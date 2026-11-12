"""HR checks and confirms the spending limits Reclaim suggests from a policy (E1)."""
import logging
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlmodel import Session, select
from starlette.requests import Request

from api import deps
from api.rate_limit import limiter
from core.enums import LimitStatus, PolicyStatus
from core.models import Policy, PolicyReimbursableCategory, User
from engine.policy.limits import LimitRule, ZonePlace, same_category
from engine.services import policy_limits_store as store
from engine.services.policy_limits_extraction import ExtractionResult, extract_limits

logger = logging.getLogger(__name__)
router = APIRouter()


class LimitRowOut(LimitRule):
    limit_id: UUID
    status: LimitStatus


class ZoneRowOut(ZonePlace):
    status: LimitStatus


class PolicyLimitsOut(BaseModel):
    policy_id: UUID
    categories: list[str]
    limits: list[LimitRowOut]
    zones: list[ZoneRowOut]
    has_suggestions: bool
    policy_active: bool
    # Categories whose confirmed limits employees see: the policy is ACTIVE and claims use it for them.
    employee_visible_categories: list[str]


class PolicyLimitsIn(BaseModel):
    limits: list[LimitRule] = Field(default_factory=list, max_length=300)
    zones: list[ZonePlace] = Field(default_factory=list, max_length=500)


def _policy_or_404(db: Session, policy_id: UUID) -> Policy:
    policy = db.get(Policy, policy_id)
    if not policy:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="POLICY_NOT_FOUND")
    return policy


def _categories(db: Session, policy_id: UUID) -> list[str]:
    return list(db.exec(select(PolicyReimbursableCategory.category)
                        .where(PolicyReimbursableCategory.policy_id == policy_id)).all())


def _has_conflict(rules: list[LimitRule]) -> bool:
    """Two rows for the same category, kind, unit, place and exact grade range with different amounts.

    Nested or overlapping ranges are allowed: the narrower one wins in engine.policy.limits.
    """
    amounts: dict[tuple, float | None] = {}
    for r in rules:
        key = (r.category, r.kind, r.unit, r.scope, (r.zone or "").strip().casefold(), r.grade_min, r.grade_max)
        if key in amounts and amounts[key] != r.amount:
            return True
        amounts[key] = r.amount
    return False


def _out(db: Session, policy_id: UUID) -> PolicyLimitsOut:
    limits, places = store.list_rows(db, policy_id)
    rows = [LimitRowOut(**store.to_rule(r).model_dump(), limit_id=r.limit_id, status=r.status) for r in limits]
    zones = [ZoneRowOut(zone=p.zone, place=p.place, status=p.status) for p in places]
    categories = _categories(db, policy_id)
    policy = db.get(Policy, policy_id)
    active = policy is not None and policy.status == PolicyStatus.ACTIVE
    visible: list[str] = []
    if active:
        picked = store.policy_for_category(db)
        visible = [c for c in categories if c in picked and picked[c].policy_id == policy_id]
    return PolicyLimitsOut(
        policy_id=policy_id, categories=categories, limits=rows, zones=zones,
        has_suggestions=any(r.status == LimitStatus.PROPOSED for r in rows + zones),
        policy_active=active, employee_visible_categories=visible,
    )


@router.get("/{policy_id}/limits", response_model=PolicyLimitsOut)
def get_limits(policy_id: UUID, db: Session = Depends(deps.get_db),
               current_user: User = Depends(deps.get_current_hr_user)) -> PolicyLimitsOut:
    _policy_or_404(db, policy_id)
    return _out(db, policy_id)


@router.put("/{policy_id}/limits", response_model=PolicyLimitsOut)
def confirm_limits(policy_id: UUID, body: PolicyLimitsIn, db: Session = Depends(deps.get_db),
                   current_user: User = Depends(deps.get_current_hr_user)) -> PolicyLimitsOut:
    _policy_or_404(db, policy_id)
    categories = _categories(db, policy_id)
    rules: list[LimitRule] = []
    for rule in body.limits:
        # Claims and active_limits match the policy's own spelling, so store that one.
        canonical = next((c for c in categories if same_category(rule.category, c)), None)
        if canonical is None:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                                detail=f"UNKNOWN_CATEGORY: {rule.category.strip()}")
        rules.append(rule.model_copy(update={"category": canonical}))
    if _has_conflict(rules):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="CONFLICTING_LIMITS")
    store.confirm_all(db, policy_id, rules, body.zones, current_user.user_id, datetime.now(timezone.utc))
    return _out(db, policy_id)


@router.post("/{policy_id}/limits/extract", response_model=ExtractionResult)
@limiter.limit("3/minute")
def suggest_limits(request: Request, policy_id: UUID, db: Session = Depends(deps.get_db),
                   current_user: User = Depends(deps.get_current_hr_user)) -> ExtractionResult:
    _policy_or_404(db, policy_id)
    try:
        return extract_limits(db, policy_id)
    except Exception:
        logger.exception("[POLICY_LIMITS] extraction failed for policy %s", policy_id)
        db.rollback()
        raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="LIMITS_EXTRACTION_FAILED")
