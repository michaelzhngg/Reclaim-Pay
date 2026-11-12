from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlalchemy import text
from sqlmodel import select

from core.enums import AgentActionType, LimitStatus, PolicyStatus, UserRole
from core.models import AgentAction, Policy, PolicyLimit, PolicyReimbursableCategory, PolicyZonePlace, User
from engine.policy.limits import LimitRule, LimitUnit, ZonePlace
from engine.services import policy_limits_store as store

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)


def make_user(db, role=UserRole.HR, rank=1):
    u = User(email=f"u-{uuid4().hex[:8]}@test.local", hashed_password="x", name="Test", role=role, rank=rank)
    db.add(u)
    db.commit()
    db.refresh(u)
    return u


def make_policy(db, creator, categories=("Meals", "Accommodations"), status=PolicyStatus.ACTIVE, effective=NOW):
    p = Policy(alias=f"P-{uuid4().hex[:6]}", title="Test policy", effective_date=effective, overview_summary="",
               mandatory_conditions="{}", source_file_url="", status=status, created_by=creator.user_id)
    db.add(p)
    db.commit()
    for c in categories:
        db.add(PolicyReimbursableCategory(policy_id=p.policy_id, category=c))
    db.commit()
    db.refresh(p)
    return p


@pytest.fixture
def only_these_policies(pg_db):
    """active_limits reads every ACTIVE policy, so park any the scratch DB already has."""
    pg_db.exec(text("UPDATE policies SET status = 'DRAFT' WHERE status = 'ACTIVE'"))
    return pg_db


MEAL = LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=100)
HOTEL = LimitRule(category="Accommodations", unit=LimitUnit.PER_NIGHT, amount=250, grade_max=2)


def test_confirm_all_replaces_rows_and_logs(pg_db):
    pg_db.exec(text("DELETE FROM agent_actions"))
    hr = make_user(pg_db)
    p = make_policy(pg_db, hr)
    store.confirm_all(pg_db, p.policy_id, [MEAL, HOTEL], [ZonePlace(zone="1", place="Ipoh")], hr.user_id, NOW)
    rules, places = store.load_limits(pg_db, p.policy_id)
    assert {r.category for r in rules} == {"Meals", "Accommodations"} and places[0].place == "Ipoh"
    rows, _ = store.list_rows(pg_db, p.policy_id)
    assert all(r.status == LimitStatus.CONFIRMED and r.confirmed_by == hr.user_id for r in rows)
    action = pg_db.exec(select(AgentAction).where(AgentAction.action_type == AgentActionType.POLICY_LIMITS_CHANGED)).first()
    assert action is not None and action.payload["limits"] == 2


def test_proposed_rows_are_hidden_from_consumers_and_keep_confirmed(pg_db):
    hr = make_user(pg_db)
    p = make_policy(pg_db, hr)
    store.confirm_all(pg_db, p.policy_id, [MEAL], [], hr.user_id, NOW)
    store.replace_proposed(pg_db, p.policy_id, [HOTEL], [])
    pg_db.commit()
    store.replace_proposed(pg_db, p.policy_id, [HOTEL], [])  # a second extraction replaces, not duplicates
    pg_db.commit()
    confirmed, _ = store.load_limits(pg_db, p.policy_id)
    everything, _ = store.load_limits(pg_db, p.policy_id, confirmed_only=False)
    assert [r.category for r in confirmed] == ["Meals"]
    assert sorted(r.category for r in everything) == ["Accommodations", "Meals"]


def test_suggestions_that_repeat_a_confirmed_row_are_skipped(pg_db):
    hr = make_user(pg_db)
    p = make_policy(pg_db, hr)
    store.confirm_all(pg_db, p.policy_id, [MEAL], [ZonePlace(zone="1", place="Ipoh")], hr.user_id, NOW)
    reworded = MEAL.model_copy(update={"source_quote": "Meals up to RM100"})
    written = store.replace_proposed(pg_db, p.policy_id, [reworded, HOTEL, HOTEL],
                                     [ZonePlace(zone="1", place="Ipoh"), ZonePlace(zone="2", place="*")])
    pg_db.commit()
    assert written == 1
    limits, places = store.list_rows(pg_db, p.policy_id)
    assert sorted((r.category, r.status) for r in limits) == [("Accommodations", "PROPOSED"), ("Meals", "CONFIRMED")]
    assert sorted((z.place, z.status) for z in places) == [("*", "PROPOSED"), ("Ipoh", "CONFIRMED")]


