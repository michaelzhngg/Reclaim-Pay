"""
Shared payout service — callable from both the HTTP route and the async
compliance background task.

Usage from an async context (FastAPI route):
    payout = await initiate_payout_async(reim_id, db)

Usage from a sync thread (background task with access to the event loop):
    payout = initiate_payout_sync(reim_id, db, loop)

Payouts go to the employee's verified PayPal account (recipient_type PAYPAL_ID).
`sender_batch_id` is derived from the claim and attempt number, so a retried
request can never pay twice.
"""
import asyncio
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal
from uuid import UUID

from sqlmodel import Session, select

from core.config import settings
from core.models import User, Reimbursement, Payout, Notification, Vendor, VendorBooking
from core.email_service import fire_and_forget_email
from core.enums import AgentActionType, ReimbursementStatus, PayoutStatus, UserRole, is_vendor_booking
from core.push_service import fire_and_forget_push
from engine.services.action_log import record_action
from engine.services import fx
from engine.services.paypal_client import (
    PayoutCreated,
    get_paypal_client,
    mask_email,
    sender_batch_id_for,
)
from engine.services.recovery_service import offset_for_reim

logger = logging.getLogger(__name__)

_LIVE_STATUSES = {PayoutStatus.ACCEPTED, PayoutStatus.REQUESTED, PayoutStatus.SUCCEEDED}
_PAYABLE_STATUSES = {ReimbursementStatus.APPROVED, ReimbursementStatus.DISBURSEMENT_FAILED}


@dataclass(frozen=True)
class Payee:
    """Who receives the money. The requester stays on Payout.user_id for attribution."""
    kind: str
    payer_id: str
    email: str | None
    label: str
    vendor_id: UUID | None = None


def payee_for_reim(db: Session, reim: Reimbursement) -> Payee | None:
    """The verified payee for a claim or a vendor booking, or None if there is not one."""
    if is_vendor_booking(reim):
        booking = db.exec(select(VendorBooking).where(VendorBooking.reim_id == reim.reim_id)).first()
        vendor = db.get(Vendor, booking.vendor_id) if booking else None
        if not vendor or not vendor.paypal_verified or not vendor.paypal_payer_id or not vendor.is_active:
            return None
        return Payee(
            kind="VENDOR_BOOKING",
            payer_id=vendor.paypal_payer_id,
            email=vendor.paypal_email,
            label=vendor.name,
            vendor_id=vendor.vendor_id,
        )
    employee = db.get(User, reim.user_id)
    if not employee or not employee.paypal_verified or not employee.paypal_payer_id:
        return None
    return Payee(
        kind="CLAIM",
        payer_id=employee.paypal_payer_id,
        email=employee.paypal_email,
        label=employee.name,
    )


def payout_plan(
    reim_status: str,
    net_amount: Decimal,
    existing_statuses: list[str],
    payee_verified: bool,
) -> tuple[str, Decimal | None, int]:
    """Decide what to do for a claim. Returns (action, amount, attempt)."""
    if reim_status not in _PAYABLE_STATUSES:
        return "SKIP_NOT_APPROVED", None, 0
    if any(s in _LIVE_STATUSES for s in existing_statuses):
        return "SKIP_EXISTING", None, 0
    if net_amount <= 0:
        return "SKIP_ZERO", None, 0
    if not payee_verified:
        return "SKIP_NO_PAYEE", None, 0
    # attempt only moves on after a payout ended FAILED, REVERSED or CANCELLED
    return "CREATE", net_amount, len(existing_statuses) + 1


def notify(db: Session, user_id: UUID, n_type: str, title: str, message: str, link: str | None = None,
           email: bool = False):
    """In-app row and web push. `email=True` also emails the user, but only when they are an employee."""
    db.add(Notification(user_id=user_id, type=n_type, title=title, message=message, link=link, is_read=False))
    db.commit()
    fire_and_forget_push(user_id, title, message, link=link or "/")
    if email:
        user = db.get(User, user_id)
        if user and user.email and user.role == UserRole.Employee:
            fire_and_forget_email(user.email, title, message, link=link)


def _claim_ref(reim_id: UUID) -> str:
    return f"RC-{str(reim_id)[:8]}"


