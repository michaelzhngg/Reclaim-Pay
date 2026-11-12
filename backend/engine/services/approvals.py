"""HR approval rules: no self-approval, distinct approvers for DUAL_REVIEW, batch eligibility."""
from datetime import datetime

BATCH_TIER = "HR_QUICK"
DUAL_TIER = "DUAL_REVIEW"
AUTO_TIER = "AUTO_PAY"
REVIEW_STATUS = "REVIEW"


def required_approvals(tier: str | None) -> int:
    return 2 if tier == DUAL_TIER else 1


def approvals_complete(
    tier: str | None, approvals: list[dict] | None, claimant_id: str, reviewed_by: str | None = None
) -> bool:
    """Whether a claim has the sign-offs its tier needs. The claimant's own approval never counts."""
    # Only decide() sets AUTO_PAY, and it is the approver there.
    if tier == AUTO_TIER:
        return True
    approvers = {a.get("hr_id") for a in approvals or []}
    # Claims from before the approvals column recorded their single reviewer in reviewed_by.
    if tier is None and reviewed_by:
        approvers.add(str(reviewed_by))
    approvers.discard(str(claimant_id))
    return len(approvers) >= required_approvals(tier)


def register_approval(
    approvals: list[dict],
    approver_id: str,
    claimant_id: str,
    now: datetime,
    required: int,
) -> tuple[list[dict], bool]:
    """Return the new approvals list and whether it now meets `required`.

    A repeat approval by the same HR user is not counted again.
    """
    if str(approver_id) == str(claimant_id):
        raise ValueError("SELF_APPROVAL")
    current = [dict(a) for a in (approvals or [])]
    if all(a.get("hr_id") != str(approver_id) for a in current):
        current.append({"hr_id": str(approver_id), "at": now.isoformat()})
    distinct = {a.get("hr_id") for a in current}
    return current, len(distinct) >= required


def split_batch(rows: list[dict], approver_id: str) -> tuple[list[str], list[dict]]:
    """Split batch rows into approvable IDs and skips. Checks run in order: tier, status, self, kind."""
    approved: list[str] = []
    skipped: list[dict] = []
    for row in rows:
        if row.get("tier") != BATCH_TIER:
            reason = "NOT_HR_QUICK"
        elif row.get("status") != REVIEW_STATUS:
            reason = "NOT_IN_REVIEW"
        elif str(row.get("user_id")) == str(approver_id):
            reason = "SELF_APPROVAL"
        elif row.get("kind") == "VENDOR_BOOKING":
            # A booking needs an individual look at the vendor and dates.
            reason = "VENDOR_BOOKING"
        elif row.get("contract_reason"):
            # A contractor claim is batched only when every contract check passed.
            reason = "CONTRACT_CHECK"
        else:
            approved.append(row["reim_id"])
            continue
        skipped.append({"reim_id": row["reim_id"], "reason": reason})
    return approved, skipped
