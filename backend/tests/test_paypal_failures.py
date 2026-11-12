"""PayPal failure paths, faked with httpx.MockTransport using PayPal's documented error shapes.

The sandbox raises these on purpose when an item note holds a trigger value: ERRPYO005 gives
INSUFFICIENT_FUNDS and ERRPYO002 gives SENDER_EMAIL_UNCONFIRMED. The live test at the bottom
sends ERRPYO005 to the real sandbox and only runs with PAYPAL_SANDBOX_LIVE_TESTS=1.
"""
import asyncio
import json
import os
from datetime import datetime, timezone
from decimal import Decimal
from types import SimpleNamespace
from uuid import UUID, uuid4

import httpx
import pytest

from core.config import settings
from core.enums import PayoutStatus, ReimbursementStatus
from engine.services import payout_service, payout_status
from engine.services.paypal_client import (
    PayPalClient,
    PayPalError,
    map_item_status,
    parse_balance,
    sender_batch_id_for,
)

BASE = "https://api-m.sandbox.paypal.com"
RID = UUID("12345678-1234-5678-1234-567812345678")
UID = UUID("87654321-4321-8765-4321-876543218765")
HR_ID = UUID("11111111-2222-3333-4444-555555555555")

INSUFFICIENT_FUNDS = {
    "name": "INSUFFICIENT_FUNDS",
    "message": "Sender does not have sufficient funds. Please add funds and retry.",
    "debug_id": "dbg-funds",
    "information_link": "https://developer.paypal.com/docs/api/payments.payouts-batch/#errors",
    "links": [],
}


def paypal(routes: dict[tuple[str, str], httpx.Response]):
    """A PayPalClient whose HTTP goes to `routes`, keyed by (method, path). The token call always succeeds."""
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if request.url.path == "/v1/oauth2/token":
            return httpx.Response(200, json={"access_token": "T", "expires_in": 3600})
        return routes.get((request.method, request.url.path), httpx.Response(404, json={"name": "RESOURCE_NOT_FOUND"}))

    return PayPalClient(BASE, "cid", "secret", transport=httpx.MockTransport(handler)), seen


def failed_batch(error_name: str) -> dict:
    return {
        "batch_header": {"payout_batch_id": "B1", "batch_status": "SUCCESS"},
        "items": [{
            "payout_item_id": "I1",
            "transaction_status": "FAILED",
            "payout_batch_id": "B1",
            "payout_item": {"recipient_type": "PAYPAL_ID", "receiver": "PAYERID123",
                            "amount": {"value": "48.00", "currency": "MYR"},
                            "note": "ERRPYO005", "sender_item_id": str(RID)},
            "errors": {"name": error_name, "message": "Payout failed", "details": [], "links": []},
        }],
    }


# --- create_payout rejected -------------------------------------------------------------------------

async def test_create_payout_rejected_with_insufficient_funds():
    client, seen = paypal({("POST", "/v1/payments/payouts"): httpx.Response(422, json=INSUFFICIENT_FUNDS)})
    with pytest.raises(PayPalError) as e:
        await client.create_payout(sender_batch_id=sender_batch_id_for(RID, 1), payer_id="PAYERID123",
                                   amount=Decimal("48"), currency="MYR", note="ERRPYO005", sender_item_id=str(RID))
    assert (e.value.status, e.value.name, e.value.debug_id) == (422, "INSUFFICIENT_FUNDS", "dbg-funds")
    # A 4xx is final: no retry that could create a second batch.
    assert sum(r.url.path == "/v1/payments/payouts" for r in seen) == 1


class _RollbackDB:
    def __init__(self):
        self.rolled_back = False

    def rollback(self):
        self.rolled_back = True


async def test_rejected_payout_leaves_the_claim_for_hr_retry(monkeypatch):
    client, _ = paypal({("POST", "/v1/payments/payouts"): httpx.Response(422, json=INSUFFICIENT_FUNDS)})
    reim = SimpleNamespace(reim_id=RID, user_id=UID, status=ReimbursementStatus.APPROVED)
    employee = SimpleNamespace(paypal_payer_id="PAYERID123")
    monkeypatch.setattr(payout_service, "_plan", lambda reim_id, db: (reim, employee, ("CREATE", Decimal("48"), 1), []))
    monkeypatch.setattr(payout_service, "_mark_disbursing", lambda db, r: None)
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: client)
    saved = []
    monkeypatch.setattr(payout_service, "_save_payout", lambda *a, **k: saved.append(a))
    db = _RollbackDB()

    assert await payout_service.initiate_payout_async(RID, db) is None
    assert db.rolled_back and saved == []


