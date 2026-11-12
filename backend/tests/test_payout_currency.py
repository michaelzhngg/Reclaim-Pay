"""Payouts in the payee currency, the approval snapshot and the MYR guard's DB paths."""

import asyncio
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api.rate_limit import limiter
from api.reimbursements import _apply_status, _build_reimbursement_response
from core import security
from core.config import settings
from core.enums import JudgmentResult, ReimbursementStatus, UserRole
from core.models import LineItem, Notification, Payout, Reimbursement, User, Vendor
from engine.services import contracts as contract_service
from engine.services import payout_guard
from engine.services import payout_service
from engine.services.funding_service import _committed
from engine.services.paypal_client import MockPayPalClient, PayPalError
from engine.services.recovery_service import RecoveryError, create_recovery, find_offset_claim, offset_for_reim
from engine.services.vendor_booking_service import resolve_vendor

NOW = datetime.now(timezone.utc)


@pytest.fixture
def client(pg_db, monkeypatch):
    from main import app

    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _user(db, role=UserRole.Employee, country="MY", verified=True, name="Person"):
    user = User(
        email=f"{uuid4().hex[:8]}@test.local", name=name, role=role, country_code=country,
        hashed_password=security.get_password_hash("pw"),
        paypal_payer_id=f"PAYER{uuid4().hex[:6]}" if verified else None,
        paypal_email="person@example.test" if verified else None,
        paypal_verified=verified,
        paypal_linked_at=NOW if verified else None,
    )
    db.add(user)
    db.flush()
    return user


def _contract(db, hr, contractor, *, currency="IDR", country="ID"):
    return contract_service.create_contract(
        db, user_id=contractor.user_id, country_code=country, currency=currency,
        rate_amount=50, rate_unit="DAY", service_category="Consulting",
        categories=["Meals"], policy_id=None, max_company_amount_per_claim=5000,
        created_by=hr.user_id, effective_from=date(2026, 1, 1),
    )


def _claim(db, user, *, currency="MYR", approved=120, contract_id=None, status=None,
           amount_company=None, approved_company=None, fx_rate=None):
    reim = Reimbursement(
        user_id=user.user_id,
        contract_id=contract_id,
        main_category="Meals",
        currency=currency,
        total_claimed_amount=approved,
        total_approved_amount=approved,
        amount_company=amount_company if amount_company is not None else approved,
        approved_company_amount=approved_company,
        fx_rate_to_company=fx_rate,
        fx_rate_at=NOW if fx_rate else None,
        fx_source="TABLE" if fx_rate else "IDENTITY",
        judgment=JudgmentResult.APPROVED,
        status=status or ReimbursementStatus.APPROVED,
        summary="",
        created_at=NOW,
        updated_at=NOW,
    )
    db.add(reim)
    db.flush()
    return reim


def _paypal_calls(monkeypatch):
    calls = []
    original = MockPayPalClient.create_payout

    async def record(self, **kwargs):
        calls.append(kwargs)
        return await original(self, **kwargs)

    monkeypatch.setattr(MockPayPalClient, "create_payout", record)
    return calls


def _set_held(db, hr, currencies):
    contract_service.update_payout_settings(
        db, paypal_account_country="MY", held_currencies=currencies, actor=hr.user_id,
    )


def test_approval_locks_the_contract_currency_payout(pg_db):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    claim = _claim(pg_db, contractor, currency="USD", approved=120, contract_id=contract.contract_id,
                   approved_company=564, fx_rate=4.7, status=ReimbursementStatus.REVIEW)
    pg_db.add(LineItem(reim_id=claim.reim_id, description="Hotel", category="Meals",
                       claimed_amount=120, approved_amount=120, judgment=JudgmentResult.APPROVED,
                       currency="USD"))
    pg_db.flush()

    _apply_status(pg_db, claim, ReimbursementStatus.APPROVED, hr)

    assert claim.status == ReimbursementStatus.APPROVED
    assert claim.payout_currency == "IDR"
    # USD 120 at 16,000 IDR per USD, the demo table's rate.
    assert float(claim.payout_amount) == 1_920_000.00
    assert float(claim.payout_fx_rate) == 16_000.0
    assert claim.payout_fx_at is not None
    assert float(claim.approved_company_amount) == 564.0


