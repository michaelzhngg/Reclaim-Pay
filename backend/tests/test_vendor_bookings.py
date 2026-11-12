"""Vendor booking intake, routing and employee redaction. Needs TEST_DATABASE_URL."""

import asyncio
import hashlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api.reimbursements import _build_reimbursement_response
from core.enums import JudgmentResult, PolicyStatus, ReimbursementStatus, UserRole
from core.models import (
    LineItem, Payout, Policy, PolicyReimbursableCategory, Recovery, Reimbursement, User, Vendor,
)
from engine.risk.queries import recent_claims
from engine.services.autonomy_store import ledger_snapshot, recent_decisions
from engine.services.recovery_service import RecoveryError, create_recovery, find_offset_claim
from engine.services.payout_service import initiate_payout_async, initiate_payout_sync, payee_for_reim
from engine.services.vendor_booking_service import (
    check_booking_policy,
    create_booking,
    vendor_name_key,
)

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)


def _user(db, name="employee", role=UserRole.Employee, verified=True, paid_claims=3):
    user = User(
        email=f"{name}-{uuid4().hex[:8]}@test.local", hashed_password="x", name=name, role=role,
        paypal_payer_id=f"PAYER{uuid4().hex[:6]}" if verified else None,
        paypal_email=f"{name}@example.test" if verified else None,
        paypal_verified=verified,
        paypal_linked_at=NOW - timedelta(days=30) if verified else None,
    )
    db.add(user)
    db.flush()
    for _ in range(paid_claims):
        db.add(Reimbursement(
            user_id=user.user_id, main_category="Meals", currency="MYR", judgment=JudgmentResult.APPROVED,
            total_claimed_amount=20.0, status=ReimbursementStatus.PAID, summary="",
            created_at=NOW - timedelta(days=90), updated_at=NOW - timedelta(days=90),
        ))
    db.flush()
    return user


def _policy(db, owner, category="Transportation", budget=100.0):
    policy = Policy(
        alias=f"V-{uuid4().hex[:8]}", title="Vendor policy", effective_date=NOW - timedelta(days=1),
        overview_summary="", mandatory_conditions="{}", source_file_url="", status=PolicyStatus.ACTIVE,
        created_by=owner.user_id,
    )
    db.add(policy)
    db.flush()
    db.add(PolicyReimbursableCategory(policy_id=policy.policy_id, category=category,
                                      auto_approval_budget=budget))
    db.flush()
    return policy


def _vendor(db, name, verified=True, payer="VENDORPAYER1"):
    vendor = Vendor(name=name, name_key=vendor_name_key(name), default_category="Transportation",
                    paypal_verified=verified, paypal_payer_id=payer if verified else None,
                    paypal_email="vendor@example.com" if verified else None,
                    paypal_linked_at=NOW - timedelta(days=30) if verified else None)
    db.add(vendor)
    db.flush()
    return vendor


def _booking(db, user, vendor_name, amount=40.0, category="Transportation"):
    return create_booking(
        db, user, vendor_name=vendor_name, category=category, amount=amount,
        service_start=NOW.date() + timedelta(days=3), service_end=NOW.date() + timedelta(days=4),
        purpose="Client visit", now=NOW,
    )


def test_name_key_is_conservative():
    assert vendor_name_key("  Hotel   Seri Kenanga ") == "hotel seri kenanga"
    assert vendor_name_key("Hotel Seri Kenanga Sdn Bhd") != vendor_name_key("Hotel Seri Kenanga")


def test_policy_missing_category_fails_closed(pg_db):
    user = _user(pg_db)
    _policy(pg_db, user, category="Meals")
    result = check_booking_policy(pg_db, "Transportation", 40.0)
    assert result.policy_id is None and result.judgment == JudgmentResult.NEEDS_INFO


def test_new_vendor_never_auto_pays(pg_db):
    user = _user(pg_db)
    _policy(pg_db, user)

    reim, booking, vendor, created = _booking(pg_db, user, "New Vendor Sdn Bhd")

    assert created is True
    assert vendor.paypal_verified is False
    assert reim.kind == "VENDOR_BOOKING"
    assert reim.tier != "AUTO_PAY"
    assert reim.status == ReimbursementStatus.REVIEW
    stops = reim.autonomy["hard_stops"]
    assert "PAYEE_NOT_VERIFIED" in stops
    assert booking.vendor_id == vendor.vendor_id
    assert float(reim.total_claimed_amount) == 40.0


