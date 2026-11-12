"""Concurrent auto-pay decisions against the employee caps and the company daily budget. Needs TEST_DATABASE_URL.

They commit through separate sessions, so instead of the rolled-back pg_db fixture each test deletes what it wrote.
"""
import os
import threading
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from uuid import UUID, uuid4

import pytest
from sqlalchemy import create_engine, func, text
from sqlmodel import Session, select

import engine.agents.compliance_agent as ca
from core.enums import ReimbursementStatus, UserRole
from core.models import AgentAction, Policy, Reimbursement, User
from engine.services import autonomy_store

JOIN_TIMEOUT = 15


@pytest.fixture
def pg():
    url = os.environ.get("TEST_DATABASE_URL")
    if not url:
        pytest.skip("TEST_DATABASE_URL not set")
    engine = create_engine(url, pool_size=8)
    with Session(engine) as s:
        autonomy_store.settings_row(s)
        s.exec(text("UPDATE autonomy_settings SET breaker_until = NULL, enabled = true"))
        s.commit()
        last_action = s.exec(select(func.coalesce(func.max(AgentAction.action_id), 0))).one()
        config = autonomy_store.get_config(s)
    made = SimpleNamespace(engine=engine, config=config, users=[], policies=[])
    try:
        yield made
    finally:
        with Session(engine) as s:
            # Deleting only the tail keeps the hash chain valid for the other DB tests.
            s.exec(text("DELETE FROM agent_actions WHERE action_id > :last").bindparams(last=last_action))
            mine = "SELECT reim_id FROM reimbursements WHERE user_id = :u"
            for uid in made.users:
                s.exec(text(f"DELETE FROM line_items WHERE reim_id IN ({mine})").bindparams(u=uid))
                s.exec(text(f"DELETE FROM reimbursement_sub_categories WHERE reim_id IN ({mine})").bindparams(u=uid))
                s.exec(text("DELETE FROM reimbursements WHERE user_id = :u").bindparams(u=uid))
            for pid in made.policies:
                s.exec(text("DELETE FROM policies WHERE policy_id = :p").bindparams(p=pid))
            for uid in made.users:
                s.exec(text("DELETE FROM employees WHERE user_id = :u").bindparams(u=uid))
            s.exec(text("UPDATE autonomy_settings SET breaker_until = NULL"))
            s.commit()
        engine.dispose()


def employee(pg, name):
    """A STANDARD employee (three paid claims, none of them auto-paid) with a verified PayPal payee."""
    with Session(pg.engine) as s:
        u = User(email=f"{name}-{uuid4().hex[:8]}@test.local", hashed_password="x", name=name, role=UserRole.Employee,
                 paypal_payer_id=f"PAYER{uuid4().hex[:6]}", paypal_email=f"{name}@gmail.com", paypal_verified=True,
                 paypal_linked_at=datetime.now(timezone.utc) - timedelta(days=30))
        s.add(u)
        s.commit()
        pg.users.append(u.user_id)
        old = datetime.now(timezone.utc) - timedelta(days=10)
        for _ in range(3):
            s.add(Reimbursement(user_id=u.user_id, main_category="Transportation", currency="MYR", judgment="APPROVED",
                                total_claimed_amount=20.0, status=ReimbursementStatus.PAID, summary="",
                                created_at=old, updated_at=old))
        s.commit()
        return u.user_id


def auto_paid(pg, user_id, amount, at=None):
    """An earlier claim that auto-paid today and counts toward the caps."""
    with Session(pg.engine) as s:
        s.add(Reimbursement(user_id=user_id, main_category="Transportation", currency="MYR", judgment="APPROVED",
                            total_claimed_amount=amount, total_approved_amount=amount, status=ReimbursementStatus.PAID,
                            tier="AUTO_PAY", summary="", updated_at=at or datetime.now(timezone.utc)))
        s.commit()


def policy(pg, owner_id):
    with Session(pg.engine) as s:
        p = Policy(alias=f"T-{uuid4().hex[:8]}", title="Cap race policy", effective_date=datetime.now(timezone.utc),
                   overview_summary="", mandatory_conditions="{}", source_file_url="", status="ACTIVE",
                   created_by=owner_id)
        s.add(p)
        s.commit()
        pg.policies.append(p.policy_id)
        return p.policy_id


def claim(user_id, policy_id, amount, judgment="APPROVED"):
    return {
        "settlement_id": "", "policy_id": str(policy_id), "main_category": "Transportation",
        "user_id": str(user_id), "all_category": ["Transportation"], "document_ids": [], "reim_id": str(uuid4()),
        "user": SimpleNamespace(role=UserRole.Employee, name="Employee", rank=1), "policy": None, "receipts": [],
        "combined_conditions": [], "currency": "MYR",
        "line_items": [{"document_id": "unknown", "category": "Transportation", "description": "Ride",
                        "status": judgment, "requested_amount": amount, "approved_amount": amount}],
        "totals": {"total_requested": amount, "net_approved": amount, "total_deduction": 0, "by_category": {}},
        "judgment": judgment, "confidence": 0.95, "summary": "", "signals": [], "reimbursement_id": "",
    }


def start(pg, state, results):
    def run():
        with Session(pg.engine) as s:
            try:
                out = ca.save_reimbursement(state, s)
                r = s.get(Reimbursement, UUID(out["reimbursement_id"]))
                results[state["reim_id"]] = (r.tier, r.autonomy["hard_stops"])
            except Exception as e:  # surfaced by the assertions below
                results[state["reim_id"]] = e

    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t


