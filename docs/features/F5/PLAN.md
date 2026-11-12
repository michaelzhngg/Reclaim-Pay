# F5: Contractors and overseas staff

**Status:** planned, not implemented
**Branch:** `feat/f5-contractors`, based on `main` at `1a0fd66`
**Scope:** a limited contractor role, contract-scoped claims and invoices, payouts in the payee's currency, and a pre-PayPal MYR guard. Mock PayPal only.

## Problem

Reclaim Pay assumes every payee is a Malaysian employee paid in MYR from one balance. Contractors and overseas staff break all three assumptions:

- They need a login that can submit claims and invoices and see their own payouts, without seeing HR data, the company vendor directory or the policy library.
- Their contract decides the rate, the billable categories and the payout currency. The current policy engine only knows company-wide policies resolved by category.
- PayPal Payouts reaches many currencies, but a batch uses one currency. A Malaysian PayPal account can send MYR only to Malaysian accounts and cannot send payouts that need conversion to or from MYR. Paying an Indonesian contractor in IDR therefore needs a non-MYR balance and a refusal before the PayPal call, not a failed PayPal request.

## The slice

One end-to-end path, demoable in mock mode:

1. HR creates a contractor with a contract: country, payout currency, rate, billable categories, FX limit, optional policy.
2. The contractor signs in and sees only their own claims, invoices, history and settings.
3. The contractor submits an expense claim in a foreign currency, or an invoice at the contract rate.
4. The claim is checked against the contract, converted to company currency for `decide()`, and routed to HR. A contractor is never auto-paid before TRUSTED.
5. HR sees the FX quote before approving, then approves. The payout goes to the contractor's PayPal in the contract currency.
6. A second contractor on an MYR contract is refused before PayPal because their country is not Malaysia. The refusal is visible to HR and no PayPal payout call is made.
7. HR batch-approves two claims in two currencies. Two PayPal batches are created, one per currency, and the ledger shows both.

## Design

### Vocabulary

- **Contractor**: a user with the `Contractor` role. Limited to their own money records.
- **Contract**: one active record per contractor with country, payout currency, rate, billable categories, FX limit and optional policy.
- **Company currency**: the currency the rule engine's limits and caps are denominated in. Today this is `PAYPAL_CURRENCY`, default MYR.
- **Claim currency**: the currency the contractor claimed in, usually the receipt currency.
- **Payout currency**: the currency the contractor is paid in, from the contract.
- **Funding currency**: a currency the company holds in PayPal. A non-MYR payout must be funded from a non-MYR balance. This is the enforceable form of "no conversion to or from MYR".
- **Invoice**: contractor time or services billed at the contract rate. It is still a `Reimbursement` row, not a new kind.

### Roles and access

Add `Contractor` to `UserRole`. The role is read from the database on every request, so a change applies on the next request without a token change.

| Capability | Contractor | Employee | HR |
|---|---|---|---|
| Submit expense claims | yes, own | yes, own | yes, own |
| Submit invoices | yes, own | no | no |
| See own claims, payouts, notifications | yes | yes | yes |
| See another person's claim | no | no | yes |
| See employee directory, vendors, policy library, departments | no | vendors and policies only through existing booking/claims surfaces | yes |
| Create contracts, change payout settings | no | no | yes |
| Approve or reject | no | no | yes |
| Link a PayPal account | yes, same flow as employees | yes | no |

Rules:

- The employee PayPal sign-in rejection currently accepts only `Employee`. It must accept `Employee` and `Contractor`, and still reject HR.
- Company-wide reads that currently accept any authenticated user get an explicit contractor denial: the policy list, the vendor directory and the department list. Contractors read their own contract instead.
- The contractor reuses the employee shell rather than a second app. Navigation hides bookings, the company policy library and any HR link. The employee guard admits `Contractor`; the HR guard still redirects non-HR.
- No new permission table. Three roles, checked with the existing dependencies, are enough for this slice.

### Contract model

