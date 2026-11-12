"""Check before you spend (F1) and the trip estimate (F4). Guidance only, never an approval."""
from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import Session
from starlette.requests import Request

from api import deps
from api.rate_limit import limiter
from core.models import User
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
