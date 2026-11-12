"""Webhook ledger tests. Postgres-backed because the unique insert is the replay fence."""
import os
import time
from datetime import datetime, timezone
from threading import Barrier, Lock, Thread
from uuid import uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy import create_engine, text
from sqlmodel import Session, select

from api import deps
from api import paypal as paypal_api
from core.enums import AgentActionType, JudgmentResult, PayoutStatus, WebhookEventStatus
from core.models import AgentAction, PayPalWebhookEvent, Payout, Reimbursement, User
from engine.services import webhook_events as svc


def _client(monkeypatch, db, mock_mode=True):
    monkeypatch.setattr(paypal_api.settings, "PAYPAL_MOCK_MODE", mock_mode)
    app = FastAPI()
    app.include_router(paypal_api.router, prefix="/paypal")
    app.dependency_overrides[deps.get_db] = lambda: db
    return TestClient(app)


def _seed_payout(db):
    employee = User(email=f"emp-{uuid4().hex[:8]}@test.local", hashed_password="x", name="Employee")
    db.add(employee)
    db.commit()
    claim = Reimbursement(
        user_id=employee.user_id, main_category="Transportation", currency="MYR",
        total_claimed_amount=48, judgment=JudgmentResult.APPROVED, summary="",
    )
    db.add(claim)
    db.commit()
    payout = Payout(
        reim_id=claim.reim_id, user_id=employee.user_id, amount=48, currency="MYR",
        status=PayoutStatus.REQUESTED, provider="PAYPAL", provider_batch_id="B1",
        provider_item_id="I1", attempt=1, idempotency_key=f"key-{claim.reim_id}",
        reference_id="RC-TEST", channel_code="PAYPAL",
    )
    db.add(payout)
    db.commit()
    return claim, payout


def _item_event(claim):
    return {
        "id": f"WH-{uuid4().hex}",
        "event_type": "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
        "resource": {
            "payout_item_id": "I1",
            "transaction_status": "SUCCESS",
            "payout_item": {"sender_item_id": str(claim.reim_id)},
        },
    }


def test_duplicate_event_is_recorded_once_and_does_not_repeat_side_effects(pg_db, monkeypatch):
    claim, payout = _seed_payout(pg_db)
    client = _client(monkeypatch, pg_db)
    event = _item_event(claim)

    first = client.post("/paypal/webhook", json=event)
    second = client.post("/paypal/webhook", json=event)

    assert first.status_code == 200 and first.json() == {"status": "ok"}
    assert second.status_code == 200 and second.json() == {"status": "duplicate"}
    pg_db.expire_all()
    rows = pg_db.exec(select(PayPalWebhookEvent)).all()
    assert len(rows) == 1 and rows[0].status == WebhookEventStatus.PROCESSED
    assert pg_db.get(Payout, payout.payout_id).status == PayoutStatus.SUCCEEDED
    actions = pg_db.exec(select(AgentAction).where(
        AgentAction.action_type == AgentActionType.PAYOUT_STATUS.value,
        AgentAction.reim_id == claim.reim_id,
    )).all()
    assert len(actions) == 1


def test_handler_failure_is_retried_on_the_next_delivery(pg_db, monkeypatch):
    claim, _ = _seed_payout(pg_db)
    client = _client(monkeypatch, pg_db)
    event = _item_event(claim)
    calls = []

    def fail(db, payload):
        calls.append(payload)
        raise RuntimeError("temporary failure")

    monkeypatch.setattr(svc, "dispatch_event", fail)
    assert client.post("/paypal/webhook", json=event).status_code == 500
    pg_db.expire_all()
    row = pg_db.get(PayPalWebhookEvent, event["id"])
    assert row.status == WebhookEventStatus.FAILED
    assert "temporary failure" in row.error

    def succeed(db, payload):
        calls.append(payload)
        return WebhookEventStatus.PROCESSED

    monkeypatch.setattr(svc, "dispatch_event", succeed)
    assert client.post("/paypal/webhook", json=event).status_code == 200
    pg_db.expire_all()
    row = pg_db.get(PayPalWebhookEvent, event["id"])
    assert row.status == WebhookEventStatus.PROCESSED and row.error is None
    assert len(calls) == 2


def test_unknown_event_is_stored_as_ignored(pg_db, monkeypatch):
    client = _client(monkeypatch, pg_db)
    event = {"id": f"WH-{uuid4().hex}", "event_type": "CHECKOUT.ORDER.APPROVED", "resource": {}}
    response = client.post("/paypal/webhook", json=event)
    assert response.status_code == 200 and response.json() == {"status": "ignored"}
    pg_db.expire_all()
    row = pg_db.get(PayPalWebhookEvent, event["id"])
    assert row.status == WebhookEventStatus.IGNORED


def test_rejected_deliveries_write_no_ledger_row(pg_db, monkeypatch):
    client = _client(monkeypatch, pg_db, mock_mode=False)

    class Rejecting:
        async def verify_webhook(self, headers, event, webhook_id):
            return False

    monkeypatch.setattr(paypal_api, "get_paypal_client", lambda: Rejecting())
    event = {"id": f"WH-{uuid4().hex}", "event_type": "CHECKOUT.ORDER.APPROVED", "resource": {}}
    assert client.post("/paypal/webhook", json=event).status_code == 400
    pg_db.expire_all()
    assert pg_db.exec(select(PayPalWebhookEvent)).all() == []


def test_concurrent_duplicate_claims_once(pg_db, monkeypatch):
    url = os.environ["TEST_DATABASE_URL"]
    engine = create_engine(url)
    event = {"id": f"WH-{uuid4().hex}", "event_type": "CHECKOUT.ORDER.APPROVED", "resource": {}}
    calls = []
    guard = Lock()
    barrier = Barrier(2)

    def slow_dispatch(db, payload):
        with guard:
            calls.append(payload["id"])
        time.sleep(0.2)
        return WebhookEventStatus.PROCESSED

    monkeypatch.setattr(svc, "dispatch_event", slow_dispatch)

    def worker():
        barrier.wait()
        with Session(engine) as session:
            svc.ingest_event(session, event)

    threads = [Thread(target=worker) for _ in range(2)]
    try:
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=10)
        with Session(engine) as session:
            rows = session.exec(select(PayPalWebhookEvent).where(
                PayPalWebhookEvent.event_id == event["id"])).all()
            assert len(rows) == 1 and rows[0].status == WebhookEventStatus.PROCESSED
        assert calls == [event["id"]]
    finally:
        with Session(engine) as session:
            session.exec(text("DELETE FROM paypal_webhook_events WHERE event_id = :id").bindparams(id=event["id"]))
            session.commit()
        engine.dispose()
