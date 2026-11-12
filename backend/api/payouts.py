import logging
from datetime import date, datetime, time, timedelta, timezone
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel
from sqlmodel import Session, select

from api import deps
from api.rate_limit import MAINTENANCE_RUN_LIMIT, limiter
from api.schemas import CreatePayoutRequest
from core.models import User, Reimbursement, Payout, Vendor
from core.enums import ReimbursementStatus, UserRole, PayoutStatus, is_vendor_booking
from engine.jobs.maintenance import MaintenanceReport, StuckPayoutsOut, run_maintenance, stuck_payouts
from engine.services.approvals import approvals_complete
from engine.services.funding_service import FundingSummary, alert_hr, funding_summary
from engine.services.payout_service import initiate_payout_async, payee_for_reim, payout_plan
from engine.services.payout_status import FINAL_STATUSES, refresh_payout
from engine.services.paypal_client import PayPalError
from engine.services.reconcile_history import (
    JOB_DAYS,
    dismiss as dismiss_difference,
    history as reconciliation_history,
    run_and_record,
)
from engine.services.reconcile_service import ReconcileSummary, reconcile
from engine.services.recovery_service import offset_for_reim

router = APIRouter()
logger = logging.getLogger(__name__)

_REFRESH_AFTER = timedelta(seconds=10)
_MANUAL_MAINTENANCE_BATCH = 50


class PayoutOut(BaseModel):
    payout_id: UUID
    reim_id: UUID
    user_id: UUID
    vendor_id: Optional[UUID] = None
    amount: float
    currency: str
    status: PayoutStatus
    provider: str
    provider_batch_id: Optional[str] = None
    provider_item_id: Optional[str] = None
    attempt: int
    xendit_id: Optional[str] = None
    reference_id: str
    channel_code: str
    failure_code: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class PayoutLedgerRow(BaseModel):
    payout_id: UUID
    reim_id: UUID
    claim_ref: str
    employee_name: str
    payee_name: str
    kind: str
    amount: float
    currency: str
    status: PayoutStatus
    tier: Optional[str] = None
    provider_batch_id: Optional[str] = None
    provider_item_id: Optional[str] = None
    attempt: int
    audit_selected: bool
    created_at: datetime
    updated_at: datetime


class ReconciliationRunOut(BaseModel):
    run_id: UUID
    trigger: str
    started_at: datetime
    finished_at: Optional[datetime] = None
    days: int
    window_start: datetime
    window_end: datetime
    state: str
    reconciled: int
    total: int
    pending: int
    differences_new: int
    differences_open: int
    data_through: Optional[datetime] = None
    mock: bool
    message: Optional[str] = None
    error: Optional[str] = None
    triggered_by: Optional[UUID] = None

    class Config:
        from_attributes = True


class ReconciliationDifferenceOut(BaseModel):
    difference_id: UUID
    kind: str
    payout_id: Optional[UUID] = None
    reim_id: Optional[UUID] = None
    transaction_id: Optional[str] = None
    amount: float
    currency: str
    employee_name: Optional[str] = None
    occurred_at: datetime
    first_seen_at: datetime
    last_seen_at: datetime
    resolved_at: Optional[datetime] = None
    resolution: Optional[str] = None

    class Config:
        from_attributes = True


class ReconciliationHistoryOut(BaseModel):
    latest: Optional[ReconciliationRunOut] = None
    last_success_at: Optional[datetime] = None
    runs: list[ReconciliationRunOut] = []
    open_differences: list[ReconciliationDifferenceOut] = []


def ledger_row(payout: Payout, reim: Reimbursement, employee: User, vendor: Vendor | None = None) -> PayoutLedgerRow:
    is_booking = is_vendor_booking(reim)
    return PayoutLedgerRow(
        payout_id=payout.payout_id,
        reim_id=payout.reim_id,
        claim_ref=f"RC-{str(payout.reim_id)[:8].upper()}",
        employee_name=employee.name,
        payee_name=vendor.name if is_booking and vendor else employee.name,
        kind="VENDOR_BOOKING" if is_booking else "CLAIM",
        amount=float(payout.amount),
        currency=payout.currency,
        status=payout.status,
        # tier and audit_selected arrive with the autonomy columns (Chingiz B, DB-1).
        tier=getattr(reim, "tier", None),
        provider_batch_id=payout.provider_batch_id,
        provider_item_id=payout.provider_item_id,
        attempt=payout.attempt,
        audit_selected=bool(getattr(reim, "audit_selected", False)),
        created_at=payout.created_at,
        updated_at=payout.updated_at,
    )