def _existing_payouts(db: Session, reim_id: UUID) -> list[Payout]:
    return list(db.exec(select(Payout).where(Payout.reim_id == reim_id).order_by(Payout.attempt)).all())


def payout_company_amount(db: Session, reim: Reimbursement, net_claim: Decimal) -> Decimal | None:
    """The amount PayPal receives in company currency, or None when no quote exists.

    A foreign claim is paid its converted company amount in this stage. Ticket 06 replaces
    this with the contract's payout currency and snapshot fields.
    """
    if fx.normalise(reim.currency) == fx.company_currency():
        return net_claim
    if (reim.approved_company_amount is not None
            and Decimal(str(reim.total_approved_amount or 0)) == net_claim):
        return Decimal(str(reim.approved_company_amount))
    quoted = fx.quote_or_none(net_claim, reim.currency, fx.company_currency())
    return quoted.converted if quoted else None


def _plan(reim_id: UUID, db: Session):
    reim = db.get(Reimbursement, reim_id)
    if not reim:
        return None, None, ("SKIP_NOT_APPROVED", None, 0), []
    existing = _existing_payouts(db, reim_id)
    payee = payee_for_reim(db, reim)
    net_amount, _applied = offset_for_reim(db, reim)
    company_amount = payout_company_amount(db, reim, net_amount)
    if company_amount is None:
        return reim, payee, ("SKIP_NO_FX_QUOTE", None, 0), existing
    plan = payout_plan(reim.status, company_amount, [p.status for p in existing], payee is not None)
    return reim, payee, plan, existing


def _settle_without_payout(db: Session, reim: Reimbursement):
    from engine.services.trust_notices import notify_if_changed, tier_of

    tier_before = tier_of(db, reim.user_id)
    reim.status = ReimbursementStatus.PAID
    reim.updated_at = datetime.now(timezone.utc)
    db.add(reim)
    db.commit()
    notify(
        db, reim.user_id, "success",
        f"Claim {_claim_ref(reim.reim_id)} settled",
        "Settled against an earlier overpayment. No PayPal transfer was needed.",
        link=f"/employee/history?id={reim.reim_id}",
    )
    notify_if_changed(db, reim.user_id, tier_before, reim_id=reim.reim_id)


def _handle_skip(db: Session, reim: Reimbursement | None, action: str, existing: list[Payout]) -> Payout | None:
    if action == "SKIP_EXISTING":
        return next(p for p in reversed(existing) if p.status in _LIVE_STATUSES)
    if action == "SKIP_ZERO" and reim is not None:
        # PAID needs money moved or an offset that covered it. Nothing approved is neither, so the status stays.
        if offset_for_reim(db, reim)[1]:
            _settle_without_payout(db, reim)
        else:
            logger.warning("[AUTO_PAYOUT] Nothing approved on reim=%s, not marking it paid", reim.reim_id)
    elif action == "SKIP_NO_PAYEE" and reim is not None:
        logger.info("[AUTO_PAYOUT] Skipping reim=%s: the payee has no verified PayPal account", reim.reim_id)
    elif action == "SKIP_NO_FX_QUOTE" and reim is not None:
        logger.warning("[AUTO_PAYOUT] Skipping reim=%s: no FX quote for %s", reim.reim_id, reim.currency)
    return None


def _mark_disbursing(db: Session, reim: Reimbursement):
    reim.status = ReimbursementStatus.DISBURSING
    reim.updated_at = datetime.now(timezone.utc)
    db.add(reim)
    db.flush()


