import hashlib
import hmac
import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import quote, urlencode
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import RedirectResponse
from jose import jwt, JWTError
from pydantic import BaseModel
from sqlmodel import Session, select

from api import deps
from api.rate_limit import limiter
from core import security
from core.config import settings
from core.enums import AgentActionType
from core.models import User
from engine.services.action_log import record_action
from engine.services.payout_service import notify
from engine.services.paypal_client import PayPalError, PayPalUser, get_paypal_client, mask_email  # noqa: F401
from engine.services.payout_status import apply_item_update, next_status, reim_status_for  # noqa: F401
from engine.services.recovery_service import mark_recovered

router = APIRouter()
logger = logging.getLogger(__name__)

# Mirrors AutonomyConfig.payee_cooldown_hours until the autonomy store exists.
PAYEE_COOLDOWN_HOURS = 72
_STATE_TTL = timedelta(minutes=10)
_STATE_PURPOSE = "paypal_link"
_SIGNIN_STATE_PURPOSE = "paypal_signin"
_SIGNIN_FAILED = "PayPal sign-in failed"
MOCK_SIGNIN_CODE = "mock-signin"
_SCOPE = "openid email https://uri.paypal.com/services/paypalattributes"


def make_state(user_id: UUID, secret: str, now: datetime) -> str:
    claims = {"sub": str(user_id), "purpose": _STATE_PURPOSE, "exp": int((now + _STATE_TTL).timestamp())}
    return jwt.encode(claims, secret, algorithm="HS256")


def _read_state_claims(token: str, secret: str, now: datetime, purpose: str) -> dict:
    try:
        # Expiry is checked against `now` below so tests and callers control the clock.
        claims = jwt.decode(token, secret, algorithms=["HS256"], options={"verify_exp": False})
    except JWTError as e:
        raise ValueError("invalid state") from e
    if claims.get("purpose") != purpose:
        raise ValueError("wrong state purpose")
    if int(claims.get("exp", 0)) < now.timestamp():
        raise ValueError("state expired")
    return claims


def read_state(token: str, secret: str, now: datetime) -> UUID:
    claims = _read_state_claims(token, secret, now, _STATE_PURPOSE)
    try:
        return UUID(claims["sub"])
    except (KeyError, ValueError) as e:
        raise ValueError("invalid state subject") from e


def _binding_hash(binding: str) -> str:
    return hashlib.sha256(binding.encode()).hexdigest()


def make_signin_state(binding: str, secret: str, now: datetime) -> str:
    # The state travels through PayPal and browser history, so it holds only a hash of the browser's cookie value.
    claims = {
        "purpose": _SIGNIN_STATE_PURPOSE,
        "binding": _binding_hash(binding),
        "exp": int((now + _STATE_TTL).timestamp()),
    }
    return jwt.encode(claims, secret, algorithm="HS256")


def read_signin_state(token: str, binding: str, secret: str, now: datetime) -> None:
    claims = _read_state_claims(token, secret, now, _SIGNIN_STATE_PURPOSE)
    if not binding or not hmac.compare_digest(_binding_hash(binding), str(claims.get("binding", ""))):
        raise ValueError("state not bound to this browser")


def link_update(current_payer_id: str | None, ever_linked: bool, user: PayPalUser, now: datetime) -> dict:
    update = {
        "paypal_payer_id": user.payer_id,
        "paypal_email": user.email,
        "paypal_verified": user.verified,
        "paypal_linked_at": now,
    }
    if current_payer_id == user.payer_id:
        return update
    # Any change after the first link (including unlink, then link another account) pauses auto-pay.
    update["payout_destination_changed_at"] = now if ever_linked else None
    return update


def cooldown_until(changed_at: datetime | None, hours: int) -> datetime | None:
    return changed_at + timedelta(hours=hours) if changed_at else None


