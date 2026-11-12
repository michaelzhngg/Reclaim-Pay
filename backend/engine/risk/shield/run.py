"""Runs every Receipt Shield check on one claim and reports each as a timeline step.

Steps carry HR-grade detail. Callers that stream to the employee pass them through
engine.risk.timeline.employee_safe first.
"""

import logging
import math
import re
from dataclasses import dataclass
from typing import Any, Callable

from pydantic import BaseModel, Field

from engine.risk.shield.arithmetic import check_totals
from engine.risk.shield.edits import signal_from_visual_anomaly, signals_from_human_edit
from engine.risk.shield.fingerprint import find_duplicates
from engine.risk.shield.forensics import forensics_signal
from engine.risk.shield.gaming import detect_near_threshold, detect_split
from engine.risk.shield.injection import scan_text
from engine.risk.shield.market_price import check_market_price
from engine.risk.timeline import make_step
from engine.risk.types import ClaimLite, DocFingerprint, RiskSignal, SignalCode, TimelineStep

logger = logging.getLogger(__name__)

Emit = Callable[[TimelineStep], None]

_NOT_A_NUMBER = re.compile(r"[^\d.\-]")
_CURRENCY_CODE = re.compile(r"[A-Z]{3}")
# With the 4 s search timeout, this bounds how long pricing can hold up a claim.
_MAX_PRICE_LOOKUPS = 3
_MIN_QUERY_CHARS = 3


@dataclass(frozen=True)
class PriceCheck:
    search: Callable[[str], list[float]]
    categories: frozenset[str]
    fx_to_usd: float
    currency: str


class ShieldDoc(BaseModel):
    document_id: str
    extracted: dict = Field(default_factory=dict)
    # Fields the employee typed over the OCR values; scanned for injection like the OCR text.
    edited: dict = Field(default_factory=dict)
    change_summary: dict = Field(default_factory=dict)
    # Provenance signals saved at upload (supporting_documents.shield["provenance"]).
    stored_signals: list[RiskSignal] = Field(default_factory=list)
    fingerprint: DocFingerprint | None = None
    # Image forensics result saved at upload (supporting_documents.shield["forensics"]).
    forensics: dict | None = None


def _strings(value: Any) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        return [s for v in value.values() for s in _strings(v)]
    if isinstance(value, (list, tuple)):
        return [s for v in value for s in _strings(v)]
    return []


def receipt_text(doc: ShieldDoc) -> str:
    """Every string the OCR returned (visible_text included) plus the employee's edits."""
    return "\n".join(_strings(doc.extracted) + _strings(doc.edited))


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or value is None:
        return None
    if isinstance(value, str):
        value = _NOT_A_NUMBER.sub("", value.replace(",", ""))
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _line_amounts(extracted: dict) -> list[float]:
    items = extracted.get("line_items")
    if not isinstance(items, list):
        return []
    amounts = [_number(i.get("amount")) for i in items if isinstance(i, dict)]
    return [a for a in amounts if a is not None]


def _hr_detail(signals: list[RiskSignal]) -> str:
    return " ".join(s.message for s in signals)


def _finish(emit: Emit, step: str, signals: list[RiskSignal], clean_detail: str, warn_detail: str | None = None) -> None:
    if signals:
        emit(make_step(step, "warn", warn_detail or _hr_detail(signals)))
    else:
        emit(make_step(step, "done", clean_detail))


def _injection(docs: list[ShieldDoc]) -> tuple[list[RiskSignal], str | None]:
    found = [s for d in docs if (s := scan_text(receipt_text(d), d.document_id))]
    if not found:
        return [], None
    snippet = found[0].evidence.get("matches", [""])[0]
    return found, f"Hidden instructions found: {snippet}"


def _duplicates(docs: list[ShieldDoc], candidates: list[DocFingerprint]) -> list[RiskSignal]:
    # The claim's own documents join the pool so a receipt attached twice is caught;
    # find_duplicates skips a document's match against itself.
    own = [d.fingerprint for d in docs if d.fingerprint]
    own_ids = {f.document_id for f in own}
    pool = [c for c in candidates if c.document_id not in own_ids] + own
    return [s for f in own if (s := find_duplicates(f, pool))]


def _duplicate_detail(candidates: list[DocFingerprint], docs: list[ShieldDoc]) -> str:
    own_ids = {d.document_id for d in docs}
    n = sum(1 for c in candidates if c.document_id not in own_ids)
    if n == 0:
        return "No earlier receipts to compare"
    return f"No match across {n:,} receipt{'s' if n != 1 else ''}"


def _provenance(docs: list[ShieldDoc], forensics_mode: str) -> list[RiskSignal]:
    signals: list[RiskSignal] = []
    for d in docs:
        signals += [s.model_copy(deep=True) for s in d.stored_signals]
        # Only `score` lets image forensics into the decision; `observe` findings go through observed_signals().
        if forensics_mode == "score" and (found := forensics_signal(d.forensics, d.document_id, "score")):
            signals.append(found)
        anomaly = signal_from_visual_anomaly(d.extracted, d.document_id)
        if anomaly:
            signals.append(anomaly)
        signals += signals_from_human_edit(d.change_summary, d.document_id)
    return signals


