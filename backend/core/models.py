from typing import Optional, List
from uuid import UUID, uuid4
from datetime import datetime, timezone, date

from sqlmodel import Field, SQLModel, Column, String, Text, Integer, Boolean, DateTime, Float, Date, Numeric
from sqlalchemy.dialects.postgresql import JSONB, UUID as PG_UUID
from pgvector.sqlalchemy import Vector
from sqlalchemy import BigInteger, ForeignKey, Index, UniqueConstraint, text

from core.enums import (
    UserRole,
    PrivilegeLevel,
    ReimbursementStatus,
    JudgmentResult,
    DocumentClass,
    PolicyStatus,
    PayoutStatus,
    RecoveryStatus,
    AgentActionType,
    LimitStatus,
)
from core.enums import SignalVerdict


# ---------------------------------------------------------------------------
# 1. employees
# ---------------------------------------------------------------------------

class User(SQLModel, table=True):
    __tablename__ = "employees"

    user_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    user_code: Optional[str] = Field(
        default=None,
        sa_column=Column(String, nullable=True, unique=True, index=True)
    )
    email: str = Field(
        sa_column=Column(String, unique=True, index=True, nullable=False)
    )
    hashed_password: str = Field(
        sa_column=Column(String, nullable=False)
    )
    name: str = Field(
        sa_column=Column(String, nullable=False)
    )
    role: UserRole = Field(
        default=UserRole.Employee,
        sa_column=Column(String, nullable=False)
    )
    department_id: Optional[UUID] = Field(
        default=None,
        foreign_key="departments.department_id"
    )
    rank: Optional[int] = Field(
        default=1,
        sa_column=Column(Integer)
    )
    privilege_level: PrivilegeLevel = Field(
        default=PrivilegeLevel.Standard,
        sa_column=Column(String, nullable=False)
    )
    is_active: bool = Field(
        default=True,
        sa_column=Column(Boolean, nullable=False)
    )
    bank_code: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    bank_account_number: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    bank_account_holder_name: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    paypal_payer_id: Optional[str] = Field(
        default=None,
        sa_column=Column(String, index=True)
    )
    paypal_email: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    paypal_verified: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default="false")
    )
    paypal_linked_at: Optional[datetime] = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True))
    )
    payout_destination_changed_at: Optional[datetime] = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True))
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 2. departments
# ---------------------------------------------------------------------------

class Department(SQLModel, table=True):
    __tablename__ = "departments"

    department_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    name: str = Field(
        sa_column=Column(String, unique=True, nullable=False)
    )
    cost_center_code: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )


# ---------------------------------------------------------------------------
# 3. policies
# ---------------------------------------------------------------------------

