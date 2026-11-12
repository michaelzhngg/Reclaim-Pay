import logging
import os
import aiofiles
from pathlib import Path
from typing import List, Any
from uuid import UUID

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile, status
from starlette.concurrency import run_in_threadpool
from starlette.requests import Request
from sqlmodel import Session, select

from api import deps
from api.rate_limit import POLICY_UPLOAD_LIMIT, limiter
from api.schemas import PolicyResponse, PolicyCategoryWithBudget, PolicyCategoriesUpdateRequest
from core.models import User, Policy, PolicyReimbursableCategory, PolicySection
from core.enums import AgentActionType, PolicyStatus, UserRole
from engine.agents.policy_agent import run_policy_workflow
from engine.services import policy_limits_store
from engine.services.policy_limits_extraction import extract_limits
from engine.services.action_log import record_action

router = APIRouter()
logger = logging.getLogger(__name__)

STORAGE_POLICIES_DIR = Path(__file__).parent.parent / "storage" / "policies"


def _budget(value) -> float | None:
    return None if value is None else round(float(value), 2)


def budget_changes(
    old: dict[str, float | None], new: dict[str, float | None]
) -> tuple[dict[str, float | None], dict[str, float | None]]:
    """The categories whose budget changed, as (old, new). A category only on one side was
    added or removed, so it appears in only one of the two dicts. None means no limit."""
    changed = sorted(k for k in old.keys() | new.keys() if k not in old or k not in new or old[k] != new[k])
    return ({k: old[k] for k in changed if k in old}, {k: new[k] for k in changed if k in new})


def _status_value(status) -> str | None:
    return status.value if hasattr(status, "value") else status


@router.get("/health")
def health():
    return {"status": "ok", "workflow": "policy_upload"}


@router.get("/")
def list_policies(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
) -> List[PolicyResponse]:
    policies = db.exec(select(Policy)).all()

    # Use helper to get policies with budgets
    policies_with_budgets = []
    for policy in policies:
        policy_response = _get_policy_with_categories(policy.policy_id, db)
        policies_with_budgets.append(policy_response)

    return policies_with_budgets


