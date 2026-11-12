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

## 04: Contractor claims under contract policy, never auto-paid

- **The contractor trust stop lives in `decide()`.** `CONTRACTOR_NOT_TRUSTED` is reported
  whenever `claimant_is_contractor` is true and the trust tier is below `TRUSTED`. No
  route can turn it off, and a trusted contractor still goes through every normal rule.
- **The contract ceiling is `OVER_CONTRACT_LIMIT`, compared in company currency.** The
  claim is decided on `max(amount_company, approved_company_amount)`, so the raw foreign
  amount cannot dodge the ceiling. The limit is passed into the compliance workflow with
  the contract id, never read from the request.
- **Contract intake splits receipts before the agent.** A receipt whose category is not
  in the contract is removed from the agent groups and becomes a `DUAL_REVIEW` claim with
  `contract_reason = CATEGORY_NOT_ALLOWED`. It is still a `Reimbursement` linked to the
  contract, so HR sees it in the same queue and the contractor sees a normal review claim.
  Blocked receipts from one submission are grouped into one claim.
- **A contract policy replaces the category lookup.** When the contract names a policy,
  every allowed receipt is evaluated against it. Without one, the existing newest active
  policy that lists the category still applies. Category matching is case-insensitive.
- **All contractor claims carry `contract_id`.** The compliance save links the contract
  it was given; review claims created without the agent are linked the same way.
- **Contractor claim responses drop the HR note too.** Employees still see the HR note,
  because they are notified of it. A contractor sees status, amounts and currency only.
  Risk score, signals, hard stops and the explanation were already stripped.
- **The trust card names the role.** `/autonomy/me` admits contractors and returns
  `is_contractor`, and the card says "Reviewed payouts up to" plus a sentence that
  contractor payments are reviewed until trusted. It carries no score, signal or stop.
- **The backtest loads the role from the users table.** It no longer infers the claimant
  from a stored hard stop, so a trusted contractor's older claims re-run with the
  contractor flag and the company amount.
- **Contractors cannot create vendor bookings.** The booking route now uses the
  non-contractor dependency, matching the nav that hides bookings from them.

## 05: Contractor invoices at the contract rate

- **An invoice is a claim row with a period.** `reimbursements.invoice_period_start` and
  `invoice_period_end` are the only new columns, and `kind` stays `CLAIM`. The period and
  the line item carry the form data, so trust history, caps, HR triage and payouts need no
  invoice branch. Migration `b3e5f7a9c1d2` is chained from `f4a8d3e5b6c7`.
- **Over-rate is `NEEDS_INFO`, not a new hard stop.** The ticket names only
  `claimant_is_contractor` and `over_contract_limit` on `ClaimFacts`, so an invoice above
  the contract rate is saved with `JudgmentResult.NEEDS_INFO`. `decide()` then reports
  `AI_NOT_APPROVED` and routes it to `HR_REVIEW` even for a trusted contractor. The reason
  is carried in `ai_reasoning.contract_reason = OVER_CONTRACT_RATE`, the summary and the
  line item, all of which are HR-only.
- **The request may echo the contract but never override it.** A submitted currency must
  match the contract currency (`CURRENCY_MISMATCH`) and a submitted category must match
  `service_category` (`CATEGORY_OVERRIDE`). Unit price omitted defaults to the contract
  rate; a supplied price is compared against it. All checks run before the first write, so
  a refused invoice leaves no rows behind.
- **The line item stores the requested figure.** `approved_amount` starts at the claimed
  amount on the line so HR approval has a figure to accept. The claim's status,
  `total_approved_amount` and company amount still move only through `decide()` or an HR
  decision; the line item is the request detail HR reviews.
- **AUTO_PAY invoices use the same payout service.** When `decide()` returns `AUTO_PAY`,
  the submit route calls `initiate_payout_sync` exactly as an analyzed claim does. A failed
  payout leaves the invoice approved for HR to resend. There is no invoice-specific payout
  path. A non-AUTO_PAY invoice stops at `REVIEW`.
- **Invoice intake is deterministic.** No LLM call, no Shield pass and no settlement. The
  invoice keeps `contract_id`, the contract policy when set, the company-currency FX
  snapshot and the service category, so it appears in the existing contractor history and
  HR triage without new list endpoints.

## Seams for 06

- **05 invoices, landed:** `reimbursements.contract_id` plus the period columns from
  `b3e5f7a9c1d2`. `engine.services.contractor_invoices.create_invoice` is the intake:
  contract checks, quantity by unit price, FX snapshot and the one call to `decide()`.
  `contract_dict` still returns the rate and `POST /contractor-invoices` is the route.
- **06 payout currency:** `engine.services.payout_service.payout_company_amount` is the
  single place that decides what PayPal receives today. Replace its company-currency
  conversion with the contract payout currency, add the payout snapshot fields
  (`payout_amount`, `payout_currency`, `payout_fx_rate`, `payout_fx_at`) in a migration
  chained after 05's (`b3e5f7a9c1d2`), and run the MYR guard before `create_payout`.
  `Payout.amount` and `Payout.currency` are already written as the actual amount sent to
  PayPal. The invoice route's AUTO_PAY call goes through the same service, so it inherits
  the change without edits.
- **07 batching:** `payee_for_reim` and `payout_company_amount` are the destination and
  amount seams. Group by the resolved payout currency before building one PayPal batch,
  and keep `provider_batch_id` as the only grouping key.




