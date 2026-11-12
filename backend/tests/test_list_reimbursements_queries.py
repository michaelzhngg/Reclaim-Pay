from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import event, text

from api import deps
from core.enums import UserRole
from core.models import (
    Department, LineItem, Payout, Policy, Reimbursement, SettlementReceipt, TravelSettlement, User,
)


@pytest.fixture
def env(pg_db):
    from main import app

    db = pg_db
    db.exec(text("DELETE FROM payouts"))
    dept = Department(name=f"Ops-{uuid4().hex[:6]}")
    db.add(dept)
    db.commit()
    hr = User(email=f"hr-{uuid4().hex[:8]}@test.local", hashed_password="x", name="HR", role=UserRole.HR)
    emp = User(email=f"emp-{uuid4().hex[:8]}@test.local", hashed_password="x", name="Emp",
               role=UserRole.Employee, department_id=dept.department_id, paypal_payer_id="PAYER1")
    db.add_all([hr, emp])
    db.commit()
    policy = Policy(alias=f"p-{uuid4().hex[:8]}", title="Travel policy", effective_date=datetime.now(timezone.utc),
                    overview_summary="", mandatory_conditions="", source_file_url="", created_by=hr.user_id)
    db.add(policy)
    db.commit()
    app.dependency_overrides[deps.get_db] = lambda: db
    hr_id = hr.user_id
    # Load the viewer per request, as real auth does, so expunging between calls is safe.
    app.dependency_overrides[deps.get_current_user] = lambda: db.get(User, hr_id)
    try:
        yield TestClient(app), db, emp, policy
    finally:
        app.dependency_overrides.clear()


def _seed(db, emp, policy, n):
    base = datetime.now(timezone.utc) + timedelta(days=1)
    ids = []
    for i in range(n):
        s = TravelSettlement(user_id=emp.user_id, purpose="Trip")
        db.add(s)
        db.commit()
        db.add_all([SettlementReceipt(settlement_id=s.settlement_id, merchant_name=m) for m in (" Cafe ", "Hotel", "Cafe")])
        at = base + timedelta(minutes=i)
        r = Reimbursement(user_id=emp.user_id, policy_id=policy.policy_id, settlement_id=s.settlement_id,
                          main_category="Meals", currency="MYR", total_claimed_amount=10 + i, judgment="APPROVED",
                          status="APPROVED", created_at=at, updated_at=at)
        db.add(r)
        db.commit()
        db.add_all([LineItem(reim_id=r.reim_id, description="x", category="Meals", claimed_amount=5, currency="MYR") for _ in range(i % 3)])
        for k, status in enumerate(("FAILED", "SUCCEEDED")[: i % 3]):
            db.add(Payout(reim_id=r.reim_id, user_id=emp.user_id, amount=10, currency="MYR", status=status,
                          idempotency_key=uuid4().hex, reference_id=uuid4().hex, channel_code="PAYPAL",
                          created_at=at + timedelta(seconds=k)))
        db.commit()
        ids.append(r.reim_id)
    return ids


def _count_queries(db, call):
    db.expunge_all()
    seen = []
    listener = lambda *args: seen.append(1)  # noqa: E731
    bind = db.get_bind()
    event.listen(bind, "before_cursor_execute", listener)
    try:
        result = call()
    finally:
        event.remove(bind, "before_cursor_execute", listener)
    return result, len(seen)


def test_list_query_count_does_not_grow_with_rows(env):
    client, db, emp, policy = env
    _seed(db, emp, policy, 12)

    few, few_queries = _count_queries(db, lambda: client.get("/api/v1/reimbursements/?limit=3").json())
    many, many_queries = _count_queries(db, lambda: client.get("/api/v1/reimbursements/?limit=12").json())

    assert len(few) == 3 and len(many) == 12
    assert many_queries == few_queries


def test_list_rows_match_the_single_claim_view(env):
    client, db, emp, policy = env
    _seed(db, emp, policy, 6)

    listed = client.get("/api/v1/reimbursements/?limit=6").json()
    for row in listed:
        single = client.get(f"/api/v1/reimbursements/{row['reim_id']}").json()
        for key in ("employee_name", "department_name", "policy_name", "merchant_names", "payout",
                    "receipt_count", "employee_code", "payee_linked"):
            assert row.get(key) == single.get(key), key
    by_count = {row["receipt_count"] for row in listed}
    assert by_count == {0, 1, 2}
    assert {row["payout"]["status"] for row in listed if "payout" in row} == {"FAILED", "SUCCEEDED"}
    assert all(row["merchant_names"] == ["Cafe", "Hotel"] for row in listed)
