from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlparse
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from jose import jwt
from sqlalchemy import text
from sqlmodel import select

import api.paypal as paypal_api
from api import deps
from api.paypal import MOCK_SIGNIN_CODE, make_signin_state, make_state, read_signin_state, read_state
from api.rate_limit import limiter
from core import security
from core.config import settings
from core.enums import UserRole
from core.models import AgentAction, Notification, User, Vendor
from engine.services import payout_service
from engine.services.action_log import verify_chain
from engine.services.paypal_client import PayPalError, PayPalUser

NOW = datetime(2026, 11, 3, 10, tzinfo=timezone.utc)
BINDING = "browser-binding"
FAILURE = {"detail": "PayPal sign-in failed"}


def test_signin_state_roundtrip():
    read_signin_state(make_signin_state(BINDING, "s", NOW), BINDING, "s", NOW + timedelta(minutes=9))


def test_signin_state_expires_after_ten_minutes():
    with pytest.raises(ValueError):
        read_signin_state(make_signin_state(BINDING, "s", NOW), BINDING, "s", NOW + timedelta(minutes=11))


def test_signin_state_rejects_tampering():
    state = make_signin_state(BINDING, "s", NOW)
    header, payload, signature = state.split(".")
    flipped = ("A" if signature[0] != "A" else "B") + signature[1:]
    for bad in (f"{header}.{payload}.{flipped}", f"{header}.{payload}x.{signature}", "not-a-token", ""):
        with pytest.raises(ValueError):
            read_signin_state(bad, BINDING, "s", NOW)
    with pytest.raises(ValueError):
        read_signin_state(state, BINDING, "other-secret", NOW)


def test_signin_state_is_bound_to_the_browser_that_started():
    state = make_signin_state(BINDING, "s", NOW)
    assert BINDING not in jwt.get_unverified_claims(state).values()
    for wrong in ("another-browser", ""):
        with pytest.raises(ValueError):
            read_signin_state(state, wrong, "s", NOW)


def test_states_do_not_cross_flows():
    with pytest.raises(ValueError):
        read_signin_state(make_state(uuid4(), "s", NOW), BINDING, "s", NOW)
    with pytest.raises(ValueError):
        read_state(make_signin_state(BINDING, "s", NOW), "s", NOW)


class FakePayPal:
    """Stands in for the real client with mock mode off, so nothing reaches PayPal."""

    def __init__(self, user: PayPalUser | None = None):
        self.user = user

    async def exchange_auth_code(self, code):
        if self.user is None:
            raise PayPalError(401, "invalid_grant")
        return "USER-TOKEN"

    async def get_userinfo(self, token):
        return self.user


def _person(db, role=UserRole.Employee, payer="PAYER1", verified=True, active=True, email=None):
    user = User(email=email or f"{uuid4().hex[:8]}@test.local", name="Person", role=role,
                hashed_password=security.get_password_hash("pw"), is_active=active,
                paypal_payer_id=payer, paypal_verified=verified,
                paypal_email="linked@paypal.test" if payer else None,
                paypal_linked_at=datetime.now(timezone.utc) - timedelta(days=30))
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


@pytest.fixture
def client(pg_db, monkeypatch):
    from main import app

    pg_db.exec(text("DELETE FROM agent_actions"))
    # Push delivery opens its own session on DATABASE_URL; keep tests on the scratch DB only.
    monkeypatch.setattr(payout_service, "fire_and_forget_push", lambda *a, **k: None)
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", False)
    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _use_paypal(monkeypatch, payer="PAYER1", email="someone@test.local", verified=True):
    monkeypatch.setattr(paypal_api, "get_paypal_client", lambda: FakePayPal(PayPalUser(payer, email, verified)))


def _complete(client, code="auth-code", state=None, binding=BINDING):
    state = state if state is not None else make_signin_state(BINDING, settings.SECRET_KEY, datetime.now(timezone.utc))
    return client.post("/api/v1/paypal/signin/complete", json={"code": code, "state": state, "binding": binding})


def _bearer(token):
    return {"Authorization": f"Bearer {token}"}


def _signin(client, monkeypatch, payer="PAYER1"):
    _use_paypal(monkeypatch, payer=payer)
    res = _complete(client)
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


