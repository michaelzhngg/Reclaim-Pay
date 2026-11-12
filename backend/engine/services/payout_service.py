"""
Shared payout service — callable from both the HTTP route and the async
compliance background task.

Usage from an async context (FastAPI route):
    payout = await initiate_payout_async(reim_id, db)

Usage from a sync thread (background task with access to the event loop):
    payout = initiate_payout_sync(reim_id, db, loop)

Payouts go to the employee's verified PayPal account (recipient_type PAYPAL_ID).
`sender_batch_id` is derived from the claim and attempt number, so a retried
request can never pay twice.

The amount and currency PayPal receives come from the claim's locked payout snapshot:
the contract currency for a contractor, the company currency otherwise. Every payout
passes the pure MYR guard before the claim is marked DISBURSING and before any PayPal
call. A refusal records a failed attempt and leaves the claim approved.
"""
import asyncio
import json
import logging
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP
from typing import Iterable
from uuid import UUID

from sqlmodel import Session, select

from core.config import settings
from core.models import (
    ContractorContract,
    Notification,
    Payout,
    PayoutSettings,
    Reimbursement,
    User,
    Vendor,
    VendorBooking,
)
from core.email_service import fire_and_forget_email
from core.enums import AgentActionType, PayoutStatus, ReimbursementStatus, UserRole, is_vendor_booking
from core.push_service import fire_and_forget_push
from engine.services.action_log import record_action
from engine.services import fx
from engine.services import payout_guard
from engine.services.contracts import DEFAULT_ACCOUNT_COUNTRY, DEFAULT_HELD_CURRENCIES
from engine.services.paypal_client import (
    PayPalError,
    PayoutCreated,
    get_paypal_client,
    mask_email,
    sender_batch_id_for,
)
from engine.services.recovery_service import offset_for_reim

logger = logging.getLogger(__name__)

MONEY = Decimal("0.01")
_LIVE_STATUSES = {PayoutStatus.ACCEPTED, PayoutStatus.REQUESTED, PayoutStatus.SUCCEEDED}
_PAYABLE_STATUSES = {ReimbursementStatus.APPROVED, ReimbursementStatus.DISBURSEMENT_FAILED}
_HR_LINK = "/hr/contractors"


class PayoutRefused(Exception):
    """The guard refused the payout before any PayPal call. `code` is the stable reason."""

    def __init__(self, code: str, message: str | None = None):
        self.code = code
        self.message = message or payout_guard.refusal_message(code)
        super().__init__(code)


@dataclass(frozen=True)
class Payee:
    """Who receives the money. The requester stays on Payout.user_id for attribution."""
    kind: str
    payer_id: str
    email: str | None
    label: str
    country: str | None = None
    vendor_id: UUID | None = None


@dataclass(frozen=True)
class PayoutDestination:
    """What PayPal would be asked to send, before and after the guard."""
    payee: Payee
    currency: str
    amount: Decimal
    payee_country: str | None
    contract_id: UUID | None = None


@dataclass(frozen=True)
class PayoutPreview:
    """The expected payout for HR review. Read-only; approval is what locks it."""
    amount: Decimal
    currency: str
    rate: Decimal | None
    as_of: datetime | None
    source: str | None
    company_amount: Decimal | None


def payee_for_reim(db: Session, reim: Reimbursement) -> Payee | None:
    """The verified payee for a claim or a vendor booking, or None if there is not one."""
    if is_vendor_booking(reim):
        booking = db.exec(select(VendorBooking).where(VendorBooking.reim_id == reim.reim_id)).first()
        vendor = db.get(Vendor, booking.vendor_id) if booking else None
        if not vendor or not vendor.paypal_verified or not vendor.paypal_payer_id or not vendor.is_active:
            return None
        return Payee(
            kind="VENDOR_BOOKING",
            payer_id=vendor.paypal_payer_id,
            email=vendor.paypal_email,
            label=vendor.name,
            country=vendor.country_code or "MY",
            vendor_id=vendor.vendor_id,
        )
    employee = db.get(User, reim.user_id)
    if not employee or not employee.paypal_verified or not employee.paypal_payer_id:
        return None
    return Payee(
        kind="CLAIM",
        payer_id=employee.paypal_payer_id,
        email=employee.paypal_email,
        label=employee.name,
        country=employee.country_code or "MY",
    )


