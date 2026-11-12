"""Tell an employee when their instant-payout limit moves.

Trust is computed on read, so callers take `tier_of` before a state change that can move it
(a claim becoming PAID, a recovery becoming OFFSET, INVOICED or RECOVERED) and pass it to
`notify_if_changed` after the change is committed. The copy names a badge and a limit only.
"""
import logging
from datetime import datetime, timezone
from uuid import UUID

from sqlmodel import Session

from core.enums import UserRole
from core.models import User
from engine.risk.autonomy import limit_for, trust_tier
from engine.risk.types import TrustTier
from engine.services import autonomy_store as store
from engine.services.recovery_service import claim_ref

logger = logging.getLogger(__name__)

BADGE = {TrustTier.NEW: "Bronze", TrustTier.STANDARD: "Silver", TrustTier.TRUSTED: "Gold"}
_RANK = {TrustTier.NEW: 0, TrustTier.STANDARD: 1, TrustTier.TRUSTED: 2}
LINK = "/employee/dashboard"


def tier_of(db: Session, user_id: UUID, now: datetime | None = None) -> TrustTier:
    return trust_tier(store.employee_history(db, user_id, now or datetime.now(timezone.utc)))


def _money(currency: str, amount: float) -> str:
    return f"{currency} {amount:,.0f}" if float(amount).is_integer() else f"{currency} {amount:,.2f}"


def limit_notice(before: TrustTier, after: TrustTier, currency: str, limit: float,
                 reim_id: UUID | None) -> tuple[str, str, str]:
    """(type, title, message) for a move from `before` to `after`."""
    amount = _money(currency, limit)
    if _RANK[after] > _RANK[before]:
        badge = BADGE[after]
        return "success", f"{badge} badge earned", f"You earned the {badge} badge: instant payouts up to {amount}."
    message = f"Your instant-payout limit is now {amount}"
    message += f" after a correction on claim {claim_ref(reim_id)}." if reim_id else "."
    return "info", "Instant-payout limit changed", message


def notify_if_changed(db: Session, user_id: UUID, before: TrustTier, reim_id: UUID | None = None,
                      now: datetime | None = None) -> TrustTier | None:
    """Notify when the tier differs from `before`. Returns the new tier, or None when nothing moved."""
    from engine.services.payout_service import notify

    try:
        user = db.get(User, user_id)
        if user is None or user.role != UserRole.Employee:
            return None
        after = tier_of(db, user_id, now)
        if after == before:
            return None
        config = store.get_config(db)
        n_type, title, message = limit_notice(before, after, config.currency, limit_for(config, after), reim_id)
        notify(db, user_id, n_type, title, message, link=LINK, email=True)
        return after
    except Exception:
        # The state change is already committed; a failed notice must not undo or fail it.
        logger.exception("[TRUST] Limit-change notice failed for user=%s", user_id)
        return None
