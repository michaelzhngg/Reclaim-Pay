"""
Compliance Workflow (Workflow 3) — Basket Evaluation
6-node LangGraph pipeline:
  load_context -> analyze_receipts -> receipt_shield -> aggregate_totals -> final_judgment -> save_reimbursement

Per-receipt ReAct agents run in parallel; final_judgment agent produces the overall verdict.
The verdict is one input to engine.risk.autonomy.decide(), which alone sets the tier.
"""
import json
import logging
import math
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timezone
from typing import Any, Callable, List, Optional
from uuid import UUID, uuid4
from decimal import Decimal

from langchain_core.messages import HumanMessage, SystemMessage
from langgraph.graph import END, START, StateGraph
from langgraph.prebuilt import create_react_agent
from sqlmodel import Session, select
from typing_extensions import TypedDict

from core.config import settings
from core.models import (
    Reimbursement, SupportingDocument, TravelSettlement, User, Policy,
    LineItem, ReimbursementSubCategory, SettlementCategory, SettlementReceipt,
    PolicySection,
)
from core.enums import AgentActionType, JudgmentResult, ReimbursementStatus, UserRole
from engine.llm import get_agent_llm
from engine.prompts.compliance_prompts import (
    COMPLIANCE_SYSTEM_PROMPT,
    FINAL_JUDGMENT_PROMPT,
    RECEIPT_ANALYSIS_PROMPT,
)
from engine.prompts.untrusted import wrap_json, wrap_text
from engine.risk import queries
from engine.risk.autonomy import breaker_should_trip, decide, limit_for, trust_tier
from engine.risk.shield.fingerprint import amount_and_date
from engine.risk.shield.market_price import channel3_search
from engine.risk.shield.run import PriceCheck, ShieldDoc, observed_signals, run_shield, split_related
from engine.risk.timeline import SENT_TO_HR, decision_copy, employee_safe, make_step
from engine.risk.types import (
    AutonomyDecision,
    AutonomyTier,
    ClaimFacts,
    ClaimLite,
    DocFingerprint,
    RiskSignal,
    Severity,
    TimelineStep,
)
from engine.services import autonomy_store
from engine.services import fx
from engine.services.action_log import record_action
from engine.tools.change_detector import detect_changes
from engine.tools.compliance_tools import get_disparance_date, make_search_policy_rag_tool

logger = logging.getLogger(__name__)


# -- Graph State ---------------------------------------------------------------

class ComplianceWorkflowState(TypedDict):
    # Inputs
    settlement_id: str
    policy_id: Optional[str]
    main_category: str
    user_id: str
    all_category: List[str]
    document_ids: Optional[List[str]]
    # Generated before the shield runs, so the claim's own documents can be told apart from others.
    reim_id: str
    # Set for a contractor claim. The limit is already in company currency.
    contract_id: Optional[str]
    contract_max_company_amount: Optional[float]

    # Context loaded from DB
    user: Optional[Any]
    policy: Optional[Any]
    receipts: List[dict]
    combined_conditions: List[str]
    currency: str

    # Results
    line_items: List[dict]
    totals: dict
    judgment: str
    confidence: float
    summary: str
    signals: List[dict]
    reimbursement_id: str


Emit = Callable[[TimelineStep], None]


def _no_emit(step: TimelineStep) -> None:
    pass


# -- Helpers -------------------------------------------------------------------

