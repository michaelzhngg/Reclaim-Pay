"""D3 settings change history: policy changes go to the agent log, and the log can be filtered,
paged and read with the actors' names."""
from datetime import datetime, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text
from sqlmodel import select

from api import deps
from api.policies import budget_changes
from core.enums import PolicyStatus, UserRole
from core.models import AgentAction, Policy, PolicyReimbursableCategory, User


# ─── budget_changes (pure) ───────────────────────────────────────────────────

def test_budget_changes_keeps_only_changed_categories():
    old = {"Meals": 50.0, "Transport": None, "Lodging": 200.0}
    new = {"Meals": 75.0, "Transport": None, "Lodging": 200.0}
    assert budget_changes(old, new) == ({"Meals": 50.0}, {"Meals": 75.0})


def test_budget_changes_reports_limit_removed_and_set():
    assert budget_changes({"Meals": 50.0}, {"Meals": None}) == ({"Meals": 50.0}, {"Meals": None})
    assert budget_changes({"Meals": None}, {"Meals": 0.0}) == ({"Meals": None}, {"Meals": 0.0})


def test_budget_changes_added_and_removed_categories_appear_on_one_side():
    old_changed, new_changed = budget_changes({"Meals": 50.0}, {"Software": 100.0})
    assert old_changed == {"Meals": 50.0}
    assert new_changed == {"Software": 100.0}


def test_budget_changes_nothing_changed():
    assert budget_changes({"Meals": 50.0}, {"Meals": 50.0}) == ({}, {})


# ─── API (needs TEST_DATABASE_URL) ───────────────────────────────────────────

@pytest.fixture
def client(pg_db):
    from main import app

    pg_db.exec(text("DELETE FROM agent_actions"))
    hr = User(email=f"hr-{uuid4().hex[:8]}@test.local", hashed_password="x", name="Aisyah HR", role=UserRole.HR)
    pg_db.add(hr)
    pg_db.commit()
    pg_db.refresh(hr)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    app.dependency_overrides[deps.get_current_hr_user] = lambda: hr
    app.dependency_overrides[deps.get_current_user] = lambda: hr
    try:
        yield TestClient(app), pg_db, hr
    finally:
        app.dependency_overrides.clear()


def _policy(db, hr, budgets: dict[str, float | None], status=PolicyStatus.ACTIVE, alias="Travel Policy") -> Policy:
    policy = Policy(
        alias=alias,
        title="Travel and Expenses",
        # PolicyResponse requires these; an uploaded policy always has them.
        effective_date=datetime(2026, 11, 1, tzinfo=timezone.utc),
        overview_summary="Test policy",
        mandatory_conditions="{}",
        source_file_url="storage/policies/test.pdf",
        status=status,
        created_by=hr.user_id,
        created_at=datetime.now(timezone.utc),
    )
    db.add(policy)
    db.commit()
    db.refresh(policy)
    for category, budget in budgets.items():
        db.add(PolicyReimbursableCategory(policy_id=policy.policy_id, category=category, auto_approval_budget=budget))
    db.commit()
    return policy


def _actions(db) -> list[AgentAction]:
    db.expire_all()
    return db.exec(select(AgentAction).order_by(AgentAction.action_id)).all()


def test_budget_patch_logs_only_the_changed_categories(client):
    c, db, hr = client
    policy = _policy(db, hr, {"Meals": 50, "Transport": None})
    res = c.patch(f"/api/v1/policies/{policy.policy_id}/categories", json={"categories": [
        {"category": "Meals", "auto_approval_budget": 75},
        {"category": "Transport", "auto_approval_budget": None},
    ]})
    assert res.status_code == 200
    [entry] = _actions(db)
    assert entry.action_type == "POLICY_BUDGETS_CHANGED"
    assert entry.actor == str(hr.user_id)
    assert entry.payload == {
        "policy_id": str(policy.policy_id),
        "alias": "Travel Policy",
        "old": {"Meals": 50.0},
        "new": {"Meals": 75.0},
    }


