"""Batch approval: one PayPal batch per payout currency, per-item and per-group failures."""

import asyncio
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api import payouts as payouts_api
from api.rate_limit import limiter
from core import security
from core.enums import JudgmentResult, PayoutStatus, ReimbursementStatus, UserRole
from core.models import LineItem, Payout, Reimbursement, User
from engine.services import contracts as contract_service
from engine.services import payout_guard, payout_service
from engine.services.approvals import split_batch
from engine.services.paypal_client import (
    PayPalClient,
    PayPalError,
    PayoutCreated,
    PayoutItem,
    PayoutItemRequest,
    sender_batch_id_for,
    sender_batch_id_for_group,
)

NOW = datetime.now(timezone.utc)


@pytest.fixture
def client(pg_db, monkeypatch):
    from main import app

    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _user(db, role=UserRole.Employee, country="MY", name="Person", verified=True):
    user = User(
        email=f"{uuid4().hex[:8]}@test.local", name=name, role=role, country_code=country,
        hashed_password=security.get_password_hash("pw"),
        paypal_payer_id=f"PAYER{uuid4().hex[:6]}" if verified else None,
        paypal_email="person@example.test" if verified else None,
        paypal_verified=verified,
        paypal_linked_at=NOW if verified else None,
    )
    db.add(user)
    db.flush()
    return user


def _contract(db, hr, contractor, *, currency="IDR", country="ID"):
    return contract_service.create_contract(
        db, user_id=contractor.user_id, country_code=country, currency=currency,
        rate_amount=50, rate_unit="DAY", service_category="Consulting",
        categories=["Meals"], policy_id=None, max_company_amount_per_claim=5000,
        created_by=hr.user_id, effective_from=date(2026, 1, 1),
    )


def _claim(db, user, *, currency="MYR", approved=120, contract_id=None,
           status=ReimbursementStatus.APPROVED, tier="HR_QUICK", reasoning=None):
    reim = Reimbursement(
        user_id=user.user_id,
        contract_id=contract_id,
        main_category="Meals",
        currency=currency,
        total_claimed_amount=approved,
        total_approved_amount=approved if status != ReimbursementStatus.REVIEW else None,
        amount_company=approved,
        approved_company_amount=approved if status != ReimbursementStatus.REVIEW else None,
        judgment=JudgmentResult.APPROVED,
        status=status,
        tier=tier,
        summary="",
        ai_reasoning=reasoning or {},
        created_at=NOW,
        updated_at=NOW,
    )
    db.add(reim)
    db.flush()
    return reim


def _line(db, reim):
    db.add(LineItem(reim_id=reim.reim_id, description="Lunch", category="Meals",
                    claimed_amount=reim.total_claimed_amount, approved_amount=reim.total_claimed_amount,
                    currency=reim.currency, judgment=JudgmentResult.APPROVED))
    db.flush()


def _set_held(db, hr, currencies):
    contract_service.update_payout_settings(
        db, paypal_account_country="MY", held_currencies=currencies, actor=hr.user_id,
    )


class _FakePayPal:
    """Records one call per batch and can fail a whole currency or one item."""

    def __init__(self, fail_currency=None, item_status=None):
        self.fail_currency = fail_currency
        self.item_status = item_status or {}
        self.calls = []

    async def create_payout_batch(self, *, sender_batch_id, items):
        self.calls.append((sender_batch_id, list(items)))
        if self.fail_currency and items[0].currency == self.fail_currency:
            raise PayPalError(500, "SERVICE_UNAVAILABLE")
        batch_id = "MOCKB-" + str(len(self.calls)).rjust(3, "0")
        statuses = tuple(
            PayoutItem(
                item_id=f"MOCKI-{len(self.calls)}-{n}",
                transaction_status=self.item_status.get(item.sender_item_id, "PENDING"),
                sender_item_id=item.sender_item_id,
                error="RECEIVER_UNREGISTERED" if self.item_status.get(item.sender_item_id) == "FAILED" else None,
            )
            for n, item in enumerate(items, start=1)
        )
        return PayoutCreated(batch_id, "PENDING", statuses)


# --- sender keys ----------------------------------------------------------------------------------------


def test_the_group_key_is_short_deterministic_and_order_independent():
    ids = [uuid4(), uuid4(), uuid4()]
    key = sender_batch_id_for_group(ids, "IDR", 1)
    assert key == sender_batch_id_for_group(list(reversed(ids)), "IDR", 1)
    assert len(key) <= 30 and key.startswith("RCB-IDR-")
    # The old per-claim key is 37 characters and must not be copied for a group.
    assert len(sender_batch_id_for(ids[0], 1)) > 30
    assert key != sender_batch_id_for(ids[0], 1)


