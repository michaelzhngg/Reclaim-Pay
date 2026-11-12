from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from api import deps
from core.enums import PolicyStatus, UserRole
from core.models import Policy, PolicyReimbursableCategory, User
from engine.policy.limits import LimitRule, LimitUnit
from engine.policy.samples import DEMO_RULES, RECLAIM_RULES, RECLAIM_ZONES
from engine.services import policy_limits_store as store

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)


def _user(db, role=UserRole.Employee, rank=4):
    u = User(email=f"u-{uuid4().hex[:8]}@test.local", hashed_password="x", name="Aisyah", role=role, rank=rank)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def _policy(db, creator, title, categories, status=PolicyStatus.ACTIVE):
    p = Policy(alias=f"RP-{uuid4().hex[:6]}", title=title, effective_date=NOW,
               overview_summary="", mandatory_conditions="{}", source_file_url="",
               status=status, created_by=creator.user_id)
    db.add(p)
    db.commit()
    for c in categories:
        db.add(PolicyReimbursableCategory(policy_id=p.policy_id, category=c))
    db.commit()
    return p


def _client(db, me):
    from main import app

    app.dependency_overrides[deps.get_db] = lambda: db
    app.dependency_overrides[deps.get_current_user] = lambda: me
    return app, TestClient(app)


@pytest.fixture
def hr(pg_db):
    pg_db.exec(text("UPDATE policies SET status = 'DEPRECATED' WHERE status = 'ACTIVE'"))  # only this test's policies
    return _user(pg_db, role=UserRole.HR, rank=5)


@pytest.fixture
def emp_api(pg_db, hr):
    p = _policy(pg_db, hr, "Demo travel policy", ("Transportation", "Meals", "Accommodations", "Equipment"))
    store.confirm_all(pg_db, p.policy_id, DEMO_RULES, [], hr.user_id, NOW)
    app, client = _client(pg_db, _user(pg_db, rank=4))
    try:
        yield client
    finally:
        app.dependency_overrides.clear()


@pytest.fixture
def reclaim_api(pg_db, hr):
    p = _policy(pg_db, hr, "Business travel policy", ("Daily Trip Allowance", "Accommodations", "Intercity Transport"))
    store.confirm_all(pg_db, p.policy_id, RECLAIM_RULES, RECLAIM_ZONES, hr.user_id, NOW)

    def as_grade(rank):
        app, client = _client(pg_db, _user(pg_db, rank=rank))
        return client

    try:
        yield as_grade
    finally:
        from main import app
        app.dependency_overrides.clear()


def test_categories_show_the_unit_for_my_grade(emp_api):
    body = emp_api.get("/api/v1/spend-check/categories").json()
    by_cat = {o["category"]: o for o in body}
    assert by_cat["Accommodations"]["unit"] == "PER_NIGHT"
    assert by_cat["Transportation"]["unit"] is None
    assert by_cat["Meals"]["policy_title"] == "Demo travel policy"
    assert by_cat["Accommodations"]["asks_destination"] is False


def test_over_the_hotel_cap_for_three_nights(emp_api):
    res = emp_api.post("/api/v1/spend-check/check",
                       json={"category": "accommodations", "amount": 1300, "quantity": 3})
    body = res.json()
    assert res.status_code == 200
    assert body["verdict"] == "OVER" and body["limit_total"] == 1200 and body["employee_pays"] == 100
    assert body["category"] == "Accommodations"  # the policy's spelling, not what was typed
    assert body["cap"]["source_section"] == "3.3 Accommodations" and body["currency"] == "MYR"


def test_category_outside_every_policy(emp_api):
    body = emp_api.post("/api/v1/spend-check/check", json={"category": "Flights", "amount": 900}).json()
    assert body["verdict"] == "NOT_COVERED" and body["policy_title"] is None


def test_trip_estimate_and_bad_dates(emp_api):
    body = emp_api.post("/api/v1/spend-check/trip",
                        json={"destination": "Penang", "depart": "2026-11-20", "return_date": "2026-11-22"}).json()
    assert body["nights"] == 2 and body["total_up_to"] == 800  # rank 4: RM400 a night
    assert body["currency"] == "MYR"
    bad = emp_api.post("/api/v1/spend-check/trip",
                       json={"depart": "2026-11-22", "return_date": "2026-11-20"})
    assert bad.status_code == 422 and bad.json()["detail"] == "RETURN_BEFORE_DEPART"
    long = emp_api.post("/api/v1/spend-check/trip",
                        json={"depart": "2026-11-01", "return_date": "2027-01-30"})
    assert long.status_code == 422 and long.json()["detail"] == "TRIP_TOO_LONG"


def test_employees_never_see_suggested_limits_or_draft_policies(pg_db, hr):
    live = _policy(pg_db, hr, "Live policy", ("Meals",))
    store.confirm_all(pg_db, live.policy_id, [], [], hr.user_id, NOW)
    store.replace_proposed(pg_db, live.policy_id, [LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=5)], [])
    _policy(pg_db, hr, "Draft policy", ("Gym",), status=PolicyStatus.DRAFT)
    pg_db.commit()
    app, client = _client(pg_db, _user(pg_db))
    try:
        cats = [o["category"] for o in client.get("/api/v1/spend-check/categories").json()]
        meal = client.post("/api/v1/spend-check/check", json={"category": "Meals", "amount": 50}).json()
        gym = client.post("/api/v1/spend-check/check", json={"category": "Gym", "amount": 50}).json()
    finally:
        app.dependency_overrides.clear()
    assert cats == ["Meals"]
    assert meal["verdict"] == "NO_LIMIT" and meal["cap"] is None
    assert gym["verdict"] == "NOT_COVERED"


def test_zone_questions_follow_my_grade(reclaim_api):
    by_cat = {o["category"]: o for o in reclaim_api(4).get("/api/v1/spend-check/categories").json()}
    assert by_cat["Daily Trip Allowance"]["asks_destination"] is True
    assert by_cat["Daily Trip Allowance"]["asks_overseas"] is True
    assert by_cat["Intercity Transport"]["asks_destination"] is False
    # Grade 9 is paid actual cost wherever they go, so there is no destination to ask for.
    senior = {o["category"]: o for o in reclaim_api(9).get("/api/v1/spend-check/categories").json()}
    assert senior["Daily Trip Allowance"]["asks_destination"] is False
    assert senior["Daily Trip Allowance"]["unit"] == "ACTUAL"


def test_zone_allowance_needs_a_destination_then_prices_it(reclaim_api):
    client = reclaim_api(4)
    need = client.post("/api/v1/spend-check/check", json={"category": "Daily Trip Allowance"}).json()
    assert need["verdict"] == "NEED_DESTINATION" and need["zone"] is None
    ipoh = client.post("/api/v1/spend-check/check",
                       json={"category": "Daily Trip Allowance", "destination": "Ipoh", "quantity": 3}).json()
    assert ipoh["verdict"] == "LIMIT_ONLY" and ipoh["zone"] == "1" and ipoh["limit_total"] == 225
