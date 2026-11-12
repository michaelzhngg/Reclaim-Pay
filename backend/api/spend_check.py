"""Check before you spend (F1) and the trip estimate (F4). Guidance only, never an approval."""
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from pydantic import BaseModel, Field
from sqlmodel import Session
from starlette.requests import Request

from api import deps
from api.rate_limit import limiter
from core.models import User
from engine.services import policy_qa
from engine.services import spend_check_service as svc

router = APIRouter()


@router.get("/categories", response_model=list[svc.CategoryOption])
def list_categories(db: Session = Depends(deps.get_db), current_user: User = Depends(deps.get_current_user)):
    return svc.categories_for(db, current_user.rank)


@router.post("/check", response_model=svc.SpendCheckOut)
@limiter.limit("60/minute")
def check(request: Request, body: svc.SpendCheckIn, db: Session = Depends(deps.get_db),
          current_user: User = Depends(deps.get_current_user)):
    return svc.check_cost(db, current_user.rank, body)


@router.post("/trip", response_model=svc.TripOut)
@limiter.limit("60/minute")
def trip(request: Request, body: svc.TripIn, db: Session = Depends(deps.get_db),
         current_user: User = Depends(deps.get_current_user)):
    try:
        return svc.plan_trip(db, current_user.rank, body)
    except ValueError as e:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(e))


class AskIn(BaseModel):
    question: str = Field(max_length=2000)  # the 5-500 rule lives in the service, so it returns QUESTION_LENGTH


_QA_STATUS = {"QUESTION_LENGTH": 422, "ONE_QUESTION": 422, "DAILY_QUESTION_LIMIT": 429, "QA_UNAVAILABLE": 503}


@router.post("/ask", response_model=policy_qa.QaAnswer)
@limiter.limit("10/minute")
def ask(request: Request, body: AskIn, db: Session = Depends(deps.get_db),
        current_user: User = Depends(deps.get_current_user)):
    try:
        return policy_qa.answer_question(db, current_user, body.question, datetime.now(timezone.utc))
    except policy_qa.QuestionError as e:
        raise HTTPException(status_code=_QA_STATUS[e.code], detail=e.code)


@router.get("/questions", response_model=policy_qa.QuestionSummary)
def questions(days: int = Query(default=30, ge=1, le=365), db: Session = Depends(deps.get_db),
              current_user: User = Depends(deps.get_current_hr_user)):
    return policy_qa.question_summary(db, datetime.now(timezone.utc), days=days)
