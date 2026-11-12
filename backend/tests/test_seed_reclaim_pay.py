from datetime import datetime, timezone
from statistics import median
from uuid import uuid4

from sqlalchemy import func
from sqlmodel import select

from core.enums import JudgmentResult, RecoveryStatus, ReimbursementStatus, UserRole
from core.models import LineItem, Payout, ReconciliationDifference, Recovery, Reimbursement, User
from engine.risk.autonomy import trust_tier
from engine.risk.types import AutonomyDecision, AutonomyTier, Severity, TrustTier
from engine.services import contracts as contract_service
from engine.services import payout_service
from engine.services.paypal_client import MockPayPalClient, PayPalError
from seeds.seed_reclaim_pay import (
    CONTRACTOR_DEMO_ACCOUNTS,
    CONTRACTOR_DEMO_BALANCES,
    DEMO_ACCOUNTS,
    SEED_CONTRACTOR_TAG,
    SEED_TAG,
    _payer_email,
    final_trust,
    generate_history,
    seed,
)

NOW = datetime(2026, 11, 3, tzinfo=timezone.utc)


def test_payer_email_comes_from_env(monkeypatch):
    monkeypatch.setenv("DEMO_PAYER_EMAIL_1", "sb-demo@personal.example.com")
    assert _payer_email(DEMO_ACCOUNTS[0]) == "sb-demo@personal.example.com"
    assert _payer_email(DEMO_ACCOUNTS[2]) is None  # HR accounts have no payer slot


def test_deterministic():
    assert generate_history(42, 120, NOW) == generate_history(42, 120, NOW)


def test_shape_and_mix():
    h = generate_history(42, 120, NOW)
    assert len(h) == 120
    assert 0.08 <= sum(c.bad for c in h) / 120 <= 0.12
    assert {c.tier for c in h} == set(AutonomyTier)
    assert all(10 <= c.amount <= 900 for c in h)
    assert 40 <= median(c.amount for c in h) <= 80
    assert all(1 <= c.days_ago <= 90 for c in h)


def test_has_split_pairs_and_near_threshold_claims():
    h = generate_history(42, 120, NOW)
    pairs = {(c.user_code, c.merchant, c.days_ago) for c in h if any(s.code.value == "SPLIT_CLAIM" for s in c.signals)}
    assert len(pairs) >= 3
    assert sum(any(s.code.value == "NEAR_THRESHOLD" for s in c.signals) for c in h) >= 5


def test_trust_levels_match_the_demo_accounts():
    trust = final_trust(generate_history(42, 120, NOW), NOW)
    assert trust["SWE123"] == TrustTier.STANDARD and trust["SWE124"] == TrustTier.STANDARD
    seeded = [trust[f"E{i:02d}"] for i in range(1, 13)]
    assert (seeded.count(TrustTier.NEW), seeded.count(TrustTier.STANDARD), seeded.count(TrustTier.TRUSTED)) == (3, 5, 4)
    # S8's open notice no longer cuts trust; E04 drops to NEW only once the recovery is executed.
    assert trust["E04"] == TrustTier.TRUSTED


def test_breaker_starts_clear():
    newest = sorted(generate_history(42, 120, NOW), key=lambda c: c.created_at)[-20:]
    assert not any(s.severity == Severity.HIGH for c in newest for s in c.signals)


def test_s8_claim_was_auto_paid_and_window_has_passed():
    s8 = next(c for c in generate_history(42, 120, NOW) if c.note == "s8")
    assert s8.user_code.startswith("E") and s8.tier == AutonomyTier.AUTO_PAY and s8.paid and s8.audit_selected
    assert s8.recovery.amount == 30.0 and s8.recovery.status == RecoveryStatus.NOTICE_SENT
    assert s8.recovery.dispute_until < NOW


def test_bad_claims_are_rejected_or_recovered():
    for c in generate_history(42, 120, NOW):
        if c.bad:
            assert c.status == ReimbursementStatus.REJECTED or c.recovery is not None


def _counts(db):
    tagged = Reimbursement.ai_reasoning.op("->>")("demo_seed") == SEED_TAG
    reim_ids = select(Reimbursement.reim_id).where(tagged)
    return {
        "users": db.exec(select(func.count()).select_from(User)).one(),
        "claims": db.exec(select(func.count()).select_from(Reimbursement).where(tagged)).one(),
        "payouts": db.exec(select(func.count()).select_from(Payout).where(Payout.reim_id.in_(reim_ids))).one(),
        "recoveries": db.exec(select(func.count()).select_from(Recovery).where(Recovery.reim_id.in_(reim_ids))).one(),
    }


