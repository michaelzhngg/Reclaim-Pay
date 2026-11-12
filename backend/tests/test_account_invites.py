import contextlib
import json
import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import httpx
import pytest
import respx
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import select

import api.auth as auth_api
from api import deps
from api.rate_limit import limiter
from core import email_service, password_tokens, security
from core.config import settings
from core.enums import UserRole
from core.models import AgentAction, Department, PasswordToken, User
from core.password_policy import MAX_BYTES, password_problems
from engine.services.action_log import verify_chain

GOOD = "Harbour-Light7"
FORGOT = {"detail": "If an account exists for that email, we sent a reset link."}
INVITE_ERROR = "This link has expired or was already used. Ask HR to send a new invitation."
RESET_ERROR = "This link has expired or was already used. Request a new reset link."


# Password policy

def test_policy_accepts_a_password_that_meets_every_rule():
    assert password_problems(GOOD) == []


@pytest.mark.parametrize("password, problem", [
    ("Ab1!xyz", "Use at least 8 characters."),
    ("harbour-light7", "Add an uppercase letter."),
    ("HARBOUR-LIGHT7", "Add a lowercase letter."),
    ("Harbour-Light", "Add a number."),
    ("HarbourLight7", "Add a special character, such as ! or #."),
])
def test_policy_names_each_missing_rule(password, problem):
    assert password_problems(password) == [problem]


def test_space_is_not_a_special_character():
    assert "Add a special character, such as ! or #." in password_problems("Harbour Light7")


def test_policy_enforces_bcrypt_byte_limit():
    at_limit = "Aa1!" + "x" * (MAX_BYTES - 4)
    assert password_problems(at_limit) == []
    assert any("72 bytes" in p for p in password_problems(at_limit + "x"))
    # 18 emoji are 18 characters but 72 bytes; one more crosses the limit.
    assert any("72 bytes" in p for p in password_problems("Aa1!" + "\U0001F600" * 18))


def test_new_sessions_carry_issued_at():
    from jose import jwt
    token = security.create_access_token("a@example.com")
    claims = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    assert isinstance(claims["iat"], float)
    assert abs(claims["iat"] - datetime.now(timezone.utc).timestamp()) < 5


def test_stale_session_rule():
    changed = datetime(2026, 11, 12, 10, tzinfo=timezone.utc)
    assert not deps.issued_before_password_change({}, None)
    assert not deps.issued_before_password_change({"iat": 1.0}, None)
    assert deps.issued_before_password_change({"iat": changed.timestamp() - 1}, changed)
    assert deps.issued_before_password_change({}, changed)
    assert not deps.issued_before_password_change({"iat": changed.timestamp() + 0.001}, changed)


# Database-backed flows

@pytest.fixture
def resend(monkeypatch):
    monkeypatch.setattr(settings, "RESEND_API_KEY", "re_test_not_a_real_key")
    monkeypatch.setattr(settings, "FRONTEND_PUBLIC_URL", "https://reclaimai.dev")
    # Send inline so each test can count calls without waiting on threads.
    monkeypatch.setattr(email_service, "fire_and_forget_email", email_service.send_email_sync)
    import core.account_emails as account_emails
    monkeypatch.setattr(account_emails, "fire_and_forget_email", email_service.send_email_sync)
    with respx.mock(assert_all_called=False) as router:
        yield router.post(email_service.RESEND_URL).mock(return_value=httpx.Response(200, json={"id": "e1"}))


@pytest.fixture
def client(pg_db, monkeypatch, resend):
    from main import app

    pg_db.exec(text("DELETE FROM agent_actions"))
    monkeypatch.setattr(limiter, "enabled", False)
    monkeypatch.setattr(auth_api, "open_session", lambda: contextlib.nullcontext(pg_db))
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _person(db, role=UserRole.Employee, password="password", active=True, email=None):
    user = User(email=email or f"{uuid4().hex[:8]}@example.com", name="Person", role=role,
                hashed_password=security.get_password_hash(password), is_active=active)
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _bearer(db, user):
    return {"Authorization": f"Bearer {security.create_access_token(user.email)}"}


def _dept(db):
    dept = Department(name=f"Ops {uuid4().hex[:6]}")
    db.add(dept)
    db.commit()
    db.refresh(dept)
    return dept


