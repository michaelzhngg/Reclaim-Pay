"""Stores ledger reconciliation runs and their differences for HR.

The comparison stays in `reconcile_service`. This module only records its result, keeps one
open row per differing subject, and closes a row when a later run matches it. Report only:
nothing here changes a payout or a claim.
"""
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Callable, Optional
from uuid import UUID

from sqlalchemy import func, text
from sqlmodel import Session, select

from core.enums import UserRole
from core.models import ReconciliationDifference, ReconciliationRun, User
from engine.services.payout_service import notify
from engine.services.reconcile_service import (
    ReconcileSummary,
    TransactionFeed,
    fetch_transactions,
    reconcile,
)

logger = logging.getLogger(__name__)

JOB_DAYS = 3
MISSING_IN_PAYPAL = "MISSING_IN_PAYPAL"
UNKNOWN_IN_PAYPAL = "UNKNOWN_IN_PAYPAL"
MATCHED = "MATCHED"
DISMISSED = "DISMISSED"
SUCCESS_STATES = ("ok", "no_data")
# Serialises writers so two runs cannot both open the same difference.
ADVISORY_LOCK_KEY = 724243
NEW_TITLE = "PayPal ledger differences need review"
OUTAGE_TITLE = "PayPal reconciliation couldn't run"
RECONCILE_LINK = "/hr/payouts?tab=reconciliation"


@dataclass(frozen=True)
class ObservedDifference:
    kind: str
    payout_id: Optional[UUID] = None
    reim_id: Optional[UUID] = None
    transaction_id: Optional[str] = None
    amount: float = 0.0
    currency: str = ""
    employee_name: Optional[str] = None
    occurred_at: Optional[datetime] = None

    @property
    def key(self) -> tuple[str, str]:
        return difference_key(self.kind, self.payout_id, self.transaction_id)


@dataclass(frozen=True)
class RecordedRun:
    run: ReconciliationRun
    new_differences: list[ReconciliationDifference]


@dataclass(frozen=True)
class History:
    latest: Optional[ReconciliationRun]
    last_success_at: Optional[datetime]
    runs: list[ReconciliationRun]
    open_differences: list[ReconciliationDifference]


def difference_key(kind: str, payout_id: Optional[UUID] = None,
                   transaction_id: Optional[str] = None) -> tuple[str, str]:
    return (kind, str(payout_id or transaction_id))


def observed_differences(summary: ReconcileSummary) -> list[ObservedDifference]:
    """The summary's differences in the shape the difference table stores."""
    if summary.state != "ok":
        return []
    return [
        ObservedDifference(
            kind=MISSING_IN_PAYPAL,
            payout_id=row.payout_id,
            reim_id=row.reim_id,
            amount=row.amount,
            currency=row.currency,
            employee_name=row.employee_name,
            occurred_at=row.created_at,
        )
        for row in summary.mismatches
    ] + [
        ObservedDifference(
            kind=UNKNOWN_IN_PAYPAL,
            transaction_id=row.transaction_id,
            amount=row.amount,
            currency=row.currency,
            occurred_at=row.occurred_at,
        )
        for row in summary.unknown_in_paypal
    ]


def should_close(difference: ReconciliationDifference, seen: set[tuple[str, str]],
                 window_start: datetime) -> bool:
    """A difference closes only when this run was complete and the subject was still compared.

    An older row stays open on purpose: the rolling window must not make an unresolved payout
    disappear from HR's list.
    """
    if difference_key(difference.kind, difference.payout_id, difference.transaction_id) in seen:
        return False
    occurred_at = difference.occurred_at
    if occurred_at.tzinfo is None:
        occurred_at = occurred_at.replace(tzinfo=timezone.utc)
    return occurred_at >= window_start


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _open_count(db: Session) -> int:
    return db.exec(
        select(func.count())
        .select_from(ReconciliationDifference)
        .where(ReconciliationDifference.resolved_at.is_(None))
    ).one()


def _plural(count: int, singular: str, plural: str) -> str:
    return singular if count == 1 else plural