class Policy(SQLModel, table=True):
    __tablename__ = "policies"

    policy_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    alias: str = Field(
        sa_column=Column(String, unique=True, index=True, nullable=False)
    )
    title: str = Field(
        sa_column=Column(String, nullable=False)
    )
    effective_date: datetime = Field(
        sa_column=Column(DateTime(timezone=True))
    )
    expiry_date: Optional[datetime] = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True))
    )
    overview_summary: str = Field(
        sa_column=Column(Text)
    )
    mandatory_conditions: str = Field(
        sa_column=Column(Text)
    )
    source_file_url: str = Field(
        sa_column=Column(String)
    )
    status: PolicyStatus = Field(
        default=PolicyStatus.DRAFT,
        sa_column=Column(String, nullable=False)
    )
    created_by: UUID = Field(
        foreign_key="employees.user_id"
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 4. policy_reimbursable_categories
# ---------------------------------------------------------------------------

class PolicyReimbursableCategory(SQLModel, table=True):
    __tablename__ = "policy_reimbursable_categories"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    policy_id: UUID = Field(foreign_key="policies.policy_id", index=True)
    category: str = Field(sa_column=Column(String, nullable=False))
    auto_approval_budget: Optional[float] = Field(default=None, sa_column=Column(Numeric(12, 2), nullable=True))

    __table_args__ = (
        UniqueConstraint("policy_id", "category", name="uq_policy_category"),
    )


# ---------------------------------------------------------------------------
# 5. policy_sections
# ---------------------------------------------------------------------------

class PolicySection(SQLModel, table=True):
    __tablename__ = "policy_sections"

    section_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    policy_id: UUID = Field(
        foreign_key="policies.policy_id",
        index=True
    )
    section_title: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    section_order: Optional[int] = Field(
        default=None,
        sa_column=Column(Integer)
    )
    content: str = Field(
        sa_column=Column(Text)
    )
    metadata_data: dict = Field(
        default={},
        sa_column=Column("metadata", JSONB)
    )
    embedding: Optional[List[float]] = Field(
        default=None,
        sa_column=Column(Vector(1536), nullable=True)
    )


# ---------------------------------------------------------------------------
# 5b. policy_limits and policy_zone_places (E1: policy limits as data)
# ---------------------------------------------------------------------------

class PolicyLimit(SQLModel, table=True):
    __tablename__ = "policy_limits"

    limit_id: UUID = Field(default_factory=uuid4, primary_key=True)
    policy_id: UUID = Field(foreign_key="policies.policy_id", index=True)
    category: str = Field(sa_column=Column(String, nullable=False))
    kind: str = Field(default="CAP", sa_column=Column(String, nullable=False))
    unit: str = Field(sa_column=Column(String, nullable=False))
    amount: Optional[float] = Field(default=None, sa_column=Column(Numeric(12, 2), nullable=True))
    currency: str = Field(default="MYR", sa_column=Column(String, nullable=False))
    grade_min: Optional[int] = Field(default=None, sa_column=Column(Integer))
    grade_max: Optional[int] = Field(default=None, sa_column=Column(Integer))
    scope: str = Field(default="ANY", sa_column=Column(String, nullable=False))
    zone: Optional[str] = Field(default=None, sa_column=Column(String))
    source_section: Optional[str] = Field(default=None, sa_column=Column(String))
    source_quote: Optional[str] = Field(default=None, sa_column=Column(Text))
    status: LimitStatus = Field(default=LimitStatus.PROPOSED, sa_column=Column(String, nullable=False))
    confirmed_by: Optional[UUID] = Field(default=None, foreign_key="employees.user_id")
    confirmed_at: Optional[datetime] = Field(default=None, sa_column=Column(DateTime(timezone=True)))
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc), sa_column=Column(DateTime(timezone=True))
    )


class PolicyZonePlace(SQLModel, table=True):
    __tablename__ = "policy_zone_places"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    policy_id: UUID = Field(foreign_key="policies.policy_id", index=True)
    zone: str = Field(sa_column=Column(String, nullable=False))
    place: str = Field(sa_column=Column(String, nullable=False))
    status: LimitStatus = Field(default=LimitStatus.PROPOSED, sa_column=Column(String, nullable=False))


# ---------------------------------------------------------------------------
# 6. travel_settlements
# ---------------------------------------------------------------------------

