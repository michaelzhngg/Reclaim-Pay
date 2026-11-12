"""The pre-PayPal payout guard.

Pure and deterministic. It reads the payout currency, the payee country, the PayPal
account country, the currencies the company holds and one balance read. It never reads
the request body.

Callers must run it before the claim is marked DISBURSING and before any PayPal payout
call. A refusal leaves the claim approved: the money never left, so the claim is unpaid
rather than failed.
"""
from dataclasses import dataclass
from decimal import Decimal

from engine.services.currency import PAYOUT_CURRENCIES

MYR = "MYR"

MYR_PAYEE_NOT_MALAYSIAN = "MYR_PAYEE_NOT_MALAYSIAN"
PAYEE_COUNTRY_UNKNOWN = "PAYEE_COUNTRY_UNKNOWN"
MYR_BALANCE_REQUIRED = "MYR_BALANCE_REQUIRED"
NON_MYR_BALANCE_REQUIRED = "NON_MYR_BALANCE_REQUIRED"
BALANCE_UNAVAILABLE = "BALANCE_UNAVAILABLE"
PAYOUT_CURRENCY_UNKNOWN = "PAYOUT_CURRENCY_UNKNOWN"

REFUSAL_CODES = frozenset({
    MYR_PAYEE_NOT_MALAYSIAN,
    PAYEE_COUNTRY_UNKNOWN,
    MYR_BALANCE_REQUIRED,
    NON_MYR_BALANCE_REQUIRED,
    BALANCE_UNAVAILABLE,
    PAYOUT_CURRENCY_UNKNOWN,
})

# Plain reasons for HR. No scores, no PayPal jargon, no em dashes.
_REFUSAL_MESSAGE = {
    MYR_PAYEE_NOT_MALAYSIAN:
        "A Malaysian PayPal account can send MYR only to a Malaysian payee. "
        "Check the payee country or pay this person in another currency.",
    PAYEE_COUNTRY_UNKNOWN:
        "This payee has no country on record, so a MYR payout cannot be checked. "
        "Set the country on the contract or the staff record.",
    MYR_BALANCE_REQUIRED:
        "The PayPal account holds no MYR balance, so no MYR payout can be sent.",
    NON_MYR_BALANCE_REQUIRED:
        "A payout in a foreign currency needs a non-MYR funding currency in PayPal. "
        "Add one under Currencies and payouts.",
    BALANCE_UNAVAILABLE:
        "PayPal did not return a usable balance, so the payout was not sent.",
    PAYOUT_CURRENCY_UNKNOWN:
        "The payout currency is not supported. Fix the payee record before retrying.",
}


def refusal_message(code: str) -> str:
    return _REFUSAL_MESSAGE.get((code or "").upper(), "The payout was refused before it reached PayPal.")


def is_refusal(value: str | None) -> bool:
    """True when `value` is a guard refusal, not a PayPal failure code."""
    return (value or "").strip().upper() in REFUSAL_CODES


@dataclass(frozen=True)
class Funding:
    """One balance read. `available is None` with no error means PayPal holds no such balance."""

    currency: str
    available: Decimal | None = None
    # "unreachable", "unreadable" or "missing".
    error: str | None = None


def _code(value: str | None) -> str:
    return (value or "").strip().upper()


def funding_refusal(
    *,
    payout_currency: str | None,
    payee_country: str | None,
    account_country: str | None,
    held_currencies: list[str] | tuple[str, ...],
) -> str | None:
    """The country and funding-currency rules. No network, no balance read."""
    payout = _code(payout_currency)
    if payout not in PAYOUT_CURRENCIES:
        return PAYOUT_CURRENCY_UNKNOWN

    held = {_code(c) for c in held_currencies or () if _code(c)}
    # A missing account country is treated as the MY default, not as "unknown".
    account = _code(account_country) or "MY"

    if payout == MYR:
        if account == "MY":
            country = _code(payee_country)
            if not country:
                return PAYEE_COUNTRY_UNKNOWN
            if country != "MY":
                return MYR_PAYEE_NOT_MALAYSIAN
        if MYR not in held:
            return MYR_BALANCE_REQUIRED
        return None

    # Paying IDR from a USD balance is allowed because PayPal converts between non-MYR
    # currencies. A MYR balance cannot fund it, because the rule forbids conversion to
    # or from MYR.
    if not any(currency != MYR for currency in held):
        return NON_MYR_BALANCE_REQUIRED
    return None


def balance_refusal(*, payout_currency: str | None, funding: Funding | None) -> str | None:
    """Fail closed on a missing, unreachable or unreadable balance."""
    if funding is None or funding.error in ("unreachable", "unreadable"):
        return BALANCE_UNAVAILABLE
    available = funding.available
    if available is not None and not available.is_finite():
        return BALANCE_UNAVAILABLE
    if funding.error == "missing" or available is None:
        return MYR_BALANCE_REQUIRED if _code(payout_currency) == MYR else NON_MYR_BALANCE_REQUIRED
    return None


def check_payout(
    *,
    payout_currency: str | None,
    payee_country: str | None,
    account_country: str | None,
    held_currencies: list[str] | tuple[str, ...],
    funding: Funding | None,
) -> str | None:
    """The refusal code for this payout, or None when it may go ahead."""
    code = funding_refusal(
        payout_currency=payout_currency,
        payee_country=payee_country,
        account_country=account_country,
        held_currencies=held_currencies,
    )
    if code:
        return code
    return balance_refusal(payout_currency=payout_currency, funding=funding)
