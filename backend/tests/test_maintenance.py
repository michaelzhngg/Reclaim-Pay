"""Payout maintenance sweep, stuck list, and the manual run surface."""
import asyncio
from datetime import datetime, timedelta, timezone
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import deps
from api import payouts as payouts_api
from api.rate_limit import limiter
from core.config import settings
from core.database import engine as app_engine
from core.enums import JudgmentResult, PayoutStatus, UserRole
from core.models import Payout, PayPalWebhookEvent, Reimbursement, User
from engine.jobs import maintenance
from engine.jobs.maintenance import (
    MaintenanceReport, PayoutSweepReport, refresh_stuck_payouts, run_maintenance, stuck_payouts,
)
from engine.services import webhook_events as webhook_svc
from engine.services.paypal_client import PayPalError
from engine.services.webhook_events import WebhookSweepReport

NOW = datetime(2026, 11, 12, 12, 0, tzinfo=timezone.utc)


def _seed(db):
    employee = User(email=f"emp-{uuid4().hex[:8]}@test.local", hashed_password="x", name="Employee")
    db.add(employee)
    db.commit()
    claim = Reimbursement(user_id=employee.user_id, main_category="Transportation", currency="MYR",
                          total_claimed_amount=48, judgment=JudgmentResult.APPROVED, summary="")
    db.add(claim)
    db.commit()

    def payout(status, batch, age_hours, provider="PAYPAL"):
        return Payout(reim_id=claim.reim_id, user_id=employee.user_id, amount=48, currency="MYR",
                      status=status, provider=provider, provider_batch_id=batch, attempt=1,
                      idempotency_key=f"key-{uuid4().hex}", reference_id="RC-TEST",
                      channel_code="PAYPAL", created_at=NOW - timedelta(hours=age_hours + 1),
                      updated_at=NOW - timedelta(hours=age_hours))

    old = payout(PayoutStatus.REQUESTED, "B1", 30)
    old_two = payout(PayoutStatus.ACCEPTED, "B2", 30)
    recent = payout(PayoutStatus.REQUESTED, "B3", 1)
    final = payout(PayoutStatus.SUCCEEDED, "B4", 30)
    demo = payout(PayoutStatus.ACCEPTED, "DEMOSEED-X", 30)
    other = payout(PayoutStatus.REQUESTED, "B5", 30, provider="XENDIT")
    db.add_all([old, old_two, recent, final, demo, other])
    db.commit()
    return employee, claim, old, old_two, recent, final, demo, other


async def _mark_succeeded(db, payout):
    payout.status = PayoutStatus.SUCCEEDED
    payout.updated_at = NOW
    db.add(payout)
    db.commit()
    return payout