def _extract_text_content(content: Any) -> str:
    """Extract string content from an AIMessage, handling both str and list types."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict) and item.get("type") == "text":
                parts.append(str(item.get("text", "")))
            elif isinstance(item, dict):
                parts.append(str(item))
        return "\n".join(parts)
    return str(content) if content else ""


def _extract_json(content: str) -> dict | None:
    """Try to extract a JSON object from text with brace-balanced parsing."""
    if not content:
        logger.warning("[JSON_EXTRACT] Empty content provided")
        return None

    # Remove markdown code blocks if present
    content_cleaned = content.strip()
    if content_cleaned.startswith("```json"):
        content_cleaned = content_cleaned[7:]
    elif content_cleaned.startswith("```"):
        content_cleaned = content_cleaned[3:]
    if content_cleaned.endswith("```"):
        content_cleaned = content_cleaned[:-3]
    content_cleaned = content_cleaned.strip()

    # Try direct parse first
    try:
        result = json.loads(content_cleaned)
        if isinstance(result, dict):
            logger.debug("[JSON_EXTRACT] Successfully parsed JSON directly")
            return result
    except json.JSONDecodeError as e:
        logger.debug("[JSON_EXTRACT] Direct JSON parse failed: %s", str(e))
    except Exception as e:
        logger.warning("[JSON_EXTRACT] Unexpected error during direct parse: %s", str(e))

    # Brace-balanced extraction for nested JSON objects
    depth = 0
    start = -1
    candidates: list[str] = []
    for i, ch in enumerate(content_cleaned):
        if ch == "{":
            if depth == 0:
                start = i
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0 and start >= 0:
                candidates.append(content_cleaned[start : i + 1])
                start = -1

    # Try candidates from outermost to innermost
    for idx, candidate in enumerate(reversed(candidates)):
        try:
            parsed = json.loads(candidate)
            if isinstance(parsed, dict):
                logger.debug("[JSON_EXTRACT] Successfully parsed candidate %d/%d", idx + 1, len(candidates))
                return parsed
        except json.JSONDecodeError as e:
            logger.debug("[JSON_EXTRACT] Candidate %d failed: %s", idx + 1, str(e))
        except Exception as e:
            logger.warning("[JSON_EXTRACT] Candidate %d unexpected error: %s", idx + 1, str(e))

    # All parsing failed - log for debugging
    logger.error(
        "[JSON_EXTRACT] All parsing attempts failed. Content preview (first 500 chars):\n%s",
        content[:500]
    )
    if len(content) > 500:
        logger.error("[JSON_EXTRACT] Content preview (last 200 chars):\n%s", content[-200:])
    return None


def _format_human_edit_block(human_edit) -> str:
    """Format _human_edit dict into a readable prompt block. Returns empty string if no changes."""
    if not isinstance(human_edit, dict):
        logger.warning("[HUMAN_EDIT] Expected dict but got %s: %r", type(human_edit).__name__, human_edit)
        return ""
    if not human_edit.get("has_changes"):
        return ""

    lines = [
        "--- Human Edit Information ---",
        f"Overall Risk: {human_edit.get('overall_risk', 'NONE')}",
        "Changed Fields:",
    ]
    for field, info in (human_edit.get("changes_by_field") or {}).items():
        if isinstance(info, dict):
            orig = info.get("original", "N/A")
            edited = info.get("edited", "N/A")
            severity = info.get("severity", "UNKNOWN")
        else:
            # editable_fields stores flat values, not nested change records
            orig = "N/A"
            edited = str(info) if info is not None else "N/A"
            severity = "UNKNOWN"
        lines.append(f"  - {field}: {orig!r} -> {edited!r}  [Severity: {severity}]")
    return "\n".join(lines)


def _parse_line_item(content: str, receipt: dict) -> dict:
    """Parse JSON from LLM response for a single receipt. Returns a fallback dict on failure."""
    doc_id = receipt.get("document_id", "unknown")
    parsed = _extract_json(content)

    if isinstance(parsed, dict):
        requested = float(parsed.get("requested_amount", 0) or 0)
        approved = float(parsed.get("approved_amount", 0) or 0)
        deducted = round(requested - approved, 2)
        parsed["deduction_amount"] = deducted
        logger.info(
            "[PARSE_LINE_ITEM] Successfully parsed receipt %s: status=%s requested=%s approved=%s",
            doc_id, parsed.get("status"), requested, approved
        )
        return parsed

    # Fallback — LLM response could not be parsed
    logger.error(
        "[PARSE_LINE_ITEM] Failed to parse receipt %s. Document ID: %s, Merchant: %s",
        doc_id,
        receipt.get("document_id"),
        receipt.get("merchant_name")
    )
    requested = float(receipt.get("total_amount", 0) or 0)
    fallback = {
        "document_id": receipt.get("document_id", "unknown"),
        "date": receipt.get("date", ""),
        "category": receipt.get("category", ""),
        "description": receipt.get("merchant_name", ""),
        "status": "MANUAL_REVIEW",
        "requested_amount": requested,
        "approved_amount": 0.0,
        "deduction_amount": requested,
        "audit_notes": [{"tag": "PARSE_ERROR", "message": "Could not parse compliance analysis. AI response was not valid JSON."}],
        "human_edit_risk": "NONE",
    }
    logger.warning("[PARSE_LINE_ITEM] Using MANUAL_REVIEW fallback for receipt %s", doc_id)
    return fallback


# -- Graph Nodes ---------------------------------------------------------------

def load_context(state: ComplianceWorkflowState, session: Session) -> dict:
    """Load user, policy, and TravelSettlement basket from the database."""
    logger.info("[LOAD_CONTEXT] Loading context for settlement=%s policy=%s user=%s", state.get("settlement_id"), state.get("policy_id"), state.get("user_id"))
    user = session.get(User, UUID(state["user_id"]))
    policy = session.get(Policy, UUID(state["policy_id"])) if state.get("policy_id") else None

    # Parse mandatory conditions dict
    try:
        conditions_dict = (
            json.loads(policy.mandatory_conditions)
            if policy and policy.mandatory_conditions
            else {}
        )
    except (json.JSONDecodeError, TypeError):
        conditions_dict = {}

    # Resolve all_category from settlement if not already set
    all_category = state.get("all_category") or []
    receipts: List[dict] = []
    currency = ""

    if state.get("settlement_id"):
        try:
            settlement = session.get(TravelSettlement, UUID(state["settlement_id"]))
            if settlement:
                logger.info("[LOAD_CONTEXT] Found settlement, fetching categories and receipts")
                if not all_category:
                    # Fetch from normalized table
                    cats = session.exec(
                        select(SettlementCategory).where(
                            SettlementCategory.settlement_id == settlement.settlement_id
                        )
                    ).all()
                    all_category = [c.category for c in cats]

                # Fetch receipts from normalized table, filtered to this policy group
                receipt_query = select(SettlementReceipt).where(
                    SettlementReceipt.settlement_id == settlement.settlement_id
                )
                doc_id_filter = state.get("document_ids") or []
                if doc_id_filter:
                    receipt_query = receipt_query.where(
                        SettlementReceipt.document_id.in_([UUID(d) for d in doc_id_filter])
                    )
                s_receipts = session.exec(receipt_query).all()
                logger.info("[LOAD_CONTEXT] Found %d SettlementReceipts (filtered by %d doc_ids)", len(s_receipts), len(doc_id_filter))

                # Bulk-fetch all SupportingDocuments for this settlement in one query
                doc_ids = [sr.document_id for sr in s_receipts if sr.document_id]
                if doc_ids:
                    bulk_docs = session.exec(
                        select(SupportingDocument).where(
                            SupportingDocument.document_id.in_(doc_ids)
                        )
                    ).all()
                    doc_by_id = {d.document_id: d for d in bulk_docs}
                else:
                    doc_by_id = {}

                # Build receipt dicts from normalized rows
                receipts = []
                for sr in s_receipts:
                    # Skip receipts without a valid document_id - they can't be linked properly
                    if not sr.document_id:
                        logger.warning("[LOAD_CONTEXT] Skipping SettlementReceipt with no document_id: category=%s amount=%s", sr.category, sr.claimed_amount)
                        continue

                    receipt_dict = {
                        "document_id": str(sr.document_id),
                        "date": sr.receipt_date.isoformat() if sr.receipt_date else "",
                        "category": sr.category or "",
                        "merchant_name": sr.merchant_name or "",
                        "total_amount": float(sr.claimed_amount) if sr.claimed_amount else 0,
                        "currency": sr.currency or settlement.currency or "MYR",
                    }
                    if sr.document_id:
                        doc = doc_by_id.get(sr.document_id)
                        if doc:
                            receipt_dict["extracted_data"] = doc.extracted_data or {}
                    receipts.append(receipt_dict)
                    logger.info("[LOAD_CONTEXT] Receipt %s: category=%s amount=%s", receipt_dict.get("document_id"), receipt_dict.get("category"), receipt_dict.get("total_amount"))

                currency = settlement.currency or ""
        except Exception:
            logger.exception("[LOAD_CONTEXT] Error loading settlement data")
            raise

    # Enrich receipts with human edit context if any documents were edited
    if receipts and state.get("settlement_id"):
        docs = session.exec(
            select(SupportingDocument).where(
                SupportingDocument.settlement_id == UUID(state["settlement_id"])
            )
        ).all()
        doc_map = {str(d.document_id): d for d in docs}
        for receipt in receipts:
            doc_id = receipt.get("document_id")
            if doc_id and doc_id in doc_map:
                doc = doc_map[doc_id]
                if doc.human_edited:
                    # Apply editable_fields on top of receipt dict (defensive)
                    fields = doc.editable_fields
                    if isinstance(fields, dict):
                        # Never let editable_fields overwrite our internal _human_edit key
                        safe_fields = {k: v for k, v in fields.items() if k != "_human_edit"}
                        receipt.update(safe_fields)
                    elif fields:
                        logger.warning("[LOAD_CONTEXT] doc.editable_fields is not a dict for doc=%s (type=%s)", doc_id, type(fields).__name__)
                    # Human edit info is now in document_change_logs table.
                    # For the agent prompt, we just flag that edits exist.
                    receipt["_human_edit"] = {
                        "has_changes": True,
                        "overall_risk": "MEDIUM",
                        "changes_by_field": fields if isinstance(fields, dict) else {},
                    }

    # Fallback: derive currency from first receipt's extracted_data if missing
    if not currency and receipts:
        currency = receipts[0].get("currency", "") or ""
    if currency == "Not found in Receipt":
        currency = ""

    # Build combined conditions (deduped, across all relevant categories)
    combined_conditions: List[str] = []
    seen: set = set()
    for cat in all_category:
        cat_data = conditions_dict.get(cat) or {}
        if not cat_data:
            matched_key = next(
                (k for k in conditions_dict if k.lower() == cat.lower()), None
            )
            cat_data = conditions_dict[matched_key] if matched_key else {}
        for cond in cat_data.get("condition", []):
            if cond not in seen:
                seen.add(cond)
                combined_conditions.append(cond)

    logger.info("[LOAD_CONTEXT] Returning %d receipts, %d categories, %d conditions", len(receipts), len(all_category), len(combined_conditions))

    return {
        "user": user,
        "policy": policy,
        "receipts": receipts,
        "all_category": all_category,
        "combined_conditions": combined_conditions,
        "currency": currency,
        "line_items": [],
        "totals": {},
        "judgment": "",
        "confidence": 0.0,
        "summary": "",
    }


def _receipt_detail(index: int, total: int, receipt: dict) -> str:
    category = receipt.get("category") or "Uncategorised"
    return category if total == 1 else f"Receipt {index + 1} of {total} · {category}"


def analyze_receipts(state: ComplianceWorkflowState, tools: list, progress_callback=None, emit: Emit = _no_emit) -> dict:
    """Run per-receipt ReAct agents in parallel using ThreadPoolExecutor."""
    receipts = state["receipts"]
    user = state["user"]
    logger.info("[ANALYZE_RECEIPTS] Starting analysis of %d receipts", len(receipts))
    position = {id(r): i for i, r in enumerate(receipts)}

    def analyze_one(receipt: dict) -> dict:
        doc_id = receipt.get("document_id", "unknown")
        logger.info("[ANALYZE_ONE] Starting analysis for receipt %s", doc_id)
        emit(make_step("receipt.analyze", "running", _receipt_detail(position[id(receipt)], len(receipts), receipt)))
        human_edit_block = _format_human_edit_block(receipt.get("_human_edit", {}))
        if human_edit_block:
            human_edit_block = wrap_text(human_edit_block)
        conditions = state["combined_conditions"]

        prompt = RECEIPT_ANALYSIS_PROMPT.format(
            employee_name=user.name if user else "Unknown",
            department="Unknown",  # department is now normalized, fetch if needed
            rank=str(user.rank if user else 1),
            currency=state.get("currency", "MYR"),
            receipt_json=wrap_json(receipt),
            human_edit_block=human_edit_block,
            conditions=json.dumps(conditions, indent=2),
        )

        agent = create_react_agent(get_agent_llm(), tools)
        result = agent.invoke(
            {"messages": [SystemMessage(content=COMPLIANCE_SYSTEM_PROMPT), HumanMessage(content=prompt)]},
            config={"recursion_limit": 25},
        )

        last_msg = result["messages"][-1]
        content = _extract_text_content(last_msg.content)
        parsed = _parse_line_item(content, receipt)
        logger.info(
            "[ANALYZE_ONE] Receipt %s result: status=%s requested=%s approved=%s",
            doc_id, parsed.get("status"), parsed.get("requested_amount"), parsed.get("approved_amount"),
        )
        return parsed

    line_items = []
    with ThreadPoolExecutor(max_workers=4) as executor:
        future_to_receipt = {executor.submit(analyze_one, r): r for r in receipts}
        for future in as_completed(future_to_receipt):
            receipt = future_to_receipt[future]
            try:
                li = future.result()
                line_items.append(li)
                emit(make_step("receipt.analyze", "done", _receipt_detail(position[id(receipt)], len(receipts), receipt)))
                logger.info("[ANALYZE_RECEIPTS] Completed %d/%d receipts", len(line_items), len(receipts))
                if progress_callback:
                    progress_callback("analyze_receipts", {
                        "current": len(line_items),
                        "total": len(receipts),
                    })
            except Exception:
                logger.exception("[ANALYZE_RECEIPTS] Error for receipt %s", receipt.get("document_id"))
                line_items.append(_parse_line_item("", receipt))
                # The fallback line item sends the claim to HR; the employee sees the step finish.
                emit(make_step("receipt.analyze", "done", _receipt_detail(position[id(receipt)], len(receipts), receipt)))

    logger.info("[ANALYZE_RECEIPTS] Finished with %d line_items", len(line_items))
    return {"line_items": line_items}


def aggregate_totals(state: ComplianceWorkflowState) -> dict:
    """Compute aggregate totals from all line items (pure Python, no LLM)."""
    line_items = state.get("line_items", [])
    logger.info("[AGGREGATE_TOTALS] Aggregating %d line items", len(line_items))
    total_requested = sum(float(li.get("requested_amount", 0) or 0) for li in line_items)
    total_deduction = sum(float(li.get("deduction_amount", 0) or 0) for li in line_items)
    net_approved = sum(float(li.get("approved_amount", 0) or 0) for li in line_items)

    by_category: dict = {}
    for li in line_items:
        cat = li.get("category", "Other")
        if cat not in by_category:
            by_category[cat] = {"claimed": 0.0, "approved": 0.0}
        by_category[cat]["claimed"] += float(li.get("requested_amount", 0) or 0)
        by_category[cat]["approved"] += float(li.get("approved_amount", 0) or 0)

    totals_result = {
        "totals": {
            "total_requested": round(total_requested, 2),
            "total_deduction": round(total_deduction, 2),
            "net_approved": round(net_approved, 2),
            "by_category": by_category,
        }
    }
    logger.info("[AGGREGATE_TOTALS] Totals: requested=%s approved=%s deduction=%s", totals_result["totals"]["total_requested"], totals_result["totals"]["net_approved"], totals_result["totals"]["total_deduction"])
    return totals_result


def final_judgment(state: ComplianceWorkflowState, tools: list) -> dict:
    """Run a ReAct agent to produce the overall settlement verdict."""
    policy = state.get("policy")
    logger.info("[FINAL_JUDGMENT] Running final judgment on %d line_items", len(state.get("line_items", [])))

    prompt = FINAL_JUDGMENT_PROMPT.format(
        line_items_json=wrap_json(state.get("line_items", [])),
        totals_json=json.dumps(state.get("totals", {}), indent=2),
        policy_overview=policy.overview_summary if policy else "",
    )

    agent = create_react_agent(get_agent_llm(), tools)
    result = agent.invoke(
        {"messages": [SystemMessage(content=COMPLIANCE_SYSTEM_PROMPT), HumanMessage(content=prompt)]},
        config={"recursion_limit": 15},
    )

    last_msg = result["messages"][-1]
    content = _extract_text_content(last_msg.content)

    parsed = _extract_json(content)
    if not parsed:
        logger.warning("[FINAL_JUDGMENT] Parse failed. Content: %s", content[:200])
        parsed = {}

    try:
        confidence = float(parsed.get("confidence", 0.0))
    except (ValueError, TypeError):
        confidence = 0.0

    judgment = parsed.get("overall_judgment", "MANUAL REVIEW")
    logger.info("[FINAL_JUDGMENT] Result: judgment=%s confidence=%s", judgment, confidence)

    return {
        "judgment": judgment,
        "confidence": confidence,
        "summary": parsed.get("summary", ""),
    }


def _map_agent_status_to_enum(status_str: str) -> JudgmentResult:
    status_upper = status_str.upper().replace(" ", "_")
    mapping = {
        "APPROVED": JudgmentResult.APPROVED,
        "APPROVE": JudgmentResult.APPROVED,
        "REJECTED": JudgmentResult.REJECTED,
        "REJECT": JudgmentResult.REJECTED,
        "PARTIAL": JudgmentResult.PARTIAL,
        "PARTIAL_APPROVE": JudgmentResult.PARTIAL,
        "NEEDS_INFO": JudgmentResult.NEEDS_INFO,
        "MANUAL_REVIEW": JudgmentResult.NEEDS_INFO,
    }
    return mapping.get(status_upper, JudgmentResult.NEEDS_INFO)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso_date(value: Any) -> Optional[date]:
    if not isinstance(value, str):
        return None
    try:
        return date.fromisoformat(value.strip()[:10])
    except ValueError:
        return None


def _is_hr(user: Any) -> bool:
    role = getattr(user, "role", None)
    return getattr(role, "value", role) == UserRole.HR.value


def _receipt_doc_ids(state: ComplianceWorkflowState) -> List[UUID]:
    return [UUID(r["document_id"]) for r in state.get("receipts", []) if r.get("document_id")]


def _shield_docs(state: ComplianceWorkflowState, session: Session) -> List[ShieldDoc]:
    ids = _receipt_doc_ids(state)
    if not ids:
        return []
    docs = session.exec(select(SupportingDocument).where(SupportingDocument.document_id.in_(ids))).all()
    out = []
    for d in docs:
        extracted = d.extracted_data or {}
        edited = d.editable_fields if d.human_edited and isinstance(d.editable_fields, dict) else {}
        fingerprint = None
        if d.sha256:
            # OCR values, not edits: candidates from other claims are compared on their OCR values too.
            amount, expense_date = amount_and_date(extracted)
            fingerprint = DocFingerprint(
                document_id=str(d.document_id), reim_id=state["reim_id"], user_id=str(d.user_id),
                sha256=d.sha256, phash=d.phash, reim_status=None, amount=amount, expense_date=expense_date,
            )
        out.append(ShieldDoc(
            document_id=str(d.document_id),
            extracted=extracted,
            edited=edited,
            change_summary=detect_changes(extracted, edited) if edited else {},
            stored_signals=[RiskSignal.model_validate(s) for s in (d.shield or {}).get("provenance", [])],
            fingerprint=fingerprint,
            forensics=(d.shield or {}).get("forensics"),
        ))
    return out


def _observations(state: ComplianceWorkflowState, session: Session) -> List[dict]:
    """Observe-mode image forensics findings for HR. Stored beside the decision, never fed to decide()."""
    mode = settings.IMAGE_FORENSICS_MODE
    ids = _receipt_doc_ids(state)
    if mode != "observe" or not ids:
        return []
    try:
        # Savepoint: a failed read here must not poison the transaction that saves the claim.
        with session.begin_nested():
            docs = session.exec(select(SupportingDocument).where(SupportingDocument.document_id.in_(ids))).all()
        shield_docs = [ShieldDoc(document_id=str(d.document_id), forensics=(d.shield or {}).get("forensics")) for d in docs]
        return [s.model_dump(mode="json") for s in observed_signals(shield_docs, mode)]
    except Exception:
        logger.exception("[SAVE_REIMBURSEMENT] Could not read image forensics findings")
        return []


def _claim_lite(state: ComplianceWorkflowState, now: datetime) -> ClaimLite:
    receipts = state.get("receipts", [])
    first = receipts[0] if receipts else {}
    raw = sum(float(r.get("total_amount") or 0) for r in receipts)
    # Shield thresholds are company-currency limits, so a foreign claim is compared in company currency.
    amount, _quote = fx.company_amount(raw, state.get("currency"), now)
    return ClaimLite(
        reim_id=state["reim_id"],
        user_id=state["user_id"],
        merchant=first.get("merchant_name") or "",
        expense_date=_iso_date(first.get("date")),
        amount=float(amount),
        created_at=now,
        status=ReimbursementStatus.REVIEW.value,
    )


def _price_check(state: ComplianceWorkflowState) -> Optional[PriceCheck]:
    """None turns the market-price check off: no Channel3 key, or no rate to compare the claim in USD."""
    if not settings.CHANNEL3_API_KEY or settings.FX_TO_USD <= 0:
        return None
    return PriceCheck(
        search=lambda query: channel3_search(query, settings.CHANNEL3_API_KEY),
        categories=frozenset(c.strip().lower() for c in settings.CHANNEL3_CATEGORIES.split(",") if c.strip()),
        fx_to_usd=settings.FX_TO_USD,
        currency=state.get("currency") or settings.PAYPAL_CURRENCY,
    )


def receipt_shield(
    state: ComplianceWorkflowState, session: Session, emit: Emit = _no_emit, now: Optional[datetime] = None
) -> dict:
    """Run the Receipt Shield on the claim's documents. Signals feed decide() in save_reimbursement."""
    now = now or _now()
    config = autonomy_store.get_config(session)
    history = autonomy_store.employee_history(session, UUID(state["user_id"]), now)
    signals = run_shield(
        _shield_docs(state, session),
        _claim_lite(state, now),
        queries.recent_claims(session, state["user_id"], now),
        queries.fingerprint_candidates(session, None, now),
        limit_for(config, trust_tier(history)),
        emit,
        price_check=_price_check(state),
        forensics_mode=settings.IMAGE_FORENSICS_MODE,
    )
    logger.info("[RECEIPT_SHIELD] %d signal(s): %s", len(signals), [s.code.value for s in signals])
    return {"signals": [s.model_dump(mode="json") for s in signals]}


