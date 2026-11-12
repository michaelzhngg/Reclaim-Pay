"""
Compares paid PayPal payouts with the company's PayPal ledger for the HR "Reconciled N of M" header.

Transaction Search goes through the PayPal Server SDK. The SDK doesn't cover Payouts, which stay on PayPalClient.
"""
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Callable, Literal, Optional
from uuid import UUID

from pydantic import BaseModel
from sqlmodel import Session, select

from core.config import settings
from core.enums import PayoutStatus
from core.models import Payout, User

logger = logging.getLogger(__name__)

WINDOW_MINUTES = 120
# PayPal: "a maximum of three hours for executed transactions to appear".
SEARCH_LAG = timedelta(hours=3)
SDK_TIMEOUT_SECONDS = 15
PAGE_SIZE = 500
MAX_PAGES = 20

SETTLED = (PayoutStatus.SUCCEEDED, PayoutStatus.REVERSED)
IN_FLIGHT = (PayoutStatus.ACCEPTED, PayoutStatus.REQUESTED)
MASS_PAYMENT_CODE = "T0001"
# Fee, currency conversion and bank withdrawal debits are never a payout to an employee.
_NON_PAYOUT_CODES = ("T01", "T02", "T04")
_DENIED_STATUS = "D"
# Seeded and mock rows were never sent to PayPal, so they can't appear in its ledger.
NEVER_AT_PAYPAL = ("DEMOSEED-", "MOCKB-")

_NOTHING_PAID = "No paid payouts in this period."
_NO_TRANSACTIONS = "PayPal returned no transactions for this period, so nothing was compared."
_UNAVAILABLE = "PayPal can't be reached right now, so these payouts were not compared."


class TransactionSearchUnavailable(Exception):
    pass


@dataclass(frozen=True)
class ReconcileReport:
    matched: list[tuple[str, str]]
    missing_in_paypal: list[str]
    unknown_in_paypal: list[str]


@dataclass(frozen=True)
class PayoutFacts:
    payout_id: UUID
    reim_id: UUID
    employee_name: str
    amount: Decimal
    currency: str
    created_at: datetime
    # When the payout last changed: PayPal's lag runs from execution, which can follow creation.
    updated_at: datetime
    settled: bool
    provider_batch_id: Optional[str] = None


@dataclass(frozen=True)
class Transaction:
    transaction_id: str
    # Signed as PayPal reports it: money leaving the company account is negative.
    amount: Decimal
    currency: str
    occurred_at: datetime
    event_code: str = ""


@dataclass(frozen=True)
class TransactionFeed:
    transactions: list[Transaction]
    data_through: Optional[datetime] = None


class MismatchedPayout(BaseModel):
    payout_id: UUID
    reim_id: UUID
    claim_ref: str
    employee_name: str
    amount: float
    currency: str
    created_at: datetime
    reason: Literal["MISSING_IN_PAYPAL"] = "MISSING_IN_PAYPAL"


class UnknownTransaction(BaseModel):
    transaction_id: str
    amount: float
    currency: str
    occurred_at: datetime


class ReconcileSummary(BaseModel):
    # "ok": the numbers are a real comparison. Otherwise nothing was compared and `message` says why.
    state: Literal["ok", "no_data", "unavailable"]
    reconciled: int = 0
    total: int = 0
    pending: int = 0
    mismatches: list[MismatchedPayout] = []
    unknown_in_paypal: list[UnknownTransaction] = []
    days: int
    checked_at: datetime
    data_through: Optional[datetime] = None
    mock: bool = False
    message: Optional[str] = None


def match_transactions(
    payouts: list[tuple[str, Decimal, datetime]],
    txns: list[tuple[str, Decimal, datetime]],
    window_minutes: int = WINDOW_MINUTES,
) -> ReconcileReport:
    """Greedy one-to-one: each payout, oldest first, takes the closest unused transaction of the same amount."""
    window = timedelta(minutes=window_minutes)
    free = list(txns)
    matched, missing = [], []
    for payout_id, amount, at in sorted(payouts, key=lambda p: p[2]):
        candidates = [t for t in free if t[1] == amount and abs(t[2] - at) <= window]
        if not candidates:
            missing.append(payout_id)
            continue
        best = min(candidates, key=lambda t: abs(t[2] - at))
        free.remove(best)
        matched.append((payout_id, best[0]))
    return ReconcileReport(matched, missing, [t[0] for t in free])


