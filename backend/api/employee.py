import secrets
from typing import List
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from api import deps, schemas
from core import account_emails, password_tokens, security
from core.enums import AgentActionType, PrivilegeLevel, UserRole
from core.models import User, Department
from engine.services.action_log import record_action

router = APIRouter()


def _value(v):
    return v.value if hasattr(v, "value") else v


def _record(u: User, dept_name: str | None, invite_status: str | None) -> dict:
    return {
        "user_id": str(u.user_id),
        "user_code": u.user_code,
        "name": u.name,
        "email": u.email,
        "role": _value(u.role),
        "department_id": str(u.department_id) if u.department_id else None,
        "department_name": dept_name,
        "rank": u.rank,
        "privilege_level": _value(u.privilege_level),
        "is_active": u.is_active,
        "bank_code": u.bank_code,
        "bank_account_number": u.bank_account_number,
        "bank_account_holder_name": u.bank_account_holder_name,
        "created_at": u.created_at.isoformat() if u.created_at else None,
        "invite_status": invite_status,
    }


@router.get("/")
def list_employees(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> List[dict]:
    """Return all employees with department names. HR only."""
    users = db.exec(select(User)).all()

    dept_ids = {u.department_id for u in users if u.department_id}
    depts = db.exec(select(Department).where(Department.department_id.in_(dept_ids))).all() if dept_ids else []
    dept_map = {d.department_id: d.name for d in depts}
    invites = password_tokens.invite_statuses(db, users)

    return [
        _record(u, dept_map.get(u.department_id) if u.department_id else None, invites.get(u.user_id))
        for u in users
    ]


def _invite_response(plain: str, token, email_result: tuple[str, str | None]) -> dict:
    email_status, email_error = email_result
    return {
        "invite_link": account_emails.invite_link(plain),
        "invite_expires_at": token.expires_at.isoformat(),
        # "sent", "off" (no API key on the server) or "failed" (Resend said no).
        "email_status": email_status,
        "email_error": email_error,
    }


@router.post("/", status_code=status.HTTP_201_CREATED)
def create_employee(
    body: schemas.CreateEmployeeRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    """HR only. Creates the account and emails a link to set the password. The link is in this response once."""
    email = str(body.email).strip()
    if db.exec(select(User).where(func.lower(User.email) == email.lower())).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="An account with this email already exists.")
    user_code = (body.user_code or "").strip() or None
    if user_code and db.exec(select(User).where(User.user_code == user_code)).first():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="Another account already uses this company ID.")
    dept = db.get(Department, body.department_id) if body.department_id else None
    if body.department_id and dept is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Choose a department from the list.")

    user = User(
        email=email,
        name=body.name.strip(),
        user_code=user_code,
        # Nobody knows this password, so the account can't sign in until the invite link is used.
        hashed_password=security.get_password_hash(secrets.token_urlsafe(48)),
        role=body.role,
        department_id=body.department_id,
        rank=1,
        privilege_level=PrivilegeLevel.Standard,
        is_active=True,
    )
    db.add(user)
    db.flush()
    plain, token = password_tokens.issue(db, user, password_tokens.INVITE)
    # record_action commits the user and the token with the log entry.
    record_action(db, AgentActionType.EMPLOYEE_CREATED, str(current_user.user_id), None, {
        "user_id": str(user.user_id), "role": _value(user.role),
    })
    db.refresh(user)
    email_result = account_emails.send_invite(user.email, user.name, plain)
    return {
        "employee": _record(user, dept.name if dept else None, "pending"),
        **_invite_response(plain, token, email_result),
    }


