"""Currency and country data shared by contracts, payout settings and the FX service.

This is deliberately a fixed table, not a provider call. The payout currencies are the
ones PayPal Payouts reaches with the company's mock or sandbox balances today; adding a
currency is a code change, not a data change.
"""
from core.config import settings

# Payout currencies and their display names. MYR is the default company currency.
PAYOUT_CURRENCIES: dict[str, str] = {
    "MYR": "Malaysian Ringgit",
    "USD": "US Dollar",
    "EUR": "Euro",
    "GBP": "British Pound",
    "AUD": "Australian Dollar",
    "CAD": "Canadian Dollar",
    "SGD": "Singapore Dollar",
    "HKD": "Hong Kong Dollar",
    "JPY": "Japanese Yen",
    "IDR": "Indonesian Rupiah",
    "THB": "Thai Baht",
    "PHP": "Philippine Peso",
    "VND": "Vietnamese Dong",
    "INR": "Indian Rupee",
    "CNY": "Chinese Yuan",
    "KRW": "South Korean Won",
    "TWD": "New Taiwan Dollar",
    "NZD": "New Zealand Dollar",
    "AED": "UAE Dirham",
    "SAR": "Saudi Riyal",
    "QAR": "Qatari Riyal",
    "KWD": "Kuwaiti Dinar",
    "ILS": "Israeli New Shekel",
    "CHF": "Swiss Franc",
    "SEK": "Swedish Krona",
    "NOK": "Norwegian Krone",
    "DKK": "Danish Krone",
    "PLN": "Polish Zloty",
    "CZK": "Czech Koruna",
    "HUF": "Hungarian Forint",
    "TRY": "Turkish Lira",
    "MXN": "Mexican Peso",
    "BRL": "Brazilian Real",
    "ARS": "Argentine Peso",
    "CLP": "Chilean Peso",
    "COP": "Colombian Peso",
    "ZAR": "South African Rand",
    "NGN": "Nigerian Naira",
    "KES": "Kenyan Shilling",
    "EGP": "Egyptian Pound",
}

# Payee countries accepted on a contract. The MYR guard only singles out MY; PayPal
# remains responsible for other country eligibility.
PAYOUT_COUNTRIES: dict[str, str] = {
    "MY": "Malaysia",
    "SG": "Singapore",
    "ID": "Indonesia",
    "TH": "Thailand",
    "PH": "Philippines",
    "VN": "Vietnam",
    "BN": "Brunei",
    "KH": "Cambodia",
    "LA": "Laos",
    "MM": "Myanmar",
    "IN": "India",
    "PK": "Pakistan",
    "BD": "Bangladesh",
    "LK": "Sri Lanka",
    "NP": "Nepal",
    "CN": "China",
    "HK": "Hong Kong",
    "TW": "Taiwan",
    "JP": "Japan",
    "KR": "South Korea",
    "AU": "Australia",
    "NZ": "New Zealand",
    "US": "United States",
    "CA": "Canada",
    "GB": "United Kingdom",
    "IE": "Ireland",
    "DE": "Germany",
    "FR": "France",
    "NL": "Netherlands",
    "BE": "Belgium",
    "ES": "Spain",
    "PT": "Portugal",
    "IT": "Italy",
    "AT": "Austria",
    "CH": "Switzerland",
    "SE": "Sweden",
    "NO": "Norway",
    "DK": "Denmark",
    "FI": "Finland",
    "PL": "Poland",
    "CZ": "Czechia",
    "HU": "Hungary",
    "RO": "Romania",
    "GR": "Greece",
    "TR": "Turkey",
    "AE": "United Arab Emirates",
    "SA": "Saudi Arabia",
    "QA": "Qatar",
    "KW": "Kuwait",
    "IL": "Israel",
    "MX": "Mexico",
    "BR": "Brazil",
    "AR": "Argentina",
    "CL": "Chile",
    "CO": "Colombia",
    "ZA": "South Africa",
    "NG": "Nigeria",
    "KE": "Kenya",
    "EG": "Egypt",
}


def company_currency() -> str:
    """The currency the rule engine's limits and caps are denominated in."""
    return (settings.PAYPAL_CURRENCY or "MYR").upper()


def normalise_currency(value: str | None) -> str | None:
    code = (value or "").strip().upper()
    return code if code in PAYOUT_CURRENCIES else None


def currency_name(code: str) -> str | None:
    return PAYOUT_CURRENCIES.get((code or "").upper())


def normalise_country(value: str | None) -> str | None:
    code = (value or "").strip().upper()
    return code if code in PAYOUT_COUNTRIES else None


def country_name(code: str | None) -> str | None:
    return PAYOUT_COUNTRIES.get((code or "").upper())