def _decide_once(session: Session, facts: ClaimFacts, signals: List[RiskSignal], uid: UUID, now: datetime) -> AutonomyDecision:
    return decide(
        facts,
        signals,
        autonomy_store.employee_history(session, uid, now),
        autonomy_store.payee_status(session, uid),
        autonomy_store.ledger_snapshot(session, now),
        autonomy_store.get_config(session),
        now,
    )


def _decide(state: ComplianceWorkflowState, session: Session, facts: ClaimFacts, now: datetime) -> AutonomyDecision:
    """decide() on totals that no concurrent claim can change until save_reimbursement commits this one.

    Takes the employee key, then the company key only for an AUTO_PAY candidate; never the reverse, so no deadlock.
    """
    uid = UUID(state["user_id"])
    signals = [RiskSignal.model_validate(s) for s in state.get("signals", [])]
    # The first read of the settings row may create and commit it, which would drop locks already held.
    autonomy_store.get_config(session)
    autonomy_store.lock_employee_budget(session, uid)
    decision = _decide_once(session, facts, signals, uid, now)
    if decision.tier != AutonomyTier.AUTO_PAY:
        return decision
    # The ledger above was read without the company lock, so decide again on a fresh one.
    autonomy_store.lock_company_budget(session)
    return _decide_once(session, facts, signals, uid, now)


