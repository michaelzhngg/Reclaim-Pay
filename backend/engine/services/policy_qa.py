"""Free-text policy questions (F1). An answer must quote the policy word for word, or it becomes "ask HR"."""
import logging
import math
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from decimal import InvalidOperation

from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import PromptTemplate
from pydantic import BaseModel
from sqlmodel import Session, func, select

from core.models import Policy, PolicyQuestion, PolicySection, User
from engine.llm import get_chat_llm
from engine.policy.limits import (
    LimitKind, LimitRule, LimitUnit, SpendCheck, TravelScope, Verdict, ZonePlace, check_spend, money, same_category,
)
from engine.prompts.policy_qa_prompts import POLICY_QA_PROMPT
from engine.prompts.untrusted import QUESTION_RULE, wrap_question
from engine.services import policy_limits_store as store
from engine.tools.rag_tool import find_policy_sections

logger = logging.getLogger(__name__)

DAILY_QUESTION_LIMIT = 20
MIN_QUESTION_CHARS = 5
MAX_QUESTION_CHARS = 500
MIN_QUOTE_CHARS = 12
# A quote may join up to this many in-order pieces of one section, e.g. a list heading and its third item.
MAX_QUOTE_PIECES = 3
MIN_PIECE_CHARS = 20
# Short cells joined with " … " are real evidence when they all sit in one table row ("MYR 240 … Grade 6").
MAX_ROW_PIECES = 6
MIN_CELL_CHARS = 2
MAX_SECTIONS = 6
NOT_COVERED_ANSWER = "I couldn't find one part of the policy that answers this. Try asking one thing at a time, or ask HR before you spend."

_UNIT_WORDS = {
    LimitUnit.PER_DAY: "a day", LimitUnit.PER_NIGHT: "a night", LimitUnit.PER_MEAL: "a meal", LimitUnit.PER_ITEM: "an item",
}
_NUMBER = re.compile(r"\d[\d,]*(?:\.\d+)?")


class QuestionError(Exception):
    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


class QaAnswer(BaseModel):
    covered: bool
    answer: str
    quote: str | None = None
    policy_title: str | None = None


class SectionCount(BaseModel):
    policy_title: str
    section: str
    excerpt: str
    count: int


class OpenQuestion(BaseModel):
    asked_on: date  # a day, not a time, so HR can't line a question up with one person's activity
    question: str


class QuestionSummary(BaseModel):
    days: int
    total: int
    unanswered: int
    top_sections: list[SectionCount]
    recent_unanswered: list[OpenQuestion]


def _plain(s: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"[*_`|#>]", " ", s or "")).strip()


def squash(s: str) -> str:
    """Lowercase, drop markdown marks and collapse whitespace, so a quote matches however the section is formatted."""
    return _plain(s).casefold()


_ELLIPSIS = re.compile(r"\s*(?:…|\.\.\.)\s*")


def _quote_pieces(quote: str, content: str) -> list[str] | None:
    """The quote as in-order pieces of the section text, each copied word for word, or None."""
    hay = _plain(content).lower()
    pieces, pos = [], 0
    for part in _ELLIPSIS.split(quote):
        rest = part.strip()
        while rest:
            low = rest.lower()
            size = len(low)
            while size >= MIN_PIECE_CHARS and low[:size] not in hay[pos:]:
                size -= 1
            if size < MIN_PIECE_CHARS or low[:size] not in hay[pos:]:
                return None
            pos = hay.index(low[:size], pos) + size
            pieces.append(rest[:size].strip())
            if len(pieces) > MAX_QUOTE_PIECES:
                return None
            rest = rest[size:].strip()
    return pieces or None


