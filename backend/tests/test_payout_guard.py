"""The pure MYR guard matrix: no database, no network, no request body."""

from decimal import Decimal

import pytest

from engine.services import payout_guard as guard

BALANCED_MYR = guard.Funding("MYR", Decimal("25000.00"))
BALANCED_USD = guard.Funding("USD", Decimal("4000.00"))


def _check(currency="MYR", payee="MY", account="MY", held=("MYR",), funding=BALANCED_MYR):
    return guard.check_payout(
        payout_currency=currency,
        payee_country=payee,
        account_country=account,
        held_currencies=list(held),
        funding=funding,
    )


def test_myr_to_a_malaysian_payee_from_a_myr_balance_is_allowed():
    assert _check() is None


def test_myr_to_a_non_malaysian_payee_is_refused():
    assert _check(payee="ID") == guard.MYR_PAYEE_NOT_MALAYSIAN


def test_myr_without_a_payee_country_fails_closed():
    assert _check(payee=None) == guard.PAYEE_COUNTRY_UNKNOWN
    assert _check(payee="") == guard.PAYEE_COUNTRY_UNKNOWN


def test_myr_without_a_myr_funding_currency_is_refused():
    assert _check(held=("USD",)) == guard.MYR_BALANCE_REQUIRED


def test_non_myr_with_only_myr_held_is_refused():
    assert _check(currency="IDR", payee="ID", held=("MYR",), funding=BALANCED_USD) == \
        guard.NON_MYR_BALANCE_REQUIRED


def test_non_myr_funded_from_a_non_myr_balance_is_allowed():
    # Paying IDR from a USD balance is the roadmap's "hold USD, pay IDR" case.
    assert _check(currency="IDR", payee="ID", held=("MYR", "USD"), funding=BALANCED_USD) is None
    assert _check(currency="USD", payee="US", held=("MYR", "USD"), funding=BALANCED_USD) is None


def test_a_missing_non_myr_balance_is_refused():
    funding = guard.Funding("USD", None, "missing")
    assert _check(currency="IDR", payee="ID", held=("MYR", "USD"), funding=funding) == \
        guard.NON_MYR_BALANCE_REQUIRED


def test_a_missing_myr_balance_is_refused():
    assert _check(funding=guard.Funding("MYR", None, "missing")) == guard.MYR_BALANCE_REQUIRED


@pytest.mark.parametrize("reason", ["unreachable", "unreadable"])
def test_an_unusable_balance_read_fails_closed(reason):
    assert _check(funding=guard.Funding("MYR", error=reason)) == guard.BALANCE_UNAVAILABLE


def test_no_balance_read_at_all_fails_closed():
    assert _check(funding=None) == guard.BALANCE_UNAVAILABLE


def test_an_unreadable_amount_fails_closed():
    funding = guard.Funding("MYR", Decimal("NaN"))
    assert _check(funding=funding) == guard.BALANCE_UNAVAILABLE


def test_a_non_malaysian_account_skips_the_myr_country_rule():
    # The MYR-to-Malaysian rule is specific to a Malaysian PayPal account.
    assert _check(account="SG", payee="ID", held=("MYR",)) is None
    assert _check(account="SG", payee=None, held=("MYR",)) is None


def test_a_non_malaysian_account_still_needs_myr_held_for_an_myr_payout():
    assert _check(account="SG", held=()) == guard.MYR_BALANCE_REQUIRED


def test_an_unknown_payout_currency_fails_closed():
    assert _check(currency="XYZ") == guard.PAYOUT_CURRENCY_UNKNOWN
    assert _check(currency="") == guard.PAYOUT_CURRENCY_UNKNOWN


def test_static_refusals_need_no_balance_read():
    # The service skips the network read when a country or funding rule already refuses.
    assert _check(payee="ID", funding=None) == guard.MYR_PAYEE_NOT_MALAYSIAN
    assert _check(currency="IDR", payee="ID", held=("MYR",), funding=None) == \
        guard.NON_MYR_BALANCE_REQUIRED


def test_refusal_codes_are_recognised_for_redaction():
    assert guard.is_refusal("MYR_PAYEE_NOT_MALAYSIAN")
    assert guard.is_refusal("balance_unavailable")
    assert not guard.is_refusal("INSUFFICIENT_FUNDS")
    assert not guard.is_refusal(None)


def test_every_refusal_has_plain_hr_copy():
    for code in guard.REFUSAL_CODES:
        message = guard.refusal_message(code)
        assert message and "\u2014" not in message
