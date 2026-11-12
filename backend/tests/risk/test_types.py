from engine.risk.types import (
    ALWAYS_DUAL,
    SEVERITY_POINTS,
    AutonomyConfig,
    AutonomyTier,
    HardStop,
    RiskSignal,
    Severity,
    SignalCode,
    make_signal,
)


def test_config_defaults_match_spec():
    c = AutonomyConfig()
    assert (c.auto_limit_new, c.auto_limit_standard, c.auto_limit_trusted) == (50.0, 100.0, 200.0)
    assert c.dual_approval_above == 1000.0
    assert (c.employee_daily_cap, c.employee_monthly_cap, c.agent_daily_budget) == (300.0, 1000.0, 2000.0)
    assert (c.quick_min_score, c.review_min_score, c.dual_min_score) == (20, 50, 80)
    assert (c.review_cost, c.review_minutes, c.recovery_rate) == (15.0, 10, 0.5)
    assert (c.audit_sample_rate, c.payee_cooldown_hours) == (0.05, 72)
    assert (c.breaker_window, c.breaker_high_ratio, c.breaker_pause_minutes) == (20, 0.3, 60)
    assert c.dispute_window_hours == 120 and c.enabled is True and c.currency == "MYR" and c.version == 1


def test_make_signal_takes_points_from_severity():
    assert make_signal(SignalCode.SPLIT_CLAIM, Severity.MEDIUM, "split").points == 20


def test_signal_json_roundtrip():
    s = make_signal(SignalCode.DUPLICATE_RECEIPT, Severity.HIGH, "Matches RC-1a2b3c4d", {"distance": 3})
    assert RiskSignal.model_validate_json(s.model_dump_json()) == s


def test_severity_points_and_always_dual():
    assert SEVERITY_POINTS == {Severity.LOW: 5, Severity.MEDIUM: 20, Severity.HIGH: 50}
    assert ALWAYS_DUAL == {SignalCode.PROMPT_INJECTION, SignalCode.DUPLICATE_RECEIPT, SignalCode.AI_PROVENANCE}


def test_enum_values_match_spec():
    assert [c.value for c in SignalCode] == [
        "PROMPT_INJECTION", "DUPLICATE_RECEIPT", "AI_PROVENANCE", "HUMAN_EDIT_HIGH", "ARITHMETIC_MISMATCH",
        "EDITING_SOFTWARE", "SPLIT_CLAIM", "VISUAL_ANOMALY", "HUMAN_EDIT_MEDIUM", "PRICE_ABOVE_MARKET",
        "NEAR_THRESHOLD", "NO_CAMERA_METADATA", "IMAGE_FORENSICS",
    ]
    assert [h.value for h in HardStop] == [
        "AUTONOMY_PAUSED", "CIRCUIT_BREAKER", "AI_NOT_APPROVED", "PAYEE_NOT_VERIFIED", "PAYEE_COOLDOWN",
        "HR_SELF_CLAIM", "OVER_CATEGORY_BUDGET", "OVER_AUTO_LIMIT", "EMPLOYEE_DAILY_CAP",
        "EMPLOYEE_MONTHLY_CAP", "AGENT_DAILY_BUDGET", "HIGH_RISK_SIGNAL", "EXPECTED_LOSS",
    ]
    assert [t.value for t in AutonomyTier] == [
        "AUTO_PAY", "HR_QUICK", "HR_REVIEW", "DUAL_REVIEW",
    ]
