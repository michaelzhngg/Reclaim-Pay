from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from engine.services.autonomy_store import history_from_rows, ledger_from_rows, payee_from_user

NOW = datetime(2026, 11, 3, 15, 0, tzinfo=timezone.utc)


def row(status, tier, amount, hours_ago):
    return {"status": status, "tier": tier, "amount": amount, "updated_at": NOW - timedelta(hours=hours_ago)}


def test_history_counts_paid_and_auto_paid_today_and_month():
    rows = [row("PAID", "AUTO_PAY", 40, 2), row("PAID", "HR_REVIEW", 300, 3),
            row("PAID", "AUTO_PAY", 60, 24 * 2), row("REVIEW", "HR_QUICK", 80, 1)]
    h = history_from_rows(rows, issue_dates=[NOW - timedelta(days=100)], now=NOW)
    assert h.paid_claims == 3
    assert h.auto_paid_today == 40
    assert h.auto_paid_month == 100
    assert h.confirmed_issues_90d == 0 and h.confirmed_issues_180d == 1


def test_ledger_sums_today_and_last_hour_and_breaker():
    rows = [row("PAID", "AUTO_PAY", 50, 0.5), row("DISBURSING", "AUTO_PAY", 30, 5), row("PAID", "HR_REVIEW", 900, 0.2)]
    led = ledger_from_rows(rows, now=NOW, breaker_until=NOW + timedelta(minutes=30))
    assert led.auto_paid_today == 80 and led.auto_paid_last_hour == 50 and led.breaker_active is True


def test_ledger_counts_paid_vendor_bookings_not_approved_ones():
    vendor_rows = [
        {"status": "PAID", "amount": 240, "updated_at": NOW - timedelta(hours=1)},
        {"status": "DISBURSING", "amount": 60, "updated_at": NOW - timedelta(hours=2)},
        {"status": "APPROVED", "amount": 500, "updated_at": NOW - timedelta(hours=1)},
        {"status": "PAID", "amount": 90, "updated_at": NOW - timedelta(days=2)},
    ]
    led = ledger_from_rows([], now=NOW, breaker_until=None, vendor_rows=vendor_rows)
    assert led.vendor_paid_today == 300
    assert led.auto_paid_today == 0 and led.auto_paid_last_hour == 0


def test_today_and_month_use_utc_calendar_boundaries():
    rows = [row("APPROVED", "AUTO_PAY", 10, 15.5),  # 23:30 on Nov 2: this month, not today
            row("PAID", "AUTO_PAY", 20, 24 * 3),    # Oct 31: neither
            row("REJECTED", "AUTO_PAY", 99, 1)]     # not an auto-paid status
    h = history_from_rows(rows, issue_dates=[], now=NOW)
    assert (h.auto_paid_today, h.auto_paid_month, h.paid_claims) == (0, 10, 1)


def test_ledger_breaker_expired_is_inactive():
    led = ledger_from_rows([], now=NOW, breaker_until=NOW - timedelta(seconds=1))
    assert led.breaker_active is False and led.auto_paid_today == 0


def test_payee_needs_verified_paypal_account():
    linked = datetime(2026, 10, 1, tzinfo=timezone.utc)
    ok = payee_from_user(SimpleNamespace(paypal_verified=True, paypal_payer_id="P1",
                                         paypal_linked_at=linked, payout_destination_changed_at=None))
    assert ok.verified is True and ok.linked_at == linked and ok.changed_at is None
    unlinked = payee_from_user(SimpleNamespace(paypal_verified=True, paypal_payer_id=None,
                                               paypal_linked_at=None, payout_destination_changed_at=None))
    assert unlinked.verified is False
