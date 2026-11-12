"""The only place that can produce AUTO_PAY (spec D2, D3).

Pure and deterministic: every input is passed in, nothing is read from the request, DB or settings.
"""

import hashlib
import math
from datetime import datetime, timedelta

from engine.risk.types import (
    ALWAYS_DUAL,
    AgentLedger,
    AutonomyConfig,
    AutonomyDecision,
    AutonomyTier,
    ClaimFacts,
    EmployeeHistory,
    HardStop,
    PayeeStatus,
    RiskSignal,
    Severity,
    TrustTier,
)

TIER_LABEL = {
    AutonomyTier.AUTO_PAY: "Auto-pay",
    AutonomyTier.HR_QUICK: "Quick HR approval",
    AutonomyTier.HR_REVIEW: "HR review",
    AutonomyTier.DUAL_REVIEW: "Two-person review",
}

# Spec D2: the breaker trips when more than half the daily budget went out in the last hour.
BREAKER_HOURLY_BUDGET_SHARE = 0.5

# Trust level thresholds, read by the whole backend. The HR limits form (LimitsForm.tsx) still hard-codes 3 and 10.
STANDARD_MIN_PAID = 3
TRUSTED_MIN_PAID = 10
NEW_ISSUE_DAYS = 90  # a confirmed issue holds the employee at NEW for this long
TRUSTED_ISSUE_DAYS = 180  # TRUSTED needs this long without a confirmed issue


def confidence_points(confidence: float) -> int:
    # Written as positive comparisons so NaN falls through to the highest penalty.
    if confidence >= 0.90:
        return 0
    if confidence >= 0.80:
        return 5
    if confidence >= 0.70:
        return 15
    return 30


def trust_tier(history: EmployeeHistory) -> TrustTier:
    if history.confirmed_issues_90d > 0:
        return TrustTier.NEW
    if history.paid_claims >= TRUSTED_MIN_PAID and history.confirmed_issues_180d == 0:
        return TrustTier.TRUSTED
    if history.paid_claims >= STANDARD_MIN_PAID:
        return TrustTier.STANDARD
    return TrustTier.NEW


def limit_for(config: AutonomyConfig, tier: TrustTier) -> float:
    return {
        TrustTier.NEW: config.auto_limit_new,
        TrustTier.STANDARD: config.auto_limit_standard,
        TrustTier.TRUSTED: config.auto_limit_trusted,
    }[tier]


def expected_loss(score: int, amount: float, recovery_rate: float) -> float:
    p_bad = min(1.0, 0.01 + score / 200)
    return p_bad * amount * (1 - recovery_rate)


def audit_selected(reim_id: str | None, rate: float) -> bool:
    if not reim_id:
        return False
    if rate >= 1.0:
        return True
    return int(hashlib.sha256(reim_id.encode()).hexdigest()[:8], 16) / 0xFFFFFFFF < rate


def breaker_should_trip(recent: list[AutonomyDecision], auto_paid_last_hour: float, config: AutonomyConfig) -> bool:
    """`recent` is most recent first, as returned by autonomy_store.recent_decisions."""
    window = recent[: config.breaker_window]
    needed = math.ceil(config.breaker_high_ratio * config.breaker_window)
    high = sum(1 for d in window if any(s.severity == Severity.HIGH for s in d.signals))
    if high >= needed:
        return True
    return auto_paid_last_hour > BREAKER_HOURLY_BUDGET_SHARE * config.agent_daily_budget