def contract_for_reim(db: Session, reim: Reimbursement) -> ContractorContract | None:
    return db.get(ContractorContract, reim.contract_id) if reim.contract_id else None


def payout_currency_for(db: Session, reim: Reimbursement) -> tuple[str, ContractorContract | None]:
    """The contract currency for a contractor claim, the company currency otherwise."""
    contract = contract_for_reim(db, reim)
    if contract and contract.currency:
        return fx.normalise(contract.currency) or fx.company_currency(), contract
    return fx.company_currency(), None


def _locked_rate(reim: Reimbursement, target_currency: str) -> Decimal | None:
    """The claim-to-payout rate HR locked, when one exists for `target_currency`."""
    locked_currency = fx.normalise(reim.payout_currency)
    if locked_currency == target_currency and reim.payout_fx_rate:
        return Decimal(str(reim.payout_fx_rate))
    if target_currency == fx.company_currency() and reim.fx_rate_to_company and not fx.is_unquoted(reim):
        return Decimal(str(reim.fx_rate_to_company))
    return None


def payout_amount_for(
    reim: Reimbursement,
    net_claim: Decimal,
    payout_currency: str,
) -> Decimal | None:
    """The amount PayPal receives, in `payout_currency`, or None when no rate exists.

    A full payout uses the snapshot locked at approval. A recovery offset nets the claim in
    the claim currency first, then converts at the same locked rate. A claim with no quote
    fails closed instead of paying a foreign amount as if it were the payout currency.
    """
    target = fx.normalise(payout_currency) or fx.company_currency()
    claim_currency = fx.normalise(reim.currency) or fx.company_currency()
    net = Decimal(str(net_claim or 0)).quantize(MONEY, ROUND_HALF_UP)
    full_claim = Decimal(str(reim.total_approved_amount or 0)).quantize(MONEY, ROUND_HALF_UP)

    if (fx.normalise(reim.payout_currency) == target
            and reim.payout_amount is not None
            and net == full_claim):
        return Decimal(str(reim.payout_amount)).quantize(MONEY, ROUND_HALF_UP)
    if claim_currency == target:
        return net
    rate = _locked_rate(reim, target)
    if rate is not None:
        return (net * rate).quantize(MONEY, ROUND_HALF_UP)
    quoted = fx.quote_or_none(net, claim_currency, target)
    return quoted.converted if quoted else None


def lock_payout_snapshot(db: Session, reim: Reimbursement, approved_claimed, now: datetime) -> None:
    """Lock what PayPal will send, at the quote approval used. Never guesses a rate."""
    currency, _contract = payout_currency_for(db, reim)
    amount = Decimal(str(approved_claimed or 0)).quantize(MONEY, ROUND_HALF_UP)
    claim_currency = fx.normalise(reim.currency) or fx.company_currency()

    if amount <= 0:
        reim.payout_amount = None
        reim.payout_currency = None
        reim.payout_fx_rate = None
        reim.payout_fx_at = None
        return

    reim.payout_currency = currency
    if claim_currency == currency:
        reim.payout_amount = float(amount)
        reim.payout_fx_rate = 1.0
        reim.payout_fx_at = reim.fx_rate_at or now
        return

    # The company-currency payout is exactly the approved company amount, so it reuses the
    # approval quote instead of re-pricing the claim.
    if currency == fx.company_currency() and reim.approved_company_amount is not None:
        reim.payout_amount = float(Decimal(str(reim.approved_company_amount)).quantize(MONEY, ROUND_HALF_UP))
        reim.payout_fx_rate = float(reim.fx_rate_to_company) if reim.fx_rate_to_company else None
        reim.payout_fx_at = reim.fx_rate_at or now
        return

    quoted = fx.quote_or_none(amount, claim_currency, currency, now)
    if quoted is None:
        reim.payout_amount = None
        reim.payout_fx_rate = None
        reim.payout_fx_at = None
        return
    reim.payout_amount = float(quoted.converted)
    reim.payout_fx_rate = float(quoted.rate)
    reim.payout_fx_at = quoted.as_of