def _verdict_for_decide(judgment: JudgmentResult, line_items: List[dict], claimed: Decimal, approved: Decimal) -> str:
    """The overall verdict counts as APPROVED only when every line item agrees and nothing was deducted."""
    if judgment != JudgmentResult.APPROVED:
        return judgment.value
    items_ok = bool(line_items) and all(
        _map_agent_status_to_enum(str(li.get("status", ""))) == JudgmentResult.APPROVED for li in line_items
    )
    if items_ok and approved > 0 and approved >= claimed:
        return judgment.value
    logger.warning("[SAVE_REIMBURSEMENT] Overall APPROVED disagrees with the line items; deciding as NEEDS_INFO")
    return JudgmentResult.NEEDS_INFO.value


def _decision_log(decision: AutonomyDecision) -> dict:
    return {
        "tier": decision.tier.value,
        "risk_score": decision.risk_score,
        "hard_stops": [h.value for h in decision.hard_stops],
        "signals": [s.code.value for s in decision.signals],
        "config_version": decision.config_version,
    }


def _audit_split_halves(session: Session, decision: AutonomyDecision) -> None:
    """The first half of a split was paid before the split was visible, so it goes to the audit queue."""
    for rid in split_related(decision.signals):
        other = session.get(Reimbursement, UUID(rid))
        status = getattr(other.status, "value", other.status) if other else None
        if not other or other.tier != AutonomyTier.AUTO_PAY.value or status not in autonomy_store.AUTO_PAID_STATUSES:
            continue
        if not other.audit_selected:
            other.audit_selected = True
            other.autonomy = {**(other.autonomy or {}), "audit_selected": True}
            session.add(other)
            session.commit()
            logger.info("[SAVE_REIMBURSEMENT] Split half reim=%s marked for audit", rid)


