"""Month-end report for finance (F12).

Every number is computed here from the database, with no model involved. Each number also names the
claims behind it (`claim_rows`), and the number is computed from those same rows, so a link from the
report to the claim list always adds up. A model only writes the sentences around the numbers, and
any sentence with a number that is not in the metrics is thrown away (see `write_narrative`).

Months follow Malaysia time (Asia/Kuala_Lumpur), the way finance closes its books. Only claims in the
report currency are counted; claims in other currencies are counted separately so the page can say so.
Vendor bookings are left out: this report is about employee reimbursements.
"""
import logging
import re
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from urllib.parse import urlencode
from uuid import UUID
from zoneinfo import ZoneInfo

from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import PromptTemplate
from sqlalchemy import func
from sqlmodel import Session, select

from core.enums import PayoutStatus, RecoveryStatus, ReimbursementStatus
from core.models import Department, Payout, Recovery, Reimbursement, User
from engine.prompts.untrusted import DATA_RULE, wrap_json
from engine.services.policy_qa import numbers_supported

logger = logging.getLogger(__name__)

REPORT_TZ = ZoneInfo("Asia/Kuala_Lumpur")
REPORT_TZ_NAME = "Malaysia time (UTC+8)"
CURRENCY = "MYR"
NO_TEAM = "No team"
TOP_BREACHES = 5

# Final decisions. PENDING, REVIEW and APPEALED claims are still open.
DECIDED = (
    ReimbursementStatus.APPROVED,
    ReimbursementStatus.DISBURSING,
    ReimbursementStatus.PAID,
    ReimbursementStatus.DISBURSEMENT_FAILED,
    ReimbursementStatus.REJECTED,
)
RECOVERED = (RecoveryStatus.RECOVERED, RecoveryStatus.OFFSET)

METRICS = ("reimbursed", "auto_paid", "decided", "fakes_caught", "recovered", "breach")

_MONTH = re.compile(r"^(\d{4})-(0[1-9]|1[0-2])$")


class ReportError(ValueError):
    """A month that can't be reported on (bad format, or in the future)."""


# ─── Months ──────────────────────────────────────────────────────────────────

def parse_month(month: str) -> tuple[int, int]:
    m = _MONTH.match(month or "")
    if not m:
        raise ReportError("Month must look like 2026-10.")
    return int(m.group(1)), int(m.group(2))


def month_window(month: str) -> tuple[datetime, datetime]:
    """[start, end) of the month in Malaysia time, as UTC datetimes."""
    year, mon = parse_month(month)
    start = datetime(year, mon, 1, tzinfo=REPORT_TZ)
    end = datetime(year + (mon == 12), mon % 12 + 1, 1, tzinfo=REPORT_TZ)
    return start.astimezone(timezone.utc), end.astimezone(timezone.utc)


def month_label(month: str) -> str:
    year, mon = parse_month(month)
    return datetime(year, mon, 1).strftime("%B %Y")


def current_month(now: datetime) -> str:
    return now.astimezone(REPORT_TZ).strftime("%Y-%m")


def previous_month(now: datetime) -> str:
    local = now.astimezone(REPORT_TZ)
    year, mon = (local.year - 1, 12) if local.month == 1 else (local.year, local.month - 1)
    return f"{year}-{mon:02d}"


def check_reportable(month: str, now: datetime) -> bool:
    """True when the month has ended. Raises for a future month."""
    parse_month(month)
    current = current_month(now)
    if month > current:
        raise ReportError("That month hasn't started yet.")
    return month < current


# ─── Rows behind the numbers ─────────────────────────────────────────────────

@dataclass(frozen=True)
class Row:
    reim_id: UUID
    amount: float          # what this row adds to the metric's money value
    category: str
    team: str
    tier: str | None
    codes: frozenset[str]  # hard stops and signal codes, once each


def _amount(value: Any) -> float:
    return round(float(value or 0), 2)


