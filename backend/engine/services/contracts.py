"""Contractor contracts and the company payout setup.

Validation lives here, not in the route, so ticket 04's claim intake reads the same rules.
Every function uses the company currency where a limit is denominated in it.
"""
from datetime import date, datetime, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from core.enums import AgentActionType, ContractRateUnit, PolicyStatus, UserRole
from core.models import (
    ContractorContract,
    ContractorContractCategory,
    PayoutSettings,
    Policy,
    PolicyReimbursableCategory,
    User,
)
from engine.services.action_log import record_action
from engine.services.currency import (
    company_currency,
    country_name,
    currency_name,
    normalise_country,
    normalise_currency,
)

PAYOUT_SETTINGS_ID = 1
DEFAULT_ACCOUNT_COUNTRY = "MY"
DEFAULT_HELD_CURRENCIES = ["MYR"]


class ContractError(ValueError):
    """A contract or payout-setup rule was broken. `code` is the stable reason for the UI."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


def _money(value) -> Decimal:
    return Decimal(str(value))


def _normalise_categories(categories: list[str]) -> list[str]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in categories or []:
        category = (raw or "").strip()
        if not category or category.lower() in seen:
            continue
        seen.add(category.lower())
        out.append(category)
    if not out:
        raise ContractError("CATEGORIES_REQUIRED")
    return out


def _policy_categories(db: Session, policy_id: UUID) -> dict[str, str]:
    """Lower-cased category to the policy's canonical spelling."""
    rows = db.exec(
        select(PolicyReimbursableCategory.category).where(
            PolicyReimbursableCategory.policy_id == policy_id
        )
    ).all()
    return {str(c).strip().lower(): str(c).strip() for c in rows if str(c).strip()}


def _checked_policy(db: Session, policy_id: UUID | None) -> Policy | None:
    if policy_id is None:
        return None
    policy = db.get(Policy, policy_id)
    if not policy or policy.status != PolicyStatus.ACTIVE:
        raise ContractError("POLICY_NOT_ACTIVE", "Choose an active policy.")
    return policy


def _checked_categories(db: Session, policy_id: UUID | None, categories: list[str]) -> list[str]:
    """Validate against the contract policy when one is set; otherwise keep the given labels."""
    normalised = _normalise_categories(categories)
    if policy_id is None:
        return normalised
    allowed = _policy_categories(db, policy_id)
    rejected = [c for c in normalised if c.lower() not in allowed]
    if rejected:
        raise ContractError(
            "CATEGORY_NOT_IN_POLICY",
            "These categories are not in the chosen policy: " + ", ".join(rejected),
        )
    return [allowed[c.lower()] for c in normalised]


def _checked_rate_unit(value: str | None) -> str:
    unit = (value or "").strip().upper()
    if unit not in {u.value for u in ContractRateUnit}:
        raise ContractError("RATE_UNIT_INVALID")
    return unit


def _checked_amount(value, field: str) -> Decimal:
    try:
        amount = _money(value)
    except Exception:
        raise ContractError("AMOUNT_INVALID", f"{field} must be a number.")
    if amount <= 0:
        raise ContractError("AMOUNT_INVALID", f"{field} must be more than zero.")
    return amount


def _checked_country(value: str | None) -> str:
    code = normalise_country(value)
    if code is None:
        raise ContractError("COUNTRY_UNSUPPORTED", "Choose a supported payee country.")
    return code


def _checked_currency(value: str | None) -> str:
    code = normalise_currency(value)
    if code is None:
        raise ContractError("CURRENCY_UNSUPPORTED", "Choose a supported payout currency.")
    return code


def _checked_service_category(value: str | None) -> str:
    category = (value or "").strip()
    if not category:
        raise ContractError("SERVICE_CATEGORY_REQUIRED")
    return category


def _checked_dates(effective_from: date | None, effective_to: date | None) -> tuple[date, date | None]:
    if effective_from is None:
        raise ContractError("EFFECTIVE_FROM_REQUIRED")
    if effective_to is not None and effective_to < effective_from:
        raise ContractError("EFFECTIVE_DATES_INVALID")
    return effective_from, effective_to


def _contractor_user(db: Session, user_id: UUID) -> User:
    user = db.get(User, user_id)
    if not user:
        raise ContractError("USER_NOT_FOUND")
    if user.role != UserRole.Contractor:
        raise ContractError("NOT_A_CONTRACTOR", "Contracts are only for contractor users.")
    return user


def _replace_categories(db: Session, contract_id: UUID, categories: list[str]) -> None:
    existing = db.exec(
        select(ContractorContractCategory).where(
            ContractorContractCategory.contract_id == contract_id
        )
    ).all()
    for row in existing:
        db.delete(row)
    db.flush()
    for category in categories:
        db.add(ContractorContractCategory(contract_id=contract_id, category=category))
    db.flush()


