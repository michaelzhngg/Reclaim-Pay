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

## 06: Payouts in the payee currency and the MYR guard

- **The contract is the only source of the payout currency.** `payout_currency_for`
  returns the contract currency for a contractor claim and the company currency otherwise.
  `resolve_payout` returns the payee, currency, amount and payee country in one place, so
  the route, the retry path and ticket 07's grouping read the same destination.
  `payout_company_amount` is gone.
- **The approval snapshot is the payout amount.** `lock_payout_snapshot` writes
  `payout_amount`, `payout_currency`, `payout_fx_rate` and `payout_fx_at` in the same
  commit as `_apply_company_amounts`, and AUTO_PAY claims lock it in `save_reimbursement`.
  A full payout uses the snapshot; a recovery offset nets the claim currency first and
  converts at the locked rate. A missing quote leaves the fields empty and the payout
  service skips with `SKIP_NO_FX_QUOTE`.
- **The guard is pure and always runs before DISBURSING.** `engine/services/payout_guard.py`
  takes the payout currency, both countries, the held currencies and one balance read. It
  never reads the request body. Static country and funding rules run first; the balance is
  read only when those pass. Both the sync and async payout entry points call it, so a
  retry cannot skip it.
- **Refusals are Failed payouts, not PayPal failures.** A refusal writes a `FAILED` row
  with the reason in `failure_code`, the amount and currency, no `provider_batch_id`, and
  notifies every active HR user. The claim stays approved. The claimant's claim response
  omits a refusal payout entirely, so a contractor sees approved and unpaid rather than a
  payment error.
- **Mock balances are per-currency and configurable.** `PAYPAL_MOCK_BALANCES` is a JSON
  map, for example `{"MYR": "25000", "USD": "4000"}`. Empty keeps the old single balance.
  Live mode reads PayPal and fails closed on an unreachable, unreadable or missing balance.
  A non-MYR payout is read from the payout currency first, then any other non-MYR held
  currency, which keeps the "hold USD, pay IDR" case working.
- **Payee country is data, not request input.** `employees.country_code` and
  `vendors.country_code` were added and backfilled to MY; registration accepts a country.
  A contractor claim uses `contractor_contracts.country_code` and ignores the user row.
  The contract's country stays editable through `PATCH /contracts/{id}`.
- **Contractor claims never take offsets and contractor recoveries are refused.**
  `find_offset_claim` skips claims with a contract, `offset_for_reim` returns the full
  approved amount for them, and `create_recovery` returns
  `CONTRACTOR_RECOVERY_UNSUPPORTED`. Employee recovery behaviour is unchanged.
- **HR sees the payout quote before approving.** The claim read returns
  `payout_preview` for HR when no snapshot exists yet: amount and currency, the
  claim-to-payout rate, the quote time and the company equivalent. The review page shows
  it in the Financial Summary card.
- **The funding summary stays company-currency.** The committed total already uses
  `approved_company_amount`, and the recent-payout rate filters `Payout.currency` to the
  company currency, so a foreign payout is never added raw to the MYR figure.
- **Invoice AUTO_PAY inherits the change.** The invoice submit route calls the same payout
  service as an analyzed claim, so it gets the contract payout currency, the approval
  snapshot and the guard with no invoice-specific branch.

### Seam for 07

- `resolve_payout(db, reim, net_claim)` is the single preflight for payee, currency and
  amount. Group the approved set by `destination.currency` before building one PayPal
  batch per group. A refusal happens per claim before its group is built; keep the
  refusal row out of any group (`provider_batch_id` is None), and keep `provider_batch_id`
  as the only grouping key.

## 07: Batch approval pays one PayPal batch per currency

- **Approvals commit first, then the set is paid once.** The batch route keeps the
  per-claim lock and re-check, commits every approval and its `HR_APPROVAL` action, and
  only then calls `initiate_batch_payout_sync` with the approved IDs. Single-claim
  approval still pays immediately through `_after_commit`, and the approval
  notifications, including their push payloads, are sent after the payout attempt.
- **The currency is the grouping key, never the claim currency.** `_batch_plan` reuses
  `resolve_payout`/`payout_plan`, so `SKIP_EXISTING`, the payee check and the payout
  snapshot behave exactly as a single payout. A group is built by `assemble_batch`, which
  raises `MixedCurrencyBatch` on an empty or multi-currency set; the PayPal client also
  raises before the HTTP call if the item list is mixed, so a mixed batch cannot reach
  PayPal.