def test_verified_vendor_can_auto_pay_and_pays_the_vendor(pg_db):
    user = _user(pg_db)
    _policy(pg_db, user)
    vendor = _vendor(pg_db, "Verified Cab Co.")

    reim, _booking_row, _vendor_row, created = _booking(pg_db, user, "Verified Cab Co.")
    assert created is False
    assert reim.tier == "AUTO_PAY"
    assert reim.status == ReimbursementStatus.APPROVED

    payee = payee_for_reim(pg_db, reim)
    assert payee is not None and payee.vendor_id == vendor.vendor_id and payee.payer_id == vendor.paypal_payer_id

    payout = asyncio.run(initiate_payout_async(reim.reim_id, pg_db))
    assert payout is not None
    assert payout.vendor_id == vendor.vendor_id
    assert payout.user_id == user.user_id
    assert payout.status == "ACCEPTED"
    pg_db.refresh(reim)
    assert reim.status == ReimbursementStatus.DISBURSING

    # A retry while the payout is live must not create a second one.
    initiate_payout_sync(reim.reim_id, pg_db)
    payouts = pg_db.exec(select(Payout).where(Payout.reim_id == reim.reim_id)).all()
    assert len(payouts) == 1


def test_employee_response_redacts_risk_and_vendor_account(pg_db):
    user = _user(pg_db)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")
    reim, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.")

    employee_view = _build_reimbursement_response(reim, pg_db, include_line_items=True, viewer_is_hr=False)
    assert employee_view["kind"] == "VENDOR_BOOKING"
    assert employee_view["vendor_name"] == "Verified Cab Co."
    assert employee_view["vendor_verified"] is None
    assert employee_view["vendor_paypal_masked"] is None
    assert employee_view["risk_score"] is None
    assert "signals" not in employee_view["autonomy"]
    assert "hard_stops" not in employee_view["autonomy"]
    assert "summary" not in employee_view or employee_view["summary"] is None

    hr_view = _build_reimbursement_response(reim, pg_db, include_line_items=True, viewer_is_hr=True)
    assert hr_view["vendor_verified"] is True
    assert hr_view["vendor_paypal_masked"] and "***" in hr_view["vendor_paypal_masked"]
    assert "vendor@example.com" != hr_view["vendor_paypal_masked"]
    assert hr_view["risk_score"] == reim.risk_score
    assert hr_view["autonomy"]["hard_stops"] == reim.autonomy["hard_stops"]


def test_booking_has_one_line_item_for_the_existing_approval_math(pg_db):
    user = _user(pg_db)
    _policy(pg_db, user)
    reim, _booking_row, _vendor_row, _created = _booking(pg_db, user, "New Vendor Sdn Bhd")

    lines = pg_db.exec(select(LineItem).where(LineItem.reim_id == reim.reim_id)).all()
    assert len(lines) == 1
    assert float(lines[0].claimed_amount) == 40.0
    assert float(lines[0].approved_amount) == 40.0
    assert lines[0].document_id is None


def test_hr_approval_pays_the_vendor(pg_db, monkeypatch):
    from main import app
    import api.reimbursements as reimbursements_api
    import engine.services.payout_service as payout_service

    monkeypatch.setattr(reimbursements_api, "fire_and_forget_push", lambda *a, **k: None)
    monkeypatch.setattr(payout_service, "fire_and_forget_push", lambda *a, **k: None)

    requester = _user(pg_db, "requester")
    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    _policy(pg_db, requester)
    reim, _booking_row, vendor, _created = _booking(pg_db, requester, "New Vendor Sdn Bhd", amount=40.0)
    assert reim.status == ReimbursementStatus.REVIEW

    vendor.paypal_verified = True
    vendor.paypal_payer_id = "VENDORPAYER-NEW"
    vendor.paypal_email = "vendor@example.com"
    pg_db.add(vendor)
    pg_db.commit()

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        res = TestClient(app).patch(f"/api/v1/reimbursements/{reim.reim_id}/status", json={"status": "APPROVED"})
        assert res.status_code == 200, res.text
    finally:
        app.dependency_overrides.clear()

    pg_db.refresh(reim)
    payouts = pg_db.exec(select(Payout).where(Payout.reim_id == reim.reim_id)).all()
    assert len(payouts) == 1
    assert payouts[0].vendor_id == vendor.vendor_id
    assert payouts[0].user_id == requester.user_id
    assert reim.status in (ReimbursementStatus.DISBURSING, ReimbursementStatus.PAID)


