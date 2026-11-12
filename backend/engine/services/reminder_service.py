"""One reminder per open overpayment notice, about a day before its dispute window closes.

Safe to run from several processes: each recovery row is locked while its notifications are
checked and the reminder row is written, so a second runner waits, then finds the reminder.
"""
import asyncio
import logging
from datetime import datetime, timedelta, timezone

from sqlmodel import Session, select

from core.enums import RecoveryStatus
from core.models import Notification, Recovery
from engine.services.paypal_client import format_amount
from engine.services.recovery_service import _money, _utc, claim_ref, format_deadline, lock_recovery

logger = logging.getLogger(__name__)

REMINDER_LEAD = timedelta(hours=24)
REMINDER_TITLE = "Your dispute window closes soon"
INTERVAL_SECONDS = 15 * 60
# Lets startup finish before the first run touches the database.
FIRST_RUN_DELAY_SECONDS = 60


def recovery_link(rec: Recovery) -> str:
    return f"/employee/dashboard?recovery={rec.recovery_id}"


def reminder_message(rec: Recovery) -> str:
    return (f"Your dispute window for claim {claim_ref(rec.reim_id)} closes on {format_deadline(rec.dispute_until)}. "
            f"If you don't dispute it by then, HR can recover {rec.currency} {format_amount(_money(rec.amount))} "
            "by deducting it from an unpaid claim or sending you a PayPal invoice.")


def is_due(rec: Recovery, now: datetime) -> bool:
    """Open, closing within the lead time, and the window was longer than the lead time.

    A window of a day or less gets no reminder: the notice itself already gave the deadline.
    """
    until = _utc(rec.dispute_until)
    return (RecoveryStatus(rec.status) == RecoveryStatus.NOTICE_SENT
            and _utc(now) < until <= _utc(now) + REMINDER_LEAD
            and _utc(rec.created_at) < until - REMINDER_LEAD)


def _already_reminded(db: Session, rec: Recovery) -> bool:
    return db.exec(select(Notification.notification_id).where(
        Notification.user_id == rec.user_id,
        Notification.title == REMINDER_TITLE,
        Notification.link == recovery_link(rec),
    )).first() is not None


def send_dispute_reminders(db: Session, now: datetime | None = None) -> int:
    """Returns how many reminders were sent."""
    from engine.services.payout_service import notify

    now = now or datetime.now(timezone.utc)
    candidates = db.exec(select(Recovery.recovery_id).where(
        Recovery.status == RecoveryStatus.NOTICE_SENT.value,
        Recovery.dispute_until > now,
        Recovery.dispute_until <= now + REMINDER_LEAD,
    )).all()
    sent = 0
    for recovery_id in candidates:
        rec = lock_recovery(db, recovery_id)
        if rec is None or not is_due(rec, now) or _already_reminded(db, rec):
            db.rollback()
            continue
        # notify commits, which writes the reminder row and releases the lock together.
        notify(db, rec.user_id, "warning", REMINDER_TITLE, reminder_message(rec), link=recovery_link(rec), email=True)
        sent += 1
    return sent


def run_once() -> int:
    from core.database import engine as db_engine

    try:
        with Session(db_engine) as db:
            return send_dispute_reminders(db)
    except Exception:
        logger.exception("[REMINDER] Dispute reminder run failed")
        return 0


async def reminder_loop() -> None:
    await asyncio.sleep(FIRST_RUN_DELAY_SECONDS)
    while True:
        sent = await asyncio.to_thread(run_once)
        if sent:
            logger.info("[REMINDER] Sent %d dispute reminder(s)", sent)
        await asyncio.sleep(INTERVAL_SECONDS)
