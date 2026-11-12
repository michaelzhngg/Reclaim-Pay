"""Contractor invoices: contract rate, period, routing, role checks and redaction."""

from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api.rate_limit import limiter
from core import security
from core.enums import JudgmentResult, ReimbursementStatus, UserRole
from core.models import LineItem, Reimbursement, User
from engine.services import autonomy_store
from engine.services import contracts as contract_service
from engine.services.contractor_invoices import InvoiceError, create_invoice, line_total

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)
PERIOD_START = date(2026, 11, 1)
PERIOD_END = date(2026, 11, 5)


@pytest.fixture
def client(pg_db, monkeypatch):
    from main import app
    from api import reimbursements as reimbursements_api
    from engine.services import payout_service

    monkeypatch.setattr(limiter, "enabled", False)
    # Push delivery needs a running event loop, which the test client does not provide.
    monkeypatch.setattr(reimbursements_api, "fire_and_forget_push", lambda *a, **k: None)
    monkeypatch.setattr(payout_service, "fire_and_forget_push", lambda *a, **k: None)
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


def _contract(db, hr, contractor, *, rate=50, limit=1000, currency="MYR", category="Consulting"):
    return contract_service.create_contract(
        db, user_id=contractor.user_id, country_code="MY", currency=currency,
        rate_amount=rate, rate_unit="DAY", service_category=category,
        categories=["Meals"], max_company_amount_per_claim=limit,
        created_by=hr.user_id, effective_from=date(2026, 1, 1),
    )


def _login(client, user):
    res = client.post("/api/v1/auth/login", data={"username": user.email, "password": "pw"})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _invoice(db, contractor, **overrides):
    values = {
        "period_start": PERIOD_START,
        "period_end": PERIOD_END,
        "description": "Design work",
        "quantity": 2,
        "claimed_amount": 100,
        "now": NOW,
    }
    values.update(overrides)
    return create_invoice(db, contractor, **values)


def _saved_count(db, user):
    return len(db.exec(select(Reimbursement).where(Reimbursement.user_id == user.user_id)).all())


# --- intake and storage ------------------------------------------------------------------------------