Three new tables:

| Table | Fields that matter | Notes |
|---|---|---|
| `contractor_contracts` | `contract_id`, `user_id` (unique), `country_code`, `currency`, `rate_amount`, `rate_unit`, `service_category`, `policy_id`, `max_company_amount_per_claim`, `is_active`, `effective_from`, `effective_to`, `created_by`, timestamps | One active contract per contractor. Edits overwrite; contract versioning is a gap. |
| `contractor_contract_categories` | `id`, `contract_id`, `category`, unique pair | Expense categories the contract covers. |
| `payout_settings` | single row: `paypal_account_country`, `held_currencies` (JSONB list), `updated_by`, `updated_at` | HR-owned. Default account country MY and held currencies `["MYR"]`. |

Contract rules:

- `country_code` is required and is the authoritative payee country for the MYR guard. A missing or unsupported country blocks setup.
- `currency` is the payout currency. It must be a currency PayPal Payouts supports.
- `rate_amount` and `rate_unit` (`HOUR`, `DAY`, `MONTH`, `PROJECT`) define invoice pricing.
- `service_category` is the category used for invoices. Expense categories are separate. Expense categories are validated against the chosen policy when a policy is set; the service category is the invoice label and does not need to appear in the policy.
- `max_company_amount_per_claim` is an FX limit in company currency. It is a second ceiling on top of the autonomy limits, not a replacement.
- `policy_id` is optional. When set, a contractor's receipts are evaluated only against that policy. When absent, the existing active-policy-by-category lookup still applies, but only for contract categories.

`payout_settings` exists so the guard and the setup screen read one source. Environment variables are not editable from the UI and would make the demo require a restart.

### Claims and invoices

A contractor claim is a `Reimbursement` row with a new nullable `contract_id`. An invoice is also a `Reimbursement` row with `contract_id` and an invoice period. There is no new `kind`.

Why no new kind:

- A contractor invoice is money to the contractor, so it belongs in contractor trust history, caps and payouts. A vendor booking is company spend to a third party, which is why F2 needed a discriminator.
- A new kind would force every claim-only filter, approval rule and trust query to make another decision, and would invite a second payout path.
- The invoice difference is intake and evidence, not money movement. It is captured by `contract_id`, `invoice_period_start`, `invoice_period_end` and a line item whose quantity is hours or units and whose unit price is the contract rate.

Expense claim intake keeps the existing upload and compliance pipeline. For a contractor:

- Require an active contract before analysis.
- Reject receipts whose category is not in the contract. Put them in a review claim with a contract-specific reason for HR, never with risk language for the contractor.
- Resolve the policy from the contract when one is set.
- Apply the contract FX limit in company currency.
- Link the resulting claim to the contract and store the FX snapshot.

Invoice intake is deterministic, with no LLM call, mirroring the vendor booking service:

- Input: period, description, quantity, unit price (defaulted from the contract), optional note.
- Category is `service_category`; currency is the contract currency.
- Quantity times unit price must equal the claimed amount.
- Unit price above the contract rate sets `NEEDS_INFO` and routes to HR. It is not rejected automatically.
- `decide()` still runs and is still the only source of `AUTO_PAY`. The contractor trust hard stop keeps a new contractor in an HR lane.

### Currency handling

The rule engine compares amounts with MYR limits and caps. Passing a raw IDR amount would make every limit meaningless. Every claim therefore carries a company-currency snapshot.

New `Reimbursement` fields:

| Field | Meaning |
|---|---|
| `amount_company` | Claimed amount converted to company currency at save time. |
| `approved_company_amount` | Approved amount converted at approval time. |
| `fx_rate_to_company`, `fx_rate_at`, `fx_source` | The quote used for the company amount. |
| `payout_amount`, `payout_currency`, `payout_fx_rate`, `payout_fx_at` | Expected payout at approval. Actual payout can be lower after recovery offsets. |

Rules:

- `decide()` receives `amount_company`, not the claim-currency amount. `ClaimFacts` keeps its currency field set to the company currency so the explanation and limits agree.
- Employee history, daily and monthly caps, the company ledger, category budgets and the backtest use company-currency amounts.
- Existing rows are backfilled for MYR only. A legacy foreign-currency row without a rate falls back to its stored amount and is flagged, rather than pretending a 1:1 rate.
- An unknown currency pair fails closed to HR. No quote, no auto-pay, no guessed rate.
- Minor units are a gap: the payout formatter assumes two decimals. Zero-decimal currencies need explicit handling before a live run.

### Payouts and batch splitting

Payout destination resolution stays in the payout service and gains one step:

1. Resolve the payee as today: contractor is the user branch, employee is the user branch, vendor booking is the vendor branch.
2. Resolve payout currency, expected amount and payee country: contract for a contractor, company currency and user country for an employee, company currency and vendor country for a vendor.
3. Run the MYR guard.
4. Build the PayPal call with the payout currency and amount, not `settings.PAYPAL_CURRENCY` and the claim amount.

`Payout.amount` and `Payout.currency` become the actual payout amount and currency. The claim keeps its own currency and company amount for reporting.

Batch splitting is a structural rule, not a label:

- PayPal accepts many items in one batch but one currency per batch.
- Today the client sends exactly one item per call, so a mixed batch cannot happen by accident. That also means the constraint is untested and invisible.
- HR batch approval currently pays each claim in a loop. It will instead approve first, commit, then pay the approved set once.
- The payout service groups the set by payout currency. Each group becomes one PayPal batch with one currency and one sender batch ID. A mixed-currency group is a programming error and raises before any PayPal call.
- Each claim still gets its own `Payout` row, sharing the group's `provider_batch_id`. A per-item PayPal failure updates only that claim.
- A failed group does not roll back another group's success. Claims in the failed group stay approved for retry.
- Sender batch IDs are deterministic across retries and unique per currency group. PayPal documents a 30-character cap on its payout IDs; the existing per-claim key is 37 characters and only survives because mock mode ignores it. Ticket 07 keeps the new group keys short and does not copy the long pattern. The legacy key is a live-mode risk to verify before sandbox.

No new payment rail, no second PayPal client, no batch table. `provider_batch_id` is the grouping key.

Contractor claims may enter batch approval when their tier is `HR_QUICK` and every contract check has already passed. The batch row carries the contract label so HR can deselect it. This is a product choice: if every contractor claim needs an individual look, exclude contractors from batch approval and move the two-currency demo to a dedicated pay-selected action.

The company funding summary counts only payouts funded from the company currency, or converts them to company currency. Foreign payout amounts are never added raw to the MYR committed total.

Recovery offsets net amounts in the claim currency. Contractor claims are excluded from offset targeting in this slice, and contractor recoveries are not created. Recovery stays employee-claim-only until a cross-currency design exists.

### The MYR guard

The guard is a pure function called by the payout service after the plan is built and before the claim is marked disbursing or any PayPal payout call is made. It never reads the request body.

Account country is MY for this slice. Held currencies come from `payout_settings`.

| Condition | Result |
|---|---|
| Payout currency MYR, payee country not MY | refuse `MYR_PAYEE_NOT_MALAYSIAN` |
| Payout currency MYR, payee country unknown | refuse `PAYEE_COUNTRY_UNKNOWN` |
| Payout currency MYR, MYR not in held currencies | refuse `MYR_BALANCE_REQUIRED` |
| Payout currency not MYR, every held currency is MYR | refuse `NON_MYR_BALANCE_REQUIRED` |
| Payout currency not MYR, at least one non-MYR held currency | allow, subject to the balance check |
| Account country not MY | apply the funding rule; the MYR-to-Malaysian rule is specific to a Malaysian account |

