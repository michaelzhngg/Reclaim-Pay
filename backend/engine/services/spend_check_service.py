"""Check a cost or plan a trip against HR-confirmed policy limits. No LLM call."""
from collections import Counter
from datetime import date

from pydantic import BaseModel, Field
from sqlmodel import Session

from engine.policy.limits import (
    LimitRule, LimitUnit, SpendCheck, TravelScope, TripEstimate, ZonePlace,
    check_spend, estimate_trip, same_category, zone_for,
)
from engine.services import policy_limits_store as store

NOT_COVERED = "NOT_COVERED"


class CategoryOption(BaseModel):
    category: str
    policy_title: str
    unit: LimitUnit | None
    asks_destination: bool
    asks_overseas: bool


class SpendCheckIn(BaseModel):
    category: str = Field(min_length=1, max_length=120)
    amount: float | None = Field(default=None, ge=0, le=1_000_000)
    quantity: int = Field(default=1, ge=1, le=60)
    destination: str | None = Field(default=None, max_length=120)
    overseas: bool = False


class SpendCheckOut(SpendCheck):
    verdict: str  # a Verdict value, or NOT_COVERED
    policy_title: str | None = None
    currency: str = "MYR"
    zone_place: str | None = None  # the listed place that set the zone, "*" for the policy's default zone


class TripIn(BaseModel):
    destination: str | None = Field(default=None, max_length=120)
    overseas: bool = False
    depart: date
    return_date: date


class TripOut(TripEstimate):
    currency: str = "MYR"
    missing_reasons: dict[str, str] = Field(default_factory=dict)  # category -> the verdict that left it out
    zone_place: str | None = None


def _policy_categories(db: Session) -> list[tuple[str, str]]:
    """(category, policy title), using the same policy a claim in that category would be judged against."""
    return sorted(((c, p.title) for c, p in store.policy_for_category(db).items()), key=lambda cp: cp[0].casefold())


def _grade_ok(rule: LimitRule, grade: int | None) -> bool:
    if rule.grade_min is None and rule.grade_max is None:
        return True
    return grade is not None and (rule.grade_min is None or grade >= rule.grade_min) and (
        rule.grade_max is None or grade <= rule.grade_max)


def _zone_place(places: list[ZonePlace], destination: str | None, zone: str | None) -> str | None:
    """Which place put the destination in this zone, so an employee can spot a wrong match."""
    if zone is None:
        return None
    listed = sorted((p for p in places if p.place.strip() != "*" and p.zone == zone),
                    key=lambda p: len(p.place), reverse=True)
    return next((p.place for p in listed if zone_for([p], destination) == zone), "*")


def _currency(rules: list[LimitRule]) -> str:
    counts = Counter(r.currency for r in rules if r.amount is not None)
    return counts.most_common(1)[0][0] if counts else "MYR"


def categories_for(db: Session, grade: int | None) -> list[CategoryOption]:
    rules, _ = store.active_limits(db)
    options = []
    for category, title in _policy_categories(db):
        # Only this grade's rows decide which inputs to ask for: a grade paid actual cost has no zone question.
        mine = [r for r in rules if same_category(r.category, category) and _grade_ok(r, grade)]
        units = Counter(r.unit for r in mine)
        options.append(CategoryOption(
            category=category, policy_title=title,
            unit=units.most_common(1)[0][0] if units else None,
            asks_destination=any(r.zone is not None for r in mine),
            asks_overseas=any(r.scope != TravelScope.ANY for r in mine),
        ))
    return options


def check_cost(db: Session, grade: int | None, body: SpendCheckIn) -> SpendCheckOut:
    match = next(((c, t) for c, t in _policy_categories(db) if same_category(c, body.category)), None)
    if match is None:
        return SpendCheckOut(verdict=NOT_COVERED, category=body.category, quantity=body.quantity)
    rules, places = store.active_limits(db)
    result = check_spend(rules, places, category=match[0], grade=grade, overseas=body.overseas,
                         destination=body.destination, amount=body.amount, quantity=body.quantity)
    rule = result.cap or result.pre_approval
    # Name the zone only when a zoned rule set the rate; an overseas or flat rate ignores it.
    zoned = rule is not None and rule.zone is not None
    return SpendCheckOut(**{**result.model_dump(), "verdict": result.verdict.value},
                         policy_title=match[1], currency=rule.currency if rule else _currency(rules),
                         zone_place=_zone_place(places, body.destination, result.zone) if zoned else None)


def plan_trip(db: Session, grade: int | None, body: TripIn) -> TripOut:
    """Raises ValueError("RETURN_BEFORE_DEPART" | "TRIP_TOO_LONG")."""
    rules, places = store.active_limits(db)
    est = estimate_trip(rules, places, grade=grade, overseas=body.overseas, destination=body.destination,
                        depart=body.depart, return_date=body.return_date)

    def check(category: str) -> SpendCheck:
        return check_spend(rules, places, category=category, grade=grade, overseas=body.overseas,
                           destination=body.destination, amount=None)

    reasons = {category: check(category).verdict.value for category in est.missing}
    zoned = any((cap := check(line.category).cap) is not None and cap.zone is not None for line in est.lines)
    return TripOut(**est.model_dump(), currency=_currency(rules), missing_reasons=reasons,
                   zone_place=_zone_place(places, body.destination, est.zone) if zoned else None)