def test_payout_is_sent_in_the_contract_currency(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    _set_held(pg_db, hr, ["MYR", "USD"])
    claim = _claim(pg_db, contractor, currency="USD", approved=120, contract_id=contract.contract_id,
                   approved_company=564, fx_rate=4.7)
    payout_service.lock_payout_snapshot(pg_db, claim, 120, NOW)
    pg_db.commit()
    calls = _paypal_calls(monkeypatch)

    payout = asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))

    assert payout is not None
    assert calls and calls[0]["currency"] == "IDR" and calls[0]["amount"] == Decimal("1920000.00")
    assert payout.currency == "IDR"
    assert float(payout.amount) == 1_920_000.00
    assert payout.provider_batch_id
    pg_db.refresh(claim)
    assert claim.status == ReimbursementStatus.DISBURSING


def test_myr_to_a_non_malaysian_contractor_is_refused_before_paypal(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    # The user row says MY; the contract says ID and the contract wins.
    contractor = _user(pg_db, role=UserRole.Contractor, country="MY")
    contract = _contract(pg_db, hr, contractor, currency="MYR", country="ID")
    _set_held(pg_db, hr, ["MYR"])
    claim = _claim(pg_db, contractor, currency="MYR", approved=120, contract_id=contract.contract_id)
    payout_service.lock_payout_snapshot(pg_db, claim, 120, NOW)
    pg_db.commit()
    calls = _paypal_calls(monkeypatch)

    with pytest.raises(payout_service.PayoutRefused) as refused:
        asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))

    assert refused.value.code == payout_guard.MYR_PAYEE_NOT_MALAYSIAN
    assert calls == []
    pg_db.refresh(claim)
    assert claim.status == ReimbursementStatus.APPROVED

    [attempt] = pg_db.exec(select(Payout).where(Payout.reim_id == claim.reim_id)).all()
    assert attempt.status == "FAILED"
    assert attempt.failure_code == payout_guard.MYR_PAYEE_NOT_MALAYSIAN
    assert attempt.provider_batch_id is None
    assert attempt.currency == "MYR" and float(attempt.amount) == 120.0

    hr_note = pg_db.exec(
        select(Notification).where(
            Notification.user_id == hr.user_id,
            Notification.title.like("Payout refused%"),
        )
    ).first()
    assert hr_note is not None and "Malaysian" in hr_note.message
    assert pg_db.exec(
        select(Notification).where(
            Notification.user_id == contractor.user_id,
            Notification.type == "error",
        )
    ).first() is None


def test_the_refusal_is_hidden_from_the_claimant(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="MYR", country="ID")
    _set_held(pg_db, hr, ["MYR"])
    claim = _claim(pg_db, contractor, currency="MYR", approved=120, contract_id=contract.contract_id)
    payout_service.lock_payout_snapshot(pg_db, claim, 120, NOW)
    pg_db.commit()
    _paypal_calls(monkeypatch)

    with pytest.raises(payout_service.PayoutRefused):
        asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))

    employee_view = _build_reimbursement_response(claim, pg_db, include_line_items=True, viewer_is_hr=False)
    hr_view = _build_reimbursement_response(claim, pg_db, include_line_items=True, viewer_is_hr=True)
    assert "payout" not in employee_view
    assert employee_view["status"] == "APPROVED"
    assert hr_view["payout"]["failure_code"] == payout_guard.MYR_PAYEE_NOT_MALAYSIAN
    assert hr_view["payout"]["currency"] == "MYR"


