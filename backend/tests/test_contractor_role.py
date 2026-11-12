"""Contractor role: creation, sign-in, company-wide refusals and self-scoped reads. Needs TEST_DATABASE_URL."""

from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api.rate_limit import limiter
from core import security
from core.enums import JudgmentResult, PayoutStatus, ReimbursementStatus, UserRole
from core.models import Notification, Payout, Reimbursement, User

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def client(pg_db, monkeypatch):
    from main import app

    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _person(db, role=UserRole.Contractor, password="pw", name="Person"):
    user = User(
        email=f"{uuid4().hex[:8]}@test.local",
        name=name,
        role=role,
        hashed_password=security.get_password_hash(password),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _login(client, user, password="pw"):
    res = client.post("/api/v1/auth/login", data={"username": user.email, "password": password})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _claim(db, user, amount=40.0, category="Meals"):
    claim = Reimbursement(
        user_id=user.user_id,
        main_category=category,
        currency="MYR",
        total_claimed_amount=amount,
        judgment=JudgmentResult.APPROVED,
        status=ReimbursementStatus.REVIEW,
        summary="",
        created_at=NOW,
        updated_at=NOW,
    )
    db.add(claim)
    db.commit()
    db.refresh(claim)
    return claim


def test_hr_creates_a_contractor_and_the_contractor_signs_in(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    email = f"contractor-{uuid4().hex[:8]}@example.com"

    res = client.post(
        "/api/v1/employee/",
        json={"email": email, "name": "Remote Contractor", "role": "Contractor"},
        headers=_login(client, hr),
    )
    assert res.status_code == 201, res.text
    assert res.json()["employee"]["role"] == "Contractor"
    assert res.json()["invite_link"]

    contractor = pg_db.exec(select(User).where(User.email == email)).one()
    assert contractor.role == UserRole.Contractor
    contractor.hashed_password = security.get_password_hash("pw")
    pg_db.add(contractor)
    pg_db.commit()
    me = client.get("/api/v1/auth/me", headers=_login(client, contractor))
    assert me.status_code == 200
    assert me.json()["role"] == "Contractor"


@pytest.mark.parametrize("role", ["Wizard", "", None])
def test_employee_creation_refuses_an_invalid_or_missing_role(client, pg_db, role):
    hr = _person(pg_db, role=UserRole.HR)
    body = {"email": f"bad-{uuid4().hex[:8]}@example.com", "name": "Bad Role"}
    if role is not None:
        body["role"] = role
    res = client.post("/api/v1/employee/", json=body, headers=_login(client, hr))
    assert res.status_code == 422


def test_contractor_can_hold_a_paypal_session_but_hr_still_cannot():
    contractor = User(email="c@test.local", name="C", role=UserRole.Contractor, hashed_password="x",
                      paypal_payer_id="PAYER1", paypal_verified=True)
    employee = User(email="e@test.local", name="E", role=UserRole.Employee, hashed_password="x",
                    paypal_payer_id="PAYER2", paypal_verified=True)
    hr = User(email="h@test.local", name="H", role=UserRole.HR, hashed_password="x",
              paypal_payer_id="PAYER3", paypal_verified=True)

    assert security.paypal_signin_rejection(contractor, "PAYER1") is None
    assert security.paypal_signin_rejection(employee, "PAYER2") is None
    assert security.paypal_signin_rejection(hr, "PAYER3") == "not_employee"


def test_company_wide_reads_are_refused_for_a_contractor(client, pg_db):
    contractor = _person(pg_db)
    headers = _login(client, contractor)
    for path in ("/api/v1/employee/", "/api/v1/vendors", "/api/v1/policies/", "/api/v1/departments/"):
        assert client.get(path, headers=headers).status_code == 403, path


def test_employees_keep_their_company_reads(client, pg_db):
    employee = _person(pg_db, role=UserRole.Employee)
    headers = _login(client, employee)
    for path in ("/api/v1/vendors", "/api/v1/policies/", "/api/v1/departments/"):
        assert client.get(path, headers=headers).status_code == 200, path
    assert client.get("/api/v1/employee/", headers=headers).status_code == 403


def test_self_scoped_reads_work_for_a_contractor(client, pg_db):
    contractor = _person(pg_db)
    other = _person(pg_db, role=UserRole.Employee)
    own = _claim(pg_db, contractor)
    theirs = _claim(pg_db, other)
    pg_db.add(Payout(
        reim_id=own.reim_id, user_id=contractor.user_id, amount=40.0, currency="MYR",
        status=PayoutStatus.SUCCEEDED, idempotency_key="k1", reference_id="RC-1", channel_code="PAYPAL",
        created_at=NOW, updated_at=NOW,
    ))
    pg_db.add(Notification(user_id=contractor.user_id, type="info", title="Own", message="mine"))
    pg_db.add(Notification(user_id=other.user_id, type="info", title="Theirs", message="not mine"))
    pg_db.commit()
    headers = _login(client, contractor)

    listed = client.get("/api/v1/reimbursements/", headers=headers)
    assert listed.status_code == 200
    assert [r["reim_id"] for r in listed.json()] == [str(own.reim_id)]
    assert client.get(f"/api/v1/reimbursements/{own.reim_id}", headers=headers).status_code == 200
    assert client.get(f"/api/v1/reimbursements/{theirs.reim_id}", headers=headers).status_code == 403

    assert client.get("/api/v1/drafts/", headers=headers).status_code == 200
    notes = client.get("/api/v1/notifications/", headers=headers)
    assert notes.status_code == 200
    assert [n["title"] for n in notes.json()] == ["Own"]

    payout = client.get(f"/api/v1/payouts/{own.reim_id}", headers=headers)
    assert payout.status_code == 200
    assert payout.json()["amount"] == 40.0
    assert client.get(f"/api/v1/payouts/{theirs.reim_id}", headers=headers).status_code == 403