def payout_preview(db: Session, reim: Reimbursement) -> PayoutPreview | None:
    """What the payout would be if HR approved now. Nothing is written or locked."""
    currency, _contract = payout_currency_for(db, reim)
    basis = reim.total_approved_amount
    if basis is None:
        basis = reim.total_claimed_amount
    amount = payout_amount_for(reim, Decimal(str(basis or 0)), currency)
    if amount is None:
        return None

    claim_currency = fx.normalise(reim.currency) or fx.company_currency()
    rate: Decimal | None = None
    as_of: datetime | None = None
    source: str | None = None
    if claim_currency == currency:
        rate, as_of, source = Decimal("1"), reim.fx_rate_at, "IDENTITY"
    elif (fx.normalise(reim.payout_currency) == currency and reim.payout_fx_rate
          and basis == reim.total_approved_amount):
        rate, as_of, source = Decimal(str(reim.payout_fx_rate)), reim.payout_fx_at, "APPROVED"
    else:
        quoted = fx.quote_or_none(Decimal(str(basis or 0)), claim_currency, currency)
        if quoted:
            rate, as_of, source = quoted.rate, quoted.as_of, quoted.source

    company = fx.quote_or_none(amount, currency, fx.company_currency())
    return PayoutPreview(
        amount=amount,
        currency=currency,
        rate=rate,
        as_of=as_of,
        source=source,
        company_amount=company.converted if company else None,
    )


def resolve_payout(db: Session, reim: Reimbursement, net_claim: Decimal) -> PayoutDestination | None:
    """The payee, currency and amount PayPal would receive, or None when it cannot be built."""
    payee = payee_for_reim(db, reim)
    if payee is None:
        return None
    currency, contract = payout_currency_for(db, reim)
    amount = payout_amount_for(reim, net_claim, currency)
    if amount is None:
        return None
    # The contract is the authoritative payee country for a contractor, never the user row.
    payee_country = contract.country_code if contract else payee.country
    return PayoutDestination(
        payee=payee,
        currency=currency,
        amount=amount,
        payee_country=payee_country,
        contract_id=contract.contract_id if contract else None,
    )


def payout_plan(
    reim_status: str,
    net_amount: Decimal,
    existing_statuses: list[str],
    payee_verified: bool,
) -> tuple[str, Decimal | None, int]:
    """Decide what to do for a claim. Returns (action, amount, attempt)."""
    if reim_status not in _PAYABLE_STATUSES:
        return "SKIP_NOT_APPROVED", None, 0
    if any(s in _LIVE_STATUSES for s in existing_statuses):
        return "SKIP_EXISTING", None, 0
    if net_amount <= 0:
        return "SKIP_ZERO", None, 0
    if not payee_verified:
        return "SKIP_NO_PAYEE", None, 0
    # attempt only moves on after a payout ended FAILED, REVERSED or CANCELLED
    return "CREATE", net_amount, len(existing_statuses) + 1


def notify(db: Session, user_id: UUID, n_type: str, title: str, message: str, link: str | None = None,
           email: bool = False):
    """In-app row and web push. `email=True` also emails the user, but only when they are an employee."""
    db.add(Notification(user_id=user_id, type=n_type, title=title, message=message, link=link, is_read=False))
    db.commit()
    fire_and_forget_push(user_id, title, message, link=link or "/")
    if email:
        user = db.get(User, user_id)
        if user and user.email and user.role == UserRole.Employee:
            fire_and_forget_email(user.email, title, message, link=link)


def _claim_ref(reim_id: UUID) -> str:
    return f"RC-{str(reim_id)[:8]}"


def _existing_payouts(db: Session, reim_id: UUID) -> list[Payout]:
    return list(db.exec(select(Payout).where(Payout.reim_id == reim_id).order_by(Payout.attempt)).all())


def payout_settings_values(db: Session) -> tuple[str, list[str]]:
    """Account country and held currencies, without creating the row mid-transaction."""
    row = db.exec(select(PayoutSettings).where(PayoutSettings.id == 1)).first()
    if row is None:
        return DEFAULT_ACCOUNT_COUNTRY, list(DEFAULT_HELD_CURRENCIES)
    return row.paypal_account_country, list(row.held_currencies or [])


