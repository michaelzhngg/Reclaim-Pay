"""Reconciliation against PayPal Transaction Search. No network: the SDK's HTTP layer is faked where it runs at all."""
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
import requests
from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import deps
from api import payouts as payouts_api
from core.enums import PayoutStatus, UserRole
from core.models import Payout, User
from engine.services import reconcile_service as rs
from engine.services.reconcile_service import (
    PayoutFacts,
    Transaction,
    TransactionFeed,
    TransactionSearchUnavailable,
    build_summary,
    match_transactions,
)

NOW = datetime(2026, 11, 4, 12, 0, tzinfo=timezone.utc)
SINCE = NOW - timedelta(days=1)
RID = UUID("12345678-1234-5678-1234-567812345678")
UID = UUID("87654321-4321-8765-4321-876543218765")


def facts(amount="48.00", age_hours=6, settled=True, currency="MYR", updated_hours=None, batch="B1"):
    created = NOW - timedelta(hours=age_hours)
    updated = NOW - timedelta(hours=age_hours if updated_hours is None else updated_hours)
    return PayoutFacts(uuid4(), RID, "Aisyah", "Aisyah", Decimal(amount), currency, created, updated, settled, batch)


def txn(amount="-48.00", age_hours=6, tid="T1", currency="MYR", code="T0001"):
    return Transaction(tid, Decimal(amount), currency, NOW - timedelta(hours=age_hours), code)


def summary(payouts, txns, data_through=None):
    return build_summary(payouts, TransactionFeed(txns, data_through), SINCE, NOW, 1)


def test_match_transactions_exact_lists():
    t = NOW
    payouts = [("p1", Decimal("48.00"), t), ("p2", Decimal("90.00"), t)]
    txns = [("t1", Decimal("48.00"), t + timedelta(minutes=5)),
            ("t2", Decimal("12.00"), t),
            ("t3", Decimal("48.00"), t + timedelta(hours=3))]
    report = match_transactions(payouts, txns)
    assert report.matched == [("p1", "t1")]
    assert report.missing_in_paypal == ["p2"]
    assert report.unknown_in_paypal == ["t2", "t3"]


def test_match_is_one_to_one_and_prefers_the_closest_transaction():
    t = NOW
    payouts = [("p1", Decimal("48"), t), ("p2", Decimal("48"), t + timedelta(minutes=30))]
    txns = [("near-p2", Decimal("48"), t + timedelta(minutes=31)), ("near-p1", Decimal("48"), t + timedelta(minutes=1))]
    assert match_transactions(payouts, txns).matched == [("p1", "near-p1"), ("p2", "near-p2")]
    assert match_transactions(payouts, txns[:1]).missing_in_paypal == ["p2"]


@pytest.mark.parametrize("minutes,matches", [(120, True), (121, False)])
def test_window_boundary(minutes, matches):
    report = match_transactions([("p", Decimal("1"), NOW)], [("t", Decimal("1"), NOW + timedelta(minutes=minutes))])
    assert bool(report.matched) is matches


def test_paypal_debit_sign_is_matched_against_the_positive_payout():
    result = summary([facts()], [txn()])
    assert (result.state, result.reconciled, result.total, result.mismatches) == ("ok", 1, 1, [])


def test_old_payout_with_no_transaction_is_listed_as_a_mismatch():
    missing = facts(amount="90.00")
    result = summary([facts(), missing], [txn()])
    assert (result.reconciled, result.total, result.pending) == (1, 2, 0)
    assert [m.payout_id for m in result.mismatches] == [missing.payout_id]
    row = result.mismatches[0]
    assert row.claim_ref == "RC-12345678" and row.employee_name == "Aisyah" and row.amount == 90.0
    assert row.reason == "MISSING_IN_PAYPAL"


def test_recent_payout_not_found_is_pending_not_a_mismatch():
    result = summary([facts(age_hours=1), facts(amount="90.00")], [txn(amount="-90.00")])
    assert (result.reconciled, result.total, result.pending, result.mismatches) == (1, 2, 1, [])


