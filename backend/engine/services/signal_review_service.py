"""HR verdicts on Receipt Shield signals, and how accurate each check has been (R1a).

Labels only: nothing here changes a decision, a score or a trust level.
"""
from collections import defaultdict

from pydantic import BaseModel

from core.enums import SignalVerdict

MIN_REVIEWS = 10


class SignalOutcome(BaseModel):
    code: str
    verdict: SignalVerdict | None
    # HR approved the whole claim while the signal fired: a weak "probably false" label.
    approved_in_full: bool
    rejected: bool


class SignalQuality(BaseModel):
    code: str
    fired: int
    confirmed: int
    false_alarm: int
    unreviewed: int
    approved_in_full: int
    rejected: int
    # confirmed / rated, only once at least MIN_REVIEWS were rated: a 1-of-1 "100%" misleads.
    precision: float | None


def tally(outcomes: list[SignalOutcome]) -> list[SignalQuality]:
    counts: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for o in outcomes:
        c = counts[o.code]
        c["fired"] += 1
        if o.verdict == SignalVerdict.CONFIRMED:
            c["confirmed"] += 1
        elif o.verdict == SignalVerdict.FALSE_ALARM:
            c["false_alarm"] += 1
        else:
            c["unreviewed"] += 1
        c["approved_in_full"] += int(o.approved_in_full)
        c["rejected"] += int(o.rejected)
    rows = []
    for code, c in counts.items():
        rated = c["confirmed"] + c["false_alarm"]
        rows.append(SignalQuality(
            code=code, fired=c["fired"], confirmed=c["confirmed"], false_alarm=c["false_alarm"],
            unreviewed=c["unreviewed"], approved_in_full=c["approved_in_full"], rejected=c["rejected"],
            precision=round(c["confirmed"] / rated, 3) if rated >= MIN_REVIEWS else None,
        ))
    return sorted(rows, key=lambda r: (-r.fired, r.code))
