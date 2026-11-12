"""Ledger reconciliation history: the record, the difference lifecycle and the HR endpoints."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import delete
from sqlmodel import select

from api import deps
from api import payouts as payouts_api
from core.enums import PayoutStatus, ReimbursementStatus, UserRole
from core.models import Notification, Payout, ReconciliationDifference, ReconciliationRun, Reimbursement, User
from engine.services import payout_service
from engine.services import reconcile_history as rh
from engine.services.reconcile_service import (
    MismatchedPayout, ReconcileSummary, Transaction, TransactionFeed, UnknownTransaction,
)

NOW = datetime(2026, 11, 12, 2, 0, tzinfo=timezone.utc)


@pytest.fixture
def db(pg_db):
    # Rows left by other suites are not this suite's input. Committed so a service rollback
    # (failure recording) cannot bring them back inside this test.
    pg_db.exec(delete(ReconciliationDifference))
    pg_db.exec(delete(ReconciliationRun))
    pg_db.commit()
    return pg_db


def _claim_and_payout(db, created_at=NOW - timedelta(hours=6), status=PayoutStatus.SUCCEEDED):
    employee = User(
        email=f"recon-{uuid4().hex[:8]}@test.local", hashed_password="x", name="Aisyah",
        role=UserRole.Employee,
    )
    db.add(employee)
    db.flush()
    reim = Reimbursement(
        user_id=employee.user_id, main_category="Transportation", currency="MYR",
        total_claimed_amount=48.0, judgment="APPROVED", summary="Taxi",
        status=ReimbursementStatus.PAID,
    )
    db.add(reim)
    db.flush()
    payout = Payout(
        reim_id=reim.reim_id, user_id=employee.user_id, amount=48.0, currency="MYR",
        status=status, provider_batch_id="BATCH-1", attempt=1, idempotency_key="k",
        reference_id="r", channel_code="PAYPAL", created_at=created_at, updated_at=created_at,
    )
    db.add(payout)
    db.commit()
    return employee, reim, payout


def _mismatch(payout, employee, at):
    return MismatchedPayout(
        payout_id=payout.payout_id, reim_id=payout.reim_id,
        claim_ref="RC-TEST", employee_name=employee.name, amount=48.0, currency="MYR",
        created_at=at,
    )


def _summary(*, at=NOW, days=3, mismatches=(), unknown=(), state="ok", reconciled=0, total=0,
             pending=0):
    return ReconcileSummary(
        state=state, reconciled=reconciled, total=total, pending=pending,
        mismatches=list(mismatches), unknown_in_paypal=list(unknown), days=days,
        checked_at=at, data_through=at, mock=False,
    )


def test_observed_differences_splits_missing_and_unknown():
    at = NOW - timedelta(hours=1)
    summary = _summary(
        mismatches=[MismatchedPayout(payout_id=uuid4(), reim_id=uuid4(), claim_ref="RC-1",
                                     employee_name="A", amount=10, currency="MYR", created_at=at)],
        unknown=[UnknownTransaction(transaction_id="T1", amount=7, currency="MYR", occurred_at=at)],
    )
    rows = rh.observed_differences(summary)
    assert [row.kind for row in rows] == [rh.MISSING_IN_PAYPAL, rh.UNKNOWN_IN_PAYPAL]
    assert rows[0].key == (rh.MISSING_IN_PAYPAL, str(rows[0].payout_id))
    assert rows[1].key == (rh.UNKNOWN_IN_PAYPAL, "T1")


def test_non_ok_summaries_report_no_differences():
    assert rh.observed_differences(_summary(state="unavailable")) == []
    assert rh.observed_differences(_summary(state="no_data")) == []


def test_should_close_only_when_unseen_and_inside_the_window():
    row = ReconciliationDifference(
        kind=rh.MISSING_IN_PAYPAL, payout_id=uuid4(), amount=10, currency="MYR",
        occurred_at=NOW - timedelta(hours=1), first_seen_at=NOW, last_seen_at=NOW,
    )
    key = rh.difference_key(row.kind, row.payout_id)
    assert rh.should_close(row, set(), NOW - timedelta(days=3)) is True
    assert rh.should_close(row, {key}, NOW - timedelta(days=3)) is False
    assert rh.should_close(row, set(), NOW) is False


def test_repeat_run_updates_one_open_row(db):
    employee, _, payout = _claim_and_payout(db)
    mismatch = _mismatch(payout, employee, payout.created_at)

    first = rh.record_run(db, _summary(mismatches=[mismatch], total=1),
                          trigger="manual", started_at=NOW)
    second_at = NOW + timedelta(hours=1)
    second = rh.record_run(db, _summary(at=second_at, mismatches=[mismatch], total=1),
                           trigger="schedule", started_at=second_at)

    assert first.run.differences_new == 1 and first.run.differences_open == 1
    assert second.run.differences_new == 0 and second.run.differences_open == 1
    assert len(db.exec(select(ReconciliationDifference)).all()) == 1
    row = db.exec(select(ReconciliationDifference)).one()
    assert row.first_seen_at == NOW and row.last_seen_at == second_at
    assert row.first_run_id == first.run.run_id and row.last_run_id == second.run.run_id


def test_a_later_match_closes_the_difference(db):
    employee, _, payout = _claim_and_payout(db)
    mismatch = _mismatch(payout, employee, payout.created_at)
    rh.record_run(db, _summary(mismatches=[mismatch], total=1), trigger="manual", started_at=NOW)

    later = NOW + timedelta(hours=1)
    result = rh.record_run(db, _summary(at=later, reconciled=1, total=1),
                           trigger="schedule", started_at=later)

    row = db.exec(select(ReconciliationDifference)).one()
    assert row.resolution == rh.MATCHED and row.resolved_at == later
    assert result.run.differences_open == 0


def test_a_difference_older_than_the_window_stays_open(db):
    employee, _, payout = _claim_and_payout(db, created_at=NOW - timedelta(days=4))
    mismatch = _mismatch(payout, employee, payout.created_at)
    rh.record_run(db, _summary(mismatches=[mismatch], total=1), trigger="manual", started_at=NOW)

    result = rh.record_run(db, _summary(at=NOW + timedelta(days=1), total=0),
                           trigger="schedule", started_at=NOW + timedelta(days=1))

    row = db.exec(select(ReconciliationDifference)).one()
    assert row.resolved_at is None
    assert result.run.differences_open == 1


@pytest.mark.parametrize("state", ["no_data", "unavailable"])
def test_runs_that_compare_nothing_leave_differences_alone(db, state):
    employee, _, payout = _claim_and_payout(db)
    mismatch = _mismatch(payout, employee, payout.created_at)
    rh.record_run(db, _summary(mismatches=[mismatch], total=1), trigger="manual", started_at=NOW)

    later = NOW + timedelta(hours=1)
    result = rh.record_run(db, _summary(at=later, state=state, total=1),
                           trigger="schedule", started_at=later)

    row = db.exec(select(ReconciliationDifference)).one()
    assert row.resolved_at is None and result.run.differences_open == 1


def test_a_run_never_changes_the_payout_or_the_claim(db):
    employee, reim, payout = _claim_and_payout(db)
    mismatch = _mismatch(payout, employee, payout.created_at)
    before = (payout.status, payout.amount, reim.status, reim.total_approved_amount)

    rh.record_run(db, _summary(mismatches=[mismatch], total=1), trigger="manual", started_at=NOW)

    db.refresh(payout)
    db.refresh(reim)
    assert (payout.status, payout.amount, reim.status, reim.total_approved_amount) == before


def test_a_failed_run_is_recorded_without_touching_differences(db):
    employee, _, payout = _claim_and_payout(db)
    mismatch = _mismatch(payout, employee, payout.created_at)
    rh.record_run(db, _summary(mismatches=[mismatch], total=1), trigger="manual", started_at=NOW)

    run = rh.record_failure(db, trigger="schedule", started_at=NOW + timedelta(hours=1), days=3,
                            error="RuntimeError")

    assert (run.state, run.error) == ("failed", "RuntimeError")
    assert run.differences_open == 1
    row = db.exec(select(ReconciliationDifference)).one()
    assert row.resolved_at is None


def test_run_and_record_compares_then_records(db, monkeypatch):
    from engine.services import reconcile_service
    monkeypatch.setattr(reconcile_service.settings, "PAYPAL_MOCK_MODE", False)
    employee, _, payout = _claim_and_payout(db)

    def feed(start, end):
        return TransactionFeed([Transaction("OTHER", -1, "MYR", NOW, "T0001")], NOW)

    recorded = rh.run_and_record(db, days=3, trigger="schedule", now=NOW, fetch=feed)
    assert (recorded.run.state, recorded.run.total, recorded.run.differences_new) == ("ok", 1, 2)
    missing = db.exec(select(ReconciliationDifference).where(
        ReconciliationDifference.kind == rh.MISSING_IN_PAYPAL)).one()
    assert missing.payout_id == payout.payout_id and missing.employee_name == employee.name


def test_run_and_record_records_an_unexpected_failure_and_reraises(db, monkeypatch):
    from engine.services import reconcile_service
    monkeypatch.setattr(reconcile_service.settings, "PAYPAL_MOCK_MODE", False)
    _claim_and_payout(db)

    def boom(start, end):
        raise RuntimeError("sdk exploded")

    with pytest.raises(RuntimeError):
        rh.run_and_record(db, days=3, trigger="schedule", now=NOW, fetch=boom)
    run = db.exec(select(ReconciliationRun)).one()
    assert (run.state, run.error) == ("failed", "RuntimeError")


def test_history_returns_latest_last_success_and_open_differences(db):
    employee, _, payout = _claim_and_payout(db)
    mismatch = _mismatch(payout, employee, payout.created_at)
    rh.record_run(db, _summary(mismatches=[mismatch], total=1), trigger="manual", started_at=NOW)
    rh.record_run(db, _summary(at=NOW + timedelta(hours=1), state="unavailable", total=1),
                  trigger="schedule", started_at=NOW + timedelta(hours=1))

    found = rh.history(db, limit=10)
    assert found.latest.state == "unavailable"
    assert found.last_success_at == NOW
    assert len(found.runs) == 2
    assert [row.kind for row in found.open_differences] == [rh.MISSING_IN_PAYPAL]


def _client(role, db=None):
    app = FastAPI()
    app.include_router(payouts_api.router, prefix="/payouts")
    if db is not None:
        app.dependency_overrides[deps.get_db] = lambda: db
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=uuid4(), email="u@example.com", hashed_password="x", name="U", role=role)
    return TestClient(app)


def test_new_routes_are_hr_only():
    assert _client(UserRole.Employee).get("/payouts/reconcile/history").status_code == 403
    assert _client(UserRole.Employee).post("/payouts/reconcile/run").status_code == 403


def test_run_endpoint_returns_the_recorded_run(monkeypatch):
    run = ReconciliationRun(
        run_id=uuid4(), started_at=NOW, finished_at=NOW, window_start=NOW - timedelta(days=3),
        window_end=NOW, state="no_data", message="No paid payouts in this period.",
    )
    monkeypatch.setattr(
        payouts_api, "run_and_record",
        lambda db, **kwargs: SimpleNamespace(run=run),
    )
    response = _client(UserRole.HR).post("/payouts/reconcile/run")
    assert response.status_code == 200
    body = response.json()
    assert body["run_id"] == str(run.run_id) and body["state"] == "no_data"


def test_history_endpoint_returns_the_view(monkeypatch):
    run = ReconciliationRun(
        run_id=uuid4(), started_at=NOW, finished_at=NOW, window_start=NOW - timedelta(days=3),
        window_end=NOW, state="ok", reconciled=1, total=1, differences_open=1,
    )
    difference = ReconciliationDifference(
        difference_id=uuid4(), kind=rh.MISSING_IN_PAYPAL, payout_id=uuid4(), reim_id=uuid4(),
        amount=48, currency="MYR", employee_name="Aisyah", occurred_at=NOW,
        first_seen_at=NOW, last_seen_at=NOW,
    )
    monkeypatch.setattr(
        payouts_api, "reconciliation_history",
        lambda db, limit: rh.History(latest=run, last_success_at=NOW, runs=[run],
                                     open_differences=[difference]),
    )
    response = _client(UserRole.HR).get("/payouts/reconcile/history")
    assert response.status_code == 200
    body = response.json()
    assert body["latest"]["run_id"] == str(run.run_id)
    assert body["open_differences"][0]["kind"] == rh.MISSING_IN_PAYPAL
    assert body["last_success_at"] == "2026-11-12T02:00:00Z"


def _hr(db, active=True):
    user = User(email=f"hr-{uuid4().hex[:8]}@test.local", hashed_password="x", name="HR",
                role=UserRole.HR, is_active=active)
    db.add(user)
    db.commit()
    return user


def _notes(db, title):
    return list(db.exec(select(Notification).where(Notification.title == title)).all())


@pytest.fixture
def no_push(monkeypatch):
    monkeypatch.setattr(payout_service, "fire_and_forget_push", lambda *args, **kwargs: None)


def test_new_differences_notify_active_hr_only(db, no_push):
    employee, _, payout = _claim_and_payout(db)
    hr1, hr2 = _hr(db), _hr(db)
    _hr(db, active=False)
    _claim_and_payout(db)  # a second employee must never be notified
    recorded = rh.record_run(db, _summary(mismatches=[_mismatch(payout, employee, payout.created_at)],
                                         total=1), trigger="schedule", started_at=NOW)

    assert rh.notify_hr(db, recorded) == 2
    notes = _notes(db, rh.NEW_TITLE)
    assert {note.user_id for note in notes} == {hr1.user_id, hr2.user_id}
    assert all(note.link == rh.RECONCILE_LINK and note.type == "error" for note in notes)
    assert "1 payout marked paid is not in PayPal" in notes[0].message


def test_unchanged_open_differences_do_not_notify_again(db, no_push):
    employee, _, payout = _claim_and_payout(db)
    _hr(db)
    mismatch = _mismatch(payout, employee, payout.created_at)
    first = rh.record_run(db, _summary(mismatches=[mismatch], total=1), trigger="schedule", started_at=NOW)
    rh.notify_hr(db, first)
    second_at = NOW + timedelta(hours=1)
    second = rh.record_run(db, _summary(at=second_at, mismatches=[mismatch], total=1),
                           trigger="schedule", started_at=second_at)

    assert rh.notify_hr(db, second) == 0
    assert len(_notes(db, rh.NEW_TITLE)) == 1


def test_a_reopened_difference_notifies_again(db, no_push):
    employee, _, payout = _claim_and_payout(db)
    _hr(db)
    mismatch = _mismatch(payout, employee, payout.created_at)
    first = rh.record_run(db, _summary(mismatches=[mismatch], total=1), trigger="schedule", started_at=NOW)
    rh.notify_hr(db, first)
    closed = rh.record_run(db, _summary(at=NOW + timedelta(hours=1), reconciled=1, total=1),
                           trigger="schedule", started_at=NOW + timedelta(hours=1))
    rh.notify_hr(db, closed)
    reopened = rh.record_run(db, _summary(at=NOW + timedelta(hours=2), mismatches=[mismatch], total=1),
                             trigger="schedule", started_at=NOW + timedelta(hours=2))
    rh.notify_hr(db, reopened)

    assert reopened.run.differences_new == 1
    assert len(_notes(db, rh.NEW_TITLE)) == 2


def test_an_outage_alerts_once_and_rearms_after_a_good_run(db, no_push):
    _hr(db)
    first = rh.record_run(db, _summary(state="unavailable", total=1), trigger="schedule", started_at=NOW)
    assert rh.notify_hr(db, first) == 1
    again = rh.record_run(db, _summary(at=NOW + timedelta(hours=1), state="unavailable", total=1),
                          trigger="schedule", started_at=NOW + timedelta(hours=1))
    assert rh.notify_hr(db, again) == 0
    good = rh.record_run(db, _summary(at=NOW + timedelta(hours=2), state="no_data", total=0),
                         trigger="schedule", started_at=NOW + timedelta(hours=2))
    assert rh.notify_hr(db, good) == 0
    later = rh.record_run(db, _summary(at=NOW + timedelta(hours=3), state="unavailable", total=1),
                          trigger="schedule", started_at=NOW + timedelta(hours=3))
    assert rh.notify_hr(db, later) == 1
    assert len(_notes(db, rh.OUTAGE_TITLE)) == 2


def test_unknown_only_differences_are_a_warning(db, no_push):
    _hr(db)
    unknown = UnknownTransaction(transaction_id="T-UNKNOWN", amount=12, currency="MYR", occurred_at=NOW)
    recorded = rh.record_run(db, _summary(unknown=[unknown], total=0), trigger="schedule", started_at=NOW)

    assert rh.notify_hr(db, recorded) == 1
    (note,) = _notes(db, rh.NEW_TITLE)
    assert note.type == "warning" and "no matching claim" in note.message


def test_a_notification_failure_does_not_fail_the_run(db, monkeypatch):
    employee, _, payout = _claim_and_payout(db)
    _hr(db)
    mismatch = _mismatch(payout, employee, payout.created_at)
    summary = _summary(mismatches=[mismatch], total=1)
    monkeypatch.setattr(rh, "reconcile", lambda *args, **kwargs: summary)

    def explode(*args, **kwargs):
        raise RuntimeError("push store down")

    monkeypatch.setattr(rh, "notify", explode)
    recorded = rh.run_and_record(db, days=3, trigger="schedule", now=NOW)

    assert recorded.run.state == "ok" and recorded.run.differences_new == 1
    assert db.exec(select(ReconciliationDifference)).one().resolved_at is None


def test_a_failed_run_notifies_hr_once(db, monkeypatch, no_push):
    _claim_and_payout(db)
    _hr(db)
    from engine.services import reconcile_service
    monkeypatch.setattr(reconcile_service.settings, "PAYPAL_MOCK_MODE", False)

    def boom(start, end):
        raise RuntimeError("sdk exploded")

    with pytest.raises(RuntimeError):
        rh.run_and_record(db, days=3, trigger="schedule", now=NOW, fetch=boom)

    (note,) = _notes(db, rh.OUTAGE_TITLE)
    assert "failed before it could compare" in note.message
