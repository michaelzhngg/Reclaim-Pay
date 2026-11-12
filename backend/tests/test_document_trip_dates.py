from engine.agents.document_agent import _ordered_trip_dates


def test_a_hotel_stay_read_backwards_is_put_in_trip_order():
    # Read from a hotel bill: check-out came back as the departure, check-in as the arrival.
    assert _ordered_trip_dates("2026-11-10", "2026-11-08") == ("2026-11-08", "2026-11-10")


def test_dates_in_order_or_missing_are_left_alone():
    assert _ordered_trip_dates("2026-11-08", "2026-11-10") == ("2026-11-08", "2026-11-10")
    assert _ordered_trip_dates("2026-11-10", "") == ("2026-11-10", "")
    assert _ordered_trip_dates("not a date", "2026-11-08") == ("not a date", "2026-11-08")