def _breaker_reason(recent: list, auto_paid_last_hour: float, config) -> str:
    window = recent[: config.breaker_window]
    high = sum(1 for d in window if any(s.severity == Severity.HIGH for s in d.signals))
    if high >= math.ceil(config.breaker_high_ratio * config.breaker_window):
        return f"{high} of the last {len(window)} decisions had a high-risk signal."
    return f"{config.currency} {auto_paid_last_hour:,.2f} was auto-paid in the last hour."


def check_breaker(session: Session, now: datetime) -> bool:
    """Trip the circuit breaker after a decision when the recent pattern calls for it."""
    config = autonomy_store.get_config(session)
    ledger = autonomy_store.ledger_snapshot(session, now)
    if ledger.breaker_active:
        return False
    recent = autonomy_store.recent_decisions(session, config.breaker_window)
    if not breaker_should_trip(recent, ledger.auto_paid_last_hour, config):
        return False
    autonomy_store.trip_breaker(session, _breaker_reason(recent, ledger.auto_paid_last_hour, config), now)
    return True


def save_reimbursement(
    state: ComplianceWorkflowState, session: Session, emit: Emit = _no_emit, now: Optional[datetime] = None
) -> dict:
    """Decide the tier with decide(), then persist the claim and its DECISION log entry together."""
    now = now or _now()
    user = state["user"]
    settlement_uuid = UUID(state["settlement_id"]) if state.get("settlement_id") else None
    reim_id = UUID(state.get("reim_id") or str(uuid4()))
    currency = state.get("currency") or fx.company_currency()

    totals = state.get("totals", {})
    total_claimed = Decimal(str(totals.get("total_requested", 0) or 0))
    total_approved = Decimal(str(totals.get("net_approved", 0) or 0))
    total_deduction = Decimal(str(totals.get("total_deduction", 0) or 0))

    # The company-currency snapshot is fixed now; HR approval locks the approved side separately.
    amount_company, claimed_quote = fx.company_amount(total_claimed, currency, now)
    approved_company, approved_quote = fx.company_amount(total_approved, currency, now)
    fx_rate = claimed_quote.rate if claimed_quote else None
    fx_at = claimed_quote.as_of if claimed_quote else None
    fx_source = claimed_quote.source if claimed_quote else "UNQUOTED"
    fx_unavailable = claimed_quote is None or approved_quote is None
    is_contractor = user.role == UserRole.Contractor
    contract_limit = state.get("contract_max_company_amount")
    over_contract_limit = (
        contract_limit is not None and float(max(amount_company, approved_company)) > float(contract_limit)
    )

    judgment_str = state.get("judgment", "MANUAL REVIEW")
    judgment_enum = _map_agent_status_to_enum(judgment_str)

    emit(make_step("autonomy.decide", "running"))
    try:
        budget_violations = (
            _check_category_budgets(state["policy_id"], totals.get("by_category", {}), session, currency)
            if state.get("policy_id") else []
        )
        facts = ClaimFacts(
            reim_id=str(reim_id),
            user_id=state["user_id"],
            # The larger figure, so a PARTIAL verdict can't shrink the amount the limits see.
            amount=float(max(amount_company, approved_company)),
            currency=fx.company_currency(),
            judgment=_verdict_for_decide(judgment_enum, state.get("line_items", []), total_claimed, total_approved),
            confidence=float(state.get("confidence") or 0.0),
            over_category_budget=bool(budget_violations),
            claimant_is_hr=_is_hr(user),
            fx_unavailable=fx_unavailable,
            claimant_is_contractor=is_contractor,
            over_contract_limit=over_contract_limit,
        )
        decision = _decide(state, session, facts, now)
    except Exception:
        session.rollback()
        emit(make_step("autonomy.decide", "done", SENT_TO_HR))
        raise
    auto_pay = decision.tier == AutonomyTier.AUTO_PAY
    # Read after decide() and stored next to it, so an observe-mode finding can't reach the decision.
    autonomy_record = decision.model_dump(mode="json")
    observations = _observations(state, session)
    if observations:
        autonomy_record["observations"] = observations
    # Only decide() can approve. Every other tier, an AI rejection included, waits for HR.
    final_status = ReimbursementStatus.APPROVED if auto_pay else ReimbursementStatus.REVIEW
    reviewed_at = now if auto_pay else None
    logger.info("[SAVE_REIMBURSEMENT] Decision for reim=%s: %s", reim_id, decision.explanation)

    # Include budget violations in summary and audit notes if present
    final_summary = state.get("summary", "")
    if budget_violations:
        base_summary = state.get("summary", "")

        # Add to summary for reimbursement record
        budget_summary = " | ".join([f"{v['category']}: claimed {v['claimed']}, budget {v['budget']}" for v in budget_violations])
        final_summary = f"{base_summary} [OVER BUDGET: {budget_summary}]" if base_summary else f"Claim exceeds category budgets: {budget_summary}"

        # Add audit notes to line items for transparency (HR and employee can see)
        # Find line items in over-budget categories and append budget info
        line_items = state.get("line_items", [])
        for item in line_items:
            item_category = item.get("category", "")
            matching_violation = next((v for v in budget_violations if v["category"] == item_category), None)
            if matching_violation:
                budget_note = f"Claim is over the budget for {item_category} category which is RM {matching_violation['budget']:.2f}"
                existing_notes = item.get("audit_notes", [])
                if isinstance(existing_notes, list):
                    item["audit_notes"] = existing_notes + [{"tag": "OVER_BUDGET", "message": budget_note}]

    reimbursement = Reimbursement(
        reim_id=reim_id,
        user_id=UUID(state["user_id"]),
        policy_id=UUID(state["policy_id"]),
        settlement_id=settlement_uuid,
        contract_id=UUID(state["contract_id"]) if state.get("contract_id") else None,
        main_category=state["main_category"],
        currency=state.get("currency") or fx.company_currency(),
        total_claimed_amount=float(total_claimed),
        total_approved_amount=float(total_approved) if total_approved > 0 else None,
        total_rejected_amount=float(total_deduction) if total_deduction > 0 else None,
        amount_company=float(amount_company),
        approved_company_amount=float(approved_company) if total_approved > 0 else None,
        fx_rate_to_company=float(fx_rate) if fx_rate is not None else None,
        fx_rate_at=fx_at,
        fx_source=fx_source,
        judgment=judgment_enum,
        confidence=state.get("confidence"),
        ai_reasoning={
            "model": settings.CHAT_MODEL,
            "policy_refs": [],
            "reasoning": f"Agent judgment: {judgment_str}",
            "timestamp": now.isoformat(),
        },
        status=final_status,
        reviewed_at=reviewed_at,
        summary=final_summary,
        tier=decision.tier.value,
        risk_score=decision.risk_score,
        autonomy=autonomy_record,
        audit_selected=decision.audit_selected,
    )
    if total_approved > 0:
        # AUTO_PAY is an approval too: lock the payout at the same quote the limits used.
        from engine.services.payout_service import lock_payout_snapshot
        lock_payout_snapshot(session, reimbursement, total_approved, now)

    try:
        session.add(reimbursement)
        session.flush()
        logger.info("[SAVE_REIMBURSEMENT] Created reimbursement reim_id=%s", reimbursement.reim_id)

        # Bulk insert ReimbursementSubCategory rows
        for cat in state.get("all_category", []):
            rsc = ReimbursementSubCategory(
                reim_id=reimbursement.reim_id,
                sub_category=cat,
            )
            session.add(rsc)

        # Bulk insert LineItem rows
        line_item_count = 0
        for li in state.get("line_items", []):
            # Map agent status to enum
            li_judgment = _map_agent_status_to_enum(li.get("status", "APPROVED"))

            # Build audit notes into rejection_reason
            audit_notes = li.get("audit_notes", [])
            rejection_reason = None
            if li_judgment in (JudgmentResult.REJECTED, JudgmentResult.NEEDS_INFO):
                rejection_reason = "; ".join(
                    f"{n.get('tag', '')}: {n.get('message', '')}" for n in audit_notes
                ) if audit_notes else None

            # Parse document_id
            doc_id_str = li.get("document_id", "")
            doc_uuid = None
            if doc_id_str and doc_id_str != "unknown" and doc_id_str.strip():
                try:
                    doc_uuid = UUID(doc_id_str)
                except ValueError as e:
                    logger.warning("[SAVE_REIMBURSEMENT] Invalid document_id format: %s. Error: %s", doc_id_str, e)
                    doc_uuid = None
            else:
                if doc_id_str and doc_id_str != "unknown":
                    logger.warning("[SAVE_REIMBURSEMENT] Skipping line item with blank/unknown document_id: %r", doc_id_str)

            line_item = LineItem(
                reim_id=reimbursement.reim_id,
                document_id=doc_uuid,
                description=li.get("description", ""),
                category=li.get("category", ""),
                claimed_amount=float(li.get("requested_amount", 0) or 0),
                approved_amount=float(li.get("approved_amount", 0) or 0) if li.get("approved_amount") else None,
                currency=state.get("currency", "MYR"),
                judgment=li_judgment,
                rejection_reason=rejection_reason,
            )
            session.add(line_item)
            line_item_count += 1

        # Linking the documents lets later duplicate checks see this claim and its status.
        doc_ids = _receipt_doc_ids(state)
        if doc_ids:
            for doc in session.exec(select(SupportingDocument).where(SupportingDocument.document_id.in_(doc_ids))).all():
                doc.reim_id = reimbursement.reim_id
                session.add(doc)

        session.flush()
        # record_action commits, so the claim and its DECISION entry land together or not at all.
        record_action(session, AgentActionType.DECISION, "agent", reimbursement.reim_id, _decision_log(decision))
        session.refresh(reimbursement)
        logger.info("[SAVE_REIMBURSEMENT] Committed %d line_items for reim_id=%s", line_item_count, reimbursement.reim_id)
    except Exception:
        logger.exception("[SAVE_REIMBURSEMENT] Failed to save reimbursement")
        session.rollback()
        emit(make_step("autonomy.decide", "done", SENT_TO_HR))
        raise

    emit(make_step("autonomy.decide", "done", decision_copy(decision, currency, float(total_approved))))

    try:
        _audit_split_halves(session, decision)
    except Exception:
        logger.exception("[SAVE_REIMBURSEMENT] Could not mark split halves for audit (reim=%s)", reim_id)
        session.rollback()
    try:
        check_breaker(session, now)
    except Exception:
        logger.exception("[SAVE_REIMBURSEMENT] Circuit breaker check failed after reim=%s", reim_id)
        session.rollback()

    return {"reimbursement_id": str(reimbursement.reim_id)}


