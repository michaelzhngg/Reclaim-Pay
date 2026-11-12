import enum


class UserRole(str, enum.Enum):
    HR = "HR"
    Employee = "Employee"


class PrivilegeLevel(str, enum.Enum):
    Standard = "Standard"
    Manager = "Manager"
    Executive = "Executive"


class ReimbursementKind(str, enum.Enum):
    CLAIM = "CLAIM"
    VENDOR_BOOKING = "VENDOR_BOOKING"


def is_vendor_booking(record) -> bool:
    """True when a claim-shaped record is a vendor booking. Missing kind means an old claim."""
    return getattr(record, "kind", None) == ReimbursementKind.VENDOR_BOOKING.value


class ReimbursementStatus(str, enum.Enum):
    PENDING = "PENDING"
    REVIEW = "REVIEW"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    APPEALED = "APPEALED"
    DISBURSING = "DISBURSING"
    PAID = "PAID"
    DISBURSEMENT_FAILED = "DISBURSEMENT_FAILED"


class PayoutStatus(str, enum.Enum):
    ACCEPTED = "ACCEPTED"
    REQUESTED = "REQUESTED"
    SUCCEEDED = "SUCCEEDED"
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"
    REVERSED = "REVERSED"


class WebhookEventStatus(str, enum.Enum):
    RECEIVED = "RECEIVED"
    PROCESSED = "PROCESSED"
    IGNORED = "IGNORED"
    FAILED = "FAILED"
    DEAD_LETTER = "DEAD_LETTER"


class RecoveryStatus(str, enum.Enum):
    NOTICE_SENT = "NOTICE_SENT"
    DISPUTED = "DISPUTED"
    OFFSET = "OFFSET"
    INVOICED = "INVOICED"
    RECOVERED = "RECOVERED"
    WAIVED = "WAIVED"


class AgentActionType(str, enum.Enum):
    DECISION = "DECISION"
    PAYOUT_CREATED = "PAYOUT_CREATED"
    PAYOUT_STATUS = "PAYOUT_STATUS"
    CONFIG_CHANGED = "CONFIG_CHANGED"
    KILL_SWITCH = "KILL_SWITCH"
    BREAKER_TRIPPED = "BREAKER_TRIPPED"
    RECOVERY_CREATED = "RECOVERY_CREATED"
    RECOVERY_INVOICED = "RECOVERY_INVOICED"
    RECOVERY_PREVIEWED = "RECOVERY_PREVIEWED"
    RECOVERY_STATUS = "RECOVERY_STATUS"
    HR_APPROVAL = "HR_APPROVAL"
    PAYEE_LINKED = "PAYEE_LINKED"
    PAYEE_LINK_FAILED = "PAYEE_LINK_FAILED"
    PAYPAL_SIGNIN = "PAYPAL_SIGNIN"
    WEBHOOK_DEAD_LETTER = "WEBHOOK_DEAD_LETTER"
    WEBHOOK_RETRY = "WEBHOOK_RETRY"


class JudgmentResult(str, enum.Enum):
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"
    PARTIAL = "PARTIAL"
    NEEDS_INFO = "NEEDS_INFO"


class DocumentClass(str, enum.Enum):
    RECEIPT = "RECEIPT"
    INVOICE = "INVOICE"
    SETTLEMENT_FORM = "SETTLEMENT_FORM"
    SUPPORTING = "SUPPORTING"


class PolicyStatus(str, enum.Enum):
    DRAFT = "DRAFT"
    ACTIVE = "ACTIVE"
    DEPRECATED = "DEPRECATED"