def _could_be_payout(txn: Transaction) -> bool:
    return txn.amount < 0 and not txn.event_code.startswith(_NON_PAYOUT_CODES)


def _still_pending(payout: PayoutFacts, feed: TransactionFeed, now: datetime) -> bool:
    if now - payout.updated_at < SEARCH_LAG:
        return True
    return feed.data_through is not None and payout.updated_at > feed.data_through


def _mismatch(payout: PayoutFacts) -> MismatchedPayout:
    return MismatchedPayout(
        payout_id=payout.payout_id,
        reim_id=payout.reim_id,
        claim_ref=f"RC-{str(payout.reim_id)[:8].upper()}",
        employee_name=payout.employee_name,
        amount=float(payout.amount),
        currency=payout.currency,
        created_at=payout.created_at,
    )


def build_summary(payouts: list[PayoutFacts], feed: TransactionFeed, since: datetime, now: datetime,
                  days: int, mock: bool = False) -> ReconcileSummary:
    """`payouts` may start before `since` and include in-flight ones: both can own a transaction, neither is counted."""
    in_scope = [p for p in payouts if p.settled and p.created_at >= since]
    base = {"days": days, "checked_at": now, "data_through": feed.data_through, "mock": mock}
    if not in_scope:
        return ReconcileSummary(state="no_data", message=_NOTHING_PAID, **base)
    # An empty search is what the sandbox returns while it lags, so it proves nothing about any one payout.
    if not feed.transactions:
        return ReconcileSummary(state="no_data", total=len(in_scope), message=_NO_TRANSACTIONS, **base)

    debits = [t for t in feed.transactions if _could_be_payout(t)]
    matched: set[str] = set()
    free: set[str] = set()
    for currency in {p.currency for p in payouts} | {t.currency for t in debits}:
        report = match_transactions(
            [(str(p.payout_id), p.amount, p.created_at) for p in payouts if p.currency == currency],
            [(t.transaction_id, -t.amount, t.occurred_at) for t in debits if t.currency == currency],
        )
        matched.update(payout_id for payout_id, _ in report.matched)
        free.update(report.unknown_in_paypal)

    missing = [p for p in in_scope if str(p.payout_id) not in matched]
    mismatched = [p for p in missing if not _still_pending(p, feed, now)]
    unknown = [t for t in debits
               if t.transaction_id in free and t.event_code == MASS_PAYMENT_CODE and t.occurred_at >= since]
    return ReconcileSummary(
        state="ok",
        reconciled=len(in_scope) - len(missing),
        total=len(in_scope),
        pending=len(missing) - len(mismatched),
        mismatches=[_mismatch(p) for p in mismatched],
        unknown_in_paypal=[
            UnknownTransaction(transaction_id=t.transaction_id, amount=float(-t.amount), currency=t.currency,
                               occurred_at=t.occurred_at)
            for t in unknown
        ],
        **base,
    )


def _utc(value: datetime) -> datetime:
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def parse_search_response(body) -> tuple[list[Transaction], Optional[datetime]]:
    """Reads an SDK SearchResponse. PayPal omits empty fields, and the SDK then leaves the attribute unset."""
    transactions = []
    for detail in getattr(body, "transaction_details", None) or []:
        info = getattr(detail, "transaction_info", None)
        money = getattr(info, "transaction_amount", None)
        if money is None or getattr(info, "transaction_status", None) == _DENIED_STATUS:
            continue
        transactions.append(Transaction(
            transaction_id=info.transaction_id,
            amount=Decimal(money.value),
            currency=money.currency_code,
            occurred_at=_utc(datetime.fromisoformat(info.transaction_initiation_date)),
            event_code=getattr(info, "transaction_event_code", None) or "",
        ))
    refreshed = getattr(body, "last_refreshed_datetime", None)
    return transactions, _utc(datetime.fromisoformat(refreshed)) if refreshed else None