def test_unverified_vendor_is_never_paid(pg_db):
    requester = _user(pg_db)
    _policy(pg_db, requester)
    reim, _booking_row, vendor, _created = _booking(pg_db, requester, "New Vendor Sdn Bhd", amount=40.0)

    # Even if an HR action forged APPROVED, the payee check is repeated at payout time.
    reim.status = ReimbursementStatus.APPROVED
    pg_db.add(reim)
    pg_db.commit()
    assert payee_for_reim(pg_db, reim) is None
    assert asyncio.run(initiate_payout_async(reim.reim_id, pg_db)) is None
    assert pg_db.exec(select(Payout).where(Payout.reim_id == reim.reim_id)).all() == []


def test_verification_unlocks_the_next_booking(pg_db, monkeypatch):
    from main import app
    import api.vendors as vendors_api

    requester = _user(pg_db, "requester")
    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    _policy(pg_db, requester)
    first, _booking_row, vendor, _created = _booking(pg_db, requester, "New Vendor Sdn Bhd", amount=40.0)
    assert first.status == ReimbursementStatus.REVIEW

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        res = TestClient(app).post(f"/api/v1/vendors/{vendor.vendor_id}/verify", json={})
        assert res.status_code == 200, res.text
        body = res.json()
        assert body["paypal_ready"] is True
        assert body["paypal_verified"] is True
        assert body["paypal_email_masked"]
    finally:
        app.dependency_overrides.clear()

    pg_db.refresh(vendor)
    assert vendor.paypal_verified and vendor.paypal_payer_id
    assert vendor.paypal_linked_at is not None
    assert vendor.payout_destination_changed_at is None

    # Verification does not re-decide a booking already in review.
    pg_db.refresh(first)
    assert first.status == ReimbursementStatus.REVIEW

    second, _booking_row, _vendor, _created = _booking(pg_db, requester, "New Vendor Sdn Bhd", amount=40.0)
    assert second.tier == "AUTO_PAY"

    from core.enums import AgentActionType
    from core.models import AgentAction
    actions = pg_db.exec(select(AgentAction).where(AgentAction.action_type == AgentActionType.PAYEE_LINKED.value)).all()
    assert any((a.payload or {}).get("vendor_id") == str(vendor.vendor_id) for a in actions)


def test_verification_refuses_a_payer_used_elsewhere(pg_db):
    from main import app

    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    first_vendor = _vendor(pg_db, "First Vendor")
    second_vendor = _vendor(pg_db, "Second Vendor")
    first_vendor.paypal_email = "shared@vendor.com"
    second_vendor.paypal_email = "shared@vendor.com"
    first_vendor.paypal_payer_id = "MOCKV" + hashlib.sha256(b"shared@vendor.com").hexdigest()[:12].upper()
    pg_db.add(first_vendor)
    pg_db.add(second_vendor)
    pg_db.commit()

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        res = TestClient(app).post(
            f"/api/v1/vendors/{second_vendor.vendor_id}/verify",
            json={"paypal_email": "shared@vendor.com"},
        )
        assert res.status_code == 409 and res.json()["detail"] == "PAYEE_ALREADY_LINKED"
    finally:
        app.dependency_overrides.clear()


