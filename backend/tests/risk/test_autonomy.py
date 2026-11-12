from datetime import datetime, timedelta, timezone

import pytest

from engine.risk.autonomy import (
    audit_selected,
    breaker_should_trip,
    confidence_points,
    decide,
    expected_loss,
    limit_for,
    trust_tier,
)
from engine.risk.types import (
    AgentLedger,
    AutonomyConfig,
    AutonomyTier,
    ClaimFacts,
    EmployeeHistory,
    HardStop,
    PayeeStatus,
    Severity,
    SignalCode,
    TrustTier,
    make_signal,
)

NOW = datetime(2026, 11, 3, 10, tzinfo=timezone.utc)


def sig(code, sev):
    return make_signal(code, sev, code.value)


def inputs(amount=48.0, confidence=0.95, judgment="APPROVED", signals=(), paid=5, issues90=0, issues180=0,
           today=0.0, month=0.0, verified=True, changed_hours_ago=None, ledger_today=0.0, breaker=False,
           over_budget=False, is_hr=False, cfg=None, vendor_paid=0.0):
    claim = ClaimFacts(reim_id="11111111-1111-1111-1111-111111111111", user_id="u1", amount=amount, currency="MYR",
                       judgment=judgment, confidence=confidence, over_category_budget=over_budget, claimant_is_hr=is_hr)
    hist = EmployeeHistory(paid_claims=paid, confirmed_issues_90d=issues90, confirmed_issues_180d=issues180,
                           auto_paid_today=today, auto_paid_month=month)
    changed = None if changed_hours_ago is None else NOW - timedelta(hours=changed_hours_ago)
    payee = PayeeStatus(verified=verified, linked_at=NOW - timedelta(days=30), changed_at=changed)
    ledger = AgentLedger(auto_paid_today=ledger_today, auto_paid_last_hour=0.0, breaker_active=breaker,
                         vendor_paid_today=vendor_paid)
    return claim, list(signals), hist, payee, ledger, cfg or AutonomyConfig(), NOW


def make(**kw):
    return decide(*inputs(**kw))


def hist(paid, issues90=0, issues180=0):
    return EmployeeHistory(paid_claims=paid, confirmed_issues_90d=issues90, confirmed_issues_180d=issues180,
                           auto_paid_today=0, auto_paid_month=0)


def test_clean_small_claim_auto_pays():
    d = make()
    assert d.tier == AutonomyTier.AUTO_PAY and d.risk_score == 0 and d.hard_stops == []
    assert d.trust_tier == TrustTier.STANDARD and d.auto_limit == 100.0
    assert d.config_version == 1


def test_over_limit_goes_to_quick():
    d = make(amount=120)
    assert d.tier == AutonomyTier.HR_QUICK and HardStop.OVER_AUTO_LIMIT in d.hard_stops


def test_amount_equal_to_limit_still_auto_pays():
    assert make(amount=100).tier == AutonomyTier.AUTO_PAY


def test_new_employee_limit_is_50():
    d = make(amount=60, paid=1)
    assert d.trust_tier == TrustTier.NEW and d.tier == AutonomyTier.HR_QUICK


def test_trusted_employee_limit_is_200():
    assert make(amount=180, paid=12).tier == AutonomyTier.AUTO_PAY


@pytest.mark.parametrize("code", [SignalCode.PROMPT_INJECTION, SignalCode.DUPLICATE_RECEIPT, SignalCode.AI_PROVENANCE])
def test_always_dual_codes(code):
    assert make(signals=[sig(code, Severity.HIGH)]).tier == AutonomyTier.DUAL_REVIEW


def test_always_dual_code_wins_even_at_low_severity():
    assert make(signals=[sig(SignalCode.PROMPT_INJECTION, Severity.LOW)]).tier == AutonomyTier.DUAL_REVIEW


def test_other_high_signal_goes_to_review():
    d = make(signals=[sig(SignalCode.HUMAN_EDIT_HIGH, Severity.HIGH)])
    assert d.tier == AutonomyTier.HR_REVIEW and HardStop.HIGH_RISK_SIGNAL in d.hard_stops


def test_ai_rejection_goes_to_review_never_auto_reject():
    d = make(judgment="REJECTED")
    assert d.tier == AutonomyTier.HR_REVIEW and HardStop.AI_NOT_APPROVED in d.hard_stops


@pytest.mark.parametrize("judgment", ["PARTIAL", "NEEDS_INFO", "MANUAL REVIEW", "approved", ""])
def test_anything_but_exact_approved_goes_to_review(judgment):
    assert make(judgment=judgment).tier == AutonomyTier.HR_REVIEW