def test_the_group_key_changes_with_currency_attempt_and_set():
    a, b = uuid4(), uuid4()
    base = sender_batch_id_for_group([a, b], "IDR", 1)
    assert sender_batch_id_for_group([a, b], "USD", 1) != base
    assert sender_batch_id_for_group([a, b], "IDR", 2) != base
    assert sender_batch_id_for_group([a], "IDR", 1) != base


# --- one group and two currencies -----------------------------------------------------------------------


def test_one_currency_is_one_batch_with_a_row_per_claim(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    first = _user(pg_db, name="Aisyah")
    second = _user(pg_db, name="Daniel")
    claims = [_claim(pg_db, first), _claim(pg_db, second, approved=80)]
    pg_db.commit()
    fake = _FakePayPal()
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: fake)

    outcome = payout_service.initiate_batch_payout_sync(
        [c.reim_id for c in claims], pg_db,
    )

    assert len(fake.calls) == 1
    batch_key, items = fake.calls[0]
    assert {item.currency for item in items} == {"MYR"}
    assert {item.sender_item_id for item in items} == {str(c.reim_id) for c in claims}
    assert len(outcome.payouts) == 2
    assert {p.provider_batch_id for p in outcome.payouts} == {"MOCKB-001"}
    assert {p.idempotency_key for p in outcome.payouts} == {batch_key}
    rows = pg_db.exec(select(Payout).where(Payout.reim_id.in_([c.reim_id for c in claims]))).all()
    assert len(rows) == 2 and {p.currency for p in rows} == {"MYR"}


def test_two_currencies_create_two_batches(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    employee = _user(pg_db)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    _set_held(pg_db, hr, ["MYR", "USD"])
    myr = _claim(pg_db, employee)
    idr = _claim(pg_db, contractor, currency="IDR", approved=250_000, contract_id=contract.contract_id)
    pg_db.commit()
    fake = _FakePayPal()
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: fake)

    outcome = payout_service.initiate_batch_payout_sync([myr.reim_id, idr.reim_id], pg_db)

    assert [items[0].currency for _key, items in fake.calls] == ["MYR", "IDR"]
    assert all(len(items) == 1 for _key, items in fake.calls)
    assert len({key for key, _items in fake.calls}) == 2
    assert len({p.provider_batch_id for p in outcome.payouts}) == 2
    assert {(p.currency, float(p.amount)) for p in outcome.payouts} == {
        ("MYR", 120.0), ("IDR", 250_000.0),
    }


# --- mixed currency is refused before PayPal ------------------------------------------------------------


def test_a_mixed_currency_batch_raises_before_any_paypal_call():
    usd = payout_service.PlannedPayout(
        reim_id=uuid4(),
        destination=payout_service.PayoutDestination(
            payee=payout_service.Payee("CLAIM", "PAYER1", None, "A"),
            currency="USD", amount=Decimal("10.00"), payee_country="US",
        ),
        attempt=1,
    )
    with pytest.raises(payout_service.MixedCurrencyBatch):
        payout_service.assemble_batch("MYR", [usd])

    with pytest.raises(ValueError):
        payout_service.assemble_batch("MYR", [])

    requests = [
        PayoutItemRequest("PAYER1", Decimal("10.00"), "MYR", "one", "a"),
        PayoutItemRequest("PAYER2", Decimal("10.00"), "USD", "two", "b"),
    ]
    with pytest.raises(ValueError):
        asyncio.run(PayPalClient("https://paypal.test", "id", "secret").create_payout_batch(
            sender_batch_id="RCB-MYR-TEST", items=requests,
        ))


# --- retries, per-item failure and group failure --------------------------------------------------------


def test_a_duplicate_attempt_does_not_pay_again(pg_db, monkeypatch):
    employee = _user(pg_db)
    claim = _claim(pg_db, employee)
    pg_db.add(Payout(reim_id=claim.reim_id, user_id=employee.user_id, amount=120, currency="MYR",
                     status=PayoutStatus.ACCEPTED, provider="PAYPAL", provider_batch_id="MOCKB-OLD",
                     attempt=1, idempotency_key="RCB-OLD", reference_id="RC-OLD", channel_code="PAYPAL"))
    pg_db.commit()
    fake = _FakePayPal()
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: fake)

    outcome = payout_service.initiate_batch_payout_sync([claim.reim_id], pg_db)

    assert fake.calls == []
    assert outcome.payouts == []
    assert outcome.skipped[0]["reason"] == "SKIP_EXISTING"
    assert len(pg_db.exec(select(Payout).where(Payout.reim_id == claim.reim_id)).all()) == 1


