"""Contractor invoice intake: contract rate checks, then the existing decision path.

An invoice is a `Reimbursement` row linked to the contract, not a new kind or a second
payment rail. Intake is deterministic: no LLM call and no status decided here. `decide()`
is still the only source of AUTO_PAY, and the contractor trust stop keeps a new contractor
in an HR lane.
"""

from datetime import date, datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from uuid import UUID, uuid4

from sqlmodel import Session

from core.enums import JudgmentResult, ReimbursementKind, ReimbursementStatus, UserRole
from core.models import LineItem, Reimbursement, User
from engine.risk.autonomy import decide
from engine.risk.types import AutonomyTier, ClaimFacts
from engine.services import autonomy_store, contracts as contract_service, fx
from engine.services.payout_service import lock_payout_snapshot

MONEY = Decimal("0.01")


class InvoiceError(ValueError):
    """An invoice rule was broken. `code` is the stable reason for the UI."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        super().__init__(message or code)


def _money(value, field: str = "amount") -> Decimal:
    try:
        return Decimal(str(value)).quantize(MONEY, ROUND_HALF_UP)
    except (InvalidOperation, TypeError, ValueError):
        raise InvoiceError("AMOUNT_INVALID", f"{field} must be a number.")


def line_total(quantity, unit_price) -> Decimal:
    """The one arithmetic rule: quantity times unit price, rounded to money."""
    return (_money(quantity, "quantity") * _money(unit_price, "unit_price")).quantize(
        MONEY, ROUND_HALF_UP
    )


def _checked_quantity(value) -> Decimal:
    quantity = _money(value, "quantity")
    if quantity <= 0:
        raise InvoiceError("QUANTITY_INVALID", "Quantity must be more than zero.")
    return quantity


def _checked_unit_price(value) -> Decimal:
    price = _money(value, "unit_price")
    if price <= 0:
        raise InvoiceError("UNIT_PRICE_INVALID", "Unit price must be more than zero.")
    return price


def _checked_period(start: date | None, end: date | None) -> tuple[date, date]:
    if start is None or end is None:
        raise InvoiceError("PERIOD_REQUIRED", "An invoice needs a start and an end date.")
    if end < start:
        raise InvoiceError("PERIOD_INVALID", "The period end cannot be before its start.")
    return start, end


def _checked_description(value: str | None) -> str:
    description = (value or "").strip()
    if not description:
        raise InvoiceError("DESCRIPTION_REQUIRED", "Describe the work this invoice covers.")
    return description


def _check_currency(requested: str | None, contract_currency: str) -> None:
    """The contract currency is the only source. A request may echo it, never change it."""
    if requested is None:
        return
    if (fx.normalise(requested) or "").upper() != (contract_currency or "").upper():
        raise InvoiceError("CURRENCY_MISMATCH", "An invoice is paid in the contract currency.")


def _check_category(requested: str | None, service_category: str) -> None:
    """The contract's service category is the invoice label and cannot be overridden."""
    if requested is None:
        return
    if (requested or "").strip().lower() != (service_category or "").strip().lower():
        raise InvoiceError("CATEGORY_OVERRIDE", "An invoice uses the contract service category.")