def test_lag_runs_from_the_last_status_change_not_creation():
    # Created 8 h ago but only executed 1 h ago: PayPal may not list it yet.
    result = summary([facts(age_hours=8, updated_hours=1), facts(amount="90.00")], [txn(amount="-90.00")])
    assert (result.pending, result.mismatches) == (1, [])


def test_payout_after_paypals_last_refresh_is_pending_even_when_old():
    stale_search = NOW - timedelta(hours=10)
    result = summary([facts(age_hours=5), facts(amount="90.00", age_hours=20)],
                     [txn(amount="-90.00", age_hours=20)], data_through=stale_search)
    assert (result.reconciled, result.pending, result.mismatches) == (1, 1, [])


def test_empty_search_compares_nothing_instead_of_flagging_every_payout():
    result = summary([facts()], [])
    assert (result.state, result.total, result.reconciled, result.mismatches) == ("no_data", 1, 0, [])
    assert "no transactions" in result.message


def test_no_paid_payouts_is_no_data():
    result = summary([facts(settled=False)], [txn()])
    assert (result.state, result.total) == ("no_data", 0)


def test_unknown_lists_only_unmatched_mass_payments_in_the_period():
    result = summary([facts()], [
        txn(),
        txn(amount="-77.00", tid="ORPHAN"),
        txn(amount="-500.00", tid="BANK", code="T0400"),
        txn(amount="-1.00", tid="FEE", code="T0104"),
        txn(amount="30.00", tid="INCOMING", code="T0001"),
        txn(amount="-66.00", tid="TOO-OLD", age_hours=25),
    ])
    assert [(u.transaction_id, u.amount) for u in result.unknown_in_paypal] == [("ORPHAN", 77.0)]


def test_in_flight_payout_owns_its_transaction_without_counting_towards_m():
    result = summary([facts(), facts(amount="20.00", settled=False)], [txn(), txn(amount="-20.00", tid="T2")])
    assert (result.reconciled, result.total, result.unknown_in_paypal) == (1, 1, [])


def test_payout_just_before_the_period_owns_its_transaction():
    earlier = facts(amount="20.00", age_hours=24.5)
    result = summary([facts(), earlier], [txn(), txn(amount="-20.00", tid="T2", age_hours=23.9)])
    assert result.total == 1 and result.unknown_in_paypal == []


def test_amounts_in_different_currencies_never_match():
    result = summary([facts()], [txn(currency="USD")])
    assert (result.reconciled, len(result.mismatches)) == (0, 1)


# PayPal's documented response, parsed by the SDK's real models.
SEARCH_BODY = {
    "transaction_details": [
        {"transaction_info": {
            "transaction_id": "5TY05013RG002845M", "transaction_event_code": "T0001",
            "transaction_initiation_date": "2026-11-04T06:00:30+0000",
            "transaction_updated_date": "2026-11-04T06:00:40+0000",
            "transaction_amount": {"currency_code": "MYR", "value": "-48.00"},
            "transaction_status": "S",
        }},
        {"transaction_info": {
            "transaction_id": "DENIED", "transaction_event_code": "T0001",
            "transaction_initiation_date": "2026-11-04T06:00:30+0000",
            "transaction_amount": {"currency_code": "MYR", "value": "-9.00"},
            "transaction_status": "D",
        }},
    ],
    "last_refreshed_datetime": "2026-11-04T10:59:59+0000",
    "page": 1, "total_items": 2, "total_pages": 1,
}


def _http_response(status, body):
    import json as jsonlib
    resp = requests.Response()
    resp.status_code = status
    resp._content = jsonlib.dumps(body).encode()
    resp.headers["Content-Type"] = "application/json"
    resp.url = "https://api-m.sandbox.paypal.com/"
    return resp


