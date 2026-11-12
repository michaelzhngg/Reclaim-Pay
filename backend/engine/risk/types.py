"""Contracts for the risk engine (spec: Contracts > Backend types, D2).

Pure data only: no DB, settings or LLM imports, so every module in engine/risk can be tested in isolation.
"""

import math
from datetime import date, datetime
from enum import Enum
from typing import Any, Literal

from pydantic import BaseModel, Field, model_validator


class AutonomyTier(str, Enum):
    AUTO_PAY = "AUTO_PAY"
    HR_QUICK = "HR_QUICK"
    HR_REVIEW = "HR_REVIEW"
    DUAL_REVIEW = "DUAL_REVIEW"


class TrustTier(str, Enum):
    NEW = "NEW"
    STANDARD = "STANDARD"
    TRUSTED = "TRUSTED"


class Severity(str, Enum):
    LOW = "LOW"
    MEDIUM = "MEDIUM"
    HIGH = "HIGH"


class SignalCode(str, Enum):
    PROMPT_INJECTION = "PROMPT_INJECTION"
    DUPLICATE_RECEIPT = "DUPLICATE_RECEIPT"
    AI_PROVENANCE = "AI_PROVENANCE"
    HUMAN_EDIT_HIGH = "HUMAN_EDIT_HIGH"
    ARITHMETIC_MISMATCH = "ARITHMETIC_MISMATCH"
    EDITING_SOFTWARE = "EDITING_SOFTWARE"
    SPLIT_CLAIM = "SPLIT_CLAIM"
    VISUAL_ANOMALY = "VISUAL_ANOMALY"
    HUMAN_EDIT_MEDIUM = "HUMAN_EDIT_MEDIUM"
    PRICE_ABOVE_MARKET = "PRICE_ABOVE_MARKET"
    NEAR_THRESHOLD = "NEAR_THRESHOLD"
    NO_CAMERA_METADATA = "NO_CAMERA_METADATA"
    # Observe-only by default (IMAGE_FORENSICS_MODE): stored and shown to HR, kept out of decide().
    IMAGE_FORENSICS = "IMAGE_FORENSICS"


class HardStop(str, Enum):
    # Declaration order is the spec's D2 order; decide() reports stops in this order.
    AUTONOMY_PAUSED = "AUTONOMY_PAUSED"
    CIRCUIT_BREAKER = "CIRCUIT_BREAKER"
    AI_NOT_APPROVED = "AI_NOT_APPROVED"
    PAYEE_NOT_VERIFIED = "PAYEE_NOT_VERIFIED"
    PAYEE_COOLDOWN = "PAYEE_COOLDOWN"
    HR_SELF_CLAIM = "HR_SELF_CLAIM"
    OVER_CATEGORY_BUDGET = "OVER_CATEGORY_BUDGET"
    OVER_AUTO_LIMIT = "OVER_AUTO_LIMIT"
    EMPLOYEE_DAILY_CAP = "EMPLOYEE_DAILY_CAP"
    EMPLOYEE_MONTHLY_CAP = "EMPLOYEE_MONTHLY_CAP"
    AGENT_DAILY_BUDGET = "AGENT_DAILY_BUDGET"
    HIGH_RISK_SIGNAL = "HIGH_RISK_SIGNAL"
    EXPECTED_LOSS = "EXPECTED_LOSS"
    # A claim in a currency with no deterministic quote cannot be compared to company limits.
    FX_RATE_UNAVAILABLE = "FX_RATE_UNAVAILABLE"
    # Contractors are paid only after the trusted tier, whatever their limit says.
    CONTRACTOR_NOT_TRUSTED = "CONTRACTOR_NOT_TRUSTED"
    # The contract's company-currency ceiling on a single claim.
    OVER_CONTRACT_LIMIT = "OVER_CONTRACT_LIMIT"


SEVERITY_POINTS: dict[Severity, int] = {Severity.LOW: 5, Severity.MEDIUM: 20, Severity.HIGH: 50}

ALWAYS_DUAL: frozenset[SignalCode] = frozenset(
    {SignalCode.PROMPT_INJECTION, SignalCode.DUPLICATE_RECEIPT, SignalCode.AI_PROVENANCE}
)


class RiskSignal(BaseModel):
    code: SignalCode
    severity: Severity
    points: int
    # Written for HR. Employees are shown generic copy, never this text.
    message: str
    evidence: dict[str, Any] = Field(default_factory=dict)
    document_id: str | None = None