def test_verification_requires_hr_and_fails_closed_outside_mock(pg_db, monkeypatch):
    from main import app
    from core.config import settings

    employee = _user(pg_db, "employee")
    vendor = _vendor(pg_db, "Unverified Vendor", verified=False)

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: employee
    try:
        assert TestClient(app).post(f"/api/v1/vendors/{vendor.vendor_id}/verify", json={}).status_code == 403
    finally:
        app.dependency_overrides.clear()

    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", False)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        res = TestClient(app).post(f"/api/v1/vendors/{vendor.vendor_id}/verify", json={})
        assert res.status_code == 409 and res.json()["detail"] == "VENDOR_MERCHANT_ONBOARDING_UNAVAILABLE"
    finally:
        app.dependency_overrides.clear()


def test_employee_vendor_list_hides_payout_details(pg_db):
    from main import app

    employee = _user(pg_db, "employee")
    _vendor(pg_db, "Verified Cab Co.")
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: employee
    try:
        rows = TestClient(app).get("/api/v1/vendors").json()
        assert rows and rows[0]["name"] == "Verified Cab Co."
        assert rows[0]["paypal_ready"] is True
        assert rows[0]["paypal_email_masked"] is None
        assert rows[0]["paypal_verified"] is False
    finally:
        app.dependency_overrides.clear()


def test_vendor_account_change_starts_the_72_hour_pause(pg_db):
    from main import app

    requester = _user(pg_db, "requester")
    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    _policy(pg_db, requester)
    vendor = _vendor(pg_db, "Verified Cab Co.")
    old_payer = vendor.paypal_payer_id

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        res = TestClient(app).patch(
            f"/api/v1/vendors/{vendor.vendor_id}/paypal",
            json={"paypal_email": "new-billing@vendor.com"},
        )
        assert res.status_code == 200, res.text
        assert res.json()["cooldown_until"] is not None
    finally:
        app.dependency_overrides.clear()

    pg_db.refresh(vendor)
    assert vendor.paypal_payer_id != old_payer
    assert vendor.payout_destination_changed_at is not None

    reim, _booking_row, _vendor_row, _created = _booking(pg_db, requester, "Verified Cab Co.", amount=40.0)
    assert reim.tier != "AUTO_PAY"
    assert "PAYEE_COOLDOWN" in reim.autonomy["hard_stops"]
    assert initiate_payout_sync(reim.reim_id, pg_db) is None

    # The payout resolver reads the new account, never the old one.
    payee = payee_for_reim(pg_db, reim)
    assert payee is not None and payee.payer_id == vendor.paypal_payer_id


def test_same_vendor_account_does_not_restart_the_pause(pg_db):
    from main import app

    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    vendor = _vendor(pg_db, "Verified Cab Co.")
    vendor.paypal_email = "vendor@example.com"
    vendor.paypal_payer_id = "MOCKV" + hashlib.sha256(b"vendor@example.com").hexdigest()[:12].upper()
    vendor.payout_destination_changed_at = NOW - timedelta(hours=10)
    pg_db.add(vendor)
    pg_db.commit()
    changed_at = vendor.payout_destination_changed_at

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        res = TestClient(app).patch(
            f"/api/v1/vendors/{vendor.vendor_id}/paypal",
            json={"paypal_email": "vendor@example.com"},
        )
        assert res.status_code == 200, res.text
    finally:
        app.dependency_overrides.clear()

    pg_db.refresh(vendor)
    assert vendor.payout_destination_changed_at == changed_at


def test_cooldown_expiry_unlocks_auto_pay(pg_db):
    requester = _user(pg_db)
    _policy(pg_db, requester)
    vendor = _vendor(pg_db, "Verified Cab Co.")
    vendor.payout_destination_changed_at = NOW - timedelta(hours=73)
    pg_db.add(vendor)
    pg_db.commit()

    reim, _booking_row, _vendor_row, _created = _booking(pg_db, requester, "Verified Cab Co.", amount=40.0)
    assert reim.tier == "AUTO_PAY"


def test_vendor_account_change_requires_hr(pg_db):
    from main import app

    employee = _user(pg_db, "employee")
    vendor = _vendor(pg_db, "Verified Cab Co.")
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: employee
    try:
        res = TestClient(app).patch(
            f"/api/v1/vendors/{vendor.vendor_id}/paypal",
            json={"paypal_email": "new-billing@vendor.com"},
        )
        assert res.status_code == 403
    finally:
        app.dependency_overrides.clear()


