"""Contractor contracts, category policy checks and company payout setup. Needs TEST_DATABASE_URL."""

from datetime import date, datetime, timedelta, timezone
from uuid import UUID, uuid4

import pytest
from fastapi.testclient import TestClient
from sqlmodel import select

from api import deps
from api.rate_limit import limiter
from core import security
from core.enums import PolicyStatus, UserRole
from core.models import (
    ContractorContract,
    ContractorContractCategory,
    Policy,
    PolicyReimbursableCategory,
    User,
)
from engine.services import contracts as service

NOW = datetime(2026, 11, 12, 9, 0, tzinfo=timezone.utc)


@pytest.fixture
def client(pg_db, monkeypatch):
    from main import app

    monkeypatch.setattr(limiter, "enabled", False)
    app.dependency_overrides[deps.get_db] = lambda: pg_db
    yield TestClient(app)
    app.dependency_overrides.clear()


def _person(db, role=UserRole.Contractor, name="Person"):
    user = User(
        email=f"{uuid4().hex[:8]}@test.local",
        name=name,
        role=role,
        hashed_password=security.get_password_hash("pw"),
    )
    db.add(user)
    db.commit()
    db.refresh(user)
    return user


def _login(client, user):
    res = client.post("/api/v1/auth/login", data={"username": user.email, "password": "pw"})
    assert res.status_code == 200, res.text
    return {"Authorization": f"Bearer {res.json()['access_token']}"}


def _policy(db, owner, categories=("Meals", "Transportation", "Accommodation")):
    policy = Policy(
        alias=f"P-{uuid4().hex[:8]}", title="Contractor policy",
        effective_date=NOW - timedelta(days=1), overview_summary="", mandatory_conditions="{}",
        source_file_url="", status=PolicyStatus.ACTIVE, created_by=owner.user_id,
    )
    db.add(policy)
    db.flush()
    for category in categories:
        db.add(PolicyReimbursableCategory(policy_id=policy.policy_id, category=category))
    db.flush()
    return policy


def _body(user, policy=None, **overrides):
    body = {
        "user_id": str(user.user_id),
        "country_code": "ID",
        "currency": "IDR",
        "rate_amount": 250000,
        "rate_unit": "DAY",
        "service_category": "Consulting",
        "categories": ["Meals", "Transportation"],
        "max_company_amount_per_claim": 1500,
        "policy_id": str(policy.policy_id) if policy else None,
        "effective_from": "2026-01-01",
    }
    body.update(overrides)
    return body


