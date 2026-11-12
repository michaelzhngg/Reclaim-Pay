"""Funding alert: the maths, the 24-hour dedupe, the balance fetch and the HR endpoint. No network, no database."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import deps
from api import payouts as payouts_api
from core.enums import UserRole
from core.models import User
from engine.services import funding_service as fs
from engine.services.funding_service import (
    ALERT_TITLES,
    alert_recipients,
    build_funding,
    days_of_cover,
    expected_daily,
    funding_status,
)
from engine.services.paypal_client import Balance, PayPalError

NOW = datetime(2026, 11, 12, 9, tzinfo=timezone.utc)
D = Decimal
HR1 = UUID("11111111-1111-1111-1111-111111111111")
HR2 = UUID("22222222-2222-2222-2222-222222222222")


def summary(available="1240.00", payouts=("2870.00",), committed="0", threshold=3, reason=None):
    balance = None if available is None else Balance("MYR", D(available), NOW)
    return build_funding(currency="MYR", balance=balance, payout_amounts=[D(a) for a in payouts],
                         committed=D(committed), threshold_days=threshold, now=NOW, reason=reason)


# --- maths --------------------------------------------------------------------------------------------

def test_expected_daily_averages_over_the_whole_window():
    assert expected_daily([D("700.00"), D("700.00")], days=14) == D("100.00")
    assert expected_daily([D("10.00")], days=3) == D("3.33")
    assert expected_daily([], days=14) == D("0.00")
    assert expected_daily([D("50")], days=0) == D("0.00")


def test_days_of_cover_rounds_down_and_handles_zero():
    assert days_of_cover(D("250.00"), D("100.00")) == D("2.5")
    assert days_of_cover(D("299.99"), D("100.00")) == D("2.9")
    assert days_of_cover(D("0.00"), D("100.00")) == D("0.0")
    assert days_of_cover(D("-5.00"), D("100.00")) == D("0.0")
    assert days_of_cover(D("500.00"), D("0.00")) is None


@pytest.mark.parametrize("available,daily,committed,expected", [
    (None, D("100"), D("0"), "unavailable"),
    (D("1000"), D("100"), D("0"), "ok"),
    (D("300"), D("100"), D("0"), "ok"),          # exactly the threshold is enough
    (D("299.99"), D("100"), D("0"), "low"),
    (D("0"), D("100"), D("0"), "low"),
    (D("400"), D("100"), D("500"), "short"),
    (D("-1"), D("0"), D("0"), "short"),         # overdrawn: can't cover even nothing
    (D("400"), D("0"), D("500"), "short"),      # short wins over no history
    (D("500"), D("0"), D("0"), "no_history"),
    (D("0"), D("0"), D("0"), "no_history"),
    (D("500"), D("100"), D("500"), "ok"),       # covers exactly what is owed
])
def test_funding_status(available, daily, committed, expected):
    assert funding_status(available, daily, committed, 3) == expected


def test_summary_ok():
    s = summary(available="25000.00", payouts=["1400.00"])
    assert s.status == "ok" and s.expected_daily == D("100.00") and s.days_of_cover == D("250.0")
    assert s.message == "MYR 25,000.00 available covers about 250 days of payouts."


def test_summary_low():
    s = summary(available="410.00", payouts=["2870.00"])  # 205.00 a day
    assert s.status == "low" and s.days_of_cover == D("2.0")
    assert s.message.startswith("MYR 410.00 available covers about 2 days of payouts, under the 3-day minimum")


def test_summary_low_under_a_day():
    s = summary(available="50.00", payouts=["2870.00"])
    assert s.status == "low" and "less than a day" in s.message


def test_summary_short():
    s = summary(available="300.00", payouts=["2870.00"], committed="520.00")
    assert s.status == "short" and s.committed == D("520.00")
    assert s.message == "MYR 300.00 available can't cover MYR 520.00 of approved claims waiting to be paid."


def test_summary_no_history():
    s = summary(available="300.00", payouts=[])
    assert s.status == "no_history" and s.days_of_cover is None
    assert "no payouts in the last 14 days" in s.message


@pytest.mark.parametrize("reason,message", [
    ("credentials", "PayPal rejected the app's client ID or secret."),
    ("permission", 'PayPal refused to share the balance. Tick "Transaction search" under the PayPal app\'s '
                   "features in the developer dashboard."),
    ("refused", "PayPal refused the balance request."),
    ("unreachable", "PayPal can't be reached right now."),
    ("not_configured", "PayPal credentials aren't set."),
    ("not_held", "The PayPal account holds no MYR balance."),
    ("unreadable", "PayPal returned a balance that couldn't be read."),
])
def test_summary_unavailable_explains_why(reason, message):
    s = summary(available=None, reason=reason)
    assert s.status == "unavailable" and s.available is None and s.days_of_cover is None
    assert s.message == message


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity"])
def test_non_finite_balance_is_unavailable_not_a_crash(value):
    s = summary(available=value)
    assert s.status == "unavailable" and s.available is None
    assert s.message == "PayPal returned a balance that couldn't be read."
    assert alert_recipients(s.status, [HR1], []) == []


def test_overdrawn_with_nothing_owed_says_overdrawn():
    s = summary(available="-50.00", committed="0")
    assert s.status == "short"
    assert s.message == "The PayPal account is overdrawn by MYR 50.00, so no payout can go out until it is topped up."
    assert "MYR 0.00" not in s.message


def test_money_stays_decimal_and_serialises_as_strings():
    s = summary(available="410.005", payouts=["2870.00"], committed="12.345")
    for value in (s.available, s.expected_daily, s.committed, s.days_of_cover):
        assert isinstance(value, Decimal)
    assert s.available == D("410.01") and s.committed == D("12.35")
    body = s.model_dump(mode="json")
    assert body["available"] == "410.01" and body["expected_daily"] == "205.00"


# --- dedupe -------------------------------------------------------------------------------------------

def test_alert_goes_to_every_hr_user_once_per_day():
    assert alert_recipients("low", [HR1, HR2], []) == [HR1, HR2]
    assert alert_recipients("low", [HR1, HR2], [(HR1, ALERT_TITLES["low"])]) == [HR2]


def test_no_alert_when_funded_or_unknown():
    for status in ("ok", "no_history", "unavailable"):
        assert alert_recipients(status, [HR1], []) == []


def test_short_still_alerts_after_low_but_not_the_reverse():
    assert alert_recipients("short", [HR1], [(HR1, ALERT_TITLES["low"])]) == [HR1]
    assert alert_recipients("low", [HR1], [(HR1, ALERT_TITLES["short"])]) == []
    assert alert_recipients("short", [HR1], [(HR1, ALERT_TITLES["short"])]) == []


def test_unrelated_notifications_do_not_suppress():
    assert alert_recipients("low", [HR1], [(HR1, "Payout failed for claim RC-1")]) == [HR1]


class _AlertDB:
    def __init__(self, hr_ids, recent):
        self.results = [hr_ids, recent]
        self.queries = []

    def exec(self, query):
        self.queries.append(query)
        rows = self.results.pop(0)
        return SimpleNamespace(all=lambda: rows)


def test_alert_hr_sends_and_looks_back_24_hours(monkeypatch):
    sent = []
    monkeypatch.setattr(fs, "notify", lambda db, user_id, n_type, title, message, link=None:
                        sent.append((user_id, n_type, title, link)))
    db = _AlertDB([HR1, HR2], [(HR2, ALERT_TITLES["low"])])
    assert fs.alert_hr(db, summary(available="410.00"), now=NOW) == 1
    assert sent == [(HR1, "warning", ALERT_TITLES["low"], "/hr/payouts")]
    params = db.queries[1].compile().params
    assert NOW - timedelta(hours=24) in params.values()


def test_alert_hr_does_nothing_when_funded(monkeypatch):
    monkeypatch.setattr(fs, "notify", lambda *a, **k: pytest.fail("should not notify"))
    assert fs.alert_hr(_AlertDB([], []), summary(available="25000.00"), now=NOW) == 0


# --- balance fetch ------------------------------------------------------------------------------------

class _Client:
    def __init__(self, result):
        self.result = result

    async def get_balance(self, currency):
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


@pytest.fixture
def live(monkeypatch):
    monkeypatch.setattr(fs.settings, "PAYPAL_MOCK_MODE", False)
    monkeypatch.setattr(fs.settings, "PAYPAL_CLIENT_ID", "cid")
    monkeypatch.setattr(fs.settings, "PAYPAL_CLIENT_SECRET", "secret")


@pytest.mark.parametrize("error,reason", [(PayPalError(401, "invalid_client"), "credentials"),
                                          (PayPalError(403, "NOT_AUTHORIZED"), "permission"),
                                          (PayPalError(400, "INVALID_REQUEST"), "refused"),
                                          (PayPalError(422, "UNPROCESSABLE_ENTITY"), "refused"),
                                          (PayPalError(429, "RATE_LIMIT_REACHED"), "unreachable"),
                                          (PayPalError(500, "INTERNAL_SERVER_ERROR"), "unreachable"),
                                          (PayPalError(504, "TIMEOUT"), "unreachable"),
                                          (TimeoutError(), "unreachable"),
                                          (ValueError("unreadable"), "unreadable"),
                                          (RuntimeError("boom"), "unreachable")])
async def test_balance_failures_become_unavailable(monkeypatch, live, error, reason):
    monkeypatch.setattr(fs, "get_paypal_client", lambda: _Client(error))
    assert await fs._fetch_balance("MYR") == (None, reason)


async def test_currency_not_held_is_unavailable_not_zero(monkeypatch, live):
    monkeypatch.setattr(fs, "get_paypal_client", lambda: _Client(None))
    assert await fs._fetch_balance("MYR") == (None, "not_held")


async def test_non_finite_balance_from_the_client_is_unreadable(monkeypatch, live):
    monkeypatch.setattr(fs, "get_paypal_client", lambda: _Client(Balance("MYR", D("NaN"), NOW)))
    assert await fs._fetch_balance("MYR") == (None, "unreadable")


async def test_balance_without_credentials_is_not_configured(monkeypatch, live):
    monkeypatch.setattr(fs.settings, "PAYPAL_CLIENT_ID", "")
    monkeypatch.setattr(fs, "get_paypal_client", lambda: pytest.fail("should not call PayPal"))
    assert await fs._fetch_balance("MYR") == (None, "not_configured")


async def test_mock_mode_reports_the_configured_balance(monkeypatch):
    from engine.services.paypal_client import MockPayPalClient
    monkeypatch.setattr(fs.settings, "PAYPAL_MOCK_BALANCE", D("1234.50"))
    balance = await MockPayPalClient().get_balance("myr")
    assert (balance.currency, balance.available) == ("MYR", D("1234.50"))


PAYOUT_ROWS = [(D("700.00"), "5ABCDEF"), (D("700.00"), "DEMOSEED-1a2b3c"), (D("700.00"), "MOCKB-ABC"), (D("700.00"), None)]


@pytest.mark.parametrize("mock,daily", [(False, D("50.00")), (True, D("200.00"))])
async def test_funding_summary_counts_only_payouts_that_drew_on_this_balance(monkeypatch, mock, daily):
    monkeypatch.setattr(fs.settings, "PAYPAL_MOCK_MODE", mock)
    monkeypatch.setattr(fs.settings, "PAYPAL_CLIENT_ID", "cid")
    monkeypatch.setattr(fs.settings, "PAYPAL_CLIENT_SECRET", "secret")
    monkeypatch.setattr(fs, "get_paypal_client", lambda: _Client(Balance("MYR", D("5000.00"), NOW)))
    db = _AlertDB(PAYOUT_ROWS, [(D("120.00"), None, None), (None, None, None), (D("30.50"), None, None)])
    s = await fs.funding_summary(db, now=NOW)
    # Live: seeded and mock payouts never left the real balance. Mock: the balance is fake too, so all count.
    assert s.expected_daily == daily and s.committed == D("150.50") and s.mock is mock
    payout_sql = str(db.queries[0].compile(compile_kwargs={"literal_binds": True}))
    assert "'SUCCEEDED'" in payout_sql and "'FAILED'" not in payout_sql and "'REVERSED'" not in payout_sql
    claim_sql = str(db.queries[1].compile(compile_kwargs={"literal_binds": True}))
    assert "'APPROVED'" in claim_sql and "'DISBURSEMENT_FAILED'" in claim_sql and "'PAID'" not in claim_sql
    # Payouts are still sent in PAYPAL_CURRENCY in this stage, and claims are committed in company currency.
    assert "reimbursements.currency" not in claim_sql


# --- endpoint -----------------------------------------------------------------------------------------

def _app(monkeypatch, role, alert=None):
    async def fake_summary(db):
        return summary(available="410.00")

    calls = []

    def fake_alert(db, s):
        calls.append(s.status)
        if alert:
            raise alert

    monkeypatch.setattr(payouts_api, "funding_summary", fake_summary)
    monkeypatch.setattr(payouts_api, "alert_hr", fake_alert)
    app = FastAPI()
    app.include_router(payouts_api.router, prefix="/payouts")
    app.dependency_overrides[deps.get_db] = lambda: SimpleNamespace(rollback=lambda: None)
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=HR1, email="hr@example.com", hashed_password="x", name="HR", role=role)
    return TestClient(app), calls


def test_endpoint_returns_the_summary_and_alerts(monkeypatch):
    client, calls = _app(monkeypatch, UserRole.HR)
    resp = client.get("/payouts/funding")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "low" and body["available"] == "410.00" and body["threshold_days"] == 3
    assert calls == ["low"]


def test_endpoint_is_hr_only(monkeypatch):
    client, calls = _app(monkeypatch, UserRole.Employee)
    assert client.get("/payouts/funding").status_code == 403
    assert calls == []


def test_a_failed_alert_never_breaks_the_endpoint(monkeypatch):
    client, _ = _app(monkeypatch, UserRole.HR, alert=RuntimeError("push down"))
    resp = client.get("/payouts/funding")
    assert resp.status_code == 200 and resp.json()["status"] == "low"
