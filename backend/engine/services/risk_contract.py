"""
Risk types the autonomy store needs, taken from engine.risk.types when it exists.

engine/risk is built in parallel on another branch. Until it lands, this module mirrors the
spec's "Backend types" for the four models the store uses. Delete the fallback once it merges.
"""
from datetime import datetime

try:
    from engine.risk.types import (  # noqa: F401
        AgentLedger,
        AutonomyConfig,
        AutonomyDecision,
        EmployeeHistory,
        PayeeStatus,
    )
    HAS_RISK_TYPES = True
except ImportError:
    from pydantic import BaseModel

    HAS_RISK_TYPES = False
    AutonomyDecision = None  # recent_decisions returns the stored dicts until engine.risk exists

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

    class EmployeeHistory(BaseModel):
        paid_claims: int
        confirmed_issues_90d: int
        confirmed_issues_180d: int
        auto_paid_today: float
        auto_paid_month: float

    class PayeeStatus(BaseModel):
        verified: bool
        linked_at: datetime | None
        changed_at: datetime | None

    class AgentLedger(BaseModel):
        auto_paid_today: float
        auto_paid_last_hour: float
        breaker_active: bool
        vendor_paid_today: float = 0.0


AUTONOMY_TIERS = ("AUTO_PAY", "HR_QUICK", "HR_REVIEW", "DUAL_REVIEW")
