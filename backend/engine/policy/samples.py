"""Limits transcribed by hand from two known policies.

DEMO_*: demo/policy/reclaim-pay-demo-policy.md (RP-DEMO-2026). seeds/seed_policy_limits.py writes these.
RECLAIM_*: docs/policy_example (PT RECLAIM Business Travel Policy HR 3.06, Appendix 1). Used by tests only.
  Appendix 1 is a rotated table; the domestic allowance grade split (3-5 vs 6-7) is our reading of it
  and must be confirmed by HR before this policy is used for real.
"""
from engine.policy.limits import LimitKind, LimitRule, LimitUnit, TravelScope, ZonePlace

DEMO_RULES: list[LimitRule] = [
    LimitRule(category="Accommodations", unit=LimitUnit.PER_NIGHT, amount=250, grade_max=2,
              source_section="3.3 Accommodations", source_quote="Rank 1 and 2 | 250"),
    LimitRule(category="Accommodations", unit=LimitUnit.PER_NIGHT, amount=400, grade_min=3, grade_max=4,
              source_section="3.3 Accommodations", source_quote="Rank 3 and 4 | 400"),
    LimitRule(category="Accommodations", unit=LimitUnit.PER_NIGHT, amount=600, grade_min=5,
              source_section="3.3 Accommodations", source_quote="Rank 5 and above | 600"),
    LimitRule(category="Meals", unit=LimitUnit.PER_MEAL, amount=100,
              source_section="3.2 Meals", source_quote="Meals above RM100 are reviewed by HR and may be reimbursed only up to RM100."),
    LimitRule(category="Equipment", kind=LimitKind.PRE_APPROVAL, unit=LimitUnit.PER_ITEM, amount=300,
              source_section="3.4 Equipment", source_quote="Equipment above RM300 needs a purchase request approved by HR before it is bought."),
]
DEMO_ZONES: list[ZonePlace] = []

_APX = "Appendix 1"
RECLAIM_RULES: list[LimitRule] = [
    # Domestic daily trip allowance by zone
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.PER_DAY, amount=75, grade_min=3, grade_max=5,
              scope=TravelScope.DOMESTIC, zone="1", source_section=f"{_APX}, Domestic, Daily Trip Allowance"),
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.PER_DAY, amount=90, grade_min=6, grade_max=7,
              scope=TravelScope.DOMESTIC, zone="1", source_section=f"{_APX}, Domestic, Daily Trip Allowance"),
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.PER_DAY, amount=60, grade_min=3, grade_max=5,
              scope=TravelScope.DOMESTIC, zone="2", source_section=f"{_APX}, Domestic, Daily Trip Allowance"),
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.PER_DAY, amount=75, grade_min=6, grade_max=7,
              scope=TravelScope.DOMESTIC, zone="2", source_section=f"{_APX}, Domestic, Daily Trip Allowance"),
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.ACTUAL, grade_min=8, grade_max=10,
              scope=TravelScope.DOMESTIC, source_section=f"{_APX}, Domestic, Daily Trip Allowance",
              source_quote="Full Reimbursement"),
    # Overseas daily trip allowance
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.PER_DAY, amount=200, grade_min=3, grade_max=3,
              scope=TravelScope.OVERSEAS, source_section=f"{_APX}, Overseas, Daily Trip Allowance"),
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.PER_DAY, amount=220, grade_min=4, grade_max=5,
              scope=TravelScope.OVERSEAS, source_section=f"{_APX}, Overseas, Daily Trip Allowance"),
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.PER_DAY, amount=240, grade_min=6, grade_max=7,
              scope=TravelScope.OVERSEAS, source_section=f"{_APX}, Overseas, Daily Trip Allowance"),
    LimitRule(category="Daily Trip Allowance", unit=LimitUnit.ACTUAL, grade_min=8, grade_max=10,
              scope=TravelScope.OVERSEAS, source_section=f"{_APX}, Overseas, Daily Trip Allowance"),
    # Domestic hotels (overseas hotels have a star rating but no amount, so no rule)
    LimitRule(category="Accommodations", unit=LimitUnit.PER_NIGHT, amount=250, grade_min=3, grade_max=3,
              scope=TravelScope.DOMESTIC, source_section=f"{_APX}, Domestic, Accommodations",
              source_quote="3-star Max MYR 250 per day"),
    LimitRule(category="Accommodations", unit=LimitUnit.PER_NIGHT, amount=375, grade_min=4, grade_max=7,
              scope=TravelScope.DOMESTIC, source_section=f"{_APX}, Domestic, Accommodations",
              source_quote="4-star Max MYR 375 per day"),
    LimitRule(category="Accommodations", unit=LimitUnit.PER_NIGHT, amount=500, grade_min=8, grade_max=10,
              scope=TravelScope.DOMESTIC, source_section=f"{_APX}, Domestic, Accommodations",
              source_quote="5-star Max MYR 500 per day"),
    # Intercity transport: section 5 caps grade 7 and below, Appendix 1 (grade 8 and above, item 7) caps the rest.
    LimitRule(category="Intercity Transport", unit=LimitUnit.PER_DAY, amount=90,
              source_section="5. Transportation iv; Appendix 1, grade 8 and above, item 7",
              source_quote="maximum amount MYR 90.00,- per day"),
]
RECLAIM_ZONES: list[ZonePlace] = [
    *[ZonePlace(zone="1", place=p) for p in (
        "Kuala Lumpur", "Petaling Jaya", "Subang Jaya", "Cheras", "Shah Alam",
        "Puchong", "Johor Bahru", "George Town", "Melaka", "Ipoh",
    )],
    ZonePlace(zone="2", place="*"),
]
