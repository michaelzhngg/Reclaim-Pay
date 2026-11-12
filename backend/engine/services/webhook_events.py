"""PayPal webhook ledger: verify is done by the route, then claim, handle, and record an outcome.

The event ID is the replay key and the primary key. A first delivery inserts a RECEIVED row; a
duplicate either sees a terminal row, a fresh in-flight row, or a failed/stale row it may reclaim.
The unique insert is the first concurrency fence; row locks on the existing row are the second.
"""
import logging
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Optional
from uuid import UUID

from sqlalchemy import and_, or_
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select
from pydantic import BaseModel

from core.config import settings
from core.enums import AgentActionType, WebhookEventStatus
from core.models import PayPalWebhookEvent
from engine.services.action_log import record_action
from engine.services.payout_status import apply_item_update
from engine.services.recovery_service import mark_recovered

logger = logging.getLogger(__name__)

MAX_ERROR_CHARS = 2000
_TERMINAL = {WebhookEventStatus.PROCESSED, WebhookEventStatus.IGNORED}


class InvalidWebhook(ValueError):
    pass


class WebhookRetryableError(Exception):
    """The event is authentic but cannot be applied yet; keep it for a retry."""


class WebhookNotFound(Exception):
    pass


class WebhookNotRetryable(Exception):
    pass


@dataclass(frozen=True)
class IngestResult:
    event_id: str
    outcome: str
    status: WebhookEventStatus


class WebhookSweepReport(BaseModel):
    checked: int = 0
    processed: int = 0
    dead_lettered: int = 0
    errors: int = 0
    truncated: bool = False


def _aware(value: Optional[datetime]) -> Optional[datetime]:
    if value is None:
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def _lease() -> timedelta:
    return timedelta(minutes=settings.WEBHOOK_LEASE_MINUTES)


def _attempt_cap() -> int:
    return max(1, settings.WEBHOOK_MAX_ATTEMPTS)


def event_id_of(event: dict) -> str:
    if not isinstance(event, dict):
        raise InvalidWebhook("Webhook body must be a JSON object")
    value = event.get("id")
    if not isinstance(value, str) or not value.strip():
        raise InvalidWebhook("Webhook event id is missing")
    value = value.strip()
    if len(value) > 255:
        raise InvalidWebhook("Webhook event id is too long")
    return value


def resource_id_of(event: dict) -> Optional[str]:
    resource = event.get("resource")
    if not isinstance(resource, dict):
        return None
    invoice = resource.get("invoice")
    invoice_id = invoice.get("id") if isinstance(invoice, dict) else None
    value = resource.get("payout_item_id") or resource.get("id") or invoice_id
    return str(value)[:255] if value else None


def _reim_id_of(event: dict) -> Optional[UUID]:
    resource = event.get("resource")
    item = resource.get("payout_item") if isinstance(resource, dict) else None
    value = item.get("sender_item_id") if isinstance(item, dict) else None
    try:
        return UUID(str(value))
    except (TypeError, ValueError):
        return None


def _error_text(exc: Exception) -> str:
    return f"{type(exc).__name__}: {exc}"[:MAX_ERROR_CHARS]


def dispatch_event(db: Session, event: dict) -> WebhookEventStatus:
    """Apply one verified event. Unknown types are ignored, not failed."""
    event_type = str(event.get("event_type") or "")
    resource = event.get("resource")
    resource = resource if isinstance(resource, dict) else {}

    if event_type.startswith("PAYMENT.PAYOUTS-ITEM."):
        errors = resource.get("errors")
        payout = apply_item_update(
            db,
            resource.get("payout_item_id"),
            (resource.get("payout_item") or {}).get("sender_item_id"),
            resource.get("transaction_status", ""),
            errors.get("name") if isinstance(errors, dict) else None,
        )
        if payout is None:
            raise WebhookRetryableError(
                f"No payout matched item={resource.get('payout_item_id')!r} "
                f"sender_item={((resource.get('payout_item') or {}).get('sender_item_id'))!r}"
            )
        return WebhookEventStatus.PROCESSED

    if event_type == "INVOICING.INVOICE.PAID":
        invoice = resource.get("invoice")
        invoice_id = resource.get("id") or (invoice.get("id") if isinstance(invoice, dict) else None)
        if not invoice_id:
            return WebhookEventStatus.IGNORED
        mark_recovered(db, invoice_id)
        return WebhookEventStatus.PROCESSED

    return WebhookEventStatus.IGNORED