def contract_categories(db: Session, contract_id: UUID) -> list[str]:
    rows = db.exec(
        select(ContractorContractCategory.category)
        .where(ContractorContractCategory.contract_id == contract_id)
        .order_by(ContractorContractCategory.category)
    ).all()
    return [str(c) for c in rows]


def receipt_is_allowed(category: str | None, contract_category_set: set[str]) -> bool:
    return (category or "").strip().lower() in contract_category_set


def split_receipts_by_contract(receipts: list, contract_category_set: set[str]) -> tuple[list, list]:
    """(receipts the contract covers, receipts it does not). Order is preserved."""
    allowed, blocked = [], []
    for receipt in receipts:
        (allowed if receipt_is_allowed(getattr(receipt, "category", None), contract_category_set)
         else blocked).append(receipt)
    return allowed, blocked


def policy_for_category(
    db: Session, category: str | None, contract_policy_id: UUID | None = None
) -> UUID | None:
    """The contract policy when set, otherwise the newest active policy listing the category."""
    if contract_policy_id is not None:
        return contract_policy_id
    rows = db.exec(
        select(PolicyReimbursableCategory, Policy)
        .join(Policy, PolicyReimbursableCategory.policy_id == Policy.policy_id)
        .where(
            func.lower(PolicyReimbursableCategory.category) == (category or "").strip().lower(),
            Policy.status == PolicyStatus.ACTIVE,
        )
        .order_by(Policy.effective_date.desc(), Policy.created_at.desc())
    ).all()
    return rows[0][1].policy_id if rows else None


def get_contract(db: Session, user_id: UUID) -> ContractorContract | None:
    return db.exec(
        select(ContractorContract).where(ContractorContract.user_id == user_id)
    ).first()


def active_contract(db: Session, user_id: UUID, now: datetime | None = None) -> ContractorContract | None:
    """The contract that covers `now`. Inactive or out-of-window contracts do not count."""
    today = (now or datetime.now(timezone.utc)).date()
    contract = get_contract(db, user_id)
    if not contract or not contract.is_active:
        return None
    if contract.effective_from > today:
        return None
    if contract.effective_to is not None and contract.effective_to < today:
        return None
    return contract


def contract_dict(db: Session, contract: ContractorContract) -> dict:
    policy = db.get(Policy, contract.policy_id) if contract.policy_id else None
    return {
        "contract_id": str(contract.contract_id),
        "user_id": str(contract.user_id),
        "country_code": contract.country_code,
        "country_name": country_name(contract.country_code),
        "currency": contract.currency,
        "currency_name": currency_name(contract.currency),
        "rate_amount": float(contract.rate_amount),
        "rate_unit": contract.rate_unit,
        "service_category": contract.service_category,
        "categories": contract_categories(db, contract.contract_id),
        "policy_id": str(contract.policy_id) if contract.policy_id else None,
        "policy_title": policy.title if policy else None,
        "max_company_amount_per_claim": float(contract.max_company_amount_per_claim),
        "company_currency": company_currency(),
        "is_active": bool(contract.is_active),
        "effective_from": contract.effective_from.isoformat(),
        "effective_to": contract.effective_to.isoformat() if contract.effective_to else None,
        "created_at": contract.created_at.isoformat() if contract.created_at else None,
        "updated_at": contract.updated_at.isoformat() if contract.updated_at else None,
    }


def create_contract(
    db: Session,
    *,
    user_id: UUID,
    country_code: str | None,
    currency: str | None,
    rate_amount,
    rate_unit: str | None,
    service_category: str | None,
    categories: list[str],
    max_company_amount_per_claim,
    created_by: UUID,
    policy_id: UUID | None = None,
    effective_from: date | None = None,
    effective_to: date | None = None,
    is_active: bool = True,
) -> ContractorContract:
    _contractor_user(db, user_id)
    if get_contract(db, user_id) is not None:
        raise ContractError("CONTRACT_EXISTS", "This contractor already has a contract. Edit it instead.")

    policy = _checked_policy(db, policy_id)
    checked_categories = _checked_categories(db, policy.policy_id if policy else None, categories)
    start, end = _checked_dates(effective_from or date.today(), effective_to)
    amount = _checked_amount(rate_amount, "rate_amount")
    ceiling = _checked_amount(max_company_amount_per_claim, "max_company_amount_per_claim")

    contract = ContractorContract(
        user_id=user_id,
        country_code=_checked_country(country_code),
        currency=_checked_currency(currency),
        rate_amount=amount,
        rate_unit=_checked_rate_unit(rate_unit),
        service_category=_checked_service_category(service_category),
        policy_id=policy.policy_id if policy else None,
        max_company_amount_per_claim=ceiling,
        is_active=is_active,
        effective_from=start,
        effective_to=end,
        created_by=created_by,
    )
    db.add(contract)
    try:
        db.flush()
    except IntegrityError:
        db.rollback()
        raise ContractError("CONTRACT_EXISTS", "This contractor already has a contract. Edit it instead.")
    _replace_categories(db, contract.contract_id, checked_categories)
    db.commit()
    db.refresh(contract)
    return contract


