from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from engine.policy.limits import (
    MAX_TRIP_DAYS, LimitKind, LimitRule, LimitUnit, TravelScope, Verdict, ZonePlace,
    applicable_rules, check_spend, estimate_trip, same_category, zone_for,
)
from engine.policy.samples import DEMO_RULES, DEMO_ZONES, RECLAIM_RULES, RECLAIM_ZONES


# --- zones -----------------------------------------------------------------

@pytest.mark.parametrize("destination,zone", [
    ("Kuala Lumpur", "1"),
    ("kuala  lumpur, Malaysia", "1"),
    ("George Town, Penang", "1"),
    ("Kota Kinabalu", "2"),
    ("Ipohville", "2"),  # whole words only
])
def test_zone_for_matches_whole_place_names_and_falls_back_to_default(destination, zone):
    assert zone_for(RECLAIM_ZONES, destination) == zone


def test_zone_for_without_destination_is_unknown():
    assert zone_for(RECLAIM_ZONES, None) is None
    assert zone_for(RECLAIM_ZONES, "  ") is None
    assert zone_for([], "Kuala Lumpur") is None


def test_same_category_ignores_case_and_spacing():
    assert same_category(" Daily  trip allowance", "Daily Trip Allowance")
    assert not same_category("Meals", "Meal")


# --- rule validation ---------------------------------------------------------

def test_actual_cost_rule_drops_any_amount():
    r = LimitRule(category="Meals", unit=LimitUnit.ACTUAL, amount=50)
    assert r.amount is None


def test_capped_rule_needs_an_amount():
    with pytest.raises(ValidationError):
        LimitRule(category="Meals", unit=LimitUnit.PER_MEAL)


def test_grade_range_must_be_in_order():
    with pytest.raises(ValidationError):
        LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=10, grade_min=5, grade_max=3)


def test_pre_approval_cannot_be_actual_cost():
    with pytest.raises(ValidationError):
        LimitRule(category="Equipment", kind=LimitKind.PRE_APPROVAL, unit=LimitUnit.ACTUAL)


def test_amount_is_rounded_to_cents_like_the_database_column():
    assert LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=99.999).amount == 100.0
    assert LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=10, currency="myr").currency == "MYR"


def test_negative_amount_is_rejected():
    with pytest.raises(ValidationError):
        LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=-1)


# --- applicable rules --------------------------------------------------------

def test_most_specific_rule_comes_first():
    rules = [
        LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=100),
        LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=60, scope=TravelScope.DOMESTIC, zone="2"),
    ]
    hits = applicable_rules(rules, category="meals", grade=3, scope=TravelScope.DOMESTIC, zone="2")
    assert [h.amount for h in hits] == [60, 100]


# --- check_spend: PT RECLAIM -------------------------------------------------

def _reclaim(**kw):
    base = dict(category="Daily Trip Allowance", grade=5, overseas=False, destination="Kuala Lumpur", amount=None)
    return check_spend(RECLAIM_RULES, RECLAIM_ZONES, **{**base, **kw})


def test_limit_only_when_no_amount_given():
    c = _reclaim()
    assert c.verdict == Verdict.LIMIT_ONLY and c.cap.amount == 75 and c.zone == "1" and c.limit_total == 75


def test_over_limit_reports_what_the_employee_pays():
    c = _reclaim(grade=6, destination="Kota Kinabalu", amount=100)
    assert c.verdict == Verdict.OVER
    assert (c.limit_total, c.reimbursable_up_to, c.employee_pays) == (75, 75, 25)


def test_over_limit_cents_do_not_drift():
    c = _reclaim(grade=6, destination="Kota Kinabalu", amount=75.1)
    assert c.employee_pays == 0.1


def test_quantity_multiplies_the_limit():
    c = _reclaim(amount=200, quantity=3)
    assert c.verdict == Verdict.WITHIN and c.limit_total == 225 and c.reimbursable_up_to == 200


def test_senior_grades_are_reimbursed_at_actual_cost():
    assert _reclaim(grade=9).verdict == Verdict.ACTUAL_COST


def test_domestic_allowance_needs_a_destination():
    assert _reclaim(destination=None).verdict == Verdict.NEED_DESTINATION


def test_grade_outside_the_table():
    assert _reclaim(grade=1).verdict == Verdict.GRADE_NOT_LISTED
    assert _reclaim(grade=None).verdict == Verdict.GRADE_NOT_LISTED


def test_grade_outside_the_table_is_reported_before_asking_for_a_destination():
    assert _reclaim(grade=1, destination=None).verdict == Verdict.GRADE_NOT_LISTED


def test_overseas_allowance_by_grade():
    c = _reclaim(grade=4, overseas=True, destination="Jakarta")
    assert c.verdict == Verdict.LIMIT_ONLY and c.cap.amount == 220


