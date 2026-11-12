"""The daily PayPal payout sweep, and the webhook retry sweep that shares its tick.

The job is idempotent: a payout's updated_at is refreshed by every successful status write, so a
stuck payout is checked at most once per PAYOUT_STUCK_HOURS. A session-level advisory lock keeps
multiple workers from running it at the same time.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Awaitable, Callable, Optional
from uuid import UUID

from pydantic import BaseModel, Field
from sqlalchemy import or_, text
from sqlmodel import Session, select

from core.config import settings
from core.database import engine
from core.enums import PayoutStatus
from core.models import Payout, User
from engine.services.paypal_client import PayPalError
from engine.services.payout_status import FINAL_STATUSES, refresh_payout
from engine.services.reconcile_service import NEVER_AT_PAYPAL
from engine.services.webhook_events import WebhookSweepReport, sweep_events

logger = logging.getLogger(__name__)

MAINTENANCE_LOCK_KEY = 724243
MAINTENANCE_INITIAL_DELAY_SECONDS = 60
_NON_FINAL = tuple(s for s in PayoutStatus if s not in FINAL_STATUSES)
_PAYOUT_BATCH = 200
_WEBHOOK_BATCH = 100


class PayoutSweepReport(BaseModel):
    checked: int = 0
    refreshed: int = 0
    changed: int = 0
    still_open: int = 0
    unrefreshable: int = 0
    errors: int = 0
    mock: bool = False
    truncated: bool = False


class MaintenanceReport(BaseModel):
    started_at: datetime
    finished_at: datetime
    locked: bool = False
    payouts: PayoutSweepReport = Field(default_factory=PayoutSweepReport)
    webhooks: WebhookSweepReport = Field(default_factory=WebhookSweepReport)


class StuckPayoutOut(BaseModel):
    payout_id: UUID
    reim_id: UUID
    claim_ref: str
    employee_name: str
    amount: float
    currency: str
    status: PayoutStatus
    provider_batch_id: Optional[str] = None
    created_at: datetime
    updated_at: datetime
    age_hours: float
    refreshable: bool


class StuckPayoutsOut(BaseModel):
    older_than_hours: int
    checked_at: datetime
    mock: bool = False
    payouts: list[StuckPayoutOut] = Field(default_factory=list)


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _refreshable(payout: Payout) -> bool:
    batch = payout.provider_batch_id
    return bool(batch) and not batch.startswith(NEVER_AT_PAYPAL)


def _claim_ref(reim_id) -> str:
    return f"RC-{str(reim_id)[:8].upper()}"


def _stuck_query(now: datetime):
    cutoff = now - timedelta(hours=settings.PAYOUT_STUCK_HOURS)
    return (
        select(Payout, User)
        .join(User, User.user_id == Payout.user_id)
        .where(Payout.provider == "PAYPAL")
        .where(Payout.status.in_([s.value for s in _NON_FINAL]))
        .where(or_(Payout.updated_at.is_(None), Payout.updated_at < cutoff))
        .order_by(Payout.created_at.asc())
    )


def stuck_payouts(db: Session, now: Optional[datetime] = None, limit: int = 200) -> StuckPayoutsOut:
    now = now or datetime.now(timezone.utc)
    rows = db.exec(_stuck_query(now).limit(limit)).all()
    payouts = []
    for payout, employee in rows:
        updated = _aware(payout.updated_at or payout.created_at)
        payouts.append(StuckPayoutOut(
            payout_id=payout.payout_id,
            reim_id=payout.reim_id,
            claim_ref=_claim_ref(payout.reim_id),
            employee_name=employee.name,
            amount=float(payout.amount),
            currency=payout.currency,
            status=PayoutStatus(payout.status),
            provider_batch_id=payout.provider_batch_id,
            created_at=payout.created_at,
            updated_at=payout.updated_at or payout.created_at,
            age_hours=round((now - updated).total_seconds() / 3600, 2),
            refreshable=_refreshable(payout),
        ))
    return StuckPayoutsOut(
        older_than_hours=settings.PAYOUT_STUCK_HOURS,
        checked_at=now,
        mock=settings.PAYPAL_MOCK_MODE,
        payouts=payouts,
    )


async def refresh_stuck_payouts(
    db: Session,
    now: Optional[datetime] = None,
    limit: int = _PAYOUT_BATCH,
    refresh: Optional[Callable[[Session, Payout], Awaitable[Payout]]] = None,
) -> PayoutSweepReport:
    now = now or datetime.now(timezone.utc)
    if settings.PAYPAL_MOCK_MODE:
        return PayoutSweepReport(mock=True)
    refresh = refresh or refresh_payout

    rows = db.exec(_stuck_query(now).limit(limit + 1)).all()
    report = PayoutSweepReport(checked=min(len(rows), limit), truncated=len(rows) > limit)
    for payout, _ in rows[:limit]:
        if not _refreshable(payout):
            report.unrefreshable += 1
            continue
        before = PayoutStatus(payout.status)
        try:
            updated = await refresh(db, payout)
        except PayPalError as exc:
            logger.warning("[MAINTENANCE] PayPal refresh failed payout=%s: %s", payout.payout_id, exc)
            db.rollback()
            report.errors += 1
            continue
        except Exception:
            logger.exception("[MAINTENANCE] Refresh failed payout=%s", payout.payout_id)
            db.rollback()
            report.errors += 1
            continue
        updated = updated or payout
        after = PayoutStatus(updated.status)
        report.refreshed += 1
        if after != before:
            report.changed += 1
        if after not in FINAL_STATUSES:
            report.still_open += 1
    return report


def _try_lock(db: Session) -> bool:
    return bool(db.connection().execute(
        text("SELECT pg_try_advisory_lock(:key)"), {"key": MAINTENANCE_LOCK_KEY}
    ).scalar())


def _unlock(db: Session) -> None:
    try:
        db.connection().execute(text("SELECT pg_advisory_unlock(:key)"), {"key": MAINTENANCE_LOCK_KEY})
    except Exception:
        logger.exception("[MAINTENANCE] Could not release the advisory lock")


async def run_maintenance(
    db: Optional[Session] = None,
    now: Optional[datetime] = None,
    payout_limit: int = _PAYOUT_BATCH,
    webhook_limit: int = _WEBHOOK_BATCH,
) -> MaintenanceReport:
    started = now or datetime.now(timezone.utc)
    own_session = db is None
    session = db or Session(engine)
    acquired = False
    try:
        acquired = _try_lock(session)
        if not acquired:
            return MaintenanceReport(started_at=started, finished_at=datetime.now(timezone.utc), locked=True)
        webhooks = sweep_events(session, started, webhook_limit)
        payouts = await refresh_stuck_payouts(session, started, payout_limit)
        return MaintenanceReport(
            started_at=started,
            finished_at=datetime.now(timezone.utc),
            payouts=payouts,
            webhooks=webhooks,
        )
    finally:
        if acquired:
            _unlock(session)
        if own_session:
            session.close()


async def maintenance_loop() -> None:
    """First tick after the delay, then every interval. The lifespan cancels this task."""
    await asyncio.sleep(MAINTENANCE_INITIAL_DELAY_SECONDS)
    while True:
        try:
            report = await run_maintenance()
            logger.info("[MAINTENANCE] payouts=%s webhooks=%s",
                        report.payouts.model_dump(), report.webhooks.model_dump())
        except Exception:
            logger.exception("[MAINTENANCE] Run failed")
        await asyncio.sleep(max(1, settings.MAINTENANCE_INTERVAL_SECONDS))
