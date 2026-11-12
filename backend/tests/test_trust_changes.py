from datetime import datetime, timedelta, timezone
from uuid import uuid4

from engine.risk.types import AutonomyConfig, TrustTier
from engine.services.backtest_service import trust_changes, trust_levels

NOW = datetime(2026, 11, 12, tzinfo=timezone.utc)
CFG = AutonomyConfig()


def day(n: int) -> datetime:
    """n days before NOW."""
    return NOW - timedelta(days=n)


def tiers(changes):
    return [(c["from_tier"], c["to_tier"], c["cause"]) for c in changes]


def test_no_history_means_no_changes():
    assert trust_changes([], [], CFG, NOW) == []


def test_third_paid_claim_reaches_standard():
    changes = trust_changes([day(30), day(20), day(10)], [], CFG, NOW)
    assert tiers(changes) == [(TrustTier.NEW, TrustTier.STANDARD, "approved_claims")]
    c = changes[0]
    assert c["at"] == day(10)
    assert (c["from_limit"], c["to_limit"]) == (CFG.auto_limit_new, CFG.auto_limit_standard)
    assert c["reim_id"] is None


def test_correction_drops_to_new_and_names_the_claim():
    reim = uuid4()
    changes = trust_changes([day(40 - i) for i in range(4)], [(day(5), "recovery", reim)], CFG, NOW)
    assert tiers(changes) == [
        (TrustTier.STANDARD, TrustTier.NEW, "recovery"),
        (TrustTier.NEW, TrustTier.STANDARD, "approved_claims"),
    ]
    assert changes[0]["reim_id"] == reim and changes[0]["at"] == day(5)


def test_limit_comes_back_after_the_hold_and_trusted_after_the_clean_period():
    paid = [day(300 - i) for i in range(12)]
    changes = trust_changes(paid, [(day(200), "correction", uuid4())], CFG, NOW, limit=10)
    assert tiers(reversed(changes)) == [
        (TrustTier.NEW, TrustTier.STANDARD, "approved_claims"),
        (TrustTier.STANDARD, TrustTier.TRUSTED, "approved_claims"),
        (TrustTier.TRUSTED, TrustTier.NEW, "correction"),
        (TrustTier.NEW, TrustTier.STANDARD, "time_passed"),
        (TrustTier.STANDARD, TrustTier.TRUSTED, "time_passed"),
    ]
    # The issue still counts on day 90, so the limit returns just after.
    hold_ends = day(200) + timedelta(days=90)
    assert timedelta(0) < changes[1]["at"] - hold_ends < timedelta(seconds=1)


def test_returns_the_last_three_newest_first():
    paid = [day(300 - i) for i in range(12)]
    changes = trust_changes(paid, [(day(200), "correction", uuid4())], CFG, NOW)
    assert len(changes) == 3
    assert [c["at"] for c in changes] == sorted((c["at"] for c in changes), reverse=True)
    assert changes[0]["to_tier"] == TrustTier.TRUSTED


def test_ignores_events_after_now():
    assert trust_changes([day(3), day(2), NOW + timedelta(days=1)], [], CFG, NOW) == []


def test_ends_on_the_live_tier_while_a_correction_holds():
    paid = [day(100 - i) for i in range(12)]
    changes = trust_changes(paid, [(day(30), "recovery", uuid4())], CFG, NOW)
    assert changes[0]["to_tier"] == TrustTier.NEW


def test_a_correction_while_new_is_not_a_change():
    assert trust_changes([day(10)], [(day(5), "recovery", uuid4())], CFG, NOW) == []


def test_trust_card_model_keeps_old_payloads_valid_and_holds_no_risk_words():
    from api.autonomy import TrustInfoOut

    old = {"trust_tier": "NEW", "auto_limit": 50.0, "paid_claims": 0, "next_tier": "STANDARD",
           "claims_to_next_tier": 3, "reasons": [], "currency": "MYR", "next_limit": 100.0, "limited_until": None}
    assert TrustInfoOut.model_validate(old).changes == []

    reim = uuid4()
    changes = trust_changes([day(40 - i) for i in range(4)], [(day(5), "recovery", reim)], CFG, NOW)
    full = {**old, "changes": changes, "levels": trust_levels(CFG), "hold_days": 90, "trusted_clean_days": 180}
    out = TrustInfoOut.model_validate(full).model_dump_json().lower()
    assert str(reim) in out
    assert "signal" not in out and "risk" not in out and "score" not in out


def test_levels_follow_the_config():
    cfg = CFG.model_copy(update={"auto_limit_new": 25.0, "auto_limit_standard": 75.0, "auto_limit_trusted": 150.0})
    assert [(lv["tier"], lv["auto_limit"], lv["min_paid_claims"]) for lv in trust_levels(cfg)] == [
        (TrustTier.NEW, 25.0, 0), (TrustTier.STANDARD, 75.0, 3), (TrustTier.TRUSTED, 150.0, 10),
    ]