def finish(*threads):
    for t in threads:
        t.join(JOIN_TIMEOUT)
        assert not t.is_alive(), "decision did not finish"


@pytest.fixture
def side_by_side(monkeypatch):
    """Hold each thread after its first ledger read until the other has read too, or 1s has passed.

    Without serialisation both claims read the totals before either is saved, which is the race.
    """
    barrier = threading.Barrier(2, timeout=1)
    seen = threading.local()
    real = autonomy_store.ledger_snapshot

    def ledger_snapshot(db, now):
        ledger = real(db, now)
        if threading.current_thread() is not threading.main_thread() and not getattr(seen, "done", False):
            seen.done = True
            try:
                barrier.wait()
            except threading.BrokenBarrierError:
                pass
        return ledger

    monkeypatch.setattr(autonomy_store, "ledger_snapshot", ledger_snapshot)


def amount_for(pg):
    return round(pg.config.auto_limit_standard * 0.9, 2)


def test_two_claims_over_the_employee_daily_cap_pay_only_one(pg, side_by_side):
    amount = amount_for(pg)
    user = employee(pg, "aisyah")
    pol = policy(pg, user)
    # One more claim fits under the cap, two don't.
    auto_paid(pg, user, pg.config.employee_daily_cap - 1.5 * amount)
    results = {}
    first, second = claim(user, pol, amount), claim(user, pol, amount)
    finish(start(pg, first, results), start(pg, second, results))

    outcomes = sorted(results.values(), key=lambda r: r[0])
    assert [tier for tier, _ in outcomes] == ["AUTO_PAY", "HR_QUICK"], results
    assert outcomes[0][1] == [] and "EMPLOYEE_DAILY_CAP" in outcomes[1][1]


def test_two_employees_over_the_company_budget_pay_only_one(pg, side_by_side):
    amount = amount_for(pg)
    filler, aisyah, farid = employee(pg, "filler"), employee(pg, "aisyah"), employee(pg, "farid")
    pol = policy(pg, aisyah)
    now = datetime.now(timezone.utc)
    with Session(pg.engine) as s:
        spent = autonomy_store.ledger_snapshot(s, now).auto_paid_today
    room = pg.config.agent_daily_budget - spent
    if room < 2 * amount:
        pytest.skip("today's company budget is already used up in this database")
    # Older than an hour where possible, so the filler alone doesn't trip the hourly breaker.
    day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    auto_paid(pg, filler, room - 1.5 * amount, at=max(day_start, now - timedelta(minutes=61)))
    results = {}
    finish(start(pg, claim(aisyah, pol, amount), results), start(pg, claim(farid, pol, amount), results))

    outcomes = sorted(results.values(), key=lambda r: r[0])
    assert [tier for tier, _ in outcomes] == ["AUTO_PAY", "HR_QUICK"], results
    assert outcomes[0][1] == [] and "AGENT_DAILY_BUDGET" in outcomes[1][1]


def test_a_held_employee_lock_does_not_block_other_employees(pg):
    amount = amount_for(pg)
    aisyah, farid = employee(pg, "aisyah"), employee(pg, "farid")
    pol = policy(pg, aisyah)
    results = {}
    with Session(pg.engine) as holder:
        autonomy_store.lock_employee_budget(holder, aisyah)
        blocked = start(pg, claim(aisyah, pol, amount), results)
        other = claim(farid, pol, amount)
        finish(start(pg, other, results))
        assert results[other["reim_id"]] == ("AUTO_PAY", [])
        blocked.join(1)
        assert blocked.is_alive(), "a claim for the locked employee should wait"
        holder.rollback()
    finish(blocked)
    assert [r for r in results.values()] == [("AUTO_PAY", []), ("AUTO_PAY", [])]


def test_a_claim_bound_for_hr_does_not_wait_for_the_company_budget(pg):
    user = employee(pg, "aisyah")
    pol = policy(pg, user)
    results = {}
    with Session(pg.engine) as holder:
        autonomy_store.lock_company_budget(holder)
        state = claim(user, pol, amount_for(pg), judgment="REJECTED")
        finish(start(pg, state, results))
        holder.rollback()
    assert results[state["reim_id"]][0] == "HR_REVIEW"


def test_a_rolled_back_decision_releases_the_lock_and_the_budget(pg, monkeypatch):
    amount = amount_for(pg)
    user = employee(pg, "aisyah")
    pol = policy(pg, user)
    auto_paid(pg, user, pg.config.employee_daily_cap - 1.5 * amount)
    failing = claim(user, pol, amount)
    real = ca.record_action

    def record_action(db, action_type, actor, reim_id, payload):
        if str(reim_id) == failing["reim_id"]:
            raise RuntimeError("log write failed")
        return real(db, action_type, actor, reim_id, payload)

    monkeypatch.setattr(ca, "record_action", record_action)
    results = {}
    # The failed session stays open, so only the rollback can have released its locks.
    with Session(pg.engine) as s:
        with pytest.raises(RuntimeError):
            ca.save_reimbursement(failing, s)
        retry = claim(user, pol, amount)
        finish(start(pg, retry, results))
        assert results[retry["reim_id"]] == ("AUTO_PAY", [])
        assert s.get(Reimbursement, UUID(failing["reim_id"])) is None