def test_non_myr_payout_needs_a_non_myr_funding_currency(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    _set_held(pg_db, hr, ["MYR"])
    claim = _claim(pg_db, contractor, currency="IDR", approved=250_000, contract_id=contract.contract_id)
    payout_service.lock_payout_snapshot(pg_db, claim, 250_000, NOW)
    pg_db.commit()
    calls = _paypal_calls(monkeypatch)

    with pytest.raises(payout_service.PayoutRefused) as refused:
        asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))

    assert refused.value.code == payout_guard.NON_MYR_BALANCE_REQUIRED
    assert calls == []
    [attempt] = pg_db.exec(select(Payout).where(Payout.reim_id == claim.reim_id)).all()
    assert attempt.currency == "IDR" and float(attempt.amount) == 250_000.0


def test_a_retry_after_the_fix_still_passes_the_guard(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    _set_held(pg_db, hr, ["MYR"])
    claim = _claim(pg_db, contractor, currency="IDR", approved=250_000, contract_id=contract.contract_id)
    payout_service.lock_payout_snapshot(pg_db, claim, 250_000, NOW)
    pg_db.commit()
    calls = _paypal_calls(monkeypatch)

    with pytest.raises(payout_service.PayoutRefused):
        asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))
    assert calls == []

    _set_held(pg_db, hr, ["MYR", "USD"])
    payout = asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))

    assert payout is not None and payout.attempt == 2 and payout.currency == "IDR"
    assert len(calls) == 1


def test_live_balance_failures_fail_closed(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    employee = _user(pg_db, role=UserRole.Employee, country="MY")
    _set_held(pg_db, hr, ["MYR"])
    claim = _claim(pg_db, employee, currency="MYR", approved=120)
    pg_db.commit()
    calls = _paypal_calls(monkeypatch)
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", False)

    class _Missing:
        async def get_balance(self, currency):
            return None

        async def create_payout(self, **kwargs):  # pragma: no cover - must not be reached
            raise AssertionError("PayPal payout called")

    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: _Missing())
    with pytest.raises(payout_service.PayoutRefused) as missing:
        asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))
    assert missing.value.code == payout_guard.MYR_BALANCE_REQUIRED

    class _Unreachable:
        async def get_balance(self, currency):
            raise PayPalError(503, "SERVICE_UNAVAILABLE")

        async def create_payout(self, **kwargs):  # pragma: no cover - must not be reached
            raise AssertionError("PayPal payout called")

    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: _Unreachable())
    pg_db.rollback()
    with pytest.raises(payout_service.PayoutRefused) as unreachable:
        asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))
    assert unreachable.value.code == payout_guard.BALANCE_UNAVAILABLE
    assert calls == []


