"""Invite and reset links. The plain token exists only in the email and the one-time HR response."""
import hashlib
import hmac
import secrets
from datetime import datetime, timedelta, timezone
from uuid import UUID

from sqlmodel import Session, select

from core.models import PasswordToken, User

INVITE = "invite"
RESET = "reset"
PURPOSES = (INVITE, RESET)
TTL = {INVITE: timedelta(days=7), RESET: timedelta(minutes=30)}
RESET_EMAILS_PER_HOUR = 3


def hash_token(plain: str) -> str:
    return hashlib.sha256(plain.encode("utf-8")).hexdigest()


def _now() -> datetime:
    return datetime.now(timezone.utc)


def revoke_unused(db: Session, user_id: UUID, purpose: str | None = None, now: datetime | None = None) -> None:
    """Marks the user's open tokens used so older links stop working. Does not commit."""
    query = select(PasswordToken).where(PasswordToken.user_id == user_id, PasswordToken.used_at.is_(None))
    if purpose:
        query = query.where(PasswordToken.purpose == purpose)
    for token in db.exec(query).all():
        token.used_at = now or _now()
        db.add(token)


def issue(db: Session, user: User, purpose: str, now: datetime | None = None) -> tuple[str, PasswordToken]:
    """New token for `purpose`; earlier unused ones of that purpose stop working. Does not commit."""
    if purpose not in PURPOSES:
        raise ValueError(purpose)
    now = now or _now()
    revoke_unused(db, user.user_id, purpose, now)
    plain = secrets.token_urlsafe(32)
    row = PasswordToken(user_id=user.user_id, purpose=purpose, token_hash=hash_token(plain),
                        expires_at=now + TTL[purpose], created_at=now)
    db.add(row)
    return plain, row


def find_valid(db: Session, plain: str, purpose: str, now: datetime | None = None,
               lock: bool = False) -> tuple[PasswordToken, User] | None:
    """The token and its active user, or None when it is unknown, expired, used or for another purpose.

    lock=True holds the row until commit, so two requests can't spend the same token.
    """
    if not plain or purpose not in PURPOSES:
        return None
    digest = hash_token(plain)
    query = select(PasswordToken).where(PasswordToken.token_hash == digest)
    if lock:
        query = query.with_for_update()
    row = db.exec(query).first()
    if row is None or not hmac.compare_digest(row.token_hash, digest):
        return None
    if row.purpose != purpose or row.used_at is not None or row.expires_at <= (now or _now()):
        return None
    user = db.get(User, row.user_id)
    if user is None or not user.is_active:
        return None
    return row, user


def resets_sent_since(db: Session, user_id: UUID, since: datetime) -> int:
    return len(db.exec(select(PasswordToken.id).where(
        PasswordToken.user_id == user_id,
        PasswordToken.purpose == RESET,
        PasswordToken.created_at >= since,
    )).all())


def invite_statuses(db: Session, users: list[User], now: datetime | None = None) -> dict[UUID, str]:
    """"pending" or "expired" for accounts whose password was never set. Other accounts are left out."""
    now = now or _now()
    waiting = [u.user_id for u in users if u.password_changed_at is None]
    if not waiting:
        return {}
    rows = db.exec(select(PasswordToken).where(
        PasswordToken.user_id.in_(waiting),
        PasswordToken.purpose == INVITE,
        PasswordToken.used_at.is_(None),
    )).all()
    status: dict[UUID, str] = {}
    for row in rows:
        if row.expires_at > now:
            status[row.user_id] = "pending"
        else:
            status.setdefault(row.user_id, "expired")
    return status