def _save_payout(
    db: Session,
    reim: Reimbursement,
    payee: Payee,
    amount: Decimal,
    attempt: int,
    sender_batch_id: str,
    created: PayoutCreated,
) -> Payout:
    currency = settings.PAYPAL_CURRENCY
    payout = Payout(
        reim_id=reim.reim_id,
        user_id=reim.user_id,
        vendor_id=payee.vendor_id,
        amount=amount,
        currency=currency,
        status=PayoutStatus.ACCEPTED,
        provider="PAYPAL",
        provider_batch_id=created.batch_id,
        attempt=attempt,
        idempotency_key=sender_batch_id,
        reference_id=_claim_ref(reim.reim_id),
        channel_code="PAYPAL",
    )
    db.add(payout)
    db.commit()
    db.refresh(payout)

    record_action(db, AgentActionType.PAYOUT_CREATED, "agent", reim.reim_id, {
        "amount": f"{amount:.2f}",
        "currency": currency,
        "sender_batch_id": sender_batch_id,
        "batch_id": created.batch_id,
        **({"vendor_id": str(payee.vendor_id)} if payee.vendor_id else {}),
    })
    if payee.kind == "VENDOR_BOOKING":
        notify(
            db, reim.user_id, "info",
            f"Vendor paid for booking {_claim_ref(reim.reim_id)}",
            f"{currency} {amount:,.2f} was sent to {payee.label} ({mask_email(payee.email or '')})",
            link=f"/employee/history?id={reim.reim_id}",
        )
    else:
        notify(
            db, reim.user_id, "info",
            f"Payout initiated for claim {_claim_ref(reim.reim_id)}",
            f"Sending {currency} {amount:,.2f} to your PayPal account ({mask_email(payee.email or '')})",
            link=f"/employee/history?id={reim.reim_id}",
        )
    if settings.PAYPAL_MOCK_MODE:
        _schedule_status_refresh(payout.payout_id)

    logger.info("[AUTO_PAYOUT] Payout initiated: reim=%s payout=%s batch=%s payee=%s",
                reim.reim_id, payout.payout_id, created.batch_id, payee.kind)
    return payout


def _schedule_status_refresh(payout_id: UUID, delay: float = 9.0):
    """Mock mode has no webhooks, so poll once after the mock payout has settled."""
    def _run():
        from core.database import engine as db_engine
        from engine.services.payout_status import refresh_payout
        try:
            with Session(db_engine) as s:
                payout = s.get(Payout, payout_id)
                if payout:
                    asyncio.run(refresh_payout(s, payout))
        except Exception:
            logger.exception("[AUTO_PAYOUT] Mock status refresh failed for payout=%s", payout_id)

    timer = threading.Timer(delay, _run)
    timer.daemon = True
    timer.start()


def initiate_payout_sync(
    reim_id: UUID,
    db: Session,
    loop: asyncio.AbstractEventLoop | None = None,
) -> Payout | None:
    """
    Synchronous payout initiator — safe to call from a thread executor.
    Returns the Payout record on success, or None if skipped (no verified PayPal
    account, nothing left to pay, or not approved). Does NOT raise on PayPal
    failure — it leaves the reimbursement in its current status for HR retry.
    """
    reim, payee, (action, amount, attempt), existing = _plan(reim_id, db)
    if action != "CREATE" or payee is None:
        return _handle_skip(db, reim, action, existing)

    _mark_disbursing(db, reim)
    sender_batch_id = sender_batch_id_for(reim_id, attempt)

    try:
        coro = get_paypal_client().create_payout(
            sender_batch_id=sender_batch_id,
            payer_id=payee.payer_id,
            amount=amount,
            currency=settings.PAYPAL_CURRENCY,
            note=_claim_ref(reim_id),
            sender_item_id=str(reim_id),
        )
        if loop and loop.is_running():
            created = asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=70)
        else:
            created = asyncio.run(coro)
    except Exception:
        logger.exception("[AUTO_PAYOUT] PayPal call failed for reim=%s - leaving for HR retry", reim_id)
        db.rollback()
        return None

    return _save_payout(db, reim, payee, amount, attempt, sender_batch_id, created)


async def initiate_payout_async(reim_id: UUID, db: Session) -> Payout | None:
    """Async variant for use in FastAPI route handlers."""
    reim, payee, (action, amount, attempt), existing = _plan(reim_id, db)
    if action != "CREATE" or payee is None:
        return _handle_skip(db, reim, action, existing)

    _mark_disbursing(db, reim)
    sender_batch_id = sender_batch_id_for(reim_id, attempt)

    try:
        created = await get_paypal_client().create_payout(
            sender_batch_id=sender_batch_id,
            payer_id=payee.payer_id,
            amount=amount,
            currency=settings.PAYPAL_CURRENCY,
            note=_claim_ref(reim_id),
            sender_item_id=str(reim_id),
        )
    except Exception:
        logger.exception("[AUTO_PAYOUT] PayPal call failed for reim=%s", reim_id)
        db.rollback()
        return None

    return _save_payout(db, reim, payee, amount, attempt, sender_batch_id, created)