def match_quote(quote: str | None, sections: list) -> tuple[object, str] | None:
    """(section, quote to show) when the quote is copied from one section. Skipped lines show as " … "."""
    q = _plain(quote or "")
    if len(q) < MIN_QUOTE_CHARS or len(q.lower()) != len(q):
        return None
    for s in sections:
        if q.casefold() in squash(s.content):
            return s, q
    for s in sections:
        pieces = _quote_pieces(q, s.content or "")
        if pieces and all(len(p) >= MIN_PIECE_CHARS for p in pieces):
            return s, " … ".join(pieces)
    cells = [c.strip() for c in _ELLIPSIS.split(q) if c.strip()]
    if not 2 <= len(cells) <= MAX_ROW_PIECES or any(len(c) < MIN_CELL_CHARS for c in cells):
        return None
    for s in sections:
        for row in (line for line in (s.content or "").splitlines() if line.count("|") >= 2):
            plain_row = _plain(row).lower()
            if all(c.lower() in plain_row for c in cells):
                return s, " … ".join(cells)
    return None


def quote_section(quote: str | None, sections: list) -> object | None:
    found = match_quote(quote, sections)
    return found[0] if found else None


def _amount(raw: str) -> float | None:
    """One matched number as a value, or None when it is too large to compare."""
    try:
        value = float(raw.replace(",", ""))
        return money(value) if math.isfinite(value) else None
    except (ValueError, OverflowError, InvalidOperation):
        return None


def _amounts(text: str) -> tuple[set[float], bool]:
    """Every number in the text as a value, so "RM 1,200.00", "RM1200" and "1200" compare equal.
    The flag is False when some number could not be read."""
    found = [_amount(n) for n in _NUMBER.findall(text or "")]
    return {v for v in found if v is not None}, None not in found


def numbers_supported(answer: str, sources: str) -> bool:
    """True when every number in the answer also appears in the sources. Catches invented or computed amounts."""
    wanted, readable = _amounts(answer)
    return readable and wanted <= _amounts(sources)[0]


def _limit_words(rule: LimitRule) -> str:
    if rule.unit == LimitUnit.ACTUAL:
        return "Actual cost"
    prefix = "Approval needed above" if rule.kind == LimitKind.PRE_APPROVAL else "Up to"
    return f"{prefix} {rule.currency} {rule.amount:,.2f} {_UNIT_WORDS[rule.unit]}"


def _check_words(c: SpendCheck) -> str:
    if c.verdict == Verdict.NEED_DESTINATION:
        return "depends on the destination"
    if c.verdict == Verdict.GRADE_NOT_LISTED:
        return "this grade is not listed"
    return "; ".join(_limit_words(r) for r in (c.cap, c.pre_approval) if r is not None) or "no amount set"


def limits_summary(rules: list[LimitRule], places: list[ZonePlace], grade: int | None) -> str:
    """This employee's own confirmed limits, one line per category (and per trip scope where the policy splits it)."""
    lines: list[str] = []
    seen: list[str] = []
    for r in rules:
        if any(same_category(r.category, s) for s in seen):
            continue
        seen.append(r.category)
        split = any(x.scope != TravelScope.ANY for x in rules if same_category(x.category, r.category))
        for label, overseas in ((", domestic", False), (", overseas", True)) if split else (("", False),):
            c = check_spend(rules, places, category=r.category, grade=grade, overseas=overseas,
                            destination=None, amount=None)
            lines.append(f"- {r.category}{label}: {_check_words(c)}")
    return "\n".join(lines) or "- none confirmed"


def run_qa_llm(question: str, sections: list, grade: int | None, limits: str) -> dict:
    chain = PromptTemplate.from_template(POLICY_QA_PROMPT) | get_chat_llm() | JsonOutputParser()
    body = "\n\n".join(f"[Section {i}]\n{s.content[:1500]}" for i, s in enumerate(sections, 1))
    return chain.invoke({"rule": QUESTION_RULE, "grade": str(grade) if grade is not None else "not set",
                         "limits": limits, "sections": body, "question": wrap_question(question)})


def _verified(raw: object, question: str, sections: list, limits: str, grade: int | None = None) -> tuple[str, str, object] | None:
    """(answer, quote, section) when the model's answer survives every check, else None."""
    if not isinstance(raw, dict) or raw.get("covered") is not True:
        return None
    answer = str(raw.get("answer") or "").strip()[:600]
    quote = raw.get("quote") if isinstance(raw.get("quote"), str) else None
    found = match_quote(quote, sections)
    if not answer or found is None:
        return None
    section, quote = found
    if not numbers_supported(answer, "\n".join([question, limits, quote, str(grade or "")])):
        return None
    return answer, quote.strip(), section