def create_invoice(
    db: Session,
    user: User,
    *,
    period_start: date | None,
    period_end: date | None,
    description: str | None,
    quantity,
    unit_price=None,
    claimed_amount,
    note: str | None = None,
    currency: str | None = None,
    category: str | None = None,
    now: datetime | None = None,
) -> tuple[Reimbursement, object]:
    """Persist one invoice and its decision. Returns (reimbursement, decision).

    Every check runs before the first database write, so a refused invoice saves nothing.
    """
    if user.role != UserRole.Contractor:
        raise InvoiceError("NOT_A_CONTRACTOR", "Only a contractor can submit an invoice.")

    contract = contract_service.active_contract(db, user.user_id, now)
    if contract is None:
        raise InvoiceError("NO_ACTIVE_CONTRACT", "Ask HR to add an active contract first.")

    start, end = _checked_period(period_start, period_end)
    title = _checked_description(description)
    _check_currency(currency, contract.currency)
    _check_category(category, contract.service_category)

    quantity_value = _checked_quantity(quantity)
    contract_rate = _money(contract.rate_amount, "contract rate")
    unit_price_value = _checked_unit_price(
        contract.rate_amount if unit_price is None else unit_price
    )
    claimed = _money(claimed_amount)
    if claimed != line_total(quantity_value, unit_price_value):
        raise InvoiceError(
            "AMOUNT_MISMATCH", "Quantity times unit price must equal the claimed amount."
        )

    over_contract_rate = unit_price_value > contract_rate
    judgment = JudgmentResult.NEEDS_INFO if over_contract_rate else JudgmentResult.APPROVED
    rate_unit = (contract.rate_unit or "").upper()

    now = now or datetime.now(timezone.utc)
    reim_id = uuid4()
    amount_company, quote = fx.company_amount(claimed, contract.currency, now)
    fx_unavailable = quote is None
    over_contract_limit = amount_company > Decimal(str(contract.max_company_amount_per_claim))

    # The amount is the claim-currency figure the invoice asks for. decide() sees the
    # company-currency snapshot, like every other claim.
    facts = ClaimFacts(
        reim_id=str(reim_id),
        user_id=str(user.user_id),
        amount=float(amount_company),
        currency=fx.company_currency(),
        judgment=judgment.value,
        confidence=1.0,
        over_category_budget=False,
        claimant_is_hr=False,
        claimant_is_contractor=True,
        over_contract_limit=over_contract_limit,
        fx_unavailable=fx_unavailable,
    )
    decision = decide(
        facts,
        [],
        autonomy_store.employee_history(db, user.user_id, now),
        autonomy_store.payee_from_user(user),
        autonomy_store.ledger_snapshot(db, now),
        autonomy_store.get_config(db),
        now,
    )

    # Only decide() can approve. An over-rate invoice is NEEDS_INFO, so it lands in an
    # HR tier even for a trusted contractor; the reasoning carries the reason for HR.
    auto_pay = decision.tier == AutonomyTier.AUTO_PAY
    status = ReimbursementStatus.APPROVED if auto_pay else ReimbursementStatus.REVIEW
    contract_reason = "OVER_CONTRACT_RATE" if over_contract_rate else None
    summary = f"Contractor invoice: {title}. {start.isoformat()} to {end.isoformat()}."
    if over_contract_rate:
        summary += (
            f" Billed at {unit_price_value} per {rate_unit.lower()} against the contract rate"
            f" of {contract_rate}."
        )
    if note and note.strip():
        summary += f" Note: {note.strip()}"

    reim = Reimbursement(
        reim_id=reim_id,
        user_id=user.user_id,
        policy_id=contract.policy_id,
        contract_id=contract.contract_id,
        kind=ReimbursementKind.CLAIM.value,
        main_category=contract.service_category,
        currency=contract.currency,
        total_claimed_amount=float(claimed),
        total_approved_amount=float(claimed) if auto_pay else None,
        amount_company=float(amount_company),
        approved_company_amount=float(amount_company) if auto_pay else None,
        fx_rate_to_company=float(quote.rate) if quote else None,
        fx_rate_at=quote.as_of if quote else None,
        fx_source=quote.source if quote else "UNQUOTED",
        judgment=judgment,
        confidence=1.0,
        ai_reasoning={
            "source": "contractor_invoice",
            "contract_id": str(contract.contract_id),
            "period": {"start": start.isoformat(), "end": end.isoformat()},
            "quantity": float(quantity_value),
            "unit_price": float(unit_price_value),
            "contract_rate": float(contract_rate),
            "contract_rate_unit": rate_unit,
            "over_contract_rate": over_contract_rate,
            "contract_reason": contract_reason,
            "note": note.strip() if note and note.strip() else None,
        },
        summary=summary,
        status=status,
        reviewed_at=now if auto_pay else None,
        tier=decision.tier.value,
        risk_score=decision.risk_score,
        autonomy=decision.model_dump(mode="json"),
        audit_selected=decision.audit_selected,
        invoice_period_start=start,
        invoice_period_end=end,
    )
    db.add(reim)
    db.flush()
    db.add(LineItem(
        reim_id=reim.reim_id,
        description=title,
        category=contract.service_category,
        quantity=float(quantity_value),
        unit_price=float(unit_price_value),
        claimed_amount=float(claimed),
        # The requested figure, so HR approval has an amount to approve. Only the
        # claim's status and totals move when decide() or HR approves.
        approved_amount=float(claimed),
        currency=contract.currency,
        expense_date=start,
        judgment=judgment,
        rejection_reason=(
            f"OVER_CONTRACT_RATE: billed {unit_price_value} against {contract_rate}"
            if over_contract_rate else None
        ),
    ))
    if auto_pay:
        # An invoice that decide() pays locks the same snapshot as an analyzed claim.
        lock_payout_snapshot(db, reim, claimed, now)
    db.commit()
    db.refresh(reim)
    return reim, decision