def _codes(autonomy: dict | None) -> frozenset[str]:
    autonomy = autonomy or {}
    stops = [str(s) for s in autonomy.get("hard_stops") or []]
    signals = [str(s.get("code")) for s in autonomy.get("signals") or [] if isinstance(s, dict) and s.get("code")]
    return frozenset(stops + signals)


def _has_high_signal(autonomy: dict | None) -> bool:
    return any(isinstance(s, dict) and s.get("severity") == "HIGH" for s in (autonomy or {}).get("signals") or [])


def _team_names(db: Session) -> dict[UUID, str]:
    return {d.department_id: d.name for d in db.exec(select(Department)).all()}


def _paid_rows(db: Session, start: datetime, end: datetime, teams: dict[UUID, str]) -> list[Row]:
    """Claims that reached PAID in the month. Paid time is the latest succeeded payout's update,
    or the claim's own update when it has no payout record."""
    paid_at = (
        select(Payout.reim_id, func.max(Payout.updated_at).label("paid_at"))
        .where(Payout.status == PayoutStatus.SUCCEEDED)
        .group_by(Payout.reim_id)
        .subquery()
    )
    when = func.coalesce(paid_at.c.paid_at, Reimbursement.updated_at)
    stmt = (
        select(Reimbursement, User.department_id)
        .join(User, User.user_id == Reimbursement.user_id)
        .outerjoin(paid_at, paid_at.c.reim_id == Reimbursement.reim_id)
        .where(Reimbursement.kind == "CLAIM", Reimbursement.currency == CURRENCY,
               Reimbursement.status == ReimbursementStatus.PAID, when >= start, when < end)
    )
    return [_row(r, dept, teams, r.total_approved_amount) for r, dept in db.exec(stmt).all()]


def _decided_claims(db: Session, start: datetime, end: datetime):
    """Claims decided in the month: by HR (reviewed_at) or by the agent at submission (created_at)."""
    when = func.coalesce(Reimbursement.reviewed_at, Reimbursement.created_at)
    return (
        select(Reimbursement, User.department_id)
        .join(User, User.user_id == Reimbursement.user_id)
        .where(Reimbursement.kind == "CLAIM", Reimbursement.currency == CURRENCY,
               Reimbursement.status.in_(DECIDED), when >= start, when < end)
    )


def _row(r: Reimbursement, dept: UUID | None, teams: dict[UUID, str], amount: Any) -> Row:
    return Row(
        reim_id=r.reim_id,
        amount=_amount(amount),
        category=r.main_category or "Uncategorised",
        team=teams.get(dept, NO_TEAM) if dept else NO_TEAM,
        tier=r.tier,
        codes=_codes(r.autonomy),
    )


def _decided_rows(db: Session, start: datetime, end: datetime, teams: dict[UUID, str]) -> list[Row]:
    return [_row(r, dept, teams, r.total_approved_amount) for r, dept in db.exec(_decided_claims(db, start, end)).all()]


def _fake_rows(db: Session, start: datetime, end: datetime, teams: dict[UUID, str]) -> list[Row]:
    """Decided in the month, and either rejected with a HIGH-severity signal or with a recovery opened."""
    pairs = db.exec(_decided_claims(db, start, end)).all()
    ids = [r.reim_id for r, _ in pairs]
    with_recovery = set(db.exec(select(Recovery.reim_id).where(Recovery.reim_id.in_(ids))).all()) if ids else set()
    return [
        _row(r, dept, teams, r.total_claimed_amount)
        for r, dept in pairs
        if (r.status == ReimbursementStatus.REJECTED and _has_high_signal(r.autonomy)) or r.reim_id in with_recovery
    ]