def _claim_row(db: Session, existing: PayPalWebhookEvent, now: datetime,
               manual: bool = False) -> tuple[PayPalWebhookEvent, bool]:
    status = WebhookEventStatus(existing.status)
    if status in _TERMINAL:
        return existing, False
    if status == WebhookEventStatus.DEAD_LETTER and not manual:
        return existing, False

    if status == WebhookEventStatus.RECEIVED:
        updated = _aware(existing.updated_at)
        if updated and updated > now - _lease():
            return existing, False

    # A manual retry still counts as an attempt; the operator gets a fresh try, not a rewritten history.
    existing.attempts = (existing.attempts or 0) + 1
    existing.status = WebhookEventStatus.RECEIVED
    existing.error = None
    existing.updated_at = now
    db.add(existing)
    db.commit()
    db.refresh(existing)
    return existing, True


def _claim_existing(db: Session, event_id: str, now: datetime,
                    manual: bool = False) -> tuple[PayPalWebhookEvent, bool]:
    existing = db.exec(
        select(PayPalWebhookEvent).where(PayPalWebhookEvent.event_id == event_id).with_for_update()
    ).first()
    if existing is None:
        raise RuntimeError(f"Webhook event {event_id} vanished during the claim")
    return _claim_row(db, existing, now, manual)


def claim_event(db: Session, event: dict, now: Optional[datetime] = None) -> tuple[PayPalWebhookEvent, bool]:
    """Insert the first delivery, or reclaim a failed/stale one. False means duplicate/in flight."""
    now = now or datetime.now(timezone.utc)
    event_id = event_id_of(event)
    existing = db.exec(
        select(PayPalWebhookEvent).where(PayPalWebhookEvent.event_id == event_id).with_for_update()
    ).first()
    if existing is not None:
        return _claim_row(db, existing, now)

    row = PayPalWebhookEvent(
        event_id=event_id,
        event_type=str(event.get("event_type") or "")[:128],
        resource_id=resource_id_of(event),
        status=WebhookEventStatus.RECEIVED,
        attempts=1,
        payload=event,
        created_at=now,
        updated_at=now,
    )
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        return _claim_existing(db, event_id, now)
    db.refresh(row)
    return row, True


def _mark(db: Session, event_id: str, status: WebhookEventStatus, now: datetime,
          error: Optional[str] = None) -> PayPalWebhookEvent:
    row = db.get(PayPalWebhookEvent, event_id)
    if row is None:
        raise RuntimeError(f"Webhook event {event_id} vanished while recording its outcome")
    row.status = status
    row.error = error
    row.updated_at = now
    row.processed_at = now if status in _TERMINAL else None
    db.add(row)
    db.commit()
    db.refresh(row)
    return row


def _record_dead_letter(db: Session, row: PayPalWebhookEvent) -> None:
    try:
        record_action(db, AgentActionType.WEBHOOK_DEAD_LETTER, "agent", _reim_id_of(row.payload or {}), {
            "event_id": row.event_id,
            "event_type": row.event_type,
            "resource_id": row.resource_id,
            "attempts": row.attempts,
            "error": row.error,
        })
    except Exception:
        logger.exception("[PAYPAL_WEBHOOK] Could not record dead letter id=%s", row.event_id)
        db.rollback()


def _record_retry(db: Session, row: PayPalWebhookEvent, actor: str, result: IngestResult) -> None:
    payload = {
        "event_id": row.event_id,
        "event_type": row.event_type,
        "attempts": row.attempts,
        "outcome": result.outcome,
        "status": result.status.value,
    }
    if row.error:
        payload["error"] = row.error
    try:
        record_action(db, AgentActionType.WEBHOOK_RETRY, actor, _reim_id_of(row.payload or {}), payload)
    except Exception:
        logger.exception("[PAYPAL_WEBHOOK] Could not record retry id=%s", row.event_id)
        db.rollback()


