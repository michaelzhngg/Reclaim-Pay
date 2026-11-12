"""Vendor booking intake, routing and employee redaction. Needs TEST_DATABASE_URL."""

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api.reimbursements import _build_reimbursement_response
from core.enums import JudgmentResult, PolicyStatus, ReimbursementStatus, UserRole
from core.models import LineItem, Payout, Policy, PolicyReimbursableCategory, Reimbursement, User, Vendor
from engine.services.payout_service import initiate_payout_sync
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
                    paypal_email="vendor@example.test" if verified else None,
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


def test_verified_vendor_can_auto_pay_without_paying_yet(pg_db):
    user = _user(pg_db)
    _policy(pg_db, user)
    _vendor(pg_db, "Verified Cab Co.")

    reim, _booking_row, vendor, created = _booking(pg_db, user, "Verified Cab Co.")

    assert created is False
    assert reim.tier == "AUTO_PAY"
    assert reim.status == ReimbursementStatus.APPROVED
    assert float(reim.total_approved_amount) == 40.0

    # This slice has no vendor payout path yet: it must refuse rather than pay the employee.
    assert initiate_payout_sync(reim.reim_id, pg_db) is None
    assert pg_db.exec(select(Payout).where(Payout.reim_id == reim.reim_id)).all() == []


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
    assert "vendor@example.test" != hr_view["vendor_paypal_masked"]
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