def _create(client, hr_headers, **fields):
    body = {"name": "Aisha Rahman", "email": f"{uuid4().hex[:8]}@example.com",
            "role": "Employee", **fields}
    return client.post("/api/v1/employee/", json=body, headers=hr_headers)


def _token_from(link: str) -> str:
    return parse_qs(urlparse(link).query)["token"][0]


def _sent(route):
    return [json.loads(call.request.content) for call in route.calls]


def _login(client, email, password):
    return client.post("/api/v1/auth/login", data={"username": email, "password": password})


def _set(client, token, purpose="invite", password=GOOD):
    return client.post("/api/v1/auth/set-password",
                       json={"token": token, "purpose": purpose, "new_password": password})


def _reset_token(db, user):
    plain, _ = password_tokens.issue(db, user, password_tokens.RESET)
    db.commit()
    return plain


# Token lifecycle

def test_token_lifecycle(pg_db):
    user = _person(pg_db)
    now = datetime.now(timezone.utc)
    plain, row = password_tokens.issue(pg_db, user, password_tokens.INVITE, now)
    pg_db.commit()
    assert row.token_hash == password_tokens.hash_token(plain) and plain not in row.token_hash
    assert row.expires_at == now + timedelta(days=7)

    assert password_tokens.find_valid(pg_db, plain, "invite")
    assert password_tokens.find_valid(pg_db, plain, "reset") is None
    assert password_tokens.find_valid(pg_db, plain, "invite", now=now + timedelta(days=7, seconds=1)) is None
    assert password_tokens.find_valid(pg_db, "not-a-token", "invite") is None

    newer, _ = password_tokens.issue(pg_db, user, password_tokens.INVITE)
    pg_db.commit()
    assert password_tokens.find_valid(pg_db, plain, "invite") is None
    assert password_tokens.find_valid(pg_db, newer, "invite")

    reset, reset_row = password_tokens.issue(pg_db, user, password_tokens.RESET, now)
    pg_db.commit()
    assert reset_row.expires_at == now + timedelta(minutes=30)
    # A reset link leaves the open invite alone; only same-purpose tokens are replaced.
    assert password_tokens.find_valid(pg_db, newer, "invite")
    assert password_tokens.find_valid(pg_db, reset, "reset", now=now + timedelta(minutes=31)) is None


# Create employee

def test_only_hr_can_create(client, pg_db):
    employee = _person(pg_db)
    assert _create(client, _bearer(pg_db, employee)).status_code == 403
    assert client.post("/api/v1/employee/", json={"name": "A", "email": "a@example.com", "role": "Employee"}).status_code == 401


def test_create_invites_and_returns_the_link_once(client, pg_db, resend):
    hr = _person(pg_db, role=UserRole.HR)
    dept = _dept(pg_db)
    email = f"{uuid4().hex[:8]}@example.com"
    res = _create(client, _bearer(pg_db, hr), email=email, user_code=f"E-{uuid4().hex[:6]}",
                  department_id=str(dept.department_id))
    assert res.status_code == 201, res.text
    body = res.json()
    assert body["employee"]["email"] == email
    assert body["employee"]["role"] == "Employee"
    assert body["employee"]["department_name"] == dept.name
    assert body["employee"]["invite_status"] == "pending"
    assert body["invite_link"].startswith("https://reclaimai.dev/set-password?token=")
    plain = _token_from(body["invite_link"])

    user = pg_db.exec(select(User).where(User.email == email)).one()
    assert user.rank == 1 and user.is_active and user.password_changed_at is None
    [row] = pg_db.exec(select(PasswordToken).where(PasswordToken.user_id == user.user_id)).all()
    assert row.purpose == "invite" and row.token_hash == password_tokens.hash_token(plain)
    stored = pg_db.exec(text("SELECT token_hash FROM password_tokens")).all()
    assert all(plain not in r[0] for r in stored)

    [mail] = _sent(resend)
    assert mail["to"] == [email]
    assert mail["subject"] == "Set up your Reclaim Pay account"
    assert plain in mail["text"] and "Hi Aisha Rahman," in mail["text"] and "7 days" in mail["text"]

    # The account can't sign in until the password is set.
    for guess in ("password", GOOD):
        assert _login(client, email, guess).status_code == 401

    listed = client.get("/api/v1/employee/", headers=_bearer(pg_db, hr)).json()
    assert all("invite_link" not in r and plain not in json.dumps(r) for r in listed)

    [action] = pg_db.exec(select(AgentAction).where(AgentAction.action_type == "EMPLOYEE_CREATED")).all()
    assert action.actor == str(hr.user_id)
    assert action.payload == {"user_id": str(user.user_id), "role": "Employee"}
    assert verify_chain(pg_db)


