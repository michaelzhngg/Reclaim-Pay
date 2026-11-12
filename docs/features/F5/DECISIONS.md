# F5 decisions

Each entry records a choice the tickets left open, or a premise that proved wrong. The
plan in `PLAN.md` stays the reference; this file says where the build departs from it.

## 01: Contractor role and personal portal

- **Role named at creation.** `POST /auth/register` now requires an explicit role. The
  ticket asks for an invalid or missing role to be refused, so the old `Employee` default
  would silently accept a missing role. Existing users are untouched; the default remains
  on `UserBase` for read models, and only `UserCreate` makes the field required.
- **Company-wide reads are denied per endpoint.** A new `get_current_non_contractor_user`
  dependency guards the policy list and detail, vendor list, and department list and
  detail. A global middleware would also have to allow the policy lookups that some
  employee pages make indirectly; keeping the denial on the read endpoints leaves every
  employee path exactly as it was.
- **One employee shell, a filtered nav.** The contractor nav is a role-filtered list
  (`navLinksForRole`), not a second layout. The guard admits `Employee` and `Contractor`
  and sends every other role to the HR dashboard, so HR still cannot enter the personal
  portal. Mobile tabs and the drawer drop bookings, calendar and drafts for contractors.
- **PayPal sign-in admits contractors.** The rejection check now allows `Employee` and
  `Contractor`; HR still gets `not_employee`. This is the existing link/unlink flow, not a
  second identity path.

## 02: Contractor contracts and company payout setup

- **The country and currency lists are fixed tables.** `engine/services/currency.py` holds
  the payout currencies and payee countries this slice accepts. A country outside the
  table is refused at setup, and only the MYR guard special-cases `MY`; PayPal remains
  responsible for other country eligibility. A dynamic PayPal country lookup would make
  contract creation depend on a network call, so it is a gap, not a default.
- **One contract per contractor is a database rule.** `contractor_contracts.user_id` has a
  unique index and the service raises `CONTRACT_EXISTS` before insert. The UI and tests
  both rely on the same guarantee; editing is `PATCH /contracts/{id}`.
- **Contract categories are validated against the chosen active policy only.** With no
  policy, the labels are stored as entered. The service category is an invoice label and
  is deliberately not checked against the policy, matching the ticket.
- **Amounts and rate units are validated in the service.** The request schema keeps
  `rate_unit` as a string so an unknown unit returns a stable `RATE_UNIT_INVALID` code
  rather than Pydantic's generic enum error. Amounts must be greater than zero.
- **Payout setup is one HR-owned row with an audit entry.** `payout_settings` is created
  from defaults (`MY`, `["MYR"]`) on first read, like `autonomy_settings`, and every
  change writes a `CONFIG_CHANGED` action with the old and new values.
- **Contract limits show the company currency.** `contract_dict` returns
  `company_currency` from `PAYPAL_CURRENCY`, so the UI never hardcodes MYR.

## 03: FX quotes and company-currency claim amounts

- **No quote is a hard stop, not just a review verdict.** `ClaimFacts.fx_unavailable`
  feeds `HardStop.FX_RATE_UNAVAILABLE`, so `decide()` is still the only thing that can
  allow AUTO_PAY and an unknown pair cannot slip through a lane rule. The stored
  `amount_company` falls back to the raw amount, and `fx_source = "UNQUOTED"` marks it.
- **The quote is stored at save and locked at approval.** `save_reimbursement` writes
  `amount_company`, the rate, its UTC timestamp and source. HR approval reuses a stored
  quote younger than 24 hours; a stale or missing one is re-quoted before approving. The
  HR detail read refreshes the quote for the same reason, so the reviewer sees the rate
  that approval will lock. Movement after approval is not re-priced.
- **Payouts pay the company amount in this stage.** The payout service sends
  `approved_company_amount` (or a quote of the net amount) in `PAYPAL_CURRENCY`, and a
  claim with no quote returns `SKIP_NO_FX_QUOTE` rather than paying the raw foreign
  amount as MYR. Ticket 06 replaces this with the contract payout currency.
- **Legacy rows are backfilled only when the currency is MYR.** The migration writes an
  identity quote for MYR and marks foreign rows `UNQUOTED` without inventing a rate.
  `fx.stored_company_amount` falls back to the raw amount for those rows.
- **The FX table is deterministic and company-currency based.** `MYR_PER_UNIT` is the
  built-in table; `FX_RATES` is a JSON override of company-currency units per foreign
  unit, and `FX_RATES_AS_OF` pins the demo timestamp. Unknown currencies are absent from
  the table, not guessed.
- **Shield and budgets see company amounts.** Receipt Shield's recent-claim and
  current-claim amounts, policy category budgets, trust history, daily and monthly caps,
  the funding committed total and the backtest all read the company-currency snapshot.
  The documented false-positive risk on foreign receipts remains, because the thresholds
  themselves are still tuned to one currency.


