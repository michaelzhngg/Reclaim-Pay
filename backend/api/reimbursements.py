import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import List, Optional
from uuid import UUID

import asyncio
import json
import concurrent.futures

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.responses import StreamingResponse
from starlette.requests import Request
from sqlalchemy.orm import joinedload
from sqlalchemy import func
from sqlmodel import Session, select

from api import deps
from api.rate_limit import limiter
from api.schemas import (
    ReimbursementResponse,
    StatusUpdateRequest,
    AnalyzeReimbursementRequest,
    BatchApproveRequest,
    LineItemResponse,
)
from core.models import (
    User, Reimbursement, SupportingDocument, TravelSettlement, Policy,
    LineItem, ReimbursementSubCategory,
    Department, Payout, Notification, SettlementReceipt, PolicyReimbursableCategory,
)
from core.enums import AgentActionType, UserRole, ReimbursementStatus, JudgmentResult, PolicyStatus
from core.database import engine as db_engine
from engine.agents.compliance_agent import run_compliance_workflow, timeline_emitter
from engine.progress import ProgressTracker
from engine.services.action_log import record_action
from engine.services.approvals import DUAL_TIER, register_approval, required_approvals, split_batch
from engine.risk.timeline import make_step
from engine.services.payout_service import initiate_payout_sync
from engine.services.paypal_client import mask_email
from engine.services.recovery_service import OFFSET_APPLIED_STATUSES, release_offsets
from core.push_service import fire_and_forget_push

router = APIRouter()
logger = logging.getLogger(__name__)

_executor = concurrent.futures.ThreadPoolExecutor(max_workers=4)

_STATUS_TO_JUDGMENT = {
    ReimbursementStatus.APPROVED: JudgmentResult.APPROVED,
    ReimbursementStatus.REJECTED: JudgmentResult.REJECTED,
    ReimbursementStatus.REVIEW:   JudgmentResult.NEEDS_INFO,
    ReimbursementStatus.DISBURSING: JudgmentResult.APPROVED,
    ReimbursementStatus.PAID: JudgmentResult.APPROVED,
    ReimbursementStatus.DISBURSEMENT_FAILED: JudgmentResult.APPROVED,
}


def _enum_val(field) -> str:
    """Safely extract enum string value from either an enum instance or a raw string."""
    return field.value if field and hasattr(field, "value") else str(field) if field is not None else None


# Decision fields an employee may see. Signals, hard stops, scores and the explanation are HR-only.
_EMPLOYEE_AUTONOMY_KEYS = ("tier", "trust_tier", "auto_limit", "audit_selected", "config_version")


def _employee_tier(tier: Optional[str]) -> Optional[str]:
    # Employees never learn that a claim needed two approvers.
    return "HR_REVIEW" if tier == "DUAL_REVIEW" else tier


def _employee_autonomy(autonomy: Optional[dict]) -> dict:
    view = {k: autonomy[k] for k in _EMPLOYEE_AUTONOMY_KEYS if autonomy and k in autonomy}
    if "tier" in view:
        view["tier"] = _employee_tier(view["tier"])
    return view


def _employee_reasoning(reasoning: Optional[dict]) -> Optional[dict]:
    if reasoning and reasoning.get("hr_note"):
        return {"hr_note": reasoning["hr_note"]}
    return None


def _line_item_dict(li: LineItem, viewer_is_hr: bool) -> dict:
    return {
        "line_item_id": str(li.line_item_id),
        "reim_id": str(li.reim_id),
        "document_id": str(li.document_id) if li.document_id else None,
        "description": li.description,
        "category": li.category,
        "quantity": li.quantity,
        "unit_price": float(li.unit_price) if li.unit_price else None,
        "claimed_amount": float(li.claimed_amount) if li.claimed_amount else None,
        "approved_amount": float(li.approved_amount) if li.approved_amount else None,
        "currency": li.currency,
        "expense_date": li.expense_date.isoformat() if li.expense_date else None,
        "judgment": _enum_val(li.judgment),
        "rejection_reason": li.rejection_reason if viewer_is_hr else None,
        "policy_section_ref": str(li.policy_section_ref) if li.policy_section_ref else None,
    }