def test_seed_twice_and_reset_keep_counts_stable(pg_db):
    from engine.services.autonomy_store import employee_history

    outsider = User(email=f"outsider-{uuid4().hex[:8]}@example.org", hashed_password="x", name="Not Demo",
                    role=UserRole.Employee)
    pg_db.add(outsider)
    pg_db.flush()
    outside_claim = Reimbursement(user_id=outsider.user_id, main_category="Meals", currency="MYR",
                                  total_claimed_amount=12.0, judgment=JudgmentResult.APPROVED, summary="real claim",
                                  status=ReimbursementStatus.PAID)
    pg_db.add(outside_claim)
    pg_db.commit()

    seed(pg_db, now=NOW)
    first = _counts(pg_db)
    assert first["claims"] == 120 and first["recoveries"] == 6
    assert first["payouts"] == sum(c.paid for c in generate_history(42, 120, NOW))

    seed(pg_db, now=NOW)
    assert _counts(pg_db) == first
    payout = pg_db.exec(select(Payout).join(
        Reimbursement, Reimbursement.reim_id == Payout.reim_id
    ).where(Reimbursement.ai_reasoning.op("->>")("demo_seed") == SEED_TAG)).first()
    difference = ReconciliationDifference(
        kind="MISSING_IN_PAYPAL", payout_id=payout.payout_id, reim_id=payout.reim_id,
        amount=48.0, currency="MYR", occurred_at=NOW, first_seen_at=NOW, last_seen_at=NOW,
    )
    pg_db.add(difference)
    pg_db.commit()
    difference_id = difference.difference_id
    seed(pg_db, reset=True, now=NOW)
    assert pg_db.get(ReconciliationDifference, difference_id) is None
    assert _counts(pg_db) == first
    seed(pg_db, reset=True, clear=True, now=NOW)
    assert _counts(pg_db) == first
    assert pg_db.get(Reimbursement, outside_claim.reim_id) is not None

    employee = pg_db.exec(select(User).where(User.email == "employee@example.com")).one()
    assert trust_tier(employee_history(pg_db, employee.user_id, NOW)) == TrustTier.STANDARD
    assert employee.paypal_verified and employee.paypal_payer_id and employee.payout_destination_changed_at is None
    assert {u.email for u in pg_db.exec(select(User).where(User.role == UserRole.HR.value)).all()} >= {
        "hr@example.com", "hr2@example.com"}

    stored = pg_db.exec(select(Reimbursement).where(Reimbursement.ai_reasoning.op("->>")("demo_seed") == SEED_TAG)).all()
    for r in stored:
        decision = AutonomyDecision.model_validate(r.autonomy)
        assert decision.tier.value == r.tier and decision.risk_score == r.risk_score

    recovery = pg_db.exec(select(Recovery).where(Recovery.status == RecoveryStatus.NOTICE_SENT.value)).one()
    assert float(recovery.amount) == 30.0 and recovery.dispute_until < NOW
    assert pg_db.get(Reimbursement, recovery.reim_id).audit_selected


def test_clear_takes_removes_live_demo_claims_only(pg_db):
    seed(pg_db, now=NOW)
    employee = pg_db.exec(select(User).where(User.email == "employee@example.com")).one()
    take = Reimbursement(user_id=employee.user_id, main_category="Transportation", currency="MYR",
                         total_claimed_amount=48.0, judgment=JudgmentResult.APPROVED, summary="S1 take",
                         status=ReimbursementStatus.PAID)
    pg_db.add(take)
    pg_db.commit()
    take_id = take.reim_id
    before = _counts(pg_db)
    seed(pg_db, clear=True, now=NOW)
    pg_db.expunge_all()
    assert pg_db.get(Reimbursement, take_id) is None
    assert _counts(pg_db) == before


# --- contractor currency demo (F5 ticket 08) ---------------------------------------------------------


def _contractor_rows(db):
    return db.exec(select(Reimbursement).where(
        Reimbursement.ai_reasoning.op("->>")("demo_seed") == SEED_CONTRACTOR_TAG)).all()


def _by_note(db):
    return {(r.ai_reasoning or {}).get("demo_note"): r for r in _contractor_rows(db)}


def _demo_user(db, code):
    account = next(a for a in CONTRACTOR_DEMO_ACCOUNTS if a.code == code)
    return db.exec(select(User).where(User.email == account.email)).one()


