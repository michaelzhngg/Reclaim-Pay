import json
from decimal import Decimal
from uuid import UUID

import httpx
import pytest
import respx

from core.enums import PayoutStatus
from engine.services.paypal_client import (
    MockPayPalClient,
    PayPalClient,
    PayPalError,
    format_amount,
    map_item_status,
    sender_batch_id_for,
)

BASE = "https://api-m.sandbox.paypal.com"
RID = UUID("12345678-1234-5678-1234-567812345678")


def client():
    return PayPalClient(BASE, "cid", "secret")


def token_route(mock):
    return mock.post(f"{BASE}/v1/oauth2/token").mock(
        return_value=httpx.Response(200, json={"access_token": "T", "expires_in": 3600}))


def test_sender_batch_id_format():
    assert sender_batch_id_for(RID, 2) == "RC-12345678123456781234567812345678-2"


def test_format_amount():
    assert format_amount(Decimal("48")) == "48.00"
    assert format_amount(Decimal("12.345")) == "12.35"


@pytest.mark.parametrize("raw,expected", [("SUCCESS", "SUCCEEDED"), ("FAILED", "FAILED"), ("DENIED", "FAILED"),
    ("BLOCKED", "FAILED"), ("UNCLAIMED", "REQUESTED"), ("PENDING", "REQUESTED"), ("ONHOLD", "REQUESTED"),
    ("RETURNED", "REVERSED"), ("REFUNDED", "REVERSED"), ("REVERSED", "REVERSED"), ("CANCELED", "CANCELLED"),
    ("SOMETHING_NEW", "REQUESTED")])
def test_map_item_status(raw, expected):
    assert map_item_status(raw) == PayoutStatus(expected)


@respx.mock
async def test_token_is_cached():
    route = token_route(respx)
    c = client(); await c.access_token(); await c.access_token()
    assert route.call_count == 1


@respx.mock
async def test_create_payout_payload_and_result():
    token_route(respx)
    payout = respx.post(f"{BASE}/v1/payments/payouts").mock(return_value=httpx.Response(
        201, json={"batch_header": {"payout_batch_id": "B1", "batch_status": "PENDING"}}))
    res = await client().create_payout(sender_batch_id=sender_batch_id_for(RID, 1), payer_id="PAYERID123",
                                       amount=Decimal("48"), currency="MYR", note="RC-12345678", sender_item_id=str(RID))
    body = json.loads(payout.calls[0].request.content)
    assert body["sender_batch_header"]["sender_batch_id"] == "RC-12345678123456781234567812345678-1"
    assert body["items"][0] == {"recipient_type": "PAYPAL_ID", "receiver": "PAYERID123",
                                "amount": {"value": "48.00", "currency": "MYR"}, "note": "RC-12345678",
                                "sender_item_id": str(RID)}
    assert (res.batch_id, res.batch_status) == ("B1", "PENDING")


@respx.mock
async def test_5xx_retried_once_with_same_batch_id():
    token_route(respx)
    route = respx.post(f"{BASE}/v1/payments/payouts").mock(side_effect=[
        httpx.Response(503), httpx.Response(201, json={"batch_header": {"payout_batch_id": "B1", "batch_status": "PENDING"}})])
    await client().create_payout(sender_batch_id="RC-x-1", payer_id="P", amount=Decimal("1"), currency="MYR",
                                 note="n", sender_item_id="s")
    ids = [json.loads(c.request.content)["sender_batch_header"]["sender_batch_id"] for c in route.calls]
    assert ids == ["RC-x-1", "RC-x-1"]


@respx.mock
async def test_second_5xx_raises():
    token_route(respx)
    respx.post(f"{BASE}/v1/payments/payouts").mock(return_value=httpx.Response(500))
    with pytest.raises(PayPalError) as e:
        await client().create_payout(sender_batch_id="RC-x-1", payer_id="P", amount=Decimal("1"),
                                     currency="MYR", note="n", sender_item_id="s")
    assert e.value.status == 500


@respx.mock
async def test_4xx_raises_paypal_error():
    token_route(respx)
    respx.post(f"{BASE}/v1/payments/payouts").mock(return_value=httpx.Response(
        400, json={"name": "VALIDATION_ERROR", "debug_id": "dbg1"}))
    with pytest.raises(PayPalError) as e:
        await client().create_payout(sender_batch_id="RC-x-1", payer_id="P", amount=Decimal("1"),
                                     currency="MYR", note="n", sender_item_id="s")
    assert (e.value.status, e.value.name, e.value.debug_id) == (400, "VALIDATION_ERROR", "dbg1")