class TravelSettlement(SQLModel, table=True):
    __tablename__ = "travel_settlements"

    settlement_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    user_id: UUID = Field(
        foreign_key="employees.user_id",
        index=True
    )
    document_path: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    main_category: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    destination: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    departure_date: Optional[date] = Field(
        default=None,
        sa_column=Column(Date)
    )
    arrival_date: Optional[date] = Field(
        default=None,
        sa_column=Column(Date)
    )
    location: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    overseas: Optional[bool] = Field(
        default=None,
        sa_column=Column(Boolean)
    )
    purpose: Optional[str] = Field(
        default=None,
        sa_column=Column(Text)
    )
    currency: Optional[str] = Field(
        default=None,
        sa_column=Column(String(3))
    )
    total_claimed_amount: Optional[float] = Field(
        default=None,
        sa_column=Column(Numeric(12, 2))
    )
    total_approved_amount: Optional[float] = Field(
        default=None,
        sa_column=Column(Numeric(12, 2))
    )
    total_rejected_amount: Optional[float] = Field(
        default=None,
        sa_column=Column(Numeric(12, 2))
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 7. settlement_categories
# ---------------------------------------------------------------------------

class SettlementCategory(SQLModel, table=True):
    __tablename__ = "settlement_categories"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    settlement_id: UUID = Field(
        foreign_key="travel_settlements.settlement_id",
        index=True
    )
    category: str = Field(sa_column=Column(String, nullable=False))

    __table_args__ = (
        UniqueConstraint("settlement_id", "category", name="uq_settlement_category"),
    )


# ---------------------------------------------------------------------------
# 8. reimbursements
# ---------------------------------------------------------------------------

class Reimbursement(SQLModel, table=True):
    __tablename__ = "reimbursements"

    reim_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    user_id: UUID = Field(
        foreign_key="employees.user_id",
        index=True
    )
    policy_id: Optional[UUID] = Field(
        default=None,
        foreign_key="policies.policy_id"
    )
    settlement_id: Optional[UUID] = Field(
        default=None,
        foreign_key="travel_settlements.settlement_id"
    )
    main_category: str = Field(
        sa_column=Column(String, nullable=False, index=True)
    )
    currency: str = Field(
        sa_column=Column(String(3), nullable=False)
    )
    total_claimed_amount: float = Field(
        sa_column=Column(Numeric(12, 2), nullable=False)
    )
    total_approved_amount: Optional[float] = Field(
        default=None,
        sa_column=Column(Numeric(12, 2))
    )
    total_rejected_amount: Optional[float] = Field(
        default=None,
        sa_column=Column(Numeric(12, 2))
    )
    judgment: JudgmentResult = Field(
        sa_column=Column(String, nullable=False)
    )
    confidence: Optional[float] = Field(
        default=None,
        sa_column=Column(Float)
    )
    ai_reasoning: dict = Field(
        default={},
        sa_column=Column(JSONB)
    )
    summary: str = Field(
        sa_column=Column(Text)
    )
    status: ReimbursementStatus = Field(
        default=ReimbursementStatus.PENDING,
        sa_column=Column(String, nullable=False, index=True)
    )
    reviewed_by: Optional[UUID] = Field(
        default=None,
        foreign_key="employees.user_id"
    )
    reviewed_at: Optional[datetime] = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True))
    )
    tier: Optional[str] = Field(
        default=None,
        sa_column=Column(String, index=True)
    )
    risk_score: Optional[int] = Field(
        default=None,
        sa_column=Column(Integer)
    )
    # AutonomyDecision.model_dump(mode="json") from engine/risk.
    autonomy: dict = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    )
    audit_selected: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, server_default="false")
    )
    # [{"hr_id": str, "at": iso8601}], one entry per distinct HR approver.
    approvals: list = Field(
        default_factory=list,
        sa_column=Column(JSONB, nullable=False, server_default=text("'[]'::jsonb"))
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True), index=True)
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 9. reimbursement_sub_categories
# ---------------------------------------------------------------------------

class ReimbursementSubCategory(SQLModel, table=True):
    __tablename__ = "reimbursement_sub_categories"

    id: UUID = Field(default_factory=uuid4, primary_key=True)
    reim_id: UUID = Field(
        foreign_key="reimbursements.reim_id",
        index=True
    )
    sub_category: str = Field(
        sa_column=Column(String, nullable=False)
    )

    __table_args__ = (
        UniqueConstraint("reim_id", "sub_category", name="uq_reim_sub_category"),
    )


# ---------------------------------------------------------------------------
# 10. line_items
# ---------------------------------------------------------------------------

