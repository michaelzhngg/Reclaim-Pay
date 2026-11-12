"""Dead-letter lifecycle and the HR event-retry surface."""
from uuid import uuid4

from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api import paypal as paypal_api
from core.config import settings
from core.enums import AgentActionType, UserRole, WebhookEventStatus
from core.models import AgentAction, PayPalWebhookEvent, User
from engine.services import webhook_events as svc


def _user(db, role):
    user = User(email=f"{role.value.lower()}-{uuid4().hex[:8]}@test.local",
                hashed_password="x", name=role.value, role=role)
    db.add(user)
    db.commit()
    return user


def _app(db, user):
    app = FastAPI()
    app.include_router(paypal_api.router, prefix="/paypal")
    app.dependency_overrides[deps.get_db] = lambda: db
    app.dependency_overrides[deps.get_current_user] = lambda: user
    return TestClient(app)


def _event(event_id=None):
    return {"id": event_id or f"WH-{uuid4().hex}",
            "event_type": "CHECKOUT.ORDER.APPROVED", "resource": {}}


def _fail(db, event):
    raise RuntimeError("webhook handler exploded")


def _succeed(db, event):
    return WebhookEventStatus.PROCESSED


def test_failure_dead_letters_at_cap_and_hr_can_retry(pg_db, monkeypatch):
    hr = _user(pg_db, UserRole.HR)
    client = _app(pg_db, hr)
    event = _event()
    monkeypatch.setattr(settings, "WEBHOOK_MAX_ATTEMPTS", 3)
    monkeypatch.setattr(svc, "dispatch_event", _fail)

    for attempt in range(3):
        response = client.post("/paypal/webhook", json=event)
        assert response.status_code == (500 if attempt < 2 else 200)

    pg_db.expire_all()
    row = pg_db.get(PayPalWebhookEvent, event["id"])
    assert row.status == WebhookEventStatus.DEAD_LETTER
    assert row.attempts == 3 and "webhook handler exploded" in row.error
    dead_letters = pg_db.exec(select(AgentAction).where(
        AgentAction.action_type == AgentActionType.WEBHOOK_DEAD_LETTER.value)).all()
    assert len(dead_letters) == 1

    monkeypatch.setattr(svc, "dispatch_event", _succeed)
    response = client.post(f"/paypal/events/{event['id']}/retry")
    assert response.status_code == 200
    assert response.json()["status"] == "PROCESSED"
    pg_db.expire_all()
    row = pg_db.get(PayPalWebhookEvent, event["id"])
    assert row.status == WebhookEventStatus.PROCESSED and row.attempts == 1
    retries = pg_db.exec(select(AgentAction).where(
        AgentAction.action_type == AgentActionType.WEBHOOK_RETRY.value)).all()
    assert len(retries) == 1 and retries[0].actor == str(hr.user_id)


def test_failed_manual_retry_stays_dead_lettered(pg_db, monkeypatch):
    hr = _user(pg_db, UserRole.HR)
    client = _app(pg_db, hr)
    event = _event()
    monkeypatch.setattr(settings, "WEBHOOK_MAX_ATTEMPTS", 1)
    monkeypatch.setattr(svc, "dispatch_event", _fail)
    assert client.post("/paypal/webhook", json=event).status_code == 200

    response = client.post(f"/paypal/events/{event['id']}/retry")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "DEAD_LETTER" and body["attempts"] == 1
    pg_db.expire_all()
    assert pg_db.get(PayPalWebhookEvent, event["id"]).status == WebhookEventStatus.DEAD_LETTER


def test_retry_rejects_processed_events_and_unknown_ids(pg_db, monkeypatch):
    hr = _user(pg_db, UserRole.HR)
    client = _app(pg_db, hr)
    event = _event()
    monkeypatch.setattr(svc, "dispatch_event", _succeed)
    assert client.post("/paypal/webhook", json=event).status_code == 200

    assert client.post(f"/paypal/events/{event['id']}/retry").status_code == 409
    assert client.post(f"/paypal/events/{uuid4().hex}/retry").status_code == 404


def test_event_list_defaults_to_dead_letter_and_hides_payload(pg_db):
    hr = _user(pg_db, UserRole.HR)
    client = _app(pg_db, hr)
    dead = PayPalWebhookEvent(event_id=f"WH-{uuid4().hex}", event_type="CHECKOUT.ORDER.APPROVED",
                              status=WebhookEventStatus.DEAD_LETTER, attempts=5, error="boom",
                              payload={"id": "secret-payload"})
    failed = PayPalWebhookEvent(event_id=f"WH-{uuid4().hex}", event_type="CHECKOUT.ORDER.APPROVED",
                                status=WebhookEventStatus.FAILED, attempts=1, payload={})
    pg_db.add_all([dead, failed])
    pg_db.commit()

    response = client.get("/paypal/events")
    assert response.status_code == 200
    body = response.json()
    assert [row["event_id"] for row in body] == [dead.event_id]
    assert "payload" not in body[0] and body[0]["error"] == "boom"

    failed_body = client.get("/paypal/events", params={"status": "FAILED"}).json()
    assert [row["event_id"] for row in failed_body] == [failed.event_id]


def test_employees_cannot_see_or_retry_events(pg_db):
    employee = _user(pg_db, UserRole.Employee)
    client = _app(pg_db, employee)
    assert client.get("/paypal/events").status_code == 403
    assert client.post(f"/paypal/events/{uuid4().hex}/retry").status_code == 403
