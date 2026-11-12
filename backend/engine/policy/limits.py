"""Policy limits as data: who may spend how much on what.

Pure functions only. Callers load CONFIRMED rows from the database and pass them in, so the
pre-spend check, the trip estimate and (later) claim decisions all read the same numbers.
"""
from __future__ import annotations

import re
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from enum import Enum

from pydantic import BaseModel, Field, model_validator

MAX_TRIP_DAYS = 60


class LimitKind(str, Enum):
    CAP = "CAP"                    # reimbursed up to the amount
    PRE_APPROVAL = "PRE_APPROVAL"  # spending above the amount needs approval before buying


class LimitUnit(str, Enum):
    PER_DAY = "PER_DAY"
    PER_NIGHT = "PER_NIGHT"
    PER_MEAL = "PER_MEAL"
    PER_ITEM = "PER_ITEM"
    ACTUAL = "ACTUAL"              # reimbursed at actual cost; no amount


class TravelScope(str, Enum):
    ANY = "ANY"
    DOMESTIC = "DOMESTIC"
    OVERSEAS = "OVERSEAS"


def money(value: float) -> float:
    """Round half up to cents through Decimal, so 2.675 becomes 2.68 and float noise never shows."""
    return float(Decimal(str(value)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


class LimitRule(BaseModel):
    category: str = Field(min_length=1, max_length=120)
    kind: LimitKind = LimitKind.CAP
    unit: LimitUnit
    amount: float | None = Field(default=None, ge=0, le=9_999_999_999.99)
    currency: str = Field(default="MYR", min_length=3, max_length=3)
    grade_min: int | None = Field(default=None, ge=0, le=50)
    grade_max: int | None = Field(default=None, ge=0, le=50)
    scope: TravelScope = TravelScope.ANY
    zone: str | None = Field(default=None, min_length=1, max_length=40)
    source_section: str | None = Field(default=None, max_length=200)
    source_quote: str | None = Field(default=None, max_length=400)

    @model_validator(mode="after")
    def _check(self) -> "LimitRule":
        if self.unit == LimitUnit.ACTUAL:
            if self.kind != LimitKind.CAP:
                raise ValueError("only a cap can be at actual cost")
            self.amount = None
        elif self.amount is None:
            raise ValueError("amount is required unless the unit is ACTUAL")
        else:
            # Stored as NUMERIC(12, 2): round here so the rule we check against is the rule we save.
            self.amount = money(self.amount)
        if self.grade_min is not None and self.grade_max is not None and self.grade_min > self.grade_max:
            raise ValueError("grade_min is above grade_max")
        self.currency = self.currency.upper()
        return self


class ZonePlace(BaseModel):
    zone: str = Field(min_length=1, max_length=40)
    place: str = Field(min_length=1, max_length=120)  # "*" means every place not listed


class Verdict(str, Enum):
    WITHIN = "WITHIN"
    OVER = "OVER"
    ACTUAL_COST = "ACTUAL_COST"
    NEEDS_PRE_APPROVAL = "NEEDS_PRE_APPROVAL"
    LIMIT_ONLY = "LIMIT_ONLY"            # no amount given: here is the limit
    NO_LIMIT = "NO_LIMIT"                # the policy states no amount for this
    NEED_DESTINATION = "NEED_DESTINATION"
    PLACE_NOT_LISTED = "PLACE_NOT_LISTED"  # a destination was given but no zone lists it
    GRADE_NOT_LISTED = "GRADE_NOT_LISTED"
    WRONG_TRIP_TYPE = "WRONG_TRIP_TYPE"    # limits exist, but only for the other of domestic or overseas
    OTHER_ZONE = "OTHER_ZONE"              # the destination is in a zone this category has no limit for


class SpendCheck(BaseModel):
    verdict: Verdict
    category: str
    quantity: int = 1
    zone: str | None = None
    cap: LimitRule | None = None
    pre_approval: LimitRule | None = None
    limit_total: float | None = None
    reimbursable_up_to: float | None = None
    employee_pays: float | None = None
    zone_implied: bool = False   # every limit for this category is in one zone, so no destination was needed
    hint: str | None = None      # WRONG_TRIP_TYPE: the scope the limits are for; OTHER_ZONE: a category that covers the zone


class TripLine(BaseModel):
    category: str
    unit: LimitUnit
    rate: float | None
    quantity: int
    subtotal: float | None
    source_section: str | None = None


class TripEstimate(BaseModel):
    days: int
    nights: int
    zone: str | None
    lines: list[TripLine]
    other_limits: list[LimitRule]  # per-meal / per-item caps and approval thresholds that dates can't turn into a total
    total_up_to: float
    has_actual_cost: bool
    missing: list[str]             # categories that need a destination, a zone for it, or a row for this grade


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", s).strip().casefold()


def same_category(a: str, b: str) -> bool:
    return _norm(a) == _norm(b)


def _place_norm(s: str) -> str:
    # "Kuala-Lumpur" and "Shah Alam, Selangor." match the policy's "Kuala Lumpur" and "Shah Alam".
    return _norm(re.sub(r"[^\w\s]", " ", s))


def zone_for(places: list[ZonePlace], destination: str | None) -> str | None:
    if not destination or not destination.strip():
        return None
    d = _place_norm(destination)
    named = sorted((p for p in places if p.place.strip() != "*"), key=lambda p: -len(_place_norm(p.place)))
    for p in named:  # longest first, so "Johor Bahru" beats "Johor"
        name = _place_norm(p.place)
        if name and re.search(rf"(?<!\w){re.escape(name)}(?!\w)", d):
            return p.zone
    return next((p.zone for p in places if p.place.strip() == "*"), None)


def _has_grades(rule: LimitRule) -> bool:
    return rule.grade_min is not None or rule.grade_max is not None


def _grade_ok(rule: LimitRule, grade: int | None) -> bool:
    if not _has_grades(rule):
        return True
    if grade is None:
        return False
    return (rule.grade_min is None or grade >= rule.grade_min) and (rule.grade_max is None or grade <= rule.grade_max)


def _applies(rule: LimitRule, category: str, grade: int | None, scope: TravelScope, zone: str | None) -> bool:
    return (
        same_category(rule.category, category)
        and _grade_ok(rule, grade)
        and rule.scope in (TravelScope.ANY, scope)
        and (rule.zone is None or (zone is not None and _norm(rule.zone) == _norm(zone)))
    )


def _specificity(rule: LimitRule) -> int:
    return (
        (4 if rule.zone is not None else 0)
        + (2 if rule.scope != TravelScope.ANY else 0)
        + (1 if _has_grades(rule) else 0)
    )


_GRADE_FLOOR, _GRADE_CEILING = 0, 50


def _rank(rule: LimitRule) -> tuple:
    # Ties go to the narrower grade range (an open bound counts as wide), then to the lower amount.
    span = (rule.grade_max if rule.grade_max is not None else _GRADE_CEILING) - (
        rule.grade_min if rule.grade_min is not None else _GRADE_FLOOR)
    amount = rule.amount if rule.amount is not None else float("inf")
    return (-_specificity(rule), span, amount)


def applicable_rules(rules: list[LimitRule], *, category: str, grade: int | None,
                     scope: TravelScope, zone: str | None) -> list[LimitRule]:
    """Rules that apply to this person and trip, most specific first."""
    hits = [r for r in rules if _applies(r, category, grade, scope, zone)]
    return sorted(hits, key=_rank)


def _only_zone(rules: list[LimitRule]) -> str | None:
    """The zone when every rule names the same one, else None."""
    zones = {_norm(r.zone) for r in rules if r.zone is not None}
    return rules[0].zone if len(zones) == 1 and all(r.zone is not None for r in rules) else None


def _category_for_zone(rules: list[LimitRule], *, category: str, grade: int | None,
                       scope: TravelScope, zone: str) -> str | None:
    """Another category with a limit for this zone, preferring the one whose name shares most words."""
    words = set(_norm(category).split())
    names = {r.category for r in rules if not same_category(r.category, category) and _grade_ok(r, grade)
             and r.scope in (TravelScope.ANY, scope) and r.zone is not None and _norm(r.zone) == _norm(zone)}
    return max(sorted(names), key=lambda n: len(words & set(_norm(n).split())), default=None)


def check_spend(rules: list[LimitRule], places: list[ZonePlace], *, category: str, grade: int | None,
                overseas: bool, destination: str | None, amount: float | None, quantity: int = 1,
                imply_zone: bool = True) -> SpendCheck:
    quantity = max(1, quantity)
    scope = TravelScope.OVERSEAS if overseas else TravelScope.DOMESTIC
    zone = zone_for(places, destination)
    base = {"category": category, "quantity": quantity, "zone": zone}

    in_category = [r for r in rules if same_category(r.category, category)]
    in_scope = [r for r in in_category if r.scope in (TravelScope.ANY, scope)]
    if not in_category:
        return SpendCheck(verdict=Verdict.NO_LIMIT, **base)
    if not in_scope:
        other = TravelScope.DOMESTIC if overseas else TravelScope.OVERSEAS
        return SpendCheck(verdict=Verdict.WRONG_TRIP_TYPE, hint=other.value, **base)
    # Grade first: asking for a destination is pointless when no row lists this grade anyway.
    mine = [r for r in in_scope if _grade_ok(r, grade)]
    if not mine:
        return SpendCheck(verdict=Verdict.GRADE_NOT_LISTED, **base)
    only = _only_zone(mine)
    if zone is None and only is not None and imply_zone and not (destination and destination.strip()):
        zone = only
        base.update(zone=zone, zone_implied=True)
    hits = applicable_rules(in_scope, category=category, grade=grade, scope=scope, zone=zone)
    if not hits:
        if zone is None and any(r.zone is not None for r in mine):
            typed = bool(destination and destination.strip())
            return SpendCheck(verdict=Verdict.PLACE_NOT_LISTED if typed else Verdict.NEED_DESTINATION, **base)
        if zone is not None and any(r.zone is not None for r in mine):
            hint = _category_for_zone(rules, category=category, grade=grade, scope=scope, zone=zone)
            return SpendCheck(verdict=Verdict.OTHER_ZONE, hint=hint, **base)
        return SpendCheck(verdict=Verdict.NO_LIMIT, **base)

    cap = next((r for r in hits if r.kind == LimitKind.CAP), None)
    pre = next((r for r in hits if r.kind == LimitKind.PRE_APPROVAL), None)
    base.update(cap=cap, pre_approval=pre)
    if cap is not None and cap.unit == LimitUnit.ACTUAL:
        if amount is not None and pre is not None and money(amount) > money(pre.amount * quantity):
            return SpendCheck(verdict=Verdict.NEEDS_PRE_APPROVAL, **base)
        return SpendCheck(verdict=Verdict.ACTUAL_COST, **base)

    limit_total = money(cap.amount * quantity) if cap is not None else None
    if amount is None:
        return SpendCheck(verdict=Verdict.LIMIT_ONLY, limit_total=limit_total, **base)
    amount = money(amount)
    if limit_total is not None and amount > limit_total:
        return SpendCheck(verdict=Verdict.OVER, limit_total=limit_total, reimbursable_up_to=limit_total,
                          employee_pays=money(amount - limit_total), **base)
    if pre is not None and amount > money(pre.amount * quantity):
        return SpendCheck(verdict=Verdict.NEEDS_PRE_APPROVAL, limit_total=limit_total, **base)
    return SpendCheck(verdict=Verdict.WITHIN, limit_total=limit_total, reimbursable_up_to=amount, **base)


def _categories(rules: list[LimitRule]) -> list[str]:
    seen: list[str] = []
    for r in rules:
        if not any(same_category(r.category, s) for s in seen):
            seen.append(r.category)
    return seen


def estimate_trip(rules: list[LimitRule], places: list[ZonePlace], *, grade: int | None, overseas: bool,
                  destination: str | None, depart: date, return_date: date) -> TripEstimate:
    """The most the policy allows for a trip. Not an approval."""
    if return_date < depart:
        raise ValueError("RETURN_BEFORE_DEPART")
    nights = (return_date - depart).days
    days = nights + 1
    if days > MAX_TRIP_DAYS:
        raise ValueError("TRIP_TOO_LONG")

    lines: list[TripLine] = []
    other: list[LimitRule] = []
    missing: list[str] = []
    # Zone-split categories (one per zone) would all count without a destination, so only the
    # catch-all zone is assumed, and only abroad, where the listed places don't apply.
    catch_all = next((p.zone for p in places if p.place.strip() == "*"), None)
    for category in _categories(rules):
        only = _only_zone([r for r in rules if same_category(r.category, category) and _grade_ok(r, grade)])
        imply = overseas and only is not None and catch_all is not None and _norm(only) == _norm(catch_all)
        c = check_spend(rules, places, category=category, grade=grade, overseas=overseas,
                        destination=destination, amount=None, imply_zone=imply)
        if c.verdict == Verdict.WRONG_TRIP_TYPE or (c.verdict == Verdict.OTHER_ZONE and c.hint):
            continue  # the other trip type, or another category, covers it
        if c.verdict in (Verdict.NEED_DESTINATION, Verdict.PLACE_NOT_LISTED, Verdict.GRADE_NOT_LISTED,
                         Verdict.OTHER_ZONE):
            missing.append(category)
            continue
        cap = c.cap
        if cap is None:
            if c.pre_approval is not None:
                other.append(c.pre_approval)  # approval threshold only: no total, but the employee should see it
            continue
        if cap.unit == LimitUnit.ACTUAL:
            lines.append(TripLine(category=cap.category, unit=cap.unit, rate=None, quantity=days,
                                  subtotal=None, source_section=cap.source_section))
            continue
        qty = days if cap.unit == LimitUnit.PER_DAY else nights if cap.unit == LimitUnit.PER_NIGHT else None
        if qty is None:
            other.append(cap)
            continue
        if qty == 0:
            continue
        lines.append(TripLine(category=cap.category, unit=cap.unit, rate=cap.amount, quantity=qty,
                              subtotal=money(cap.amount * qty), source_section=cap.source_section))

    return TripEstimate(
        days=days, nights=nights, zone=zone_for(places, destination), lines=lines, other_limits=other,
        total_up_to=money(sum(l.subtotal or 0 for l in lines)),
        has_actual_cost=any(l.subtotal is None for l in lines), missing=missing,
    )