def _check_category_budgets(policy_id: str, category_totals: dict, session: Session,
                            currency: str | None = None) -> list:
    """
    Check if claimed amounts exceed auto-approval budgets per category.

    Budgets are company-currency amounts, so category totals are converted before the
    comparison. A currency with no quote is left raw; decide() already fails it closed.

    Returns list of violations: [{"category": "Meals", "claimed": 150.0, "budget": 100.0}, ...]
    """
    from core.models import PolicyReimbursableCategory
    from sqlalchemy import select

    violations = []

    # Fetch all category budgets for this policy
    stmt = select(PolicyReimbursableCategory).where(
        PolicyReimbursableCategory.policy_id == UUID(policy_id)
    )
    result = session.execute(stmt)
    policy_categories = {pc.category: pc.auto_approval_budget for pc in result.scalars()}

    # Check each category in the claim
    for category_name, category_data in category_totals.items():
        # Extract claimed amount from dict structure: {"claimed": X, "approved": Y}
        if isinstance(category_data, dict):
            claimed_amount = category_data.get("claimed", 0)
        else:
            claimed_amount = category_data

        budget = policy_categories.get(category_name)

        # Null budget = unlimited, skip check
        if budget is None:
            continue

        company_claimed, _quote = fx.company_amount(claimed_amount, currency)
        if float(company_claimed) > float(budget):
            violations.append({
                "category": category_name,
                "claimed": float(claimed_amount),
                "budget": float(budget)
            })

    return violations


