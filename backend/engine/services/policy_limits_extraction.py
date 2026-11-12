"""Suggest policy limits from the stored policy text. One LLM call per policy. HR confirms the result."""
import json
import logging
import re
from uuid import UUID

from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import PromptTemplate
from pydantic import BaseModel, ValidationError
from sqlmodel import Session, select

from core.models import PolicyReimbursableCategory, PolicySection
from engine.llm import get_chat_llm
from engine.policy.limits import LimitRule, ZonePlace, same_category
from engine.prompts.policy_prompts import POLICY_LIMITS_PROMPT
from engine.services import policy_limits_store as store
from engine.services.policy_qa import squash

logger = logging.getLogger(__name__)

MAX_POLICY_CHARS = 60_000
_DELIMITER = re.compile(r"<\s*/?\s*policy_text[^>]*>", re.IGNORECASE)


class ExtractionResult(BaseModel):
    proposed: int
    zone_places: int
    dropped: int


def _clip(value, limit: int) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text[:limit] or None


def _zone(value) -> str | None:
    # Models often answer zone 1 as a number; an empty zone means "no zone".
    if value is None or isinstance(value, bool):
        return None
    return str(value).strip() or None


def parse_extraction(raw, categories: list[str], text: str | None = None) -> tuple[list[LimitRule], list[ZonePlace], int]:
    """With the policy text, a quote it doesn't contain is dropped: HR reads it as the policy's own words."""
    if not isinstance(raw, dict):
        return [], [], 0
    items = raw.get("limits")
    rules: list[LimitRule] = []
    dropped = 0
    for item in items if isinstance(items, list) else []:
        if not isinstance(item, dict):
            dropped += 1
            continue
        canonical = next((c for c in categories if same_category(c, str(item.get("category", "")))), None)
        if canonical is None:
            dropped += 1
            continue
        quote = _clip(item.get("source_quote"), 400)
        if quote and text is not None and squash(quote) not in squash(text):
            quote = None
        fields = {
            **item, "category": canonical, "zone": _zone(item.get("zone")),
            "source_section": _clip(item.get("source_section"), 200),
            "source_quote": quote,
        }
        try:
            rules.append(LimitRule.model_validate(fields))
        except ValidationError:
            dropped += 1
    zones = raw.get("zones")
    places: list[ZonePlace] = []
    for z in zones if isinstance(zones, list) else []:
        if not isinstance(z, dict) or _zone(z.get("zone")) is None or not isinstance(z.get("places"), list):
            continue
        for place in z["places"]:
            try:
                places.append(ZonePlace(zone=_zone(z["zone"]), place=str(place).strip()))
            except ValidationError:
                continue
    return rules, places, dropped


def run_extraction_llm(categories: list[str], text: str) -> dict:
    chain = PromptTemplate.from_template(POLICY_LIMITS_PROMPT) | get_chat_llm() | JsonOutputParser()
    body = _DELIMITER.sub("[tag removed]", text[:MAX_POLICY_CHARS])  # the text can't close its own block
    return chain.invoke({"categories": json.dumps(categories), "text": body})


def _policy_text(db: Session, policy_id: UUID) -> str:
    sections = db.exec(select(PolicySection).where(PolicySection.policy_id == policy_id)
                       .order_by(PolicySection.section_order)).all()
    return "\n\n".join(s.content for s in sections if s.content)


def extract_limits(db: Session, policy_id: UUID) -> ExtractionResult:
    """Raises if the LLM call fails. Commits the suggestions on success."""
    categories = list(db.exec(select(PolicyReimbursableCategory.category)
                              .where(PolicyReimbursableCategory.policy_id == policy_id)).all())
    text = _policy_text(db, policy_id)
    if not categories or not text.strip():
        return ExtractionResult(proposed=0, zone_places=0, dropped=0)
    rules, places, dropped = parse_extraction(run_extraction_llm(categories, text), categories, text)
    proposed = store.replace_proposed(db, policy_id, rules, places)
    db.commit()
    logger.info("[POLICY_LIMITS] policy=%s proposed=%d places=%d dropped=%d",
                policy_id, proposed, len(places), dropped)
    return ExtractionResult(proposed=proposed, zone_places=len(places), dropped=dropped)