def test_active_limits_skip_inactive_policies(only_these_policies):
    db = only_these_policies
    hr = make_user(db)
    live = make_policy(db, hr)
    old = make_policy(db, hr, status=PolicyStatus.DEPRECATED)
    store.confirm_all(db, live.policy_id, [MEAL], [], hr.user_id, NOW)
    store.confirm_all(db, old.policy_id, [HOTEL], [], hr.user_id, NOW)
    rules, _ = store.active_limits(db)
    assert MEAL in rules and HOTEL not in rules


def test_newest_active_policy_wins_a_shared_category_like_claims_do(only_these_policies):
    db = only_these_policies
    hr = make_user(db)
    older = make_policy(db, hr, categories=("Meals", "Accommodations"), effective=NOW - timedelta(days=30))
    newer = make_policy(db, hr, categories=("Meals",), effective=NOW)
    store.confirm_all(db, older.policy_id, [MEAL, HOTEL], [], hr.user_id, NOW)
    cheaper_meal = MEAL.model_copy(update={"amount": 60.0})
    store.confirm_all(db, newer.policy_id, [cheaper_meal], [], hr.user_id, NOW)

    picked = store.policy_for_category(db)
    assert picked["Meals"].policy_id == newer.policy_id
    assert picked["Accommodations"].policy_id == older.policy_id
    rules, _ = store.active_limits(db)
    assert sorted((r.category, r.amount) for r in rules) == [("Accommodations", 250.0), ("Meals", 60.0)]


def test_limits_for_a_category_the_policy_no_longer_lists_are_ignored(only_these_policies):
    db = only_these_policies
    hr = make_user(db)
    p = make_policy(db, hr, categories=("Meals",))
    store.confirm_all(db, p.policy_id, [MEAL, HOTEL], [], hr.user_id, NOW)
    rules, _ = store.active_limits(db)
    assert rules == [MEAL]


def test_delete_for_policy_removes_limits_and_zones(pg_db):
    hr = make_user(pg_db)
    p = make_policy(pg_db, hr)
    store.confirm_all(pg_db, p.policy_id, [MEAL], [ZonePlace(zone="1", place="Ipoh")], hr.user_id, NOW)
    store.replace_proposed(pg_db, p.policy_id, [HOTEL], [])
    store.delete_for_policy(pg_db, p.policy_id)
    pg_db.commit()
    assert store.list_rows(pg_db, p.policy_id) == ([], [])
    assert pg_db.exec(select(PolicyZonePlace).where(PolicyZonePlace.policy_id == p.policy_id)).first() is None


# --- API -----------------------------------------------------------------------

from fastapi.testclient import TestClient

from api import deps


@pytest.fixture
def hr_api(pg_db):
    from main import app

    pg_db.exec(text("DELETE FROM agent_actions"))
    hr = make_user(pg_db)
    acting = {"user": hr}
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_user] = lambda: acting["user"]
    try:
        yield TestClient(app), pg_db, hr, acting
    finally:
        app.dependency_overrides.clear()


def test_deleting_a_policy_removes_its_limits(hr_api):
    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    store.confirm_all(db, p.policy_id, [MEAL], [ZonePlace(zone="1", place="Ipoh")], hr.user_id, NOW)
    res = c.delete(f"/api/v1/policies/{p.policy_id}")
    assert res.status_code == 200
    assert store.list_rows(db, p.policy_id) == ([], [])


def _with_text(db, policy, text_body):
    from core.models import PolicySection

    db.add(PolicySection(policy_id=policy.policy_id, section_order=1, content=text_body))
    db.commit()


def test_extract_limits_saves_suggestions_from_the_policy_text(pg_db, monkeypatch):
    from engine.services import policy_limits_extraction as ex

    hr = make_user(pg_db)
    p = make_policy(pg_db, hr)
    _with_text(pg_db, p, "Meals are reimbursed up to RM100 each.")
    seen = {}

    def fake_llm(categories, text_body):
        seen["text"] = text_body
        return {"limits": [{"category": "meals", "unit": "PER_MEAL", "amount": 100},
                           {"category": "Parking", "unit": "PER_DAY", "amount": 5}], "zones": []}

    monkeypatch.setattr(ex, "run_extraction_llm", fake_llm)
    result = ex.extract_limits(pg_db, p.policy_id)
    assert (result.proposed, result.dropped) == (1, 1) and "RM100" in seen["text"]
    rows, _ = store.list_rows(pg_db, p.policy_id)
    assert [(r.category, r.status) for r in rows] == [("Meals", "PROPOSED")]
    assert store.load_limits(pg_db, p.policy_id) == ([], [])


