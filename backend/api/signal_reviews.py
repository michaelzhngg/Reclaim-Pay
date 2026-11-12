"""HR marks Receipt Shield signals as real problems or false alarms (R1a). HR only."""
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session

from api import deps
from core.models import Reimbursement, User
from engine.services import signal_review_service as svc

router = APIRouter()

_STATUS = {"SELF_REVIEW": status.HTTP_403_FORBIDDEN, "SIGNAL_NOT_ON_CLAIM": status.HTTP_422_UNPROCESSABLE_ENTITY}


def _claim(db: Session, reim_id: UUID) -> Reimbursement:
    r = db.get(Reimbursement, reim_id)
    if r is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="NOT_FOUND")
    return r


@router.put("/reimbursements/{reim_id}/signal-reviews", response_model=svc.SignalReviewOut)
def review_signal(reim_id: UUID, body: svc.SignalReviewIn, db: Session = Depends(deps.get_db),
                  current_user: User = Depends(deps.get_current_hr_user)):
    try:
        row = svc.record_review(db, _claim(db, reim_id), current_user, body, datetime.now(timezone.utc))
    except svc.ReviewError as e:
        db.rollback()
        raise HTTPException(status_code=_STATUS[e.code], detail=e.code)
    return svc.to_out(row)


@router.get("/reimbursements/{reim_id}/signal-reviews", response_model=list[svc.SignalReviewOut])
def list_reviews(reim_id: UUID, db: Session = Depends(deps.get_db),
                 current_user: User = Depends(deps.get_current_hr_user)):
    _claim(db, reim_id)
    return [svc.to_out(r) for r in svc.reviews_for(db, reim_id)]


@router.get("/autonomy/signal-quality", response_model=list[svc.SignalQuality])
def quality(days: int = 90, db: Session = Depends(deps.get_db),
            current_user: User = Depends(deps.get_current_hr_user)):
    return svc.signal_quality(db, datetime.now(timezone.utc), days=max(1, min(days, 365)))
