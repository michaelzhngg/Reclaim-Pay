"""Daily ledger reconciliation entry point for the Render cron service.

Run from the backend directory:

    python -m jobs.daily_reconcile

Exits 0 when the run was recorded (ok, no_data or unavailable), because a PayPal outage is a
recorded result HR is told about. Exits non-zero only when the job itself fails unexpectedly.
"""
import argparse
import logging
import sys
from typing import Optional

from sqlmodel import Session

from core.database import engine
from engine.services.reconcile_history import JOB_DAYS, RecordedRun, run_and_record

logger = logging.getLogger(__name__)


def run_once(db: Session, days: int) -> RecordedRun:
    return run_and_record(db, days=days, trigger="schedule")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Compare the payout ledger with PayPal and record it.")
    parser.add_argument("--days", type=int, default=JOB_DAYS,
                        help=f"Days to look back (1-30, default {JOB_DAYS}).")
    args = parser.parse_args(argv)
    if not 1 <= args.days <= 30:
        parser.error("--days must be between 1 and 30")

    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s %(message)s")
    try:
        with Session(engine) as db:
            recorded = run_once(db, args.days)
    except Exception:
        logger.exception("[RECONCILE] Daily run failed")
        return 1

    run = recorded.run
    print(
        f"[RECONCILE] {run.state}: reconciled {run.reconciled} of {run.total}, "
        f"pending {run.pending}, new {run.differences_new}, open {run.differences_open}"
        f"{' (mock)' if run.mock else ''}"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
