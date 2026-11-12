"""
Funding alert for the HR Payouts page: does the PayPal business balance cover the payouts we expect to send?

Alert only. Nothing here changes whether or when a claim is paid. The maths is in pure functions
(`expected_daily`, `days_of_cover`, `funding_status`, `build_funding`) so it is tested without a database.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from decimal import ROUND_DOWN, ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Iterable, Literal, Optional
from uuid import UUID

from pydantic import BaseModel
from sqlmodel import Session, select

from core.config import settings
from core.enums import PayoutStatus, ReimbursementStatus, UserRole
from core.models import Notification, Payout, Reimbursement, User
from engine.services.payout_service import notify
from engine.services.paypal_client import Balance, PayPalError, get_paypal_client
from engine.services.reconcile_service import NEVER_AT_PAYPAL

logger = logging.getLogger(__name__)

HISTORY_DAYS = 14
BALANCE_TIMEOUT_SECONDS = 8
ALERT_EVERY = timedelta(hours=24)

FundingStatus = Literal["ok", "low", "short", "no_history", "unavailable"]
UnavailableReason = Literal["credentials", "permission", "refused", "unreachable", "not_configured", "not_held",
                            "unreadable"]

_CENT = Decimal("0.01")
_TENTH = Decimal("0.1")
_ZERO = Decimal("0.00")
# Payouts PayPal accepted: the money left, or is leaving, the balance.
_DRAWN = (PayoutStatus.SUCCEEDED, PayoutStatus.ACCEPTED, PayoutStatus.REQUESTED)
# Approved and owed, but not yet sent. A failed payout stays owed until HR resends it.
_OWED = (ReimbursementStatus.APPROVED, ReimbursementStatus.DISBURSEMENT_FAILED)

# The card already says "Balance not checked", so these say only why.
_UNAVAILABLE_MESSAGE: dict[UnavailableReason, str] = {
    "credentials": "PayPal rejected the app's client ID or secret.",
    "permission": ('PayPal refused to share the balance. Tick "Transaction search" under the PayPal app\'s '
                   "features in the developer dashboard."),
    "refused": "PayPal refused the balance request.",
    "unreachable": "PayPal can't be reached right now.",
    "not_configured": "PayPal credentials aren't set.",
    "not_held": "The PayPal account holds no {currency} balance.",
    "unreadable": "PayPal returned a balance that couldn't be read.",
}

ALERT_TITLES: dict[str, str] = {
    "low": "PayPal balance is low",
    "short": "PayPal balance is short",
}
# A "short" alert still goes out after a "low" one the same day: it is the more urgent of the two.
_SUPPRESSED_BY: dict[str, tuple[str, ...]] = {
    "low": (ALERT_TITLES["low"], ALERT_TITLES["short"]),
    "short": (ALERT_TITLES["short"],),
}


class FundingSummary(BaseModel):
    status: FundingStatus
    currency: str
    # Money is Decimal end to end; JSON carries it as a string such as "1240.00".
    available: Optional[Decimal] = None
    expected_daily: Decimal = _ZERO
    committed: Decimal = _ZERO
    days_of_cover: Optional[Decimal] = None
    threshold_days: int
    history_days: int = HISTORY_DAYS
    as_of: Optional[datetime] = None
    checked_at: datetime
    mock: bool = False
    message: str


def _money(value: object) -> Decimal:
    return Decimal(str(value if value is not None else 0)).quantize(_CENT, rounding=ROUND_HALF_UP)


def format_money(currency: str, amount: Decimal) -> str:
    return f"{currency} {amount:,.2f}"


def expected_daily(amounts: Iterable[Decimal], days: int = HISTORY_DAYS) -> Decimal:
    """Average paid out per calendar day over the window, including days with no payouts."""
    if days <= 0:
        return _ZERO
    total = sum((Decimal(a) for a in amounts), Decimal("0"))
    return max(_ZERO, (total / days).quantize(_CENT, rounding=ROUND_HALF_UP))


def days_of_cover(available: Decimal, daily: Decimal) -> Decimal | None:
    """Rounded down, so the cover is never overstated. None when there is no rate to divide by."""
    if daily <= 0:
        return None
    if available <= 0:
        return Decimal("0.0")
    return (available / daily).quantize(_TENTH, rounding=ROUND_DOWN)


def funding_status(available: Decimal | None, daily: Decimal, committed: Decimal, threshold_days: int) -> FundingStatus:
    if available is None:
        return "unavailable"
    if available < committed:
        return "short"
    if daily <= 0:
        return "no_history"
    if available < daily * threshold_days:
        return "low"
    return "ok"


def cover_phrase(cover: Decimal) -> str:
    if cover < 1:
        return "less than a day"
    whole = int(cover)
    return "about 1 day" if whole == 1 else f"about {whole} days"


def funding_message(status: FundingStatus, currency: str, available: Decimal | None, committed: Decimal,
                    cover: Decimal | None, threshold_days: int,
                    reason: UnavailableReason | None = None) -> str:
    if status == "unavailable" or available is None:
        return _UNAVAILABLE_MESSAGE[reason or "unreachable"].format(currency=currency)
    have = format_money(currency, available)
    if status == "short" and committed <= 0:
        return (f"The PayPal account is overdrawn by {format_money(currency, -available)}, "
                "so no payout can go out until it is topped up.")
    if status == "short":
        return f"{have} available can't cover {format_money(currency, committed)} of approved claims waiting to be paid."
    if status == "no_history" or cover is None:
        return f"{have} available, with no payouts in the last {HISTORY_DAYS} days to estimate a daily rate from."
    if status == "low":
        return (f"{have} available covers {cover_phrase(cover)} of payouts, under the {threshold_days}-day minimum, "
                "so top up the PayPal business account.")
    return f"{have} available covers {cover_phrase(cover)} of payouts."


def build_funding(*, currency: str, balance: Balance | None, payout_amounts: Iterable[Decimal],
                  committed: Decimal, threshold_days: int, now: datetime, mock: bool = False,
                  reason: UnavailableReason | None = None) -> FundingSummary:
    if balance is not None and not balance.available.is_finite():
        balance, reason = None, "unreadable"
    available = _money(balance.available) if balance is not None else None
    daily = expected_daily(payout_amounts)
    committed = _money(committed)
    status = funding_status(available, daily, committed, threshold_days)
    cover = days_of_cover(available, daily) if available is not None else None
    return FundingSummary(
        status=status,
        currency=currency,
        available=available,
        expected_daily=daily,
        committed=committed,
        days_of_cover=cover,
        threshold_days=threshold_days,
        as_of=balance.as_of if balance is not None else None,
        checked_at=now,
        mock=mock,
        message=funding_message(status, currency, available, committed, cover, threshold_days, reason),
    )


def alert_recipients(status: FundingStatus, hr_user_ids: Iterable[UUID],
                     recent: Iterable[tuple[UUID, str]]) -> list[UUID]:
    """HR users who should get an alert now. `recent` is (user_id, title) of notifications from the last 24 hours."""
    suppressed_by = _SUPPRESSED_BY.get(status)
    if not suppressed_by:
        return []
    already = {user_id for user_id, title in recent if title in suppressed_by}
    return [user_id for user_id in hr_user_ids if user_id not in already]


def _recent_payout_amounts(db: Session, currency: str, since: datetime, include_unsent: bool) -> list[Decimal]:
    rows = db.exec(
        select(Payout.amount, Payout.provider_batch_id)
        .where(Payout.provider == "PAYPAL")
        .where(Payout.currency == currency)
        .where(Payout.status.in_([s.value for s in _DRAWN]))
        .where(Payout.created_at >= since)
    ).all()
    # With a real balance, seeded and mock payouts never drew on it, so they don't set the rate (as in reconcile).
    return [
        _money(amount) for amount, batch_id in rows
        if include_unsent or (batch_id and not batch_id.startswith(NEVER_AT_PAYPAL))
    ]


def _committed(db: Session) -> Decimal:
    # Same amount the payout service sends. Recovery offsets can lower it a little, so this errs high.
    # Amounts are converted to company currency; a claim with no quote uses its raw amount.
    rows = db.exec(
        select(
            Reimbursement.total_approved_amount,
            Reimbursement.approved_company_amount,
            Reimbursement.amount_company,
        )
        .where(Reimbursement.status.in_([s.value for s in _OWED]))
    ).all()
    total = _ZERO
    for approved, approved_company, claimed_company in rows:
        total += _money(approved_company if approved_company is not None else claimed_company or approved)
    return total


async def _fetch_balance(currency: str) -> tuple[Balance | None, UnavailableReason | None]:
    if not settings.PAYPAL_MOCK_MODE and not (settings.PAYPAL_CLIENT_ID and settings.PAYPAL_CLIENT_SECRET):
        return None, "not_configured"
    try:
        balance = await asyncio.wait_for(get_paypal_client().get_balance(currency), BALANCE_TIMEOUT_SECONDS)
    except PayPalError as exc:
        logger.warning("[FUNDING] Balance check failed: %s %s", exc.status, exc.name)
        return None, reason_for_status(exc.status)
    except (ValueError, InvalidOperation) as exc:
        logger.warning("[FUNDING] Balance unreadable: %s", exc)
        return None, "unreadable"
    except Exception as exc:
        logger.warning("[FUNDING] Balance check failed: %s", type(exc).__name__)
        return None, "unreachable"
    if balance is None:
        return None, "not_held"
    if not balance.available.is_finite():
        return None, "unreadable"
    return balance, None


def reason_for_status(status: int) -> UnavailableReason:
    if status == 401:
        return "credentials"
    if status == 403:
        return "permission"
    # 408 and 429 mean "try later", like a timeout or a 5xx.
    if 400 <= status < 500 and status not in (408, 429):
        return "refused"
    return "unreachable"


async def funding_summary(db: Session, now: datetime | None = None) -> FundingSummary:
    now = now or datetime.now(timezone.utc)
    currency = settings.PAYPAL_CURRENCY.upper()
    mock = settings.PAYPAL_MOCK_MODE
    amounts = _recent_payout_amounts(db, currency, now - timedelta(days=HISTORY_DAYS), include_unsent=mock)
    committed = _committed(db)
    balance, reason = await _fetch_balance(currency)
    return build_funding(currency=currency, balance=balance, payout_amounts=amounts, committed=committed,
                         threshold_days=settings.FUNDING_ALERT_DAYS, now=now, mock=mock, reason=reason)


def alert_hr(db: Session, summary: FundingSummary, now: datetime | None = None) -> int:
    """In-app alert to each active HR user, at most once per 24 hours per level. Returns how many were sent."""
    title = ALERT_TITLES.get(summary.status)
    if title is None:
        return 0
    now = now or datetime.now(timezone.utc)
    hr_ids = db.exec(select(User.user_id).where(User.role == UserRole.HR, User.is_active == True)).all()  # noqa: E712
    recent = db.exec(
        select(Notification.user_id, Notification.title)
        .where(Notification.title.in_(list(ALERT_TITLES.values())))
        .where(Notification.created_at >= now - ALERT_EVERY)
    ).all()
    recipients = alert_recipients(summary.status, hr_ids, recent)
    n_type = "error" if summary.status == "short" else "warning"
    for user_id in recipients:
        notify(db, user_id, n_type, title, summary.message, link="/hr/payouts")
    return len(recipients)
