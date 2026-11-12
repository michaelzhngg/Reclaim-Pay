from datetime import datetime, timedelta, timezone

from engine.risk import autonomy
from engine.risk.types import EmployeeHistory, TrustTier
from engine.services import autonomy_store, backtest_service

NAMES = ("STANDARD_MIN_PAID", "TRUSTED_MIN_PAID", "NEW_ISSUE_DAYS", "TRUSTED_ISSUE_DAYS")


def _h(paid, issues_90=0, issues_180=0):
    return EmployeeHistory(paid_claims=paid, confirmed_issues_90d=issues_90, confirmed_issues_180d=issues_180,
                           auto_paid_today=0, auto_paid_month=0)


def test_thresholds_keep_their_values():
    assert [getattr(autonomy, n) for n in NAMES] == [3, 10, 90, 180]


def test_backtest_uses_the_same_thresholds_as_the_decision():
    for name in NAMES:
        assert getattr(backtest_service, name) == getattr(autonomy, name), name


def test_trust_tier_boundaries_follow_the_constants():
    assert autonomy.trust_tier(_h(autonomy.STANDARD_MIN_PAID - 1)) == TrustTier.NEW
    assert autonomy.trust_tier(_h(autonomy.STANDARD_MIN_PAID)) == TrustTier.STANDARD
    assert autonomy.trust_tier(_h(autonomy.TRUSTED_MIN_PAID - 1)) == TrustTier.STANDARD
    assert autonomy.trust_tier(_h(autonomy.TRUSTED_MIN_PAID)) == TrustTier.TRUSTED
    assert autonomy.trust_tier(_h(autonomy.TRUSTED_MIN_PAID, issues_180=1)) == TrustTier.STANDARD
    assert autonomy.trust_tier(_h(autonomy.TRUSTED_MIN_PAID, issues_90=1, issues_180=1)) == TrustTier.NEW


def test_history_windows_follow_the_constants():
    now = datetime(2026, 11, 12, tzinfo=timezone.utc)
    just_inside = now - timedelta(days=autonomy.NEW_ISSUE_DAYS - 1)
    between = now - timedelta(days=autonomy.NEW_ISSUE_DAYS + 1)
    too_old = now - timedelta(days=autonomy.TRUSTED_ISSUE_DAYS + 1)
    h = autonomy_store.history_from_rows([], [just_inside, between, too_old], now)
    assert (h.confirmed_issues_90d, h.confirmed_issues_180d) == (1, 2)


def test_an_issue_exactly_at_the_window_edge_still_counts():
    now = datetime(2026, 11, 12, tzinfo=timezone.utc)
    at_new_edge = now - timedelta(days=autonomy.NEW_ISSUE_DAYS)
    at_trusted_edge = now - timedelta(days=autonomy.TRUSTED_ISSUE_DAYS)
    assert autonomy_store.history_from_rows([], [at_new_edge], now).confirmed_issues_90d == 1
    h = autonomy_store.history_from_rows([], [at_trusted_edge], now)
    assert (h.confirmed_issues_90d, h.confirmed_issues_180d) == (0, 1)
