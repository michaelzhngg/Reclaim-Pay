"""Payout-link rules shared by employees and vendors.

A first link never starts a cool-down. Changing the payer identity after a first
link does, so a hijacked account change cannot redirect an instant payout.
"""

from datetime import datetime, timedelta

from engine.services.paypal_client import PayPalUser

PAYEE_COOLDOWN_HOURS = 72


def cooldown_until(changed_at: datetime | None, hours: int) -> datetime | None:
    return changed_at + timedelta(hours=hours) if changed_at else None


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