# -- Graph Assembly --------------------------------------------------------------

def timeline_emitter(progress_callback) -> Emit:
    """Publishes steps on the analysis stream. That stream goes to the claimant, so steps are made employee-safe."""
    def emit(step: TimelineStep) -> None:
        if not progress_callback:
            return
        safe = employee_safe(step)
        progress_callback("timeline", {**safe.model_dump(), "ts": _now().strftime("%Y-%m-%dT%H:%M:%SZ")})
    return emit


def _policy_detail(session: Session, policy: Optional[Policy]) -> str:
    from core.models import PolicyReimbursableCategory
    if not policy:
        return "No policy matched"
    count = len(session.exec(
        select(PolicyReimbursableCategory.category).where(PolicyReimbursableCategory.policy_id == policy.policy_id)
    ).all())
    return f"{policy.title} · {count} categor{'y' if count == 1 else 'ies'}"


def _totals_detail(state: ComplianceWorkflowState) -> str:
    totals = state.get("totals", {})
    currency = state.get("currency") or "MYR"
    return (
        f"{currency} {float(totals.get('total_requested', 0) or 0):,.2f} claimed · "
        f"{currency} {float(totals.get('net_approved', 0) or 0):,.2f} eligible"
    )


_VERDICT_COPY = {
    JudgmentResult.APPROVED: "Approve",
    JudgmentResult.PARTIAL: "Approve part of the claim",
}


