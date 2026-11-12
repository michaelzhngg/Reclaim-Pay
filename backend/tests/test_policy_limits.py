from datetime import date, timedelta

import pytest
from pydantic import ValidationError

from engine.policy.limits import (
    MAX_TRIP_DAYS, LimitKind, LimitRule, LimitUnit, TravelScope, Verdict,
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
    assert [r.category for r in e.other_limits] == ["Meals"]


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
