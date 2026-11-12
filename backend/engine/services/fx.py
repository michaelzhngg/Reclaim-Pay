"""Deterministic FX quotes to and from the company currency.

No provider, no network and no spread. The table is denominated in MYR per one unit of
the foreign currency, and `FX_RATES` (JSON) overrides it for demos and tests. Any pair
with a currency missing from the table raises `FxUnavailable`, so callers can fail closed
instead of guessing 1:1.
"""
import json
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation, ROUND_HALF_UP

from core.config import settings
from engine.services.currency import company_currency

logger = logging.getLogger(__name__)

# MYR per one unit. Source: a fixed demo table, not a live feed.
MYR_PER_UNIT: dict[str, Decimal] = {
    "MYR": Decimal("1"),
    "USD": Decimal("4.70"),
    "EUR": Decimal("5.10"),
    "GBP": Decimal("5.95"),
    "AUD": Decimal("3.10"),
    "CAD": Decimal("3.40"),
    "SGD": Decimal("3.50"),
    "HKD": Decimal("0.60"),
    "JPY": Decimal("0.030"),
    "IDR": Decimal("0.00029375"),
    "THB": Decimal("0.135"),
    "PHP": Decimal("0.082"),
    "VND": Decimal("0.000185"),
    "INR": Decimal("0.055"),
    "CNY": Decimal("0.65"),
    "KRW": Decimal("0.0034"),
    "TWD": Decimal("0.145"),
    "NZD": Decimal("2.80"),
    "AED": Decimal("1.28"),
    "SAR": Decimal("1.25"),
    "QAR": Decimal("1.29"),
    "KWD": Decimal("15.30"),
    "ILS": Decimal("1.30"),
    "CHF": Decimal("5.40"),
    "SEK": Decimal("0.45"),
    "NOK": Decimal("0.44"),
    "DKK": Decimal("0.68"),
    "PLN": Decimal("1.20"),
    "CZK": Decimal("0.20"),
    "HUF": Decimal("0.013"),
    "TRY": Decimal("0.14"),
    "MXN": Decimal("0.27"),
    "BRL": Decimal("0.85"),
    "ARS": Decimal("0.0047"),
    "CLP": Decimal("0.0050"),
    "COP": Decimal("0.0012"),
    "ZAR": Decimal("0.26"),
    "NGN": Decimal("0.0031"),
    "KES": Decimal("0.036"),
    "EGP": Decimal("0.095"),
}

# Receipts still read "RM" in places. It is the same currency as MYR.
ALIASES = {"RM": "MYR"}

MONEY = Decimal("0.01")
RATE = Decimal("0.00000001")


class FxUnavailable(ValueError):
    """No deterministic quote for this currency pair."""

    def __init__(self, from_currency: str, to_currency: str):
        self.from_currency = from_currency
        self.to_currency = to_currency
        super().__init__(f"FX_UNAVAILABLE: {from_currency}->{to_currency}")


@dataclass(frozen=True)
class FxQuote:
    from_currency: str
    to_currency: str
    rate: Decimal
    amount: Decimal
    converted: Decimal
    as_of: datetime
    source: str

    def as_dict(self) -> dict:
        return {
            "from_currency": self.from_currency,
            "to_currency": self.to_currency,
            "rate": float(self.rate),
            "amount": float(self.amount),
            "converted": float(self.converted),
            "as_of": self.as_of.isoformat(),
            "source": self.source,
        }


def normalise(code: str | None) -> str:
    value = (code or "").strip().upper()
    return ALIASES.get(value, value)


def _env_rates() -> dict[str, Decimal]:
    raw = (settings.FX_RATES or "").strip()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
        return {
            normalise(code): Decimal(str(rate))
            for code, rate in parsed.items()
            if Decimal(str(rate)) > 0
        }
    except (ValueError, TypeError, InvalidOperation, AttributeError):
        logger.error("[FX] FX_RATES is not a JSON object of positive rates; using the table")
        return {}


def _to_company(currency: str, overrides: dict[str, Decimal]) -> Decimal:
    company = company_currency()
    if currency == company:
        return Decimal("1")
    if currency in overrides:
        return overrides[currency]
    rate = MYR_PER_UNIT.get(currency)
    company_rate = MYR_PER_UNIT.get(company)
    if rate is None or company_rate is None:
        raise FxUnavailable(currency, company)
    return rate / company_rate


def rate_between(from_currency: str, to_currency: str) -> Decimal:
    """Units of `to_currency` per one unit of `from_currency`, chained through company currency."""
    source, target = normalise(from_currency), normalise(to_currency)
    if source == target:
        return Decimal("1")
    overrides = _env_rates()
    try:
        return (_to_company(source, overrides) / _to_company(target, overrides)).quantize(RATE)
    except (FxUnavailable, InvalidOperation) as exc:
        if isinstance(exc, FxUnavailable):
            raise
        raise FxUnavailable(source, target)


def _as_of(now: datetime | None) -> datetime:
    if now is not None:
        return now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    fixed = (settings.FX_RATES_AS_OF or "").strip()
    if fixed:
        try:
            parsed = datetime.fromisoformat(fixed.replace("Z", "+00:00"))
            return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
        except ValueError:
            logger.error("[FX] FX_RATES_AS_OF is not an ISO timestamp; using now")
    return datetime.now(timezone.utc)


def quote(
    amount,
    from_currency: str | None,
    to_currency: str | None,
    now: datetime | None = None,
) -> FxQuote:
    source, target = normalise(from_currency), normalise(to_currency)
    value = Decimal(str(amount or 0))
    if source == target:
        return FxQuote(source, target, Decimal("1"), value, value.quantize(MONEY, ROUND_HALF_UP),
                       _as_of(now), "IDENTITY")
    rate = rate_between(source, target)
    converted = (value * rate).quantize(MONEY, ROUND_HALF_UP)
    return FxQuote(
        source, target, rate, value, converted, _as_of(now),
        "ENV" if _env_rates() else "TABLE",
    )


def quote_or_none(
    amount,
    from_currency: str | None,
    to_currency: str | None = None,
    now: datetime | None = None,
) -> FxQuote | None:
    try:
        return quote(amount, from_currency, to_currency or company_currency(), now)
    except FxUnavailable:
        return None


def company_amount(amount, currency: str | None, now: datetime | None = None) -> tuple[Decimal, FxQuote | None]:
    """(company-currency amount, quote). Unquoted currencies fall back to the raw amount."""
    value = Decimal(str(amount or 0))
    quoted = quote_or_none(value, currency, company_currency(), now)
    if quoted is None:
        return value.quantize(MONEY, ROUND_HALF_UP), None
    return quoted.converted, quoted


def stored_company_amount(record) -> Decimal:
    """The larger of the claimed and approved company snapshots, or the raw fallback."""
    claimed = getattr(record, "amount_company", None)
    approved = getattr(record, "approved_company_amount", None)
    if claimed is not None or approved is not None:
        return max(Decimal(str(claimed or 0)), Decimal(str(approved or 0)))
    raw_claimed = getattr(record, "total_claimed_amount", None)
    raw_approved = getattr(record, "total_approved_amount", None)
    return max(Decimal(str(raw_claimed or 0)), Decimal(str(raw_approved or 0)))


def is_unquoted(record) -> bool:
    """True when the stored company amount was not converted by a quote."""
    source = (getattr(record, "fx_source", None) or "").upper()
    if source == "UNQUOTED":
        return True
    currency = normalise(getattr(record, "currency", None))
    rate = getattr(record, "fx_rate_to_company", None)
    return currency != company_currency() and not rate
