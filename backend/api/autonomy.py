"""Autonomy settings, kill switch, status, action log and back-test (HR), and the employee trust card."""
from datetime import datetime, timezone
from typing import Any, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from api import deps
from core.enums import UserRole
from core.models import AgentAction, User
from engine.risk.types import TrustTier
from engine.services import autonomy_store as store
from engine.services.backtest_service import BacktestResult, employee_trust, load_backtest_cases, run_backtest
from engine.services.action_log import action_to_dict, verify_chain
from engine.services.risk_contract import AutonomyConfig

router = APIRouter()


class AutonomySettingsOut(BaseModel):
    config: dict[str, Any]
    enabled: bool
    version: int
    breaker_until: datetime | None


class AutonomySettingsIn(AutonomyConfig):
    """A full AutonomyConfig plus why it changed. The reason goes to the action log, never into the stored config."""
    reason: str | None = Field(default=None, max_length=500)

    @field_validator("reason")
    @classmethod
    def blank_reason_is_none(cls, v: str | None) -> str | None:
        return (v or "").strip() or None


class KillSwitchIn(BaseModel):
    enabled: bool
    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def reason_not_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("reason is required")
        return v


class AutonomyStatusOut(BaseModel):
    enabled: bool
    breaker_until: datetime | None
    auto_paid_today: float
    agent_daily_budget: float
    decisions_today_by_tier: dict[str, int]


class AgentActionOut(BaseModel):
    action_id: int
    action_type: str
    actor: str
    reim_id: str | None
    payload: dict[str, Any]
    prev_hash: str
    hash: str
    created_at: datetime


class AgentActionsOut(BaseModel):
    chain_valid: bool
    actions: list[AgentActionOut]


class BacktestIn(BaseModel):
    config: AutonomyConfig


class TrustChangeOut(BaseModel):
    at: datetime
    from_tier: TrustTier
    to_tier: TrustTier
    from_limit: float
    to_limit: float
    # Only what the employee may see: never the check or signal behind a correction.
    cause: Literal["approved_claims", "time_passed", "correction", "recovery"]
    # The claim a correction or recovery was on; null for the other causes.
    reim_id: UUID | None = None


class TrustLevelOut(BaseModel):
    tier: TrustTier
    auto_limit: float
    min_paid_claims: int


class TrustInfoOut(BaseModel):
    trust_tier: TrustTier
    auto_limit: float
    paid_claims: int
    next_tier: TrustTier | None
    claims_to_next_tier: int
    reasons: list[str]
    currency: str
    next_limit: float | None
    # Set while a recent correction keeps the employee at NEW.
    limited_until: datetime | None
    # Up to 3 most recent tier changes, newest first.
    changes: list[TrustChangeOut] = []
    levels: list[TrustLevelOut] = []
    # Days a correction holds the employee at NEW, and days without one that Trusted needs.
    hold_days: int | None = None
    trusted_clean_days: int | None = None


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _settings_out(db: Session) -> AutonomySettingsOut:
    row = store.settings_row(db)
    cfg = store.get_config(db)
    return AutonomySettingsOut(
        config=cfg.model_dump(mode="json"),
        enabled=cfg.enabled,
        version=row.version,
        breaker_until=store.active_breaker_until(row, _now()),
    )


@router.get("/settings", response_model=AutonomySettingsOut)
def get_settings(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    return _settings_out(db)


@router.put("/settings", response_model=AutonomySettingsOut)
def put_settings(
    body: AutonomySettingsIn,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    """`enabled` and `version` in the body are ignored: use the kill switch, and the server bumps the version."""
    config = AutonomyConfig.model_validate(body.model_dump(exclude={"reason"}))
    store.update_config(db, config, current_user.user_id, _now(), reason=body.reason)
    return _settings_out(db)


@router.post("/kill-switch", response_model=AutonomySettingsOut)
def kill_switch(
    body: KillSwitchIn,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    store.set_enabled(db, body.enabled, body.reason, current_user.user_id, _now())
    return _settings_out(db)


@router.get("/status", response_model=AutonomyStatusOut)
def get_status(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    now = _now()
    cfg = store.get_config(db)
    ledger = store.ledger_snapshot(db, now)
    return AutonomyStatusOut(
        enabled=cfg.enabled,
        breaker_until=store.active_breaker_until(store.settings_row(db), now),
        auto_paid_today=round(ledger.auto_paid_today, 2),
        agent_daily_budget=cfg.agent_daily_budget,
        decisions_today_by_tier=store.decisions_today_by_tier(db, now),
    )


@router.get("/actions", response_model=AgentActionsOut)
def get_actions(
    limit: int = Query(50, ge=1, le=500),
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    rows = db.exec(select(AgentAction).order_by(AgentAction.action_id.desc()).limit(limit)).all()
    return AgentActionsOut(
        chain_valid=verify_chain(db),
        actions=[AgentActionOut(**action_to_dict(a)) for a in rows],
    )


@router.post("/backtest", response_model=BacktestResult)
def backtest(
    body: BacktestIn,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    now = _now()
    return run_backtest(load_backtest_cases(db, now), body.config, now)


@router.get("/me", response_model=TrustInfoOut)
def my_trust(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
):
    """HR users get 403: their own claims never auto-pay (HR_SELF_CLAIM)."""
    if current_user.role != UserRole.Employee:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Trust tiers apply to employees only")
    return employee_trust(db, current_user.user_id, store.get_config(db), _now())