def test_a_per_item_failure_is_recorded_on_that_claim_only(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    good = _user(pg_db, name="Aisyah")
    bad = _user(pg_db, name="Daniel")
    good_claim = _claim(pg_db, good)
    bad_claim = _claim(pg_db, bad, approved=80)
    pg_db.commit()
    fake = _FakePayPal(item_status={str(bad_claim.reim_id): "FAILED"})
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: fake)

    outcome = payout_service.initiate_batch_payout_sync([good_claim.reim_id, bad_claim.reim_id], pg_db)

    by_reim = {p.reim_id: p for p in outcome.payouts}
    assert by_reim[good_claim.reim_id].status == PayoutStatus.ACCEPTED
    assert by_reim[bad_claim.reim_id].status == PayoutStatus.FAILED
    assert by_reim[bad_claim.reim_id].failure_code == "RECEIVER_UNREGISTERED"
    assert {p.provider_batch_id for p in outcome.payouts} == {"MOCKB-001"}
    pg_db.refresh(good_claim)
    pg_db.refresh(bad_claim)
    assert good_claim.status == ReimbursementStatus.DISBURSING
    assert bad_claim.status == ReimbursementStatus.DISBURSEMENT_FAILED
    assert len(fake.calls) == 1


def test_a_failed_group_leaves_its_claims_approved_and_another_group_pays(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    employee = _user(pg_db)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    _set_held(pg_db, hr, ["MYR", "USD"])
    idr = _claim(pg_db, contractor, currency="IDR", approved=250_000, contract_id=contract.contract_id)
    myr = _claim(pg_db, employee)
    pg_db.commit()
    fake = _FakePayPal(fail_currency="IDR")
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: fake)

    outcome = payout_service.initiate_batch_payout_sync([idr.reim_id, myr.reim_id], pg_db)

    assert outcome.failed_currencies == ["IDR"]
    assert {p.currency for p in outcome.payouts} == {"MYR"}
    pg_db.refresh(idr)
    pg_db.refresh(myr)
    assert idr.status == ReimbursementStatus.APPROVED
    assert myr.status == ReimbursementStatus.DISBURSING
    assert pg_db.exec(select(Payout).where(Payout.reim_id == idr.reim_id)).all() == []
    assert len(pg_db.exec(select(Payout).where(Payout.reim_id == myr.reim_id)).all()) == 1


def test_one_refusal_does_not_abort_the_rest_of_its_currency_group(pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    employee = _user(pg_db, name="Malaysian")
    # The contract country wins over the user row, so this MYR payout is refused.
    contractor = _user(pg_db, role=UserRole.Contractor, country="MY")
    contract = _contract(pg_db, hr, contractor, currency="MYR", country="ID")
    _set_held(pg_db, hr, ["MYR"])
    refused = _claim(pg_db, contractor, contract_id=contract.contract_id, approved=50)
    paid = _claim(pg_db, employee)
    pg_db.commit()
    fake = _FakePayPal()
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: fake)

    outcome = payout_service.initiate_batch_payout_sync([refused.reim_id, paid.reim_id], pg_db)

    assert outcome.refused == [{"reim_id": str(refused.reim_id),
                                "reason": payout_guard.MYR_PAYEE_NOT_MALAYSIAN}]
    assert len(fake.calls) == 1
    _key, items = fake.calls[0]
    assert [item.sender_item_id for item in items] == [str(paid.reim_id)]
    [attempt] = pg_db.exec(select(Payout).where(Payout.reim_id == refused.reim_id)).all()
    assert attempt.status == "FAILED" and attempt.provider_batch_id is None
    pg_db.refresh(refused)
    pg_db.refresh(paid)
    assert refused.status == ReimbursementStatus.APPROVED
    assert paid.status == ReimbursementStatus.DISBURSING


# --- approval rules -------------------------------------------------------------------------------------


def test_contract_checks_and_existing_rules_gate_batch_approval():
    rows = [
        {"reim_id": "a", "tier": "HR_QUICK", "status": "REVIEW", "user_id": "u1", "kind": "CLAIM"},
        {"reim_id": "b", "tier": "HR_QUICK", "status": "REVIEW", "user_id": "u1", "kind": "CLAIM",
         "contract_reason": "OVER_CONTRACT_RATE"},
        {"reim_id": "c", "tier": "HR_QUICK", "status": "REVIEW", "user_id": "hr1", "kind": "CLAIM"},
        {"reim_id": "d", "tier": "HR_QUICK", "status": "REVIEW", "user_id": "u1", "kind": "VENDOR_BOOKING"},
    ]
    approved, skipped = split_batch(rows, "hr1")
    assert approved == ["a"]
    assert {s["reim_id"]: s["reason"] for s in skipped} == {
        "b": "CONTRACT_CHECK", "c": "SELF_APPROVAL", "d": "VENDOR_BOOKING",
    }