def test_upload_still_succeeds_when_limit_extraction_fails(hr_api, monkeypatch, tmp_path):
    import api.policies as policies_api

    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    monkeypatch.setattr(policies_api, "STORAGE_POLICIES_DIR", tmp_path)
    monkeypatch.setattr(policies_api, "run_policy_workflow", lambda *a, **kw: str(p.policy_id))

    def boom(db, policy_id):
        raise RuntimeError("quota")

    monkeypatch.setattr(policies_api, "extract_limits", boom)
    res = c.post("/api/v1/policies/upload", data={"alias": p.alias},
                 files={"files": ("policy.pdf", b"%PDF-1.4", "application/pdf")})
    assert res.status_code == 200 and res.json()["limits_found"] == 0


def test_get_starts_empty_and_lists_categories(hr_api):
    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    body = c.get(f"/api/v1/policies/{p.policy_id}/limits").json()
    assert body["limits"] == [] and sorted(body["categories"]) == ["Accommodations", "Meals"]
    assert body["has_suggestions"] is False


def test_get_shows_suggestions_to_hr(hr_api):
    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    store.replace_proposed(db, p.policy_id, [HOTEL], [ZonePlace(zone="2", place="*")])
    db.commit()
    body = c.get(f"/api/v1/policies/{p.policy_id}/limits").json()
    assert body["has_suggestions"] is True
    assert body["limits"][0]["status"] == "PROPOSED" and body["limits"][0]["amount"] == 250
    assert body["zones"] == [{"zone": "2", "place": "*", "status": "PROPOSED"}]


def test_put_confirms_the_set(hr_api):
    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    payload = {"limits": [MEAL.model_dump(mode="json")], "zones": [{"zone": "1", "place": "Ipoh"}]}
    res = c.put(f"/api/v1/policies/{p.policy_id}/limits", json=payload)
    assert res.status_code == 200
    body = res.json()
    assert body["limits"][0]["status"] == "CONFIRMED" and body["zones"][0]["place"] == "Ipoh"
    assert body["has_suggestions"] is False


def test_put_stores_the_category_as_the_policy_spells_it(hr_api):
    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    meal = {**MEAL.model_dump(mode="json"), "category": " meals "}
    body = c.put(f"/api/v1/policies/{p.policy_id}/limits", json={"limits": [meal], "zones": []}).json()
    assert body["limits"][0]["category"] == "Meals"


def test_put_rejects_a_category_the_policy_does_not_have(hr_api):
    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    bad = LimitRule(category="Parking", unit=LimitUnit.PER_DAY, amount=10).model_dump(mode="json")
    res = c.put(f"/api/v1/policies/{p.policy_id}/limits", json={"limits": [bad], "zones": []})
    assert res.status_code == 422 and res.json()["detail"] == "UNKNOWN_CATEGORY"


def test_put_rejects_a_capped_limit_without_an_amount(hr_api):
    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    meal = {**MEAL.model_dump(mode="json"), "amount": None}
    assert c.put(f"/api/v1/policies/{p.policy_id}/limits", json={"limits": [meal], "zones": []}).status_code == 422


def test_employees_cannot_read_or_change_limits(hr_api):
    c, db, hr, acting = hr_api
    p = make_policy(db, hr)
    acting["user"] = make_user(db, role=UserRole.Employee)
    assert c.get(f"/api/v1/policies/{p.policy_id}/limits").status_code == 403
    assert c.put(f"/api/v1/policies/{p.policy_id}/limits", json={"limits": [], "zones": []}).status_code == 403
    assert c.post(f"/api/v1/policies/{p.policy_id}/limits/extract").status_code == 403


def test_unknown_policy_is_404(hr_api):
    c, *_ = hr_api
    res = c.get(f"/api/v1/policies/{uuid4()}/limits")
    assert res.status_code == 404 and res.json()["detail"] == "POLICY_NOT_FOUND"


def test_extract_reports_counts_and_maps_failure_to_503(hr_api, monkeypatch):
    import api.policy_limits as mod
    from engine.services.policy_limits_extraction import ExtractionResult

    c, db, hr, _ = hr_api
    p = make_policy(db, hr)
    monkeypatch.setattr(mod, "extract_limits", lambda db, pid: ExtractionResult(proposed=3, zone_places=0, dropped=1))
    assert c.post(f"/api/v1/policies/{p.policy_id}/limits/extract").json()["proposed"] == 3

    def boom(db, pid):
        raise RuntimeError("quota")

    monkeypatch.setattr(mod, "extract_limits", boom)
    res = c.post(f"/api/v1/policies/{p.policy_id}/limits/extract")
    assert res.status_code == 503 and res.json()["detail"] == "LIMITS_EXTRACTION_FAILED"
