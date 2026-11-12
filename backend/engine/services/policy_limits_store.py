"""Reads and writes policy limits. Only CONFIRMED rows reach employees."""
from datetime import datetime
from uuid import UUID

from sqlalchemy import delete
from sqlmodel import Session, select

from core.enums import AgentActionType, LimitStatus, PolicyStatus
from core.models import Policy, PolicyLimit, PolicyReimbursableCategory, PolicyZonePlace
from engine.policy.limits import LimitRule, ZonePlace, same_category
from engine.services.action_log import record_action


def to_rule(row: PolicyLimit) -> LimitRule:
    return LimitRule(
        category=row.category, kind=row.kind, unit=row.unit,
        amount=float(row.amount) if row.amount is not None else None, currency=row.currency,
        grade_min=row.grade_min, grade_max=row.grade_max, scope=row.scope, zone=row.zone,
        source_section=row.source_section, source_quote=row.source_quote,
    )


def _status(value) -> str:
    return value.value if hasattr(value, "value") else str(value)


def list_rows(db: Session, policy_id: UUID) -> tuple[list[PolicyLimit], list[PolicyZonePlace]]:
    limits = db.exec(select(PolicyLimit).where(PolicyLimit.policy_id == policy_id)
                     .order_by(PolicyLimit.category, PolicyLimit.scope, PolicyLimit.zone.asc().nulls_first(),
                               PolicyLimit.grade_min.asc().nulls_first(), PolicyLimit.grade_max.asc().nulls_last(),
                               PolicyLimit.created_at)).all()
    places = db.exec(select(PolicyZonePlace).where(PolicyZonePlace.policy_id == policy_id)
                     .order_by(PolicyZonePlace.zone, PolicyZonePlace.place)).all()
    return list(limits), list(places)


def load_limits(db: Session, policy_id: UUID, *, confirmed_only: bool = True) -> tuple[list[LimitRule], list[ZonePlace]]:
    limits, places = list_rows(db, policy_id)
    keep = (lambda s: _status(s) == LimitStatus.CONFIRMED.value) if confirmed_only else (lambda s: True)
    return (
        [to_rule(r) for r in limits if keep(r.status)],
        [ZonePlace(zone=p.zone, place=p.place) for p in places if keep(p.status)],
    )


def policy_for_category(db: Session) -> dict[str, Policy]:
    """Category (as the policy spells it) -> the ACTIVE policy claims are judged against.

    Must mirror the claim pipeline's choice in api/reimbursements.py (around line 776):
    ACTIVE policies listing the category, newest effective_date first, then newest created_at.
    """
    rows = db.exec(
        select(PolicyReimbursableCategory.category, Policy)
        .join(Policy, PolicyReimbursableCategory.policy_id == Policy.policy_id)
        .where(Policy.status == PolicyStatus.ACTIVE)
        .order_by(Policy.effective_date.desc(), Policy.created_at.desc())
    ).all()
    picked: dict[str, Policy] = {}
    for category, policy in rows:
        picked.setdefault(category, policy)
    return picked


def active_limits(db: Session) -> tuple[list[LimitRule], list[ZonePlace]]:
    """Confirmed limits for every category, each taken from the policy claims would use for it."""
    won: dict[UUID, list[str]] = {}
    for category, policy in policy_for_category(db).items():
        won.setdefault(policy.policy_id, []).append(category)
    rules: list[LimitRule] = []
    places: list[ZonePlace] = []
    for policy_id, categories in won.items():
        r, p = load_limits(db, policy_id)
        mine = [rule for rule in r if any(same_category(rule.category, c) for c in categories)]
        rules += mine
        # Zone lists are per policy; two contributing policies with clashing zone names are not reconciled.
        if mine:
            places += [z for z in p if z not in places]
    return rules, places


def _rule_key(rule: LimitRule) -> tuple:
    d = rule.model_dump(exclude={"source_section", "source_quote", "category"})
    return (" ".join(rule.category.split()).casefold(), *sorted(d.items()))


def _place_key(place: ZonePlace) -> tuple:
    return (place.zone.strip().casefold(), " ".join(place.place.split()).casefold())


def _rows(policy_id: UUID, rules: list[LimitRule], places: list[ZonePlace], status: LimitStatus,
          actor_id: UUID | None = None, now: datetime | None = None) -> list:
    confirmed = status == LimitStatus.CONFIRMED
    limit_rows = [
        PolicyLimit(policy_id=policy_id, status=status,
                    confirmed_by=actor_id if confirmed else None, confirmed_at=now if confirmed else None,
                    **{**r.model_dump(), "kind": r.kind.value, "unit": r.unit.value, "scope": r.scope.value})
        for r in rules
    ]
    place_rows = [PolicyZonePlace(policy_id=policy_id, zone=p.zone, place=p.place, status=status) for p in places]
    return limit_rows + place_rows


def replace_proposed(db: Session, policy_id: UUID, rules: list[LimitRule], places: list[ZonePlace]) -> int:
    """Swap the suggested rows for a new set and return how many limits were suggested. Caller commits.

    Confirmed rows stay. A suggestion that repeats a confirmed row (or another suggestion) is skipped,
    so re-reading the policy after HR confirmed does not list every limit twice.
    """
    for model in (PolicyLimit, PolicyZonePlace):
        db.exec(delete(model).where(model.policy_id == policy_id, model.status == LimitStatus.PROPOSED.value))
    confirmed_rules, confirmed_places = load_limits(db, policy_id)
    seen_rules = {_rule_key(r) for r in confirmed_rules}
    seen_places = {_place_key(p) for p in confirmed_places}
    new_rules: list[LimitRule] = []
    for r in rules:
        if _rule_key(r) not in seen_rules:
            seen_rules.add(_rule_key(r))
            new_rules.append(r)
    new_places: list[ZonePlace] = []
    for p in places:
        if _place_key(p) not in seen_places:
            seen_places.add(_place_key(p))
            new_places.append(p)
    db.add_all(_rows(policy_id, new_rules, new_places, LimitStatus.PROPOSED))
    return len(new_rules)


def confirm_all(db: Session, policy_id: UUID, rules: list[LimitRule], places: list[ZonePlace],
                actor_id: UUID | None, now: datetime) -> None:
    """HR's checked set replaces every row for the policy. Logged in the hash-chained action log."""
    delete_for_policy(db, policy_id)
    db.add_all(_rows(policy_id, rules, places, LimitStatus.CONFIRMED, actor_id, now))
    record_action(db, AgentActionType.POLICY_LIMITS_CHANGED, str(actor_id) if actor_id else "seed", None,
                  {"policy_id": str(policy_id), "limits": len(rules), "zone_places": len(places)})


def delete_for_policy(db: Session, policy_id: UUID) -> None:
    """Remove every limit and zone row of a policy, for example before the policy itself is deleted. Caller commits."""
    for model in (PolicyLimit, PolicyZonePlace):
        db.exec(delete(model).where(model.policy_id == policy_id))