def test_vendor_payment_reduces_the_company_daily_budget(pg_db):
    from engine.services.autonomy_store import employee_history, ledger_snapshot

    user = _user(pg_db)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")
    reim, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)
    assert reim.status == ReimbursementStatus.APPROVED

    # Approved but unpaid does not reserve budget.
    ledger_before = ledger_snapshot(pg_db, NOW)
    assert ledger_before.vendor_paid_today == 0
    assert ledger_before.auto_paid_today == 0 and ledger_before.auto_paid_last_hour == 0
    before = employee_history(pg_db, user.user_id, NOW)

    assert asyncio.run(initiate_payout_async(reim.reim_id, pg_db)) is not None
    ledger_after = ledger_snapshot(pg_db, NOW)
    # One payment of 40 counts once: vendor spend only, never auto-paid or breaker velocity.
    assert ledger_after.vendor_paid_today == 40.0
    assert ledger_after.auto_paid_today == 0
    assert ledger_after.auto_paid_last_hour == 0

    # A vendor payment is not employee income and must not consume the employee's trust or caps.
    after = employee_history(pg_db, user.user_id, NOW)
    assert after.paid_claims == before.paid_claims
    assert after.auto_paid_today == before.auto_paid_today == 0


def test_vendor_payment_budget_forces_a_clean_booking_to_hr(pg_db, monkeypatch):
    from engine.services import autonomy_store
    from engine.risk.types import AutonomyConfig

    user = _user(pg_db)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")
    _vendor(pg_db, "Budget Cab Co.")

    # Commit most of the company budget as a vendor payment today.
    other, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Budget Cab Co.", amount=40.0)
    assert asyncio.run(initiate_payout_async(other.reim_id, pg_db)) is not None

    monkeypatch.setattr(autonomy_store, "get_config", lambda db: AutonomyConfig(agent_daily_budget=50.0))
    reim, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)

    assert reim.tier != "AUTO_PAY"
    assert "AGENT_DAILY_BUDGET" in reim.autonomy["hard_stops"]


def test_create_booking_api_pays_a_verified_vendor(pg_db, monkeypatch):
    from main import app
    import engine.services.payout_service as payout_service

    monkeypatch.setattr(payout_service, "fire_and_forget_push", lambda *a, **k: None)
    user = _user(pg_db)
    _policy(pg_db, user)
    vendor = _vendor(pg_db, "Verified Cab Co.")

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: user
    try:
        res = TestClient(app).post("/api/v1/vendor-bookings", json={
            "vendor_id": str(vendor.vendor_id),
            "category": "Transportation",
            "amount": 40,
            "service_start": str(NOW.date() + timedelta(days=1)),
            "service_end": str(NOW.date() + timedelta(days=2)),
            "purpose": "Airport transfer",
        })
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["status"] in ("DISBURSING", "PAID")
        assert body["payout"]["status"] == "ACCEPTED"
    finally:
        app.dependency_overrides.clear()

    payout = pg_db.exec(select(Payout).where(Payout.reim_id == UUID(body["reim_id"]))).one()
    assert payout.vendor_id == vendor.vendor_id
    assert payout.user_id == user.user_id


def test_create_booking_api_returns_employee_view(pg_db):
    from main import app

    user = _user(pg_db)
    _policy(pg_db, user)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: user
    try:
        client = TestClient(app)
        res = client.post("/api/v1/vendor-bookings", json={
            "vendor_name": "Api Vendor Sdn Bhd",
            "category": "Transportation",
            "amount": 40,
            "service_start": str(NOW.date() + timedelta(days=1)),
            "service_end": str(NOW.date() + timedelta(days=2)),
            "purpose": "Airport transfer",
        })
        assert res.status_code == 201, res.text
        body = res.json()
        assert body["kind"] == "VENDOR_BOOKING"
        assert body["vendor_name"] == "Api Vendor Sdn Bhd"
        assert body["status"] == "REVIEW"
        assert body["vendor_verified"] is None
        assert body["risk_score"] is None
        assert body["vendor_created"] is True
    finally:
        app.dependency_overrides.clear()


