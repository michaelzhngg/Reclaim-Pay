"""
Autonomy settings, kill switch, circuit breaker and the inputs `decide()` reads from the DB.

The pure `*_from_rows` helpers hold the counting rules; the DB functions only fetch rows.
"Today" and "month" are UTC calendar boundaries.
"""
import logging
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from uuid import UUID

from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from core.config import settings
from core.enums import AgentActionType, RecoveryStatus, ReimbursementStatus, UserRole
from core.models import AutonomySettings, Recovery, Reimbursement, User
from engine.risk.autonomy import NEW_ISSUE_DAYS, TRUSTED_ISSUE_DAYS
from engine.services.action_log import record_action
from engine.services.risk_contract import (
    AUTONOMY_TIERS,
    AgentLedger,
    AutonomyConfig,
    AutonomyDecision,
    EmployeeHistory,
    PayeeStatus,
)

logger = logging.getLogger(__name__)

SETTINGS_ID = 1
AUTO_PAID_STATUSES = {
    ReimbursementStatus.APPROVED.value,
    ReimbursementStatus.DISBURSING.value,
    ReimbursementStatus.PAID.value,
}
# A notice can still be disputed or waived, so only a recovery that was acted on counts against trust.
CONFIRMED_RECOVERY_STATUSES = (
    RecoveryStatus.OFFSET.value,
    RecoveryStatus.INVOICED.value,
    RecoveryStatus.RECOVERED.value,
)
# Fields on AutonomyConfig the server owns: `enabled` moves only through the kill switch.
SERVER_OWNED_FIELDS = {"enabled", "version"}
# Two-key advisory lock namespaces, a separate key space from the action log's single-key lock.
EMPLOYEE_BUDGET_LOCK = 724243
COMPANY_BUDGET_LOCK = 724244


def _utc(dt: datetime) -> datetime:
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _day_start(now: datetime) -> datetime:
    return _utc(now).replace(hour=0, minute=0, second=0, microsecond=0)


def _month_start(now: datetime) -> datetime:
    return _day_start(now).replace(day=1)


def _is_auto_paid(row: dict) -> bool:
    return row.get("tier") == "AUTO_PAY" and str(row.get("status")) in AUTO_PAID_STATUSES


def _status_str(status) -> str:
    return status.value if hasattr(status, "value") else str(status)


def history_from_rows(rows: list[dict], issue_dates: list[datetime], now: datetime) -> EmployeeHistory:
    """rows: one employee's claims with `status`, `tier`, `amount`, `updated_at`."""
    today, month = _day_start(now), _month_start(now)
    auto = [r for r in rows if _is_auto_paid(r)]
    issues = [_utc(d) for d in issue_dates]
    now = _utc(now)
    return EmployeeHistory(
        paid_claims=sum(1 for r in rows if str(r.get("status")) == ReimbursementStatus.PAID.value),
        confirmed_issues_90d=sum(1 for d in issues if d >= now - timedelta(days=NEW_ISSUE_DAYS)),
        confirmed_issues_180d=sum(1 for d in issues if d >= now - timedelta(days=TRUSTED_ISSUE_DAYS)),
        auto_paid_today=float(sum(Decimal(str(r["amount"])) for r in auto if _utc(r["updated_at"]) >= today)),
        auto_paid_month=float(sum(Decimal(str(r["amount"])) for r in auto if _utc(r["updated_at"]) >= month)),
    )


def ledger_from_rows(rows: list[dict], now: datetime, breaker_until: datetime | None,
                     vendor_rows: list[dict] | None = None) -> AgentLedger:
    """rows: company-wide claims with `status`, `tier`, `amount`, `updated_at`.
    vendor_rows: vendor booking payments with `status`, `amount`, `updated_at`.
    """
    now = _utc(now)
    today, hour_ago = _day_start(now), now - timedelta(hours=1)
    auto = [r for r in rows if _is_auto_paid(r)]
    vendor_paid_today = sum(
        Decimal(str(r["amount"])) for r in vendor_rows or []
        if str(r.get("status")) in (ReimbursementStatus.DISBURSING.value, ReimbursementStatus.PAID.value)
        and _utc(r["updated_at"]) >= today
    )
    return AgentLedger(
        auto_paid_today=float(sum(Decimal(str(r["amount"])) for r in auto if _utc(r["updated_at"]) >= today)),
        auto_paid_last_hour=float(sum(Decimal(str(r["amount"])) for r in auto if _utc(r["updated_at"]) >= hour_ago)),
        breaker_active=breaker_until is not None and _utc(breaker_until) > now,
        vendor_paid_today=float(vendor_paid_today),
    )


def payee_from_user(user: User) -> PayeeStatus:
    return PayeeStatus(
        verified=bool(user.paypal_verified and user.paypal_payer_id),
        linked_at=user.paypal_linked_at,
        changed_at=user.payout_destination_changed_at,
    )


