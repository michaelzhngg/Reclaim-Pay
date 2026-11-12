"""Transactional email through Resend's HTTP API.

Sending never raises into the caller: a missing key, a timeout or an error answer is logged and dropped.
"""
import html
import logging
import threading

import httpx

from core.config import settings

logger = logging.getLogger(__name__)

RESEND_URL = "https://api.resend.com/emails"
TIMEOUT_SECONDS = 5.0
DEFAULT_LINK_LABEL = "Open Reclaim Pay"

_no_key_logged = False


def _absolute(link: str | None) -> str | None:
    if not link:
        return None
    if link.startswith("http://") or link.startswith("https://"):
        return link
    return settings.FRONTEND_PUBLIC_URL.rstrip("/") + "/" + link.lstrip("/")


def build_payload(to: str, subject: str, text: str, link: str | None = None,
                  link_label: str = DEFAULT_LINK_LABEL) -> dict:
    url = _absolute(link)
    plain = text if not url else f"{text}\n\n{link_label}: {url}"
    body = "".join(f"<p>{html.escape(part)}</p>" for part in text.split("\n\n"))
    if url:
        body += f'<p><a href="{html.escape(url, quote=True)}">{html.escape(link_label)}</a></p>'
    return {
        "from": settings.EMAIL_FROM,
        "to": [to],
        "subject": subject,
        "text": plain,
        "html": f'<div style="font-family:sans-serif;font-size:15px;line-height:1.5">{body}</div>',
    }


def _error_message(response: httpx.Response) -> str:
    try:
        return str(response.json().get("message", ""))[:300]
    except ValueError:
        return response.text[:300]


def send_email_sync(to: str, subject: str, text: str, link: str | None = None,
                    link_label: str = DEFAULT_LINK_LABEL) -> bool:
    """Returns True when Resend accepted the email."""
    global _no_key_logged
    key = settings.RESEND_API_KEY
    if not key:
        if not _no_key_logged:
            logger.info("[EMAIL] RESEND_API_KEY is not set, email is off")
            _no_key_logged = True
        return False
    if not to:
        return False
    try:
        response = httpx.post(
            RESEND_URL,
            json=build_payload(to, subject, text, link, link_label),
            headers={"Authorization": f"Bearer {key}"},
            timeout=TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning("[EMAIL] Resend request failed: %s", type(exc).__name__)
        return False
    if response.status_code >= 400:
        logger.warning("[EMAIL] Resend answered %s: %s", response.status_code, _error_message(response))
        return False
    return True


def fire_and_forget_email(to: str, subject: str, text: str, link: str | None = None,
                          link_label: str = DEFAULT_LINK_LABEL) -> None:
    """Send on a daemon thread so the request path never waits on Resend."""
    if not settings.RESEND_API_KEY:
        send_email_sync(to, subject, text, link, link_label)
        return
    try:
        threading.Thread(target=send_email_sync, args=(to, subject, text, link, link_label), daemon=True).start()
    except Exception:
        logger.exception("[EMAIL] Could not start the send thread")
