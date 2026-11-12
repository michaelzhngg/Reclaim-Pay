"""Vendor directory and employee vendor bookings."""

import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from api import deps
from api.paypal import PAYEE_COOLDOWN_HOURS, cooldown_until
from api.reimbursements import _build_reimbursement_response
from core.enums import UserRole
from core.models import User, Vendor
from engine.services.paypal_client import mask_email
from engine.services.vendor_booking_service import create_booking

router = APIRouter()
logger = logging.getLogger(__name__)


class VendorOut(BaseModel):
    vendor_id: UUID
    name: str
    default_category: Optional[str] = None
    paypal_ready: bool
    # HR-only fields.
    paypal_email_masked: Optional[str] = None
    paypal_verified: bool
    paypal_linked_at: Optional[datetime] = None
    cooldown_until: Optional[datetime] = None


class VendorBookingCreate(BaseModel):
    vendor_id: Optional[UUID] = None
    vendor_name: Optional[str] = Field(default=None, max_length=200)
    category: str = Field(min_length=1, max_length=100)
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    service_start: date
    service_end: date
    purpose: str = Field(min_length=2, max_length=1000)

    @field_validator("vendor_name", "category", "purpose")
    @classmethod
    def _strip(cls, value: Optional[str]) -> Optional[str]:
        return value.strip() if isinstance(value, str) else value


def vendor_out(vendor: Vendor, viewer_is_hr: bool) -> VendorOut:
    until = cooldown_until(vendor.payout_destination_changed_at, PAYEE_COOLDOWN_HOURS)
    if until and until <= datetime.now(timezone.utc):
        until = None
    return VendorOut(
        vendor_id=vendor.vendor_id,
        name=vendor.name,
        default_category=vendor.default_category,
        paypal_ready=bool(vendor.paypal_verified and vendor.paypal_payer_id),
        paypal_email_masked=mask_email(vendor.paypal_email) if viewer_is_hr and vendor.paypal_email else None,
        paypal_verified=bool(vendor.paypal_verified) if viewer_is_hr else False,
        paypal_linked_at=vendor.paypal_linked_at if viewer_is_hr else None,
        cooldown_until=until if viewer_is_hr else None,
    )


@router.get("/vendors", response_model=list[VendorOut])
def list_vendors(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
):
    """Active vendors for the booking picker. Employees see names, not payout details."""
    vendors = db.exec(select(Vendor).where(Vendor.is_active == True).order_by(Vendor.name)).all()  # noqa: E712
    return [vendor_out(v, current_user.role == UserRole.HR) for v in vendors]


@router.post("/vendor-bookings", status_code=status.HTTP_201_CREATED)
def create_vendor_booking(
    body: VendorBookingCreate,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
) -> dict:
    if body.service_end < body.service_start:
        raise HTTPException(status_code=422, detail="SERVICE_END_BEFORE_START")

    if body.vendor_id:
        vendor = db.get(Vendor, body.vendor_id)
        if not vendor or not vendor.is_active:
            raise HTTPException(status_code=404, detail="Vendor not found")
        vendor_name = vendor.name
    else:
        vendor_name = (body.vendor_name or "").strip()
        if not vendor_name:
            raise HTTPException(status_code=422, detail="VENDOR_REQUIRED")

    reim, booking, vendor, vendor_created = create_booking(
        db,
        current_user,
        vendor_name=vendor_name,
        category=body.category,
        amount=body.amount,
        service_start=body.service_start,
        service_end=body.service_end,
        purpose=body.purpose,
    )
    logger.info(
        "[VENDOR_BOOKING] created reim=%s vendor=%s new_vendor=%s tier=%s",
        reim.reim_id, vendor.vendor_id, vendor_created, reim.tier,
    )
    result = _build_reimbursement_response(
        reim, db, include_line_items=True, viewer_is_hr=current_user.role == UserRole.HR
    )
    result["vendor_created"] = vendor_created
    return result