def payee_from_vendor(vendor) -> PayeeStatus:
    return PayeeStatus(
        verified=bool(vendor.paypal_verified and vendor.paypal_payer_id),
        linked_at=vendor.paypal_linked_at,
        changed_at=vendor.payout_destination_changed_at,
    )


def _claim_row(r: Reimbursement) -> dict:
    amount = r.total_approved_amount if r.total_approved_amount is not None else r.total_claimed_amount
    return {
        "status": _status_str(r.status),
        "tier": r.tier,
        "amount": amount or 0,
        "updated_at": r.updated_at or r.created_at,
    }


def _has_high_signal(autonomy: dict | None) -> bool:
    return any((s or {}).get("severity") == "HIGH" for s in (autonomy or {}).get("signals", []))


def lock_employee_budget(db: Session, user_id: UUID) -> None:
    """Serialise auto-pay decisions for one employee until this transaction commits or rolls back."""
    # A 32-bit slice of the UUID: a collision only makes two employees wait for each other.
    key = int.from_bytes(user_id.bytes[:4], "big", signed=True)
    db.exec(text(f"SELECT pg_advisory_xact_lock({EMPLOYEE_BUDGET_LOCK}, {key})"))


def lock_company_budget(db: Session) -> None:
    """Serialise every claim that would spend the company daily budget until this transaction ends."""
    db.exec(text(f"SELECT pg_advisory_xact_lock({COMPANY_BUDGET_LOCK}, 0)"))


def settings_row(db: Session, for_update: bool = False) -> AutonomySettings:
    """Return the single settings row, creating it from AutonomyConfig defaults on first read."""
    stmt = select(AutonomySettings).where(AutonomySettings.id == SETTINGS_ID)
    if for_update:
        stmt = stmt.with_for_update()
    row = db.exec(stmt).first()
    if row:
        return row
    defaults = AutonomyConfig().model_dump(mode="json")
    row = AutonomySettings(id=SETTINGS_ID, config=defaults, enabled=defaults["enabled"], version=defaults["version"])
    db.add(row)
    try:
        db.commit()
    except IntegrityError:
        # Another request created it first.
        db.rollback()
        return db.exec(stmt).one()
    db.refresh(row)
    return row


def config_from_row(row: AutonomySettings) -> AutonomyConfig:
    data = {**(row.config or {}), "enabled": bool(row.enabled), "version": row.version}
    return AutonomyConfig.model_validate(data)


def get_config(db: Session) -> AutonomyConfig:
    """The config decide() uses; `enabled` already reflects the env kill switch."""
    cfg = config_from_row(settings_row(db))
    if not settings.AUTO_REIMBURSE_ENABLED:
        cfg = cfg.model_copy(update={"enabled": False})
    return cfg


def payee_cooldown_hours(db: Session) -> int:
    """Display-only read that never creates or commits the settings row."""
    row = db.exec(select(AutonomySettings).where(AutonomySettings.id == SETTINGS_ID)).first()
    return config_from_row(row).payee_cooldown_hours if row else AutonomyConfig().payee_cooldown_hours


def is_enabled(db: Session) -> bool:
    return bool(settings.AUTO_REIMBURSE_ENABLED and settings_row(db).enabled)


def active_breaker_until(row: AutonomySettings, now: datetime) -> datetime | None:
    if row.breaker_until and _utc(row.breaker_until) > _utc(now):
        return row.breaker_until
    return None


def breaker_active(db: Session, now: datetime) -> bool:
    return active_breaker_until(settings_row(db), now) is not None


def update_config(
    db: Session, new: AutonomyConfig, actor_id: UUID, now: datetime, reason: str | None = None
) -> AutonomySettings:
    row = settings_row(db, for_update=True)
    old_cfg = row.config or {}
    new_cfg = new.model_dump(mode="json", exclude=SERVER_OWNED_FIELDS)
    merged = {**old_cfg, **new_cfg}
    changed = sorted(k for k in merged if old_cfg.get(k) != merged.get(k))
    row.config = merged
    row.version = (row.version or 1) + 1
    row.updated_by = actor_id
    row.updated_at = now
    db.add(row)
    db.commit()
    db.refresh(row)
    record_action(db, AgentActionType.CONFIG_CHANGED, str(actor_id), None, {
        "version": row.version,
        "changed": changed,
        "old": {k: old_cfg.get(k) for k in changed},
        "new": {k: merged.get(k) for k in changed},
        **({"reason": reason} if reason else {}),
    })
    return row


def set_enabled(db: Session, enabled: bool, reason: str, actor_id: UUID, now: datetime) -> AutonomySettings:
    row = settings_row(db, for_update=True)
    previous = bool(row.enabled)
    row.enabled = enabled
    row.updated_by = actor_id
    row.updated_at = now
    db.add(row)
    db.commit()
    db.refresh(row)
    record_action(db, AgentActionType.KILL_SWITCH, str(actor_id), None, {
        "enabled": enabled,
        "previous": previous,
        "reason": reason,
        "env_enabled": settings.AUTO_REIMBURSE_ENABLED,
    })
    return row


