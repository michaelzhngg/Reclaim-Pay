import json
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import select

from api import deps
from api.rate_limit import limiter
from core import security
from core.enums import UserRole
from core.models import AgentAction, Department, User
from engine.services.action_log import verify_chain

PASSWORD = "Harbour-Light7"


@pytest.fixture
def client(pg_db, monkeypatch):
    from main import app

    pg_db.exec(text("DELETE FROM agent_actions"))
    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _person(db, role=UserRole.Employee, active=True, **fields):
    user = User(email=f"{uuid4().hex[:8]}@example.com", name="Person", role=role,
                hashed_password=security.get_password_hash(PASSWORD), is_active=active, **fields)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _bearer(user):
    return {"Authorization": f"Bearer {security.create_access_token(user.email)}"}


def _dept(db, name=None):
    dept = Department(name=name or f"Ops {uuid4().hex[:6]}")
    db.add(dept)
    db.commit()
    db.refresh(dept)
    return dept


def _patch(client, headers, user_id, **body):
    return client.patch(f"/api/v1/employee/{user_id}", json=body, headers=headers)


def _updates(db):
    return db.exec(select(AgentAction).where(AgentAction.action_type == "EMPLOYEE_UPDATED")
                   .order_by(AgentAction.action_id)).all()


@pytest.fixture
def hr(pg_db):
    return _person(pg_db, role=UserRole.HR)


@pytest.fixture
def hr_headers(hr):
    return _bearer(hr)


# Access and lookups

def test_employee_caller_is_refused(client, pg_db):
    target = _person(pg_db)
    caller = _person(pg_db)
    r = _patch(client, _bearer(caller), target.user_id, name="New Name")
    assert r.status_code == 403
    pg_db.refresh(target)
    assert target.name == "Person"


def test_unknown_user_is_404(client, hr_headers):
    r = _patch(client, hr_headers, uuid4(), name="Nobody")
    assert r.status_code == 404
    assert r.json()["detail"] == "Employee not found."


# Editing fields

def test_updates_details_and_returns_the_list_record(client, pg_db, hr_headers):
    dept = _dept(pg_db)
    target = _person(pg_db)
    r = _patch(client, hr_headers, target.user_id,
               name="  Aisha Rahman ", user_code="EMP-0042", department_id=str(dept.department_id))
    assert r.status_code == 200, r.text
    record = r.json()
    assert record["name"] == "Aisha Rahman"
    assert record["user_code"] == "EMP-0042"
    assert record["department_id"] == str(dept.department_id)
    assert record["department_name"] == dept.name
    assert record["email"] == target.email

    listed = client.get("/api/v1/employee/", headers=hr_headers).json()
    match = next(e for e in listed if e["user_id"] == str(target.user_id))
    assert record == match


def test_record_keeps_invite_status_for_an_invited_person(client, hr_headers):
    created = client.post("/api/v1/employee/", headers=hr_headers,
                          json={"name": "New Starter", "email": f"{uuid4().hex[:8]}@example.com"}).json()
    user_id = created["employee"]["user_id"]
    r = _patch(client, hr_headers, user_id, name="New Starter Two")
    assert r.status_code == 200
    assert r.json()["invite_status"] == "pending"


def test_clears_company_id_and_department(client, pg_db, hr_headers):
    dept = _dept(pg_db)
    target = _person(pg_db, user_code=f"C-{uuid4().hex[:6]}", department_id=dept.department_id)
    r = _patch(client, hr_headers, target.user_id, user_code="  ", department_id=None)
    assert r.status_code == 200
    assert r.json()["user_code"] is None
    assert r.json()["department_id"] is None
    assert r.json()["department_name"] is None


def test_duplicate_company_id_is_400(client, pg_db, hr_headers):
    taken = f"C-{uuid4().hex[:6]}"
    _person(pg_db, user_code=taken)
    target = _person(pg_db)
    r = _patch(client, hr_headers, target.user_id, user_code=taken)
    assert r.status_code == 400
    assert r.json()["detail"] == "Another account already uses this company ID."


def test_keeping_your_own_company_id_is_not_a_duplicate(client, pg_db, hr_headers):
    code = f"C-{uuid4().hex[:6]}"
    target = _person(pg_db, user_code=code)
    r = _patch(client, hr_headers, target.user_id, user_code=code, name="Renamed")
    assert r.status_code == 200
    assert r.json()["user_code"] == code


def test_unknown_department_is_400(client, pg_db, hr_headers):
    target = _person(pg_db)
    r = _patch(client, hr_headers, target.user_id, department_id=str(uuid4()))
    assert r.status_code == 400
    assert r.json()["detail"] == "Choose a department from the list."


@pytest.mark.parametrize("body", [
    {"email": "new@example.com"},
    {"hashed_password": "x"},
    {"paypal_payer_id": "PAYER1"},
    {"bank_account_number": "123"},
    {"name": "   "},
    {"name": None},
    {"role": None},
    {"is_active": None},
    {"role": "Admin"},
])
def test_rejects_fields_that_cannot_change_here(client, pg_db, hr_headers, body):
    target = _person(pg_db)
    before = (target.email, target.hashed_password, target.name)
    r = _patch(client, hr_headers, target.user_id, **body)
    assert r.status_code == 422
    pg_db.refresh(target)
    assert (target.email, target.hashed_password, target.name) == before


def test_no_change_writes_no_log_entry(client, pg_db, hr_headers):
    target = _person(pg_db)
    r = _patch(client, hr_headers, target.user_id, name="Person", is_active=True)
    assert r.status_code == 200
    assert _updates(pg_db) == []


# Self-protection and the last HR account

