from core.enums import SignalVerdict
from engine.services.signal_review_service import MIN_REVIEWS, SignalOutcome, tally


def _o(code, verdict=None, full=False, rejected=False):
    return SignalOutcome(code=code, verdict=verdict, approved_in_full=full, rejected=rejected)


def test_counts_per_signal_and_sorts_by_how_often_it_fired():
    rows = tally([
        _o("DUPLICATE_RECEIPT", SignalVerdict.CONFIRMED, rejected=True),
        _o("NO_CAMERA_METADATA", full=True),
        _o("NO_CAMERA_METADATA", SignalVerdict.FALSE_ALARM, full=True),
        _o("NO_CAMERA_METADATA"),
    ])
    assert [r.code for r in rows] == ["NO_CAMERA_METADATA", "DUPLICATE_RECEIPT"]
    cam = rows[0]
    assert (cam.fired, cam.confirmed, cam.false_alarm, cam.unreviewed, cam.approved_in_full) == (3, 0, 1, 2, 2)
    assert rows[1].rejected == 1


def test_ties_on_fired_sort_by_code():
    rows = tally([_o("SPLIT_CLAIM"), _o("AI_PROVENANCE")])
    assert [r.code for r in rows] == ["AI_PROVENANCE", "SPLIT_CLAIM"]


def test_precision_needs_enough_reviews():
    few = tally([_o("SPLIT_CLAIM", SignalVerdict.CONFIRMED)] * (MIN_REVIEWS - 1))
    assert few[0].precision is None
    many = tally(
        [_o("SPLIT_CLAIM", SignalVerdict.CONFIRMED)] * (MIN_REVIEWS - 2)
        + [_o("SPLIT_CLAIM", SignalVerdict.FALSE_ALARM)] * 2
    )
    assert many[0].precision == 0.8


def test_unrated_firings_do_not_count_toward_precision():
    rows = tally([_o("SPLIT_CLAIM", SignalVerdict.FALSE_ALARM)] * MIN_REVIEWS + [_o("SPLIT_CLAIM")] * 5)
    assert rows[0].precision == 0.0 and rows[0].unreviewed == 5


def test_empty_input():
    assert tally([]) == []
