"""DB reads for the shield. The only module under engine/risk that touches the database."""

from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlmodel import Session, select

from core.models import LineItem, Reimbursement, SettlementReceipt, SupportingDocument
from engine.risk.shield.fingerprint import amount_and_date
from engine.risk.types import ClaimLite, DocFingerprint
from engine.services import fx


def fingerprint_candidates(
    db: Session, exclude_reim_id: str | None, now: datetime, days: int = 180
) -> list[DocFingerprint]:
    """Fingerprinted documents uploaded in the last `days`, with their claim's status.

    Documents of `exclude_reim_id` are left out; the caller compares a claim's own documents itself.
    """
    stmt = (
        select(SupportingDocument, Reimbursement.status)
        .join(Reimbursement, Reimbursement.reim_id == SupportingDocument.reim_id, isouter=True)
        .where(SupportingDocument.sha256.is_not(None))
        .where(SupportingDocument.created_at >= now - timedelta(days=days))
    )
    if exclude_reim_id is not None:
        stmt = stmt.where(
            (SupportingDocument.reim_id.is_(None)) | (SupportingDocument.reim_id != exclude_reim_id)
        )
    out = []
    for doc, status in db.exec(stmt).all():
        amount, expense_date = amount_and_date(doc.extracted_data)
        out.append(
            DocFingerprint(
                document_id=str(doc.document_id),
                reim_id=str(doc.reim_id) if doc.reim_id else None,
                user_id=str(doc.user_id),
                sha256=doc.sha256,
                phash=doc.phash,
                reim_status=getattr(status, "value", status),
                amount=amount,
                expense_date=expense_date,
            )
        )
    return out


def _first_receipt(db: Session, reim: Reimbursement) -> SettlementReceipt | None:
    """The claim's first receipt: through its line items, else the first in its settlement."""
    doc_ids = [d for d in db.exec(select(LineItem.document_id).where(LineItem.reim_id == reim.reim_id)).all() if d]
    if doc_ids:
        row = db.exec(select(SettlementReceipt).where(SettlementReceipt.document_id.in_(doc_ids))).first()
        if row:
            return row
    if reim.settlement_id:
        return db.exec(select(SettlementReceipt).where(SettlementReceipt.settlement_id == reim.settlement_id)).first()
    return None


def recent_claims(db: Session, user_id: str | UUID, now: datetime, days: int = 30) -> list[ClaimLite]:
    """The employee's claims created in the last `days`, for split and near-threshold checks."""
    uid = user_id if isinstance(user_id, UUID) else UUID(str(user_id))
    rows = db.exec(
        select(Reimbursement)
        .where(
            Reimbursement.user_id == uid,
            Reimbursement.kind == "CLAIM",
            Reimbursement.created_at >= now - timedelta(days=days),
        )
    ).all()
    out = []
    for r in rows:
        receipt = _first_receipt(db, r)
        created = r.created_at if r.created_at.tzinfo else r.created_at.replace(tzinfo=timezone.utc)
        out.append(
            ClaimLite(
                reim_id=str(r.reim_id),
                user_id=str(r.user_id),
                merchant=(receipt.merchant_name if receipt else None) or "",
                expense_date=receipt.receipt_date if receipt else None,
                amount=float(fx.stored_company_amount(r)),
                created_at=created,
                status=getattr(r.status, "value", r.status),
            )
        )
    return out