def build_connect_url(web_url: str, client_id: str, redirect_uri: str, state: str) -> str:
    query = urlencode({
        "flowEntry": "static",
        "client_id": client_id,
        "response_type": "code",
        "scope": _SCOPE,
        "redirect_uri": redirect_uri,
        "state": state,
    }, quote_via=quote)
    return f"{web_url.rstrip('/')}/connect?{query}"


def _callback_url() -> str:
    return f"{settings.BACKEND_PUBLIC_URL.rstrip('/')}{settings.API_V1_STR}/paypal/callback"


def _signin_callback_url() -> str:
    # Next.js owns this URL: only it can set the HttpOnly session cookie on the frontend's origin.
    return f"{settings.FRONTEND_PUBLIC_URL.rstrip('/')}/login/paypal/callback"


def _settings_redirect(result: str) -> RedirectResponse:
    return RedirectResponse(f"{settings.FRONTEND_PUBLIC_URL.rstrip('/')}/employee/settings?paypal={result}",
                            status_code=302)


class PayPalStatus(BaseModel):
    linked: bool
    email_masked: Optional[str] = None
    verified: bool
    linked_at: Optional[datetime] = None
    cooldown_until: Optional[datetime] = None
    link_changes_paused_until: Optional[datetime] = None


class SigninStart(BaseModel):
    url: str
    binding: str


class SigninComplete(BaseModel):
    code: str
    state: str
    binding: str


class SigninSession(BaseModel):
    access_token: str
    token_type: str = "bearer"
    expires_in: int


@router.get("/connect-url", dependencies=[Depends(deps.require_payout_changes_allowed)])
def get_connect_url(current_user: User = Depends(deps.get_current_user)):
    state = make_state(current_user.user_id, settings.SECRET_KEY, datetime.now(timezone.utc))
    if settings.PAYPAL_MOCK_MODE:
        # No PayPal login page in mock mode: go straight to our callback with a fake code.
        code = f"mock-{current_user.user_id.hex[:8]}"
        return {"url": f"{_callback_url()}?{urlencode({'code': code, 'state': state})}"}
    return {"url": build_connect_url(settings.PAYPAL_WEB_URL, settings.PAYPAL_CLIENT_ID, _callback_url(), state)}


@router.get("/callback")
async def paypal_callback(
    code: str | None = None,
    state: str | None = None,
    db: Session = Depends(deps.get_db),
):
    now = datetime.now(timezone.utc)
    try:
        user_id = read_state(state or "", settings.SECRET_KEY, now)
    except ValueError:
        logger.warning("[PAYPAL_LINK] Rejected callback with invalid or expired state")
        return _settings_redirect("error")

    employee = db.get(User, user_id)
    if not employee:
        return _settings_redirect("error")

    def failed(reason: str, **detail):
        # Only reached with a valid signed state, so anonymous traffic can't write to the action log.
        record_action(db, AgentActionType.PAYEE_LINK_FAILED, str(user_id), None, {"reason": reason, **detail})
        return _settings_redirect("error")

    if not code:
        return failed("no_code")
    client = get_paypal_client()
    try:
        paypal_user = await client.get_userinfo(await client.exchange_auth_code(code))
    except PayPalError as err:
        logger.exception("[PAYPAL_LINK] Code exchange or userinfo failed for user=%s", user_id)
        return failed("paypal_error", status=err.status, error=err.name, debug_id=err.debug_id)
    if not paypal_user.payer_id:
        return failed("no_payer_id")

    taken = db.exec(
        select(User).where(User.paypal_payer_id == paypal_user.payer_id, User.user_id != user_id)
    ).first()
    if taken:
        logger.warning("[PAYPAL_LINK] Payer already linked to another employee; user=%s", user_id)
        return failed("payer_already_linked")

    update = link_update(employee.paypal_payer_id, employee.paypal_linked_at is not None, paypal_user, now)
    for field, value in update.items():
        setattr(employee, field, value)
    db.add(employee)
    db.commit()

    changed = update.get("payout_destination_changed_at") is not None
    record_action(db, AgentActionType.PAYEE_LINKED, str(user_id), None, {
        "email": mask_email(paypal_user.email or ""),
        "verified": paypal_user.verified,
        "changed": changed,
    })
    if changed:
        until = cooldown_until(now, PAYEE_COOLDOWN_HOURS)
        notify(
            db, user_id, "warning", "Your payout account changed",
            f"Your payout account changed. Instant payouts are paused until {until:%d %b %Y %H:%M} UTC. "
            "If this wasn't you, contact HR.",
            link="/employee/settings",
        )
    return _settings_redirect("linked")


