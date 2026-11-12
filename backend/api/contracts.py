"""Contractor contracts and the HR-owned company payout setup."""

from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlmodel import Session, select

from api import deps
from core.enums import ContractRateUnit, UserRole
from core.models import ContractorContract, User
from engine.services import contracts as service
from engine.services.contracts import ContractError

router = APIRouter()


class ContractCreate(BaseModel):
    user_id: UUID
    country_code: str
    currency: str
    rate_amount: float
    rate_unit: str
    service_category: str
    categories: list[str]
    max_company_amount_per_claim: float
    policy_id: Optional[UUID] = None
    effective_from: date
    effective_to: Optional[date] = None
    is_active: bool = True


class ContractUpdate(BaseModel):
    country_code: Optional[str] = None
    currency: Optional[str] = None
    rate_amount: Optional[float] = None
    rate_unit: Optional[str] = None
    service_category: Optional[str] = None
    categories: Optional[list[str]] = None
    max_company_amount_per_claim: Optional[float] = None
    policy_id: Optional[UUID] = None
    clear_policy: bool = False
    effective_from: Optional[date] = None
    effective_to: Optional[date] = None
    clear_effective_to: bool = False
    is_active: Optional[bool] = None


class PayoutSettingsUpdate(BaseModel):
    paypal_account_country: Optional[str] = None
    held_currencies: Optional[list[str]] = None


_STATUS = {
    "CONTRACT_EXISTS": status.HTTP_409_CONFLICT,
    "USER_NOT_FOUND": status.HTTP_404_NOT_FOUND,
    "POLICY_NOT_ACTIVE": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "NOT_A_CONTRACTOR": status.HTTP_422_UNPROCESSABLE_ENTITY,
}


def _fail(error: ContractError):
    detail = error.code if str(error) == error.code else f"{error.code}: {error}"
    raise HTTPException(status_code=_STATUS.get(error.code, status.HTTP_422_UNPROCESSABLE_ENTITY), detail=detail)


def _contractor_row(db: Session, user: User) -> dict:
    contract = service.get_contract(db, user.user_id)
    return {
        "user_id": str(user.user_id),
        "user_code": user.user_code,
        "name": user.name,
        "email": user.email,
        "is_active": bool(user.is_active),
        "contract": service.contract_dict(db, contract) if contract else None,
    }


@router.get("/")
def list_contractors(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> list[dict]:
    """Every contractor, with their contract when one exists. HR only."""
    users = db.exec(
        select(User).where(User.role == UserRole.Contractor.value).order_by(User.name)
    ).all()
    return [_contractor_row(db, user) for user in users]


@router.get("/me")
def my_contract(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_contractor_user),
) -> dict:
    """The contractor's own summary. Another contractor's contract is not addressable."""
    contract = service.active_contract(db, current_user.user_id)
    if not contract:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="NO_ACTIVE_CONTRACT")
    return service.contract_dict(db, contract)


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_contract(
    body: ContractCreate,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    try:
        contract = service.create_contract(
            db,
            user_id=body.user_id,
            country_code=body.country_code,
            currency=body.currency,
            rate_amount=body.rate_amount,
            rate_unit=body.rate_unit,
            service_category=body.service_category,
            categories=body.categories,
            max_company_amount_per_claim=body.max_company_amount_per_claim,
            policy_id=body.policy_id,
            effective_from=body.effective_from,
            effective_to=body.effective_to,
            created_by=current_user.user_id,
            is_active=body.is_active,
        )
    except ContractError as error:
        _fail(error)
    return service.contract_dict(db, contract)


@router.patch("/{contract_id}")
def update_contract(
    contract_id: UUID,
    body: ContractUpdate,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    contract = db.get(ContractorContract, contract_id)
    if not contract:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Contract not found")
    try:
        contract = service.update_contract(
            db,
            contract,
            country_code=body.country_code,
            currency=body.currency,
            rate_amount=body.rate_amount,
            rate_unit=body.rate_unit,
            service_category=body.service_category,
            categories=body.categories,
            max_company_amount_per_claim=body.max_company_amount_per_claim,
            policy_id=body.policy_id,
            clear_policy=body.clear_policy,
            effective_from=body.effective_from,
            effective_to=body.effective_to,
            clear_effective_to=body.clear_effective_to,
            is_active=body.is_active,
        )
    except ContractError as error:
        _fail(error)
    return service.contract_dict(db, contract)


@router.get("/payout-settings")
def get_payout_settings(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    return service.payout_settings_dict(db)


@router.put("/payout-settings")
def update_payout_settings(
    body: PayoutSettingsUpdate,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    try:
        service.update_payout_settings(
            db,
            paypal_account_country=body.paypal_account_country,
            held_currencies=body.held_currencies,
            actor=current_user.user_id,
        )
    except ContractError as error:
        _fail(error)
    return service.payout_settings_dict(db)


@router.get("/options")
def contract_options(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    """Supported countries and currencies, so the form does not keep its own copy."""
    from engine.services.currency import PAYOUT_COUNTRIES, PAYOUT_CURRENCIES

    return {
        "countries": [{"code": c, "name": n} for c, n in sorted(PAYOUT_COUNTRIES.items())],
        "currencies": [{"code": c, "name": n} for c, n in sorted(PAYOUT_CURRENCIES.items())],
        "rate_units": [u.value for u in ContractRateUnit],
    }