def _password_login(client, user):
    res = client.post("/api/v1/auth/login", data={"username": user.email, "password": "pw"})
    assert res.status_code == 200, res.text
    return res.json()["access_token"]


def _actions(db):
    return db.exec(select(AgentAction).where(AgentAction.action_type == "PAYPAL_SIGNIN")).all()


def test_linked_verified_employee_signs_in(client, pg_db, monkeypatch):
    user = _person(pg_db)
    _use_paypal(monkeypatch)
    res = _complete(client)
    assert res.status_code == 200
    assert res.json()["expires_in"] == 72 * 3600

    me = client.get("/api/v1/auth/me", headers=_bearer(res.json()["access_token"]))
    assert me.status_code == 200 and me.json()["user_id"] == str(user.user_id)

    [action] = _actions(pg_db)
    assert action.actor == str(user.user_id) and action.payload["outcome"] == "signed_in"
    assert verify_chain(pg_db)
    notes = pg_db.exec(select(Notification).where(Notification.user_id == user.user_id)).all()
    assert [n.title for n in notes] == ["New sign-in with PayPal"]


def test_seeded_sandbox_can_sign_in_when_paypal_omits_verification(client, pg_db, monkeypatch):
    user = _person(pg_db)
    _use_paypal(monkeypatch, verified=False)
    monkeypatch.setattr(settings, "PAYPAL_ALLOW_UNVERIFIED_SANDBOX", True)
    monkeypatch.setattr(settings, "PAYPAL_BASE_URL", "https://api-m.sandbox.paypal.com")
    res = _complete(client)
    assert res.status_code == 200
    [action] = _actions(pg_db)
    assert action.actor == str(user.user_id)
    assert action.payload["outcome"] == "signed_in"
    assert action.payload["verification"] == "seeded_sandbox"


def test_unknown_payer_gets_a_plain_failure(client, pg_db, monkeypatch):
    _person(pg_db)
    before = pg_db.exec(select(User)).all()
    _use_paypal(monkeypatch, payer="NOBODY")
    res = _complete(client)
    assert res.status_code == 401 and res.json() == FAILURE
    assert len(pg_db.exec(select(User)).all()) == len(before)
    [action] = _actions(pg_db)
    assert action.actor == "unknown" and action.payload == {
        "outcome": "rejected", "reason": "unknown_payer",
        "verified": True, "verified_account": None, "email_verified": None,
    }


def test_email_match_is_never_used(client, pg_db, monkeypatch):
    target = _person(pg_db, payer="TARGET", email="target@test.local")
    target.paypal_email = "shared@paypal.test"
    pg_db.add(target)
    pg_db.commit()
    for email in ("target@test.local", "shared@paypal.test"):
        _use_paypal(monkeypatch, payer="ATTACKER", email=email)
        res = _complete(client)
        assert res.status_code == 401 and res.json() == FAILURE


def test_hr_is_rejected_with_the_same_failure(client, pg_db, monkeypatch):
    hr = _person(pg_db, role=UserRole.HR, payer="HRPAYER")
    _use_paypal(monkeypatch, payer="HRPAYER")
    res = _complete(client)
    assert res.status_code == 401 and res.json() == FAILURE
    [action] = _actions(pg_db)
    assert action.actor == str(hr.user_id) and action.payload["reason"] == "not_employee"


def test_payer_shared_with_hr_is_rejected(client, pg_db, monkeypatch):
    _person(pg_db, payer="SHARED")
    _person(pg_db, role=UserRole.HR, payer="SHARED")
    _use_paypal(monkeypatch, payer="SHARED")
    res = _complete(client)
    assert res.status_code == 401 and res.json() == FAILURE


@pytest.mark.parametrize("kwargs, paypal_verified", [
    ({"verified": False}, True),
    ({"active": False}, True),
    ({}, False),
])
def test_unverified_or_inactive_is_rejected(client, pg_db, monkeypatch, kwargs, paypal_verified):
    _person(pg_db, **kwargs)
    _use_paypal(monkeypatch, verified=paypal_verified)
    res = _complete(client)
    assert res.status_code == 401 and res.json() == FAILURE


