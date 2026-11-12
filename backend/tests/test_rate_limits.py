"""Per-user rate limits on claim submission (O2): 429 with Retry-After and a plain message."""
from uuid import uuid4

import pytest
from fastapi import FastAPI, Request
from fastapi.testclient import TestClient
from limits import parse_many
from slowapi.errors import RateLimitExceeded

from api import deps, documents, drafts, reimbursements
from api.rate_limit import (
    ANALYZE_LIMIT,
    DOCUMENT_EDIT_LIMIT,
    DRAFT_SAVE_LIMIT,
    UPLOAD_LIMIT,
    limiter,
    rate_limit_exceeded_handler,
)
from core.models import User, UserRole
from core.security import create_access_token


def _per(limit: str, granularity: str) -> int:
    return next(item.amount for item in parse_many(limit) if item.GRANULARITY.name == granularity)


class _FakeSession:
    def add(self, obj):
        pass

    def commit(self):
        pass

    def refresh(self, obj):
        pass


@pytest.fixture(autouse=True)
def _fresh_limiter():
    limiter.reset()
    yield
    limiter.reset()


@pytest.fixture
def client():
    users: dict[str, User] = {}

    def current_user(request: Request) -> User:
        token = request.headers["Authorization"][7:]
        return users[token]

    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)
    app.include_router(drafts.router, prefix="/drafts")
    app.include_router(documents.router, prefix="/documents")
    app.include_router(reimbursements.router, prefix="/reimbursements")
    app.dependency_overrides[deps.get_db] = lambda: _FakeSession()
    app.dependency_overrides[deps.get_current_user] = current_user

    def login(email: str) -> dict:
        token = create_access_token(email)
        users[token] = User(user_id=uuid4(), email=email, hashed_password="x", name=email, role=UserRole.Employee)
        return {"Authorization": f"Bearer {token}"}

    with TestClient(app) as c:
        yield c, login


# Each case: (limit, call(client, headers, i) -> response, status under the limit).
# Invalid IDs return before the database is touched, so the calls stay cheap.
CASES = {
    "draft create + update": (
        DRAFT_SAVE_LIMIT,
        lambda c, h, i: c.post("/drafts/", json={"title": "Trip"}, headers=h) if i % 2 == 0
        else c.put("/drafts/not-a-uuid", json={"title": "Trip"}, headers=h),
        None,
    ),
    "receipt edits + field patch": (
        DOCUMENT_EDIT_LIMIT,
        lambda c, h, i: c.post("/documents/not-a-uuid/edits", json={"total_amount": 1}, headers=h) if i % 2 == 0
        else c.patch("/documents/not-a-uuid/fields", json={"edits": {"total_amount": 1}}, headers=h),
        400,
    ),
    "analyze": (
        ANALYZE_LIMIT,
        lambda c, h, i: c.post("/reimbursements/analyze", json={"settlement_id": "not-a-uuid"}, headers=h),
        400,
    ),
}

MESSAGES = {
    "draft create + update": "Too many draft saves. Try again in about a minute.",
    "receipt edits + field patch": "Too many receipt edits. Try again in about a minute.",
    "analyze": "Too many claim submissions. Try again in about a minute.",
}


@pytest.mark.parametrize("case", list(CASES))
def test_limit_is_per_user_with_retry_after_and_plain_message(client, case):
    c, login = client
    limit, call, under_status = CASES[case]
    per_minute = _per(limit, "minute")
    alice, bob = login("alice@test.local"), login("bob@test.local")

    for i in range(per_minute):
        res = call(c, alice, i)
        assert res.status_code != 429, f"call {i + 1} of {per_minute} was throttled"
        if under_status is not None:
            assert res.status_code == under_status
        elif i % 2 == 0:
            assert res.status_code == 201  # draft create still works under the limit
        else:
            assert res.status_code == 400

    blocked = call(c, alice, per_minute)
    assert blocked.status_code == 429
    assert blocked.json() == {"error": MESSAGES[case], "detail": MESSAGES[case]}
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60

    # Another employee keeps their own budget.
    assert call(c, bob, per_minute).status_code != 429


def test_draft_saves_comfortably_exceed_manual_saving():
    # The claim form has no autosave; drafts are written on Save Draft or the leave dialog.
    assert _per(DRAFT_SAVE_LIMIT, "minute") >= 20


def test_ai_endpoints_have_a_daily_ceiling_above_demo_retakes():
    # One full demo take costs employee@ about 11 uploads and 11 analyses (S1-S6 plus 4 of
    # the 8 S7 flood claims). The ceilings must allow at least 15 takes in one day.
    per_take = 11
    assert _per(ANALYZE_LIMIT, "day") >= 15 * per_take
    assert _per(UPLOAD_LIMIT, "day") >= 15 * per_take
    # S7 (flood.py) alternates two employees with a 13 s gap: at most 3 claims per user per minute.
    assert _per(ANALYZE_LIMIT, "minute") >= 5
    assert _per(UPLOAD_LIMIT, "minute") >= 5


def test_daily_limit_message_names_hours_not_a_minute():
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

    @app.post("/submit")
    @limiter.limit("1/day", error_message="Too many claim submissions.")
    def submit(request: Request):
        return {"ok": True}

    with TestClient(app) as c:
        assert c.post("/submit").json() == {"ok": True}
        res = c.post("/submit")
    assert res.status_code == 429
    assert res.json()["error"] == "Too many claim submissions. Try again in about 24 hours."
    assert int(res.headers["Retry-After"]) > 23 * 3600


def test_limits_without_a_message_get_a_generic_one():
    app = FastAPI()
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)

    @app.post("/login")
    @limiter.limit("1/minute")
    def login(request: Request):
        return {"ok": True}

    with TestClient(app) as c:
        c.post("/login")
        res = c.post("/login")
    assert res.status_code == 429
    assert res.json()["error"] == "Too many requests. Try again in about a minute."


def test_main_app_uses_the_plain_429_handler():
    from main import app

    assert app.exception_handlers[RateLimitExceeded] is rate_limit_exceeded_handler