def _build_reimbursement_response(
    r: Reimbursement,
    db: Session,
    include_line_items: bool = True,
    employee_name: Optional[str] = None,
    department_name: Optional[str] = None,
    viewer_is_hr: bool = False,
    prefetched: Optional["_ListContext"] = None,
) -> dict:
    """Build a response dict for a Reimbursement row, including joined data.

    Non-HR viewers get no AI or HR judgment text: summary, reasoning, signals and the
    autonomy explanation are left out. The HR note stays, since the employee is notified of it.
    `prefetched` carries the list view's bulk lookups, so a page of rows costs a fixed number of queries.
    """
    if prefetched is not None:
        line_items = []
        sub_cats = []
        receipt_count = prefetched.receipt_counts.get(r.reim_id, 0)
    elif include_line_items:
        line_items = db.exec(
            select(LineItem).where(LineItem.reim_id == r.reim_id)
        ).all()
        sub_cats = db.exec(
            select(ReimbursementSubCategory).where(
                ReimbursementSubCategory.reim_id == r.reim_id
            )
        ).all()
        receipt_count = len(line_items)
    else:
        line_items = []
        sub_cats = []
        receipt_count = db.exec(
            select(func.count()).where(LineItem.reim_id == r.reim_id)
        ).one()

    user = prefetched.users.get(r.user_id) if prefetched is not None else db.get(User, r.user_id)

    # Use pre-fetched names if provided, otherwise look up
    if employee_name is None or department_name is None:
        if user:
            employee_name = user.name
            if user.department_id:
                dept = (prefetched.departments.get(user.department_id) if prefetched is not None
                        else db.get(Department, user.department_id))
                if dept:
                    department_name = dept.name
        employee_name = employee_name or "Unknown"
        department_name = department_name or "Unknown"

    # Fetch policy name if policy_id is set
    policy_name = None
    if r.policy_id:
        if prefetched is not None:
            policy_name = prefetched.policy_titles.get(r.policy_id)
        else:
            policy = db.get(Policy, r.policy_id)
            if policy:
                policy_name = policy.title

    result = {
        "reim_id": str(r.reim_id),
        "user_id": str(r.user_id),
        "employee_name": employee_name,
        "department_name": department_name,
        "policy_id": str(r.policy_id) if r.policy_id else None,
        "policy_name": policy_name,
        "settlement_id": str(r.settlement_id) if r.settlement_id else None,
        "main_category": r.main_category,
        "currency": r.currency,
        "total_claimed_amount": float(r.total_claimed_amount) if r.total_claimed_amount else None,
        "total_approved_amount": float(r.total_approved_amount) if r.total_approved_amount else None,
        "total_rejected_amount": float(r.total_rejected_amount) if r.total_rejected_amount else None,
        "confidence": r.confidence,
        "judgment": _enum_val(r.judgment),
        "status": _enum_val(r.status),
        "summary": r.summary if viewer_is_hr else None,
        "ai_reasoning": r.ai_reasoning if viewer_is_hr else _employee_reasoning(r.ai_reasoning),
        "reviewed_by": str(r.reviewed_by) if r.reviewed_by else None,
        "reviewed_at": r.reviewed_at.isoformat() if r.reviewed_at else None,
        "created_at": r.created_at.isoformat() if r.created_at else None,
        "updated_at": r.updated_at.isoformat() if r.updated_at else None,
        "sub_categories": [sc.sub_category for sc in sub_cats],
        "receipt_count": receipt_count,
        "tier": r.tier if viewer_is_hr else _employee_tier(r.tier),
        "risk_score": r.risk_score if viewer_is_hr else None,
        "autonomy": (r.autonomy or {}) if viewer_is_hr else _employee_autonomy(r.autonomy),
        "audit_selected": bool(r.audit_selected),
        "approvals": list(r.approvals or []) if viewer_is_hr else [],
        # Display-only fields. These never carry AI or HR judgment text.
        "employee_code": user.user_code if user else None,
        "payee_linked": bool(user and user.paypal_payer_id),
        "merchant_names": [],
        "purpose": None,
        "destination": None,
        "location": None,
        "departure_date": None,
        "arrival_date": None,
    }

    if r.settlement_id:
        if prefetched is not None:
            merchants = prefetched.merchants.get(r.settlement_id, [])
        else:
            merchants = db.exec(
                select(SettlementReceipt.merchant_name).where(
                    SettlementReceipt.settlement_id == r.settlement_id
                )
            ).all()
        result["merchant_names"] = list(dict.fromkeys(m.strip() for m in merchants if m and m.strip()))
        if include_line_items:
            settlement = db.get(TravelSettlement, r.settlement_id)
            if settlement:
                result["purpose"] = settlement.purpose or None
                result["destination"] = settlement.destination or None
                result["location"] = settlement.location or None
                result["departure_date"] = settlement.departure_date.isoformat() if settlement.departure_date else None
                result["arrival_date"] = settlement.arrival_date.isoformat() if settlement.arrival_date else None

    if include_line_items:
        result["line_items"] = [_line_item_dict(li, viewer_is_hr) for li in line_items]

    # Include payout info if one exists
    if prefetched is not None:
        payout = prefetched.latest_payouts.get(r.reim_id)
    else:
        payout = db.exec(
            select(Payout).where(Payout.reim_id == r.reim_id).order_by(Payout.created_at.desc())
        ).first()
    if payout:
        result["payout"] = {
            "payout_id": str(payout.payout_id),
            "amount": float(payout.amount),
            "currency": payout.currency,
            "status": _enum_val(payout.status),
            "xendit_id": payout.xendit_id,
            "channel_code": payout.channel_code,
            "failure_code": payout.failure_code,
            "created_at": payout.created_at.isoformat() if payout.created_at else None,
            "updated_at": payout.updated_at.isoformat() if payout.updated_at else None,
        }

    return result