class LineItem(SQLModel, table=True):
    __tablename__ = "line_items"

    line_item_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    reim_id: UUID = Field(
        foreign_key="reimbursements.reim_id",
        index=True
    )
    document_id: Optional[UUID] = Field(
        default=None,
        foreign_key="supporting_documents.document_id"
    )
    description: str = Field(
        sa_column=Column(Text, nullable=False)
    )
    category: str = Field(
        sa_column=Column(String, nullable=False)
    )
    quantity: Optional[float] = Field(
        default=1.0,
        sa_column=Column(Float)
    )
    unit_price: Optional[float] = Field(
        default=None,
        sa_column=Column(Numeric(12, 2))
    )
    claimed_amount: float = Field(
        sa_column=Column(Numeric(12, 2), nullable=False)
    )
    approved_amount: Optional[float] = Field(
        default=None,
        sa_column=Column(Numeric(12, 2))
    )
    currency: str = Field(
        sa_column=Column(String(3), nullable=False)
    )
    expense_date: Optional[date] = Field(
        default=None,
        sa_column=Column(Date)
    )
    judgment: Optional[JudgmentResult] = Field(
        default=None,
        sa_column=Column(String)
    )
    rejection_reason: Optional[str] = Field(
        default=None,
        sa_column=Column(Text)
    )
    policy_section_ref: Optional[UUID] = Field(
        default=None,
        foreign_key="policy_sections.section_id"
    )


# ---------------------------------------------------------------------------
# 11. settlement_receipts
# ---------------------------------------------------------------------------

class SettlementReceipt(SQLModel, table=True):
    __tablename__ = "settlement_receipts"

    receipt_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    settlement_id: UUID = Field(
        foreign_key="travel_settlements.settlement_id",
        index=True
    )
    document_id: Optional[UUID] = Field(
        default=None,
        foreign_key="supporting_documents.document_id"
    )
    merchant_name: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    receipt_date: Optional[date] = Field(
        default=None,
        sa_column=Column(Date)
    )
    category: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    claimed_amount: Optional[float] = Field(
        default=None,
        sa_column=Column(Numeric(12, 2))
    )
    currency: Optional[str] = Field(
        default=None,
        sa_column=Column(String(3))
    )


# ---------------------------------------------------------------------------
# 12. supporting_documents
# ---------------------------------------------------------------------------

class SupportingDocument(SQLModel, table=True):
    __tablename__ = "supporting_documents"

    document_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    reim_id: Optional[UUID] = Field(
        default=None,
        foreign_key="reimbursements.reim_id",
        index=True
    )
    settlement_id: Optional[UUID] = Field(
        default=None,
        foreign_key="travel_settlements.settlement_id",
        index=True
    )
    user_id: UUID = Field(
        foreign_key="employees.user_id",
        index=True
    )
    name: str = Field(sa_column=Column(Text))
    path: str = Field(sa_column=Column(String, nullable=False))
    type: str = Field(sa_column=Column(String, nullable=False))
    is_main: bool = Field(
        default=True,
        sa_column=Column(Boolean, nullable=False)
    )
    document_class: DocumentClass = Field(
        default=DocumentClass.RECEIPT,
        sa_column=Column(String, nullable=False)
    )
    human_edited: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False)
    )
    extracted_data: dict = Field(
        default={},
        sa_column=Column(JSONB)
    )
    editable_fields: dict = Field(
        default={},
        sa_column=Column(JSONB)
    )
    sha256: Optional[str] = Field(
        default=None,
        sa_column=Column(String, index=True)
    )
    phash: Optional[str] = Field(
        default=None,
        sa_column=Column(String, index=True)
    )
    shield: dict = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 13. document_change_log
# ---------------------------------------------------------------------------

class DocumentChangeLog(SQLModel, table=True):
    __tablename__ = "document_change_logs"

    log_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    document_id: UUID = Field(
        foreign_key="supporting_documents.document_id",
        index=True
    )
    changed_by: UUID = Field(
        foreign_key="employees.user_id"
    )
    field_name: str = Field(
        sa_column=Column(String, nullable=False)
    )
    old_value: Optional[str] = Field(
        default=None,
        sa_column=Column(Text)
    )
    new_value: Optional[str] = Field(
        default=None,
        sa_column=Column(Text)
    )
    changed_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# signal_reviews (R1a)
# ---------------------------------------------------------------------------