def _search_controller():
    # Imported here so mock mode and the tests never load the SDK's HTTP stack.
    from paypalserversdk.configuration import Environment
    from paypalserversdk.http.auth.o_auth_2 import ClientCredentialsAuthCredentials
    from paypalserversdk.paypal_serversdk_client import PaypalServersdkClient

    environment = Environment.SANDBOX if "sandbox" in settings.PAYPAL_BASE_URL else Environment.PRODUCTION
    return PaypalServersdkClient(
        client_credentials_auth_credentials=ClientCredentialsAuthCredentials(
            o_auth_client_id=settings.PAYPAL_CLIENT_ID,
            o_auth_client_secret=settings.PAYPAL_CLIENT_SECRET,
        ),
        environment=environment,
        timeout=SDK_TIMEOUT_SECONDS,
    ).transaction_search


def fetch_transactions(start: datetime, end: datetime) -> TransactionFeed:
    """Every page or nothing: a partial list would turn the unread pages into false mismatches."""
    if not settings.PAYPAL_CLIENT_ID or not settings.PAYPAL_CLIENT_SECRET:
        raise TransactionSearchUnavailable("PayPal credentials are not set")
    options = {
        "start_date": start.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "end_date": end.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "fields": "transaction_info",
        "page_size": PAGE_SIZE,
    }
    transactions: list[Transaction] = []
    data_through = None
    # The SDK raises its own API, OAuth and requests errors, and a bad field fails parsing: all mean "not compared".
    try:
        controller = _search_controller()
        page = 1
        while True:
            body = controller.search_transactions({**options, "page": page}).body
            found, data_through = parse_search_response(body)
            transactions += found
            total_pages = getattr(body, "total_pages", None) or 1
            if page >= total_pages:
                return TransactionFeed(transactions, data_through)
            if page >= MAX_PAGES:
                raise TransactionSearchUnavailable(f"More than {MAX_PAGES} pages of transactions")
            page += 1
    except TransactionSearchUnavailable:
        raise
    except Exception as exc:
        logger.warning("[RECONCILE] Transaction Search failed: %s", type(exc).__name__)
        raise TransactionSearchUnavailable(type(exc).__name__) from exc


def mock_feed(payouts: list[PayoutFacts], now: datetime) -> TransactionFeed:
    """PAYPAL_MOCK_MODE: PayPal's ledger agrees with ours. The summary carries mock=true so HR isn't misled."""
    return TransactionFeed(
        [Transaction(f"MOCKT-{p.payout_id.hex[:12].upper()}", -p.amount, p.currency, p.created_at, MASS_PAYMENT_CODE)
         for p in payouts],
        now,
    )


def _load_payouts(db: Session, start: datetime) -> list[PayoutFacts]:
    rows = db.exec(
        select(Payout, User)
        .join(User, User.user_id == Payout.user_id)
        .where(Payout.provider == "PAYPAL")
        .where(Payout.status.in_([s.value for s in SETTLED + IN_FLIGHT]))
        .where(Payout.created_at >= start)
    ).all()
    return [
        PayoutFacts(
            payout_id=payout.payout_id,
            reim_id=payout.reim_id,
            employee_name=employee.name,
            amount=Decimal(str(payout.amount)).quantize(Decimal("0.01")),
            currency=payout.currency,
            created_at=_utc(payout.created_at),
            updated_at=_utc(payout.updated_at or payout.created_at),
            settled=PayoutStatus(payout.status) in SETTLED,
            provider_batch_id=payout.provider_batch_id,
        )
        for payout, employee in rows
    ]


def reconcile(db: Session, days: int = 1, now: Optional[datetime] = None,
              fetch: Callable[[datetime, datetime], TransactionFeed] = fetch_transactions) -> ReconcileSummary:
    now = now or datetime.now(timezone.utc)
    since = now - timedelta(days=days)
    start = since - timedelta(minutes=WINDOW_MINUTES)
    payouts = _load_payouts(db, start)
    if settings.PAYPAL_MOCK_MODE:
        return build_summary(payouts, mock_feed(payouts, now), since, now, days, mock=True)

    payouts = [p for p in payouts if p.provider_batch_id and not p.provider_batch_id.startswith(NEVER_AT_PAYPAL)]
    total = sum(1 for p in payouts if p.settled and p.created_at >= since)
    if not total:
        return build_summary(payouts, TransactionFeed([]), since, now, days)
    try:
        feed = fetch(start, now)
    except TransactionSearchUnavailable:
        return ReconcileSummary(state="unavailable", total=total, days=days, checked_at=now, message=_UNAVAILABLE)
    return build_summary(payouts, feed, since, now, days)
