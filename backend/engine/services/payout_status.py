"""
Payout status updates from PayPal webhooks and status refreshes.

Both paths go through `apply_item_update`, so a webhook delivered twice, or a
webhook racing a refresh, never notifies twice or moves a final status backwards.
"""
import logging
from datetime import datetime, timezone
from uuid import UUID

from sqlmodel import Session, select

from core.enums import AgentActionType, PayoutStatus, ReimbursementStatus, UserRole
from core.models import Payout, Reimbursement, User, Vendor
from engine.services.action_log import record_action
from engine.services.payout_service import notify
from engine.services.paypal_client import get_paypal_client, map_item_status

logger = logging.getLogger(__name__)

FINAL_STATUSES = {PayoutStatus.SUCCEEDED, PayoutStatus.FAILED, PayoutStatus.CANCELLED, PayoutStatus.REVERSED}
_FAILED_STATUSES = {PayoutStatus.FAILED, PayoutStatus.CANCELLED, PayoutStatus.REVERSED}


def next_status(current: PayoutStatus, incoming: PayoutStatus) -> PayoutStatus:
    if current in _FAILED_STATUSES:
        return current
    if current == PayoutStatus.SUCCEEDED:
        return PayoutStatus.REVERSED if incoming == PayoutStatus.REVERSED else current
    return incoming


def reim_status_for(payout_status: PayoutStatus) -> ReimbursementStatus | None:
    if payout_status == PayoutStatus.SUCCEEDED:
        return ReimbursementStatus.PAID
    if payout_status in _FAILED_STATUSES:
        return ReimbursementStatus.DISBURSEMENT_FAILED
    return None


def _find_payout(db: Session, item_id: str | None, sender_item_id: str | None) -> Payout | None:
    if item_id:
        payout = db.exec(select(Payout).where(Payout.provider_item_id == item_id).with_for_update()).first()
        if payout:
            return payout
    if not sender_item_id:
        return None
    try:
        reim_id = UUID(sender_item_id)
    except ValueError:
        return None
    # Webhook can arrive before provider_item_id is stored: fall back to the claim's latest attempt.
    return db.exec(
        select(Payout).where(Payout.reim_id == reim_id, Payout.provider == "PAYPAL")
        .order_by(Payout.attempt.desc()).with_for_update()
    ).first()


def _notify_change(db: Session, payout: Payout, status: PayoutStatus):
    ref = f"RC-{str(payout.reim_id)[:8]}"
    link = f"/employee/history?id={payout.reim_id}"
    is_booking = getattr(payout, "vendor_id", None) is not None
    vendor = db.get(Vendor, payout.vendor_id) if is_booking else None
    label = "booking" if is_booking else "claim"
    payee = vendor.name if vendor else "the vendor"
    if status == PayoutStatus.SUCCEEDED:
        if is_booking:
            notify(db, payout.user_id, "success", f"Vendor paid for booking {ref}",
                   f"{payout.currency} {float(payout.amount):,.2f} was sent to {payee}.", link=link)
        else:
            notify(db, payout.user_id, "success", f"Payment received for claim {ref}",
                   f"{payout.currency} {float(payout.amount):,.2f} arrived in your PayPal account", link=link)
        return
    if status not in _FAILED_STATUSES:
        return
    reason = payout.failure_code or status.value
    if is_booking:
        notify(db, payout.user_id, "error", f"Vendor payment failed for booking {ref}",
               f"The payment to {payee} did not go through ({reason}). HR has been told.", link=link)
    else:
        notify(db, payout.user_id, "error", f"Payout failed for claim {ref}",
               f"Your PayPal payout did not go through ({reason}). HR has been told.", link=link)
    for hr in db.exec(select(User).where(User.role == UserRole.HR, User.is_active == True)).all():  # noqa: E712
        notify(db, hr.user_id, "error", f"Payout {status.value.lower()} for {label} {ref}",
               f"PayPal payout of {payout.currency} {float(payout.amount):,.2f} ended {status.value} ({reason}).",
               link=f"/hr/view/{payout.reim_id}")


def apply_item_update(
    db: Session,
    item_id: str | None,
    sender_item_id: str | None,
    transaction_status: str,
    error: str | None = None,
) -> Payout | None:
    payout = _find_payout(db, item_id, sender_item_id)
    if payout is None:
        logger.warning("[PAYPAL] No payout for item=%s sender_item=%s", item_id, sender_item_id)
        return None

    if item_id and not payout.provider_item_id:
        payout.provider_item_id = item_id
    current = PayoutStatus(payout.status)
    new = next_status(current, map_item_status(transaction_status))
    payout.updated_at = datetime.now(timezone.utc)
    changed = new != current
    if changed:
        payout.status = new
        if error:
            payout.failure_code = error
        reim_status = reim_status_for(new)
        reim = db.get(Reimbursement, payout.reim_id)
        if reim and reim_status:
            reim.status = reim_status
            reim.updated_at = datetime.now(timezone.utc)
            db.add(reim)
    db.add(payout)
    db.commit()
    db.refresh(payout)

    if changed:
        record_action(db, AgentActionType.PAYOUT_STATUS, "agent", payout.reim_id, {
            "from": current.value,
            "to": new.value,
            "paypal_status": transaction_status,
            "item_id": payout.provider_item_id,
        })
        _notify_change(db, payout, new)
    return payout


async def refresh_payout(db: Session, payout: Payout) -> Payout:
    """Pull the latest item status from PayPal. Raises PayPalError if PayPal is unreachable."""
    if not payout.provider_batch_id or PayoutStatus(payout.status) in FINAL_STATUSES:
        return payout
    batch = await get_paypal_client().get_payout_batch(payout.provider_batch_id)
    item = next((i for i in batch.items if i.sender_item_id == str(payout.reim_id)), None)
    if item is None:
        return payout
    return apply_item_update(db, item.item_id, item.sender_item_id, item.transaction_status, item.error) or payout