@router.post("/upload")
@limiter.limit(POLICY_UPLOAD_LIMIT)
async def upload_policy(
    request: Request,
    alias: str = Form(...),
    files: List[UploadFile] = File(...),
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    """Upload one or more policy PDFs. HR only."""
    STORAGE_POLICIES_DIR.mkdir(parents=True, exist_ok=True)

    saved_paths = []
    for file in files:
        if not file.filename or not file.filename.lower().endswith(".pdf"):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"Only PDF files are accepted. Got: {file.filename}",
            )
        safe_name = Path(file.filename).name
        dest = STORAGE_POLICIES_DIR / safe_name
        if not str(dest.resolve()).startswith(str(STORAGE_POLICIES_DIR.resolve())):
            raise HTTPException(status_code=400, detail=f"Invalid filename: {file.filename}")
        async with aiofiles.open(dest, "wb") as out:
            content = await file.read()
            await out.write(content)
        saved_paths.append(str(dest))

    try:
        # Off the event loop, so health checks and other requests are answered during the upload.
        policy_id = await run_in_threadpool(
            run_policy_workflow, saved_paths, alias, db, user_id=str(current_user.user_id)
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Policy workflow failed: {e}")

    policy = db.get(Policy, UUID(policy_id))
    if not policy:
        raise HTTPException(status_code=500, detail="Policy saved but could not be retrieved")

    record_action(db, AgentActionType.POLICY_UPLOADED, str(current_user.user_id), None, {
        "policy_id": str(policy.policy_id),
        "alias": policy.alias,
        "files": [Path(p).name for p in saved_paths],
    })

    # Suggest spending limits for HR to confirm. A failure here never fails the upload:
    # HR can retry from Policy Studio or add limits by hand.
    limits_found = 0
    try:
        limits_found = (await run_in_threadpool(extract_limits, db, policy.policy_id)).proposed
    except Exception:
        logger.exception("[POLICY_LIMITS] extraction failed for policy %s", policy.policy_id)
        db.rollback()

    # Fetch categories for response
    cats = db.exec(
        select(PolicyReimbursableCategory).where(
            PolicyReimbursableCategory.policy_id == policy.policy_id
        )
    ).all()

    return {
        "policy_id": str(policy.policy_id),
        "alias": policy.alias,
        "title": policy.title,
        "reimbursable_categories": [c.category for c in cats],
        "overview_summary": policy.overview_summary,
        "limits_found": limits_found,
        "status": ((policy.status.value if policy.status and hasattr(policy.status, "value") else policy.status) if policy.status and hasattr(policy.status, "value") else policy.status),
    }


@router.get("/{policy_id}")
def get_policy(
    policy_id: str,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
) -> PolicyResponse:
    try:
        p_uuid = UUID(policy_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid policy_id")

    return _get_policy_with_categories(p_uuid, db)


@router.patch("/{policy_id}/deprecate")
def deprecate_policy(
    policy_id: str,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    """Set policy status to DEPRECATED and set expiry_date to now."""
    try:
        p_uuid = UUID(policy_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid policy_id")

    policy = db.get(Policy, p_uuid)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    from datetime import datetime, timezone
    previous_status = _status_value(policy.status)
    policy.status = PolicyStatus.DEPRECATED
    policy.expiry_date = datetime.now(timezone.utc)
    db.add(policy)
    # record_action commits, so the status change and its log entry land together.
    record_action(db, AgentActionType.POLICY_DEPRECATED, str(current_user.user_id), None, {
        "policy_id": str(policy.policy_id),
        "alias": policy.alias,
        "previous_status": previous_status,
    })
    db.refresh(policy)

    return {
        "policy_id": str(policy.policy_id),
        "status": (policy.status.value if policy.status and hasattr(policy.status, "value") else policy.status),
        "expiry_date": policy.expiry_date.isoformat() if policy.expiry_date else None,
    }


@router.delete("/{policy_id}")
def delete_policy(
    policy_id: str,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    """Delete a policy and its associated data. HR only."""
    try:
        p_uuid = UUID(policy_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid policy_id")

    policy = db.get(Policy, p_uuid)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    # Delete associated reimbursable categories (no cascade configured)
    cats = db.exec(
        select(PolicyReimbursableCategory).where(
            PolicyReimbursableCategory.policy_id == policy.policy_id
        )
    ).all()
    for cat in cats:
        db.delete(cat)

    # Delete associated policy sections (no cascade configured)
    sections = db.exec(
        select(PolicySection).where(PolicySection.policy_id == policy.policy_id)
    ).all()
    for section in sections:
        db.delete(section)

    policy_limits_store.delete_for_policy(db, policy.policy_id)

    # Null out policy_id on any reimbursements referencing this policy
    # (FK constraint prevents delete while references exist)
    from core.models import Reimbursement
    reims = db.exec(
        select(Reimbursement).where(Reimbursement.policy_id == policy.policy_id)
    ).all()
    for reim in reims:
        reim.policy_id = None
        db.add(reim)
    db.flush()

    # Delete associated file from disk if it exists inside the policies storage dir
    if policy.source_file_url:
        try:
            file_path = Path(policy.source_file_url).resolve()
            policies_dir = STORAGE_POLICIES_DIR.resolve()
            if file_path.exists() and str(file_path).startswith(str(policies_dir)):
                file_path.unlink()
        except Exception:
            pass  # Best-effort deletion; don't fail the request if file removal fails

    deleted = {"policy_id": str(policy.policy_id), "alias": policy.alias, "status": _status_value(policy.status)}
    db.delete(policy)
    # record_action commits, so the deletion and its log entry land together.
    record_action(db, AgentActionType.POLICY_DELETED, str(current_user.user_id), None, deleted)

    return {"policy_id": deleted["policy_id"], "deleted": True}


@router.patch("/{policy_id}/categories")
def update_policy_categories(
    policy_id: str,
    request: PolicyCategoriesUpdateRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> PolicyResponse:
    """
    Update auto-approval budgets for policy categories.
    Only HR users can update category budgets.
    """
    try:
        p_uuid = UUID(policy_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid policy_id")

    # Fetch policy
    policy = db.get(Policy, p_uuid)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    old_budgets = {
        c.category: _budget(c.auto_approval_budget)
        for c in db.exec(
            select(PolicyReimbursableCategory).where(PolicyReimbursableCategory.policy_id == policy.policy_id)
        ).all()
    }
    new_budgets = {c.category: _budget(c.auto_approval_budget) for c in request.categories}

    # Delete existing categories
    from sqlalchemy import delete
    db.exec(
        delete(PolicyReimbursableCategory).where(
            PolicyReimbursableCategory.policy_id == policy.policy_id
        )
    )

    # Insert updated categories with budgets
    for cat_data in request.categories:
        new_cat = PolicyReimbursableCategory(
            policy_id=policy.policy_id,
            category=cat_data.category,
            auto_approval_budget=cat_data.auto_approval_budget,
        )
        db.add(new_cat)

    old_changed, new_changed = budget_changes(old_budgets, new_budgets)
    if old_changed or new_changed:
        # record_action commits, so the new budgets and their log entry land together.
        record_action(db, AgentActionType.POLICY_BUDGETS_CHANGED, str(current_user.user_id), None, {
            "policy_id": str(policy.policy_id),
            "alias": policy.alias,
            "old": old_changed,
            "new": new_changed,
        })
    else:
        db.commit()

    # Fetch and return updated policy
    return _get_policy_with_categories(policy.policy_id, db)


def _get_policy_with_categories(policy_id: UUID, db: Session) -> PolicyResponse:
    """Helper to fetch policy with category budgets."""
    policy = db.get(Policy, policy_id)
    if not policy:
        raise HTTPException(status_code=404, detail="Policy not found")

    # Fetch categories with budgets
    cats = db.exec(
        select(PolicyReimbursableCategory).where(
            PolicyReimbursableCategory.policy_id == policy_id
        )
    ).all()

    categories_with_budgets = [
        PolicyCategoryWithBudget(
            category=c.category,
            auto_approval_budget=float(c.auto_approval_budget) if c.auto_approval_budget else None
        )
        for c in cats
    ]

    return PolicyResponse(
        policy_id=policy.policy_id,
        alias=policy.alias,
        title=policy.title,
        effective_date=policy.effective_date,
        expiry_date=policy.expiry_date,
        overview_summary=policy.overview_summary,
        mandatory_conditions=policy.mandatory_conditions,
        source_file_url=policy.source_file_url,
        reimbursable_categories=[c.category for c in categories_with_budgets],
        reimbursable_categories_with_budgets=categories_with_budgets,
        status=policy.status,
        created_by=policy.created_by,
        created_at=policy.created_at,
    )