def test_signin_never_links_or_changes_the_account(client, pg_db, monkeypatch):
    user = _person(pg_db)
    before = (user.paypal_email, user.paypal_linked_at, user.payout_destination_changed_at)
    _use_paypal(monkeypatch, email="new-address@paypal.test")
    assert _complete(client).status_code == 200
    pg_db.refresh(user)
    assert (user.paypal_email, user.paypal_linked_at, user.payout_destination_changed_at) == before


def test_connect_state_is_rejected_at_signin(client, pg_db, monkeypatch):
    user = _person(pg_db)
    _use_paypal(monkeypatch)
    state = make_state(user.user_id, settings.SECRET_KEY, datetime.now(timezone.utc))
    res = _complete(client, state=state)
    assert res.status_code == 401 and res.json() == FAILURE


def test_signin_state_is_rejected_at_connect_callback(client, pg_db, monkeypatch):
    user = _person(pg_db)
    _use_paypal(monkeypatch, payer="OTHERPAYER")
    state = make_signin_state(BINDING, settings.SECRET_KEY, datetime.now(timezone.utc))
    res = client.get("/api/v1/paypal/callback", params={"code": "c", "state": state}, follow_redirects=False)
    assert res.status_code == 302 and res.headers["location"].endswith("paypal=error")
    pg_db.refresh(user)
    assert user.paypal_payer_id == "PAYER1"


def test_expired_tampered_or_unbound_state_is_rejected(client, pg_db, monkeypatch):
    _person(pg_db)
    _use_paypal(monkeypatch)
    now = datetime.now(timezone.utc)
    expired = make_signin_state(BINDING, settings.SECRET_KEY, now - timedelta(minutes=11))
    tampered = make_signin_state(BINDING, "wrong-secret", now)
    for res in (_complete(client, state=expired), _complete(client, state=tampered), _complete(client, binding="other")):
        assert res.status_code == 401 and res.json() == FAILURE
    assert _actions(pg_db) == []


def test_session_token_is_not_a_state(client, pg_db, monkeypatch):
    user = _person(pg_db)
    _use_paypal(monkeypatch)
    res = _complete(client, state=_password_login(client, user))
    assert res.status_code == 401


def test_paypal_error_is_a_plain_failure(client, pg_db, monkeypatch):
    monkeypatch.setattr(paypal_api, "get_paypal_client", lambda: FakePayPal(None))
    res = _complete(client)
    assert res.status_code == 401 and res.json() == FAILURE


def test_paypal_session_cannot_change_the_link(client, pg_db, monkeypatch):
    user = _person(pg_db)
    headers = _bearer(_signin(client, monkeypatch))

    assert client.get("/api/v1/paypal/connect-url", headers=headers).status_code == 403
    assert client.delete("/api/v1/paypal/link", headers=headers).status_code == 403
    pg_db.refresh(user)
    assert user.paypal_payer_id == "PAYER1"

    status = client.get("/api/v1/paypal/status", headers=headers).json()
    until = datetime.fromisoformat(status["link_changes_paused_until"])
    remaining = until - datetime.now(timezone.utc)
    assert timedelta(hours=71, minutes=59) < remaining <= timedelta(hours=72)