_SKIP_DETAIL = {
    "SKIP_NOT_APPROVED": "Claim must be APPROVED (or DISBURSEMENT_FAILED for a retry) before it can be paid.",
    "SKIP_EXISTING": "A payout for this claim is already in progress or has succeeded.",
    "SKIP_NO_PAYEE": "The payee has not connected a verified PayPal account.",
}


_ENDED_UNPAID = {PayoutStatus.FAILED, PayoutStatus.CANCELLED, PayoutStatus.REVERSED}


def _require_genuine_approval(reim: Reimbursement, caller: User, existing: list[Payout]) -> None:
    """Refuse a payout unless the approval rules were met. Payout status alone proves nothing."""
    if reim.user_id == caller.user_id:
        raise HTTPException(status_code=403, detail="SELF_APPROVAL")
    if reim.status not in (ReimbursementStatus.APPROVED, ReimbursementStatus.DISBURSEMENT_FAILED):
        return
    if reim.status == ReimbursementStatus.DISBURSEMENT_FAILED and not any(
        PayoutStatus(p.status) in _ENDED_UNPAID for p in existing
    ):
        raise HTTPException(status_code=409, detail="This claim has no failed payout to resend.")
    if not approvals_complete(reim.tier, reim.approvals, str(reim.user_id), reim.reviewed_by):
        raise HTTPException(status_code=409, detail="This claim doesn't have the HR approvals it needs yet.")