def _judgment_detail(judgment: str, confidence: float) -> str:
    verdict = _VERDICT_COPY.get(_map_agent_status_to_enum(judgment or ""), "Needs a closer look")
    return f"{verdict} · confidence {float(confidence or 0):.2f}"


def run_compliance_workflow(
    settlement_id: str,
    policy_id: str,
    main_category: str,
    user_id: str,
    all_category: Optional[List[str]],
    session: Session,
    document_ids: Optional[List[str]] = None,
    progress_callback=None,
    contract_id: Optional[str] = None,
    contract_max_company_amount: Optional[float] = None,
) -> dict:
    """
    Compile and run the compliance graph.
    Returns a dict with reimbursement_id, judgment, totals, line_items,
    confidence, and summary.
    """
    tools = [get_disparance_date]
    if policy_id:
        tools.append(make_search_policy_rag_tool(policy_id, session))
    cb = progress_callback
    emit = timeline_emitter(cb)

    def _load_context(state):
        if cb:
            cb("load_context", {"message": "Loading policy and receipts..."})
        emit(make_step("policy.load", "running"))
        out = load_context(state, session)
        emit(make_step("policy.load", "done", _policy_detail(session, out.get("policy"))))
        return out

    def _analyze_receipts(state):
        if cb:
            cb("analyze_receipts", {"message": "Analyzing receipts with AI..."})
        return analyze_receipts(state, tools, progress_callback=cb, emit=emit)

    def _receipt_shield(state):
        return receipt_shield(state, session, emit=emit)

    def _aggregate_totals(state):
        if cb:
            cb("aggregate_totals", {"message": "Computing totals..."})
        emit(make_step("totals.aggregate", "running"))
        out = aggregate_totals(state)
        emit(make_step("totals.aggregate", "done", _totals_detail({**state, **out})))
        return out

    def _final_judgment(state):
        if cb:
            cb("final_judgment", {"message": "Making judgment..."})
        emit(make_step("judgment.final", "running"))
        out = final_judgment(state, tools)
        emit(make_step("judgment.final", "done", _judgment_detail(out.get("judgment"), out.get("confidence"))))
        return out

    def _save_reimbursement(state):
        if cb:
            cb("save_reimbursement", {"message": "Saving reimbursement result..."})
        return save_reimbursement(state, session, emit=emit)

    graph = StateGraph(ComplianceWorkflowState)
    graph.add_node("load_context", _load_context)
    graph.add_node("analyze_receipts", _analyze_receipts)
    graph.add_node("receipt_shield", _receipt_shield)
    graph.add_node("aggregate_totals", _aggregate_totals)
    graph.add_node("final_judgment", _final_judgment)
    graph.add_node("save_reimbursement", _save_reimbursement)

    graph.add_edge(START, "load_context")
    graph.add_edge("load_context", "analyze_receipts")
    graph.add_edge("analyze_receipts", "receipt_shield")
    graph.add_edge("receipt_shield", "aggregate_totals")
    graph.add_edge("aggregate_totals", "final_judgment")
    graph.add_edge("final_judgment", "save_reimbursement")
    graph.add_edge("save_reimbursement", END)

    app = graph.compile()

    logger.info("[RUN_COMPLIANCE] Invoking graph for settlement=%s policy=%s", settlement_id, policy_id)
    result = app.invoke({
        "settlement_id": settlement_id,
        "policy_id": policy_id or "",
        "main_category": main_category,
        "user_id": user_id,
        "all_category": all_category or [],
        "document_ids": document_ids or [],
        "reim_id": str(uuid4()),
        "contract_id": contract_id,
        "contract_max_company_amount": contract_max_company_amount,
        "user": None,
        "policy": None,
        "receipts": [],
        "combined_conditions": [],
        "currency": "",
        "line_items": [],
        "totals": {},
        "judgment": "",
        "confidence": 0.0,
        "summary": "",
        "signals": [],
        "reimbursement_id": "",
    })

    logger.info("[RUN_COMPLIANCE] Graph complete. reimbursement_id=%s judgment=%s", result.get("reimbursement_id"), result.get("judgment"))
    return {
        "reimbursement_id": result.get("reimbursement_id", ""),
        "judgment": result.get("judgment", ""),
        "summary": result.get("summary", ""),
        "line_items": result.get("line_items", []),
        "totals": result.get("totals", {}),
        "confidence": result.get("confidence", 0.0),
    }