@router.post("/{user_id}/invite")
def resend_invite(
    user_id: UUID,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    """HR only. Replaces the invite link for someone who hasn't set a password yet."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found.")
    if user.password_changed_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="This person already set a password. They can use Forgot password on the sign-in page.")
    if not user.is_active:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This account is inactive.")
    plain, token = password_tokens.issue(db, user, password_tokens.INVITE)
    record_action(db, AgentActionType.INVITE_RESENT, str(current_user.user_id), None, {"user_id": str(user.user_id)})
    email_result = account_emails.send_invite(user.email, user.name, plain)
    return {"email": user.email, **_invite_response(plain, token, email_result)}


EDITABLE_FIELDS = ("name", "user_code", "department_id", "role", "is_active")


def _is_active_hr(role, is_active: bool) -> bool:
    return _value(role) == UserRole.HR.value and is_active


def _other_active_hr_count(db: Session, target_id: UUID) -> int:
    """Locks the active HR rows so two HR admins can't remove each other at the same moment."""
    rows = db.exec(
        select(User)
        .where(User.role == UserRole.HR.value, User.is_active == True)  # noqa: E712
        .with_for_update()
        .execution_options(populate_existing=True)
    ).all()
    return sum(1 for u in rows if u.user_id != target_id)


@router.patch("/{user_id}")
def update_employee(
    user_id: UUID,
    body: schemas.UpdateEmployeeRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_hr_user),
) -> dict:
    """HR only. Changes name, company ID, department, role or active status. Returns the list record."""
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Employee not found.")

    wanted = {f: getattr(body, f) for f in EDITABLE_FIELDS if f in body.model_fields_set}
    if "user_code" in wanted:
        wanted["user_code"] = (wanted["user_code"] or "").strip() or None
    changes = {
        f: {"from": _value(getattr(user, f)), "to": _value(v)}
        for f, v in wanted.items()
        if _value(getattr(user, f)) != _value(v)
    }

    if changes.get("user_code", {}).get("to"):
        taken = db.exec(select(User).where(User.user_code == changes["user_code"]["to"],
                                           User.user_id != user.user_id)).first()
        if taken:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="Another account already uses this company ID.")
    dept = db.get(Department, wanted["department_id"]) if wanted.get("department_id") else None
    if wanted.get("department_id") and dept is None:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Choose a department from the list.")

    new_role = wanted.get("role", user.role)
    new_active = wanted.get("is_active", user.is_active)
    removes_hr = _is_active_hr(user.role, user.is_active) and not _is_active_hr(new_role, new_active)
    if user.user_id == current_user.user_id:
        if "is_active" in changes and not new_active:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="You can't deactivate your own account. Ask another HR admin to do it.")
        if "role" in changes:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="You can't remove your own HR access. Ask another HR admin to do it.")
    if removes_hr and _other_active_hr_count(db, user.user_id) == 0:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT,
                            detail="This is the only active HR account. Make someone else HR first.")

    if changes:
        for f, v in wanted.items():
            setattr(user, f, v)
        db.add(user)
        try:
            db.flush()
        except IntegrityError:
            # Another request took the company ID between the check above and this write.
            db.rollback()
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                                detail="Another account already uses this company ID.")
        # record_action commits the update with the log entry.
        record_action(db, AgentActionType.EMPLOYEE_UPDATED, str(current_user.user_id), None, {
            "user_id": str(user.user_id),
            "fields": sorted(changes),
            "changes": changes,
        })
        db.refresh(user)

    if dept is None and user.department_id:
        dept = db.get(Department, user.department_id)
    invite = password_tokens.invite_statuses(db, [user]).get(user.user_id)
    return _record(user, dept.name if dept else None, invite)


@router.get("/banking")
def get_banking(
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
):
    return {
        "bank_code": current_user.bank_code,
        "bank_account_number": current_user.bank_account_number,
        "bank_account_holder_name": current_user.bank_account_holder_name,
        "bank_name": None,
    }


@router.put("/banking")
def update_banking(
    body: schemas.BankingDetailsRequest,
    db: Session = Depends(deps.get_db),
    current_user: User = Depends(deps.get_current_user),
):
    current_user.bank_code = body.bank_code
    current_user.bank_account_number = body.bank_account_number
    current_user.bank_account_holder_name = body.bank_account_holder_name
    db.add(current_user)
    db.commit()
    db.refresh(current_user)
    return {
        "bank_code": current_user.bank_code,
        "bank_account_number": current_user.bank_account_number,
        "bank_account_holder_name": current_user.bank_account_holder_name,
        "bank_name": None,
    }