This is deliberately conservative. Paying IDR from a USD balance is allowed because PayPal can convert USD to IDR. Paying anything from a MYR balance that needs conversion is refused because the rule forbids exchange to or from MYR. Requiring the exact payout currency would be simpler but would wrongly refuse the roadmap's "hold USD, pay IDR" case.

On refusal:

- Do not mark the claim disbursing and do not call `create_payout`.
- Record a failed `Payout` attempt with the refusal code, amount and currency, and no batch ID. This keeps the refusal visible in the ledger and lets HR retry after fixing the contract or balance.
- Leave the claim approved, notify HR with a plain reason and a link to the contract or setup screen.
- A refusal is not a PayPal failure. The contractor sees the claim as approved and unpaid, not as a payment error.

In live mode the payout service supplies a balance read to the guard and fails closed when PayPal is unreachable, the balance is missing or the balance is unreadable. Mock mode uses configured per-currency balances so the guard can be demonstrated without keys.

### FX quote

No external FX provider in this slice. A deterministic rate table lives in one service, overridable by environment for demos and tests.

- Quote from any supported currency to company currency, and from claim currency to payout currency, chaining through company currency.
- A quote carries rate, converted amount, `as_of` and source.
- Store the quote at claim save for display, and lock the final quote at HR approval. The review read refreshes a quote older than 24 hours before rendering, so the reviewer always sees the rate that approval will lock.
- HR sees the quote before approving: `USD 120.00 ≈ MYR 564.00 at 4.7000 on 12 Nov 2026, 09:00 UTC`. For a payout currency different from the claim currency, HR also sees `Pays IDR 1,920,000.00`.
- A contractor sees the equivalent in their own claim/payout currency, not the risk explanation.
- The contract FX limit is compared in company currency.
- Rate movement between approval and payout is not re-priced. The approval quote is the payout quote. This is a product decision, documented as a risk.

Real rates, provider spread, rate history and a treasury policy are explicit gaps.

### Trust and policy

Contractors start at NEW because their history starts empty. NEW alone does not stop `STANDARD` from auto-paying after three paid claims, so a new hard stop is required:

- Add `claimant_is_contractor` to `ClaimFacts`.
- Add `CONTRACTOR_NOT_TRUSTED` to `HardStop`.
- `decide()` reports the stop whenever the claimant is a contractor and the trust tier is not `TRUSTED`.
- Once a contractor reaches TRUSTED, the stop disappears and the normal limits still apply. A trusted contractor can reach `AUTO_PAY`, but only through `decide()`.

Policy per contract:

- Contract categories are checked before the compliance agent runs.
- A category outside the contract goes to HR with a contract reason.
- A contract policy, when set, replaces the category-to-policy lookup.
- The contract rate is checked on invoices, not on expense receipts.
- The FX limit is checked in company currency.
- The AI never approves, rejects or pays. It can only hold a claim back, as today.

Backtest: `ClaimFacts` needs the contractor flag and company amount. The backtest loads the user's role rather than inferring it from a stored stop, so a trusted contractor's past claims re-run correctly.

### Company setup screen

The HR settings area gains a `Currencies and payouts` section:

- PayPal account country.
- Funding currencies the company holds, as removable chips.
- The MYR rule, in plain language: a Malaysian account can pay MYR only to Malaysian accounts, and cannot pay from a MYR balance when the payout needs conversion. Overseas payouts are funded from a non-MYR balance, which the company tops up in PayPal.
- A note that the balance itself is not topped up by Reclaim Pay.

This is the screen the task requires. It shows the constraint where HR makes the decision, not only in an error after approval.

### UI

Contractor:

- Same shell as employees, with a reduced nav: Overview, Claims, History, Settings.
- Claims page reuses upload and receipt review. A new invoice form sits beside it.
- History shows the claim amount and, once paid, the payout amount and currency.
- Settings shows the contract summary and the existing PayPal connect card.
- No bookings, no vendor directory, no policy library, no HR links.
- The trust card reads NEW and explains that contractor payments are reviewed until trusted.

HR:

- New Contractors page: list contractors, create/edit a contract, see missing setup.
- Contract form: country, payout currency, rate and unit, service category, expense categories from the active policy, FX limit, optional policy.
- Review page: contract card and FX quote before approval. Replace hardcoded MYR with the claim currency and company equivalent.
- Payouts ledger: payout currency and amount, claim currency, refusal reason when a payout was blocked.
- Settings: Currencies and payouts.
- Batch approval stays where it is; it now creates one PayPal batch per currency behind the scenes.

Copy rules: no em dashes, empty values read "Not set", no risk scores, signals or hard stops in contractor-facing copy.

### API surface

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/auth/register` | HR | Create a Contractor user; existing endpoint, role becomes valid |
| `GET` | `/contracts` | HR | List contracts and contractors without one |
| `POST` | `/contracts` | HR | Create a contract |
| `PATCH` | `/contracts/{id}` | HR | Edit a contract |
| `GET` | `/contracts/me` | Contractor | Own contract summary |
| `GET` | `/payout-settings` | HR | Account country and held currencies |
| `PUT` | `/payout-settings` | HR | Change held currencies |
| `POST` | `/contractor-invoices` | Contractor | Submit an invoice |
| `POST` | `/reimbursements/analyze` | Contractor/Employee | Existing; contract-aware for contractors |
| `POST` | `/reimbursements/batch-approve` | HR | Existing; now batches payouts by currency |
| `POST` | `/payouts/` | HR | Existing; guarded payout |
| `GET` | `/autonomy/me` | Contractor/Employee | Existing; contractor trust card |

Self-scoped claim, document, draft, notification and payout reads stay as they are.

### Prefactoring inside the tickets

No separate refactor ticket. Three small prefactors land with the ticket that first needs them, so the main change stays narrow:

- Extract payout destination resolution into one helper that returns payee, payout currency, expected amount and payee country. Single and batch payouts share it.
- Extract money formatting and minor-unit handling into one helper. HR review, history and the ledger stop duplicating currency strings.
- Split the approval commit from the payout trigger. Single approval keeps paying immediately; batch approval can pay the whole set after the loop.

### Data model and migrations

Alembic head is `c8d2e3f4a5b6`. Each ticket that changes schema adds its model and one migration chained from the previous ticket's head. Planned additions:

- `contractor_contracts`, `contractor_contract_categories`, `payout_settings`.
- `users.country_code`, `vendors.country_code` with a MY backfill.
- `reimbursements.contract_id`, `invoice_period_start`, `invoice_period_end`.
- `reimbursements.amount_company`, `approved_company_amount`, `fx_rate_to_company`, `fx_rate_at`, `fx_source`.
- `reimbursements.payout_amount`, `payout_currency`, `payout_fx_rate`, `payout_fx_at`.

No new `Payout` table or batch table.

## Acceptance criteria for the slice

- [ ] HR can create a Contractor user and a contract with a country, payout currency, rate, billable categories and FX limit.
- [ ] A contractor can sign in and sees only their own claims, invoices, history, contract and payout details. Company vendor, policy and department reads are refused.
- [ ] A contractor can submit an expense claim in a foreign currency and an invoice at the contract rate.
- [ ] Contract categories and the FX limit gate intake. A category outside the contract goes to HR with a contract reason.
- [ ] HR sees the FX quote before approving, for the claim and the expected payout.
- [ ] A contractor at NEW and at STANDARD is never auto-paid. A TRUSTED contractor can auto-pay when every other rule passes.
- [ ] Approval pays the contractor in the contract currency through the existing payout service. `Payout.amount` and `Payout.currency` match what PayPal received.
- [ ] An MYR payout to a non-Malaysian payee is refused before the PayPal payout call, recorded as a failed attempt, and shown to HR. No batch ID exists for the refusal.
- [ ] A non-MYR payout is allowed only when the company holds a non-MYR funding currency.
- [ ] Batch approval of two approved claims in two currencies creates two PayPal batches, one per currency. A mixed-currency batch is impossible.
- [ ] The company setup screen shows the MYR rule and the funding currencies.
- [ ] Contractor responses contain no risk score, signal name, hard stop, explanation or HR note.
- [ ] Every schema change has a SQLModel model and an Alembic migration chained from `c8d2e3f4a5b6`.
- [ ] Backend pytest, frontend `tsc --noEmit` and vitest pass. Mock PayPal only.

## Guardrails

| Guardrail | Mechanism |
|---|---|
| MYR payout to a non-Malaysian payee | Pure pre-PayPal guard; refuses and records, never reaches PayPal |
| Payout from a MYR balance that needs conversion | Guard requires a non-MYR funding currency for non-MYR payouts |
| Contractors never auto-paid before TRUSTED | New `CONTRACTOR_NOT_TRUSTED` hard stop in `decide()` |
| FX limits | Contract company-currency ceiling plus existing autonomy caps, both on company amounts |
| Per-country rules | Country is contract data, not request data; MYR rule in the guard; other countries remain PayPal's responsibility |
| Sanctions and KYC | PayPal handles them; Reclaim Pay stores no identity documents |
| Claim currency confusion | Company-currency snapshot on every claim; unknown rates fail closed |
| Wrong payout currency | Contract is the only source; request fields cannot override it |
| Batch mixing | Group by payout currency before the client call; mixed input raises |
| AI cannot pay | `decide()` remains the only producer of `AUTO_PAY`; invoice intake never sets status |
| Company policy leakage | Contractors are denied the policy library and vendor directory; contract categories scope their intake |
| Silent payout skips | Guard refusals and PayPal failures are recorded and notified, not swallowed |

## Risks

| Risk | Mitigation |
|---|---|
| Currency normalization touches every claim path, including history, caps, ledger, budgets and dashboards | Land it as its own ticket with fallbacks for legacy rows; test MYR and foreign claims; audit hardcoded MYR in the UI |
| Locking the payout rate at approval means the company bears rate movement | State it in the approval copy; keep the quote timestamp next to the amount; fresh-rate payouts are future work |
| Existing non-MYR rows have no stored rate | Backfill MYR only; flag legacy foreign rows; do not guess a rate |
| The MYR guard could block existing payouts if country data is wrong | Backfill MY, make the contract country editable, set new staff country at creation, test employee and vendor paths, fail closed with a visible reason |
| Batch approval now pays after the loop, changing failure timing | Keep approvals committed first; a payout failure leaves claims approved; test partial and group failures |
| Batch sender keys must be deterministic and unique per currency group | Derive from sorted claim IDs plus currency and attempt; keep within PayPal's documented 30-character ID cap |
| The current per-claim sender key is longer than PayPal's limit | Record as a live-mode risk; do not extend the pattern; fix separately because changing keys changes idempotency |
| Contract mistakes block or misroute payouts | HR-only setup, country and currency validation, action log, visible refusal reasons |
| Mock balances always succeed, hiding live funding failures | Guard reads real balances in live mode and fails closed; document the mock difference |
| Zero-decimal currencies and PayPal minor units | Explicit gap; do not claim live readiness for IDR/JPY-like currencies |
| Recovery offsets and currencies diverge | Contractor claims are excluded from offset targeting in this slice; recovery remains employee-claim-only |
| A contractor's foreign claim trips Receipt Shield thresholds tuned for MYR | Shield stays as-is; treat it as a known false-positive source and document it |
| Parallel tickets 05 and 06 both change the claim record | Sequence the migrations; 05 adds invoice fields, 06 adds payout snapshot fields, both chained |

## Explicit gaps

- **Real FX rates.** The rate table is deterministic and environment-overridable. There is no provider, no spread, no historical rate store and no treasury policy.
- **Sandbox multi-currency balance.** Mock mode models balances per currency. Real sandbox and production need a funded non-MYR balance and a top-up process. Reclaim Pay does not move money between balances.
- **Live PayPal country eligibility.** Only the MYR rule is encoded. Other country restrictions, receiving limits and currency conversion exclusions are left to PayPal and are not pre-checked.
- **Tax and legal treatment.** No tax forms, withholding, VAT/GST, gig-worker records or per-country employment classification. This needs local advice before a live launch.
- **Sanctions and KYC.** Handled by PayPal. No identity documents, screening lists or adverse-media checks are stored.
- **Venmo.** Not built. US-only and USD-only in the roadmap; this slice uses PayPal Payouts only.
- **Cross-currency recovery.** Contractor overpayments are not offset against other claims. Recovery remains employee-claim-only; a contractor recovery needs a separate design.
- **Contract versioning and rate history.** One active contract per contractor. Editing overwrites the previous terms; there is no amendment history.
- **Invoice documents.** An invoice is a form, not a generated PDF, signed document or tax invoice. There is no vendor/customer tax identifier handling.
- **Partial payout of one claim.** A claim is paid in one currency and one amount. Splitting a single claim across currencies or payees is not built.
- **Funding alerts by currency.** The funding card stays company-currency. The guard checks a live balance before paying, but HR has no per-currency runway alert.
- **Zero-decimal currencies.** Formatting and validation assume two decimals.
- **Contractor self-onboarding.** HR creates the user and contract. There is no invite, self-service contract acceptance or document upload.
- **Receipt Shield currency tuning.** Thresholds and market-price checks remain tuned to the company currency and one FX rate. Foreign receipts can produce false positives.

## Test strategy

- Pure: FX quote pairs, inverse and unknown pair; MYR guard matrix; contract category and rate checks; contractor trust hard stop; batch grouping and sender key; amounts in company currency.
- Postgres (`TEST_DATABASE_URL`): role isolation; contract CRUD and uniqueness; contractor claim intake with allowed and disallowed categories; invoice rate boundary; FX snapshot persisted; payout currency and amount; MYR refusal with no PayPal call; batch approval two currencies two batches; redaction of contractor responses.
- PayPal client: multi-item body uses one currency; mixed input raises; mock batch status mapping.
- Frontend: vitest for pure nav, currency and FX display helpers; `tsc --noEmit`; no rendered-component tests, matching the repo.
- Migration: upgrade a scratch database from `c8d2e3f4a5b6`, confirm the seed still runs and the head is the last F5 migration.

## Tickets

| # | Ticket | Blocked by |
|---|---|---|
| 01 | Contractor role with a self-scoped portal | None |
| 02 | Contractor contracts and company payout setup | 01 |
| 03 | FX quotes and company-currency claim amounts | 02 |
| 04 | Contractor claims under contract policy, never auto-paid | 02, 03 |
| 05 | Contractor invoices at the contract rate | 04 |
| 06 | Payouts in the payee currency with the MYR guard | 04 |
| 07 | Batch approval pays one PayPal batch per currency | 06 |
| 08 | Seed the contractor demo and verify end to end | 05, 07 |

Tickets 05 and 06 can be developed in either order after 04, but their migrations are chained, so land 05 then 06 if one branch carries both. Ticket 08 is the integration and demo ticket.

## Premise corrections

- The current payout path has no multi-item batch. Every payout is one item in one call, so "batches split by currency" is a new constraint introduced by ticket 07, not an existing behaviour to preserve.
- Trust tiers alone do not stop a contractor from auto-paying. `STANDARD` is reached after three paid claims and already allows `AUTO_PAY`, so a contractor-specific hard stop is required.
- There is no per-person contract or rate model today. Policies are company-wide and resolved by category.
- There is no payee country anywhere in the schema, so the MYR guard cannot be implemented without new country data.
- The HR review screen hardcodes MYR and ignores the claim currency, so FX display is a real change, not a label.
- `Payout` and funding already assume a single company currency. `Payout.currency` is written from settings while the amount comes from the claim, which is wrong as soon as a claim is not in MYR.