def test_batch_approval_commits_first_then_pays_by_currency(client, pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    employee = _user(pg_db)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    _set_held(pg_db, hr, ["MYR", "USD"])
    myr = _claim(pg_db, employee, status=ReimbursementStatus.REVIEW)
    idr = _claim(pg_db, contractor, currency="IDR", approved=250_000,
                 contract_id=contract.contract_id, status=ReimbursementStatus.REVIEW)
    _line(pg_db, myr)
    _line(pg_db, idr)
    pg_db.commit()
    fake = _FakePayPal()
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: fake)

    token = client.post("/api/v1/auth/login", data={"username": hr.email, "password": "pw"}).json()["access_token"]
    res = client.post(
        "/api/v1/reimbursements/batch-approve",
        json={"reim_ids": [str(myr.reim_id), str(idr.reim_id)]},
        headers={"Authorization": f"Bearer {token}"},
    )

    assert res.status_code == 200, res.text
    body = res.json()
    assert body["approved"] == [str(myr.reim_id), str(idr.reim_id)]
    assert body["skipped"] == []
    assert len(fake.calls) == 2
    pg_db.refresh(myr)
    pg_db.refresh(idr)
    assert myr.status == ReimbursementStatus.DISBURSING
    assert idr.status == ReimbursementStatus.DISBURSING
    assert idr.payout_currency == "IDR" and float(idr.payout_amount) == 250_000.0


def test_batch_approval_skips_a_contract_check_and_still_pays_the_rest(client, pg_db, monkeypatch):
    hr = _user(pg_db, role=UserRole.HR, verified=False)
    employee = _user(pg_db)
    contractor = _user(pg_db, role=UserRole.Contractor, country="ID")
    contract = _contract(pg_db, hr, contractor, currency="IDR", country="ID")
    _set_held(pg_db, hr, ["MYR", "USD"])
    ok = _claim(pg_db, employee, status=ReimbursementStatus.REVIEW)
    blocked = _claim(pg_db, contractor, currency="IDR", approved=250_000,
                     contract_id=contract.contract_id, status=ReimbursementStatus.REVIEW,
                     reasoning={"contract_reason": "CATEGORY_NOT_ALLOWED"})
    _line(pg_db, ok)
    _line(pg_db, blocked)
    pg_db.commit()
    fake = _FakePayPal()
    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: fake)

    token = client.post("/api/v1/auth/login", data={"username": hr.email, "password": "pw"}).json()["access_token"]
    body = client.post(
        "/api/v1/reimbursements/batch-approve",
        json={"reim_ids": [str(ok.reim_id), str(blocked.reim_id)]},
        headers={"Authorization": f"Bearer {token}"},
    ).json()

    assert body["approved"] == [str(ok.reim_id)]
    assert body["skipped"] == [{"reim_id": str(blocked.reim_id), "reason": "CONTRACT_CHECK"}]
    assert len(fake.calls) == 1 and fake.calls[0][1][0].currency == "MYR"
    pg_db.refresh(blocked)
    assert blocked.status == ReimbursementStatus.REVIEW


# --- ledger ---------------------------------------------------------------------------------------------


def test_the_ledger_row_names_both_currencies_and_the_company_amount():
    payout = Payout(reim_id=uuid4(), user_id=uuid4(), amount=250_000, currency="IDR",
                    status=PayoutStatus.ACCEPTED, provider_batch_id="MOCKB-1", attempt=1,
                    idempotency_key="RCB-IDR-1", reference_id="RC-1", channel_code="PAYPAL",
                    created_at=NOW, updated_at=NOW)
    reim = Reimbursement(reim_id=payout.reim_id, user_id=payout.user_id, main_category="Meals",
                         currency="USD", total_claimed_amount=120, total_approved_amount=120,
                         amount_company=564, approved_company_amount=564, judgment="APPROVED",
                         summary="")
    employee = User(user_id=payout.user_id, email="e@example.com", hashed_password="x", name="Aisyah")

    row = payouts_api.ledger_row(payout, reim, employee)

    assert row.amount == 250_000 and row.currency == "IDR"
    assert row.claim_currency == "USD"
    assert row.company_amount == 564.0
    assert row.provider_batch_id == "MOCKB-1"
