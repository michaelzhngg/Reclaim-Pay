"""Contractor invoices: a `Reimbursement` linked to the contract, at the contract rate."""

from datetime import date
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session

from api import deps
from api.reimbursements import _build_reimbursement_response
from core.models import User
from engine.risk.types import AutonomyTier
from engine.services import contractor_invoices as service
from engine.services.contractor_invoices import InvoiceError
from engine.services.payout_service import initiate_payout_sync

router = APIRouter()


class InvoiceCreate(BaseModel):
    period_start: date
    period_end: date
    description: str
    quantity: float
    # Defaults to the contract rate when omitted. A value above it routes to HR.
    unit_price: Optional[float] = None
    claimed_amount: float
    note: Optional[str] = None
    # Echoes are accepted, overrides are refused.
    currency: Optional[str] = None
    category: Optional[str] = None


def _fail(error: InvoiceError):
    code = status.HTTP_403_FORBIDDEN if error.code == "NOT_A_CONTRACTOR" else (
        status.HTTP_422_UNPROCESSABLE_ENTITY
    )
    detail = error.code if str(error) == error.code else f"{error.code}: {error}"
    raise HTTPException(status_code=code, detail=detail)


@router.post("/", status_code=status.HTTP_201_CREATED)
def submit_invoice(
    body: InvoiceCreate,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_contractor_user),
) -> dict:
    """Submit an invoice. Only `decide()` decides the tier; an AUTO_PAY invoice uses the normal payout service."""
    try:
        reim, decision = service.create_invoice(
            db,
            current_user,
            period_start=body.period_start,
            period_end=body.period_end,
            description=body.description,
            quantity=body.quantity,
            unit_price=body.unit_price,
            claimed_amount=body.claimed_amount,
            note=body.note,
            currency=body.currency,
            category=body.category,
        )
    except InvoiceError as error:
        _fail(error)

    if decision.tier == AutonomyTier.AUTO_PAY:
        # Same payout service as an auto-paid claim. A failure leaves the invoice approved
        # for HR to resend, exactly like a claim.
        try:
            initiate_payout_sync(reim.reim_id, db)
            db.refresh(reim)
        except Exception:
            db.rollback()

    return _build_reimbursement_response(
        reim, db, viewer_is_hr=False, viewer_is_contractor=True
    )