def trip_breaker(db: Session, reason: str, now: datetime) -> datetime:
    """Pause AUTO_PAY for `breaker_pause_minutes`, log it and notify every HR user."""
    from engine.services.payout_service import notify

    row = settings_row(db, for_update=True)
    cfg = config_from_row(row)
    until = _utc(now) + timedelta(minutes=cfg.breaker_pause_minutes)
    row.breaker_until = until
    row.updated_at = now
    db.add(row)
    db.commit()
    record_action(db, AgentActionType.BREAKER_TRIPPED, "agent", None, {
        "reason": reason,
        "until": until.isoformat(),
    })
    hr_ids = db.exec(select(User.user_id).where(User.role == UserRole.HR.value, User.is_active == True)).all()  # noqa: E712
    for hr_id in hr_ids:
        notify(
            db, hr_id, "warning", "Auto-pay paused by the circuit breaker",
            f"{reason} Claims that would auto-pay go to quick review until {until:%H:%M} UTC.",
            link="/hr/autonomy",
        )
    logger.warning("[BREAKER] Tripped until %s: %s", until.isoformat(), reason)
    return until


def confirmed_issues(db: Session, user_id: UUID) -> list[tuple[datetime, str, UUID]]:
    """(date, kind, reim_id) for each issue that counts against trust. kind is "recovery" or "correction"."""
    recoveries = db.exec(
        select(Recovery.created_at, Recovery.reim_id).where(
            Recovery.user_id == user_id, Recovery.status.in_(CONFIRMED_RECOVERY_STATUSES)
        )
    ).all()
    rejected = db.exec(
        select(Reimbursement).where(
            Reimbursement.user_id == user_id,
            Reimbursement.kind == "CLAIM",
            Reimbursement.status == ReimbursementStatus.REJECTED.value,
            Reimbursement.reviewed_by.is_not(None),
        )
    ).all()
    issues = [(d, "recovery", reim_id) for d, reim_id in recoveries if d]
    issues += [(r.reviewed_at or r.updated_at, "correction", r.reim_id) for r in rejected if _has_high_signal(r.autonomy)]
    return [i for i in issues if i[0]]


def _confirmed_issue_dates(db: Session, user_id: UUID) -> list[datetime]:
    return [d for d, _, _ in confirmed_issues(db, user_id)]


def employee_history(db: Session, user_id: UUID, now: datetime) -> EmployeeHistory:
    # Vendor bookings are company spend, not money the employee received; keep them out of trust and caps.
    claims = db.exec(
        select(Reimbursement).where(
            Reimbursement.user_id == user_id,
            Reimbursement.kind == "CLAIM",
        )
    ).all()
    return history_from_rows([_claim_row(r) for r in claims], _confirmed_issue_dates(db, user_id), now)


def payee_status(db: Session, user_id: UUID) -> PayeeStatus:
    user = db.get(User, user_id)
    if not user:
        return PayeeStatus(verified=False, linked_at=None, changed_at=None)
    return payee_from_user(user)


def ledger_snapshot(db: Session, now: datetime) -> AgentLedger:
    claims = db.exec(
        select(Reimbursement).where(
            Reimbursement.kind == "CLAIM",
            Reimbursement.tier == "AUTO_PAY",
            Reimbursement.status.in_(AUTO_PAID_STATUSES),
            Reimbursement.updated_at >= _day_start(now),
        )
    ).all()
    vendor_rows = [
        _claim_row(r) for r in db.exec(
            select(Reimbursement).where(
                Reimbursement.kind == "VENDOR_BOOKING",
                Reimbursement.status.in_([
                    ReimbursementStatus.DISBURSING.value,
                    ReimbursementStatus.PAID.value,
                ]),
                Reimbursement.updated_at >= _day_start(now),
            )
        ).all()
    ]
    return ledger_from_rows([_claim_row(r) for r in claims], now, settings_row(db).breaker_until, vendor_rows)


def recent_decisions(db: Session, n: int) -> list:
    """Newest first. AutonomyDecision models once engine.risk exists, stored dicts until then."""
    rows = db.exec(
        select(Reimbursement.autonomy)
        .where(
            Reimbursement.kind == "CLAIM",
            Reimbursement.tier.is_not(None),
        )
        .order_by(Reimbursement.created_at.desc())
        .limit(n)
    ).all()
    stored = [a for a in rows if a]
    if AutonomyDecision is None:
        return stored
    return [AutonomyDecision.model_validate(a) for a in stored]


def decisions_today_by_tier(db: Session, now: datetime) -> dict[str, int]:
    tiers = db.exec(
        select(Reimbursement.tier).where(
            Reimbursement.tier.is_not(None), Reimbursement.created_at >= _day_start(now)
        )
    ).all()
    counts = {t: 0 for t in AUTONOMY_TIERS}
    for t in tiers:
        counts[t] = counts.get(t, 0) + 1
    return counts