def test_create_booking_api_validates_dates(pg_db):
    from main import app

    user = _user(pg_db)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: user
    try:
        res = TestClient(app).post("/api/v1/vendor-bookings", json={
            "vendor_name": "Api Vendor Sdn Bhd", "category": "Transportation", "amount": 40,
            "service_start": "2026-11-20", "service_end": "2026-11-19", "purpose": "Airport transfer",
        })
        assert res.status_code == 422 and res.json()["detail"] == "SERVICE_END_BEFORE_START"
    finally:
        app.dependency_overrides.clear()


def test_vendor_booking_is_never_an_offset_target(pg_db):
    user = _user(pg_db, paid_claims=0)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)
    assert booking.status == ReimbursementStatus.APPROVED

    rec = Recovery(reim_id=uuid4(), user_id=user.user_id, amount=10.0, currency="MYR", reason="test",
                   status="NOTICE_SENT", dispute_until=NOW + timedelta(days=5), created_by=user.user_id)
    assert find_offset_claim(pg_db, rec) is None


def test_create_recovery_refuses_a_paid_booking(pg_db):
    user = _user(pg_db, paid_claims=0)
    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)
    booking.status = ReimbursementStatus.PAID
    pg_db.add(booking)
    pg_db.commit()

    with pytest.raises(RecoveryError) as err:
        create_recovery(pg_db, booking, Decimal("10.00"), "test", hr, NOW)
    assert err.value.code == "NOT_A_CLAIM"


def test_audit_queue_query_excludes_bookings(pg_db):
    from main import app

    user = _user(pg_db)
    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)
    booking.audit_selected = True
    pg_db.add(booking)
    pg_db.commit()

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        rows = TestClient(app).get("/api/v1/reimbursements/?audit_selected=true&kind=CLAIM").json()
        assert all(row["kind"] == "CLAIM" for row in rows)
        assert str(booking.reim_id) not in {row["reim_id"] for row in rows}
    finally:
        app.dependency_overrides.clear()


def test_recent_claims_and_breaker_window_are_claim_only(pg_db):
    user = _user(pg_db)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)

    claim = Reimbursement(
        user_id=user.user_id, kind="CLAIM", main_category="Meals", currency="MYR",
        total_claimed_amount=12.0, total_approved_amount=12.0, judgment=JudgmentResult.APPROVED,
        summary="recent claim", status=ReimbursementStatus.PAID, tier="AUTO_PAY",
        autonomy={**booking.autonomy, "tier": "AUTO_PAY"}, created_at=NOW, updated_at=NOW,
    )
    pg_db.add(claim)
    pg_db.commit()

    recent = recent_claims(pg_db, user.user_id, NOW)
    assert {r.reim_id for r in recent} == {str(claim.reim_id)}
    decisions = recent_decisions(pg_db, 20)
    assert len(decisions) == 1
    assert decisions[0].tier.value == "AUTO_PAY"


def test_failed_vendor_paypal_call_leaves_the_booking_for_retry(pg_db, monkeypatch):
    from engine.services.paypal_client import MockPayPalClient

    user = _user(pg_db)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)

    original = MockPayPalClient.create_payout
    calls = {"n": 0}

    async def flaky(self, **kwargs):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("PayPal timeout")
        return await original(self, **kwargs)

    monkeypatch.setattr(MockPayPalClient, "create_payout", flaky)

    assert asyncio.run(initiate_payout_async(booking.reim_id, pg_db)) is None
    pg_db.refresh(booking)
    assert booking.status == ReimbursementStatus.APPROVED
    assert pg_db.exec(select(Payout).where(Payout.reim_id == booking.reim_id)).all() == []

    payout = asyncio.run(initiate_payout_async(booking.reim_id, pg_db))
    assert payout is not None
    payouts = pg_db.exec(select(Payout).where(Payout.reim_id == booking.reim_id)).all()
    assert len(payouts) == 1 and payouts[0].attempt == 1


