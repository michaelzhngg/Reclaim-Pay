from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from api import deps
from core.enums import PolicyStatus, UserRole
from core.models import Policy, PolicyReimbursableCategory, User
from engine.policy.limits import LimitRule, LimitUnit, ZonePlace
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
    assert meal["verdict"] == "LIMITS_PENDING" and meal["cap"] is None and meal["limit_total"] is None
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


@pytest.fixture
def zoned_api(pg_db, hr):
    """A zoned allowance in a policy with no "*" place, so an unlisted city matches no zone."""
    p = _policy(pg_db, hr, "Zoned policy", ("Daily Allowance",))
    rule = LimitRule(category="Daily Allowance", unit=LimitUnit.PER_DAY, amount=75, zone="1", grade_min=3)
    store.confirm_all(pg_db, p.policy_id, [rule], [ZonePlace(zone="1", place="Ipoh")], hr.user_id, NOW)

    def as_grade(rank):
        return _client(pg_db, _user(pg_db, rank=rank))[1]

    try:
        yield as_grade
    finally:
        from main import app
        app.dependency_overrides.clear()


def test_unlisted_place_is_told_apart_from_no_destination(zoned_api):
    client = zoned_api(4)
    tokyo = client.post("/api/v1/spend-check/check", json={"category": "Daily Allowance", "destination": "Tokyo"}).json()
    assert tokyo["verdict"] == "PLACE_NOT_LISTED" and tokyo["zone"] is None
    dates = {"depart": "2026-11-20", "return_date": "2026-11-21"}
    blank = client.post("/api/v1/spend-check/trip", json=dates).json()
    assert blank["missing_reasons"] == {"Daily Allowance": "NEED_DESTINATION"}
    away = client.post("/api/v1/spend-check/trip", json={**dates, "destination": "Tokyo"}).json()
    assert away["missing_reasons"] == {"Daily Allowance": "PLACE_NOT_LISTED"}
    junior = zoned_api(1).post("/api/v1/spend-check/trip", json={**dates, "destination": "Ipoh"}).json()
    assert junior["missing_reasons"] == {"Daily Allowance": "GRADE_NOT_LISTED"} and junior["total_up_to"] == 0


def test_results_name_the_place_that_set_the_zone(reclaim_api):
    client = reclaim_api(4)
    ipoh = client.post("/api/v1/spend-check/check",
                       json={"category": "Daily Trip Allowance", "destination": "Ipoh, Perak"}).json()
    assert ipoh["zone"] == "1" and ipoh["zone_place"] == "Ipoh"
    elsewhere = client.post("/api/v1/spend-check/check",
                            json={"category": "Daily Trip Allowance", "destination": "Kuching"}).json()
    assert elsewhere["zone"] == "2" and elsewhere["zone_place"] == "*"
    trip = client.post("/api/v1/spend-check/trip",
                       json={"destination": "Kuching", "depart": "2026-11-20", "return_date": "2026-11-21"}).json()
    assert trip["zone"] == "2" and trip["zone_place"] == "*"
    blank = client.post("/api/v1/spend-check/check", json={"category": "Intercity Transport"}).json()
    assert blank["zone_place"] is None


def test_zone_is_only_named_when_a_zoned_rule_set_the_rate(reclaim_api):
    client = reclaim_api(4)
    abroad = client.post("/api/v1/spend-check/check",
                         json={"category": "Daily Trip Allowance", "destination": "Ipoh", "overseas": True}).json()
    assert abroad["verdict"] == "LIMIT_ONLY" and abroad["zone_place"] is None  # the overseas rate has no zone
    hotel = client.post("/api/v1/spend-check/check", json={"category": "Accommodations", "destination": "Ipoh"}).json()
    assert hotel["zone_place"] is None
    trip = client.post("/api/v1/spend-check/trip", json={"destination": "Ipoh", "overseas": True,
                                                          "depart": "2026-11-20", "return_date": "2026-11-21"}).json()
    assert trip["zone_place"] is None


def test_zone_place_follows_policy_matching_for_punctuation_and_longer_names(pg_db, hr):
    p = _policy(pg_db, hr, "Zoned policy", ("Daily Allowance",))
    rules = [LimitRule(category="Daily Allowance", unit=LimitUnit.PER_DAY, amount=a, zone=z) for z, a in (("1", 75), ("3", 50))]
    places = [ZonePlace(zone="1", place="Kuala Lumpur"), ZonePlace(zone="3", place="Kuala Lumpur Airport"),
              ZonePlace(zone="2", place="*")]
    store.confirm_all(pg_db, p.policy_id, rules, places, hr.user_id, NOW)
    app, client = _client(pg_db, _user(pg_db))
    try:
        dashed = client.post("/api/v1/spend-check/check", json={"category": "Daily Allowance", "destination": "Kuala-Lumpur"}).json()
        airport = client.post("/api/v1/spend-check/check",
                              json={"category": "Daily Allowance", "destination": "Kuala Lumpur Airport (KLIA)"}).json()
    finally:
        app.dependency_overrides.clear()
    assert (dashed["zone"], dashed["zone_place"], dashed["limit_total"]) == ("1", "Kuala Lumpur", 75)
    assert (airport["zone"], airport["zone_place"], airport["limit_total"]) == ("3", "Kuala Lumpur Airport", 50)


def test_a_trip_says_when_limits_are_still_suggestions(pg_db, hr):
    p = _policy(pg_db, hr, "Unconfirmed policy", ("Meals",))
    store.replace_proposed(pg_db, p.policy_id, [LimitRule(category="Meals", unit=LimitUnit.PER_DAY, amount=50)], [])
    pg_db.commit()
    app, client = _client(pg_db, _user(pg_db))
    try:
        trip = client.post("/api/v1/spend-check/trip", json={"depart": "2026-11-12", "return_date": "2026-11-13"}).json()
    finally:
        app.dependency_overrides.clear()
    assert trip["limits_pending"] is True and trip["lines"] == [] and trip["total_up_to"] == 0


def test_a_single_zone_category_lists_the_places_it_covers(pg_db, hr):
    p = _policy(pg_db, hr, "Split policy", ("Allowance (Zone 1)",))
    rule = LimitRule(category="Allowance (Zone 1)", unit=LimitUnit.PER_DAY, amount=90, zone="1")
    places = [ZonePlace(zone="1", place="Kuala Lumpur"), ZonePlace(zone="1", place="Ipoh"), ZonePlace(zone="2", place="*")]
    store.confirm_all(pg_db, p.policy_id, [rule], places, hr.user_id, NOW)
    pg_db.commit()
    app, client = _client(pg_db, _user(pg_db))
    try:
        out = client.post("/api/v1/spend-check/check", json={"category": "Allowance (Zone 1)"}).json()
    finally:
        app.dependency_overrides.clear()
    assert out["verdict"] == "LIMIT_ONLY" and out["limit_total"] == 90 and out["zone_implied"] is True
    assert out["zone_places"] == ["Ipoh", "Kuala Lumpur"] and out["zone_place"] is None