@pytest.fixture
def sdk_http(monkeypatch):
    """Replaces the socket under the real SDK. `search` decides the answer to each Transaction Search call."""
    calls = []
    behaviour = {"search": lambda url: _http_response(200, SEARCH_BODY)}

    def fake_request(self, method, url, **kwargs):
        if "/v1/oauth2/token" in url:
            return _http_response(200, {"access_token": "tok", "token_type": "Bearer", "expires_in": 3600})
        calls.append(SimpleNamespace(method=method, url=url, params=kwargs.get("params"),
                                     timeout=kwargs.get("timeout")))
        return behaviour["search"](url)

    monkeypatch.setattr(requests.Session, "request", fake_request)
    monkeypatch.setattr(rs.settings, "PAYPAL_CLIENT_ID", "id")
    monkeypatch.setattr(rs.settings, "PAYPAL_CLIENT_SECRET", "secret")
    return SimpleNamespace(calls=calls, behaviour=behaviour)


def test_fetch_uses_the_sdk_endpoint_and_parses_the_response(sdk_http):
    feed = rs.fetch_transactions(SINCE, NOW)
    [call] = sdk_http.calls
    assert call.method == "GET" and "api-m.sandbox.paypal.com/v1/reporting/transactions" in call.url
    assert "start_date=2026-11-03T12%3A00%3A00Z" in call.url and "fields=transaction_info" in call.url
    assert call.timeout == rs.SDK_TIMEOUT_SECONDS
    assert feed.data_through == datetime(2026, 11, 4, 10, 59, 59, tzinfo=timezone.utc)
    [t] = feed.transactions
    assert t == Transaction("5TY05013RG002845M", Decimal("-48.00"), "MYR",
                            datetime(2026, 11, 4, 6, 0, 30, tzinfo=timezone.utc), "T0001")


def test_fetch_reads_every_page(sdk_http):
    pages = [{**SEARCH_BODY, "total_pages": 2, "page": 1}, {**SEARCH_BODY, "total_pages": 2, "page": 2}]
    sdk_http.behaviour["search"] = lambda url: _http_response(200, pages[len(sdk_http.calls) - 1])
    assert len(rs.fetch_transactions(SINCE, NOW).transactions) == 2
    assert len(sdk_http.calls) == 2 and "page=2" in sdk_http.calls[1].url


def _connection_down(url):
    raise requests.ConnectionError("no route to host")


@pytest.mark.parametrize("search", [
    _connection_down,
    lambda url: _http_response(403, {"name": "NOT_AUTHORIZED", "message": "missing scope"}),
    lambda url: _http_response(500, {"name": "INTERNAL_SERVICE_ERROR"}),
    lambda url: _http_response(200, {"transaction_details": [{"transaction_info": {
        "transaction_id": "X", "transaction_initiation_date": "not a date",
        "transaction_amount": {"currency_code": "MYR", "value": "-1.00"}}}]}),
], ids=["connection", "403-no-scope", "500", "unparseable"])
def test_fetch_failures_become_unavailable(sdk_http, search):
    sdk_http.behaviour["search"] = search
    with pytest.raises(TransactionSearchUnavailable):
        rs.fetch_transactions(SINCE, NOW)


def test_a_failed_later_page_discards_the_earlier_ones(sdk_http):
    first = {**SEARCH_BODY, "total_pages": 2}
    sdk_http.behaviour["search"] = lambda url: (
        _http_response(200, first) if len(sdk_http.calls) == 1 else _http_response(500, {}))
    with pytest.raises(TransactionSearchUnavailable):
        rs.fetch_transactions(SINCE, NOW)


def test_too_many_pages_is_unavailable_not_a_partial_list(sdk_http):
    sdk_http.behaviour["search"] = lambda url: _http_response(200, {**SEARCH_BODY, "total_pages": rs.MAX_PAGES + 1})
    with pytest.raises(TransactionSearchUnavailable):
        rs.fetch_transactions(SINCE, NOW)


def test_missing_credentials_are_unavailable_without_a_request(sdk_http, monkeypatch):
    monkeypatch.setattr(rs.settings, "PAYPAL_CLIENT_ID", "")
    with pytest.raises(TransactionSearchUnavailable):
        rs.fetch_transactions(SINCE, NOW)
    assert sdk_http.calls == []


class _FakeDB:
    def __init__(self, rows):
        self.rows = rows

    def exec(self, query):
        return self

    def all(self):
        return self.rows