def _arithmetic(docs: list[ShieldDoc]) -> tuple[list[RiskSignal], bool]:
    signals, checked = [], False
    for d in docs:
        lines = _line_amounts(d.extracted)
        total = _number(d.extracted.get("total_amount"))
        if not lines or total is None:
            continue
        checked = True
        s = check_totals(
            lines, _number(d.extracted.get("tax_amount")), _number(d.extracted.get("service_charge")),
            total, d.document_id,
        )
        if s:
            signals.append(s)
    return signals, checked


def _gaming(claim: ClaimLite, recent: list[ClaimLite], auto_limit: float) -> list[RiskSignal]:
    others = [c for c in recent if c.reim_id != claim.reim_id]
    found = [
        detect_split(claim, others, auto_limit),
        detect_near_threshold(claim.amount, auto_limit, [c.amount for c in others]),
    ]
    return [s for s in found if s]


def _priced_lines(doc: ShieldDoc, check: PriceCheck) -> list[tuple[str, float]]:
    """(description, unit price) for the doc's lines worth looking up, dearest first."""
    categories = {str(d.get("category", "")).strip().lower() for d in (doc.extracted, doc.edited)}
    # FX_TO_USD converts one currency, so a receipt in another would compare wrong amounts.
    currency = str(doc.extracted.get("currency") or "").strip().upper()
    if not categories & check.categories or (_CURRENCY_CODE.fullmatch(currency) and currency != check.currency.upper()):
        return []
    items = doc.extracted.get("line_items")
    lines = []
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            continue
        description = str(item.get("description") or "").strip()
        amount = _number(item.get("amount"))
        quantity = _number(item.get("quantity")) or 1.0
        if len(description) >= _MIN_QUERY_CHARS and amount and amount > 0 and quantity > 0:
            lines.append((description, amount / quantity))
    return sorted(lines, key=lambda line: line[1], reverse=True)


def _market_prices(docs: list[ShieldDoc], check: PriceCheck) -> tuple[list[RiskSignal], str]:
    """Never raises: an unavailable price service only means this claim goes without the signal."""
    signals: list[RiskSignal] = []
    lookups = 0
    for doc in docs:
        found = []
        for description, unit_price in _priced_lines(doc, check):
            if lookups == _MAX_PRICE_LOOKUPS:
                break
            lookups += 1
            try:
                signal = check_market_price(description, unit_price, check.fx_to_usd, check.search,
                                            doc.document_id, check.currency)
            except Exception as exc:
                logger.warning("[MARKET_PRICE] Channel3 lookup failed: %s", type(exc).__name__)
                return signals, "Price lookup unavailable"
            if signal:
                found.append(signal)
        # One signal per receipt, the largest overage: each extra line would otherwise add to the risk score.
        if found:
            signals.append(max(found, key=lambda s: s.evidence["claimed_usd"] - s.evidence["median_usd"]))
    return signals, "In line with market prices"


def run_shield(
    docs: list[ShieldDoc],
    claim: ClaimLite,
    recent: list[ClaimLite],
    candidates: list[DocFingerprint],
    auto_limit: float,
    emit: Emit,
    price_check: PriceCheck | None = None,
    forensics_mode: str = "observe",
) -> list[RiskSignal]:
    """A check that raises emits `fail` and re-raises, so the claim falls back to manual review.

    The market-price step is the exception: it only runs with a `price_check` on receipts it applies to, and can't fail.
    """
    out: list[RiskSignal] = []

    def run(step: str, check: Callable[[], None]) -> None:
        emit(make_step(step, "running"))
        try:
            check()
        except Exception:
            emit(make_step(step, "fail", "This check could not run."))
            raise

    def injection() -> None:
        signals, detail = _injection(docs)
        out.extend(signals)
        _finish(emit, "shield.injection", signals, "None found", detail)

    def duplicate() -> None:
        signals = _duplicates(docs, candidates)
        out.extend(signals)
        _finish(emit, "shield.duplicate", signals, _duplicate_detail(candidates, docs))

    def provenance() -> None:
        signals = _provenance(docs, forensics_mode)
        out.extend(signals)
        _finish(emit, "shield.provenance", signals, "No editing or AI traces found")

    def arithmetic() -> None:
        signals, checked = _arithmetic(docs)
        out.extend(signals)
        _finish(emit, "shield.arithmetic", signals, "Items + tax = total" if checked else "No line items to add up")

    def split() -> None:
        signals = _gaming(claim, recent, auto_limit)
        out.extend(signals)
        _finish(emit, "shield.split", signals, "No related claims")

    def price() -> None:
        signals, detail = _market_prices(docs, price_check)
        out.extend(signals)
        _finish(emit, "shield.price", signals, detail)

    run("shield.injection", injection)
    run("shield.duplicate", duplicate)
    run("shield.provenance", provenance)
    run("shield.arithmetic", arithmetic)
    run("shield.split", split)
    if price_check and any(_priced_lines(d, price_check) for d in docs):
        run("shield.price", price)
    return out


def observed_signals(docs: list[ShieldDoc], forensics_mode: str) -> list[RiskSignal]:
    """Observe-mode image forensics findings: 0 points, for HR's evidence only. Never pass these to decide()."""
    if forensics_mode != "observe":
        return []
    return [s for d in docs if (s := forensics_signal(d.forensics, d.document_id, "observe"))]


def split_related(signals: list[RiskSignal]) -> list[str]:
    """Claim ids a SPLIT_CLAIM signal links to this one."""
    return [rid for s in signals if s.code == SignalCode.SPLIT_CLAIM for rid in s.evidence.get("related", [])]