def _new_message(new: list[ReconciliationDifference]) -> str:
    missing = sum(1 for row in new if row.kind == MISSING_IN_PAYPAL)
    unknown = sum(1 for row in new if row.kind == UNKNOWN_IN_PAYPAL)
    parts = []
    if missing:
        parts.append(
            f"{missing} {_plural(missing, 'payout', 'payouts')} marked paid "
            f"{_plural(missing, 'is', 'are')} not in PayPal"
        )
    if unknown:
        parts.append(
            f"{unknown} PayPal {_plural(unknown, 'payment', 'payments')} "
            f"{_plural(unknown, 'has', 'have')} no matching claim"
        )
    message = " and ".join(parts)
    return f"{message[0].upper()}{message[1:]}. Review the differences in Payouts."


def _notify_hr(db: Session, title: str, message: str, n_type: str) -> int:
    hr_ids = db.exec(
        select(User.user_id)
        .where(User.role == UserRole.HR, User.is_active == True)  # noqa: E712
    ).all()
    sent = 0
    for user_id in hr_ids:
        try:
            notify(db, user_id, n_type, title, message, link=RECONCILE_LINK)
            sent += 1
        except Exception:
            logger.exception("[RECONCILE] Could not notify HR user %s", user_id)
            db.rollback()
    return sent


def _outage_notified(db: Session, current: ReconciliationRun) -> bool:
    previous = db.exec(
        select(ReconciliationRun)
        .where(ReconciliationRun.run_id != current.run_id)
        .order_by(ReconciliationRun.started_at.desc())
        .limit(1)
    ).first()
    return previous is not None and previous.state in ("unavailable", "failed")


def notify_hr(db: Session, recorded: RecordedRun) -> int:
    """Route a recorded run to HR. New differences first, otherwise one alert per outage."""
    run = recorded.run
    if recorded.new_differences:
        missing = any(row.kind == MISSING_IN_PAYPAL for row in recorded.new_differences)
        return _notify_hr(db, NEW_TITLE, _new_message(recorded.new_differences),
                          "error" if missing else "warning")
    if run.state in ("unavailable", "failed") and not _outage_notified(db, run):
        message = run.message or "The check failed before it could compare. Try again from Payouts."
        return _notify_hr(db, OUTAGE_TITLE, message, "warning")
    return 0


def record_run(db: Session, summary: ReconcileSummary, *, trigger: str,
               started_at: datetime, triggered_by: Optional[UUID] = None) -> RecordedRun:
    """Persist one comparison and update the difference lifecycle. Commits."""
    now = _utc(summary.checked_at)
    days = summary.days
    window_start = now - timedelta(days=days)
    db.exec(text(f"SELECT pg_advisory_xact_lock({ADVISORY_LOCK_KEY})"))

    run = ReconciliationRun(
        trigger=trigger,
        started_at=_utc(started_at),
        finished_at=now,
        days=days,
        window_start=window_start,
        window_end=now,
        state=summary.state,
        reconciled=summary.reconciled,
        total=summary.total,
        pending=summary.pending,
        data_through=_utc(summary.data_through) if summary.data_through else None,
        mock=summary.mock,
        message=summary.message,
        triggered_by=triggered_by,
    )
    db.add(run)
    db.flush()

    new: list[ReconciliationDifference] = []
    if summary.state == "ok":
        observed = {row.key: row for row in observed_differences(summary)}
        open_rows = list(db.exec(
            select(ReconciliationDifference)
            .where(ReconciliationDifference.resolved_at.is_(None))
        ).all())
        by_key = {
            difference_key(row.kind, row.payout_id, row.transaction_id): row
            for row in open_rows
        }
        seen = set(observed)
        for row in open_rows:
            key = difference_key(row.kind, row.payout_id, row.transaction_id)
            if should_close(row, seen, window_start):
                row.resolved_at = now
                row.resolution = MATCHED
                row.last_run_id = run.run_id
                db.add(row)
                by_key.pop(key, None)
        for key, observed_row in observed.items():
            existing = by_key.get(key)
            if existing is not None:
                existing.last_seen_at = now
                existing.last_run_id = run.run_id
                existing.amount = observed_row.amount
                existing.currency = observed_row.currency
                if observed_row.employee_name:
                    existing.employee_name = observed_row.employee_name
                db.add(existing)
                continue
            row = ReconciliationDifference(
                kind=observed_row.kind,
                payout_id=observed_row.payout_id,
                reim_id=observed_row.reim_id,
                transaction_id=observed_row.transaction_id,
                amount=observed_row.amount,
                currency=observed_row.currency,
                employee_name=observed_row.employee_name,
                occurred_at=_utc(observed_row.occurred_at),
                first_seen_at=now,
                last_seen_at=now,
                first_run_id=run.run_id,
                last_run_id=run.run_id,
            )
            db.add(row)
            new.append(row)
            by_key[key] = row

    db.flush()
    run.differences_new = len(new)
    run.differences_open = _open_count(db)
    db.add(run)
    db.commit()
    db.refresh(run)
    return RecordedRun(run=run, new_differences=new)


