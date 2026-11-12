"""The demo difference seed: one open difference, one notification, and a clean reset."""
from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from sqlmodel import select

from core.enums import PayoutStatus, ReimbursementStatus, UserRole
from core.models import Notification, Payout, ReconciliationDifference, ReconciliationRun, Reimbursement, User
from engine.services import payout_service
from engine.services import reconcile_history as rh
from engine.services.reconcile_service import MismatchedPayout, ReconcileSummary
from seeds import seed_reconciliation_demo as demo

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


@pytest.fixture
def no_push(monkeypatch):
    monkeypatch.setattr(payout_service, "fire_and_forget_push", lambda *args, **kwargs: None)


@pytest.fixture
def db(pg_db):
    return pg_db


def _hr(db):
    user = User(email=f"hr-{uuid4().hex[:8]}@test.local", hashed_password="x", name="HR",
                role=UserRole.HR)
    db.add(user)
    db.commit()
    return user


def _claim_and_payout(db, at=NOW - timedelta(hours=6), batch="DEMOSEED-DEMO1",
                      status=PayoutStatus.SUCCEEDED):
    employee = User(email=f"demo-{uuid4().hex[:8]}@test.local", hashed_password="x", name="Demo Employee",
                    role=UserRole.Employee)
    db.add(employee)
    db.flush()
    reim = Reimbursement(user_id=employee.user_id, main_category="Transportation", currency="MYR",
                         total_claimed_amount=48.0, judgment="APPROVED", summary="Taxi",
                         status=ReimbursementStatus.PAID)
    db.add(reim)
    db.flush()
    payout = Payout(reim_id=reim.reim_id, user_id=employee.user_id, amount=48.0, currency="MYR",
                    status=status, provider_batch_id=batch, attempt=1,
                    idempotency_key="k", reference_id="r", channel_code="PAYPAL",
                    created_at=at, updated_at=at)
    db.add(payout)
    db.commit()
    return employee, reim, payout


def _notes(db):
    return list(db.exec(select(Notification).where(Notification.title == rh.NEW_TITLE)).all())


def test_demo_records_one_difference_and_notifies_hr(db, no_push):
    _hr(db)
    employee, reim, payout = _claim_and_payout(db)

    recorded, notified = demo.seed_demo(db, now=NOW)

    assert recorded.run.trigger == demo.DEMO_TRIGGER
    assert (recorded.run.differences_new, recorded.run.differences_open) == (1, 1)
    assert notified == 1
    difference = db.exec(select(ReconciliationDifference).where(
        ReconciliationDifference.payout_id == payout.payout_id)).one()
    assert (difference.kind, difference.payout_id, difference.employee_name) == (
        rh.MISSING_IN_PAYPAL, payout.payout_id, employee.name)
    assert len(_notes(db)) == 1
    db.refresh(payout)
    db.refresh(reim)
    assert payout.status == PayoutStatus.SUCCEEDED and reim.status == ReimbursementStatus.PAID


def test_running_the_demo_twice_does_not_duplicate(db, no_push):
    _hr(db)
    _, _, payout = _claim_and_payout(db)
    demo.seed_demo(db, now=NOW)

    second, notified = demo.seed_demo(db, now=NOW + timedelta(hours=1))

    assert second.run.differences_new == 0 and notified == 0
    rows = db.exec(select(ReconciliationDifference).where(
        ReconciliationDifference.payout_id == payout.payout_id)).all()
    assert len(rows) == 1
    assert len(_notes(db)) == 1


def test_clear_removes_only_the_demo_rows(db, no_push):
    _hr(db)
    _claim_and_payout(db)
    demo.seed_demo(db, now=NOW)
    real = rh.record_run(db, ReconcileSummary(state="no_data", days=3, checked_at=NOW),
                         trigger="schedule", started_at=NOW)

    differences, runs = demo.clear_demo(db)

    assert (differences, runs) == (1, 1)
    assert db.exec(select(ReconciliationRun).where(ReconciliationRun.trigger == demo.DEMO_TRIGGER)).all() == []
    assert db.exec(select(ReconciliationDifference)).all() == []
    assert db.get(ReconciliationRun, real.run.run_id) is not None