# --- batch item comes back FAILED ---------------------------------------------------------------------

class _StatusDB:
    """Just enough of a Session for apply_item_update: one claim and one HR user."""

    def __init__(self, reim):
        self.reim = reim
        self.committed = False

    def get(self, model, key):
        return self.reim if key == self.reim.reim_id else None

    def exec(self, query):
        return SimpleNamespace(all=lambda: [SimpleNamespace(user_id=HR_ID)])

    def add(self, obj):
        pass

    def commit(self):
        self.committed = True

    def refresh(self, obj):
        pass


@pytest.mark.parametrize("error_name", ["INSUFFICIENT_FUNDS", "SENDER_EMAIL_UNCONFIRMED"])
async def test_failed_batch_item_marks_payout_failed_and_claim_disbursement_failed(monkeypatch, error_name):
    client, _ = paypal({("GET", "/v1/payments/payouts/B1"): httpx.Response(200, json=failed_batch(error_name))})
    batch = await client.get_payout_batch("B1")
    item = batch.items[0]
    assert (item.transaction_status, item.error, item.sender_item_id) == ("FAILED", error_name, str(RID))
    assert map_item_status(item.transaction_status) == PayoutStatus.FAILED
    assert payout_status.reim_status_for(PayoutStatus.FAILED) == ReimbursementStatus.DISBURSEMENT_FAILED

    now = datetime(2026, 11, 12, 9, tzinfo=timezone.utc)
    payout = SimpleNamespace(reim_id=RID, user_id=UID, amount=Decimal("48.00"), currency="MYR",
                             status=PayoutStatus.ACCEPTED, provider_batch_id="B1", provider_item_id=None,
                             failure_code=None, updated_at=now)
    reim = SimpleNamespace(reim_id=RID, status=ReimbursementStatus.DISBURSING, updated_at=now)
    notes = []
    monkeypatch.setattr(payout_status, "get_paypal_client", lambda: client)
    monkeypatch.setattr(payout_status, "_find_payout", lambda db, item_id, sender_item_id: payout)
    monkeypatch.setattr(payout_status, "record_action", lambda *a, **k: None)
    monkeypatch.setattr(payout_status, "notify", lambda db, user_id, n_type, title, message, link=None, email=False:
                        notes.append((user_id, n_type, message)))
    db = _StatusDB(reim)

    await payout_status.refresh_payout(db, payout)

    assert payout.status == PayoutStatus.FAILED and payout.failure_code == error_name
    assert payout.provider_item_id == "I1"
    assert reim.status == ReimbursementStatus.DISBURSEMENT_FAILED and db.committed
    # HR sees PayPal's reason in the alert, not only "FAILED".
    hr_note = next(n for n in notes if n[0] == HR_ID)
    assert hr_note[1] == "error" and error_name in hr_note[2]


# --- get_balance --------------------------------------------------------------------------------------

BALANCES = {
    "balances": [
        {"currency": "USD", "primary": True,
         "total_balance": {"currency_code": "USD", "value": "900.00"},
         "available_balance": {"currency_code": "USD", "value": "880.00"},
         "withheld_balance": {"currency_code": "USD", "value": "20.00"}},
        {"currency": "MYR", "primary": False,
         "total_balance": {"currency_code": "MYR", "value": "1300.50"},
         "available_balance": {"currency_code": "MYR", "value": "1240.00"},
         "withheld_balance": {"currency_code": "MYR", "value": "60.50"}},
    ],
    "account_id": "ACCT123",
    "as_of_time": "2026-11-12T08:00:00Z",
    "last_refresh_time": "2026-11-12T07:59:00Z",
}


async def test_get_balance_parses_the_available_balance():
    client, seen = paypal({("GET", "/v1/reporting/balances"): httpx.Response(200, json=BALANCES)})
    balance = await client.get_balance("myr")
    assert balance.currency == "MYR"
    assert balance.available == Decimal("1240.00") and isinstance(balance.available, Decimal)
    assert balance.as_of == datetime(2026, 11, 12, 8, tzinfo=timezone.utc)
    assert seen[-1].url.params["currency_code"] == "MYR"


def test_balance_picks_the_payout_currency_not_the_primary_one():
    assert parse_balance(BALANCES, "USD").available == Decimal("880.00")
    assert parse_balance(BALANCES, "MYR").available == Decimal("1240.00")


def test_balance_in_a_currency_the_account_does_not_hold_is_none_not_zero():
    assert parse_balance(BALANCES, "SGD") is None
    assert parse_balance({}, "MYR") is None