def test_stuck_list_excludes_final_recent_and_other_providers(pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", True)
    employee, claim, old, old_two, recent, final, demo, other = _seed(pg_db)
    result = stuck_payouts(pg_db, now=NOW)
    ids = {row.payout_id for row in result.payouts}
    assert old.payout_id in ids and old_two.payout_id in ids and demo.payout_id in ids
    assert recent.payout_id not in ids and final.payout_id not in ids and other.payout_id not in ids
    demo_row = next(row for row in result.payouts if row.payout_id == demo.payout_id)
    assert demo_row.refreshable is False
    assert result.older_than_hours == settings.PAYOUT_STUCK_HOURS


def test_sweep_refreshes_only_refreshable_stale_payouts(pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", False)
    _, _, old, old_two, _, _, demo, _ = _seed(pg_db)
    calls = []

    async def fake(db, payout):
        calls.append(payout.payout_id)
        return await _mark_succeeded(db, payout)

    report = asyncio.run(refresh_stuck_payouts(pg_db, now=NOW, refresh=fake))
    assert report.checked == 3 and report.unrefreshable == 1
    assert report.refreshed == 2 and report.changed == 2 and report.still_open == 0
    assert set(calls) == {old.payout_id, old_two.payout_id}


def test_one_paypal_error_does_not_abort_the_sweep(pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", False)
    _, _, old, old_two, _, _, _, _ = _seed(pg_db)

    async def fake(db, payout):
        if payout.payout_id == old.payout_id:
            raise PayPalError(503, "SERVICE_UNAVAILABLE")
        return await _mark_succeeded(db, payout)

    report = asyncio.run(refresh_stuck_payouts(pg_db, now=NOW, refresh=fake))
    assert report.refreshed == 1 and report.errors == 1 and report.changed == 1


def test_mock_mode_refreshes_nothing(pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", True)
    _seed(pg_db)

    async def fake(db, payout):
        raise AssertionError("mock mode must not call PayPal")

    report = asyncio.run(refresh_stuck_payouts(pg_db, now=NOW, refresh=fake))
    assert report.mock is True and report.checked == 0


def test_run_maintenance_respects_an_existing_lock(pg_db, monkeypatch):
    monkeypatch.setattr(maintenance, "_try_lock", lambda db: False)
    report = asyncio.run(run_maintenance(pg_db, now=NOW))
    assert report.locked is True


def test_advisory_lock_is_held_per_connection(pg_db):
    # The pg_db fixture skips when TEST_DATABASE_URL is unset, as CI runs without it.
    engine = pg_db.get_bind().engine
    first = engine.connect()
    second = engine.connect()
    assert maintenance._try_lock(first) is True
    try:
        assert maintenance._try_lock(second) is False
    finally:
        maintenance._unlock(first)
        first.close()
        second.close()


def test_two_runs_cannot_overlap_and_lock_is_released(pg_db, monkeypatch):
    async def scenario():
        started = asyncio.Event()
        release = asyncio.Event()

        def fake_sweep(db, now, limit):
            db.commit()
            return WebhookSweepReport()

        async def fake_payouts(db, now, limit, refresh=None):
            started.set()
            await release.wait()
            return PayoutSweepReport()

        monkeypatch.setattr(maintenance, "sweep_events", fake_sweep)
        monkeypatch.setattr(maintenance, "refresh_stuck_payouts", fake_payouts)
        first = asyncio.create_task(run_maintenance(payout_limit=10))
        await asyncio.wait_for(started.wait(), 5)
        second = await run_maintenance(payout_limit=10)
        assert second.locked is True
        release.set()
        first_report = await asyncio.wait_for(first, 5)
        assert first_report.locked is False

    asyncio.run(scenario())
    probe = app_engine.connect()
    try:
        assert maintenance._try_lock(probe) is True
    finally:
        maintenance._unlock(probe)
        probe.close()


def test_run_maintenance_runs_both_sweeps(pg_db, monkeypatch):
    monkeypatch.setattr(maintenance, "sweep_events",
                        lambda db, now, limit: WebhookSweepReport(checked=1, processed=1))

    async def fake_payouts(db, now, limit, refresh=None):
        return PayoutSweepReport(refreshed=1)

    monkeypatch.setattr(maintenance, "refresh_stuck_payouts", fake_payouts)
    report = asyncio.run(run_maintenance(pg_db, now=NOW, payout_limit=10))
    assert report.locked is False
    assert report.webhooks.processed == 1
    assert report.payouts.refreshed == 1


def _user(db, role):
    user = User(email=f"{role.value.lower()}-{uuid4().hex[:8]}@test.local",
                hashed_password="x", name=role.value, role=role)
    db.add(user)
    db.commit()
    return user


def _app(db, user):
    app = FastAPI()
    app.state.limiter = limiter
    app.include_router(payouts_api.router, prefix="/payouts")
    app.dependency_overrides[deps.get_db] = lambda: db
    app.dependency_overrides[deps.get_current_user] = lambda: user
    return TestClient(app)


def test_stuck_and_maintenance_routes_are_hr_only(pg_db, monkeypatch):
    monkeypatch.setattr(settings, "PAYPAL_MOCK_MODE", True)
    _seed(pg_db)
    hr = _user(pg_db, UserRole.HR)
    employee = _user(pg_db, UserRole.Employee)

    assert _app(pg_db, hr).get("/payouts/stuck").status_code == 200
    assert _app(pg_db, employee).get("/payouts/stuck").status_code == 403

    async def fake_run(db, payout_limit):
        return MaintenanceReport(started_at=NOW, finished_at=NOW)

    monkeypatch.setattr(payouts_api, "run_maintenance", fake_run)
    response = _app(pg_db, hr).post("/payouts/maintenance/run")
    assert response.status_code == 200 and response.json()["locked"] is False
    assert _app(pg_db, employee).post("/payouts/maintenance/run").status_code == 403


def test_manual_run_reports_an_already_running_job(pg_db, monkeypatch):
    hr = _user(pg_db, UserRole.HR)

    async def locked(db, payout_limit):
        return MaintenanceReport(started_at=NOW, finished_at=NOW, locked=True)

    monkeypatch.setattr(payouts_api, "run_maintenance", locked)
    response = _app(pg_db, hr).post("/payouts/maintenance/run")
    assert response.status_code == 409


def test_webhook_sweep_retries_and_dead_letters(pg_db, monkeypatch):
    monkeypatch.setattr(settings, "WEBHOOK_MAX_ATTEMPTS", 2)

    failed = PayPalWebhookEvent(event_id=f"WH-{uuid4().hex}", event_type="CHECKOUT.ORDER.APPROVED",
                                status=webhook_svc.WebhookEventStatus.FAILED, attempts=1,
                                payload={"id": "x"})
    pg_db.add(failed)
    pg_db.commit()

    def boom(db, event):
        raise RuntimeError("boom")

    monkeypatch.setattr(webhook_svc, "dispatch_event", boom)
    report = webhook_svc.sweep_events(pg_db, now=NOW)
    assert report.dead_lettered == 1
    pg_db.expire_all()
    assert pg_db.get(PayPalWebhookEvent, failed.event_id).status == webhook_svc.WebhookEventStatus.DEAD_LETTER


def test_webhook_sweep_reclaims_a_stale_in_flight_row(pg_db, monkeypatch):
    stale = PayPalWebhookEvent(event_id=f"WH-{uuid4().hex}", event_type="CHECKOUT.ORDER.APPROVED",
                               status=webhook_svc.WebhookEventStatus.RECEIVED, attempts=1,
                               payload={"id": "x"}, updated_at=NOW - timedelta(hours=1))
    pg_db.add(stale)
    pg_db.commit()
    monkeypatch.setattr(webhook_svc, "dispatch_event", lambda db, event: webhook_svc.WebhookEventStatus.PROCESSED)
    report = webhook_svc.sweep_events(pg_db, now=NOW)
    assert report.processed == 1