async def read_funding(payout_currency: str, held_currencies: Iterable[str]) -> payout_guard.Funding:
    """One balance read the guard can reason about. Fails closed on any PayPal error.

    A MYR payout needs the MYR balance. A foreign payout may be funded from any non-MYR
    balance the company holds, so those are tried in turn. Mock mode reads the configured
    per-currency balances; live mode reads PayPal and refuses when the read fails.
    """
    candidates = [payout_currency]
    if payout_currency != "MYR":
        candidates += [c for c in held_currencies if c != "MYR" and c != payout_currency]
    if settings.PAYPAL_MOCK_MODE:
        return _mock_funding(candidates, payout_currency)
    for currency in candidates:
        try:
            balance = await get_paypal_client().get_balance(currency)
        except PayPalError as exc:
            logger.warning("[PAYOUT_GUARD] Balance read failed for %s: %s %s", currency, exc.status, exc.name)
            return payout_guard.Funding(currency, error="unreachable")
        except (ValueError, InvalidOperation):
            logger.warning("[PAYOUT_GUARD] Balance unreadable for %s", currency)
            return payout_guard.Funding(currency, error="unreadable")
        except Exception as exc:
            logger.warning("[PAYOUT_GUARD] Balance read failed for %s: %s", currency, type(exc).__name__)
            return payout_guard.Funding(currency, error="unreachable")
        if balance is None:
            continue
        if not balance.available.is_finite():
            return payout_guard.Funding(currency, error="unreadable")
        return payout_guard.Funding(currency, balance.available)
    return payout_guard.Funding(payout_currency, error="missing")


def _mock_funding(candidates: list[str], payout_currency: str) -> payout_guard.Funding:
    """Per-currency mock balances. No JSON configured keeps the single demo balance."""
    raw = (settings.PAYPAL_MOCK_BALANCES or "").strip()
    if not raw:
        return payout_guard.Funding(payout_currency, Decimal(str(settings.PAYPAL_MOCK_BALANCE)))
    try:
        balances = {str(code).upper(): Decimal(str(amount)) for code, amount in json.loads(raw).items()}
    except (ValueError, TypeError, InvalidOperation, AttributeError):
        logger.error("[PAYOUT_GUARD] PAYPAL_MOCK_BALANCES is not a JSON object of amounts")
        return payout_guard.Funding(payout_currency, error="unreadable")
    for currency in candidates:
        if currency in balances:
            return payout_guard.Funding(currency, balances[currency])
    return payout_guard.Funding(payout_currency, error="missing")


def _guard_code(db: Session, destination: PayoutDestination, funding: payout_guard.Funding | None) -> str | None:
    account_country, held = payout_settings_values(db)
    return payout_guard.check_payout(
        payout_currency=destination.currency,
        payee_country=destination.payee_country,
        account_country=account_country,
        held_currencies=held,
        funding=funding,
    )


def _record_refusal(
    db: Session,
    reim: Reimbursement,
    destination: PayoutDestination,
    attempt: int,
    code: str,
) -> None:
    """Record the failed attempt with no batch ID, tell HR, and leave the claim approved."""
    payout = Payout(
        reim_id=reim.reim_id,
        user_id=reim.user_id,
        vendor_id=destination.payee.vendor_id,
        amount=destination.amount,
        currency=destination.currency,
        status=PayoutStatus.FAILED,
        provider="PAYPAL",
        provider_batch_id=None,
        attempt=attempt,
        idempotency_key=f"REFUSED-{reim.reim_id.hex}-{attempt}",
        reference_id=_claim_ref(reim.reim_id),
        channel_code="PAYPAL",
        failure_code=code,
    )
    db.add(payout)
    db.commit()
    db.refresh(payout)

    record_action(db, AgentActionType.PAYOUT_CREATED, "agent", reim.reim_id, {
        "amount": f"{destination.amount:.2f}",
        "currency": destination.currency,
        "refused": code,
        **({"vendor_id": str(destination.payee.vendor_id)} if destination.payee.vendor_id else {}),
    })
    _notify_hr_refusal(db, reim, destination, code)
    logger.warning("[PAYOUT_GUARD] Refused reim=%s: %s", reim.reim_id, code)
    raise PayoutRefused(code)


def _notify_hr_refusal(db: Session, reim: Reimbursement, destination: PayoutDestination, code: str) -> None:
    title = f"Payout refused for claim {_claim_ref(reim.reim_id)}"
    message = (
        f"{destination.currency} {destination.amount:,.2f} was not sent. "
        f"{payout_guard.refusal_message(code)} The claim stays approved, so HR can retry after the fix."
    )
    link = _HR_LINK if destination.contract_id else "/hr/settings"
    recipients = db.exec(select(User).where(User.role == UserRole.HR, User.is_active == True)).all()  # noqa: E712
    for hr in recipients:
        notify(db, hr.user_id, "error", title, message, link=link)