@pytest.mark.parametrize("conf,pts", [(0.95, 0), (0.90, 0), (0.85, 5), (0.80, 5), (0.75, 15), (0.70, 15), (0.5, 30)])
def test_confidence_points(conf, pts):
    assert confidence_points(conf) == pts


@pytest.mark.parametrize("conf", [float("nan"), -1.0])
def test_bad_confidence_counts_as_lowest(conf):
    assert confidence_points(conf) == 30


def test_confidence_above_one_never_reduces_risk():
    d = make(confidence=5.0, signals=[sig(SignalCode.SPLIT_CLAIM, Severity.MEDIUM)])
    assert d.confidence_points == 0 and d.risk_score == 20


def test_low_confidence_only_adds_risk():
    d = make(confidence=0.65)
    assert d.confidence_points == 30 and d.risk_score == 30 and d.tier == AutonomyTier.HR_QUICK


def test_score_is_capped_at_100():
    d = make(confidence=0.1, signals=[sig(SignalCode.HUMAN_EDIT_HIGH, Severity.HIGH)] * 3)
    assert d.risk_score == 100 and d.tier == AutonomyTier.DUAL_REVIEW


def test_unverified_payee_and_cooldown():
    assert HardStop.PAYEE_NOT_VERIFIED in make(verified=False).hard_stops
    assert HardStop.PAYEE_COOLDOWN in make(changed_hours_ago=10).hard_stops
    assert HardStop.PAYEE_COOLDOWN not in make(changed_hours_ago=80).hard_stops


def test_first_ever_payee_link_is_not_a_cooldown():
    # A first-time link has no changed_at, even if linked minutes ago.
    claim, signals, h, _, ledger, cfg, now = inputs(paid=0, amount=20)
    payee = PayeeStatus(verified=True, linked_at=NOW - timedelta(minutes=5), changed_at=None)
    d = decide(claim, signals, h, payee, ledger, cfg, now)
    assert HardStop.PAYEE_COOLDOWN not in d.hard_stops and d.tier == AutonomyTier.AUTO_PAY


def test_kill_switch_breaker_caps_and_budget():
    assert HardStop.AUTONOMY_PAUSED in make(cfg=AutonomyConfig(enabled=False)).hard_stops
    assert HardStop.CIRCUIT_BREAKER in make(breaker=True).hard_stops
    assert HardStop.EMPLOYEE_DAILY_CAP in make(today=280).hard_stops
    assert HardStop.EMPLOYEE_MONTHLY_CAP in make(month=990).hard_stops
    assert HardStop.AGENT_DAILY_BUDGET in make(ledger_today=1990).hard_stops
    assert HardStop.HR_SELF_CLAIM in make(is_hr=True).hard_stops
    assert HardStop.OVER_CATEGORY_BUDGET in make(over_budget=True).hard_stops


def test_vendor_spend_consumes_the_company_daily_budget():
    assert HardStop.AGENT_DAILY_BUDGET in make(ledger_today=1900, vendor_paid=100).hard_stops
    assert make(ledger_today=1900, vendor_paid=40).tier == AutonomyTier.AUTO_PAY


def test_every_hard_stop_blocks_auto_pay():
    for kw in [dict(cfg=AutonomyConfig(enabled=False)), dict(breaker=True), dict(verified=False),
               dict(changed_hours_ago=1), dict(is_hr=True), dict(over_budget=True), dict(today=280),
               dict(month=990), dict(ledger_today=1990), dict(ledger_today=1900, vendor_paid=100)]:
        assert make(**kw).tier != AutonomyTier.AUTO_PAY, kw


def test_hard_stops_reported_in_spec_order():
    d = make(cfg=AutonomyConfig(enabled=False), breaker=True, judgment="REJECTED", verified=False, is_hr=True)
    assert d.hard_stops == [HardStop.AUTONOMY_PAUSED, HardStop.CIRCUIT_BREAKER, HardStop.AI_NOT_APPROVED,
                            HardStop.PAYEE_NOT_VERIFIED, HardStop.HR_SELF_CLAIM]


def test_large_amount_needs_two_people():
    assert make(amount=1500).tier == AutonomyTier.DUAL_REVIEW
    assert make(amount=1000, paid=12).tier != AutonomyTier.DUAL_REVIEW


def test_expected_loss_formula():
    assert expected_loss(20, 100.0, 0.5) == pytest.approx(5.5)
    assert expected_loss(100, 100.0, 0.5) == pytest.approx(25.5)
    assert expected_loss(400, 100.0, 0.5) == pytest.approx(50.0)
    d = make(amount=100, signals=[sig(SignalCode.SPLIT_CLAIM, Severity.MEDIUM)])
    assert d.risk_score == 20 and d.expected_loss == pytest.approx(5.5) and d.tier == AutonomyTier.HR_QUICK


