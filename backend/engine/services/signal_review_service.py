"""HR verdicts on Receipt Shield signals, and how accurate each check has been (R1a).

Labels only: nothing here changes a decision, a score or a trust level.
"""
from collections import defaultdict
from datetime import datetime, timedelta
from uuid import UUID

from pydantic import BaseModel, Field
from sqlmodel import Session, select

from core.enums import AgentActionType, ReimbursementStatus, SignalVerdict
from core.models import Reimbursement, SignalReview, User
from engine.risk.types import SignalCode
from engine.services import autonomy_store as store
from engine.services.action_log import record_action

MIN_REVIEWS = 10

APPROVED_STATUSES = {
    ReimbursementStatus.APPROVED.value, ReimbursementStatus.DISBURSING.value,
    ReimbursementStatus.PAID.value, ReimbursementStatus.DISBURSEMENT_FAILED.value,
}


class SignalOutcome(BaseModel):
    code: str
    verdict: SignalVerdict | None
    # HR approved the whole claim while the signal fired: a weak "probably false" label.
    approved_in_full: bool
    rejected: bool


class SignalQuality(BaseModel):
    code: str
    fired: int
    confirmed: int
    false_alarm: int
    unreviewed: int
    approved_in_full: int
    rejected: int
    # confirmed / rated, only once at least MIN_REVIEWS were rated: a 1-of-1 "100%" misleads.
    precision: float | None


def tally(outcomes: list[SignalOutcome]) -> list[SignalQuality]:
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for o in outcomes:
        c = counts[o.code]
        c["fired"] += 1
        if o.verdict == SignalVerdict.CONFIRMED:
            c["confirmed"] += 1
        elif o.verdict == SignalVerdict.FALSE_ALARM:
            c["false_alarm"] += 1
        else:
            c["unreviewed"] += 1
        c["approved_in_full"] += int(o.approved_in_full)
        c["rejected"] += int(o.rejected)
    rows = []
    for code, c in counts.items():
        rated = c["confirmed"] + c["false_alarm"]
        rows.append(SignalQuality(
            code=code, fired=c["fired"], confirmed=c["confirmed"], false_alarm=c["false_alarm"],
            unreviewed=c["unreviewed"], approved_in_full=c["approved_in_full"], rejected=c["rejected"],
            precision=round(c["confirmed"] / rated, 3) if rated >= MIN_REVIEWS else None,
        ))
    return sorted(rows, key=lambda r: (-r.fired, r.code))


class ReviewError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class SignalReviewIn(BaseModel):
    signal_code: SignalCode
    document_id: str | None = Field(default=None, max_length=64)
    verdict: SignalVerdict


class SignalReviewOut(BaseModel):
    signal_code: str
    document_id: str | None
    verdict: SignalVerdict
    reviewed_by: UUID
    updated_at: datetime


def to_out(row: SignalReview) -> SignalReviewOut:
    return SignalReviewOut(signal_code=row.signal_code, document_id=row.document_key or None,
                           verdict=row.verdict, reviewed_by=row.reviewed_by, updated_at=row.updated_at)


def _signals(autonomy: dict | None) -> list[dict]:
    return list((autonomy or {}).get("signals") or [])


def record_review(db: Session, r: Reimbursement, hr: User, body: SignalReviewIn, now: datetime) -> SignalReview:
    """Upsert HR's verdict and log it. In DUAL_REVIEW the second reviewer's answer replaces the first."""
    if r.user_id == hr.user_id:
        raise ReviewError("SELF_REVIEW")
    code = body.signal_code.value
    # Exact document match: a label stored under another key would never line up with the signal in the report.
    if not any(s.get("code") == code and s.get("document_id") == body.document_id for s in _signals(r.autonomy)):
        raise ReviewError("SIGNAL_NOT_ON_CLAIM")
    key = body.document_id or ""
    row = db.exec(select(SignalReview).where(
        SignalReview.reim_id == r.reim_id, SignalReview.signal_code == code, SignalReview.document_key == key,
    ).with_for_update()).first()
    previous = None
    if row is None:
        row = SignalReview(reim_id=r.reim_id, signal_code=code, document_key=key,
                           verdict=body.verdict, reviewed_by=hr.user_id, created_at=now, updated_at=now)
    else:
        previous = {"verdict": store._status_str(row.verdict), "reviewed_by": str(row.reviewed_by)}
        row.verdict, row.reviewed_by, row.updated_at = body.verdict, hr.user_id, now
    db.add(row)
    # record_action commits, so the review and its log entry land together.
    record_action(db, AgentActionType.SIGNAL_REVIEWED, str(hr.user_id), r.reim_id, {
        "code": code, "document_id": body.document_id, "verdict": body.verdict.value, "previous": previous,
    })
    db.refresh(row)
    return row


def reviews_for(db: Session, reim_id: UUID) -> list[SignalReview]:
    return list(db.exec(select(SignalReview).where(SignalReview.reim_id == reim_id)).all())


def _outcomes(claims, verdicts: dict[tuple, str]) -> list[SignalOutcome]:
    outcomes = []
    for c in claims:
        status = store._status_str(c.status)
        # Only a human decision counts: AUTO_PAY and agent rejections say nothing about the signal.
        reviewed = c.reviewed_by is not None
        # total_approved_amount is the sum of line approvals, so any HR cut makes this False.
        full = (reviewed and status in APPROVED_STATUSES
                and float(c.total_approved_amount or 0) >= float(c.total_claimed_amount or 0) - 0.005)
        rejected = reviewed and status == ReimbursementStatus.REJECTED.value
        for s in _signals(c.autonomy):
            code = str(s.get("code"))
            verdict = verdicts.get((c.reim_id, code, s.get("document_id") or ""))
            outcomes.append(SignalOutcome(code=code, verdict=verdict, approved_in_full=full, rejected=rejected))
    return outcomes


def signal_quality(db: Session, now: datetime, days: int = 90) -> list[SignalQuality]:
    claims = db.exec(select(
        Reimbursement.reim_id, Reimbursement.status, Reimbursement.reviewed_by, Reimbursement.autonomy,
        Reimbursement.total_approved_amount, Reimbursement.total_claimed_amount,
    ).where(Reimbursement.created_at >= now - timedelta(days=days))).all()
    claims = [c for c in claims if _signals(c.autonomy)]
    if not claims:
        return []
    reviews = db.exec(select(SignalReview).where(SignalReview.reim_id.in_([c.reim_id for c in claims]))).all()
    verdicts = {(v.reim_id, v.signal_code, v.document_key): v.verdict for v in reviews}
    return tally(_outcomes(claims, verdicts))