@dataclass
class _ListContext:
    users: dict
    departments: dict
    receipt_counts: dict
    policy_titles: dict
    merchants: dict
    latest_payouts: dict


def _list_context(db: Session, reimbursements: list) -> _ListContext:
    """One query per related table for a page of claims, instead of several per claim."""
    reim_ids = [r.reim_id for r in reimbursements]
    user_ids = {r.user_id for r in reimbursements}
    policy_ids = {r.policy_id for r in reimbursements if r.policy_id}
    settlement_ids = {r.settlement_id for r in reimbursements if r.settlement_id}

    users = {u.user_id: u for u in db.exec(select(User).where(User.user_id.in_(user_ids))).all()} if user_ids else {}
    dept_ids = {u.department_id for u in users.values() if u.department_id}
    departments = (
        {d.department_id: d for d in db.exec(select(Department).where(Department.department_id.in_(dept_ids))).all()}
        if dept_ids else {}
    )
    receipt_counts = dict(
        db.exec(
            select(LineItem.reim_id, func.count()).where(LineItem.reim_id.in_(reim_ids)).group_by(LineItem.reim_id)
        ).all()
    ) if reim_ids else {}
    policy_titles = dict(
        db.exec(select(Policy.policy_id, Policy.title).where(Policy.policy_id.in_(policy_ids))).all()
    ) if policy_ids else {}

    merchants: dict = {}
    if settlement_ids:
        for sid, name in db.exec(
            select(SettlementReceipt.settlement_id, SettlementReceipt.merchant_name).where(
                SettlementReceipt.settlement_id.in_(settlement_ids)
            )
        ).all():
            merchants.setdefault(sid, []).append(name)

    # Same ordering as the single-claim lookup, so the first row per claim is the one it would pick.
    latest_payouts: dict = {}
    if reim_ids:
        for p in db.exec(
            select(Payout).where(Payout.reim_id.in_(reim_ids)).order_by(Payout.created_at.desc())
        ).all():
            latest_payouts.setdefault(p.reim_id, p)

    return _ListContext(users, departments, receipt_counts, policy_titles, merchants, latest_payouts)


@router.get("/health")
def health():
    return {"status": "ok", "workflow": "compliance_analysis"}


@router.get("/")
def list_reimbursements(
    limit: int = 50,
    offset: int = 0,
    status: Optional[str] = None,
    tier: Optional[str] = None,
    audit_selected: Optional[bool] = None,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
) -> List[dict]:
    viewer_is_hr = current_user.role == UserRole.HR
    if viewer_is_hr:
        stmt = select(Reimbursement)
    else:
        stmt = select(Reimbursement).where(Reimbursement.user_id == current_user.user_id)

    if status:
        stmt = stmt.where(Reimbursement.status == status)
    if tier:
        stmt = stmt.where(Reimbursement.tier == tier)
    if audit_selected is not None:
        stmt = stmt.where(Reimbursement.audit_selected == audit_selected)

    stmt = stmt.order_by(Reimbursement.created_at.desc()).offset(offset).limit(limit)
    reimbursements = db.exec(stmt).all()
    ctx = _list_context(db, reimbursements)

    return [
        _build_reimbursement_response(
            r,
            db,
            include_line_items=False,
            viewer_is_hr=viewer_is_hr,
            prefetched=ctx,
        )
        for r in reimbursements
    ]