def test_mock_balances_are_per_currency(monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_BALANCES", '{"MYR": "1000.00"}')
    client = MockPayPalClient()
    myr = asyncio.run(client.get_balance("MYR"))
    usd = asyncio.run(client.get_balance("USD"))
    assert myr is not None and myr.available == Decimal("1000.00")
    assert usd is None


def test_a_refusal_is_not_a_payment_error_for_the_claimant(client, pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    contractor = _user(pg_db, role=UserRole.Contractor, country="MY")
    contract = _contract(pg_db, hr, contractor, currency="MYR", country="ID")
    _set_held(pg_db, hr, ["MYR"])
    claim = _claim(pg_db, contractor, currency="MYR", approved=120, contract_id=contract.contract_id)
    payout_service.lock_payout_snapshot(pg_db, claim, 120, NOW)
    pg_db.commit()
    _paypal_calls(monkeypatch)

    with pytest.raises(payout_service.PayoutRefused):
        asyncio.run(payout_service.initiate_payout_async(claim.reim_id, pg_db))

    def token_for(user):
        res = client.post("/api/v1/auth/login", data={"username": user.email, "password": "pw"})
        return {"Authorization": f"Bearer {res.json()['access_token']}"}

    employee_view = client.get(f"/api/v1/payouts/{claim.reim_id}", headers=token_for(contractor))
    assert employee_view.status_code == 404
    hr_view = client.get(f"/api/v1/payouts/{claim.reim_id}", headers=token_for(hr))
    assert hr_view.status_code == 200
    assert hr_view.json()["failure_code"] == payout_guard.MYR_PAYEE_NOT_MALAYSIAN


def test_hr_sees_the_payout_quote_before_approval(pg_db):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    claim = _claim(pg_db, contractor, currency="USD", approved=120, contract_id=contract.contract_id,
                   approved_company=564, fx_rate=4.7, status=ReimbursementStatus.REVIEW)

    response = _build_reimbursement_response(claim, pg_db, include_line_items=True, viewer_is_hr=True)

    assert response["payout_amount"] is None
    preview = response["payout_preview"]
    assert preview["currency"] == "IDR"
    assert preview["amount"] == 1_920_000.00
    assert preview["company_amount"] == 564.0
    assert preview["rate"] == 16_000.0


def test_contractor_claims_are_not_offset_targets(pg_db):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="MYR", country="ID")
    paid = _claim(pg_db, contractor, currency="MYR", approved=120, contract_id=contract.contract_id,
                  status=ReimbursementStatus.PAID)
    open_claim = _claim(pg_db, contractor, currency="MYR", approved=120, contract_id=contract.contract_id)
    pg_db.commit()

    from core.models import Recovery
    from core.enums import RecoveryStatus

    recovery = Recovery(
        reim_id=paid.reim_id, user_id=contractor.user_id, amount=30, currency="MYR", reason="Overpaid",
        status=RecoveryStatus.NOTICE_SENT.value, dispute_until=NOW, created_by=hr.user_id,
        created_at=NOW, updated_at=NOW,
    )
    pg_db.add(recovery)
    pg_db.flush()

    assert find_offset_claim(pg_db, recovery) is None
    net, applied = offset_for_reim(pg_db, open_claim)
    assert net == Decimal("120.00") and applied == []
    with pytest.raises(RecoveryError) as refused:
        create_recovery(pg_db, paid, Decimal("10"), "Overpaid", hr, NOW)
    assert refused.value.code == "CONTRACTOR_RECOVERY_UNSUPPORTED"


def test_new_staff_and_vendors_default_to_malaysia(pg_db):
    person = _user(pg_db, role=UserRole.Employee)
    vendor, created = resolve_vendor(pg_db, f"Vendor {uuid4().hex[:6]}", "Meals", person.user_id)
    pg_db.flush()
    assert person.country_code == "MY"
    assert created is True and vendor.country_code == "MY"


def test_register_accepts_a_country_and_refuses_an_unknown_one(client, pg_db):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    token = client.post("/api/v1/auth/login", data={"username": hr.email, "password": "pw"}).json()["access_token"]
    headers = {"Authorization": f"Bearer {token}"}
    base = {
        "email": f"{uuid4().hex[:8]}@example.com", "name": "Overseas", "role": "Contractor",
        "password": "pw", "country_code": "ID",
    }

    created = client.post("/api/v1/auth/register", json=base, headers=headers)
    assert created.status_code == 200 and created.json()["country_code"] == "ID"

    base["email"] = f"{uuid4().hex[:8]}@example.com"
    base["country_code"] = "ZZ"
    refused = client.post("/api/v1/auth/register", json=base, headers=headers)
    assert refused.status_code == 422 and refused.json()["detail"] == "COUNTRY_UNSUPPORTED"


def test_funding_committed_uses_the_company_amount(pg_db):
    employee = _user(pg_db, role=UserRole.Employee, country="MY")
    before = _committed(pg_db)
    foreign = _claim(pg_db, employee, currency="USD", approved=120, amount_company=564,
                     approved_company=564, fx_rate=4.7)
    pg_db.commit()
    assert _committed(pg_db) - before == Decimal("564.00")
    pg_db.refresh(foreign)
    assert foreign.total_approved_amount == 120