def test_overseas_hotel_has_no_amount_in_this_policy():
    c = _reclaim(category="Accommodations", grade=5, overseas=True, destination="Tokyo")
    assert c.verdict == Verdict.NO_LIMIT


def test_unknown_category_has_no_limit():
    assert _reclaim(category="Parking").verdict == Verdict.NO_LIMIT


# --- check_spend: RP-DEMO ----------------------------------------------------

def _demo(**kw):
    base = dict(grade=4, overseas=False, destination=None, amount=None)
    return check_spend(DEMO_RULES, DEMO_ZONES, **{**base, **kw})


def test_demo_hotel_cap_by_rank_over_several_nights():
    c = _demo(category="Accommodations", amount=1300, quantity=3)
    assert c.verdict == Verdict.OVER and c.limit_total == 1200 and c.employee_pays == 100


def test_demo_meal_within_cap():
    c = _demo(category="Meals", amount=80)
    assert c.verdict == Verdict.WITHIN and c.reimbursable_up_to == 80


def test_demo_equipment_above_pre_approval_amount():
    assert _demo(category="Equipment", amount=450).verdict == Verdict.NEEDS_PRE_APPROVAL
    assert _demo(category="Equipment", amount=200).verdict == Verdict.WITHIN


# --- estimate_trip -----------------------------------------------------------

def test_reclaim_trip_estimate_adds_allowance_hotel_and_intercity():
    e = estimate_trip(RECLAIM_RULES, RECLAIM_ZONES, grade=5, overseas=False, destination="Kuala Lumpur",
                      depart=date(2026, 11, 12), return_date=date(2026, 11, 14))
    assert (e.days, e.nights, e.zone) == (3, 2, "1")
    by_cat = {l.category: l for l in e.lines}
    assert by_cat["Daily Trip Allowance"].subtotal == 225
    assert by_cat["Accommodations"].subtotal == 750
    assert by_cat["Intercity Transport"].subtotal == 270
    assert e.total_up_to == 1245 and e.has_actual_cost is False and e.missing == []


def test_same_day_trip_has_no_hotel_line():
    e = estimate_trip(DEMO_RULES, DEMO_ZONES, grade=1, overseas=False, destination=None,
                      depart=date(2026, 11, 12), return_date=date(2026, 11, 12))
    assert e.nights == 0 and e.lines == []
    assert [r.category for r in e.other_limits] == ["Meals", "Equipment"]


def test_actual_cost_line_has_no_subtotal():
    e = estimate_trip(RECLAIM_RULES, RECLAIM_ZONES, grade=9, overseas=False, destination="Ipoh",
                      depart=date(2026, 11, 12), return_date=date(2026, 11, 13))
    allowance = next(l for l in e.lines if l.category == "Daily Trip Allowance")
    assert allowance.subtotal is None and e.has_actual_cost is True
    assert e.total_up_to == 680  # one night at the grade 8-10 hotel cap plus two days of intercity transport


def test_missing_destination_is_reported_not_guessed():
    e = estimate_trip(RECLAIM_RULES, RECLAIM_ZONES, grade=5, overseas=False, destination=None,
                      depart=date(2026, 11, 12), return_date=date(2026, 11, 13))
    assert e.missing == ["Daily Trip Allowance"]


def test_trip_dates_are_validated():
    with pytest.raises(ValueError, match="RETURN_BEFORE_DEPART"):
        estimate_trip(DEMO_RULES, DEMO_ZONES, grade=1, overseas=False, destination=None,
                      depart=date(2026, 11, 12), return_date=date(2026, 11, 11))
    with pytest.raises(ValueError, match="TRIP_TOO_LONG"):
        estimate_trip(DEMO_RULES, DEMO_ZONES, grade=1, overseas=False, destination=None,
                      depart=date(2026, 1, 1), return_date=date(2026, 1, 1) + timedelta(days=MAX_TRIP_DAYS))


# --- review fixes ----------------------------------------------------------------

KL_ONLY = [ZonePlace(zone="1", place="Kuala Lumpur")]
ZONED_MEAL = [LimitRule(category="Meals", unit=LimitUnit.PER_DAY, amount=50, scope=TravelScope.DOMESTIC, zone="1")]


def _zoned(destination):
    return check_spend(ZONED_MEAL, KL_ONLY, category="Meals", grade=3, overseas=False,
                       destination=destination, amount=None)


def test_a_typed_place_outside_every_zone_is_not_asked_for_again():
    assert _zoned("Kota Kinabalu").verdict == Verdict.PLACE_NOT_LISTED


def test_an_empty_destination_is_still_asked_for():
    assert _zoned(None).verdict == Verdict.NEED_DESTINATION
    assert _zoned("  ").verdict == Verdict.NEED_DESTINATION