def process_event(db: Session, row: PayPalWebhookEvent, now: Optional[datetime] = None,
                  manual: bool = False) -> IngestResult:
    now = now or datetime.now(timezone.utc)
    event_id = row.event_id
    try:
        outcome = dispatch_event(db, row.payload or {})
    except Exception as exc:
        logger.exception("[PAYPAL_WEBHOOK] Handling failed id=%s", event_id)
        db.rollback()
        row = db.get(PayPalWebhookEvent, event_id)
        dead = manual or (row.attempts or 1) >= _attempt_cap()
        status = WebhookEventStatus.DEAD_LETTER if dead else WebhookEventStatus.FAILED
        row = _mark(db, event_id, status, now, _error_text(exc))
        if dead:
            _record_dead_letter(db, row)
        return IngestResult(event_id, "dead_letter" if dead else "failed", status)

    _mark(db, event_id, outcome, now)
    return IngestResult(event_id, "ignored" if outcome == WebhookEventStatus.IGNORED else "ok", outcome)


def ingest_event(db: Session, event: dict, now: Optional[datetime] = None) -> IngestResult:
    """Call only after signature verification. A duplicate terminal event does no domain work."""
    now = now or datetime.now(timezone.utc)
    row, claimed = claim_event(db, event, now)
    if not claimed:
        logger.info("[PAYPAL_WEBHOOK] Duplicate event id=%s status=%s", row.event_id, row.status)
        return IngestResult(row.event_id, "duplicate", WebhookEventStatus(row.status))
    return process_event(db, row, now)


def retry_event(db: Session, event_id: str, actor: str, now: Optional[datetime] = None) -> IngestResult:
    """HR retry from the stored, previously verified payload. Resets the attempt budget."""
    now = now or datetime.now(timezone.utc)
    existing = db.exec(
        select(PayPalWebhookEvent).where(PayPalWebhookEvent.event_id == event_id).with_for_update()
    ).first()
    if existing is None:
        raise WebhookNotFound(event_id)
    row, claimed = _claim_row(db, existing, now, manual=True)
    if not claimed:
        raise WebhookNotRetryable(f"Event is {WebhookEventStatus(row.status).value}")
    result = process_event(db, row, now, manual=True)
    row = db.get(PayPalWebhookEvent, event_id)
    _record_retry(db, row, actor, result)
    return result


def sweep_events(db: Session, now: Optional[datetime] = None, limit: int = 100) -> WebhookSweepReport:
    """Retry FAILED rows and RECEIVED rows whose lease expired. Dead letters wait for HR."""
    now = now or datetime.now(timezone.utc)
    cutoff = now - _lease()
    rows = db.exec(
        select(PayPalWebhookEvent)
        .where(or_(
            PayPalWebhookEvent.status == WebhookEventStatus.FAILED.value,
            and_(
                PayPalWebhookEvent.status == WebhookEventStatus.RECEIVED.value,
                PayPalWebhookEvent.updated_at < cutoff,
            ),
        ))
        .order_by(PayPalWebhookEvent.updated_at.asc())
        .limit(limit + 1)
    ).all()
    report = WebhookSweepReport(checked=min(len(rows), limit), truncated=len(rows) > limit)
    for candidate in rows[:limit]:
        try:
            row = db.exec(
                select(PayPalWebhookEvent)
                .where(PayPalWebhookEvent.event_id == candidate.event_id)
                .with_for_update()
            ).first()
            if row is None:
                continue
            row, claimed = _claim_row(db, row, now)
            if not claimed:
                continue
            result = process_event(db, row, now)
            if result.status in _TERMINAL:
                report.processed += 1
            elif result.status == WebhookEventStatus.DEAD_LETTER:
                report.dead_lettered += 1
            else:
                report.errors += 1
        except Exception:
            logger.exception("[PAYPAL_WEBHOOK] Sweep failed id=%s", candidate.event_id)
            db.rollback()
            report.errors += 1
    return report