- **The group sender key is 24 characters.** `sender_batch_id_for_group` is
  `RCB-{CUR}-{sha256(sorted ids | currency | attempt)[:16]}`. Sorting makes it stable for
  the same set, the attempt keeps a retry from reusing a live PayPal key, and the currency
  keeps two groups apart. The 37-character per-claim key is unchanged for single payouts
  and remains a live-mode risk; 07 does not copy it.
- **The guard runs per claim, the balance read once per group.** Static funding refusals
  run for every claim first; only the survivors trigger one `read_funding` for the group.
  A refusal commits its FAILED row with no batch ID and is caught, so the rest of the
  group still pays. Nothing is marked `DISBURSING` until every guard check has passed.
- **A group failure rolls its claims back to APPROVED.** The group marks its claims
  `DISBURSING` in one uncommitted transaction, calls PayPal, and only then saves the
  payout rows. An exception rolls that transaction back and the loop moves to the next
  currency; already committed groups are untouched. There is no batch retry action: the
  claims stay APPROVED for the existing single-payout retry, which uses the per-claim key.
  A repeated batch call with the same set and attempt would reuse the same group key on
  purpose, so a transport failure stays idempotent.
- **Per-item statuses come from the create response.** `PayoutCreated.items` parses the
  items PayPal returns. A terminal `FAILED`/`DENIED`/`BLOCKED` item makes only that
  claim's payout FAILED and its claim `DISBURSEMENT_FAILED`; every other row in the batch
  stays ACCEPTED. Mock mode returns no items, so an ordinary mock batch stays pending and
  the existing status refresh still runs per payout.
- **The contract check is a batch skip reason.** `split_batch` reads
  `ai_reasoning.contract_reason` and returns `CONTRACT_CHECK` for a claim whose category
  or rate check failed. A contractor claim with no contract reason can be batched at
  `HR_QUICK`; the row carries a `service category · currency` contract label so HR can
  deselect it. Self-approval, non-`HR_QUICK`, non-`REVIEW` and vendor bookings are
  unchanged.
- **The batch response keeps its old shape.** `approved` and `skipped` are unchanged, so
  the existing HR sheet and its tests are untouched. Batch ID, payout currency and amount
  per claim are read from the payouts ledger, which now also returns `claim_currency`,
  `company_amount` and `company_currency`. Those three are derived on read, not stored,
  so 07 adds no schema and the migration head stays `a7c1e9d4b2f6`.

## 08: Contractor currency demo seed

- **The demo rows have their own tag.** `SEED_CONTRACTOR_TAG` keeps the four new claims
  out of the 120-claim `SEED_TAG` history, so the existing seed tests and the demo
  history counts stay unchanged. `--reset-demo` deletes both tags and their children.
- **The employee in the MYR group is a demo-only account.** C03 is a fresh Employee with
  no history, so `OVER_AUTO_LIMIT` puts the claim in `HR_QUICK`. Reusing `employee@`
  would make the tier depend on the existing Standard trust history.
- **The contract-check row is hand-placed.** Real intake sends a blocked category to
  `DUAL_REVIEW`, which would skip on tier before the contract rule. The demo row keeps
  `HR_QUICK` and carries `contract_reason = CATEGORY_NOT_ALLOWED`, so the Quick tab shows
  the `CONTRACT_CHECK` exclusion the batch rule exists to produce.
- **The seed writes payout settings, not environment.** Account country MY and held
  currencies `MYR`, `USD` are database rows and are set on every run. `PAYPAL_MOCK_BALANCES`
  is process environment, so the seed prints the JSON to set on the API and the walkthrough
  repeats it. The seed cannot change a running API's balances.
- **Reset keeps contracts and settings.** `--reset-demo` deletes the tagged claims,
  payouts and line items only. Contracts are updated in place and payout settings are
  rewritten, so a reset cannot leave a second contract or a lost funding list.
- **The demo verifies the 07 behaviour end to end.** Seed tests assert two provider batch
  IDs for the two clean rows, a failed refusal row with no batch ID, the contract-check row
  left in `REVIEW`, and an IDR group failure that leaves only the IDR claim approved while
  the MYR group still pays.