def test_create_honours_hr_role(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    res = _create(client, _bearer(pg_db, hr), role="HR")
    assert res.status_code == 201 and res.json()["employee"]["role"] == "HR"


def test_duplicate_email_is_rejected(client, pg_db, resend):
    hr = _person(pg_db, role=UserRole.HR)
    existing = _person(pg_db)
    res = _create(client, _bearer(pg_db, hr), email=existing.email.upper())
    assert res.status_code == 400
    assert res.json()["detail"] == "An account with this email already exists."
    assert not resend.called


# Resend

def test_resend_replaces_the_link(client, pg_db, resend):
    hr = _person(pg_db, role=UserRole.HR)
    first = _create(client, _bearer(pg_db, hr)).json()
    user_id = first["employee"]["user_id"]
    res = client.post(f"/api/v1/employee/{user_id}/invite", headers=_bearer(pg_db, hr))
    assert res.status_code == 200, res.text
    second = res.json()["invite_link"]
    assert second != first["invite_link"]

    old = _set(client, _token_from(first["invite_link"]))
    assert old.status_code == 400 and old.json()["detail"] == INVITE_ERROR
    assert len(_sent(resend)) == 2
    [action] = pg_db.exec(select(AgentAction).where(AgentAction.action_type == "INVITE_RESENT")).all()
    assert action.payload == {"user_id": user_id}

    assert _set(client, _token_from(second)).status_code == 200
    again = client.post(f"/api/v1/employee/{user_id}/invite", headers=_bearer(pg_db, hr))
    assert again.status_code == 409


def test_resend_is_hr_only(client, pg_db):
    target = _person(pg_db)
    employee = _person(pg_db)
    res = client.post(f"/api/v1/employee/{target.user_id}/invite", headers=_bearer(pg_db, employee))
    assert res.status_code == 403


# Invite status in the HR list

def test_invite_status_values(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    headers = _bearer(pg_db, hr)
    pending = _create(client, headers).json()
    expired = _create(client, headers).json()
    done = _create(client, headers).json()
    expired_id = expired["employee"]["user_id"]
    pg_db.exec(text("UPDATE password_tokens SET expires_at = now() - interval '1 minute' WHERE user_id = :u")
               .bindparams(u=expired_id))
    pg_db.commit()
    assert _set(client, _token_from(done["invite_link"])).status_code == 200

    status = {r["user_id"]: r["invite_status"] for r in client.get("/api/v1/employee/", headers=headers).json()}
    assert status[pending["employee"]["user_id"]] == "pending"
    assert status[expired_id] == "expired"
    assert status[done["employee"]["user_id"]] is None
    assert status[str(hr.user_id)] is None


# Set password

def test_invite_then_login(client, pg_db, resend):
    hr = _person(pg_db, role=UserRole.HR)
    created = _create(client, _bearer(pg_db, hr)).json()
    token = _token_from(created["invite_link"])
    email = created["employee"]["email"]

    info = client.post("/api/v1/auth/password-token", json={"token": token, "purpose": "invite"})
    assert info.status_code == 200
    assert info.json()["name"] == "Aisha Rahman" and info.json()["email_masked"].endswith("@example.com")
    assert info.json()["email_masked"] != email

    weak = _set(client, token, password="password")
    assert weak.status_code == 400 and "uppercase" in weak.json()["detail"]

    res = _set(client, token)
    assert res.status_code == 200 and res.json()["purpose"] == "invite"
    assert _login(client, email, GOOD).status_code == 200
    # First-time setup sends no extra notice.
    assert [m["subject"] for m in _sent(resend)] == ["Set up your Reclaim Pay account"]

    reused = _set(client, token, password="Another-Pass9")
    assert reused.status_code == 400 and reused.json()["detail"] == INVITE_ERROR
    assert client.post("/api/v1/auth/password-token",
                       json={"token": token, "purpose": "invite"}).status_code == 400


def test_wrong_purpose_and_unknown_tokens(client, pg_db):
    user = _person(pg_db)
    token = _reset_token(pg_db, user)
    res = _set(client, token, purpose="invite")
    assert res.status_code == 400 and res.json()["detail"] == INVITE_ERROR
    res = _set(client, "made-up", purpose="reset")
    assert res.status_code == 400 and res.json()["detail"] == RESET_ERROR


def test_reset_ends_old_sessions(client, pg_db, resend):
    user = _person(pg_db)
    old_session = _login(client, user.email, "password").json()["access_token"]
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {old_session}"})
    assert me.status_code == 200

    res = _set(client, _reset_token(pg_db, user), purpose="reset")
    assert res.status_code == 200 and res.json()["purpose"] == "reset"

    for path in ("/api/v1/auth/me", "/api/v1/paypal/status"):
        assert client.get(path, headers={"Authorization": f"Bearer {old_session}"}).status_code == 401
    assert _login(client, user.email, "password").status_code == 401
    fresh = _login(client, user.email, GOOD).json()["access_token"]
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {fresh}"}).status_code == 200

    [notice] = _sent(resend)
    assert notice["subject"] == "Your Reclaim Pay password was changed" and notice["to"] == [user.email]
    assert "contact HR" in notice["text"]


def test_users_who_never_reset_keep_their_sessions(client, pg_db):
    user = _person(pg_db)
    session = _login(client, user.email, "password").json()["access_token"]
    assert client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {session}"}).status_code == 200


def test_set_password_rejects_overlong_password(client, pg_db):
    user = _person(pg_db)
    res = _set(client, _reset_token(pg_db, user), purpose="reset", password="Aa1!" + "x" * 80)
    assert res.status_code == 400 and "72 bytes" in res.json()["detail"]


# Forgot password

def test_forgot_password_looks_the_same_for_every_email(client, pg_db, resend):
    active = _person(pg_db)
    inactive = _person(pg_db, active=False)
    replies = [client.post("/api/v1/auth/forgot-password", json={"email": e})
               for e in (active.email, inactive.email, "nobody@example.com")]
    assert {r.status_code for r in replies} == {200}
    assert all(r.json() == FORGOT for r in replies)
    assert len({r.content for r in replies}) == 1

    [mail] = _sent(resend)
    assert mail["to"] == [active.email]
    assert mail["subject"] == "Reset your Reclaim Pay password"
    assert "30 minutes" in mail["text"]
    link = next(w for w in mail["text"].split() if w.startswith("https://reclaimai.dev/reset-password?token="))
    assert _set(client, _token_from(link), purpose="reset").status_code == 200


def test_forgot_password_caps_emails_per_account(client, pg_db, resend):
    user = _person(pg_db)
    for _ in range(5):
        res = client.post("/api/v1/auth/forgot-password", json={"email": user.email})
        assert res.status_code == 200 and res.json() == FORGOT
    assert len(_sent(resend)) == password_tokens.RESET_EMAILS_PER_HOUR


def test_secrets_never_reach_the_logs(client, pg_db, resend, caplog):
    hr = _person(pg_db, role=UserRole.HR)
    user = _person(pg_db)
    with caplog.at_level(logging.DEBUG):
        created = _create(client, _bearer(pg_db, hr)).json()
        invite = _token_from(created["invite_link"])
        resent = client.post(f"/api/v1/employee/{created['employee']['user_id']}/invite",
                             headers=_bearer(pg_db, hr)).json()
        client.post("/api/v1/auth/forgot-password", json={"email": user.email})
        _set(client, _token_from(resent["invite_link"]))
    secrets_seen = [invite, _token_from(resent["invite_link"]), GOOD]
    secrets_seen += [r[0] for r in pg_db.exec(text("SELECT token_hash FROM password_tokens")).all()]
    logged = "\n".join(r.getMessage() for r in caplog.records)
    assert all(s not in logged for s in secrets_seen)