@router.get("/signin/start", response_model=SigninStart)
@limiter.limit("10/minute")
def signin_start(request: Request):
    binding = secrets.token_urlsafe(32)
    state = make_signin_state(binding, settings.SECRET_KEY, datetime.now(timezone.utc))
    if settings.PAYPAL_MOCK_MODE:
        query = urlencode({"code": MOCK_SIGNIN_CODE, "state": state})
        return SigninStart(url=f"{_signin_callback_url()}?{query}", binding=binding)
    if not settings.PAYPAL_CLIENT_ID:
        raise HTTPException(status_code=503, detail=_SIGNIN_FAILED)
    url = build_connect_url(settings.PAYPAL_WEB_URL, settings.PAYPAL_CLIENT_ID, _signin_callback_url(), state)
    return SigninStart(url=url, binding=binding)


async def _signin_identity(code: str) -> PayPalUser | None:
    if settings.PAYPAL_MOCK_MODE:
        # The fake PayPal's answer never comes from the request, so no code can pick a payer ID to sign in as.
        if code != MOCK_SIGNIN_CODE or not settings.PAYPAL_MOCK_SIGNIN_PAYER_ID:
            return None
        return PayPalUser(payer_id=settings.PAYPAL_MOCK_SIGNIN_PAYER_ID, email=None, verified=True)
    client = get_paypal_client()
    return await client.get_userinfo(await client.exchange_auth_code(code))


@router.post("/signin/complete", response_model=SigninSession)
@limiter.limit("10/minute")
async def signin_complete(request: Request, body: SigninComplete, db: Session = Depends(deps.get_db)):
    """Every failure answers the same way, so a caller can't learn which payer IDs or accounts exist."""
    failed = HTTPException(status_code=401, detail=_SIGNIN_FAILED)
    now = datetime.now(timezone.utc)
    try:
        read_signin_state(body.state, body.binding, settings.SECRET_KEY, now)
    except ValueError:
        logger.warning("[PAYPAL_SIGNIN] Rejected invalid, expired or unbound state")
        raise failed
    try:
        identity = await _signin_identity(body.code)
    except PayPalError:
        logger.exception("[PAYPAL_SIGNIN] Code exchange or userinfo failed")
        raise failed
    if not identity or not identity.payer_id:
        raise failed

    # The lookup is by payer ID alone, not role, so a payer ID shared with an HR user is refused outright.
    matches = db.exec(select(User).where(User.paypal_payer_id == identity.payer_id)).all()
    user = matches[0] if len(matches) == 1 else None
    if user is None:
        reason = "ambiguous_payer" if matches else "unknown_payer"
    elif not identity.verified and not (
        settings.PAYPAL_ALLOW_UNVERIFIED_SANDBOX
        and settings.PAYPAL_BASE_URL.startswith("https://api-m.sandbox")
        and bool(user.paypal_verified)
    ):
        reason = "paypal_not_verified"
    else:
        reason = security.paypal_signin_rejection(user, identity.payer_id)
    if reason:
        actor = str(user.user_id) if user else "unknown"
        record_action(db, AgentActionType.PAYPAL_SIGNIN, actor, None, {
            "outcome": "rejected", "reason": reason,
            "verified": identity.verified,
            "verified_account": identity.verified_account,
            "email_verified": identity.email_verified,
        })
        raise failed

    lifetime = timedelta(hours=PAYEE_COOLDOWN_HOURS)
    token = security.create_access_token(
        subject=user.email,
        expires_delta=lifetime,
        extra_claims={"auth_method": security.PAYPAL_AUTH_METHOD, "paypal_payer_id": identity.payer_id},
    )
    until = cooldown_until(now, PAYEE_COOLDOWN_HOURS)
    record_action(db, AgentActionType.PAYPAL_SIGNIN, str(user.user_id), None, {
        "outcome": "signed_in",
        "link_changes_paused_until": until,
        "verification": "paypal" if identity.verified else "seeded_sandbox",
    })
    notify(
        db, user.user_id, "warning", "New sign-in with PayPal",
        "Someone signed in to your account with PayPal. That session can't change your payout account, "
        f"and it ends {until:%d %b %Y %H:%M} UTC. If this wasn't you, sign in with your password, "
        "unlink PayPal in Settings and contact HR.",
        link="/employee/settings",
    )
    return SigninSession(access_token=token, expires_in=int(lifetime.total_seconds()))