@respx.mock
async def test_get_payout_batch_parses_items():
    token_route(respx)
    respx.get(f"{BASE}/v1/payments/payouts/B1").mock(return_value=httpx.Response(200, json={
        "batch_header": {"payout_batch_id": "B1", "batch_status": "SUCCESS"},
        "items": [{"payout_item_id": "I1", "transaction_status": "SUCCESS",
                   "payout_item": {"sender_item_id": str(RID)}}]}))
    batch = await client().get_payout_batch("B1")
    assert batch.batch_status == "SUCCESS"
    assert batch.items[0].item_id == "I1" and batch.items[0].sender_item_id == str(RID)
    assert batch.items[0].error is None


@respx.mock
async def test_verify_webhook_success_and_failure():
    token_route(respx)
    route = respx.post(f"{BASE}/v1/notifications/verify-webhook-signature").mock(side_effect=[
        httpx.Response(200, json={"verification_status": "SUCCESS"}),
        httpx.Response(200, json={"verification_status": "FAILURE"})])
    headers = {"paypal-auth-algo": "SHA256withRSA", "paypal-cert-url": "https://c", "paypal-transmission-id": "t1",
               "paypal-transmission-sig": "sig", "paypal-transmission-time": "2026-11-03T10:00:00Z"}
    assert await client().verify_webhook(headers, {"id": "WH-1"}, "WEBHOOK_ID") is True
    assert await client().verify_webhook(headers, {"id": "WH-1"}, "WEBHOOK_ID") is False
    sent = json.loads(route.calls[0].request.content)
    assert sent["transmission_id"] == "t1" and sent["webhook_id"] == "WEBHOOK_ID" and sent["webhook_event"] == {"id": "WH-1"}


@respx.mock
async def test_verify_webhook_missing_headers_is_false():
    token_route(respx)
    assert await client().verify_webhook({}, {"id": "WH-1"}, "WEBHOOK_ID") is False


@respx.mock
async def test_userinfo_parses_payer_and_verified_string():
    respx.get(url__startswith=f"{BASE}/v1/identity/oauth2/userinfo").mock(return_value=httpx.Response(200, json={
        "payer_id": "P1", "emails": [{"value": "a@b.com", "primary": True}], "verified_account": "true"}))
    u = await client().get_userinfo("USER_TOKEN")
    assert (u.payer_id, u.email, u.verified) == ("P1", "a@b.com", True)


@respx.mock
async def test_userinfo_falls_back_to_openid_on_404():
    respx.get(url__startswith=f"{BASE}/v1/identity/oauth2/userinfo").mock(return_value=httpx.Response(404))
    respx.get(url__startswith=f"{BASE}/v1/identity/openidconnect/userinfo").mock(return_value=httpx.Response(200, json={
        "payer_id": "P2", "email": "c@d.com", "verified_account": False}))
    u = await client().get_userinfo("USER_TOKEN")
    assert (u.payer_id, u.email, u.verified) == ("P2", "c@d.com", False)


@respx.mock
async def test_userinfo_accepts_openid_email_verified():
    respx.get(url__startswith=f"{BASE}/v1/identity/oauth2/userinfo").mock(return_value=httpx.Response(404))
    respx.get(url__startswith=f"{BASE}/v1/identity/openidconnect/userinfo").mock(return_value=httpx.Response(200, json={
        "payer_id": "P3", "email": "e@f.com", "email_verified": True}))
    u = await client().get_userinfo("USER_TOKEN")
    assert (u.payer_id, u.email, u.verified) == ("P3", "e@f.com", True)


@respx.mock
async def test_userinfo_accepts_email_verified_when_account_flag_is_false():
    respx.get(url__startswith=f"{BASE}/v1/identity/oauth2/userinfo").mock(return_value=httpx.Response(200, json={
        "payer_id": "P4", "email": "g@h.com", "verified_account": False, "email_verified": True}))
    u = await client().get_userinfo("USER_TOKEN")
    assert (u.payer_id, u.email, u.verified) == ("P4", "g@h.com", True)


async def test_mock_client_succeeds_after_delay():
    clock = [1000.0]
    mock = MockPayPalClient(now=lambda: clock[0])
    created = await mock.create_payout(sender_batch_id="RC-x-1", payer_id="P", amount=Decimal("48"),
                                       currency="MYR", note="n", sender_item_id=str(RID))
    assert created.batch_status == "PENDING"
    assert (await mock.get_payout_batch(created.batch_id)).items[0].transaction_status == "PENDING"
    clock[0] += 8
    batch = await mock.get_payout_batch(created.batch_id)
    assert batch.items[0].transaction_status == "SUCCESS" and batch.items[0].sender_item_id == str(RID)