def test_expected_loss_at_review_cost_is_a_hard_stop():
    # score 15, amount 200: p_bad 0.085, loss = 0.085 * 200 * 0.5 = 8.5 (< 15); score 30 at 200: 0.16 * 100 = 16
    assert HardStop.EXPECTED_LOSS not in make(amount=200, paid=12, confidence=0.75).hard_stops
    assert HardStop.EXPECTED_LOSS in make(amount=200, paid=12, confidence=0.5).hard_stops


def test_trust_rises_slowly_falls_fast():
    assert trust_tier(hist(20, issues90=1, issues180=1)) == TrustTier.NEW
    assert trust_tier(hist(10, issues90=0, issues180=1)) == TrustTier.STANDARD
    assert trust_tier(hist(10)) == TrustTier.TRUSTED
    assert trust_tier(hist(3)) == TrustTier.STANDARD
    assert trust_tier(hist(2)) == TrustTier.NEW


def test_limit_for_each_tier():
    cfg = AutonomyConfig()
    assert [limit_for(cfg, t) for t in TrustTier] == [50.0, 100.0, 200.0]


def test_audit_selection_is_deterministic():
    assert audit_selected("abc", 0.0) is False and audit_selected("abc", 1.0) is True
    assert audit_selected("abc", 0.05) == audit_selected("abc", 0.05)
    assert audit_selected(None, 1.0) is False


def test_audit_sample_rate_is_roughly_honoured():
    hits = sum(audit_selected(f"claim-{i}", 0.05) for i in range(4000))
    assert 120 < hits < 280


def test_audit_selected_only_on_auto_pay():
    assert make(cfg=AutonomyConfig(audit_sample_rate=1.0)).audit_selected is True
    assert make(amount=120, cfg=AutonomyConfig(audit_sample_rate=1.0)).audit_selected is False


def test_breaker_trips_at_six_of_twenty_or_half_budget_in_an_hour():
    high = make(signals=[sig(SignalCode.HUMAN_EDIT_HIGH, Severity.HIGH)])
    clean = make()
    cfg = AutonomyConfig()
    assert breaker_should_trip([high] * 6 + [clean] * 14, 0.0, cfg) is True
    assert breaker_should_trip([high] * 5 + [clean] * 15, 0.0, cfg) is False
    assert breaker_should_trip([clean] * 20, 1001.0, cfg) is True
    assert breaker_should_trip([clean] * 20, 1000.0, cfg) is False


def test_breaker_only_looks_at_the_window():
    high = make(signals=[sig(SignalCode.HUMAN_EDIT_HIGH, Severity.HIGH)])
    clean = make()
    # Most recent first: 20 clean decisions, then older HIGH ones outside the window.
    assert breaker_should_trip([clean] * 20 + [high] * 10, 0.0, AutonomyConfig()) is False


def test_explanation_format():
    d = make()
    assert d.explanation.startswith("Auto-pay: risk 0/100") and "MYR 100.00" in d.explanation
    assert d.explanation == "Auto-pay: risk 0/100, Standard employee limit MYR 100.00."


def test_explanation_lists_stops_and_signals():
    d = make(amount=120, signals=[sig(SignalCode.NEAR_THRESHOLD, Severity.LOW),
                                  sig(SignalCode.SPLIT_CLAIM, Severity.MEDIUM)])
    assert d.explanation == ("Quick HR approval: risk 25/100, Standard employee limit MYR 100.00."
                             " Stops: OVER_AUTO_LIMIT. Signals: SPLIT_CLAIM; NEAR_THRESHOLD.")


def test_signals_sorted_by_points_and_inputs_not_mutated():
    low, high = sig(SignalCode.NO_CAMERA_METADATA, Severity.LOW), sig(SignalCode.HUMAN_EDIT_HIGH, Severity.HIGH)
    args = inputs(signals=[low, high])
    before = [s.model_copy(deep=True) for s in args[1]]
    d = decide(*args)
    assert [s.code for s in d.signals] == [SignalCode.HUMAN_EDIT_HIGH, SignalCode.NO_CAMERA_METADATA]
    assert args[1] == before and args[1][0] is low


def test_decision_is_json_serialisable():
    d = make(signals=[sig(SignalCode.SPLIT_CLAIM, Severity.MEDIUM)])
    assert type(d).model_validate_json(d.model_dump_json()) == d