def test_a_place_outside_every_zone_is_missing_from_the_trip_estimate():
    e = estimate_trip(ZONED_MEAL, KL_ONLY, grade=3, overseas=False, destination="Kota Kinabalu",
                      depart=date(2026, 11, 12), return_date=date(2026, 11, 13))
    assert e.missing == ["Meals"]


EQUIPMENT_ACTUAL = [
    LimitRule(category="Equipment", unit=LimitUnit.ACTUAL),
    LimitRule(category="Equipment", kind=LimitKind.PRE_APPROVAL, unit=LimitUnit.PER_ITEM, amount=300),
]


def _equipment(amount):
    return check_spend(EQUIPMENT_ACTUAL, [], category="Equipment", grade=3, overseas=False,
                       destination=None, amount=amount)


def test_actual_cost_does_not_hide_a_pre_approval_threshold():
    assert _equipment(900).verdict == Verdict.NEEDS_PRE_APPROVAL
    assert _equipment(200).verdict == Verdict.ACTUAL_COST
    assert _equipment(None).verdict == Verdict.ACTUAL_COST


def test_the_narrower_grade_range_wins_a_tie_in_specificity():
    wide = LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=80, grade_min=1, grade_max=10)
    narrow = LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=120, grade_min=4, grade_max=5)
    open_top = LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=60, grade_min=4)
    for rules in ([wide, narrow, open_top], [open_top, narrow, wide]):
        hits = applicable_rules(rules, category="Meals", grade=4, scope=TravelScope.DOMESTIC, zone=None)
        assert [h.amount for h in hits] == [120, 80, 60]


def test_the_lower_amount_wins_an_exact_tie():
    a = LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=90, grade_min=3, grade_max=5)
    b = a.model_copy(update={"amount": 70.0})
    for rules in ([a, b], [b, a]):
        c = check_spend(rules, [], category="Meals", grade=4, overseas=False, destination=None, amount=None)
        assert c.cap.amount == 70


# --- full review fixes ---------------------------------------------------------

def test_zone_matching_ignores_punctuation():
    assert zone_for(RECLAIM_ZONES, "Kuala-Lumpur") == "1"
    assert zone_for(RECLAIM_ZONES, "Shah Alam, Selangor.") == "1"


def test_the_longest_matching_place_wins():
    places = [ZonePlace(zone="1", place="Johor"), ZonePlace(zone="2", place="Johor Bahru")]
    assert zone_for(places, "Johor Bahru city centre") == "2"
    assert zone_for(places, "Johor state") == "1"


def test_trip_length_limit_is_inclusive():
    start = date(2026, 1, 1)
    e = estimate_trip(DEMO_RULES, DEMO_ZONES, grade=1, overseas=False, destination=None,
                      depart=start, return_date=start + timedelta(days=MAX_TRIP_DAYS - 1))
    assert e.days == MAX_TRIP_DAYS
    with pytest.raises(ValueError, match="TRIP_TOO_LONG"):
        estimate_trip(DEMO_RULES, DEMO_ZONES, grade=1, overseas=False, destination=None,
                      depart=start, return_date=start + timedelta(days=MAX_TRIP_DAYS))


def test_amount_cap_matches_the_numeric_12_2_column():
    assert LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=9_999_999_999.99).amount == 9_999_999_999.99
    with pytest.raises(ValidationError):
        LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=10_000_000_000)


CAP_AND_APPROVAL = [
    LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=100),
    LimitRule(category="Meals", kind=LimitKind.PRE_APPROVAL, unit=LimitUnit.PER_MEAL, amount=150),
]


def test_over_the_cap_still_carries_the_pre_approval_threshold():
    c = check_spend(CAP_AND_APPROVAL, [], category="Meals", grade=3, overseas=False, destination=None, amount=200)
    assert c.verdict == Verdict.OVER and c.employee_pays == 100
    assert c.cap.amount == 100 and c.pre_approval is not None and c.pre_approval.amount == 150
    low = check_spend(CAP_AND_APPROVAL, [], category="Meals", grade=3, overseas=False, destination=None, amount=120)
    assert low.verdict == Verdict.OVER and low.pre_approval.amount == 150


def test_a_category_with_only_a_pre_approval_rule_is_listed_in_other_limits():
    rules = [LimitRule(category="Equipment", kind=LimitKind.PRE_APPROVAL, unit=LimitUnit.PER_ITEM, amount=300)]
    e = estimate_trip(rules, [], grade=3, overseas=False, destination=None,
                      depart=date(2026, 11, 12), return_date=date(2026, 11, 14))
    assert e.lines == [] and [(r.category, r.kind) for r in e.other_limits] == [("Equipment", LimitKind.PRE_APPROVAL)]
    assert e.total_up_to == 0
