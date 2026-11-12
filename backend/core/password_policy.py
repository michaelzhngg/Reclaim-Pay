"""Rules for passwords set through the invite and reset flows. Login never applies them, so older passwords keep working.

frontend/lib/passwordPolicy.ts mirrors these rules; change both together.
"""
import re

MIN_LENGTH = 8
# bcrypt only reads the first 72 bytes and the installed version refuses longer input.
MAX_BYTES = 72

TOO_LONG = (
    f"Use a shorter password. The limit is {MAX_BYTES} bytes, "
    "and emoji or accented letters count as more than one."
)

_RULES = (
    (lambda p: len(p) >= MIN_LENGTH, f"Use at least {MIN_LENGTH} characters."),
    (lambda p: re.search(r"[A-Z]", p) is not None, "Add an uppercase letter."),
    (lambda p: re.search(r"[a-z]", p) is not None, "Add a lowercase letter."),
    (lambda p: re.search(r"[0-9]", p) is not None, "Add a number."),
    (lambda p: re.search(r"[^A-Za-z0-9\s]", p) is not None, "Add a special character, such as ! or #."),
    (lambda p: len(p.encode("utf-8")) <= MAX_BYTES, TOO_LONG),
)


def password_problems(password: str) -> list[str]:
    return [message for check, message in _RULES if not check(password or "")]
