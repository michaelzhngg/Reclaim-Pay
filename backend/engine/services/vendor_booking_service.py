"""Vendor booking intake: deterministic policy check and the one call to decide()."""

from dataclasses import dataclass
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID, uuid4

from sqlmodel import Session, select

from core.config import settings
from core.enums import JudgmentResult, PolicyStatus, ReimbursementKind, ReimbursementStatus, UserRole
from core.models import (
    LineItem,
    Policy,
    PolicyReimbursableCategory,
    Reimbursement,
    User,
    Vendor,
    VendorBooking,
)
from engine.risk.autonomy import decide
from engine.risk.types import ClaimFacts
from engine.services import autonomy_store


def vendor_name_key(name: str) -> str:
    """Conservative identity key: case-fold, trim and collapse whitespace only."""
    return " ".join(name.split()).casefold()


@dataclass(frozen=True)
class PolicyCheck:
    policy_id: UUID | None
    judgment: JudgmentResult
    over_budget: bool
    category_budget: float | None


def check_booking_policy(db: Session, category: str, amount: float) -> PolicyCheck:
    """Find the active policy listing this category, newest effective date first.

    No policy means the booking fails closed to HR. An amount over the category's
    auto-approval budget is still policy-compliant; the existing over-budget hard stop
    routes it to HR.
    """
    rows = db.exec(
        select(PolicyReimbursableCategory, Policy)
        .join(Policy, PolicyReimbursableCategory.policy_id == Policy.policy_id)
        .where(
            PolicyReimbursableCategory.category == category,
            Policy.status == PolicyStatus.ACTIVE,
        )
        .order_by(Policy.effective_date.desc(), Policy.created_at.desc())
    ).all()
    if not rows:
        return PolicyCheck(policy_id=None, judgment=JudgmentResult.NEEDS_INFO, over_budget=False,
                           category_budget=None)

    policy_category, policy = rows[0]
    budget = float(policy_category.auto_approval_budget) if policy_category.auto_approval_budget is not None else None
    return PolicyCheck(
        policy_id=policy.policy_id,
        judgment=JudgmentResult.APPROVED,
        over_budget=budget is not None and amount > budget,
        category_budget=budget,
    )


def resolve_vendor(db: Session, name: str, category: str, requester_id: UUID) -> tuple[Vendor, bool]:
    """Reuse a vendor by conservative name key, otherwise create it unverified."""
    key = vendor_name_key(name)
    existing = db.exec(select(Vendor).where(Vendor.name_key == key)).first()
    if existing:
        return existing, False
    vendor = Vendor(
        name=" ".join(name.split()),
        name_key=key,
        default_category=category,
        created_by=requester_id,
    )
    db.add(vendor)
    db.flush()
    return vendor, True


def _booking_summary(vendor: Vendor, category: str, purpose: str) -> str:
    return f"Vendor booking: {vendor.name}, {category}. {purpose.strip()}"


def create_booking(
    db: Session,
    requester: User,
    *,
    vendor_name: str,
    category: str,
    amount: Decimal | float,
    service_start: date,
    service_end: date,
    purpose: str,
    now: datetime | None = None,
) -> tuple[Reimbursement, VendorBooking, Vendor, bool]:
    """Persist a booking and its decision. Returns (reimbursement, booking, vendor, vendor_created).

    Only decide() sets AUTO_PAY. This function never overrides its tier.
    """
    now = now or datetime.now(timezone.utc)
    amount = float(amount)
    vendor, vendor_created = resolve_vendor(db, vendor_name, category, requester.user_id)
    policy = check_booking_policy(db, category, amount)

    reim_id = uuid4()
    facts = ClaimFacts(
        reim_id=str(reim_id),
        user_id=str(requester.user_id),
        amount=amount,
        currency=settings.PAYPAL_CURRENCY,
        judgment=policy.judgment.value,
        # The policy check is deterministic, so there is no confidence to discount.
        confidence=1.0,
        over_category_budget=policy.over_budget,
        claimant_is_hr=requester.role == UserRole.HR,
    )
    decision = decide(
        facts,
        [],
        autonomy_store.employee_history(db, requester.user_id, now),
        autonomy_store.payee_from_vendor(vendor),
        autonomy_store.ledger_snapshot(db, now),
        autonomy_store.get_config(db),
        now,
    )

    auto_pay = decision.tier.value == "AUTO_PAY"
    status = ReimbursementStatus.APPROVED if auto_pay else ReimbursementStatus.REVIEW
    reim = Reimbursement(
        reim_id=reim_id,
        user_id=requester.user_id,
        policy_id=policy.policy_id,
        kind=ReimbursementKind.VENDOR_BOOKING.value,
        main_category=category,
        currency=settings.PAYPAL_CURRENCY,
        total_claimed_amount=amount,
        total_approved_amount=amount if auto_pay else None,
        judgment=policy.judgment,
        confidence=1.0,
        ai_reasoning={
            "source": "vendor_booking",
            "policy_check": {
                "category": category,
                "category_budget": policy.category_budget,
                "over_budget": policy.over_budget,
                "policy_id": str(policy.policy_id) if policy.policy_id else None,
            },
        },
        summary=_booking_summary(vendor, category, purpose),
        status=status,
        reviewed_at=now if auto_pay else None,
        tier=decision.tier.value,
        risk_score=decision.risk_score,
        autonomy=decision.model_dump(mode="json"),
        audit_selected=decision.audit_selected,
    )
    db.add(reim)
    db.flush()

    booking = VendorBooking(
        reim_id=reim.reim_id,
        vendor_id=vendor.vendor_id,
        service_start=service_start,
        service_end=service_end,
        purpose=purpose.strip(),
        created_at=now,
    )
    db.add(booking)
    db.add(LineItem(
        reim_id=reim.reim_id,
        description=f"{vendor.name} booking: {purpose.strip()}",
        category=category,
        quantity=1.0,
        unit_price=amount,
        claimed_amount=amount,
        approved_amount=amount,
        currency=settings.PAYPAL_CURRENCY,
        expense_date=service_start,
        judgment=policy.judgment,
    ))
    db.commit()
    db.refresh(reim)
    db.refresh(booking)
    return reim, booking, vendor, vendor_created


def booking_context(db: Session, reim_ids: list[UUID]) -> tuple[dict, dict]:
    """Bulk lookup for list responses: {reim_id: VendorBooking} and {vendor_id: Vendor}."""
    if not reim_ids:
        return {}, {}
    bookings = {
        b.reim_id: b
        for b in db.exec(select(VendorBooking).where(VendorBooking.reim_id.in_(reim_ids))).all()
    }
    vendor_ids = {b.vendor_id for b in bookings.values()}
    vendors = (
        {v.vendor_id: v for v in db.exec(select(Vendor).where(Vendor.vendor_id.in_(vendor_ids))).all()}
        if vendor_ids else {}
    )
    return bookings, vendors