def update_contract(
    db: Session,
    contract: ContractorContract,
    *,
    country_code: str | None = None,
    currency: str | None = None,
    rate_amount=None,
    rate_unit: str | None = None,
    service_category: str | None = None,
    categories: list[str] | None = None,
    max_company_amount_per_claim=None,
    policy_id: UUID | None = None,
    clear_policy: bool = False,
    effective_from: date | None = None,
    effective_to: date | None = None,
    clear_effective_to: bool = False,
    is_active: bool | None = None,
) -> ContractorContract:
    """Partial update. Only fields that were supplied are revalidated and written."""
    effective_policy_id = None if clear_policy else (policy_id if policy_id is not None else contract.policy_id)
    policy = _checked_policy(db, effective_policy_id)

    if categories is not None:
        checked_categories = _checked_categories(
            db, policy.policy_id if policy else None, categories
        )
    elif effective_policy_id != contract.policy_id:
        # A new policy must still cover the categories already stored on the contract.
        checked_categories = _checked_categories(
            db, policy.policy_id if policy else None, contract_categories(db, contract.contract_id)
        )
    else:
        checked_categories = None

    if country_code is not None:
        contract.country_code = _checked_country(country_code)
    if currency is not None:
        contract.currency = _checked_currency(currency)
    if rate_amount is not None:
        contract.rate_amount = _checked_amount(rate_amount, "rate_amount")
    if rate_unit is not None:
        contract.rate_unit = _checked_rate_unit(rate_unit)
    if service_category is not None:
        contract.service_category = _checked_service_category(service_category)
    if max_company_amount_per_claim is not None:
        contract.max_company_amount_per_claim = _checked_amount(
            max_company_amount_per_claim, "max_company_amount_per_claim"
        )
    contract.policy_id = policy.policy_id if policy else None

    start = effective_from if effective_from is not None else contract.effective_from
    end = None if clear_effective_to else (
        effective_to if effective_to is not None else contract.effective_to
    )
    contract.effective_from, contract.effective_to = _checked_dates(start, end)
    if is_active is not None:
        contract.is_active = is_active

    if checked_categories is not None:
        _replace_categories(db, contract.contract_id, checked_categories)
    contract.updated_at = datetime.now(timezone.utc)
    db.add(contract)
    db.commit()
    db.refresh(contract)
    return contract


def payout_settings_row(db: Session) -> PayoutSettings:
    """The single row, created from defaults on first read."""
    row = db.exec(select(PayoutSettings).where(PayoutSettings.id == PAYOUT_SETTINGS_ID)).first()
    if row:
        return row
    row = PayoutSettings(
        id=PAYOUT_SETTINGS_ID,
        paypal_account_country=DEFAULT_ACCOUNT_COUNTRY,
        held_currencies=list(DEFAULT_HELD_CURRENCIES),
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return db.exec(select(PayoutSettings).where(PayoutSettings.id == PAYOUT_SETTINGS_ID)).one()
    db.refresh(row)
    return row


def payout_settings_dict(db: Session) -> dict:
    row = payout_settings_row(db)
    return {
        "paypal_account_country": row.paypal_account_country,
        "paypal_account_country_name": country_name(row.paypal_account_country),
        "held_currencies": list(row.held_currencies or []),
        "company_currency": company_currency(),
        "updated_by": str(row.updated_by) if row.updated_by else None,
        "updated_at": row.updated_at.isoformat() if row.updated_at else None,
    }


def update_payout_settings(
    db: Session,
    *,
    paypal_account_country: str | None,
    held_currencies: list[str] | None,
    actor: UUID,
) -> PayoutSettings:
    row = payout_settings_row(db)
    country = _checked_country(paypal_account_country if paypal_account_country is not None
                               else row.paypal_account_country)
    if not held_currencies:
        raise ContractError("CURRENCIES_REQUIRED", "Choose at least one funding currency.")
    currencies: list[str] = []
    for raw in held_currencies:
        code = normalise_currency(raw)
        if code is None:
            raise ContractError("CURRENCY_UNSUPPORTED", f"Unsupported funding currency: {raw}")
        if code not in currencies:
            currencies.append(code)

    before = {
        "paypal_account_country": row.paypal_account_country,
        "held_currencies": list(row.held_currencies or []),
    }
    row.paypal_account_country = country
    row.held_currencies = currencies
    row.updated_by = actor
    row.updated_at = datetime.now(timezone.utc)
    db.add(row)
    db.commit()
    db.refresh(row)
    record_action(db, AgentActionType.CONFIG_CHANGED, str(actor), None, {
        "setting": "payout_settings",
        "old": before,
        "new": {"paypal_account_country": country, "held_currencies": currencies},
    })
    return row
