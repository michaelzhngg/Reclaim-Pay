"""Vendor directory and employee vendor bookings."""

import hashlib
import logging
from datetime import date, datetime, timezone
from decimal import Decimal
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, EmailStr, Field, field_validator
from sqlmodel import Session, select

from api import deps
from api.reimbursements import _build_reimbursement_response
from core.config import settings
from core.enums import AgentActionType, UserRole
from core.models import User, Vendor
from engine.services.action_log import record_action
from engine.services.payee_link import PAYEE_COOLDOWN_HOURS, cooldown_until, link_update
from engine.services.payout_service import initiate_payout_async
from engine.services.paypal_client import PayPalUser, mask_email
from engine.services.vendor_booking_service import create_booking
from engine.services import autonomy_store

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
    cooldown_hours: int = PAYEE_COOLDOWN_HOURS


class VendorPaypalVerify(BaseModel):
    # Optional in mock mode: HR can attest a billing email or let the mock issuer provide one.
    paypal_email: Optional[EmailStr] = None


class VendorPaypalChange(BaseModel):
    paypal_email: EmailStr


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


def vendor_out(vendor: Vendor, viewer_is_hr: bool, cooldown_hours: int = PAYEE_COOLDOWN_HOURS) -> VendorOut:
    until = cooldown_until(vendor.payout_destination_changed_at, cooldown_hours)
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
        cooldown_hours=cooldown_hours,
    )


@router.get("/vendors", response_model=list[VendorOut])
def list_vendors(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_non_contractor_user),
):
    """Active vendors for the booking picker. Employees see names, not payout details."""
    vendors = db.exec(select(Vendor).where(Vendor.is_active == True).order_by(Vendor.name)).all()  # noqa: E712
    hours = autonomy_store.payee_cooldown_hours(db)
    return [vendor_out(v, current_user.role == UserRole.HR, hours) for v in vendors]


def _mock_vendor_paypal(email: str) -> PayPalUser:
    # Deterministic in mock mode so repeated verification or the same email is a no-op.
    payer_id = "MOCKV" + hashlib.sha256(email.lower().encode()).hexdigest()[:12].upper()
    return PayPalUser(payer_id=payer_id, email=email, verified=True)


def _identity_taken(db: Session, payer_id: str, vendor_id: UUID) -> bool:
    other_vendor = db.exec(
        select(Vendor).where(Vendor.paypal_payer_id == payer_id, Vendor.vendor_id != vendor_id)
    ).first()
    employee = db.exec(select(User).where(User.paypal_payer_id == payer_id)).first()
    return bool(other_vendor or employee)


@router.post("/vendors/{vendor_id}/verify", response_model=VendorOut)
def verify_vendor(
    vendor_id: UUID,
    body: VendorPaypalVerify | None = None,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    """Attest a vendor's payout account. Mock mode only; real merchant onboarding is not built."""
    vendor = db.get(Vendor, vendor_id)
    if not vendor or not vendor.is_active:
        raise HTTPException(status_code=404, detail="Vendor not found")
    if not settings.PAYPAL_MOCK_MODE:
        raise HTTPException(status_code=409, detail="VENDOR_MERCHANT_ONBOARDING_UNAVAILABLE")

    email = (str(body.paypal_email) if body and body.paypal_email
             else f"billing+{vendor_id.hex[:8]}@vendor.example")
    identity = _mock_vendor_paypal(email)
    if _identity_taken(db, identity.payer_id, vendor.vendor_id):
        raise HTTPException(status_code=409, detail="PAYEE_ALREADY_LINKED")

    now = datetime.now(timezone.utc)
    update = link_update(vendor.paypal_payer_id, vendor.paypal_linked_at is not None, identity, now)
    for field, value in update.items():
        setattr(vendor, field, value)
    db.add(vendor)
    db.commit()
    db.refresh(vendor)

    record_action(db, AgentActionType.PAYEE_LINKED, str(current_user.user_id), None, {
        "vendor_id": str(vendor.vendor_id),
        "email": mask_email(vendor.paypal_email or ""),
        "verified": True,
        "changed": update.get("payout_destination_changed_at") is not None,
    })
    return vendor_out(vendor, viewer_is_hr=True, cooldown_hours=autonomy_store.payee_cooldown_hours(db))


@router.patch("/vendors/{vendor_id}/paypal", response_model=VendorOut)
def change_vendor_paypal(
    vendor_id: UUID,
    body: VendorPaypalChange,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
):
    """Change a vendor's payout account. A payer change after the first link starts the pause."""
    vendor = db.get(Vendor, vendor_id)
    if not vendor or not vendor.is_active:
        raise HTTPException(status_code=404, detail="Vendor not found")
    if not settings.PAYPAL_MOCK_MODE:
        raise HTTPException(status_code=409, detail="VENDOR_MERCHANT_ONBOARDING_UNAVAILABLE")

    identity = _mock_vendor_paypal(str(body.paypal_email))
    if identity.payer_id == vendor.paypal_payer_id:
        return vendor_out(vendor, viewer_is_hr=True, cooldown_hours=autonomy_store.payee_cooldown_hours(db))
    if _identity_taken(db, identity.payer_id, vendor.vendor_id):
        raise HTTPException(status_code=409, detail="PAYEE_ALREADY_LINKED")

    now = datetime.now(timezone.utc)
    update = link_update(vendor.paypal_payer_id, vendor.paypal_linked_at is not None, identity, now)
    for field, value in update.items():
        setattr(vendor, field, value)
    db.add(vendor)
    db.commit()
    db.refresh(vendor)

    record_action(db, AgentActionType.PAYEE_LINKED, str(current_user.user_id), None, {
        "vendor_id": str(vendor.vendor_id),
        "email": mask_email(vendor.paypal_email or ""),
        "verified": True,
        "changed": update.get("payout_destination_changed_at") is not None,
    })
    return vendor_out(vendor, viewer_is_hr=True, cooldown_hours=autonomy_store.payee_cooldown_hours(db))


@router.post("/vendor-bookings", status_code=status.HTTP_201_CREATED)
async def create_vendor_booking(
    body: VendorBookingCreate,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_non_contractor_user),
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
    status_value = getattr(reim.status, "value", reim.status)
    if status_value == "APPROVED":
        # decide() approved it, so the existing payout service pays the vendor. On failure
        # the booking stays APPROVED for HR retry from the payouts screen.
        payout = await initiate_payout_async(reim.reim_id, db)
        if payout is None:
            logger.warning("[VENDOR_BOOKING] payout did not start for reim=%s", reim.reim_id)
        db.refresh(reim)

    result = _build_reimbursement_response(
        reim, db, include_line_items=True, viewer_is_hr=current_user.role == UserRole.HR
    )
    result["vendor_created"] = vendor_created
    return result
