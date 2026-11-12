import time
from collections import Counter
from datetime import datetime, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import text

from api import deps
from engine.risk.types import AutonomyConfig, TrustTier
from engine.services.backtest_service import CURVE_LIMITS, load_backtest_cases, run_backtest
from seeds.seed_reclaim_pay import final_trust, seed

NOW = datetime(2026, 11, 3, tzinfo=timezone.utc)


@pytest.fixture
def seeded(pg_db):
    pg_db.exec(text("DELETE FROM autonomy_settings"))
    return pg_db, seed(pg_db, now=NOW)


def test_default_config_reproduces_the_stored_tiers(seeded):
    db, result = seeded
    history = result["history"]
    cases = load_backtest_cases(db, NOW)
    assert len(cases) == 120
    # S8's recovery is still an open notice, so it isn't confirmed bad yet.
    confirmed_bad = [c for c in history if c.bad and c.note != "s8"]
    assert sum(c.bad for c in cases) == len(confirmed_bad)

    r = run_backtest(cases, AutonomyConfig(), NOW)
    assert r.by_tier == dict(Counter(c.tier.value for c in history))
    assert r.auto_paid_count == r.by_tier["AUTO_PAY"] == r.hr_reviews_avoided
    assert r.bad_auto_paid_count + r.caught_bad_count == len(confirmed_bad)
    assert [p.auto_limit_standard for p in r.curve] == list(CURVE_LIMITS)
    assert r.assumptions[0] == "ignores daily budget and circuit breaker"
    assert r.demo_claims == 120
    assert r.assumptions[-1] == "all 120 claims are demo data, so don't tune limits on these results"


def test_raising_the_limits_automates_more(seeded):
    db, _ = seeded
    cases = load_backtest_cases(db, NOW)
    low = run_backtest(cases, AutonomyConfig(auto_limit_new=25, auto_limit_standard=50, auto_limit_trusted=100), NOW)
    high = run_backtest(cases, AutonomyConfig(auto_limit_new=100, auto_limit_standard=200, auto_limit_trusted=400), NOW)
    assert low.auto_paid_count < high.auto_paid_count
    assert low.projected_leakage <= high.projected_leakage


def test_backtest_is_fast_enough_for_a_slider(seeded):
    db, _ = seeded
    start = time.perf_counter()
    run_backtest(load_backtest_cases(db, NOW), AutonomyConfig(), NOW)
    assert time.perf_counter() - start < 0.3


@pytest.fixture
def api(pg_db):
    from main import app

    pg_db.exec(text("DELETE FROM autonomy_settings"))
    # The endpoints read the real clock, so the history is seeded relative to it.
    result = seed(pg_db, now=datetime.now(timezone.utc))
    app.dependency_overrides[deps.get_db] = lambda: pg_db

    def login(code):
        user = result["users"][code]
        app.dependency_overrides[deps.get_current_user] = lambda: user
        return user

    try:
        yield TestClient(app), login, result
    finally:
        app.dependency_overrides.clear()


def test_backtest_endpoint_returns_the_documented_shape(api):
    client, login, _ = api
    login("HR001")
    cfg = client.get("/api/v1/autonomy/settings").json()["config"]
    res = client.post("/api/v1/autonomy/backtest", json={"config": cfg})
    assert res.status_code == 200
    body = res.json()
    assert set(body) == {"total_claims", "auto_paid_count", "automation_rate", "auto_paid_amount",
                         "bad_auto_paid_count", "projected_leakage", "caught_bad_count", "hr_reviews_avoided",
                         "hr_hours_saved", "by_tier", "curve", "assumptions", "demo_claims"}
    assert body["total_claims"] == body["demo_claims"] == 120 and len(body["curve"]) == 8
    assert set(body["curve"][0]) == {"auto_limit_standard", "automation_rate", "projected_leakage"}
    assert set(body["by_tier"]) == {"AUTO_PAY", "HR_QUICK", "HR_REVIEW", "DUAL_REVIEW"}


def test_backtest_is_hr_only_and_validates_the_config(api):
    client, login, _ = api
    login("SWE123")
    assert client.post("/api/v1/autonomy/backtest", json={"config": {}}).status_code == 403
    login("HR001")
    bad = client.post("/api/v1/autonomy/backtest", json={"config": {"auto_limit_standard": "lots"}})
    assert bad.status_code == 422


def test_me_returns_the_trust_card_without_risk_details(api):
    client, login, result = api
    login("SWE123")
    res = client.get("/api/v1/autonomy/me")
    assert res.status_code == 200
    body = res.json()
    expected = final_trust(result["history"], datetime.now(timezone.utc))["SWE123"]
    assert body["trust_tier"] == expected.value == "STANDARD"
    assert body["auto_limit"] == 100.0 and body["currency"] == "MYR"
    assert body["next_tier"] == "TRUSTED" and body["next_limit"] == 200.0
    assert body["claims_to_next_tier"] == 10 - body["paid_claims"]
    assert set(body) == {"trust_tier", "auto_limit", "paid_claims", "next_tier", "claims_to_next_tier",
                         "reasons", "currency", "next_limit", "limited_until", "changes", "levels",
                         "hold_days", "trusted_clean_days"}
    # The replay starts at NEW, so a STANDARD employee has at least one change, ending where they are now.
    assert body["changes"] and body["changes"][0]["to_tier"] == "STANDARD"
    assert [lv["auto_limit"] for lv in body["levels"]] == [50.0, 100.0, 200.0]
    raw = res.text
    assert "signal" not in raw.lower() and "risk" not in raw.lower()


def test_me_explains_a_recent_correction(api):
    client, login, result = api
    trust = final_trust(result["history"], datetime.now(timezone.utc))
    corrected = [code for code, tier in trust.items() if tier == TrustTier.NEW
                 and any(c.recovery and c.user_code == code for c in result["history"])]
    assert corrected, "seed should hold an employee held at NEW by a recovery"
    login(corrected[0])
    body = client.get("/api/v1/autonomy/me").json()
    assert body["trust_tier"] == "NEW" and body["next_tier"] == "STANDARD"
    assert body["limited_until"] is not None
    assert body["reasons"][0].startswith("Instant payouts are limited after a recent correction.")
    if body["changes"]:
        latest = body["changes"][0]
        assert latest["to_tier"] == "NEW" and latest["cause"] in ("recovery", "correction")
        assert latest["reim_id"] is not None


def test_me_is_employee_only(api):
    client, login, _ = api
    login("HR001")
    assert client.get("/api/v1/autonomy/me").status_code == 403
