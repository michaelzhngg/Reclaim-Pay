"""Demo only: show one missing-in-PayPal difference without a real PayPal discrepancy.

Uses an existing seeded claim and payout, records one run with the `demo` trigger, and sends the
same HR notification a real new difference would send. No payout, claim or recovery is changed.

Run from the backend directory after the main seed:

    python -m seeds.seed_reconciliation_demo
    python -m seeds.seed_reconciliation_demo --clear
"""
import argparse
from datetime import datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import or_
from sqlmodel import Session, select

from core.database import engine, init_db
from core.enums import PayoutStatus
from core.models import Payout, ReconciliationDifference, ReconciliationRun, Reimbursement, User
from engine.services.reconcile_history import (
    RecordedRun,
    notify_hr,
    record_run,
)
from engine.services.reconcile_service import MismatchedPayout, ReconcileSummary

DEMO_TRIGGER = "demo"
DEMO_MESSAGE = "Demo difference: one payout is shown as missing from PayPal."


def _latest_payout(db: Session):
    return db.exec(
        select(Payout, Reimbursement, User)
        .join(Reimbursement, Reimbursement.reim_id == Payout.reim_id)
        .join(User, User.user_id == Payout.user_id)
        .where(Payout.provider == "PAYPAL")
        .where(Payout.status.in_([PayoutStatus.SUCCEEDED.value, PayoutStatus.REVERSED.value]))
        .order_by(Payout.created_at.desc())
        .limit(1)
    ).first()


def seed_demo(db: Session, now: Optional[datetime] = None) -> Optional[tuple[RecordedRun, int]]:
    """Record one demo difference for the newest payout. Returns None when there is no payout."""
    row = _latest_payout(db)
    if row is None:
        return None
    payout, reim, employee = row
    now = now or datetime.now(timezone.utc)
    summary = ReconcileSummary(
        state="ok",
        reconciled=0,
        total=1,
        pending=0,
        mismatches=[MismatchedPayout(
            payout_id=payout.payout_id,
            reim_id=payout.reim_id,
            claim_ref=f"RC-{str(payout.reim_id)[:8].upper()}",
            employee_name=employee.name,
            amount=float(payout.amount),
            currency=payout.currency,
            created_at=payout.created_at,
        )],
        unknown_in_paypal=[],
        days=3,
        checked_at=now,
        data_through=now,
        mock=True,
        message=DEMO_MESSAGE,
    )
    recorded = record_run(db, summary, trigger=DEMO_TRIGGER,
                          started_at=now - timedelta(seconds=2), resolve=False)
    return recorded, notify_hr(db, recorded)


def clear_demo(db: Session) -> tuple[int, int]:
    """Remove only runs recorded by this seed and the differences they opened."""
    runs = list(db.exec(
        select(ReconciliationRun).where(ReconciliationRun.trigger == DEMO_TRIGGER)
    ).all())
    if not runs:
        return 0, 0
    run_ids = [run.run_id for run in runs]
    differences = list(db.exec(
        select(ReconciliationDifference)
        .where(or_(
            ReconciliationDifference.first_run_id.in_(run_ids),
            ReconciliationDifference.last_run_id.in_(run_ids),
        ))
    ).all())
    removed = 0
    for difference in differences:
        if difference.first_run_id in run_ids:
            db.delete(difference)
            removed += 1
        else:
            # A real row that an older demo run once touched. Keep the row, release the FK.
            difference.last_run_id = None
            db.add(difference)
    db.flush()
    for run in runs:
        db.delete(run)
    db.commit()
    return removed, len(runs)


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Show a demo ledger difference. Demo only.")
    parser.add_argument("--clear", action="store_true",
                        help="remove the runs and open differences created by this seed")
    args = parser.parse_args(argv)

    init_db()
    with Session(engine) as db:
        if args.clear:
            differences, runs = clear_demo(db)
            print(f"[DEMO] Removed {differences} demo differences and {runs} demo runs. "
                  "The notification stays in the bell until it is read.")
            return 0

        result = seed_demo(db)
        if result is None:
            print("[DEMO] No PayPal payout found. Run the main demo seed first.")
            return 1
        recorded, notified = result
        print(f"[DEMO] Recorded run {recorded.run.run_id} with "
              f"{recorded.run.differences_new} new and {recorded.run.differences_open} open differences. "
              f"Notified {notified} HR users. No payout or claim was changed.")
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