def test_an_invoice_is_a_claim_linked_to_the_contract_with_its_period(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    contract = _contract(pg_db, hr, contractor)

    reim, decision = _invoice(pg_db, contractor)

    assert reim.contract_id == contract.contract_id
    assert reim.invoice_period_start == PERIOD_START
    assert reim.invoice_period_end == PERIOD_END
    assert reim.kind == "CLAIM"
    assert reim.currency == "MYR"
    assert reim.main_category == "Consulting"
    assert float(reim.total_claimed_amount) == 100
    assert float(reim.amount_company) == 100
    assert reim.status == ReimbursementStatus.REVIEW
    assert decision.tier.value != "AUTO_PAY"
    assert "CONTRACTOR_NOT_TRUSTED" in reim.autonomy["hard_stops"]

    [line] = pg_db.exec(select(LineItem).where(LineItem.reim_id == reim.reim_id)).all()
    assert line.quantity == 2
    assert float(line.unit_price) == 50
    assert float(line.claimed_amount) == 100
    assert line.category == "Consulting"


def test_the_unit_price_defaults_to_the_contract_rate(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor, rate=75)

    reim, _ = _invoice(pg_db, contractor, quantity=1, claimed_amount=75)

    [line] = pg_db.exec(select(LineItem).where(LineItem.reim_id == reim.reim_id)).all()
    assert float(line.unit_price) == 75
    assert line.judgment == JudgmentResult.APPROVED


def test_an_invoice_stores_the_company_currency_snapshot(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor, currency="USD")

    reim, _ = _invoice(pg_db, contractor, quantity=1, claimed_amount=50)

    assert reim.currency == "USD"
    assert float(reim.amount_company) == 235.00
    assert float(reim.fx_rate_to_company) == 4.7
    assert reim.fx_source == "TABLE"


# --- rate boundary and routing -------------------------------------------------------------------------

def test_the_rate_boundary_is_allowed(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor, rate=50)

    reim, decision = _invoice(pg_db, contractor, unit_price=50, claimed_amount=100)

    assert reim.judgment == JudgmentResult.APPROVED
    assert "OVER_CONTRACT_LIMIT" not in reim.autonomy["hard_stops"]
    assert decision.tier.value == "HR_QUICK"
    assert reim.status == ReimbursementStatus.REVIEW


def test_an_over_rate_invoice_routes_to_hr_with_a_reason(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor, rate=50)

    reim, decision = _invoice(pg_db, contractor, unit_price=60, claimed_amount=120)

    assert reim.judgment == JudgmentResult.NEEDS_INFO
    assert reim.status == ReimbursementStatus.REVIEW
    assert decision.tier.value == "HR_REVIEW"
    assert "AI_NOT_APPROVED" in reim.autonomy["hard_stops"]
    assert reim.ai_reasoning["contract_reason"] == "OVER_CONTRACT_RATE"
    assert reim.ai_reasoning["over_contract_rate"] is True
    [line] = pg_db.exec(select(LineItem).where(LineItem.reim_id == reim.reim_id)).all()
    assert line.rejection_reason and "OVER_CONTRACT_RATE" in line.rejection_reason


def test_a_trusted_contractor_can_reach_auto_pay_at_the_contract_rate(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db, paid_claims=10)
    _contract(pg_db, hr, contractor, rate=50, limit=500)

    reim, decision = _invoice(pg_db, contractor)

    assert decision.tier.value == "AUTO_PAY"
    assert reim.status == ReimbursementStatus.APPROVED
    assert reim.total_approved_amount is not None


def test_a_trusted_contractor_over_rate_is_still_reviewed(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db, paid_claims=10)
    _contract(pg_db, hr, contractor, rate=50)

    reim, decision = _invoice(pg_db, contractor, unit_price=60, claimed_amount=120)

    assert decision.tier.value == "HR_REVIEW"
    assert reim.status == ReimbursementStatus.REVIEW
    assert reim.total_approved_amount is None


def test_the_contract_ceiling_is_checked_in_company_currency(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db, paid_claims=10)
    _contract(pg_db, hr, contractor, rate=50, limit=50)

    reim, _ = _invoice(pg_db, contractor)

    assert "OVER_CONTRACT_LIMIT" in reim.autonomy["hard_stops"]
    assert reim.tier != "AUTO_PAY"


# --- refusals that save nothing -------------------------------------------------------------------------

def test_a_quantity_times_price_mismatch_is_refused_before_saving(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor)

    with pytest.raises(InvoiceError) as error:
        _invoice(pg_db, contractor, claimed_amount=99)

    assert error.value.code == "AMOUNT_MISMATCH"
    assert _saved_count(pg_db, contractor) == 0
    assert pg_db.exec(select(LineItem)).all() == []


def test_an_invoice_without_an_active_contract_is_refused(pg_db):
    contractor = _person(pg_db)

    with pytest.raises(InvoiceError) as error:
        _invoice(pg_db, contractor)

    assert error.value.code == "NO_ACTIVE_CONTRACT"
    assert _saved_count(pg_db, contractor) == 0


def test_a_currency_override_is_refused(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor, currency="MYR")

    with pytest.raises(InvoiceError) as error:
        _invoice(pg_db, contractor, currency="USD")

    assert error.value.code == "CURRENCY_MISMATCH"
    assert _saved_count(pg_db, contractor) == 0


def test_a_service_category_override_is_refused(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor, category="Consulting")

    with pytest.raises(InvoiceError) as error:
        _invoice(pg_db, contractor, category="Meals")

    assert error.value.code == "CATEGORY_OVERRIDE"
    assert _saved_count(pg_db, contractor) == 0


def test_an_invalid_period_is_refused(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor)

    with pytest.raises(InvoiceError) as error:
        _invoice(pg_db, contractor, period_start=PERIOD_END, period_end=PERIOD_START)

    assert error.value.code == "PERIOD_INVALID"
    assert _saved_count(pg_db, contractor) == 0


def test_an_employee_or_hr_cannot_submit_an_invoice(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    employee = _person(pg_db, role=UserRole.Employee)

    for user in (hr, employee):
        with pytest.raises(InvoiceError) as error:
            _invoice(pg_db, user)
        assert error.value.code == "NOT_A_CONTRACTOR"


# --- API and redaction ----------------------------------------------------------------------------------

def test_the_invoice_endpoint_refuses_a_mismatch_and_saves_nothing(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor)

    res = client.post(
        "/api/v1/contractor-invoices/",
        json={
            "period_start": "2026-11-01", "period_end": "2026-11-05",
            "description": "Design work", "quantity": 2, "claimed_amount": 99,
        },
        headers=_login(client, contractor),
    )

    assert res.status_code == 422
    assert res.json()["detail"].startswith("AMOUNT_MISMATCH")
    assert _saved_count(pg_db, contractor) == 0


def test_employee_and_hr_get_403_from_the_invoice_endpoint(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    employee = _person(pg_db, role=UserRole.Employee)
    body = {
        "period_start": "2026-11-01", "period_end": "2026-11-05",
        "description": "Design work", "quantity": 2, "claimed_amount": 99,
    }

    for user in (hr, employee):
        res = client.post(
            "/api/v1/contractor-invoices/", json=body, headers=_login(client, user)
        )
        assert res.status_code == 403


def test_hr_approves_an_over_rate_invoice_at_its_line_amount(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor, rate=50)

    submitted = client.post(
        "/api/v1/contractor-invoices/",
        json={
            "period_start": "2026-11-01", "period_end": "2026-11-05",
            "description": "Design work", "quantity": 2, "unit_price": 60,
            "claimed_amount": 120,
        },
        headers=_login(client, contractor),
    )
    assert submitted.status_code == 201, submitted.text

    approved = client.patch(
        f"/api/v1/reimbursements/{submitted.json()['reim_id']}/status",
        json={"status": "APPROVED"},
        headers=_login(client, hr),
    )

    assert approved.status_code == 200, approved.text
    assert approved.json()["total_approved_amount"] == 120


def test_the_invoice_response_shows_the_period_and_strips_risk_detail(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor)

    res = client.post(
        "/api/v1/contractor-invoices/",
        json={
            "period_start": "2026-11-01", "period_end": "2026-11-05",
            "description": "Design work", "quantity": 2, "claimed_amount": 100,
            "note": "November retainer",
        },
        headers=_login(client, contractor),
    )

    assert res.status_code == 201, res.text
    body = res.json()
    assert body["is_invoice"] is True
    assert body["invoice_period_start"] == "2026-11-01"
    assert body["invoice_period_end"] == "2026-11-05"
    assert body["contract_id"] is not None
    assert body["status"] == "REVIEW"
    assert body["risk_score"] is None
    assert body["summary"] is None
    assert body["ai_reasoning"] is None
    for forbidden in ("hard_stops", "signals", "explanation"):
        assert forbidden not in body["autonomy"]
    assert body["line_items"][0]["quantity"] == 2
    assert body["line_items"][0]["unit_price"] == 50


# --- trust history --------------------------------------------------------------------------------------

def test_an_invoice_counts_as_contractor_money_for_trust(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    _contract(pg_db, hr, contractor)
    reim, _ = _invoice(pg_db, contractor, quantity=1, claimed_amount=50)

    reim.status = ReimbursementStatus.PAID
    pg_db.add(reim)
    pg_db.commit()

    history = autonomy_store.employee_history(pg_db, contractor.user_id, NOW)
    assert history.paid_claims == 1


def test_line_total_rounds_to_money():
    assert line_total(Decimal("1.5"), Decimal("19.99")) == Decimal("29.99")