@router.get("/status", response_model=PayPalStatus)
def paypal_status(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
    claims: dict = Depends(deps.get_session_claims),
):
    employee = db.get(User, current_user.user_id)
    until = cooldown_until(employee.payout_destination_changed_at, PAYEE_COOLDOWN_HOURS)
    if until and until <= datetime.now(timezone.utc):
        until = None
    return PayPalStatus(
        linked=bool(employee.paypal_payer_id),
        email_masked=mask_email(employee.paypal_email) if employee.paypal_email else None,
        verified=bool(employee.paypal_payer_id and employee.paypal_verified),
        linked_at=employee.paypal_linked_at,
        cooldown_until=until,
        link_changes_paused_until=deps.payout_changes_paused_until(claims),
    )


@router.delete("/link", status_code=204, dependencies=[Depends(deps.require_payout_changes_allowed)])
def unlink_paypal(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
):
    employee = db.get(User, current_user.user_id)
    # paypal_linked_at is kept so that linking a different account later still counts as a change.
    employee.paypal_payer_id = None
    employee.paypal_email = None
    employee.paypal_verified = False
    db.add(employee)
    db.commit()
    return Response(status_code=204)


@router.post("/webhook")
async def paypal_webhook(request: Request, db: Session = Depends(deps.get_db)):
    """PayPal webhook receiver. Every event is verified with PayPal unless mock mode is on."""
    try:
        event = await request.json()
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    if not settings.PAYPAL_MOCK_MODE:
        try:
            verified = await get_paypal_client().verify_webhook(request.headers, event, settings.PAYPAL_WEBHOOK_ID)
        except PayPalError:
            logger.exception("[PAYPAL_WEBHOOK] Signature verification call failed")
            verified = False
        if not verified:
            logger.warning("[PAYPAL_WEBHOOK] Rejected event id=%s: signature not verified", event.get("id"))
            raise HTTPException(status_code=400, detail="Webhook signature not verified")

    event_type = event.get("event_type", "")
    resource = event.get("resource") or {}
    logger.info("[PAYPAL_WEBHOOK] Received %s id=%s", event_type, event.get("id"))

    if event_type.startswith("PAYMENT.PAYOUTS-ITEM."):
        errors = resource.get("errors")
        apply_item_update(
            db,
            resource.get("payout_item_id"),
            (resource.get("payout_item") or {}).get("sender_item_id"),
            resource.get("transaction_status", ""),
            errors.get("name") if isinstance(errors, dict) else None,
        )
    elif event_type == "INVOICING.INVOICE.PAID":
        mark_recovered(db, resource.get("id") or (resource.get("invoice") or {}).get("id", ""))

    return {"status": "ok"}