def _hard_stops(
    claim: ClaimFacts,
    signals: list[RiskSignal],
    history: EmployeeHistory,
    payee: PayeeStatus,
    ledger: AgentLedger,
    config: AutonomyConfig,
    now: datetime,
    limit: float,
    loss: float,
) -> list[HardStop]:
    # A first link has no changed_at, so a new employee's first payee never hits the cool-down.
    in_cooldown = payee.changed_at is not None and now - payee.changed_at < timedelta(hours=config.payee_cooldown_hours)
    conditions = {
        HardStop.AUTONOMY_PAUSED: not config.enabled,
        HardStop.CIRCUIT_BREAKER: ledger.breaker_active,
        HardStop.AI_NOT_APPROVED: claim.judgment != "APPROVED",
        HardStop.PAYEE_NOT_VERIFIED: not payee.verified,
        HardStop.PAYEE_COOLDOWN: in_cooldown,
        HardStop.HR_SELF_CLAIM: claim.claimant_is_hr,
        HardStop.OVER_CATEGORY_BUDGET: claim.over_category_budget,
        HardStop.OVER_AUTO_LIMIT: claim.amount > limit,
        HardStop.EMPLOYEE_DAILY_CAP: history.auto_paid_today + claim.amount > config.employee_daily_cap,
        HardStop.EMPLOYEE_MONTHLY_CAP: history.auto_paid_month + claim.amount > config.employee_monthly_cap,
        HardStop.AGENT_DAILY_BUDGET: ledger.auto_paid_today + ledger.vendor_paid_today + claim.amount > config.agent_daily_budget,
        HardStop.HIGH_RISK_SIGNAL: any(s.severity == Severity.HIGH for s in signals),
        HardStop.EXPECTED_LOSS: loss >= config.review_cost,
    }
    return [stop for stop in HardStop if conditions[stop]]


def _explanation(tier: AutonomyTier, score: int, trust: TrustTier, limit: float, config: AutonomyConfig,
                 stops: list[HardStop], signals: list[RiskSignal]) -> str:
    text = f"{TIER_LABEL[tier]}: risk {score}/100, {trust.value.title()} employee limit {config.currency} {limit:,.2f}."
    if stops:
        text += " Stops: " + ", ".join(s.value for s in stops) + "."
    if signals:
        text += " Signals: " + "; ".join(s.message for s in signals) + "."
    return text


def decide(
    claim: ClaimFacts,
    signals: list[RiskSignal],
    history: EmployeeHistory,
    payee: PayeeStatus,
    ledger: AgentLedger,
    config: AutonomyConfig,
    now: datetime,
) -> AutonomyDecision:
    ordered = sorted((s.model_copy(deep=True) for s in signals), key=lambda s: s.points, reverse=True)
    conf_pts = confidence_points(claim.confidence)
    score = min(100, sum(s.points for s in ordered) + conf_pts)
    trust = trust_tier(history)
    limit = limit_for(config, trust)
    loss = expected_loss(score, claim.amount, config.recovery_rate)
    stops = _hard_stops(claim, ordered, history, payee, ledger, config, now, limit, loss)

    # Tier rules from spec D2, first match wins. An AI rejection lands in HR_REVIEW, never an auto-reject.
    dual = (
        claim.amount > config.dual_approval_above
        or score >= config.dual_min_score
        or any(s.code in ALWAYS_DUAL for s in ordered)
    )
    review = (
        score >= config.review_min_score
        or any(s.severity == Severity.HIGH for s in ordered)
        or claim.judgment != "APPROVED"
    )
    if dual:
        tier = AutonomyTier.DUAL_REVIEW
    elif review:
        tier = AutonomyTier.HR_REVIEW
    elif stops or score >= config.quick_min_score:
        tier = AutonomyTier.HR_QUICK
    else:
        tier = AutonomyTier.AUTO_PAY

    return AutonomyDecision(
        tier=tier,
        risk_score=score,
        confidence_points=conf_pts,
        trust_tier=trust,
        auto_limit=limit,
        hard_stops=stops,
        signals=ordered,
        expected_loss=loss,
        explanation=_explanation(tier, score, trust, limit, config, stops, ordered),
        audit_selected=tier == AutonomyTier.AUTO_PAY and audit_selected(claim.reim_id, config.audit_sample_rate),
        config_version=config.version,
    )