class ClaimFacts(BaseModel):
    reim_id: str | None
    user_id: str
    # NaN would slip past every `amount > limit` comparison, so non-finite values are rejected.
    amount: float = Field(allow_inf_nan=False)
    currency: str
    judgment: str
    confidence: float
    over_category_budget: bool
    claimant_is_hr: bool
    # No deterministic quote for the claim currency: compare nothing and let HR look.
    fx_unavailable: bool = False
    claimant_is_contractor: bool = False
    over_contract_limit: bool = False


class EmployeeHistory(BaseModel):
    paid_claims: int
    # The windows are NEW_ISSUE_DAYS and TRUSTED_ISSUE_DAYS in engine.risk.autonomy.
    confirmed_issues_90d: int
    confirmed_issues_180d: int
    auto_paid_today: float
    auto_paid_month: float


class PayeeStatus(BaseModel):
    verified: bool
    linked_at: datetime | None
    # Set only when the payout account changed after the first link.
    changed_at: datetime | None


class AgentLedger(BaseModel):
    auto_paid_today: float
    auto_paid_last_hour: float
    breaker_active: bool
    # Vendor payments made today, all tiers. Committed company spend, not agent velocity.
    vendor_paid_today: float = 0.0


class AutonomyConfig(BaseModel):
    enabled: bool = True
    currency: str = "MYR"
    auto_limit_new: float = 50.0
    auto_limit_standard: float = 100.0
    auto_limit_trusted: float = 200.0
    dual_approval_above: float = 1000.0
    employee_daily_cap: float = 300.0
    employee_monthly_cap: float = 1000.0
    agent_daily_budget: float = 2000.0
    quick_min_score: int = 20
    review_min_score: int = 50
    dual_min_score: int = 80
    review_cost: float = 15.0
    review_minutes: int = 10
    recovery_rate: float = 0.5
    audit_sample_rate: float = 0.05
    payee_cooldown_hours: int = 72
    breaker_window: int = 20
    breaker_high_ratio: float = 0.3
    breaker_pause_minutes: int = 60
    dispute_window_hours: int = 120
    version: int = 1

    @model_validator(mode="after")
    def _check_ranges(self) -> "AutonomyConfig":
        amounts = (
            self.auto_limit_new, self.auto_limit_standard, self.auto_limit_trusted,
            self.dual_approval_above, self.employee_daily_cap, self.employee_monthly_cap,
            self.agent_daily_budget, self.review_cost,
        )
        if any(not math.isfinite(a) or a < 0 for a in amounts):
            raise ValueError("limits and costs must be zero or more")
        if not 0 <= self.quick_min_score <= self.review_min_score <= self.dual_min_score <= 100:
            raise ValueError("score bands must rise in order between 0 and 100")
        if any(not 0 <= r <= 1 for r in (self.recovery_rate, self.audit_sample_rate, self.breaker_high_ratio)):
            raise ValueError("rates must be between 0 and 1")
        if min(self.review_minutes, self.payee_cooldown_hours, self.breaker_window,
               self.breaker_pause_minutes, self.dispute_window_hours) < 0:
            raise ValueError("durations must be zero or more")
        return self


class AutonomyDecision(BaseModel):
    tier: AutonomyTier
    risk_score: int
    confidence_points: int
    trust_tier: TrustTier
    auto_limit: float
    hard_stops: list[HardStop]
    signals: list[RiskSignal]
    expected_loss: float
    explanation: str
    audit_selected: bool
    config_version: int


class TimelineStep(BaseModel):
    step: str
    label: str
    status: Literal["running", "done", "warn", "fail"]
    detail: str | None = None


class ClaimLite(BaseModel):
    reim_id: str
    user_id: str
    merchant: str
    expense_date: date | None
    amount: float
    created_at: datetime
    status: str


class DocFingerprint(BaseModel):
    document_id: str
    reim_id: str | None
    user_id: str
    sha256: str
    phash: str | None
    reim_status: str | None
    amount: float | None = None
    expense_date: date | None = None


def make_signal(
    code: SignalCode,
    severity: Severity,
    message: str,
    evidence: dict[str, Any] | None = None,
    document_id: str | None = None,
) -> RiskSignal:
    return RiskSignal(
        code=code,
        severity=severity,
        points=SEVERITY_POINTS[severity],
        message=message,
        evidence=dict(evidence or {}),
        document_id=document_id,
    )
