from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import deps
from api import paypal as paypal_api
from core.enums import PayoutStatus as P, ReimbursementStatus as R
from engine.services.payout_status import next_status, reim_status_for


def test_final_states_do_not_regress():
    assert next_status(P.SUCCEEDED, P.REQUESTED) == P.SUCCEEDED
    assert next_status(P.FAILED, P.SUCCEEDED) == P.FAILED
    assert next_status(P.REQUESTED, P.SUCCEEDED) == P.SUCCEEDED


def test_success_can_become_reversed():
    assert next_status(P.SUCCEEDED, P.REVERSED) == P.REVERSED


def test_reim_status_mapping():
    assert reim_status_for(P.SUCCEEDED) == R.PAID
    assert reim_status_for(P.FAILED) == R.DISBURSEMENT_FAILED
    assert reim_status_for(P.REVERSED) == R.DISBURSEMENT_FAILED
    assert reim_status_for(P.REQUESTED) is None


ITEM_EVENT = {
    "id": "WH-1",
    "event_type": "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    "resource": {"payout_item_id": "I1", "transaction_status": "SUCCESS",
                 "payout_item": {"sender_item_id": "12345678-1234-5678-1234-567812345678"}},
}


class _RejectingClient:
    async def verify_webhook(self, headers, event, webhook_id):
        return False


def _app(monkeypatch, mock_mode: bool):
    calls = []
    monkeypatch.setattr(paypal_api.settings, "PAYPAL_MOCK_MODE", mock_mode)
    monkeypatch.setattr(paypal_api, "get_paypal_client", lambda: _RejectingClient())
    app = FastAPI()
    app.include_router(paypal_api.router, prefix="/paypal")
    app.dependency_overrides[deps.get_db] = lambda: object()
    return TestClient(app), calls


def test_webhook_with_bad_signature_is_rejected(monkeypatch):
    client, _ = _app(monkeypatch, mock_mode=False)
    assert client.post("/paypal/webhook", json=ITEM_EVENT).status_code == 400


def test_webhook_without_event_id_is_rejected_before_handling(monkeypatch):
    client, _ = _app(monkeypatch, mock_mode=True)
    assert client.post("/paypal/webhook", json={"event_type": "CHECKOUT.ORDER.APPROVED"}).status_code == 400
    assert client.post("/paypal/webhook", json=[]).status_code == 400
    assert client.post("/paypal/webhook", content=b"{bad", headers={"content-type": "application/json"}).status_code == 400