@router.get("/{reim_id}")
def get_reimbursement(
    reim_id: str,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
) -> dict:
    try:
        reim_uuid = UUID(reim_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reim_id")

    r = db.get(Reimbursement, reim_uuid)
    if not r:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reimbursement not found")

    if current_user.role != UserRole.HR and r.user_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")

    return _build_reimbursement_response(
        r, db, include_line_items=True, viewer_is_hr=current_user.role == UserRole.HR
    )


def _lock_reimbursement(db: Session, reim_uuid: UUID) -> Optional[Reimbursement]:
    # Row lock so two HR users approving at once can't both read the same approvals list.
    return db.exec(
        select(Reimbursement).where(Reimbursement.reim_id == reim_uuid).with_for_update()
    ).first()


def _decided_line_item(li: LineItem, override: Optional[float], approving: bool) -> tuple:
    """The (approved_amount, judgment) a line ends up with after an HR decision."""
    amount, judgment = li.approved_amount, li.judgment
    if override is not None:
        amount, judgment = override, JudgmentResult.APPROVED if override > 0 else JudgmentResult.REJECTED
    # Approving without a figure for this line accepts it in full. HR's explicit figure, even 0, stands.
    elif approving and judgment == JudgmentResult.REJECTED:
        amount, judgment = li.claimed_amount, JudgmentResult.APPROVED
    return amount, judgment


def _check_overrides(line_items: list, overrides: Optional[list]) -> None:
    """HR can reduce a line but can't approve more than the employee claimed on it."""
    claimed = {li.line_item_id: float(li.claimed_amount or 0) for li in line_items}
    for adjustment in overrides or []:
        limit = claimed.get(adjustment.line_item_id)
        if limit is not None and adjustment.approved_amount > limit + 0.005:
            raise HTTPException(status_code=422, detail="AMOUNT_ABOVE_CLAIMED")


def _has_amount_to_pay(db: Session, r: Reimbursement, overrides: Optional[list] = None) -> bool:
    """False when approving would leave MYR 0 approved, as on a claim with no line items."""
    override_map = {li.line_item_id: li.approved_amount for li in overrides or []}
    line_items = db.exec(select(LineItem).where(LineItem.reim_id == r.reim_id)).all()
    _check_overrides(line_items, overrides)
    return any(
        float(_decided_line_item(li, override_map.get(li.line_item_id), True)[0] or 0) > 0 for li in line_items
    )


def _apply_status(
    db: Session,
    r: Reimbursement,
    new_status: ReimbursementStatus,
    hr: User,
    line_item_overrides: Optional[list] = None,
    hr_note: Optional[str] = None,
) -> list[tuple[str, str]]:
    """Apply an HR decision without committing. Returns (title, message) pushes to send after commit."""
    line_items = db.exec(
        select(LineItem).where(LineItem.reim_id == r.reim_id)
    ).all()

    _check_overrides(line_items, line_item_overrides)
    override_map = {li.line_item_id: li.approved_amount for li in line_item_overrides or []}
    approving = new_status == ReimbursementStatus.APPROVED
    for li in line_items:
        li.approved_amount, li.judgment = _decided_line_item(li, override_map.get(li.line_item_id), approving)
    db.add_all(line_items)
    db.flush()

    # Constraint 2: total_approved_amount must equal SUM(line_items.approved_amount)
    approved_sum = sum(
        float(li.approved_amount or 0) for li in line_items
    )
    if new_status in (ReimbursementStatus.APPROVED, ReimbursementStatus.REJECTED):
        r.total_approved_amount = approved_sum
        r.total_rejected_amount = float(r.total_claimed_amount or 0) - approved_sum

    now = datetime.now(timezone.utc)
    r.status = new_status
    r.reviewed_by = hr.user_id
    r.reviewed_at = now
    r.judgment = _STATUS_TO_JUDGMENT.get(new_status, JudgmentResult.NEEDS_INFO)
    if hr_note:
        reasoning = dict(r.ai_reasoning or {})
        reasoning["hr_note"] = hr_note
        r.ai_reasoning = reasoning
    r.updated_at = now
    db.add(r)

    reim_short = str(r.reim_id)[:8]
    if new_status == ReimbursementStatus.APPROVED:
        title = f"Claim RC-{reim_short} approved"
        message = f"Your claim for MYR {float(r.total_approved_amount or 0):,.2f} has been approved and is ready for payout."
    elif new_status == ReimbursementStatus.REJECTED:
        title = f"Claim RC-{reim_short} rejected"
        message = f"Your claim was rejected. Reason: {(hr_note or 'No reason provided')[:200]}"
    else:
        return []
    db.add(Notification(
        user_id=r.user_id,
        type="success" if new_status == ReimbursementStatus.APPROVED else "error",
        title=title,
        message=message,
        link=f"/employee/history?id={r.reim_id}",
        is_read=False,
    ))
    return [(title, message)]


def _register_hr_approval(r: Reimbursement, hr: User) -> bool:
    """Add hr's approval to r.approvals. Returns True once the tier's approval count is met.

    Raises ValueError("SELF_APPROVAL") when hr filed the claim.
    """
    approvals, done = register_approval(
        list(r.approvals or []), str(hr.user_id), str(r.user_id),
        datetime.now(timezone.utc), required_approvals(r.tier),
    )
    r.approvals = approvals
    return done


def _log_approval(db: Session, r: Reimbursement, hr: User, complete: bool, batch: bool) -> None:
    """Writes the HR_APPROVAL row. record_action commits everything pending in db."""
    record_action(db, AgentActionType.HR_APPROVAL, str(hr.user_id), r.reim_id, {
        "tier": r.tier,
        "approvals": len(r.approvals or []),
        "required": required_approvals(r.tier),
        "complete": complete,
        "batch": batch,
        "amount": r.total_approved_amount,
    })


def _after_commit(db: Session, r: Reimbursement, pushes: list[tuple[str, str]]) -> None:
    if r.status == ReimbursementStatus.APPROVED:
        try:
            initiate_payout_sync(r.reim_id, db, loop=None)
            logger.info("[HR_APPROVAL] Auto-payout initiated for reim=%s", r.reim_id)
        except Exception:
            logger.exception("[HR_APPROVAL] Auto-payout failed for reim=%s, claim stays APPROVED", r.reim_id)
    for title, message in pushes:
        fire_and_forget_push(r.user_id, title, message, link=f"/employee/history?id={r.reim_id}")


@router.post("/batch-approve")
def batch_approve(
    body: BatchApproveRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    """Approve HR_QUICK claims in REVIEW. Anything else comes back in `skipped` with a reason."""
    requested = list(dict.fromkeys(body.reim_ids))
    parsed: dict[str, UUID] = {}
    for rid in requested:
        try:
            parsed[rid] = UUID(rid)
        except ValueError:
            pass

    found = db.exec(
        select(Reimbursement).where(Reimbursement.reim_id.in_(list(parsed.values())))
    ).all() if parsed else []
    by_uuid = {r.reim_id: r for r in found}

    def as_row(rid: str, r: Optional[Reimbursement]) -> dict:
        # Unknown IDs have no tier, so they are skipped as NOT_HR_QUICK.
        if r is None:
            return {"reim_id": rid, "tier": None, "status": None, "user_id": None}
        return {"reim_id": rid, "tier": r.tier, "status": _enum_val(r.status), "user_id": str(r.user_id)}

    rows = [as_row(rid, by_uuid.get(parsed.get(rid))) for rid in requested]
    eligible, skipped = split_batch(rows, str(current_user.user_id))

    approved: list[str] = []
    for rid in eligible:
        r = _lock_reimbursement(db, parsed[rid])
        # Re-check under the lock: another reviewer may have acted since the first read.
        ok, late_skip = split_batch([as_row(rid, r)], str(current_user.user_id))
        if not ok:
            db.rollback()
            skipped.extend(late_skip)
            continue
        if not _has_amount_to_pay(db, r):
            db.rollback()
            skipped.append({"reim_id": rid, "reason": "NOTHING_TO_PAY"})
            continue
        complete = _register_hr_approval(r, current_user)
        pushes = _apply_status(db, r, ReimbursementStatus.APPROVED, current_user) if complete else []
        _log_approval(db, r, current_user, complete=complete, batch=True)
        db.refresh(r)
        _after_commit(db, r, pushes)
        approved.append(rid)

    return {"approved": approved, "skipped": skipped}


@router.patch("/{reim_id}/status")
def update_reimbursement_status(
    reim_id: str,
    body: StatusUpdateRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    try:
        reim_uuid = UUID(reim_id)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Invalid reim_id")

    r = _lock_reimbursement(db, reim_uuid)
    if not r:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Reimbursement not found")

    approving = body.status == ReimbursementStatus.APPROVED
    prior_status = r.status
    complete = True
    if approving:
        # Refused so the claim stays in REVIEW: APPROVED means ready for payout, and HR must reject it or set amounts.
        if not _has_amount_to_pay(db, r, body.line_items):
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="NOTHING_TO_PAY")
        if r.status == ReimbursementStatus.REVIEW and any(
            a.get("hr_id") == str(current_user.user_id) for a in (r.approvals or [])
        ):
            db.rollback()
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="ALREADY_APPROVED")
        try:
            complete = _register_hr_approval(r, current_user)
        except ValueError:
            db.rollback()
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="SELF_APPROVAL")

    if complete:
        pushes = _apply_status(db, r, body.status, current_user, body.line_items, body.hr_note)
    else:
        # First of two DUAL_REVIEW approvals: the claim stays in REVIEW for a second HR user.
        r.updated_at = datetime.now(timezone.utc)
        db.add(r)
        pushes = []

    if approving:
        _log_approval(db, r, current_user, complete=complete, batch=False)
    else:
        if body.status == ReimbursementStatus.REJECTED and prior_status not in OFFSET_APPLIED_STATUSES:
            release_offsets(db, r, current_user, datetime.now(timezone.utc))
        db.commit()
    db.refresh(r)
    _after_commit(db, r, pushes)

    result = _build_reimbursement_response(r, db, include_line_items=True, viewer_is_hr=True)
    result["ready_for_payout"] = approving and complete
    if not complete:
        result["awaiting_second_approval"] = True
    return result


