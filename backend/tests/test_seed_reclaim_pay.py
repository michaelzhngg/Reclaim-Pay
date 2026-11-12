from datetime import datetime, timezone
from statistics import median
from uuid import uuid4

from sqlalchemy import func
from sqlmodel import select

from core.enums import JudgmentResult, RecoveryStatus, ReimbursementStatus, UserRole
from core.models import Payout, Recovery, Reimbursement, User
from engine.risk.autonomy import trust_tier
from engine.risk.types import AutonomyDecision, AutonomyTier, Severity, TrustTier
from seeds.seed_reclaim_pay import (
    DEMO_ACCOUNTS,
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
    seed(pg_db, reset=True, now=NOW)
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
