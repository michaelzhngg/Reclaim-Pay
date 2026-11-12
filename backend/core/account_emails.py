"""Copy for the account emails: invitation, password reset and the changed-password notice."""
from core.config import settings
from core.email_service import fire_and_forget_email

INVITE_SUBJECT = "Set up your Reclaim Pay account"
RESET_SUBJECT = "Reset your Reclaim Pay password"
CHANGED_SUBJECT = "Your Reclaim Pay password was changed"


def invite_link(token: str) -> str:
    return f"{settings.FRONTEND_PUBLIC_URL.rstrip('/')}/set-password?token={token}"


def reset_link(token: str) -> str:
    return f"{settings.FRONTEND_PUBLIC_URL.rstrip('/')}/reset-password?token={token}"


def _hello(name: str) -> str:
    return f"Hi {name.strip() or 'there'},"


def invite_text(name: str) -> str:
    return (
        f"{_hello(name)}\n\n"
        "HR created a Reclaim Pay account for you. Use the link below to set your password. "
        "The link works for 7 days.\n\n"
        "If you weren't expecting this email, you can ignore it."
    )


def reset_text(name: str) -> str:
    return (
        f"{_hello(name)}\n\n"
        "We got a request to reset the password for your Reclaim Pay account. "
        "Use the link below to choose a new one. The link works for 30 minutes.\n\n"
        "If you didn't ask for this, ignore this email. Your password stays the same."
    )


def changed_text(name: str) -> str:
    return (
        f"{_hello(name)}\n\n"
        "The password for your Reclaim Pay account was just changed. "
        "If this wasn't you, contact HR straight away."
    )


def send_invite(email: str, name: str, token: str) -> None:
    fire_and_forget_email(email, INVITE_SUBJECT, invite_text(name), link=invite_link(token),
                          link_label="Set your password")


def send_reset(email: str, name: str, token: str) -> None:
    fire_and_forget_email(email, RESET_SUBJECT, reset_text(name), link=reset_link(token),
                          link_label="Choose a new password")


def send_changed_notice(email: str, name: str) -> None:
    fire_and_forget_email(email, CHANGED_SUBJECT, changed_text(name))