def test_hr_cannot_deactivate_themselves(client, pg_db, hr, hr_headers):
    _person(pg_db, role=UserRole.HR)
    r = _patch(client, hr_headers, hr.user_id, is_active=False)
    assert r.status_code == 400
    assert r.json()["detail"] == "You can't deactivate your own account. Ask another HR admin to do it."
    pg_db.refresh(hr)
    assert hr.is_active


def test_hr_cannot_demote_themselves(client, pg_db, hr, hr_headers):
    _person(pg_db, role=UserRole.HR)
    r = _patch(client, hr_headers, hr.user_id, role="Employee")
    assert r.status_code == 400
    assert r.json()["detail"] == "You can't remove your own HR access. Ask another HR admin to do it."
    pg_db.refresh(hr)
    assert hr.role == UserRole.HR.value


def test_hr_can_edit_their_own_name(client, pg_db, hr, hr_headers):
    r = _patch(client, hr_headers, hr.user_id, name="Demo HR", role="HR", is_active=True)
    assert r.status_code == 200
    assert r.json()["name"] == "Demo HR"


def test_refuses_to_leave_no_active_hr(client, pg_db):
    # Two HR admins remove each other at once: the caller passed the role check, then lost HR first.
    from main import app

    pg_db.exec(text("UPDATE employees SET is_active = false WHERE role = 'HR'"))
    caller = _person(pg_db, role=UserRole.Employee)
    only_hr = _person(pg_db, role=UserRole.HR)
    app.dependency_overrides[deps.get_current_hr_user] = lambda: caller
    for body in ({"role": "Employee"}, {"is_active": False}):
        r = client.patch(f"/api/v1/employee/{only_hr.user_id}", json=body)
        assert r.status_code == 409
        assert r.json()["detail"] == "This is the only active HR account. Make someone else HR first."
    pg_db.refresh(only_hr)
    assert only_hr.role == UserRole.HR.value and only_hr.is_active


def test_demoting_another_hr_removes_their_access(client, pg_db, hr_headers):
    other = _person(pg_db, role=UserRole.HR)
    assert client.get("/api/v1/employee/", headers=_bearer(other)).status_code == 200
    r = _patch(client, hr_headers, other.user_id, role="Employee")
    assert r.status_code == 200
    assert r.json()["role"] == "Employee"
    assert client.get("/api/v1/employee/", headers=_bearer(other)).status_code == 403


# Action log

def test_role_change_to_hr_is_logged_without_secrets(client, pg_db, hr, hr_headers):
    dept = _dept(pg_db)
    target = _person(pg_db, user_code="OLD-1")
    r = _patch(client, hr_headers, target.user_id, role="HR", name="Lee Wong",
               user_code="NEW-1", department_id=str(dept.department_id))
    assert r.status_code == 200

    [entry] = _updates(pg_db)
    assert entry.actor == str(hr.user_id)
    assert entry.payload == {
        "user_id": str(target.user_id),
        "fields": ["department_id", "name", "role", "user_code"],
        "changes": {
            "department_id": {"from": None, "to": str(dept.department_id)},
            "name": {"from": "Person", "to": "Lee Wong"},
            "role": {"from": "Employee", "to": "HR"},
            "user_code": {"from": "OLD-1", "to": "NEW-1"},
        },
    }
    raw = json.dumps(entry.payload).lower()
    assert target.email.lower() not in raw
    assert "password" not in raw and "token" not in raw and "@" not in raw
    assert verify_chain(pg_db)


def test_deactivation_is_logged(client, pg_db, hr_headers):
    target = _person(pg_db)
    _patch(client, hr_headers, target.user_id, is_active=False)
    [entry] = _updates(pg_db)
    assert entry.payload["fields"] == ["is_active"]
    assert entry.payload["changes"] == {"is_active": {"from": True, "to": False}}


# Sessions

def test_deactivation_ends_existing_sessions_and_blocks_sign_in(client, pg_db, hr_headers):
    target = _person(pg_db)
    old_session = _bearer(target)
    assert client.get("/api/v1/auth/me", headers=old_session).status_code == 200
    assert client.get("/api/v1/reimbursements/", headers=old_session).status_code == 200
    assert client.post("/api/v1/auth/login", data={"username": target.email, "password": PASSWORD}).status_code == 200

    assert _patch(client, hr_headers, target.user_id, is_active=False).status_code == 200
    assert client.get("/api/v1/auth/me", headers=old_session).status_code == 401
    assert client.get("/api/v1/reimbursements/", headers=old_session).status_code == 401
    assert client.post("/api/v1/auth/login", data={"username": target.email, "password": PASSWORD}).status_code == 401


def test_reactivation_keeps_the_password(client, pg_db, hr_headers):
    target = _person(pg_db, active=False)
    hashed, changed_at = target.hashed_password, target.password_changed_at
    r = _patch(client, hr_headers, target.user_id, is_active=True)
    assert r.status_code == 200 and r.json()["is_active"] is True
    pg_db.refresh(target)
    assert (target.hashed_password, target.password_changed_at) == (hashed, changed_at)
    assert client.post("/api/v1/auth/login", data={"username": target.email, "password": PASSWORD}).status_code == 200
    [entry] = _updates(pg_db)
    assert entry.payload["changes"] == {"is_active": {"from": False, "to": True}}


def test_active_users_keep_their_sessions(client, pg_db, hr_headers):
    target = _person(pg_db)
    session = _bearer(target)
    assert _patch(client, hr_headers, target.user_id, name="Still Here").status_code == 200
    assert client.get("/api/v1/auth/me", headers=session).status_code == 200