def _plan(reim_id: UUID, db: Session):
    reim = db.get(Reimbursement, reim_id)
    if not reim:
        return None, None, ("SKIP_NOT_APPROVED", None, 0), []
    existing = _existing_payouts(db, reim_id)
    net_amount, _applied = offset_for_reim(db, reim)
    destination = resolve_payout(db, reim, net_amount)
    if destination is None:
        # Distinguish a missing payee from a missing quote for the HR response.
        payee = payee_for_reim(db, reim)
        action = "SKIP_NO_PAYEE" if payee is None else "SKIP_NO_FX_QUOTE"
        return reim, None, (action, None, 0), existing
    plan = payout_plan(
        reim.status, destination.amount, [p.status for p in existing],
        destination.payee is not None,
    )
    return reim, destination, plan, existing


def _settle_without_payout(db: Session, reim: Reimbursement):
    from engine.services.trust_notices import notify_if_changed, tier_of

    tier_before = tier_of(db, reim.user_id)
    reim.status = ReimbursementStatus.PAID
    reim.updated_at = datetime.now(timezone.utc)
    db.add(reim)
    db.commit()
    notify(
        db, reim.user_id, "success",
        f"Claim {_claim_ref(reim.reim_id)} settled",
        "Settled against an earlier overpayment. No PayPal transfer was needed.",
        link=f"/employee/history?id={reim.reim_id}",
    )
    notify_if_changed(db, reim.user_id, tier_before, reim_id=reim.reim_id)


def _handle_skip(db: Session, reim: Reimbursement | None, action: str, existing: list[Payout]) -> Payout | None:
    if action == "SKIP_EXISTING":
        return next(p for p in reversed(existing) if p.status in _LIVE_STATUSES)
    if action == "SKIP_ZERO" and reim is not None:
        # PAID needs money moved or an offset that covered it. Nothing approved is neither, so the status stays.
        if offset_for_reim(db, reim)[1]:
            _settle_without_payout(db, reim)
        else:
            logger.warning("[AUTO_PAYOUT] Nothing approved on reim=%s, not marking it paid", reim.reim_id)
    elif action == "SKIP_NO_PAYEE" and reim is not None:
        logger.info("[AUTO_PAYOUT] Skipping reim=%s: the payee has no verified PayPal account", reim.reim_id)
    elif action == "SKIP_NO_FX_QUOTE" and reim is not None:
        logger.warning("[AUTO_PAYOUT] Skipping reim=%s: no FX quote for %s", reim.reim_id, reim.currency)
    return None


def _mark_disbursing(db: Session, reim: Reimbursement):
    reim.status = ReimbursementStatus.DISBURSING
    reim.updated_at = datetime.now(timezone.utc)
    db.add(reim)
    db.flush()


def _save_payout(
    db: Session,
    reim: Reimbursement,
    destination: PayoutDestination,
    attempt: int,
    sender_batch_id: str,
    created: PayoutCreated,
) -> Payout:
    payee = destination.payee
    currency = destination.currency
    amount = destination.amount
    payout = Payout(
        reim_id=reim.reim_id,
        user_id=reim.user_id,
        vendor_id=payee.vendor_id,
        amount=amount,
        currency=currency,
        status=PayoutStatus.ACCEPTED,
        provider="PAYPAL",
        provider_batch_id=created.batch_id,
        attempt=attempt,
        idempotency_key=sender_batch_id,
        reference_id=_claim_ref(reim.reim_id),
        channel_code="PAYPAL",
    )
    db.add(payout)
    db.commit()
    db.refresh(payout)

    record_action(db, AgentActionType.PAYOUT_CREATED, "agent", reim.reim_id, {
        "amount": f"{amount:.2f}",
        "currency": currency,
        "sender_batch_id": sender_batch_id,
        "batch_id": created.batch_id,
        **({"vendor_id": str(payee.vendor_id)} if payee.vendor_id else {}),
    })
    if payee.kind == "VENDOR_BOOKING":
        notify(
            db, reim.user_id, "info",
            f"Vendor paid for booking {_claim_ref(reim.reim_id)}",
            f"{currency} {amount:,.2f} was sent to {payee.label} ({mask_email(payee.email or '')})",
            link=f"/employee/history?id={reim.reim_id}",
        )
    else:
        notify(
            db, reim.user_id, "info",
            f"Payout initiated for claim {_claim_ref(reim.reim_id)}",
            f"Sending {currency} {amount:,.2f} to your PayPal account ({mask_email(payee.email or '')})",
            link=f"/employee/history?id={reim.reim_id}",
        )
    if settings.PAYPAL_MOCK_MODE:
        _schedule_status_refresh(payout.payout_id)

    logger.info("[AUTO_PAYOUT] Payout initiated: reim=%s payout=%s batch=%s payee=%s currency=%s",
                reim.reim_id, payout.payout_id, created.batch_id, payee.kind, currency)
    return payout


