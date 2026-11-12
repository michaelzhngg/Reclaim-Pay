import math
import time

from fastapi.responses import JSONResponse
from starlette.requests import Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.util import get_remote_address
from jose import jwt, JWTError

from core.config import settings

# ─── Limits (per user, keyed by the verified JWT email; per IP when signed out) ──
# Several limits in one string are separated by ";" and all apply.
#
# Demo budget: one full take (S1 to S7) costs employee@ about 11 uploads and 11
# analyses (S1, S2, S3, S4 + backup, S6a, S6b, 4 flood claims) and employee2@ about
# 5. The daily ceilings leave room for well over 15 takes a day.

# OCR + AI analysis: the two endpoints that spend LLM credit.
ANALYZE_LIMIT = "5/minute;200/day"
UPLOAD_LIMIT = "10/minute;300/day"
# Draft create and update share one budget. The claim form has no autosave: a draft
# is written only by the Save Draft button or the leave-page dialog.
DRAFT_SAVE_LIMIT = "30/minute"
# Receipt corrections (POST .../edits and PATCH .../fields share one budget). The
# claim form sends one edit per changed receipt when the employee presses Submit.
DOCUMENT_EDIT_LIMIT = "60/minute"
TEMPLATE_LIMIT = "10/minute"
AUTH_LIMIT = "10/minute"
PAYPAL_CONNECT_LIMIT = "10/minute"
PAYPAL_WEBHOOK_RETRY_LIMIT = "10/minute"
POLICY_UPLOAD_LIMIT = "3/minute"

# First sentence of the 429 message; the handler adds when to try again.
ANALYZE_MESSAGE = "Too many claim submissions."
UPLOAD_MESSAGE = "Too many receipt uploads."
DRAFT_SAVE_MESSAGE = "Too many draft saves."
DOCUMENT_EDIT_MESSAGE = "Too many receipt edits."
DEFAULT_MESSAGE = "Too many requests."


def _get_user_identity(request: Request) -> str:
    """Rate-limit key: verified JWT email for authenticated requests, IP address otherwise."""
    auth = request.headers.get("Authorization", "")
    if auth.startswith("Bearer "):
        token = auth[7:]
        try:
            payload = jwt.decode(token, settings.SECRET_KEY, algorithms=[settings.ALGORITHM])
            email: str = payload.get("sub")
            if email:
                return f"user:{email}"
        except JWTError:
            pass
    return get_remote_address(request)


# NOTE: Uses in-memory storage per-process. With multiple uvicorn workers or
# multiple containers, each process maintains its own counter — effective limit
# becomes limit × N workers. Switch to a Redis backend for multi-process deployments.
limiter = Limiter(key_func=_get_user_identity)


def _retry_after_seconds(request: Request, exc: RateLimitExceeded) -> int:
    """Seconds until the window of the limit that was hit resets."""
    try:
        item, args = request.state.view_rate_limit
        reset_at, _ = request.app.state.limiter.limiter.get_window_stats(item, *args)
        return max(1, math.ceil(reset_at - time.time()))
    except Exception:
        return exc.limit.limit.get_expiry()


def _try_again_in(seconds: int) -> str:
    if seconds <= 90:
        return "Try again in about a minute."
    if seconds < 3600:
        return f"Try again in about {round(seconds / 60)} minutes."
    hours = round(seconds / 3600)
    return f"Try again in about {hours} hour{'s' if hours != 1 else ''}."


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> JSONResponse:
    """429 with a Retry-After header and a plain message.

    The message goes in both `error` (slowapi's field) and `detail` (FastAPI's), so
    clients reading either keep working.
    """
    retry_after = _retry_after_seconds(request, exc)
    lead = exc.limit.error_message if isinstance(exc.limit.error_message, str) else DEFAULT_MESSAGE
    message = f"{lead} {_try_again_in(retry_after)}"
    return JSONResponse(
        {"error": message, "detail": message},
        status_code=429,
        headers={"Retry-After": str(retry_after)},
    )