def test_hr_creates_a_contract_with_country_currency_rate_and_categories(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    policy = _policy(pg_db, hr)

    res = client.post("/api/v1/contracts/", json=_body(contractor, policy), headers=_login(client, hr))
    assert res.status_code == 201, res.text
    data = res.json()
    assert data["user_id"] == str(contractor.user_id)
    assert data["country_code"] == "ID" and data["country_name"] == "Indonesia"
    assert data["currency"] == "IDR" and data["currency_name"] == "Indonesian Rupiah"
    assert data["rate_amount"] == 250000 and data["rate_unit"] == "DAY"
    assert data["categories"] == ["Meals", "Transportation"]
    assert data["policy_id"] == str(policy.policy_id)
    assert data["max_company_amount_per_claim"] == 1500
    assert data["effective_from"] == "2026-01-01"

    listed = client.get("/api/v1/contracts/", headers=_login(client, hr)).json()
    assert [row["user_id"] for row in listed] == [str(contractor.user_id)]
    assert listed[0]["contract"]["contract_id"] == data["contract_id"]


def test_a_second_contract_for_the_same_contractor_is_refused(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    headers = _login(client, hr)
    assert client.post("/api/v1/contracts/", json=_body(contractor), headers=headers).status_code == 201
    again = client.post("/api/v1/contracts/", json=_body(contractor), headers=headers)
    assert again.status_code == 409
    assert "CONTRACT_EXISTS" in again.json()["detail"]


def test_contract_categories_must_exist_in_the_chosen_policy(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    policy = _policy(pg_db, hr, categories=("Meals",))
    res = client.post(
        "/api/v1/contracts/",
        json=_body(contractor, policy, categories=["Meals", "Software"]),
        headers=_login(client, hr),
    )
    assert res.status_code == 422
    assert "CATEGORY_NOT_IN_POLICY" in res.json()["detail"]
    assert "Software" in res.json()["detail"]


def test_the_service_category_is_not_required_to_be_in_the_policy(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    policy = _policy(pg_db, hr, categories=("Meals",))
    res = client.post(
        "/api/v1/contracts/",
        json=_body(contractor, policy, service_category="Design services", categories=["Meals"]),
        headers=_login(client, hr),
    )
    assert res.status_code == 201, res.text
    assert res.json()["service_category"] == "Design services"


def test_a_contract_is_only_for_a_contractor(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    employee = _person(pg_db, role=UserRole.Employee)
    res = client.post("/api/v1/contracts/", json=_body(employee), headers=_login(client, hr))
    assert res.status_code == 422
    assert "NOT_A_CONTRACTOR" in res.json()["detail"]


@pytest.mark.parametrize("field, value, code", [
    ("country_code", "ZZ", "COUNTRY_UNSUPPORTED"),
    ("currency", "XYZ", "CURRENCY_UNSUPPORTED"),
    ("rate_unit", "FORTNIGHT", "RATE_UNIT_INVALID"),
    ("rate_amount", 0, "AMOUNT_INVALID"),
    ("max_company_amount_per_claim", -1, "AMOUNT_INVALID"),
    ("categories", [], "CATEGORIES_REQUIRED"),
    ("service_category", "  ", "SERVICE_CATEGORY_REQUIRED"),
])
def test_invalid_contract_values_are_refused(client, pg_db, field, value, code):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    res = client.post(
        "/api/v1/contracts/", json=_body(contractor, **{field: value}), headers=_login(client, hr)
    )
    assert res.status_code == 422
    assert code in res.json()["detail"]


def test_hr_edits_the_existing_contract(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    policy = _policy(pg_db, hr)
    headers = _login(client, hr)
    created = client.post("/api/v1/contracts/", json=_body(contractor), headers=headers).json()

    res = client.patch(
        f"/api/v1/contracts/{created['contract_id']}",
        json={"currency": "USD", "rate_amount": 30, "categories": ["Meals"], "policy_id": str(policy.policy_id)},
        headers=headers,
    )
    assert res.status_code == 200, res.text
    data = res.json()
    assert data["currency"] == "USD" and data["rate_amount"] == 30
    assert data["categories"] == ["Meals"]
    assert data["policy_id"] == str(policy.policy_id)
    assert pg_db.exec(select(ContractorContract)).all()[0].contract_id == UUID(created["contract_id"])


def test_editing_the_policy_rechecks_the_stored_categories(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    headers = _login(client, hr)
    created = client.post(
        "/api/v1/contracts/", json=_body(contractor, categories=["Meals"]), headers=headers
    ).json()
    narrow = _policy(pg_db, hr, categories=("Transportation",))
    res = client.patch(
        f"/api/v1/contracts/{created['contract_id']}",
        json={"policy_id": str(narrow.policy_id)},
        headers=headers,
    )
    assert res.status_code == 422 and "CATEGORY_NOT_IN_POLICY" in res.json()["detail"]


def test_contractor_reads_only_their_own_contract(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    other = _person(pg_db)
    headers = _login(client, hr)
    client.post("/api/v1/contracts/", json=_body(contractor), headers=headers)

    mine = client.get("/api/v1/contracts/me", headers=_login(client, contractor))
    assert mine.status_code == 200
    assert mine.json()["user_id"] == str(contractor.user_id)

    no_contract = client.get("/api/v1/contracts/me", headers=_login(client, other))
    assert no_contract.status_code == 404 and no_contract.json()["detail"] == "NO_ACTIVE_CONTRACT"

    assert client.get("/api/v1/contracts/me", headers=_login(client, hr)).status_code == 403
    employee = _person(pg_db, role=UserRole.Employee)
    assert client.get("/api/v1/contracts/me", headers=_login(client, employee)).status_code == 403


def test_only_hr_can_create_or_list_contracts(client, pg_db):
    contractor = _person(pg_db)
    hr = _person(pg_db, role=UserRole.HR)
    headers = _login(client, contractor)
    assert client.get("/api/v1/contracts/", headers=headers).status_code == 403
    assert client.post("/api/v1/contracts/", json=_body(contractor), headers=headers).status_code == 403


def test_active_contract_respects_the_window_and_switch(pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    contract = service.create_contract(
        pg_db, user_id=contractor.user_id, country_code="ID", currency="IDR",
        rate_amount=100, rate_unit="DAY", service_category="Consulting", categories=["Meals"],
        max_company_amount_per_claim=500, created_by=hr.user_id,
        effective_from=date(2026, 1, 1), effective_to=date(2026, 12, 31),
    )
    assert service.active_contract(pg_db, contractor.user_id, NOW) == contract
    assert service.active_contract(pg_db, contractor.user_id, datetime(2027, 1, 1, tzinfo=timezone.utc)) is None

    contract.is_active = False
    pg_db.add(contract)
    pg_db.commit()
    assert service.active_contract(pg_db, contractor.user_id, NOW) is None


def test_company_payout_setup_defaults_and_changes(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    contractor = _person(pg_db)
    headers = _login(client, hr)

    defaults = client.get("/api/v1/contracts/payout-settings", headers=headers)
    assert defaults.status_code == 200
    assert defaults.json()["paypal_account_country"] == "MY"
    assert defaults.json()["paypal_account_country_name"] == "Malaysia"
    assert defaults.json()["held_currencies"] == ["MYR"]

    changed = client.put(
        "/api/v1/contracts/payout-settings",
        json={"paypal_account_country": "MY", "held_currencies": ["MYR", "usd", "USD"]},
        headers=headers,
    )
    assert changed.status_code == 200, changed.text
    assert changed.json()["held_currencies"] == ["MYR", "USD"]

    assert client.get("/api/v1/contracts/payout-settings",
                      headers=_login(client, contractor)).status_code == 403


def test_payout_setup_refuses_an_unknown_currency_or_empty_list(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    headers = _login(client, hr)
    for currencies in ([], ["XYZ"]):
        res = client.put(
            "/api/v1/contracts/payout-settings",
            json={"held_currencies": currencies},
            headers=headers,
        )
        assert res.status_code == 422


def test_contract_options_come_from_the_service_table(client, pg_db):
    hr = _person(pg_db, role=UserRole.HR)
    res = client.get("/api/v1/contracts/options", headers=_login(client, hr))
    assert res.status_code == 200
    data = res.json()
    assert {"code": "MY", "name": "Malaysia"} in data["countries"]
    assert {"code": "IDR", "name": "Indonesian Rupiah"} in data["currencies"]
    assert data["rate_units"] == ["HOUR", "DAY", "MONTH", "PROJECT"]