def _recovered_rows(db: Session, start: datetime, end: datetime, teams: dict[UUID, str]) -> list[Row]:
    """Recoveries that reached RECOVERED or OFFSET in the month. The amount is what was recovered."""
    stmt = (
        select(Recovery, Reimbursement, User.department_id)
        .join(Reimbursement, Reimbursement.reim_id == Recovery.reim_id)
        .join(User, User.user_id == Reimbursement.user_id)
        .where(Recovery.status.in_(RECOVERED), Recovery.currency == CURRENCY,
               Recovery.updated_at >= start, Recovery.updated_at < end)
    )
    return [_row(r, dept, teams, rec.amount) for rec, r, dept in db.exec(stmt).all()]


def claim_rows(db: Session, month: str, metric: str, *, category: str | None = None,
               team: str | None = None, code: str | None = None) -> list[Row]:
    """The rows behind one number on the report. The report's numbers are computed from these."""
    if metric not in METRICS:
        raise ReportError(f"Unknown metric: {metric}")
    start, end = month_window(month)
    teams = _team_names(db)
    if metric == "reimbursed":
        rows = _paid_rows(db, start, end, teams)
    elif metric == "fakes_caught":
        rows = _fake_rows(db, start, end, teams)
    elif metric == "recovered":
        rows = _recovered_rows(db, start, end, teams)
    else:
        rows = _decided_rows(db, start, end, teams)
        if metric == "auto_paid":
            rows = [r for r in rows if r.tier == "AUTO_PAY"]
        elif metric == "breach":
            rows = [r for r in rows if code and code in r.codes]
    if category is not None:
        rows = [r for r in rows if r.category == category]
    if team is not None:
        rows = [r for r in rows if r.team == team]
    return rows


def total(rows: list[Row]) -> float:
    return round(sum(r.amount for r in rows), 2)


# ─── Metrics ─────────────────────────────────────────────────────────────────

def link(month: str, metric: str, **filters: str) -> str:
    """Where the claims behind a number are listed."""
    return "/hr/history?" + urlencode({"report": month, "metric": metric, **filters})


def _grouped(month: str, rows: list[Row], key: str) -> list[dict]:
    groups: dict[str, list[Row]] = {}
    for r in rows:
        groups.setdefault(getattr(r, key), []).append(r)
    out = [
        {"key": k, "value": total(g), "count": len(g), "link": link(month, "reimbursed", **{key: k})}
        for k, g in groups.items()
    ]
    return sorted(out, key=lambda g: (-g["value"], g["key"]))


def _other_currency_count(db: Session, start: datetime, end: datetime) -> int:
    when = func.coalesce(Reimbursement.reviewed_at, Reimbursement.created_at)
    stmt = select(func.count()).select_from(Reimbursement).where(
        Reimbursement.kind == "CLAIM", Reimbursement.currency != CURRENCY,
        Reimbursement.status.in_(DECIDED), when >= start, when < end,
    )
    return int(db.exec(stmt).one())


def compute_metrics(db: Session, month: str) -> dict:
    """Every number on the report, each with a link to its rows. Plain SQL, no model."""
    start, end = month_window(month)
    teams = _team_names(db)
    paid = _paid_rows(db, start, end, teams)
    decided = _decided_rows(db, start, end, teams)
    auto = [r for r in decided if r.tier == "AUTO_PAY"]
    fakes = _fake_rows(db, start, end, teams)
    recovered = _recovered_rows(db, start, end, teams)

    codes = Counter(code for r in decided for code in r.codes)
    breaches = [
        {"code": code, "count": n, "link": link(month, "breach", code=code)}
        for code, n in sorted(codes.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_BREACHES]
    ]

    return {
        "month": month,
        "label": month_label(month),
        "timezone": REPORT_TZ_NAME,
        "currency": CURRENCY,
        "reimbursed": {"value": total(paid), "count": len(paid), "link": link(month, "reimbursed")},
        "by_category": _grouped(month, paid, "category"),
        "by_team": _grouped(month, paid, "team"),
        "auto_pay": {
            "auto": len(auto),
            "decided": len(decided),
            "rate": round(100 * len(auto) / len(decided), 1) if decided else None,
            "link": link(month, "auto_paid"),
            "decided_link": link(month, "decided"),
        },
        "fakes_caught": {"count": len(fakes), "value": total(fakes), "link": link(month, "fakes_caught")},
        "recovered": {"value": total(recovered), "count": len(recovered), "link": link(month, "recovered")},
        "breaches": breaches,
        "other_currency_claims": _other_currency_count(db, start, end),
    }


