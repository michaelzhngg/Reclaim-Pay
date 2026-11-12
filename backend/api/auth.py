import logging
from datetime import datetime, timedelta, timezone
from typing import Any
from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordRequestForm
from starlette.requests import Request
from sqlalchemy import func
from sqlmodel import Session, select

from core import account_emails, password_tokens, security
from core.config import settings
from core.database import engine
from core.models import User
from core.password_policy import password_problems
from engine.services.paypal_client import mask_email
from api import schemas, deps
from api.schemas import UpdateProfileRequest
from api.rate_limit import AUTH_LIMIT, limiter

router = APIRouter()
logger = logging.getLogger(__name__)

FORGOT_REPLY = {"detail": "If an account exists for that email, we sent a reset link."}
LINK_ERRORS = {
    password_tokens.INVITE: "This link has expired or was already used. Ask HR to send a new invitation.",
    password_tokens.RESET: "This link has expired or was already used. Request a new reset link.",
}

@router.post("/login", response_model=schemas.Token)
@limiter.limit(AUTH_LIMIT)
def login_access_token(
    request: Request,
    db: Session = Depends(deps.get_db),
    form_data: OAuth2PasswordRequestForm = Depends()
) -> Any:
    """
    OAuth2 compatible token login, get an access token for future requests
    """
    statement = select(User).where(User.email == form_data.username)
    user = db.exec(statement).first()
    
    if not user or not user.is_active or not security.verify_password(form_data.password, user.hashed_password):
        logging.warning(f"Login failed: Invalid credentials for email {form_data.username}")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect email or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token_expires = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    access_token = security.create_access_token(
        subject=user.email, expires_delta=access_token_expires
    )
    return {
        "access_token": access_token,
        "token_type": "bearer",
    }

@router.get("/me")
def read_users_me(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user)
) -> Any:
    """
    Get current user, including department name.
    """
    dept_name = None
    if current_user.department_id:
        from core.models import Department
        dept = db.get(Department, current_user.department_id)
        if dept:
            dept_name = dept.name

    return {
        "user_id": str(current_user.user_id),
        "user_code": current_user.user_code,
        "email": current_user.email,
        "name": current_user.name,
        "role": current_user.role.value if current_user.role and hasattr(current_user.role, "value") else current_user.role,
        "country_code": current_user.country_code,
        "department_id": str(current_user.department_id) if current_user.department_id else None,
        "department_name": dept_name,
        "rank": current_user.rank,
        "privilege_level": current_user.privilege_level.value if current_user.privilege_level and hasattr(current_user.privilege_level, "value") else current_user.privilege_level,
        "is_active": current_user.is_active,
        "created_at": current_user.created_at.isoformat() if current_user.created_at else None,
    }


@router.put("/me")
def update_profile(
    body: UpdateProfileRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
    claims: dict = Depends(deps.get_session_claims),
) -> dict:
    """Update current user's profile."""
    # Check email uniqueness if it changed
    if body.email != current_user.email:
        # The email is the password login, and that login is how an employee recovers from a PayPal takeover.
        if deps.payout_changes_paused_until(claims):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Sign in with your password to change your email.",
            )
        existing = db.exec(select(User).where(User.email == body.email)).first()
        if existing and existing.user_id != current_user.user_id:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Email is already in use by another account.",
            )

    current_user.name = body.name
    current_user.email = body.email
    if body.department_id is not None:
        from uuid import UUID
        current_user.department_id = UUID(str(body.department_id)) if body.department_id else None

    db.add(current_user)
    db.commit()
    db.refresh(current_user)

    u = current_user
    return {
        "user_id": str(u.user_id),
        "user_code": u.user_code,
        "email": u.email,
        "name": u.name,
        "role": u.role.value if u.role and hasattr(u.role, "value") else u.role,
        "department_id": str(u.department_id) if u.department_id else None,
        "rank": u.rank,
        "privilege_level": u.privilege_level.value if u.privilege_level and hasattr(u.privilege_level, "value") else u.privilege_level,
        "is_active": u.is_active,
    }


def open_session() -> Session:
    return Session(engine)


def send_reset_if_eligible(email: str) -> None:
    """Runs after the response is sent, so a known email takes no longer to answer than an unknown one."""
    try:
        with open_session() as db:
            user = db.exec(select(User).where(func.lower(User.email) == email.strip().lower())).first()
            if user is None or not user.is_active:
                return
            now = datetime.now(timezone.utc)
            recent = password_tokens.resets_sent_since(db, user.user_id, now - timedelta(hours=1))
            if recent >= password_tokens.RESET_EMAILS_PER_HOUR:
                return
            plain, _ = password_tokens.issue(db, user, password_tokens.RESET, now)
            db.commit()
            account_emails.send_reset(user.email, user.name, plain)
    except Exception as exc:
        # Type only: a database error message could carry query parameters.
        logger.warning("[AUTH] Reset request could not be processed: %s", type(exc).__name__)


@router.post("/forgot-password")
@limiter.limit("5/minute")
def forgot_password(
    request: Request,
    body: schemas.ForgotPasswordRequest,
    background: BackgroundTasks,
) -> dict:
    """Public. The same answer whether or not the account exists."""
    background.add_task(send_reset_if_eligible, str(body.email))
    return FORGOT_REPLY


@router.post("/password-token")
@limiter.limit("20/minute")
def password_token_info(
    request: Request,
    body: schemas.PasswordTokenRequest,
    db: Session = Depends(deps.get_db),
) -> dict:
    """Public. Lets the set-password page greet the person before they type. A POST keeps the token out of access logs."""
    found = password_tokens.find_valid(db, body.token, body.purpose)
    if not found:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=LINK_ERRORS[body.purpose])
    token, user = found
    return {
        "purpose": token.purpose,
        "name": user.name,
        "email_masked": mask_email(user.email),
        "expires_at": token.expires_at.isoformat(),
    }


@router.post("/set-password")
@limiter.limit(AUTH_LIMIT)
def set_password(
    request: Request,
    body: schemas.SetPasswordRequest,
    db: Session = Depends(deps.get_db),
) -> dict:
    """Public. Spends an invite or reset token and ends every earlier session for the account."""
    found = password_tokens.find_valid(db, body.token, body.purpose, lock=True)
    if not found:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=LINK_ERRORS[body.purpose])
    problems = password_problems(body.new_password)
    if problems:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=" ".join(problems))

    token, user = found
    now = datetime.now(timezone.utc)
    user.hashed_password = security.get_password_hash(body.new_password)
    user.password_changed_at = now
    token.used_at = now
    password_tokens.revoke_unused(db, user.user_id, None, now)
    db.add(user)
    db.add(token)
    db.commit()

    if token.purpose == password_tokens.RESET:
        account_emails.send_changed_notice(user.email, user.name)
        return {"purpose": token.purpose, "detail": "Password changed. Sign in."}
    return {"purpose": token.purpose, "detail": "Password set. Sign in."}