def test_paypal_session_cannot_outlive_its_pause(client, pg_db, monkeypatch):
    _person(pg_db)
    token = _signin(client, monkeypatch)
    claims = jwt.get_unverified_claims(token)
    expired = {**claims, "exp": int((datetime.now(timezone.utc) - timedelta(seconds=1)).timestamp())}
    stale = jwt.encode(expired, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    assert client.get("/api/v1/paypal/connect-url", headers=_bearer(stale)).status_code == 401
    assert client.delete("/api/v1/paypal/link", headers=_bearer(stale)).status_code == 401


def test_paypal_session_cannot_change_the_password_login_email(client, pg_db, monkeypatch):
    user = _person(pg_db)
    headers = _bearer(_signin(client, monkeypatch))
    body = {"name": "Renamed", "email": "attacker@test.local"}
    assert client.put("/api/v1/auth/me", json=body, headers=headers).status_code == 403
    pg_db.refresh(user)
    assert user.email != "attacker@test.local"
    assert client.put("/api/v1/auth/me", json={"name": "Renamed", "email": user.email}, headers=headers).status_code == 200


def test_signin_does_not_block_auto_pay(client, pg_db, monkeypatch):
    from engine.services.autonomy_store import payee_from_user

    user = _person(pg_db)
    _signin(client, monkeypatch)
    pg_db.refresh(user)
    payee = payee_from_user(user)
    assert user.payout_destination_changed_at is None
    assert payee.verified is True and payee.changed_at is None


def test_password_login_is_unaffected(client, pg_db, monkeypatch):
    user = _person(pg_db)
    _signin(client, monkeypatch)

    headers = _bearer(_password_login(client, user))
    status = client.get("/api/v1/paypal/status", headers=headers).json()
    assert status["link_changes_paused_until"] is None
    assert client.get("/api/v1/paypal/connect-url", headers=headers).status_code == 200
    assert client.delete("/api/v1/paypal/link", headers=headers).status_code == 204


def test_password_session_lifetime_is_unchanged(client, pg_db):
    user = _person(pg_db)
    claims = jwt.get_unverified_claims(_password_login(client, user))
    assert "auth_method" not in claims
    lifetime = datetime.fromtimestamp(claims["exp"], timezone.utc) - datetime.now(timezone.utc)
    assert lifetime > timedelta(days=7)


def test_unlinking_from_a_password_session_ends_paypal_sessions(client, pg_db, monkeypatch):
    user = _person(pg_db)
    attacker = _bearer(_signin(client, monkeypatch))
    assert client.get("/api/v1/auth/me", headers=attacker).status_code == 200

    owner = _bearer(_password_login(client, user))
    assert client.delete("/api/v1/paypal/link", headers=owner).status_code == 204
    assert client.get("/api/v1/auth/me", headers=attacker).status_code == 401


def test_paypal_session_ends_if_the_user_becomes_hr(client, pg_db, monkeypatch):
    user = _person(pg_db)
    headers = _bearer(_signin(client, monkeypatch))
    user.role = UserRole.HR
    pg_db.add(user)
    pg_db.commit()
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401


def _start(client):
    res = client.get("/api/v1/paypal/signin/start")
    assert res.status_code == 200, res.text
    return res.json()


def test_start_points_at_paypal_when_mock_mode_is_off(client, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_ID", "CID")
    monkeypatch.setattr(settings, "FRONTEND_PUBLIC_URL", "https://app.example/")
    start = _start(client)
    url = urlparse(start["url"])
    query = parse_qs(url.query)
    assert url.netloc == urlparse(settings.PAYPAL_WEB_URL).netloc and "code" not in query
    assert query["redirect_uri"] == ["https://app.example/login/paypal/callback"]
    read_signin_state(query["state"][0], start["binding"], settings.SECRET_KEY, datetime.now(timezone.utc))


def test_start_refuses_without_paypal_keys(client, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_CLIENT_ID", "")
    assert client.get("/api/v1/paypal/signin/start").status_code == 503


def test_mock_signin_works_for_the_linked_demo_payer(client, pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", True)
    monkeypatch.setattr(settings, "PAYPAL_MOCK_SIGNIN_PAYER_ID", "MOCKDEMO")
    user = _person(pg_db, payer="MOCKDEMO")
    start = _start(client)
    query = parse_qs(urlparse(start["url"]).query)
    assert query["code"] == [MOCK_SIGNIN_CODE]
    res = _complete(client, code=query["code"][0], state=query["state"][0], binding=start["binding"])
    assert res.status_code == 200
    me = client.get("/api/v1/auth/me", headers=_bearer(res.json()["access_token"]))
    assert me.json()["user_id"] == str(user.user_id)


def test_mock_code_cannot_choose_who_signs_in(client, pg_db, monkeypatch):
    from engine.services.paypal_client import MockPayPalClient
    import asyncio

    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", True)
    monkeypatch.setattr(settings, "PAYPAL_MOCK_SIGNIN_PAYER_ID", "MOCKDEMO")
    # A victim linked through mock Connect: their payer ID comes straight from the code the Connect flow used.
    fake = MockPayPalClient()
    victim_code = "mock-12345678"
    victim_payer = asyncio.run(fake.get_userinfo(asyncio.run(fake.exchange_auth_code(victim_code)))).payer_id
    _person(pg_db, payer=victim_payer)
    for code in (victim_code, "anything", ""):
        res = _complete(client, code=code)
        assert res.status_code == 401 and res.json() == FAILURE


def test_mock_signin_fails_for_an_unlinked_demo_payer(client, pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", True)
    monkeypatch.setattr(settings, "PAYPAL_MOCK_SIGNIN_PAYER_ID", "NOT-LINKED")
    _person(pg_db)
    assert _complete(client, code=MOCK_SIGNIN_CODE).status_code == 401


def test_mock_signin_can_be_switched_off(client, pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", True)
    monkeypatch.setattr(settings, "PAYPAL_MOCK_SIGNIN_PAYER_ID", "")
    _person(pg_db, payer=None)
    assert _complete(client, code=MOCK_SIGNIN_CODE).status_code == 401


def test_mock_code_does_nothing_when_mock_mode_is_off(client, pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_SIGNIN_PAYER_ID", "MOCKDEMO")
    _person(pg_db, payer="MOCKDEMO")
    # PayPal itself refuses a code it never issued.
    monkeypatch.setattr(paypal_api, "get_paypal_client", lambda: FakePayPal(None))
    res = _complete(client, code=MOCK_SIGNIN_CODE)
    assert res.status_code == 401 and res.json() == FAILURE


def test_default_mock_payer_is_the_seeded_demo_employee(monkeypatch):
    from core.config import Settings
    from seeds.seed_reclaim_pay import ACCOUNTS, _payer_id

    monkeypatch.delenv("DEMO_PAYER_ID_1", raising=False)
    assert _payer_id(ACCOUNTS["SWE123"])[0] == Settings.model_fields["PAYPAL_MOCK_SIGNIN_PAYER_ID"].default


def _link_failures(db):
    return db.exec(select(AgentAction).where(AgentAction.action_type == "PAYEE_LINK_FAILED")).all()


def _connect_callback(client, user, code="c"):
    state = make_state(user.user_id, settings.SECRET_KEY, datetime.now(timezone.utc))
    return client.get("/api/v1/paypal/callback", params={"code": code, "state": state}, follow_redirects=False)


def test_link_to_a_payer_owned_by_someone_else_logs_the_reason(client, pg_db, monkeypatch):
    _person(pg_db, payer="TAKEN")
    newcomer = _person(pg_db, payer=None)
    _use_paypal(monkeypatch, payer="TAKEN")
    res = _connect_callback(client, newcomer)
    assert res.headers["location"].endswith("paypal=error")
    assert [a.payload["reason"] for a in _link_failures(pg_db)] == ["payer_already_linked"]


def test_employee_cannot_link_a_vendor_payer(client, pg_db, monkeypatch):
    pg_db.add(Vendor(name="Vendor Co", name_key="vendor co", paypal_payer_id="VENDORPAYER",
                     paypal_verified=True))
    pg_db.commit()
    newcomer = _person(pg_db, payer=None)
    _use_paypal(monkeypatch, payer="VENDORPAYER")
    res = _connect_callback(client, newcomer)
    assert res.headers["location"].endswith("paypal=error")
    assert [a.payload["reason"] for a in _link_failures(pg_db)] == ["payer_already_linked"]


def test_paypal_error_during_link_logs_status_and_debug_id(client, pg_db, monkeypatch):
    user = _person(pg_db, payer=None)

    class Failing(FakePayPal):
        async def exchange_auth_code(self, code):
            raise PayPalError(401, "invalid_client", "dbg123")

    monkeypatch.setattr(paypal_api, "get_paypal_client", lambda: Failing(PayPalUser("X", "x@test.local", True)))
    _connect_callback(client, user)
    [entry] = _link_failures(pg_db)
    assert entry.payload == {"reason": "paypal_error", "status": 401, "error": "invalid_client", "debug_id": "dbg123"}


def test_bad_state_at_link_writes_nothing(client, pg_db, monkeypatch):
    _use_paypal(monkeypatch)
    client.get("/api/v1/paypal/callback", params={"code": "c", "state": "garbage"}, follow_redirects=False)
    assert _link_failures(pg_db) == []
