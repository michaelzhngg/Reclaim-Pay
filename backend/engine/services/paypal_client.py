"""
PayPal REST client for Payouts, webhook verification and "Log in with PayPal".

Payout requests are idempotent through `sender_batch_id`: PayPal rejects a reused
ID for 30 days, so a 5xx or timeout is retried once with the same ID.
"""
import base64
import hashlib
import logging
import time
from dataclasses import dataclass
from decimal import Decimal, ROUND_HALF_UP
from typing import Callable, Mapping
from uuid import UUID

import httpx

from core.config import settings
from core.enums import PayoutStatus

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class PayoutCreated:
    batch_id: str
    batch_status: str


@dataclass(frozen=True)
class PayoutItem:
    item_id: str
    transaction_status: str
    sender_item_id: str
    error: str | None


@dataclass(frozen=True)
class PayoutBatch:
    batch_id: str
    batch_status: str
    items: list[PayoutItem]


@dataclass(frozen=True)
class PayPalUser:
    payer_id: str
    email: str | None
    verified: bool
    verified_account: bool | None = None
    email_verified: bool | None = None


class PayPalError(Exception):
    def __init__(self, status: int, name: str | None = None, debug_id: str | None = None, message: str = ""):
        self.status = status
        self.name = name
        self.debug_id = debug_id
        super().__init__(f"PayPal {status} {name or ''} {message}".strip())


_ITEM_STATUS = {
    "SUCCESS": PayoutStatus.SUCCEEDED,
    "FAILED": PayoutStatus.FAILED,
    "DENIED": PayoutStatus.FAILED,
    "BLOCKED": PayoutStatus.FAILED,
    "RETURNED": PayoutStatus.REVERSED,
    "REFUNDED": PayoutStatus.REVERSED,
    "REVERSED": PayoutStatus.REVERSED,
    "CANCELED": PayoutStatus.CANCELLED,
}

_WEBHOOK_HEADERS = {
    "auth_algo": "paypal-auth-algo",
    "cert_url": "paypal-cert-url",
    "transmission_id": "paypal-transmission-id",
    "transmission_sig": "paypal-transmission-sig",
    "transmission_time": "paypal-transmission-time",
}


def sender_batch_id_for(reim_id: UUID, attempt: int) -> str:
    return f"RC-{reim_id.hex}-{attempt}"


def map_item_status(transaction_status: str) -> PayoutStatus:
    # UNCLAIMED, PENDING, ONHOLD and anything new are still in flight.
    return _ITEM_STATUS.get(transaction_status.upper(), PayoutStatus.REQUESTED)


