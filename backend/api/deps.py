from datetime import datetime, timezone
from typing import Generator
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jose import jwt, JWTError
from sqlmodel import Session, select

from core import security
from core.config import settings
from core.database import engine
from core.enums import UserRole
from api import schemas

oauth2_scheme = OAuth2PasswordBearer(tokenUrl=f"{settings.API_V1_STR}/auth/login")

def get_db() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session

def get_current_user(
    db: Session = Depends(get_db), token: str = Depends(oauth2_scheme)
) -> schemas.UserInDB:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Could not validate credentials",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM]
        )
        email: str = payload.get("sub")
        if email is None:
            raise credentials_exception
        token_data = schemas.TokenData(email=email)
    except JWTError:
        raise credentials_exception
    
    # Import here to avoid circular import at module load time
    from core.models import User
    statement = select(User).where(User.email == token_data.email)
    user = db.exec(statement).first()
    if user is None or not user.is_active:
        raise credentials_exception
    # Unlinking from a password session, or a role change, ends any PayPal session at once.
    if security.is_paypal_session(payload) and security.paypal_signin_rejection(user, payload.get("paypal_payer_id")):
        raise credentials_exception
    if issued_before_password_change(payload, user.password_changed_at):
        raise credentials_exception
    return user


def issued_before_password_change(claims: dict, changed_at: datetime | None) -> bool:
    """A password set through invite or reset ends every session issued before it, including ones without iat."""
    if changed_at is None:
        return False
    if changed_at.tzinfo is None:
        changed_at = changed_at.replace(tzinfo=timezone.utc)
    issued = claims.get("iat")
    return not isinstance(issued, (int, float)) or issued < changed_at.timestamp()


# Depends on get_current_user so no route can read claims from a session that has ended.
def get_session_claims(token: str = Depends(oauth2_scheme), _user=Depends(get_current_user)) -> dict:
    try:
        return jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
    except JWTError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Could not validate credentials",
            headers={"WWW-Authenticate": "Bearer"},
        )


def payout_changes_paused_until(claims: dict) -> datetime | None:
    """A PayPal session expires when its pause ends, so it can never change payout details."""
    if not security.is_paypal_session(claims):
        return None
    return datetime.fromtimestamp(claims["exp"], timezone.utc)


def require_payout_changes_allowed(claims: dict = Depends(get_session_claims)) -> None:
    until = payout_changes_paused_until(claims)
    if until:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"Payout account changes are paused until {until:%d %b %Y %H:%M} UTC after a PayPal sign-in. "
                   "Sign in with your password to change it sooner.",
        )


def get_current_hr_user(
    current_user = Depends(get_current_user),
) -> schemas.UserInDB:
    if current_user.role != UserRole.HR:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="The user doesn't have enough privileges"
        )
    return current_user


def get_current_non_contractor_user(
    current_user = Depends(get_current_user),
) -> schemas.UserInDB:
    """Company-wide reads keep their existing audience; a contractor is scoped to their own records."""
    if current_user.role == UserRole.Contractor:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Contractors can only read their own records",
        )
    return current_user
