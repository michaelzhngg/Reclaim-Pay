"""Contractor claim intake, contract policy selection, trust stop and redaction."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api.rate_limit import limiter
from api.reimbursements import _build_reimbursement_response, _undecided_claim
from core import security
from core.enums import JudgmentResult, PolicyStatus, ReimbursementStatus, UserRole
from core.models import (
    Policy,
    PolicyReimbursableCategory,
    Reimbursement,
    TravelSettlement,
    User,
)
from engine.agents.compliance_agent import save_reimbursement
from engine.risk.autonomy import decide
from engine.risk.types import (
    AgentLedger,
    AutonomyConfig,
    AutonomyTier,
    ClaimFacts,
    EmployeeHistory,
    HardStop,
    PayeeStatus,
)
from engine.services import contracts as contract_service
from engine.services.backtest_service import employee_trust, load_backtest_cases

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def client(pg_db, monkeypatch):
    from main import app

    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _person(db, role=UserRole.Contractor, verified=True, paid_claims=0, name="Person"):
    user = User(
        email=f"{uuid4().hex[:8]}@test.local", name=name, role=role,
        hashed_password=security.get_password_hash("pw"),
        paypal_payer_id=f"PAYER{uuid4().hex[:6]}" if verified else None,
        paypal_email="person@example.test" if verified else None,
        paypal_verified=verified,
        paypal_linked_at=NOW - timedelta(days=30) if verified else None,
    )
    db.add(user)
    db.flush()
    for _ in range(paid_claims):
        db.add(Reimbursement(
            user_id=user.user_id, main_category="Meals", currency="MYR",
            judgment=JudgmentResult.APPROVED, total_claimed_amount=20,
            status=ReimbursementStatus.PAID, summary="",
            created_at=NOW - timedelta(days=90), updated_at=NOW - timedelta(days=90),
        ))
    db.flush()
    return user


def _policy(db, owner, categories=("Meals", "Transportation"), title="Contractor policy"):
    policy = Policy(
        alias=f"P-{uuid4().hex[:8]}", title=title, effective_date=NOW - timedelta(days=1),
        overview_summary="", mandatory_conditions="{}", source_file_url="",
        status=PolicyStatus.ACTIVE, created_by=owner.user_id,
    )
    db.add(policy)
    db.flush()
    for category in categories:
        db.add(PolicyReimbursableCategory(policy_id=policy.policy_id, category=category))
    db.flush()
    return policy


def _contract(db, hr, contractor, *, policy=None, categories=("Meals",), limit=100,
              currency="MYR", country="MY"):
    return contract_service.create_contract(
        db, user_id=contractor.user_id, country_code=country, currency=currency,
        rate_amount=50, rate_unit="DAY", service_category="Consulting",
        categories=list(categories), policy_id=policy.policy_id if policy else None,
        max_company_amount_per_claim=limit, created_by=hr.user_id,
        effective_from=date(2026, 1, 1),
    )


def _settlement(db, user, currency="MYR"):
    settlement = TravelSettlement(user_id=user.user_id, currency=currency, main_category="Meals")
    db.add(settlement)
    db.commit()
    db.refresh(settlement)
    return settlement


def _login(client, user):
    res = client.post("/api/v1/auth/login", data={"username": user.email, "password": "pw"})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _facts(amount=10, contractor=True, over_limit=False, fx_unavailable=False):
    return ClaimFacts(
        reim_id=str(uuid4()), user_id="u1", amount=amount, currency="MYR",
        judgment="APPROVED", confidence=0.95, over_category_budget=False,
        claimant_is_hr=False, claimant_is_contractor=contractor,
        over_contract_limit=over_limit, fx_unavailable=fx_unavailable,
    )


def _decide(facts, paid_claims):
    return decide(
        facts, [],
        EmployeeHistory(paid_claims=paid_claims, confirmed_issues_90d=0, confirmed_issues_180d=0,
                        auto_paid_today=0, auto_paid_month=0),
        PayeeStatus(verified=True, linked_at=NOW, changed_at=None),
        AgentLedger(auto_paid_today=0, auto_paid_last_hour=0, breaker_active=False),
        AutonomyConfig(), NOW,
    )


# --- intake --------------------------------------------------------------------------------------------

def test_a_contractor_without_a_contract_cannot_submit(client, pg_db):
    contractor = _person(pg_db)
    settlement = _settlement(pg_db, contractor)
    res = client.post(
        "/api/v1/reimbursements/analyze",
        json={"settlement_id": str(settlement.settlement_id), "document_ids": []},
        headers=_login(client, contractor),
    )
    assert res.status_code == 422
    assert res.json()["detail"] == "NO_ACTIVE_CONTRACT"
    assert pg_db.exec(select(Reimbursement).where(Reimbursement.user_id == contractor.user_id)).all() == []


def test_an_inactive_contract_does_not_count(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    contract = _contract(pg_db, hr, contractor)
    contract.is_active = False
    pg_db.add(contract)
    pg_db.commit()
    settlement = _settlement(pg_db, contractor)

    res = client.post(
        "/api/v1/reimbursements/analyze",
        json={"settlement_id": str(settlement.settlement_id), "document_ids": []},
        headers=_login(client, contractor),
    )
    assert res.status_code == 422 and res.json()["detail"] == "NO_ACTIVE_CONTRACT"


def test_contract_receipts_split_by_category(pg_db):
    class Receipt:
        def __init__(self, category):
            self.category = category

    receipts = [Receipt("Meals"), Receipt("Software"), Receipt("Transportation")]
    allowed, blocked = contract_service.split_receipts_by_contract(receipts, {"meals", "transportation"})
    assert [r.category for r in allowed] == ["Meals", "Transportation"]
    assert [r.category for r in blocked] == ["Software"]


def test_the_contract_policy_replaces_the_category_lookup(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    contract_policy = _policy(pg_db, hr, title="Contract policy")
    other_policy = _policy(pg_db, hr, title="Newer policy")

    assert contract_service.policy_for_category(pg_db, "Meals", None) == other_policy.policy_id
    assert contract_service.policy_for_category(pg_db, "Meals", contract_policy.policy_id) == contract_policy.policy_id
    # Contract intake matches category labels case-insensitively, as DECISIONS says.
    assert contract_service.policy_for_category(pg_db, "meals", None) == other_policy.policy_id
    assert contract_service.policy_for_category(pg_db, " MEALS ", None) == other_policy.policy_id


def test_a_blocked_receipt_claim_links_the_contract_and_waits_for_hr(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    contract = _contract(pg_db, hr, contractor)
    claim = _undecided_claim(
        user_id=contractor.user_id, policy_id=None, settlement_id=None,
        contract_id=contract.contract_id, main_category="Contract review", currency="MYR",
        total_claimed_amount=40, summary="Outside the contract categories: Software.",
        ai_reasoning={"contract_reason": "CATEGORY_NOT_ALLOWED", "categories": ["Software"]},
    )
    pg_db.add(claim)
    pg_db.commit()

    assert claim.contract_id == contract.contract_id
    assert claim.status == ReimbursementStatus.REVIEW
    assert claim.tier == "DUAL_REVIEW"


# --- decide() ------------------------------------------------------------------------------------------

def test_new_and_standard_contractors_hit_the_trust_stop():
    for paid in (0, 3):
        decision = _decide(_facts(), paid)
        assert HardStop.CONTRACTOR_NOT_TRUSTED in decision.hard_stops
        assert decision.tier != AutonomyTier.AUTO_PAY


def test_a_trusted_contractor_can_auto_pay():
    decision = _decide(_facts(), 10)
    assert HardStop.CONTRACTOR_NOT_TRUSTED not in decision.hard_stops
    assert decision.tier == AutonomyTier.AUTO_PAY


def test_the_contract_limit_is_a_hard_stop():
    decision = _decide(_facts(over_limit=True), 10)
    assert HardStop.OVER_CONTRACT_LIMIT in decision.hard_stops
    assert decision.tier != AutonomyTier.AUTO_PAY


# --- persistence ---------------------------------------------------------------------------------------

def _state(user, policy, contract, currency, amount):
    return {
        "settlement_id": None, "policy_id": str(policy.policy_id), "main_category": "Meals",
        "user_id": str(user.user_id), "all_category": ["Meals"], "document_ids": [],
        "reim_id": str(uuid4()), "user": user, "policy": policy,
        "contract_id": str(contract.contract_id),
        "contract_max_company_amount": float(contract.max_company_amount_per_claim),
        "receipts": [{"total_amount": amount, "merchant_name": "Cafe"}],
        "currency": currency,
        "totals": {"total_requested": amount, "net_approved": amount, "total_deduction": 0,
                   "by_category": {"Meals": {"claimed": amount, "approved": amount}}},
        "judgment": "APPROVED", "confidence": 0.95, "summary": "Clean claim",
        "line_items": [{"document_id": "", "description": "Lunch", "category": "Meals",
                        "requested_amount": amount, "approved_amount": amount, "status": "APPROVED"}],
    }


def test_a_new_contractor_claim_is_linked_and_never_auto_paid(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    policy = _policy(pg_db, hr)
    contract = _contract(pg_db, hr, contractor, policy=policy)
    result = save_reimbursement(_state(contractor, policy, contract, "MYR", 20), pg_db, now=NOW)
    claim = pg_db.get(Reimbursement, UUID(result["reimbursement_id"]))

    assert claim.contract_id == contract.contract_id
    assert claim.status == ReimbursementStatus.REVIEW
    assert claim.tier != "AUTO_PAY"
    assert "CONTRACTOR_NOT_TRUSTED" in claim.autonomy["hard_stops"]


def test_a_trusted_contractor_can_auto_pay_through_decide(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db, paid_claims=10)
    policy = _policy(pg_db, hr)
    contract = _contract(pg_db, hr, contractor, policy=policy, limit=200)
    result = save_reimbursement(_state(contractor, policy, contract, "MYR", 20), pg_db, now=NOW)
    claim = pg_db.get(Reimbursement, UUID(result["reimbursement_id"]))

    assert claim.tier == "AUTO_PAY" and claim.status == ReimbursementStatus.APPROVED
    assert "CONTRACTOR_NOT_TRUSTED" not in claim.autonomy["hard_stops"]


def test_the_contract_limit_is_checked_in_company_currency(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db, paid_claims=10)
    policy = _policy(pg_db, hr)
    over = _contract(pg_db, hr, contractor, policy=policy, limit=20)
    # 100,000 IDR is about MYR 29.38, so a MYR 20 contract limit stops it.
    result = save_reimbursement(_state(contractor, policy, over, "IDR", 100000), pg_db, now=NOW)
    claim = pg_db.get(Reimbursement, UUID(result["reimbursement_id"]))
    assert float(claim.amount_company) == 29.38
    assert "OVER_CONTRACT_LIMIT" in claim.autonomy["hard_stops"]
    assert claim.tier != "AUTO_PAY"


# --- trust card and backtest ---------------------------------------------------------------------------

def test_the_contractor_trust_card_shows_new_without_risk_detail(pg_db):
    contractor = _person(pg_db)
    card = employee_trust(pg_db, contractor.user_id, AutonomyConfig(), NOW, is_contractor=True)
    assert card["trust_tier"].value == "NEW"
    assert card["is_contractor"] is True
    assert any("reviewed by HR" in reason for reason in card["reasons"])
    for forbidden in ("risk_score", "signals", "hard_stops", "explanation"):
        assert forbidden not in card


def test_the_backtest_loads_the_contractor_role(pg_db):
    contractor = _person(pg_db)
    pg_db.add(Reimbursement(
        user_id=contractor.user_id, main_category="Meals", currency="MYR",
        total_claimed_amount=20, total_approved_amount=20,
        amount_company=20, approved_company_amount=20,
        judgment=JudgmentResult.APPROVED, status=ReimbursementStatus.PAID, summary="",
        tier="AUTO_PAY", autonomy={"hard_stops": [], "signals": []},
        created_at=NOW, updated_at=NOW,
    ))
    pg_db.commit()

    [case] = load_backtest_cases(pg_db, NOW)
    assert case.claim.claimant_is_contractor is True
    assert _decide(case.claim, 0).tier != AutonomyTier.AUTO_PAY


def test_contractor_claim_responses_strip_risk_detail(pg_db):
    contractor = _person(pg_db)
    claim = Reimbursement(
        user_id=contractor.user_id, main_category="Meals", currency="MYR",
        total_claimed_amount=20, judgment=JudgmentResult.NEEDS_INFO,
        status=ReimbursementStatus.REVIEW, summary="AI verdict text",
        risk_score=85, tier="HR_REVIEW",
        autonomy={
            "tier": "HR_REVIEW", "risk_score": 85, "trust_tier": "NEW",
            "hard_stops": ["CONTRACTOR_NOT_TRUSTED"], "signals": [{"code": "SPLIT_CLAIM"}],
            "explanation": "Stops: CONTRACTOR_NOT_TRUSTED.",
        },
        ai_reasoning={"hr_note": "Please add the missing receipt.", "reasoning": "secret"},
        created_at=NOW, updated_at=NOW,
    )
    pg_db.add(claim)
    pg_db.commit()

    response = _build_reimbursement_response(claim, pg_db, viewer_is_hr=False, viewer_is_contractor=True)
    assert response["risk_score"] is None
    assert response["summary"] is None
    assert response["ai_reasoning"] is None
    assert "hard_stops" not in response["autonomy"]
    assert "signals" not in response["autonomy"]
    assert "explanation" not in response["autonomy"]

    # Employees keep the HR note, which is the only reasoning they are meant to see.
    employee_view = _build_reimbursement_response(claim, pg_db, viewer_is_hr=False)
    assert employee_view["ai_reasoning"] == {"hr_note": "Please add the missing receipt."}