def test_a_requested_payout_is_not_used_for_the_demo(db):
    _claim_and_payout(db, status=PayoutStatus.REQUESTED)
    assert demo.seed_demo(db, now=NOW) is None


def test_a_real_difference_on_the_same_payout_is_untouched(db, no_push):
    employee, _, payout = _claim_and_payout(db)
    _hr(db)
    real = rh.record_run(
        db,
        ReconcileSummary(
            state="ok", reconciled=0, total=1, checked_at=NOW - timedelta(hours=1), days=3,
            mismatches=[MismatchedPayout(
                payout_id=payout.payout_id, reim_id=payout.reim_id, claim_ref="RC-REAL",
                employee_name=employee.name, amount=48.0, currency="MYR",
                created_at=payout.created_at)],
        ),
        trigger="schedule", started_at=NOW - timedelta(hours=1),
    )
    real_difference = real.new_differences[0]
    last_seen = real_difference.last_seen_at
    last_run = real_difference.last_run_id

    recorded, notified = demo.seed_demo(db, now=NOW)

    assert recorded.new_differences == [] and notified == 0
    db.expire_all()
    row = db.get(ReconciliationDifference, real_difference.difference_id)
    assert row.last_seen_at == last_seen and row.last_run_id == last_run
    removed, runs = demo.clear_demo(db)
    assert (removed, runs) == (0, 1)
    db.expire_all()
    row = db.get(ReconciliationDifference, real_difference.difference_id)
    assert row is not None and row.last_run_id == last_run


def test_clear_releases_a_demo_run_from_a_real_difference(db, no_push):
    employee_a, _, payout_a = _claim_and_payout(db, at=NOW - timedelta(hours=10))
    _hr(db)
    recorded, _ = demo.seed_demo(db, now=NOW)

    employee_b, _, payout_b = _claim_and_payout(db, at=NOW - timedelta(hours=2))
    real = rh.record_run(
        db,
        ReconcileSummary(
            state="ok", reconciled=0, total=1, checked_at=NOW, days=3,
            mismatches=[MismatchedPayout(
                payout_id=payout_b.payout_id, reim_id=payout_b.reim_id, claim_ref="RC-REAL",
                employee_name=employee_b.name, amount=48.0, currency="MYR",
                created_at=payout_b.created_at)],
        ),
        trigger="schedule", started_at=NOW,
    )
    real_difference = real.new_differences[0]
    real_difference.last_run_id = recorded.run.run_id
    db.add(real_difference)
    db.commit()

    removed, runs = demo.clear_demo(db)

    assert (removed, runs) == (1, 1)
    db.expire_all()
    row = db.get(ReconciliationDifference, real_difference.difference_id)
    assert row is not None and row.last_run_id is None


def test_the_demo_does_not_close_a_real_open_difference(db, no_push):
    _hr(db)
    employee_a, _, payout_a = _claim_and_payout(db, at=NOW - timedelta(hours=10))
    _claim_and_payout(db, at=NOW - timedelta(hours=2))
    from engine.services.reconcile_service import MismatchedPayout

    # Record the real difference through the normal path.
    rh.record_run(db, ReconcileSummary(
        state="ok", reconciled=0, total=1, checked_at=NOW - timedelta(hours=1), days=3,
        mismatches=[MismatchedPayout(
            payout_id=payout_a.payout_id, reim_id=payout_a.reim_id, claim_ref="RC-A",
            employee_name=employee_a.name, amount=48.0, currency="MYR",
            created_at=payout_a.created_at)],
    ), trigger="schedule", started_at=NOW - timedelta(hours=1))

    demo.seed_demo(db, now=NOW)

    real = db.exec(select(ReconciliationDifference).where(
        ReconciliationDifference.payout_id == payout_a.payout_id)).one()
    assert real.resolved_at is None


def test_without_a_payout_the_demo_does_nothing(db):
    assert demo.seed_demo(db, now=NOW) is None