# ─── Narrative ───────────────────────────────────────────────────────────────

def _money(v: float) -> str:
    return f"{CURRENCY} {v:,.2f}"


def template_narrative(m: dict) -> str:
    """One plain sentence per metric. Used when the model is unavailable or its text fails the check."""
    a = m["auto_pay"]
    parts = [f"In {m['label']}, {_money(m['reimbursed']['value'])} was reimbursed across {m['reimbursed']['count']} paid claims."]
    if m["by_category"]:
        top = m["by_category"][0]
        parts.append(f"The largest category was {top['key']} at {_money(top['value'])}.")
    if a["rate"] is not None:
        parts.append(f"{a['auto']} of {a['decided']} decided claims were paid automatically ({a['rate']}%).")
    parts.append(f"{m['fakes_caught']['count']} suspicious claims were caught, and {_money(m['recovered']['value'])} was recovered.")
    if m["breaches"]:
        b = m["breaches"][0]
        parts.append(f"The most frequent flag was {b['code']} on {b['count']} claims.")
    return " ".join(parts)


def _sources(m: dict) -> str:
    """Every number the narrative may use: the metrics, plus whole-number and one-decimal roundings."""
    values: list[float] = [TOP_BREACHES]
    a = m["auto_pay"]
    values += [m["reimbursed"]["value"], m["reimbursed"]["count"], a["auto"], a["decided"],
               m["fakes_caught"]["count"], m["fakes_caught"]["value"], m["recovered"]["value"], m["recovered"]["count"]]
    if a["rate"] is not None:
        values.append(a["rate"])
    for g in m["by_category"] + m["by_team"]:
        values += [g["value"], g["count"]]
    values += [b["count"] for b in m["breaches"]]
    out = []
    for v in values:
        out += [f"{v}", f"{v:.2f}", f"{round(v)}", f"{round(v, 1)}"]
    return " ".join(out) + " " + m["label"] + " " + m["month"]


NARRATIVE_PROMPT = """You write the summary at the top of a company's month-end expense report for finance.

{rule}

Write 4 to 6 short sentences in plain English about the metrics below. Use only numbers that appear in
the metrics, written as they appear there (amounts as "MYR 1,234.50", the auto-pay rate with a % sign).
Do not add, subtract or compute new numbers. Do not give advice. Codes such as HIGH_RISK_SIGNAL may be
quoted as they are.

Metrics:
{metrics}

Reply with JSON only: {{"summary": "<your sentences>"}}"""


def run_narrative_llm(metrics: dict) -> dict:
    from engine.llm import get_chat_llm

    chain = PromptTemplate.from_template(NARRATIVE_PROMPT) | get_chat_llm() | JsonOutputParser()
    return chain.invoke({"rule": DATA_RULE.replace("from a receipt an employee uploaded", "from the expense database"),
                         "metrics": wrap_json(metrics)})


def checked_narrative(raw: object, metrics: dict) -> str | None:
    """The model's summary when every number in it is in the metrics, else None."""
    if not isinstance(raw, dict):
        return None
    text = str(raw.get("summary") or "").strip()[:1500]
    if not text or not numbers_supported(text, _sources(metrics)):
        return None
    return text


def write_narrative(metrics: dict, llm=None) -> tuple[str, str]:
    """(text, source). source is "model" when the model's text passed the number check, else "template"."""
    try:
        text = checked_narrative((llm or run_narrative_llm)(metrics), metrics)
    except Exception:  # model down, quota, bad JSON: the template still tells the story
        logger.warning("[MONTH_REPORT] narrative model failed", exc_info=True)
        text = None
    return (text, "model") if text else (template_narrative(metrics), "template")