def test_ledger_row_keeps_vendor_payee_and_employee_requester(pg_db):
    from api.payouts import ledger_row

    user = _user(pg_db)
    _policy(pg_db, user)
    vendor = _vendor(pg_db, "Verified Cab Co.")
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)
    payout = asyncio.run(initiate_payout_async(booking.reim_id, pg_db))
    assert payout is not None
    pg_db.refresh(booking)

    row = ledger_row(payout, booking, user, vendor)
    assert row.payee_name == "Verified Cab Co."
    assert row.employee_name == user.name
    assert row.kind == "VENDOR_BOOKING"


def test_rejecting_a_booking_pays_nobody(pg_db, monkeypatch):
    from main import app
    import api.reimbursements as reimbursements_api
    import engine.services.payout_service as payout_service

    monkeypatch.setattr(reimbursements_api, "fire_and_forget_push", lambda *a, **k: None)
    monkeypatch.setattr(payout_service, "fire_and_forget_push", lambda *a, **k: None)
    user = _user(pg_db)
    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    _policy(pg_db, user)
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "New Vendor Sdn Bhd", amount=40.0)

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        res = TestClient(app).patch(
            f"/api/v1/reimbursements/{booking.reim_id}/status",
            json={"status": "REJECTED", "hr_note": "Not approved"},
        )
        assert res.status_code == 200, res.text
    finally:
        app.dependency_overrides.clear()

    pg_db.refresh(booking)
    assert booking.status == ReimbursementStatus.REJECTED
    assert pg_db.exec(select(Payout).where(Payout.reim_id == booking.reim_id)).all() == []


def test_vendor_cooldown_display_uses_live_config(pg_db, monkeypatch):
    from api.vendors import vendor_out
    from engine.services import autonomy_store

    vendor = _vendor(pg_db, "Verified Cab Co.")
    # Relative to the wall clock: this test asserts an active cool-down, so a fixed NOW
    # would start failing as soon as that date's cool-down window passed.
    vendor.payout_destination_changed_at = datetime.now(timezone.utc) - timedelta(hours=1)
    pg_db.add(vendor)
    pg_db.commit()

    shown = vendor_out(vendor, viewer_is_hr=True, cooldown_hours=5)
    assert shown.cooldown_hours == 5
    assert shown.cooldown_until == vendor.payout_destination_changed_at + timedelta(hours=5)

    monkeypatch.setattr(autonomy_store, "payee_cooldown_hours", lambda db: 5)
    handler = _build_reimbursement_response
    user = _user(pg_db, paid_claims=0)
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)
    pg_db.refresh(booking)
    view = handler(booking, pg_db, include_line_items=False, viewer_is_hr=True)
    assert view["vendor_cooldown_hours"] == 5
    until = datetime.fromisoformat(view["vendor_cooldown_until"])
    assert until - vendor.payout_destination_changed_at == timedelta(hours=5)


def test_verification_refuses_an_employee_payer(pg_db):
    from main import app

    hr = _user(pg_db, "hr", role=UserRole.HR, verified=False, paid_claims=0)
    email = "employee-linked@example.com"
    payer = "MOCKV" + hashlib.sha256(email.encode()).hexdigest()[:12].upper()
    employee = _user(pg_db, "employee-payer")
    employee.paypal_payer_id = payer
    pg_db.add(employee)
    pg_db.commit()
    vendor = _vendor(pg_db, "New Vendor Sdn Bhd", verified=False)

    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        res = TestClient(app).post(
            f"/api/v1/vendors/{vendor.vendor_id}/verify",
            json={"paypal_email": email},
        )
        assert res.status_code == 409 and res.json()["detail"] == "PAYEE_ALREADY_LINKED"
    finally:
        app.dependency_overrides.clear()


def test_vendor_payout_notification_names_the_vendor(pg_db):
    from core.models import Notification

    user = _user(pg_db)
    _policy(pg_db, user)
    vendor = _vendor(pg_db, "Verified Cab Co.")
    booking, _booking_row, _vendor_row, _created = _booking(pg_db, user, "Verified Cab Co.", amount=40.0)
    assert asyncio.run(initiate_payout_async(booking.reim_id, pg_db)) is not None

    notes = pg_db.exec(select(Notification).where(Notification.user_id == user.user_id)).all()
    assert any("Vendor paid for booking" in n.title and vendor.name in n.message for n in notes)