def answer_question(db: Session, user: User, question: str, now: datetime) -> QaAnswer:
    q = (question or "").strip()
    if not MIN_QUESTION_CHARS <= len(q) <= MAX_QUESTION_CHARS:
        raise QuestionError("QUESTION_LENGTH")
    if q.count("?") > 1:  # one answer is backed by one quote, so several questions can't all be answered
        raise QuestionError("ONE_QUESTION")
    asked = db.exec(select(func.count()).select_from(PolicyQuestion).where(
        PolicyQuestion.user_id == user.user_id, PolicyQuestion.created_at >= now - timedelta(days=1))).one()
    if asked >= DAILY_QUESTION_LIMIT:
        raise QuestionError("DAILY_QUESTION_LIMIT")

    # Only the policies claims are judged against, so a superseded ACTIVE policy can't answer.
    policies = {p.policy_id: p for p in store.policy_for_category(db).values()}
    sections = find_policy_sections(list(policies), db, q, limit=MAX_SECTIONS)
    record = PolicyQuestion(user_id=user.user_id, question=q, created_at=now)
    result = QaAnswer(covered=False, answer=NOT_COVERED_ANSWER)

    if sections:
        rules, places = store.active_limits(db)
        limits = limits_summary(rules, places, user.rank)
        try:
            raw = run_qa_llm(q, sections, user.rank, limits)
        except Exception:
            logger.exception("[POLICY_QA] answer failed")
            db.add(record)  # answer stays None: counts toward the cap, kept out of HR's gaps
            db.commit()
            raise QuestionError("QA_UNAVAILABLE")
        verified = _verified(raw, q, sections, limits, user.rank)
        if verified is not None:
            answer, quote, section = verified
            result = QaAnswer(covered=True, answer=answer, quote=quote, policy_title=policies[section.policy_id].title)
            record.section_id, record.policy_id = section.section_id, section.policy_id

    record.answer, record.covered = result.answer, result.covered
    db.add(record)
    db.commit()
    return result


def _section_label(s: PolicySection) -> str:
    if s.section_title:
        return s.section_title
    heading = _plain((s.content or "").strip().split("\n", 1)[0])
    return heading if 0 < len(heading) <= 80 else f"Part {(s.section_order or 0) + 1}"


def _excerpt(s: PolicySection, label: str) -> str:
    text = _plain(s.content)
    return text[len(label):].strip() if text.startswith(label) else text  # don't repeat a heading used as the label


def _utc_day(moment: datetime) -> date:
    return (moment if moment.tzinfo else moment.replace(tzinfo=timezone.utc)).astimezone(timezone.utc).date()


def question_summary(db: Session, now: datetime, days: int = 30) -> QuestionSummary:
    rows = db.exec(select(PolicyQuestion).where(PolicyQuestion.created_at >= now - timedelta(days=days))
                   .order_by(PolicyQuestion.created_at.desc())).all()
    rows = [r for r in rows if r.answer is not None]  # a failed model call was not a question HR can act on
    gaps = [r for r in rows if not r.covered]
    counts = Counter(r.section_id for r in rows if r.covered and r.section_id)
    top: list[SectionCount] = []
    for section_id, n in counts.most_common(5):
        s = db.get(PolicySection, section_id)
        if s is None:
            continue
        p = db.get(Policy, s.policy_id)
        label = _section_label(s)
        top.append(SectionCount(policy_title=p.title if p else "Policy", section=label,
                                excerpt=_excerpt(s, label)[:160],
                                count=n))
    return QuestionSummary(
        days=days, total=len(rows), unanswered=len(gaps), top_sections=top,
        recent_unanswered=[OpenQuestion(asked_on=_utc_day(r.created_at), question=r.question) for r in gaps[:10]],
    )