def _row(batch="B1", status=PayoutStatus.SUCCEEDED, age_hours=6):
    at = NOW - timedelta(hours=age_hours)
    payout = Payout(payout_id=uuid4(), reim_id=RID, user_id=UID, amount=48, currency="MYR", status=status,
                    provider_batch_id=batch, attempt=1, idempotency_key="k", reference_id="r", channel_code="PAYPAL",
                    created_at=at, updated_at=at)
    return payout, User(user_id=UID, email="e@example.com", hashed_password="x", name="Aisyah")


def _fetch_must_not_run(start, end):
    raise AssertionError("no PayPal call expected")


def test_mock_mode_reconciles_with_no_network_and_says_it_is_mock(monkeypatch):
    monkeypatch.setattr(rs.settings, "PAYPAL_MOCK_MODE", True)
    result = rs.reconcile(_FakeDB([_row(), _row()]), 1, now=NOW, fetch=_fetch_must_not_run)
    assert (result.state, result.reconciled, result.total, result.mock) == ("ok", 2, 2, True)


def test_outage_returns_unavailable_never_a_mismatch(monkeypatch):
    monkeypatch.setattr(rs.settings, "PAYPAL_MOCK_MODE", False)

    def down(start, end):
        raise TransactionSearchUnavailable("down")

    result = rs.reconcile(_FakeDB([_row()]), 1, now=NOW, fetch=down)
    assert (result.state, result.total, result.reconciled, result.mismatches) == ("unavailable", 1, 0, [])
    assert "can't be reached" in result.message


@pytest.mark.parametrize("batch", ["DEMOSEED-abc", "MOCKB-ABC", None])
def test_rows_never_sent_to_paypal_are_not_compared(monkeypatch, batch):
    monkeypatch.setattr(rs.settings, "PAYPAL_MOCK_MODE", False)
    result = rs.reconcile(_FakeDB([_row(batch=batch)]), 1, now=NOW, fetch=_fetch_must_not_run)
    assert (result.state, result.total) == ("no_data", 0)


def test_search_range_covers_the_match_window_before_the_period(monkeypatch):
    monkeypatch.setattr(rs.settings, "PAYPAL_MOCK_MODE", False)
    seen = {}

    def fetch(start, end):
        seen.update(start=start, end=end)
        return TransactionFeed([])

    rs.reconcile(_FakeDB([_row()]), 2, now=NOW, fetch=fetch)
    assert seen == {"start": NOW - timedelta(days=2, minutes=rs.WINDOW_MINUTES), "end": NOW}


def _client(role, rows=()):
    app = FastAPI()
    app.include_router(payouts_api.router, prefix="/payouts")
    app.dependency_overrides[deps.get_db] = lambda: _FakeDB(list(rows))
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=UID, email="u@example.com", hashed_password="x", name="U", role=role)
    return TestClient(app)


def test_endpoint_is_hr_only():
    assert _client(UserRole.Employee).get("/payouts/reconcile").status_code == 403


def test_endpoint_is_not_captured_by_the_reim_id_route(monkeypatch):
    monkeypatch.setattr(rs.settings, "PAYPAL_MOCK_MODE", True)
    resp = _client(UserRole.HR).get("/payouts/reconcile", params={"days": 7})
    assert resp.status_code == 200
    body = resp.json()
    assert body["state"] == "no_data" and body["days"] == 7 and body["mismatches"] == []


@pytest.mark.parametrize("days", [0, 31])
def test_endpoint_rejects_days_outside_paypals_range(days):
    assert _client(UserRole.HR).get("/payouts/reconcile", params={"days": days}).status_code == 422


def test_mismatch_names_the_vendor_and_keeps_the_requester():
    payout = PayoutFacts(uuid4(), RID, "Aisyah", "Hotel Seri Kenanga", Decimal("240.00"), "MYR",
                         NOW - timedelta(hours=6), NOW - timedelta(hours=6), True, "B1")
    row = rs._mismatch(payout)
    assert row.payee_name == "Hotel Seri Kenanga"
    assert row.employee_name == "Aisyah"