@router.get("/", response_model=list[PayoutLedgerRow])
def list_payouts(
    status: Optional[PayoutStatus] = None,
    from_date: Optional[date] = Query(default=None, alias="from"),
    to_date: Optional[date] = Query(default=None, alias="to"),
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    query = (
        select(Payout, Reimbursement, User)
        .join(Reimbursement, Reimbursement.reim_id == Payout.reim_id)
        .join(User, User.user_id == Payout.user_id)
    )
    if status:
        query = query.where(Payout.status == status)
    if from_date:
        query = query.where(Payout.created_at >= datetime.combine(from_date, time.min, tzinfo=timezone.utc))
    if to_date:
        query = query.where(Payout.created_at < datetime.combine(to_date + timedelta(days=1), time.min, tzinfo=timezone.utc))
    rows = db.exec(query.order_by(Payout.created_at.desc()).limit(500)).all()
    vendor_ids = {payout.vendor_id for payout, _reim, _employee in rows if payout.vendor_id}
    vendors = (
        {v.vendor_id: v for v in db.exec(select(Vendor).where(Vendor.vendor_id.in_(vendor_ids))).all()}
        if vendor_ids else {}
    )
    return [ledger_row(payout, reim, employee, vendors.get(payout.vendor_id)) for payout, reim, employee in rows]


# Declared before GET /{reim_id}, which would otherwise capture "reconcile". Sync because the PayPal SDK blocks.
@router.get("/reconcile", response_model=ReconcileSummary)
def reconcile_payouts(
    days: int = Query(default=1, ge=1, le=30),
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    return reconcile(db, days)


@router.get("/reconcile/history", response_model=ReconciliationHistoryOut)
def reconcile_history(
    runs: int = Query(default=14, ge=1, le=50),
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    found = reconciliation_history(db, runs)
    return ReconciliationHistoryOut(
        latest=ReconciliationRunOut.model_validate(found.latest) if found.latest else None,
        last_success_at=found.last_success_at,
        runs=[ReconciliationRunOut.model_validate(run) for run in found.runs],
        open_differences=[
            ReconciliationDifferenceOut.model_validate(row) for row in found.open_differences
        ],
    )


@router.post("/reconcile/run", response_model=ReconciliationRunOut)
def reconcile_now(
    days: int = Query(default=JOB_DAYS, ge=1, le=30),
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    recorded = run_and_record(db, days=days, trigger="manual", triggered_by=current_user.user_id)
    return ReconciliationRunOut.model_validate(recorded.run)


@router.post("/reconcile/differences/{difference_id}/dismiss",
             response_model=ReconciliationDifferenceOut)
def dismiss_reconciliation_difference(
    difference_id: str,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    try:
        parsed_id = UUID(difference_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid difference_id")
    row = dismiss_difference(db, parsed_id, current_user.user_id)
    if row is None:
        raise HTTPException(status_code=404, detail="Difference not found")
    return ReconciliationDifferenceOut.model_validate(row)


# Also before GET /{reim_id}. Alert only: it never changes a claim or a payout.
@router.get("/funding", response_model=FundingSummary)
async def payout_funding(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    summary = await funding_summary(db)
    try:
        alert_hr(db, summary)
    except Exception:
        logger.exception("[FUNDING] Could not send the low-balance alert")
        db.rollback()
    return summary


# Declared before GET /{reim_id}, which would otherwise capture "stuck" and "maintenance".
@router.get("/stuck", response_model=StuckPayoutsOut)
def get_stuck_payouts(
    limit: int = Query(default=200, ge=1, le=500),
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    return stuck_payouts(db, limit=limit)


@router.post("/maintenance/run", response_model=MaintenanceReport)
@limiter.limit(MAINTENANCE_RUN_LIMIT)
async def run_payout_maintenance(
    request: Request,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    report = await run_maintenance(db, payout_limit=_MANUAL_MAINTENANCE_BATCH)
    if report.locked:
        raise HTTPException(status_code=409, detail="Maintenance is already running")
    return report


@router.post("/", response_model=PayoutOut)
async def create_payout(
    body: CreatePayoutRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    reim = db.get(Reimbursement, body.reim_id)
    if not reim:
        raise HTTPException(status_code=404, detail="Reimbursement not found")

    existing = db.exec(select(Payout).where(Payout.reim_id == body.reim_id)).all()
    _require_genuine_approval(reim, current_user, existing)
    net_amount, applied_offsets = offset_for_reim(db, reim)
    action, _, _ = payout_plan(
        reim.status, net_amount, [p.status for p in existing],
        payee_for_reim(db, reim) is not None,
    )
    if action in _SKIP_DETAIL:
        raise HTTPException(status_code=400, detail=_SKIP_DETAIL[action])
    if action == "SKIP_ZERO":
        if not applied_offsets:
            raise HTTPException(status_code=400, detail="Nothing to pay: no amount was approved on this claim.")
        await initiate_payout_async(body.reim_id, db)
        raise HTTPException(status_code=400, detail="Nothing to pay: the claim was settled against an earlier overpayment.")

    payout = await initiate_payout_async(body.reim_id, db)
    if payout is None:
        raise HTTPException(status_code=502, detail="PayPal did not accept the payout. Try again shortly.")
    return PayoutOut.model_validate(payout)


@router.get("/{reim_id}", response_model=PayoutOut)
async def get_payout(
    reim_id: str,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
):
    try:
        reim_uuid = UUID(reim_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid reim_id")

    reim = db.get(Reimbursement, reim_uuid)
    if not reim:
        raise HTTPException(status_code=404, detail="Reimbursement not found")

    if current_user.role != UserRole.HR and reim.user_id != current_user.user_id:
        raise HTTPException(status_code=403, detail="Access denied")

    payout = db.exec(
        select(Payout).where(Payout.reim_id == reim_uuid).order_by(Payout.attempt.desc())
    ).first()
    if not payout:
        raise HTTPException(status_code=404, detail="No payout found for this claim")

    stale = payout.updated_at is None or datetime.now(timezone.utc) - payout.updated_at > _REFRESH_AFTER
    if payout.provider == "PAYPAL" and PayoutStatus(payout.status) not in FINAL_STATUSES and stale:
        try:
            payout = await refresh_payout(db, payout)
        except PayPalError:
            # A PayPal outage must not break the claim page: show the last known status.
            logger.warning("[PAYOUT] Status refresh failed for reim=%s; returning stored status", reim_uuid)
            db.rollback()

    return PayoutOut.model_validate(payout)
