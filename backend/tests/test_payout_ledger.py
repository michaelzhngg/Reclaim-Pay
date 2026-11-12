from datetime import datetime, timezone
from uuid import UUID

from fastapi import FastAPI
from fastapi.testclient import TestClient

from api import deps
from api import payouts as payouts_api
from core.enums import PayoutStatus, UserRole
from core.models import Payout, Reimbursement, User

RID = UUID("12345678-1234-5678-1234-567812345678")
UID = UUID("87654321-4321-8765-4321-876543218765")
T = datetime(2026, 11, 3, 10, tzinfo=timezone.utc)


def _row():
    payout = Payout(reim_id=RID, user_id=UID, amount=48, currency="MYR", status=PayoutStatus.SUCCEEDED,
                    provider_batch_id="B1", provider_item_id="I1", attempt=1, idempotency_key="RC-x-1",
                    reference_id="RC-12345678", channel_code="PAYPAL", created_at=T, updated_at=T)
    reim = Reimbursement(reim_id=RID, user_id=UID, main_category="Transportation", currency="MYR",
                         total_claimed_amount=48, judgment="APPROVED", summary="")
    employee = User(user_id=UID, email="e@example.com", hashed_password="x", name="Aisyah")
    return payout, reim, employee


def test_ledger_row_shape():
    row = payouts_api.ledger_row(*_row())
    assert row.claim_ref == "RC-12345678" and row.employee_name == "Aisyah"
    assert row.status == PayoutStatus.SUCCEEDED and row.amount == 48.0 and row.attempt == 1
    assert row.claim_currency == "MYR" and row.company_amount == 48.0 and row.company_currency == "MYR"
    assert row.tier is None and row.audit_selected is False


class _FakeDB:
    def __init__(self, rows):
        self.rows = rows
        self.query = None

    def exec(self, query):
        self.query = query
        return self

    def all(self):
        return self.rows


def _client(role):
    db = _FakeDB([_row()])
    app = FastAPI()
    app.include_router(payouts_api.router, prefix="/payouts")
    app.dependency_overrides[deps.get_db] = lambda: db
    app.dependency_overrides[deps.get_current_user] = lambda: User(
        user_id=UID, email="hr@example.com", hashed_password="x", name="HR", role=role)
    return TestClient(app), db


def test_ledger_returns_rows_for_hr():
    client, db = _client(UserRole.HR)
    resp = client.get("/payouts/", params={"status": "SUCCEEDED", "from": "2026-11-01", "to": "2026-11-03"})
    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1 and body[0]["status"] == "SUCCEEDED" and "tier" in body[0]
    sql = str(db.query.compile(compile_kwargs={"literal_binds": True}))
    assert "LIMIT 500" in sql and "ORDER BY payouts.created_at DESC" in sql


def test_ledger_is_hr_only():
    client, _ = _client(UserRole.Employee)
    assert client.get("/payouts/").status_code == 403