def _run(coro, loop: asyncio.AbstractEventLoop | None = None, timeout: float = 70):
    if loop and loop.is_running():
        return asyncio.run_coroutine_threadsafe(coro, loop).result(timeout=timeout)
    return asyncio.run(coro)


def _schedule_status_refresh(payout_id: UUID, delay: float = 9.0):
    """Mock mode has no webhooks, so poll once after the mock payout has settled."""
    def _refresh():
        from core.database import engine as db_engine
        from engine.services.payout_status import refresh_payout
        try:
            with Session(db_engine) as s:
                payout = s.get(Payout, payout_id)
                if payout:
                    asyncio.run(refresh_payout(s, payout))
        except Exception:
            logger.exception("[AUTO_PAYOUT] Mock status refresh failed for payout=%s", payout_id)

    timer = threading.Timer(delay, _refresh)
    timer.daemon = True
    timer.start()


def initiate_payout_sync(
    reim_id: UUID,
    db: Session,
    loop: asyncio.AbstractEventLoop | None = None,
) -> Payout | None:
    """
    Synchronous payout initiator — safe to call from a thread executor.
    Returns the Payout record on success, or None if skipped (no verified PayPal
    account, nothing left to pay, or not approved). Raises PayoutRefused when the guard
    blocks it. Does NOT raise on PayPal failure — it leaves the reimbursement in its
    current status for HR retry.
    """
    reim, destination, (action, amount, attempt), existing = _plan(reim_id, db)
    if action != "CREATE" or destination is None or reim is None:
        return _handle_skip(db, reim, action, existing)

    account_country, held = payout_settings_values(db)
    code = payout_guard.funding_refusal(
        payout_currency=destination.currency,
        payee_country=destination.payee_country,
        account_country=account_country,
        held_currencies=held,
    )
    if code is None:
        funding = _run(read_funding(destination.currency, held), loop)
        code = _guard_code(db, destination, funding)
    if code:
        _record_refusal(db, reim, destination, attempt, code)

    _mark_disbursing(db, reim)
    sender_batch_id = sender_batch_id_for(reim_id, attempt)

    try:
        coro = get_paypal_client().create_payout(
            sender_batch_id=sender_batch_id,
            payer_id=destination.payee.payer_id,
            amount=destination.amount,
            currency=destination.currency,
            note=_claim_ref(reim_id),
            sender_item_id=str(reim_id),
        )
        created = _run(coro, loop)
    except Exception:
        logger.exception("[AUTO_PAYOUT] PayPal call failed for reim=%s - leaving for HR retry", reim_id)
        db.rollback()
        return None

    return _save_payout(db, reim, destination, attempt, sender_batch_id, created)


async def initiate_payout_async(reim_id: UUID, db: Session) -> Payout | None:
    """Async variant for use in FastAPI route handlers. Same guard, same order."""
    reim, destination, (action, amount, attempt), existing = _plan(reim_id, db)
    if action != "CREATE" or destination is None or reim is None:
        return _handle_skip(db, reim, action, existing)

    account_country, held = payout_settings_values(db)
    code = payout_guard.funding_refusal(
        payout_currency=destination.currency,
        payee_country=destination.payee_country,
        account_country=account_country,
        held_currencies=held,
    )
    if code is None:
        funding = await read_funding(destination.currency, held)
        code = _guard_code(db, destination, funding)
    if code:
        _record_refusal(db, reim, destination, attempt, code)

    _mark_disbursing(db, reim)
    sender_batch_id = sender_batch_id_for(reim_id, attempt)

    try:
        created = await get_paypal_client().create_payout(
            sender_batch_id=sender_batch_id,
            payer_id=destination.payee.payer_id,
            amount=destination.amount,
            currency=destination.currency,
            note=_claim_ref(reim_id),
            sender_item_id=str(reim_id),
        )
    except Exception:
        logger.exception("[AUTO_PAYOUT] PayPal call failed for reim=%s", reim_id)
        db.rollback()
        return None

    return _save_payout(db, reim, destination, attempt, sender_batch_id, created)
