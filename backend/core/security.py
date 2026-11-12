from datetime import datetime, timedelta, timezone
from typing import Any, Optional, Union
from jose import jwt
import bcrypt
from core.config import settings
from core.enums import UserRole

PAYPAL_AUTH_METHOD = "paypal"


def create_access_token(
    subject: Union[str, Any], expires_delta: Optional[timedelta] = None, extra_claims: Optional[dict] = None
) -> str:
    now = datetime.now(timezone.utc)
    expire = now + (expires_delta or timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES))
    # Fractional iat: a password set a moment before sign-in must not reject the new session.
    to_encode = {**(extra_claims or {}), "exp": expire, "iat": now.timestamp(), "sub": str(subject)}
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=settings.ALGORITHM)
    return encoded_jwt

def verify_password(plain_password: str, hashed_password: str) -> bool:
    return bcrypt.checkpw(plain_password.encode('utf-8'), hashed_password.encode('utf-8'))

def get_password_hash(password: str) -> str:
    return bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt()).decode('utf-8')


def is_paypal_session(claims: dict) -> bool:
    return claims.get("auth_method") == PAYPAL_AUTH_METHOD


def paypal_signin_rejection(user: Any, payer_id: Optional[str]) -> Optional[str]:
    """Why this user can't hold a PayPal session for this payer ID, or None when they can."""
    # Contractors are paid to their own PayPal account, so they sign in like employees. HR never does.
    if user.role not in (UserRole.Employee, UserRole.Contractor):
        return "not_employee"
    if not user.is_active:
        return "inactive"
    if not payer_id or user.paypal_payer_id != payer_id:
        return "payer_mismatch"
    if not user.paypal_verified:
        return "link_not_verified"
    return None
