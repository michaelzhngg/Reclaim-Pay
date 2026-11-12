"""
Throwaway claims for the Postman collection's approval and recovery requests.

The API has no way to delete a claim, and creating one with a tier needs the AI pipeline, so these
rows go straight to the database and `down` removes them. The agent action log keeps what the run
wrote, because it is hash-chained and has no foreign key to claims.

    uv run python -m seeds.newman_fixtures up
    uv run python -m seeds.newman_fixtures down

Claims are tagged `ai_reasoning.newman_fixture`, which is how the collection finds them. The fixture
employee has no linked PayPal account, so approving these claims can never start a payout.
"""
import argparse
import os
import sys
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlparse
from uuid import UUID

os.environ.setdefault("SECRET_KEY", "newman-fixtures-sign-nothing")

from sqlalchemy import cast, delete, or_, String, update
from sqlmodel import Session, create_engine, select

from core.config import settings
from core.enums import JudgmentResult, RecoveryStatus, ReimbursementStatus, UserRole
from core.models import (
    LineItem, Notification, Payout, Recovery, Reimbursement, ReimbursementSubCategory, User, Vendor, VendorBooking,
)

EMPLOYEE_EMAIL = "newman-employee@example.com"
LOCAL_DB_HOSTS = {"localhost", "127.0.0.1", "db"}
RISKY_DECISION = {
    "tier": "DUAL_REVIEW", "trust_tier": "STANDARD", "auto_limit": 100.0, "audit_selected": False, "config_version": 1,
    "risk_score": 85, "hard_stops": ["OVER_AUTO_LIMIT"], "explanation": "Fixture: HR-only explanation.",
    "signals": [{"code": "PROMPT_INJECTION", "severity": "HIGH", "score": 85, "message": "Fixture: HR-only signal."}],
}
SAFE_DECISION = {
    "tier": "HR_QUICK", "trust_tier": "STANDARD", "auto_limit": 100.0, "audit_selected": False, "config_version": 1,
    "risk_score": 25, "hard_stops": [], "explanation": "Fixture: HR-only explanation.", "signals": [],
}


def _claim(db: Session, key: str, owner: User, tier: str, status: ReimbursementStatus, amount: float,
           now: datetime, decision: dict) -> Reimbursement:
    paid = status == ReimbursementStatus.PAID
    claim = Reimbursement(
        user_id=owner.user_id, main_category="Transportation", currency="MYR", total_claimed_amount=amount,
        total_approved_amount=amount, judgment=JudgmentResult.APPROVED if paid else JudgmentResult.NEEDS_INFO,
        confidence=0.9, ai_reasoning={"newman_fixture": key}, summary=f"Newman fixture: {key}", status=status,
        tier=tier, risk_score=decision["risk_score"], autonomy={**decision, "tier": tier}, created_at=now, updated_at=now,
    )
    db.add(claim)
    db.flush()
    db.add(LineItem(reim_id=claim.reim_id, description=f"Newman fixture: {key}", category="Transportation", quantity=1.0,
                    unit_price=amount, claimed_amount=amount, approved_amount=amount, currency="MYR",
                    expense_date=date(2026, 11, 3), judgment=JudgmentResult.APPROVED))
    return claim


def up(db: Session) -> None:
    down(db)
    hr = db.exec(select(User).where(User.email == "hr@example.com")).first()
    if hr is None:
        sys.exit("hr@example.com is missing. Run `python -m seeds.seed_reclaim_pay` first.")

    # Shares hr@'s hash, so the fixture account uses the same demo password.
    employee = User(email=EMPLOYEE_EMAIL, hashed_password=hr.hashed_password, name="Newman Fixture",
                    role=UserRole.Employee, rank=1)
    db.add(employee)
    db.flush()

    now = datetime.now(timezone.utc)
    review = ReimbursementStatus.REVIEW
    paid = ReimbursementStatus.PAID
    _claim(db, "quick", employee, "HR_QUICK", review, 12.0, now, SAFE_DECISION)
    _claim(db, "dual", employee, "DUAL_REVIEW", review, 24.0, now, RISKY_DECISION)
    _claim(db, "self", hr, "HR_QUICK", review, 15.0, now, SAFE_DECISION)
    # Oldest unpaid claim, so the expired recovery below offsets against this one.
    _claim(db, "offset_target", employee, "HR_REVIEW", review, 100.0, now - timedelta(days=1), SAFE_DECISION)
    _claim(db, "paid_open", employee, "AUTO_PAY", paid, 50.0, now, SAFE_DECISION)
    expired = _claim(db, "paid_expired", employee, "AUTO_PAY", paid, 60.0, now, SAFE_DECISION)
    db.add(Recovery(reim_id=expired.reim_id, user_id=employee.user_id, amount=20.0, currency="MYR",
                    reason="Newman fixture: window already closed", status=RecoveryStatus.NOTICE_SENT.value,
                    dispute_until=now - timedelta(days=1), created_by=hr.user_id, created_at=now, updated_at=now))
    db.commit()
    print("Newman fixtures created: 6 claims, 1 recovery, 1 employee")


def down(db: Session) -> None:
    employee = db.exec(select(User).where(User.email == EMPLOYEE_EMAIL)).first()
    owned = Reimbursement.user_id == employee.user_id if employee else False
    tagged = Reimbursement.ai_reasoning["newman_fixture"].astext.isnot(None)
    claim_ids: list[UUID] = list(db.exec(select(Reimbursement.reim_id).where(or_(tagged, owned))).all())

    if claim_ids:
        recoveries = list(db.exec(select(Recovery.recovery_id).where(or_(
            Recovery.reim_id.in_(claim_ids), Recovery.offset_reim_id.in_(claim_ids)))).all())
        # HR gets notified about disputes too, and those notifications link to the claim.
        links = [Notification.link.contains(str(reim_id)) for reim_id in claim_ids]
        links += [cast(Notification.link, String).contains(str(rec_id)) for rec_id in recoveries]
        db.exec(delete(Notification).where(or_(*links)))
        db.exec(delete(Recovery).where(Recovery.recovery_id.in_(recoveries)))
        db.exec(delete(Payout).where(Payout.reim_id.in_(claim_ids)))
        db.exec(delete(VendorBooking).where(VendorBooking.reim_id.in_(claim_ids)))
        db.exec(delete(LineItem).where(LineItem.reim_id.in_(claim_ids)))
        db.exec(delete(ReimbursementSubCategory).where(ReimbursementSubCategory.reim_id.in_(claim_ids)))
        db.exec(delete(Reimbursement).where(Reimbursement.reim_id.in_(claim_ids)))
    if employee:
        db.exec(update(Vendor).where(Vendor.created_by == employee.user_id).values(created_by=None))
        db.exec(delete(Notification).where(Notification.user_id == employee.user_id))
        db.delete(employee)
    db.commit()
    print(f"Newman fixtures removed: {len(claim_ids)} claims")


def main() -> None:
    parser = argparse.ArgumentParser(description="Create or remove the Postman collection's throwaway claims.")
    parser.add_argument("action", choices=["up", "down"])
    args = parser.parse_args()
    host = urlparse(settings.DATABASE_URL).hostname
    if host not in LOCAL_DB_HOSTS:
        sys.exit(f"Refusing to touch a non-local database ({host}).")
    with Session(create_engine(settings.DATABASE_URL)) as db:
        up(db) if args.action == "up" else down(db)


if __name__ == "__main__":
    main()