class SignalReview(SQLModel, table=True):
    """HR's verdict on one Receipt Shield signal of one claim. The latest answer wins; the action log keeps each one."""
    __tablename__ = "signal_reviews"

    review_id: UUID = Field(default_factory=uuid4, primary_key=True)
    reim_id: UUID = Field(foreign_key="reimbursements.reim_id", ondelete="CASCADE", index=True)
    signal_code: str = Field(sa_column=Column(String, nullable=False))
    # "" when the signal belongs to the whole claim; NULLs would defeat the unique constraint.
    document_key: str = Field(default="", sa_column=Column(String, nullable=False, server_default=""))
    verdict: SignalVerdict = Field(sa_column=Column(String, nullable=False))
    reviewed_by: UUID = Field(foreign_key="employees.user_id")
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )

    __table_args__ = (
        UniqueConstraint("reim_id", "signal_code", "document_key", name="uq_signal_review"),
    )


# ---------------------------------------------------------------------------
# 14. claim_drafts
# ---------------------------------------------------------------------------

class ClaimDraft(SQLModel, table=True):
    __tablename__ = "claim_drafts"

    draft_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    user_id: UUID = Field(
        foreign_key="employees.user_id",
        index=True
    )
    title: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    main_category: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    settlement_id: Optional[UUID] = Field(
        default=None,
        foreign_key="travel_settlements.settlement_id"
    )
    draft_data: dict = Field(
        default={},
        sa_column=Column(JSONB)
    )
    receipt_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False)
    )
    failed_receipt_count: int = Field(
        default=0,
        sa_column=Column(Integer, nullable=False)
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 15. payouts
# ---------------------------------------------------------------------------

class Payout(SQLModel, table=True):
    __tablename__ = "payouts"
    # The claim list picks each claim's latest payout.
    __table_args__ = (Index("ix_payouts_reim_id_created_at", "reim_id", "created_at"),)

    payout_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    reim_id: UUID = Field(
        foreign_key="reimbursements.reim_id",
        index=True
    )
    user_id: UUID = Field(
        foreign_key="employees.user_id",
        index=True
    )
    amount: float = Field(
        sa_column=Column(Numeric(12, 2), nullable=False)
    )
    currency: str = Field(
        sa_column=Column(String(3), nullable=False)
    )
    status: PayoutStatus = Field(
        default=PayoutStatus.ACCEPTED,
        sa_column=Column(String, nullable=False, index=True)
    )
    xendit_id: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    idempotency_key: str = Field(
        sa_column=Column(String, nullable=False)
    )
    reference_id: str = Field(
        sa_column=Column(String, nullable=False)
    )
    channel_code: str = Field(
        sa_column=Column(String, nullable=False)
    )
    failure_code: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    provider: str = Field(
        default="PAYPAL",
        sa_column=Column(String, nullable=False, server_default="PAYPAL")
    )
    provider_batch_id: Optional[str] = Field(
        default=None,
        sa_column=Column(String, index=True)
    )
    provider_item_id: Optional[str] = Field(
        default=None,
        sa_column=Column(String, index=True)
    )
    attempt: int = Field(
        default=1,
        sa_column=Column(Integer, nullable=False, server_default="1")
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 16. notifications
# ---------------------------------------------------------------------------

class Notification(SQLModel, table=True):
    __tablename__ = "notifications"

    notification_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    user_id: UUID = Field(
        foreign_key="employees.user_id",
        index=True
    )
    type: str = Field(
        sa_column=Column(String, nullable=False)
    )
    title: str = Field(
        sa_column=Column(String(255), nullable=False)
    )
    message: str = Field(
        sa_column=Column(Text, nullable=False)
    )
    link: Optional[str] = Field(
        default=None,
        sa_column=Column(String)
    )
    is_read: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False)
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True), index=True)
    )


# ---------------------------------------------------------------------------
# 17. push_subscriptions
# ---------------------------------------------------------------------------