@router.get("/{reim_id}/line-items")
def get_reimbursement_line_items(
    reim_id: str,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
) -> List[dict]:
    try:
        reim_uuid = UUID(reim_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid reim_id")

    r = db.get(Reimbursement, reim_uuid)
    if not r:
        raise HTTPException(status_code=404, detail="Reimbursement not found")

    if current_user.role != UserRole.HR and r.user_id != current_user.user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    line_items = db.exec(
        select(LineItem).where(LineItem.reim_id == r.reim_id)
    ).all()

    return [_line_item_dict(li, current_user.role == UserRole.HR) for li in line_items]


def _auto_payout(db: Session, reim: Reimbursement, loop, emit) -> bool:
    """Pay an AUTO_PAY claim through PayPal and report it as the payout.create step.

    Only decide() sets AUTO_PAY, so nothing from the request can start a payout here.
    """
    if reim.tier != "AUTO_PAY" or reim.status != ReimbursementStatus.APPROVED:
        return False
    employee = db.get(User, reim.user_id)
    amount = float(reim.total_approved_amount or 0)
    detail = f"{reim.currency or 'MYR'} {amount:,.2f} to {mask_email((employee.paypal_email if employee else '') or '')}"
    emit(make_step("payout.create", "running", detail))
    try:
        payout = initiate_payout_sync(reim.reim_id, db, loop=loop)
        db.refresh(reim)
    except Exception:
        logger.exception("[API_ANALYZE_BG] Auto-payout failed for reim=%s, claim stays APPROVED", reim.reim_id)
        db.rollback()
        payout = None
    if payout is not None:
        emit(make_step("payout.create", "done", detail))
    elif reim.status == ReimbursementStatus.PAID:
        emit(make_step("payout.create", "done", "Settled against an earlier overpayment"))
    else:
        emit(make_step("payout.create", "fail", "PayPal couldn't take the payment. Your claim stays approved and HR can resend it."))
    return True


def _undecided_claim(**fields) -> Reimbursement:
    """A claim decide() never saw: no policy or Shield check passed, so it fails closed to two approvers."""
    return Reimbursement(judgment=JudgmentResult.NEEDS_INFO, status=ReimbursementStatus.REVIEW, tier=DUAL_TIER, **fields)


def _notify_claims_for_review(db: Session, user_id: UUID, results: list[dict]) -> None:
    """Tell the employee which claims went to HR. Auto-paid claims get the payout notifications instead."""
    count = sum(r.get("status") == ReimbursementStatus.REVIEW.value for r in results)
    if not count:
        return
    title = "Claim submitted for review"
    message = (f"We received your claim with {count} receipt{'s' if count != 1 else ''} for processing. "
               "You'll be notified when it's reviewed.")
    db.add(Notification(user_id=user_id, type="success", title=title, message=message,
                        link="/employee/history", is_read=False))
    db.commit()
    fire_and_forget_push(user_id, title, message, link="/employee/history")


@router.post("/analyze")
@limiter.limit("5/minute")
async def analyze_reimbursement(
    request: Request,
    body: AnalyzeReimbursementRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
) -> dict:
    """Run basket compliance analysis, auto-routing each receipt to its matched policy."""
    logger.info("[API_ANALYZE] Called with settlement=%s docs=%s user=%s", body.settlement_id, body.document_ids, current_user.user_id)

    # === Validation ===
    try:
        settlement_uuid = UUID(body.settlement_id)
    except ValueError:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid settlement_id",
        )

    settlement = db.get(TravelSettlement, settlement_uuid)
    if not settlement:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Settlement {body.settlement_id} not found",
        )

    if settlement.user_id != current_user.user_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Settlement does not belong to current user",
        )

    viewer_is_hr = current_user.role == UserRole.HR

    # Cache check: return cached results if no human edits
    has_edits = bool(
        db.exec(
            select(SupportingDocument).where(
                SupportingDocument.settlement_id == settlement_uuid,
                SupportingDocument.human_edited == True,
            )
        ).first()
    )

    cached_reims = db.exec(
        select(Reimbursement).where(Reimbursement.settlement_id == settlement_uuid)
    ).all()

    if not has_edits and cached_reims:
        logger.info("[API_ANALYZE] Returning %d cached reimbursements", len(cached_reims))
        results = [
            _build_reimbursement_response(r, db, include_line_items=True, viewer_is_hr=viewer_is_hr)
            for r in cached_reims
        ]
        return {"reimbursements": results}

    user_id_str = str(current_user.user_id)
    settlement_currency = settlement.currency or "MYR"

    # === Create task and launch background processing ===
    tracker = ProgressTracker()
    task_id = tracker.create_task(owner_id=current_user.user_id)
    logger.info("[API_ANALYZE] Created task_id=%s for background compliance", task_id)

    loop = asyncio.get_running_loop()

    def _process_background():
        from decimal import Decimal
        from collections import Counter
        logger.info("[API_ANALYZE_BG] Starting background compliance for task=%s", task_id)

        with Session(db_engine) as bg_db:
            try:
                # 1. Load settlement receipts (optionally filtered to submitted document_ids)
                receipts_q = select(SettlementReceipt).where(
                    SettlementReceipt.settlement_id == settlement_uuid
                )
                if body.document_ids:
                    receipts_q = receipts_q.where(
                        SettlementReceipt.document_id.in_([UUID(d) for d in body.document_ids])
                    )
                all_receipts = bg_db.exec(receipts_q).all()
                logger.info("[API_ANALYZE_BG] Loaded %d settlement receipts", len(all_receipts))

                if not all_receipts:
                    tracker.publish(task_id, "error", {"message": "No receipts found for this settlement"})
                    return

                # 2. Map each unique category → best active policy (latest effective_date)
                unique_categories = list({r.category for r in all_receipts if r.category})
                cat_to_policy_id: dict[str, Optional[str]] = {}
                for cat in unique_categories:
                    rows = bg_db.exec(
                        select(PolicyReimbursableCategory, Policy)
                        .join(Policy, PolicyReimbursableCategory.policy_id == Policy.policy_id)
                        .where(
                            PolicyReimbursableCategory.category == cat,
                            Policy.status == PolicyStatus.ACTIVE,
                        )
                        .order_by(Policy.effective_date.desc(), Policy.created_at.desc())
                    ).all()
                    cat_to_policy_id[cat] = str(rows[0][1].policy_id) if rows else None
                logger.info("[API_ANALYZE_BG] Category→policy map: %s", cat_to_policy_id)

                # 3. Group document_ids by resolved policy_id (None = unmatched)
                groups: dict[Optional[str], list[str]] = {}
                for receipt in all_receipts:
                    if not receipt.document_id:
                        continue
                    pid = cat_to_policy_id.get(receipt.category)
                    groups.setdefault(pid, []).append(str(receipt.document_id))

                matched_groups = [(pid, dids) for pid, dids in groups.items() if pid is not None]
                unmatched_doc_ids = groups.get(None, [])
                all_results: list[dict] = []

                def progress_callback(stage: str, data: dict):
                    logger.info("[API_ANALYZE_BG] task=%s stage=%s", task_id, stage)
                    tracker.publish(task_id, stage, data)

                # 4. Unmatched receipts → direct MANUAL_REVIEW (no agent)
                if unmatched_doc_ids:
                    logger.info("[API_ANALYZE_BG] Creating MANUAL_REVIEW for %d unmatched receipts", len(unmatched_doc_ids))
                    unmatched_receipts = [
                        r for r in all_receipts
                        if r.document_id and str(r.document_id) in unmatched_doc_ids
                    ]
                    unmatched_total = Decimal(str(sum(
                        float(r.claimed_amount or 0) for r in unmatched_receipts
                    )))
                    unmatched_reim = _undecided_claim(
                        user_id=UUID(user_id_str),
                        policy_id=None,
                        settlement_id=settlement_uuid,
                        main_category="Uncategorized",
                        currency=settlement_currency,
                        total_claimed_amount=unmatched_total,
                        summary="No matching active policy found for these receipts. Manual review required.",
                        ai_reasoning={"unmatched_documents": unmatched_doc_ids, "pipeline_failure": False},
                    )
                    bg_db.add(unmatched_reim)
                    bg_db.commit()
                    bg_db.refresh(unmatched_reim)
                    all_results.append(_build_reimbursement_response(unmatched_reim, bg_db, include_line_items=False, viewer_is_hr=viewer_is_hr))

                # 5. Run compliance agent once per matched policy group
                for i, (policy_id_str, doc_ids) in enumerate(matched_groups):
                    policy_obj = bg_db.get(Policy, UUID(policy_id_str))
                    policy_alias = policy_obj.title if policy_obj else policy_id_str

                    tracker.publish(task_id, "compliance_analysis", {
                        "message": f"Evaluating policy {i + 1} of {len(matched_groups)}: {policy_alias}...",
                        "policy_index": i + 1,
                        "policy_total": len(matched_groups),
                        "policy_alias": policy_alias,
                    })

                    group_receipts = [r for r in all_receipts if r.document_id and str(r.document_id) in doc_ids]
                    group_categories = list({r.category for r in group_receipts if r.category})
                    cat_counts = Counter(r.category for r in group_receipts if r.category)
                    group_main_category = cat_counts.most_common(1)[0][0] if cat_counts else "General"

                    logger.info("[API_ANALYZE_BG] Group %d/%d policy=%s docs=%d cats=%s", i + 1, len(matched_groups), policy_alias, len(doc_ids), group_categories)

                    try:
                        result = run_compliance_workflow(
                            settlement_id=body.settlement_id,
                            policy_id=policy_id_str,
                            main_category=group_main_category,
                            user_id=user_id_str,
                            all_category=group_categories,
                            session=bg_db,
                            document_ids=doc_ids,
                            progress_callback=progress_callback,
                        )
                        reim_id = result.get("reimbursement_id")
                        if not reim_id:
                            raise ValueError("Compliance workflow returned no reimbursement_id")
                        reim = bg_db.get(Reimbursement, UUID(reim_id))
                        if not reim:
                            raise ValueError(f"Reimbursement {reim_id} not found in DB after creation")
                        logger.info("[API_ANALYZE_BG] Group %d complete: reim_id=%s judgment=%s tier=%s", i + 1, reim_id, result.get("judgment"), reim.tier)
                        try:
                            _auto_payout(bg_db, reim, loop, timeline_emitter(progress_callback))
                        except Exception:
                            logger.exception("[API_ANALYZE_BG] Payout step failed for reim=%s", reim_id)
                        all_results.append(_build_reimbursement_response(reim, bg_db, include_line_items=True, viewer_is_hr=viewer_is_hr))
                    except Exception as group_err:
                        logger.exception("[API_ANALYZE_BG] Compliance failed for policy=%s", policy_alias)
                        try:
                            # Calculate total claimed from group receipts so fallback has meaningful amount
                            total_claimed = sum((float(r.claimed_amount) or 0) for r in group_receipts)

                            fail_reim = _undecided_claim(
                                user_id=UUID(user_id_str),
                                policy_id=UUID(policy_id_str),
                                settlement_id=settlement_uuid,
                                main_category=group_main_category,
                                currency=settlement_currency,
                                total_claimed_amount=Decimal(str(total_claimed)),
                                summary=f"Compliance pipeline failed for '{policy_alias}' — manual review required. Error: {str(group_err)[:500]}",
                                ai_reasoning={"error": str(group_err), "pipeline_failure": True, "policy_id": policy_id_str},
                            )
                            bg_db.add(fail_reim)
                            bg_db.commit()
                            bg_db.refresh(fail_reim)
                            all_results.append(_build_reimbursement_response(fail_reim, bg_db, include_line_items=False, viewer_is_hr=viewer_is_hr))
                        except Exception as fallback_err:
                            logger.exception("[API_ANALYZE_BG] Fallback MANUAL_REVIEW failed: %s", fallback_err)

                logger.info("[API_ANALYZE_BG] Publishing complete with %d reimbursements", len(all_results))

                try:
                    _notify_claims_for_review(bg_db, UUID(user_id_str), all_results)
                except Exception:
                    logger.exception("[API_ANALYZE_BG] Failed to send submission notification")

                tracker.publish(task_id, "complete", {"reimbursements": all_results})

            except Exception as e:
                logger.exception("[API_ANALYZE_BG] Fatal error in background processing")
                tracker.publish(task_id, "error", {"message": str(e)})

    loop.run_in_executor(_executor, _process_background)

    logger.info("[API_ANALYZE] Returning task_id=%s", task_id)
    return {"task_id": task_id}


@router.get("/analyze/progress/{task_id}")
async def analyze_progress(
    task_id: str,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
):
    """SSE endpoint: stream progress events for a compliance analysis task, to its owner only."""
    logger.info("[API_SSE] Client connected to reimbursements/analyze/progress/%s", task_id)
    tracker = ProgressTracker()
    owner_id = tracker.owner_of(task_id)
    if owner_id is not None and owner_id != current_user.user_id:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Access denied")
    # The stream can run for minutes; don't hold a pooled connection that long.
    db.close()

    async def event_generator():
        try:
            async for event_str in tracker.subscribe(task_id):
                logger.info("[API_SSE] Streaming event for task=%s: %s", task_id, event_str.strip().replace("\n", " "))
                yield event_str
        except asyncio.CancelledError:
            logger.info("[API_SSE] Client disconnected from task=%s", task_id)
        finally:
            asyncio.create_task(tracker.cleanup(task_id))

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        }
    )