def record_failure(db: Session, *, trigger: str, started_at: datetime, days: int,
                   error: str, triggered_by: Optional[UUID] = None) -> ReconciliationRun:
    """Record a run that could not complete. The error is a class name, never a traceback."""
    db.rollback()
    now = datetime.now(timezone.utc)
    run = ReconciliationRun(
        trigger=trigger,
        started_at=_utc(started_at),
        finished_at=now,
        days=days,
        window_start=_utc(started_at) - timedelta(days=days),
        window_end=now,
        state="failed",
        error=error,
        differences_open=_open_count(db),
        triggered_by=triggered_by,
    )
    db.add(run)
    db.commit()
    db.refresh(run)
    return run


def run_and_record(db: Session, *, days: int = JOB_DAYS, trigger: str = "manual",
                   now: Optional[datetime] = None, triggered_by: Optional[UUID] = None,
                   fetch: Callable[[datetime, datetime], TransactionFeed] = fetch_transactions
                   ) -> RecordedRun:
    """Compare, then record. A failed comparison is recorded and re-raised for the caller."""
    started = _utc(now or datetime.now(timezone.utc))
    try:
        summary = reconcile(db, days=days, now=started, fetch=fetch)
    except Exception as exc:
        try:
            failed = record_failure(db, trigger=trigger, started_at=started, days=days,
                                    error=type(exc).__name__, triggered_by=triggered_by)
            try:
                notify_hr(db, RecordedRun(run=failed, new_differences=[]))
            except Exception:
                logger.exception("[RECONCILE] Could not send the failure notification")
                db.rollback()
        except Exception:
            logger.exception("[RECONCILE] Could not record the failed run")
        raise
    # The comparison only read. Release its snapshot before the write transaction so two runs
    # cannot both act on an older set of open differences.
    db.rollback()
    recorded = record_run(db, summary, trigger=trigger, started_at=started, triggered_by=triggered_by)
    try:
        notify_hr(db, recorded)
    except Exception:
        logger.exception("[RECONCILE] Could not send the reconciliation notification")
        db.rollback()
    return recorded


def history(db: Session, limit: int = 14) -> History:
    runs = list(db.exec(
        select(ReconciliationRun)
        .order_by(ReconciliationRun.started_at.desc())
        .limit(limit)
    ).all())
    latest_success = db.exec(
        select(ReconciliationRun)
        .where(ReconciliationRun.state.in_(SUCCESS_STATES))
        .order_by(ReconciliationRun.started_at.desc())
        .limit(1)
    ).first()
    open_differences = list(db.exec(
        select(ReconciliationDifference)
        .where(ReconciliationDifference.resolved_at.is_(None))
        .order_by(ReconciliationDifference.kind, ReconciliationDifference.occurred_at.desc())
    ).all())
    return History(
        latest=runs[0] if runs else None,
        last_success_at=latest_success.started_at if latest_success else None,
        runs=runs,
        open_differences=open_differences,
    )
