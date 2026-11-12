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


# Brand colours from DESIGN.md. Email clients ignore CSS variables, so they are written out here.
INK = "#0b0b1e"
MUTED = "#5c5c72"
PAPER = "#f5f5f9"
LINE = "#e6e6ee"
ACCENT = "#4647d3"
FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif"


def logo_url() -> str:
    # A PNG the site already serves; Gmail and Outlook don't show SVG.
    return settings.FRONTEND_PUBLIC_URL.rstrip("/") + "/icons/icon-192x192.png"


def _paragraphs(text: str) -> str:
    out = []
    for part in text.split("\n\n"):
        lines = "<br>".join(html.escape(line) for line in part.split("\n"))
        out.append(f'<p style="margin:0 0 14px;font-size:15px;line-height:1.6;color:{INK}">{lines}</p>')
    return "".join(out)


def render_html(subject: str, text: str, url: str | None, link_label: str) -> str:
    """Branded, table-based layout so it holds together in Gmail, Outlook and Apple Mail."""
    first_line = text.split("\n", 1)[0]
    button = ""
    fallback = ""
    if url:
        href = html.escape(url, quote=True)
        button = (
            '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 4px">'
            f'<tr><td align="center" bgcolor="{INK}" style="border-radius:10px">'
            f'<a href="{href}" target="_blank" style="display:block;padding:14px 24px;font-family:{FONT};'
            f'font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:10px">'
            f"{html.escape(link_label)}</a></td></tr></table>"
        )
        fallback = (
            f'<p style="margin:18px 0 0;font-size:12px;line-height:1.5;color:{MUTED}">'
            "If the button doesn&#39;t work, paste this link into your browser:<br>"
            f'<a href="{href}" style="color:{ACCENT};word-break:break-all">{html.escape(url)}</a></p>'
        )
    return (
        '<!doctype html><html lang="en"><head><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">'
        f"<title>{html.escape(subject)}</title></head>"
        f'<body style="margin:0;padding:0;background:{PAPER}">'
        # Inbox preview text, hidden in the body.
        f'<div style="display:none;max-height:0;overflow:hidden;opacity:0">{html.escape(first_line)}</div>'
        f'<table role="presentation" width="100%" cellpadding="0" cellspacing="0" bgcolor="{PAPER}" style="background:{PAPER}">'
        '<tr><td align="center" style="padding:32px 16px">'
        '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px">'
        # Logo and wordmark
        '<tr><td align="center" style="padding:0 0 20px">'
        '<table role="presentation" cellpadding="0" cellspacing="0"><tr>'
        f'<td style="padding-right:10px"><img src="{html.escape(logo_url(), quote=True)}" width="36" height="36" '
        'alt="" style="display:block;border:0;border-radius:8px"></td>'
        f'<td style="font-family:{FONT};font-size:20px;font-weight:700;letter-spacing:-0.3px;color:{INK}">'
        f'Reclaim <span style="color:{ACCENT}">Pay</span></td>'
        "</tr></table></td></tr>"
        # Card
        f'<tr><td bgcolor="#ffffff" style="background:#ffffff;border:1px solid {LINE};border-radius:16px;'
        f'padding:28px 28px 24px;font-family:{FONT}">'
        f'<h1 style="margin:0 0 16px;font-size:20px;line-height:1.3;font-weight:700;color:{INK}">{html.escape(subject)}</h1>'
        f"{_paragraphs(text)}{button}{fallback}"
        "</td></tr>"
        # Footer
        f'<tr><td align="center" style="padding:20px 8px 0;font-family:{FONT};font-size:12px;line-height:1.5;color:{MUTED}">'
        "Reclaim Pay &middot; expense claims paid to PayPal<br>"
        "You got this email because of your Reclaim Pay account."
        "</td></tr>"
        "</table></td></tr></table></body></html>"
    )


def build_payload(to: str, subject: str, text: str, link: str | None = None,
                  link_label: str = DEFAULT_LINK_LABEL) -> dict:
    url = _absolute(link)
    plain = text if not url else f"{text}\n\n{link_label}: {url}"
    return {
        "from": settings.EMAIL_FROM,
        "to": [to],
        "subject": subject,
        "text": plain,
        "html": render_html(subject, text, url, link_label),
    }


def _error_message(response: httpx.Response) -> str:
    try:
        return str(response.json().get("message", ""))[:300]
    except ValueError:
        return response.text[:300]


def send_email_result(to: str, subject: str, text: str, link: str | None = None,
                      link_label: str = DEFAULT_LINK_LABEL) -> tuple[str, str | None]:
    """Send now and say what happened: ("sent", None), ("off", None) or ("failed", reason).

    The reason is safe to show to HR: it never contains the API key.
    """
    global _no_key_logged
    key = settings.RESEND_API_KEY
    if not key:
        if not _no_key_logged:
            logger.warning("[EMAIL] RESEND_API_KEY is not set, email is off")
            _no_key_logged = True
        return "off", None
    if not to:
        return "failed", "There is no email address."
    try:
        response = httpx.post(
            RESEND_URL,
            json=build_payload(to, subject, text, link, link_label),
            headers={"Authorization": f"Bearer {key}"},
            timeout=TIMEOUT_SECONDS,
        )
    except Exception as exc:
        logger.warning("[EMAIL] Resend request failed: %s", type(exc).__name__)
        return "failed", "Resend could not be reached."
    if response.status_code >= 400:
        message = _error_message(response)
        logger.warning("[EMAIL] Resend answered %s: %s", response.status_code, message)
        if response.status_code in (401, 403) and "domain" not in message.lower():
            return "failed", "Resend refused the API key."
        return "failed", message or f"Resend answered {response.status_code}."
    return "sent", None


def send_email_sync(to: str, subject: str, text: str, link: str | None = None,
                    link_label: str = DEFAULT_LINK_LABEL) -> bool:
    """Returns True when Resend accepted the email."""
    return send_email_result(to, subject, text, link, link_label)[0] == "sent"


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