def test_budget_patch_without_changes_logs_nothing(client):
    c, db, hr = client
    policy = _policy(db, hr, {"Meals": 50})
    res = c.patch(f"/api/v1/policies/{policy.policy_id}/categories", json={"categories": [
        {"category": "Meals", "auto_approval_budget": 50},
    ]})
    assert res.status_code == 200
    assert _actions(db) == []


def test_deprecate_logs_previous_status(client):
    c, db, hr = client
    policy = _policy(db, hr, {})
    assert c.patch(f"/api/v1/policies/{policy.policy_id}/deprecate").status_code == 200
    [entry] = _actions(db)
    assert entry.action_type == "POLICY_DEPRECATED"
    assert entry.payload == {"policy_id": str(policy.policy_id), "alias": "Travel Policy", "previous_status": "ACTIVE"}


def test_delete_logs_what_was_deleted(client):
    c, db, hr = client
    policy = _policy(db, hr, {"Meals": 50})
    policy_id = str(policy.policy_id)
    assert c.delete(f"/api/v1/policies/{policy_id}").status_code == 200
    [entry] = _actions(db)
    assert entry.action_type == "POLICY_DELETED"
    assert entry.payload == {"policy_id": policy_id, "alias": "Travel Policy", "status": "ACTIVE"}
    assert db.get(Policy, policy.policy_id) is None


def test_actions_filter_by_type_and_resolve_names(client):
    c, db, hr = client
    policy = _policy(db, hr, {"Meals": 50})
    c.post("/api/v1/autonomy/kill-switch", json={"enabled": False, "reason": "Audit"})
    c.patch(f"/api/v1/policies/{policy.policy_id}/deprecate")

    body = c.get("/api/v1/autonomy/actions", params={"types": ["KILL_SWITCH"]}).json()
    assert [a["action_type"] for a in body["actions"]] == ["KILL_SWITCH"]
    assert body["actions"][0]["actor_name"] == "Aisyah HR"
    assert body["chain_valid"] is True

    both = c.get("/api/v1/autonomy/actions", params={"types": ["KILL_SWITCH", "POLICY_DEPRECATED"]}).json()
    assert [a["action_type"] for a in both["actions"]] == ["POLICY_DEPRECATED", "KILL_SWITCH"]


def test_actions_unknown_type_is_rejected(client):
    c, _, _ = client
    assert c.get("/api/v1/autonomy/actions", params={"types": ["NOT_A_TYPE"]}).status_code == 422


def test_actions_agent_actor_has_no_name(client):
    c, db, _ = client
    from engine.services import autonomy_store as store
    store.trip_breaker(db, "Too many high-risk claims", datetime.now(timezone.utc))
    [entry] = c.get("/api/v1/autonomy/actions", params={"types": ["BREAKER_TRIPPED"]}).json()["actions"]
    assert entry["actor"] == "agent" and entry["actor_name"] is None


def test_actions_page_back_with_before(client):
    c, _, _ = client
    for i in range(3):
        c.post("/api/v1/autonomy/kill-switch", json={"enabled": i % 2 == 0, "reason": f"step {i}"})
    first = c.get("/api/v1/autonomy/actions", params={"limit": 2}).json()["actions"]
    assert [a["payload"]["reason"] for a in first] == ["step 2", "step 1"]
    older = c.get("/api/v1/autonomy/actions", params={"limit": 2, "before": first[-1]["action_id"]}).json()["actions"]
    assert [a["payload"]["reason"] for a in older] == ["step 0"]


def test_actions_filter_by_policy(client):
    c, db, hr = client
    a = _policy(db, hr, {"Meals": 50})
    b = _policy(db, hr, {"Meals": 50}, alias="Office Policy")
    c.patch(f"/api/v1/policies/{a.policy_id}/deprecate")
    c.patch(f"/api/v1/policies/{b.policy_id}/categories", json={"categories": [{"category": "Meals", "auto_approval_budget": 60}]})
    entries = c.get("/api/v1/autonomy/actions", params={"policy_id": str(b.policy_id)}).json()["actions"]
    assert [e["action_type"] for e in entries] == ["POLICY_BUDGETS_CHANGED"]