def format_amount(amount: Decimal) -> str:
    return str(Decimal(amount).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def mask_email(email: str) -> str:
    local, _, domain = (email or "").partition("@")
    if not local or not domain:
        return "***"
    return f"{local[0]}***@{domain}"


def _payout_body(sender_batch_id: str, payer_id: str, amount: Decimal, currency: str,
                 note: str, sender_item_id: str) -> dict:
    return {
        "sender_batch_header": {
            "sender_batch_id": sender_batch_id,
            "email_subject": "You have a reimbursement from Reclaim Pay",
        },
        "items": [{
            "recipient_type": "PAYPAL_ID",
            "receiver": payer_id,
            "amount": {"value": format_amount(amount), "currency": currency},
            "note": note,
            "sender_item_id": sender_item_id,
        }],
    }


def _parse_batch(data: dict) -> PayoutBatch:
    header = data.get("batch_header", {})
    items = []
    for raw in data.get("items", []):
        error = raw.get("errors")
        items.append(PayoutItem(
            item_id=raw.get("payout_item_id", ""),
            transaction_status=raw.get("transaction_status", "PENDING"),
            sender_item_id=(raw.get("payout_item") or {}).get("sender_item_id", ""),
            error=(error.get("name") if isinstance(error, dict) else error) or None,
        ))
    return PayoutBatch(header.get("payout_batch_id", ""), header.get("batch_status", ""), items)


def _as_bool(value: object) -> bool:
    return value.lower() == "true" if isinstance(value, str) else bool(value)


def _parse_user(data: dict) -> PayPalUser:
    email = data.get("email")
    if not email:
        emails = data.get("emails") or []
        primary = next((e for e in emails if e.get("primary")), emails[0] if emails else None)
        email = primary.get("value") if primary else None
    verified_account = data.get("verified_account")
    email_verified = data.get("email_verified")
    return PayPalUser(
        payer_id=data.get("payer_id") or data.get("user_id", ""),
        email=email,
        verified=_as_bool(verified_account) or _as_bool(email_verified),
        verified_account=None if verified_account is None else _as_bool(verified_account),
        email_verified=None if email_verified is None else _as_bool(email_verified),
    )


class PayPalClient:
    def __init__(self, base_url: str, client_id: str, client_secret: str,
                 transport: httpx.AsyncBaseTransport | None = None):
        self._base_url = base_url.rstrip("/")
        self._client_id = client_id
        self._client_secret = client_secret
        self._transport = transport
        self._token: str | None = None
        self._token_expires_at = 0.0

    def _http(self) -> httpx.AsyncClient:
        return httpx.AsyncClient(base_url=self._base_url, timeout=30.0, transport=self._transport)

    @property
    def _basic_auth(self) -> str:
        return base64.b64encode(f"{self._client_id}:{self._client_secret}".encode()).decode()

    async def _oauth_token(self, data: dict) -> dict:
        async with self._http() as http:
            resp = await http.post(
                "/v1/oauth2/token", data=data,
                headers={"Authorization": f"Basic {self._basic_auth}", "Accept": "application/json"},
            )
        if resp.status_code >= 400:
            body = _json_or_empty(resp)
            raise PayPalError(resp.status_code, body.get("error") or body.get("name"), body.get("debug_id"))
        return resp.json()

    async def access_token(self) -> str:
        if self._token and time.monotonic() < self._token_expires_at:
            return self._token
        data = await self._oauth_token({"grant_type": "client_credentials"})
        self._token = data["access_token"]
        self._token_expires_at = time.monotonic() + int(data.get("expires_in", 0)) - 60
        return self._token

    async def request(self, method: str, path: str, json: dict | None = None,
                      headers: dict | None = None) -> dict:
        token = await self.access_token()
        req_headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json", **(headers or {})}
        for attempt in (1, 2):
            try:
                async with self._http() as http:
                    resp = await http.request(method, path, json=json, headers=req_headers)
            except httpx.TimeoutException:
                if attempt == 2:
                    raise PayPalError(504, "TIMEOUT")
                logger.warning("[PAYPAL] %s %s timed out, retrying once", method, path)
                continue
            if resp.status_code >= 500 and attempt == 1:
                logger.warning("[PAYPAL] %s %s returned %s, retrying once", method, path, resp.status_code)
                continue
            if resp.status_code >= 400:
                body = _json_or_empty(resp)
                raise PayPalError(resp.status_code, body.get("name"), body.get("debug_id"), body.get("message", ""))
            return _json_or_empty(resp)
        raise PayPalError(500, "RETRY_EXHAUSTED")

    async def create_payout(self, *, sender_batch_id: str, payer_id: str, amount: Decimal,
                            currency: str, note: str, sender_item_id: str) -> PayoutCreated:
        data = await self.request("POST", "/v1/payments/payouts",
                                  json=_payout_body(sender_batch_id, payer_id, amount, currency, note, sender_item_id))
        header = data.get("batch_header", {})
        return PayoutCreated(header.get("payout_batch_id", ""), header.get("batch_status", ""))

    async def get_payout_batch(self, batch_id: str) -> PayoutBatch:
        return _parse_batch(await self.request("GET", f"/v1/payments/payouts/{batch_id}"))

    async def cancel_payout_item(self, item_id: str) -> str:
        data = await self.request("POST", f"/v1/payments/payouts-item/{item_id}/cancel")
        return data.get("transaction_status", "")

    async def verify_webhook(self, headers: Mapping[str, str], event: dict, webhook_id: str) -> bool:
        lowered = {k.lower(): v for k, v in headers.items()}
        fields = {key: lowered.get(header) for key, header in _WEBHOOK_HEADERS.items()}
        if not all(fields.values()) or not webhook_id:
            return False
        data = await self.request("POST", "/v1/notifications/verify-webhook-signature",
                                  json={**fields, "webhook_id": webhook_id, "webhook_event": event})
        return data.get("verification_status") == "SUCCESS"

    async def exchange_auth_code(self, code: str) -> str:
        data = await self._oauth_token({"grant_type": "authorization_code", "code": code})
        return data["access_token"]

    async def get_userinfo(self, user_access_token: str) -> PayPalUser:
        headers = {"Authorization": f"Bearer {user_access_token}", "Accept": "application/json"}
        endpoint = "paypalv1.1"
        async with self._http() as http:
            resp = await http.get("/v1/identity/oauth2/userinfo", params={"schema": "paypalv1.1"}, headers=headers)
            if resp.status_code == 404:
                endpoint = "openid"
                resp = await http.get("/v1/identity/openidconnect/userinfo", params={"schema": "openid"},
                                      headers=headers)
        if resp.status_code >= 400:
            body = _json_or_empty(resp)
            raise PayPalError(resp.status_code, body.get("name") or body.get("error"), body.get("debug_id"))
        body = resp.json()
        logger.info(
            "[PAYPAL_USERINFO] endpoint=%s keys=%s verified_account=%r email_verified=%r payer_id=%s",
            endpoint, sorted(body.keys()), body.get("verified_account"), body.get("email_verified"),
            bool(body.get("payer_id") or body.get("user_id")),
        )
        return _parse_user(body)


class MockPayPalClient:
    """Stands in for PayPal when PAYPAL_MOCK_MODE=true: payouts succeed 8 seconds after creation."""

    SUCCESS_AFTER_SECONDS = 8

    def __init__(self, now: Callable[[], float] = time.monotonic):
        self._now = now
        self._batches: dict[str, tuple[float, str]] = {}

    async def access_token(self) -> str:
        return "MOCK-TOKEN"

    async def create_payout(self, *, sender_batch_id: str, payer_id: str, amount: Decimal,
                            currency: str, note: str, sender_item_id: str) -> PayoutCreated:
        batch_id = "MOCKB-" + hashlib.sha256(sender_batch_id.encode()).hexdigest()[:12].upper()
        self._batches.setdefault(batch_id, (self._now(), sender_item_id))
        return PayoutCreated(batch_id, "PENDING")

    async def get_payout_batch(self, batch_id: str) -> PayoutBatch:
        if batch_id not in self._batches:
            raise PayPalError(404, "RESOURCE_NOT_FOUND")
        created_at, sender_item_id = self._batches[batch_id]
        done = self._now() - created_at >= self.SUCCESS_AFTER_SECONDS
        item = PayoutItem("MOCKI-" + batch_id[6:], "SUCCESS" if done else "PENDING", sender_item_id, None)
        return PayoutBatch(batch_id, "SUCCESS" if done else "PENDING", [item])

    async def cancel_payout_item(self, item_id: str) -> str:
        return "CANCELED"

    async def verify_webhook(self, headers: Mapping[str, str], event: dict, webhook_id: str) -> bool:
        return True

    async def exchange_auth_code(self, code: str) -> str:
        return f"MOCK-USER-{code}"

    async def get_userinfo(self, user_access_token: str) -> PayPalUser:
        code = user_access_token.removeprefix("MOCK-USER-")
        payer_id = "MOCK" + hashlib.sha256(code.encode()).hexdigest()[:9].upper()
        return PayPalUser(payer_id=payer_id, email=f"{code[:12] or 'demo'}@sandbox.example", verified=True)


def _json_or_empty(resp: httpx.Response) -> dict:
    try:
        data = resp.json()
    except ValueError:
        return {}
    return data if isinstance(data, dict) else {}


_client: "PayPalClient | MockPayPalClient | None" = None


def get_paypal_client() -> "PayPalClient | MockPayPalClient":
    global _client
    if _client is None:
        if settings.PAYPAL_MOCK_MODE:
            _client = MockPayPalClient()
        else:
            _client = PayPalClient(settings.PAYPAL_BASE_URL, settings.PAYPAL_CLIENT_ID, settings.PAYPAL_CLIENT_SECRET)
    return _client