class PushSubscription(SQLModel, table=True):
    __tablename__ = "push_subscriptions"

    id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    user_id: UUID = Field(
        foreign_key="employees.user_id",
        index=True
    )
    endpoint: str = Field(
        sa_column=Column(Text, nullable=False)
    )
    p256dh: str = Field(
        sa_column=Column(Text, nullable=False)
    )
    auth: str = Field(
        sa_column=Column(Text, nullable=False)
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )

    __table_args__ = (
        UniqueConstraint("user_id", "endpoint", name="uq_push_sub_user_endpoint"),
    )


# ---------------------------------------------------------------------------
# 18. autonomy_settings
# ---------------------------------------------------------------------------

class AutonomySettings(SQLModel, table=True):
    """Single row (id = 1). The store creates it from AutonomyConfig defaults on first read."""
    __tablename__ = "autonomy_settings"

    id: int = Field(default=1, primary_key=True)
    config: dict = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    )
    enabled: bool = Field(
        default=True,
        sa_column=Column(Boolean, nullable=False, server_default="true")
    )
    version: int = Field(
        default=1,
        sa_column=Column(Integer, nullable=False, server_default="1")
    )
    breaker_until: Optional[datetime] = Field(
        default=None,
        sa_column=Column(DateTime(timezone=True))
    )
    updated_by: Optional[UUID] = Field(
        default=None,
        foreign_key="employees.user_id"
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 19. recoveries
# ---------------------------------------------------------------------------

class Recovery(SQLModel, table=True):
    __tablename__ = "recoveries"

    recovery_id: UUID = Field(
        default_factory=uuid4,
        primary_key=True
    )
    reim_id: UUID = Field(
        foreign_key="reimbursements.reim_id",
        index=True
    )
    user_id: UUID = Field(
        foreign_key="employees.user_id",
        index=True
    )
    amount: float = Field(
        sa_column=Column(Numeric(12, 2), nullable=False)
    )
    currency: str = Field(
        sa_column=Column(String(3), nullable=False)
    )
    reason: str = Field(
        sa_column=Column(Text, nullable=False)
    )
    status: RecoveryStatus = Field(
        default=RecoveryStatus.NOTICE_SENT,
        sa_column=Column(String, nullable=False, index=True)
    )
    dispute_until: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False)
    )
    dispute_note: Optional[str] = Field(
        default=None,
        sa_column=Column(Text)
    )
    offset_reim_id: Optional[UUID] = Field(
        default=None,
        foreign_key="reimbursements.reim_id"
    )
    paypal_invoice_id: Optional[str] = Field(
        default=None,
        sa_column=Column(String, index=True)
    )
    created_by: UUID = Field(
        foreign_key="employees.user_id"
    )
    created_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )
    updated_at: datetime = Field(
        default_factory=lambda: datetime.now(timezone.utc),
        sa_column=Column(DateTime(timezone=True))
    )


# ---------------------------------------------------------------------------
# 20. agent_actions
# ---------------------------------------------------------------------------

class AgentAction(SQLModel, table=True):
    """Hash-chained, append-only log. Written only through engine.services.action_log."""
    __tablename__ = "agent_actions"

    action_id: Optional[int] = Field(
        default=None,
        sa_column=Column(BigInteger, primary_key=True, autoincrement=True)
    )
    action_type: AgentActionType = Field(
        sa_column=Column(String, nullable=False, index=True)
    )
    # "agent" or a user UUID.
    actor: str = Field(
        sa_column=Column(String, nullable=False)
    )
    # No foreign key: the log must outlive the claim it describes.
    reim_id: Optional[UUID] = Field(
        default=None,
        sa_column=Column(PG_UUID(as_uuid=True), index=True)
    )
    payload: dict = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default=text("'{}'::jsonb"))
    )
    prev_hash: str = Field(
        sa_column=Column(String(64), nullable=False)
    )
    hash: str = Field(
        sa_column=Column(String(64), nullable=False, unique=True)
    )
    created_at: datetime = Field(
        sa_column=Column(DateTime(timezone=True), nullable=False)
    )