def test_seed_creates_the_contractor_currency_demo(pg_db):
    seed(pg_db, now=NOW)

    rows = _contractor_rows(pg_db)
    assert len(rows) == 4
    by_note = {r.ai_reasoning["demo_note"]: r for r in rows}
    assert set(by_note) == {"contractor-idr", "employee-myr", "refusal-myr", "contract-check"}
    for row in rows:
        assert row.status == ReimbursementStatus.REVIEW
        assert row.tier == "HR_QUICK"
        assert pg_db.exec(select(LineItem).where(LineItem.reim_id == row.reim_id)).all()

    c01, c02, c03 = (_demo_user(pg_db, code) for code in ("C01", "C02", "C03"))
    assert c01.role == UserRole.Contractor and c02.role == UserRole.Contractor
    assert c03.role == UserRole.Employee
    assert all(u.paypal_verified and u.paypal_payer_id for u in (c01, c02, c03))

    contract_c01 = contract_service.get_contract(pg_db, c01.user_id)
    contract_c02 = contract_service.get_contract(pg_db, c02.user_id)
    assert (contract_c01.currency, contract_c01.country_code) == ("IDR", "ID")
    assert (contract_c02.currency, contract_c02.country_code) == ("MYR", "ID")

    idr = by_note["contractor-idr"]
    assert idr.currency == "USD" and float(idr.amount_company) == 564.0
    assert idr.contract_id == contract_c01.contract_id
    myr = by_note["employee-myr"]
    assert myr.currency == "MYR" and myr.contract_id is None
    refused = by_note["refusal-myr"]
    assert refused.currency == "MYR" and refused.contract_id == contract_c02.contract_id
    blocked = by_note["contract-check"]
    assert blocked.ai_reasoning["contract_reason"] == "CATEGORY_NOT_ALLOWED"
    assert blocked.tier == "HR_QUICK"

    settings_row = contract_service.payout_settings_dict(pg_db)
    assert settings_row["paypal_account_country"] == "MY"
    assert settings_row["held_currencies"] == ["MYR", "USD"]
    assert CONTRACTOR_DEMO_BALANCES == '{"MYR": "25000", "USD": "4000"}'

    seed(pg_db, now=NOW)
    assert len(_contractor_rows(pg_db)) == 4
    seed(pg_db, reset=True, now=NOW)
    assert len(_contractor_rows(pg_db)) == 4
    assert contract_service.get_contract(pg_db, c01.user_id) is not None


def test_the_seeded_demo_pays_two_batches_and_refuses_the_bad_contract(pg_db):
    from api.reimbursements import _apply_status

    seed(pg_db, now=NOW)
    by_note = _by_note(pg_db)
    hr = pg_db.exec(select(User).where(User.email == "hr@example.com")).one()
    for note in ("contractor-idr", "employee-myr", "refusal-myr"):
        _apply_status(pg_db, by_note[note], ReimbursementStatus.APPROVED, hr)
    pg_db.commit()
    for note in ("contractor-idr", "employee-myr", "refusal-myr"):
        pg_db.refresh(by_note[note])

    outcome = payout_service.initiate_batch_payout_sync(
        [by_note["contractor-idr"].reim_id, by_note["employee-myr"].reim_id,
         by_note["refusal-myr"].reim_id],
        pg_db,
    )

    assert len({p.provider_batch_id for p in outcome.payouts}) == 2
    assert {(p.currency, float(p.amount)) for p in outcome.payouts} == {
        ("IDR", 1_920_000.0), ("MYR", 120.0),
    }
    assert outcome.refused == [{
        "reim_id": str(by_note["refusal-myr"].reim_id),
        "reason": "MYR_PAYEE_NOT_MALAYSIAN",
    }]
    pg_db.refresh(by_note["refusal-myr"])
    pg_db.refresh(by_note["contract-check"])
    assert by_note["refusal-myr"].status == ReimbursementStatus.APPROVED
    assert by_note["contract-check"].status == ReimbursementStatus.REVIEW
    [refused_attempt] = pg_db.exec(
        select(Payout).where(Payout.reim_id == by_note["refusal-myr"].reim_id)).all()
    assert refused_attempt.status == "FAILED" and refused_attempt.provider_batch_id is None


def test_a_rejected_idr_group_leaves_its_seeded_claim_approved(pg_db, monkeypatch):
    from api.reimbursements import _apply_status

    seed(pg_db, now=NOW)
    by_note = _by_note(pg_db)
    hr = pg_db.exec(select(User).where(User.email == "hr@example.com")).one()
    for note in ("contractor-idr", "employee-myr"):
        _apply_status(pg_db, by_note[note], ReimbursementStatus.APPROVED, hr)
    pg_db.commit()
    for note in ("contractor-idr", "employee-myr"):
        pg_db.refresh(by_note[note])

    class _FailIdr:
        def __init__(self):
            self._inner = MockPayPalClient()

        async def create_payout_batch(self, *, sender_batch_id, items):
            if items[0].currency == "IDR":
                raise PayPalError(500, "SERVICE_UNAVAILABLE")
            return await self._inner.create_payout_batch(sender_batch_id=sender_batch_id, items=items)

    monkeypatch.setattr(payout_service, "get_paypal_client", lambda: _FailIdr())
    outcome = payout_service.initiate_batch_payout_sync(
        [by_note["contractor-idr"].reim_id, by_note["employee-myr"].reim_id], pg_db,
    )

    assert outcome.failed_currencies == ["IDR"]
    assert {p.currency for p in outcome.payouts} == {"MYR"}
    pg_db.refresh(by_note["contractor-idr"])
    pg_db.refresh(by_note["employee-myr"])
    assert by_note["contractor-idr"].status == ReimbursementStatus.APPROVED
    assert by_note["employee-myr"].status == ReimbursementStatus.DISBURSING
    assert pg_db.exec(select(Payout).where(
        Payout.reim_id == by_note["contractor-idr"].reim_id)).all() == []