@pytest.mark.parametrize("value", ["NaN", "Infinity", "-Infinity", "sNaN", "abc", None])
def test_balance_with_an_unreadable_amount_raises(value):
    data = {"balances": [{"currency": "MYR", "available_balance": {"currency_code": "MYR", "value": value}}]}
    with pytest.raises(ValueError):
        parse_balance(data, "MYR")


async def test_get_balance_for_a_currency_not_held_returns_none():
    client, _ = paypal({("GET", "/v1/reporting/balances"): httpx.Response(200, json=BALANCES)})
    assert await client.get_balance("SGD") is None


def test_balance_falls_back_to_total_when_available_is_missing():
    data = {"balances": [{"currency": "MYR", "total_balance": {"currency_code": "MYR", "value": "75.10"}}]}
    assert parse_balance(data, "MYR").available == Decimal("75.10")


# Exactly what the project's sandbox app returns: its token has the payouts scope but not reporting.
NOT_AUTHORIZED = {"name": "NOT_AUTHORIZED", "message": "Authorization failed due to insufficient permissions.",
                  "debug_id": "f3a8c2b1d4e5"}


async def test_get_balance_without_permission_raises_paypal_error():
    client, _ = paypal({("GET", "/v1/reporting/balances"): httpx.Response(403, json=NOT_AUTHORIZED)})
    with pytest.raises(PayPalError) as e:
        await client.get_balance("MYR")
    assert (e.value.status, e.value.name, e.value.debug_id) == (403, "NOT_AUTHORIZED", "f3a8c2b1d4e5")


async def test_balance_403_tells_hr_to_tick_transaction_search(monkeypatch):
    from engine.services import funding_service as fs
    client, _ = paypal({("GET", "/v1/reporting/balances"): httpx.Response(403, json=NOT_AUTHORIZED)})
    monkeypatch.setattr(fs.settings, "PAYPAL_MOCK_MODE", False)
    monkeypatch.setattr(fs.settings, "PAYPAL_CLIENT_ID", "cid")
    monkeypatch.setattr(fs.settings, "PAYPAL_CLIENT_SECRET", "secret")
    monkeypatch.setattr(fs, "get_paypal_client", lambda: client)
    balance, reason = await fs._fetch_balance("MYR")
    assert (balance, reason) == (None, "permission")
    s = fs.build_funding(currency="MYR", balance=None, payout_amounts=[], committed=Decimal("0"),
                         threshold_days=3, now=datetime(2026, 11, 12, tzinfo=timezone.utc), reason=reason)
    assert s.status == "unavailable" and '"Transaction search"' in s.message and "Tick" in s.message


# --- live sandbox (opt-in) ----------------------------------------------------------------------------

_LIVE = os.environ.get("PAYPAL_SANDBOX_LIVE_TESTS") == "1"
_RECEIVER = os.environ.get("PAYPAL_SANDBOX_RECEIVER_PAYER_ID") or os.environ.get("DEMO_PAYER_ID_1", "")


@pytest.mark.skipif(
    not (_LIVE and settings.PAYPAL_CLIENT_ID and settings.PAYPAL_CLIENT_SECRET and _RECEIVER
         and "sandbox" in settings.PAYPAL_BASE_URL),
    reason="Live sandbox test: set PAYPAL_SANDBOX_LIVE_TESTS=1, sandbox PayPal credentials and "
           "PAYPAL_SANDBOX_RECEIVER_PAYER_ID (or DEMO_PAYER_ID_1)",
)
async def test_live_sandbox_errpyo005_returns_insufficient_funds():
    client = PayPalClient(settings.PAYPAL_BASE_URL, settings.PAYPAL_CLIENT_ID, settings.PAYPAL_CLIENT_SECRET)
    reim_id = uuid4()
    try:
        created = await client.create_payout(
            sender_batch_id=f"RC-test-{reim_id.hex}", payer_id=_RECEIVER, amount=Decimal("1.00"),
            currency=settings.PAYPAL_CURRENCY, note="ERRPYO005", sender_item_id=str(reim_id),
        )
    except PayPalError as e:
        # PayPal may refuse the whole batch up front.
        assert e.name == "INSUFFICIENT_FUNDS"
        return
    # Or accept the batch and fail the item a few seconds later.
    item = None
    for _ in range(10):
        batch = await client.get_payout_batch(created.batch_id)
        item = batch.items[0] if batch.items else None
        if item and map_item_status(item.transaction_status) != PayoutStatus.REQUESTED:
            break
        await asyncio.sleep(3)
    assert item is not None, json.dumps({"batch": created.batch_id})
    assert map_item_status(item.transaction_status) == PayoutStatus.FAILED
    assert item.error == "INSUFFICIENT_FUNDS"
