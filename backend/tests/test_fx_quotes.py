"""FX quotes, company-currency snapshots and the company amount decide() sees."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from sqlmodel import select

from api.reimbursements import _build_reimbursement_response, _apply_company_amounts, _refresh_stale_quote
from core.config import settings
from core.enums import JudgmentResult, PolicyStatus, ReimbursementStatus, UserRole
from core.models import LineItem, Policy, PolicyReimbursableCategory, Reimbursement, User
from engine.agents.compliance_agent import _check_category_budgets, save_reimbursement
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
from engine.services import autonomy_store, fx
from engine.services.backtest_service import load_backtest_cases
from engine.services.funding_service import _committed
from engine.services.payout_service import payout_company_amount

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)


# --- pure quotes ---------------------------------------------------------------------------------------

def test_direct_quote_to_company_currency():
    q = fx.quote(120, "USD", "MYR", NOW)
    assert q.rate == Decimal("4.70000000")
    assert q.converted == Decimal("564.00")
    assert q.source == "TABLE" and q.as_of == NOW


def test_inverse_quote_is_the_reciprocal():
    q = fx.quote(564, "MYR", "USD", NOW)
    assert q.rate == Decimal("0.21276596")
    assert q.converted == Decimal("120.00")


def test_chained_quote_goes_through_company_currency():
    q = fx.quote(120, "USD", "IDR", NOW)
    assert q.rate == Decimal("16000.00000000")
    assert q.converted == Decimal("1920000.00")


def test_identity_quote():
    q = fx.quote(48, "MYR", "MYR", NOW)
    assert q.rate == Decimal("1") and q.converted == Decimal("48.00") and q.source == "IDENTITY"


def test_the_receipt_alias_rm_is_myr():
    assert fx.quote(10, "RM", "MYR", NOW).converted == Decimal("10.00")


def test_unknown_pair_fails_closed():
    with pytest.raises(fx.FxUnavailable):
        fx.quote(10, "XYZ", "MYR", NOW)
    assert fx.quote_or_none(10, "XYZ", "MYR", NOW) is None
    assert fx.company_amount(10, "XYZ", NOW) == (Decimal("10.00"), None)


def test_environment_overrides_the_table(monkeypatch):
    monkeypatch.setattr(settings, "FX_RATES", '{"USD": 5.0}')
    monkeypatch.setattr(settings, "FX_RATES_AS_OF", "2026-11-12T09:00:00+00:00")
    q = fx.quote(120, "USD", "MYR")
    assert q.rate == Decimal("5.00000000") and q.converted == Decimal("600.00")
    assert q.source == "ENV" and q.as_of == NOW


# --- decide() ------------------------------------------------------------------------------------------

def _decide(amount: float, currency: str = "MYR", fx_unavailable: bool = False):
    facts = ClaimFacts(
        reim_id=str(uuid4()), user_id="u1", amount=amount, currency=currency,
        judgment="APPROVED", confidence=0.95, over_category_budget=False,
        claimant_is_hr=False, fx_unavailable=fx_unavailable,
    )
    history = EmployeeHistory(paid_claims=3, confirmed_issues_90d=0, confirmed_issues_180d=0,
                              auto_paid_today=0, auto_paid_month=0)
    return decide(facts, [], history, PayeeStatus(verified=True, linked_at=NOW, changed_at=None),
                  AgentLedger(auto_paid_today=0, auto_paid_last_hour=0, breaker_active=False),
                  AutonomyConfig(), NOW)


def test_limits_compare_the_company_amount_not_the_raw_foreign_amount():
    company_amount = float(fx.quote(300000, "IDR", "MYR", NOW).converted)
    assert _decide(company_amount).tier == AutonomyTier.AUTO_PAY
    raw = _decide(300000)
    assert raw.tier != AutonomyTier.AUTO_PAY and HardStop.OVER_AUTO_LIMIT in raw.hard_stops


def test_an_unavailable_rate_is_a_hard_stop():
    decision = _decide(10, fx_unavailable=True)
    assert decision.tier != AutonomyTier.AUTO_PAY
    assert HardStop.FX_RATE_UNAVAILABLE in decision.hard_stops


# --- persistence ---------------------------------------------------------------------------------------

def _user(db, paid_claims=0, verified=True):
    user = User(
        email=f"{uuid4().hex[:8]}@test.local", name="Claimant", role=UserRole.Employee,
        hashed_password="x", paypal_payer_id=f"PAYER{uuid4().hex[:6]}" if verified else None,
        paypal_email="claimant@example.test" if verified else None,
        paypal_verified=verified,
        paypal_linked_at=NOW - timedelta(days=30) if verified else None,
    )
    db.add(user)
    db.flush()
    for _ in range(paid_claims):
        db.add(Reimbursement(
            user_id=user.user_id, main_category="Meals", currency="MYR",
            judgment=JudgmentResult.APPROVED, total_claimed_amount=20, status=ReimbursementStatus.PAID,
            summary="", created_at=NOW - timedelta(days=90), updated_at=NOW - timedelta(days=90),
        ))
    db.flush()
    return user


def _policy(db, owner, budget=None):
    policy = Policy(
        alias=f"FX-{uuid4().hex[:8]}", title="FX policy", effective_date=NOW - timedelta(days=1),
        overview_summary="", mandatory_conditions="{}", source_file_url="", status=PolicyStatus.ACTIVE,
        created_by=owner.user_id,
    )
    db.add(policy)
    db.flush()
    db.add(PolicyReimbursableCategory(policy_id=policy.policy_id, category="Meals",
                                      auto_approval_budget=budget))
    db.flush()
    return policy


def _state(user, policy, currency, amount, reim_id=None):
    return {
        "settlement_id": None, "policy_id": str(policy.policy_id), "main_category": "Meals",
        "user_id": str(user.user_id), "all_category": ["Meals"], "document_ids": [],
        "reim_id": reim_id or str(uuid4()), "user": user, "policy": policy,
        "receipts": [{"total_amount": amount, "merchant_name": "Cafe"}],
        "currency": currency,
        "totals": {"total_requested": amount, "net_approved": amount, "total_deduction": 0,
                   "by_category": {"Meals": {"claimed": amount, "approved": amount}}},
        "judgment": "APPROVED", "confidence": 0.95, "summary": "Clean claim",
        "line_items": [{"document_id": "", "description": "Lunch", "category": "Meals",
                        "requested_amount": amount, "approved_amount": amount, "status": "APPROVED"}],
    }


def test_a_foreign_claim_stores_the_quote_and_decides_on_the_company_amount(pg_db):
    user = _user(pg_db)
    policy = _policy(pg_db, user)
    result = save_reimbursement(_state(user, policy, "IDR", 100000), pg_db, now=NOW)
    claim = pg_db.get(Reimbursement, UUID(result["reimbursement_id"]))

    assert claim.currency == "IDR"
    assert float(claim.total_claimed_amount) == 100000
    assert float(claim.amount_company) == 29.38
    assert float(claim.fx_rate_to_company) == 0.00029375
    assert claim.fx_source == "TABLE" and claim.fx_rate_at == NOW
    assert claim.tier == "AUTO_PAY"
    assert claim.status == ReimbursementStatus.APPROVED


def test_an_unquoted_currency_stores_a_fallback_and_cannot_auto_pay(pg_db):
    user = _user(pg_db)
    policy = _policy(pg_db, user)
    result = save_reimbursement(_state(user, policy, "XYZ", 40), pg_db, now=NOW)
    claim = pg_db.get(Reimbursement, UUID(result["reimbursement_id"]))

    assert float(claim.amount_company) == 40 and claim.fx_source == "UNQUOTED"
    assert claim.fx_rate_to_company is None
    assert claim.tier != "AUTO_PAY" and claim.status == ReimbursementStatus.REVIEW
    assert "FX_RATE_UNAVAILABLE" in claim.autonomy["hard_stops"]


def test_category_budgets_compare_company_amounts(pg_db):
    user = _user(pg_db)
    policy = _policy(pg_db, user, budget=50)
    violations = _check_category_budgets(str(policy.policy_id),
                                         {"Meals": {"claimed": 100000, "approved": 100000}},
                                         pg_db, "IDR")
    assert violations == []


def test_history_and_caps_use_the_company_amount(pg_db):
    user = _user(pg_db)
    pg_db.add(Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="IDR",
        total_claimed_amount=100000, total_approved_amount=100000,
        amount_company=29.38, approved_company_amount=29.38,
        fx_rate_to_company=0.00029375, fx_rate_at=NOW, fx_source="TABLE",
        judgment=JudgmentResult.APPROVED, status=ReimbursementStatus.PAID, summary="",
        tier="AUTO_PAY", created_at=NOW, updated_at=NOW,
    ))
    pg_db.commit()

    history = autonomy_store.employee_history(pg_db, user.user_id, NOW)
    assert float(history.auto_paid_today) == 29.38
    assert float(history.auto_paid_month) == 29.38
    assert _committed(pg_db) == Decimal("0.00")  # PAID is no longer owed


def test_backtest_reruns_with_the_company_amount(pg_db):
    user = _user(pg_db)
    pg_db.add(Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="IDR",
        total_claimed_amount=100000, total_approved_amount=100000,
        amount_company=29.38, approved_company_amount=29.38,
        fx_rate_to_company=0.00029375, fx_rate_at=NOW, fx_source="TABLE",
        judgment=JudgmentResult.APPROVED, status=ReimbursementStatus.PAID, summary="",
        tier="AUTO_PAY", autonomy={"hard_stops": [], "signals": []},
        created_at=NOW, updated_at=NOW,
    ))
    pg_db.commit()

    [case] = load_backtest_cases(pg_db, NOW)
    assert case.claim.amount == 29.38
    assert case.claim.currency == "MYR"
    assert case.claim.fx_unavailable is False


def test_a_legacy_foreign_row_is_flagged_and_not_converted(pg_db):
    user = _user(pg_db)
    legacy = Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="USD",
        total_claimed_amount=120, judgment=JudgmentResult.APPROVED,
        status=ReimbursementStatus.REVIEW, summary="", created_at=NOW, updated_at=NOW,
    )
    pg_db.add(legacy)
    pg_db.commit()

    assert fx.is_unquoted(legacy) is True
    assert fx.stored_company_amount(legacy) == Decimal("120")
    response = _build_reimbursement_response(legacy, pg_db, viewer_is_hr=True)
    assert response["fx_unavailable"] is True
    assert response["fx_rate_to_company"] is None


def test_line_items_carry_a_company_amount(pg_db):
    user = _user(pg_db)
    claim = Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="USD",
        total_claimed_amount=120, total_approved_amount=100,
        amount_company=564, approved_company_amount=470,
        fx_rate_to_company=4.7, fx_rate_at=NOW, fx_source="TABLE",
        judgment=JudgmentResult.APPROVED, status=ReimbursementStatus.REVIEW, summary="",
        created_at=NOW, updated_at=NOW,
    )
    pg_db.add(claim)
    pg_db.flush()
    pg_db.add(LineItem(reim_id=claim.reim_id, description="Lunch", category="Meals",
                       claimed_amount=120, approved_amount=100, currency="USD"))
    pg_db.commit()

    response = _build_reimbursement_response(claim, pg_db, viewer_is_hr=True)
    [line] = response["line_items"]
    assert line["claimed_company_amount"] == 564.0
    assert line["approved_company_amount"] == 470.0


def test_payouts_use_the_company_amount_or_fail_closed(pg_db):
    user = _user(pg_db)
    foreign = Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="USD",
        total_claimed_amount=120, total_approved_amount=120,
        amount_company=564, approved_company_amount=564,
        fx_rate_to_company=4.7, fx_rate_at=NOW, fx_source="TABLE",
        judgment=JudgmentResult.APPROVED, status=ReimbursementStatus.APPROVED, summary="",
        created_at=NOW, updated_at=NOW,
    )
    unquoted = Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="XYZ",
        total_claimed_amount=50, total_approved_amount=50, amount_company=50, fx_source="UNQUOTED",
        judgment=JudgmentResult.APPROVED, status=ReimbursementStatus.APPROVED, summary="",
        created_at=NOW, updated_at=NOW,
    )
    pg_db.add_all([foreign, unquoted])
    pg_db.commit()

    assert payout_company_amount(pg_db, foreign, Decimal("120")) == Decimal("564.00")
    assert payout_company_amount(pg_db, unquoted, Decimal("50")) is None


def test_hr_review_refreshes_a_stale_quote(pg_db):
    user = _user(pg_db)
    claim = Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="USD",
        total_claimed_amount=120, amount_company=500,
        fx_rate_to_company=4.16666667, fx_rate_at=NOW - timedelta(days=2), fx_source="TABLE",
        judgment=JudgmentResult.APPROVED, status=ReimbursementStatus.REVIEW, summary="",
        created_at=NOW - timedelta(days=2), updated_at=NOW - timedelta(days=2),
    )
    pg_db.add(claim)
    pg_db.commit()

    _refresh_stale_quote(pg_db, claim, NOW)
    assert float(claim.fx_rate_to_company) == 4.7
    assert float(claim.amount_company) == 564.0
    assert claim.fx_rate_at == NOW


def test_a_missing_rate_at_review_marks_the_claim_unquoted(pg_db):
    user = _user(pg_db)
    claim = Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="XYZ",
        total_claimed_amount=50, judgment=JudgmentResult.APPROVED,
        status=ReimbursementStatus.REVIEW, summary="", created_at=NOW, updated_at=NOW,
    )
    pg_db.add(claim)
    pg_db.commit()

    _refresh_stale_quote(pg_db, claim, NOW)
    assert claim.fx_source == "UNQUOTED" and claim.fx_rate_to_company is None


def test_approval_locks_the_company_amount(pg_db):
    user = _user(pg_db)
    claim = Reimbursement(
        user_id=user.user_id, main_category="Meals", currency="USD",
        total_claimed_amount=120, total_approved_amount=100,
        amount_company=564, fx_rate_to_company=4.7, fx_rate_at=NOW, fx_source="TABLE",
        judgment=JudgmentResult.APPROVED, status=ReimbursementStatus.REVIEW, summary="",
        created_at=NOW, updated_at=NOW,
    )
    pg_db.add(claim)
    pg_db.commit()

    _apply_company_amounts(pg_db, claim, 100, NOW)
    assert float(claim.approved_company_amount) == 470.0
    assert float(claim.fx_rate_to_company) == 4.7
