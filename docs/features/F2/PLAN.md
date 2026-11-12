# F2: Company-paid vendor bookings

**Status:** planned, not implemented
**Branch:** `feat/f2-vendor-bookings`
**Scope:** an employee books a vendor; the deterministic engine routes the booking and, when it is safe, pays the vendor from the company PayPal account. Mock PayPal only.

## Problem

Employees front money for hotels, travel and events, then wait for reimbursement. F2 removes that float: the employee books the vendor through Reclaim Pay and the company pays the vendor directly. The same evidence and approval rules that protect employee claims must protect company money, without adding a second payment rail or a second source of auto-pay.

## The slice

One end-to-end path, five demos:

1. An employee enters a vendor (existing or new), amount, service dates, category and purpose.
2. The backend records a booking and runs a deterministic policy check.
3. `decide()` picks the lane, exactly as it does for a claim.
4. A verified vendor within limits reaches auto-pay and the existing payout service pays the vendor's verified PayPal account.
5. Everything else lands in the existing HR triage queue with vendor evidence. HR approval pays the vendor through the same payout service.
6. The employee sees the booking in history with the vendor name, amount and status, and never sees a risk score or signal name.

No receipt is required at booking time. F3 will attach the receipt to the paid booking later.

## Design

### Vocabulary

- **Vendor booking** (`VendorBooking`): the service request. Vendor, dates, purpose, amount.
- **Vendor** (`Vendor`): a company-wide payee record, with payout-account fields shaped like an employee's.
- **Claim** (`Reimbursement`): still the thing that carries a decision, approvals and a payout. A booking uses one as its financial record.

### Why a booking is a `Reimbursement` row

A booking reuses the claim record rather than duplicating the decision, approval, payout, notification, audit and recovery machinery. A `kind` discriminator (`CLAIM` or `VENDOR_BOOKING`) keeps the two apart in lists, copy and reporting. `decide()` remains the only producer of `AUTO_PAY`, and there is still one payout rail.

Consequences to handle explicitly:

- Every list, dashboard total, history filter and report that reads `Reimbursement` must decide whether bookings belong there. The default is to include them, labelled, except money-to-employee totals.
- One implicit line item per booking keeps the existing approval math and payout netting unchanged.
- `Payout.user_id` stays the requesting employee for attribution and notifications. A new nullable `Payout.vendor_id` records the actual payee.

### Models

| Table | Fields that matter | Notes |
|---|---|---|
| `vendors` | `vendor_id`, `name`, `name_key` (unique), `default_category`, `paypal_email`, `paypal_payer_id`, `paypal_verified`, `paypal_linked_at`, `payout_destination_changed_at`, `is_active`, `created_by`, timestamps | Payee fields mirror `User` so `PayeeStatus` works with no mapping layer. |
| `vendor_bookings` | `booking_id`, `reim_id` (unique FK), `vendor_id`, `service_start`, `service_end`, `purpose`, `created_at` | One booking per reimbursement row. |
| `reimbursements` | new `kind` string, not null, server default `CLAIM`, indexed | Existing rows become `CLAIM`. |
| `payouts` | new nullable `vendor_id` FK | Null for employee payouts. |
| `line_items` | existing table, one row per booking | `document_id` stays null until F3. |

`name_key` is a conservative dedupe key: case-folded, trimmed, inner whitespace collapsed. It is not the shield's aggressive merchant normaliser, because two different vendors must not merge.

### Booking states

No new statuses. The booking uses `ReimbursementStatus`:

| State | Meaning |
|---|---|
| `REVIEW` | Waiting for HR. Every new or unverified vendor starts here. |
| `APPROVED` | Approved by `decide()` or by enough HR approvers, ready for payout. |
| `DISBURSING` | PayPal accepted the payout. |
| `PAID` | PayPal reported success. |
| `DISBURSEMENT_FAILED` | PayPal refused; HR can retry through the payouts screen. |
| `REJECTED` | HR refused. No payout. |

Approval counts and two-person review come from the existing `tier` and `approvals` fields, unchanged.

### Decision path

`POST /vendor-bookings` builds the inputs and calls `decide()` once:

| Input | Booking value |
|---|---|
| `ClaimFacts.amount` | booking amount |
| `ClaimFacts.currency` | company payout currency |
| `ClaimFacts.judgment` | `APPROVED` when the deterministic policy check passes, `NEEDS_INFO` when the category is not covered |
| `ClaimFacts.confidence` | `1.0`; there is no AI reading to discount |
| `ClaimFacts.over_category_budget` | true when the amount exceeds the category's auto-approval budget |
| `ClaimFacts.claimant_is_hr` | true when the requester is HR |
| `signals` | empty; there is no receipt to shield-check yet |
| `history` | the requester's claim history |
| `payee` | the vendor's verification and change timestamps |
| `ledger` | company ledger, including vendor payments once ticket 05 lands |
| `config` | the live autonomy config |

Policy check rules, deterministic and LLM-free:

- Find the active policy that lists the chosen category, newest effective date first, matching how claims resolve policy.
- No active policy lists the category: `NEEDS_INFO`. The booking goes to HR.
- Category listed and the amount is over `auto_approval_budget`: the booking still counts as policy-compliant, but `over_category_budget` is true, so the existing hard stop sends it to HR.
- Within budget or no budget set: policy check passes.

If the policy check passes and the vendor is clean, the existing trust limits, daily caps, company budget, breaker and audit sampling all still apply.

### Guardrails mapped to existing mechanisms

| Guardrail | Mechanism | No new engine rule needed |
|---|---|---|
| A new vendor always needs HR approval | A newly created vendor has `paypal_verified = false`, so `PayeeStatus.verified` is false and `decide()` reports `PAYEE_NOT_VERIFIED` | Yes |
| Vendor payout accounts are verified like employee accounts | Vendor carries the same `verified`, `linked_at` and `changed_at` fields; verification reuses the same link rules | Yes |
| A vendor payee change starts the same 72-hour pause | Change sets `payout_destination_changed_at`; `decide()` reports `PAYEE_COOLDOWN` for `payee_cooldown_hours` | Yes |
| The company daily budget includes vendor payments | Vendor payouts in `DISBURSING`/`PAID` today add to a new `AgentLedger.vendor_paid_today`; the `AGENT_DAILY_BUDGET` hard stop sums it | Small pure-engine addition, ticket 05 |
| New vendor cannot auto-pay | Same `PAYEE_NOT_VERIFIED` path; no bypass flag, no request field can set verification | Yes |
| A booking cannot slip through batch approval | The batch eligibility rule skips `VENDOR_BOOKING` rows, so each booking gets individual review | Small approvals addition |
| `decide()` stays the only source of `AUTO_PAY` | The route only persists the decision; it never decides the status itself | Yes |

A vendor created during booking is unverified by construction. HR verification (ticket 03) is what makes the next booking eligible for auto-pay. The first booking still required HR action, which satisfies "a new vendor always needs HR approval".

Interpretation to confirm with product: "new vendor" means a vendor the company has not verified, not a vendor this employee has never used. Employee-level first-use flags are not in this slice.

### Payout reuse

`engine/services/payout_service.py` stays the only payout entry point. Changes:

- Resolve the payee by `Reimbursement.kind`: employee fields for claims, vendor fields for bookings.
- Persist `vendor_id` on the payout and show the vendor as the payee in the ledger.
- Branch notification copy: the requester is told the vendor was paid, not that money arrived in their PayPal.
- Keep `sender_batch_id` derived from the reimbursement and attempt, so retries cannot double-pay a vendor.
- Keep payout status to reimbursement status mapping unchanged.

No new PayPal client methods. In mock mode the existing client accepts the vendor's mock payer ID.

### Verification and account changes

Verification is an HR action, not employee self-service. In mock mode it derives a deterministic mock payer identity for the vendor. The real sandbox path needs PayPal merchant onboarding, which is a documented gap; the endpoint must fail with a clear "not available" response rather than pretending a merchant was verified.

Link rules are shared with the employee flow, extracted from the PayPal connect module into a service helper so both paths use one implementation:

- First link sets `paypal_linked_at`; it does not set `payout_destination_changed_at`.
- Changing the payer ID after a first link sets `payout_destination_changed_at`.
- Re-submitting the same payer ID changes nothing and does not restart the pause.
- A payer ID already attached to another vendor or employee is refused.

### Budget

Vendor payments are committed company spend. Ticket 05 adds `vendor_paid_today` to the ledger and includes it in the `AGENT_DAILY_BUDGET` check. Counted when the payout reaches `DISBURSING` or `PAID` that UTC day; an approved but unpaid booking does not reserve budget. Vendor spend does not feed the circuit breaker's hourly auto-pay velocity, because HR-approved spend is not agent velocity.

The employee daily and monthly caps still apply to a booking's amount per request. They do not accumulate vendor spend, since the employee receives no money. This is conservative and deliberate.

### UI

Employee:

- New `Book a vendor` page and nav link.
- Vendor picker lists active vendors. `Add a new vendor` is a name field; the vendor starts unverified.
- Fields: vendor, amount (company currency), category from the active policy, service start and end, purpose.
- Result panel says paid, sent to HR, or needs HR without exposing why in risk terms. The same copy rules as claims apply.
- History row gets a `Vendor booking` chip and the vendor name. The detail view gets a vendor block: vendor, dates, purpose, payout state.

HR:

- Triage row gets a `Vendor booking` chip, vendor name, and verification state. Existing lane tabs apply, but bookings are never batch-approved in this slice; each one gets an individual HR review of the vendor and dates.
- Detail gets a vendor card: name, masked PayPal email, verified or not, cooldown date, service dates, purpose. Actions live here: verify account, change account.
- Payouts ledger shows the vendor as payee and keeps the requesting employee as the requester.
- No booking-specific copy should imply the AI read a receipt.

### API surface

| Method | Path | Role | Purpose |
|---|---|---|---|
| `POST` | `/vendor-bookings` | employee | Create a booking and run the decision |
| `GET` | `/vendors` | employee | Active vendors for the picker |
| `GET` | `/reimbursements?kind=VENDOR_BOOKING` | both | Booking history; existing endpoint gains the filter |
| `POST` | `/vendors/{id}/verify` | HR | Verify the vendor's payout account (ticket 03) |
| `PATCH` | `/vendors/{id}/paypal` | HR | Change the vendor's payout account (ticket 04) |

Approval and payout reuse the existing reimbursement status and payouts endpoints.

## Acceptance criteria for the slice

- [ ] An employee can book a seeded verified vendor and, when the decision is auto-pay, the vendor's PayPal account receives the money in mock mode. The employee's own PayPal is never the payee.
- [ ] An employee can book a brand-new vendor. It is created unverified, routes to HR, and cannot be auto-paid or paid until HR verifies it.
- [ ] HR sees the booking in the existing triage queue with vendor, dates, purpose, amount and verification state, and can approve or reject it with the existing controls.
- [ ] Approving a booking pays the vendor through the existing payout service; rejecting it pays nobody.
- [ ] Changing a verified vendor's payout account pauses auto-pay for 72 hours, and the next booking goes to HR.
- [ ] Vendor payments count against the company daily budget.
- [ ] Employee responses contain no risk score, signal name, hard stop, vendor payer ID or vendor email.
- [ ] Every schema change has a SQLModel model and an Alembic migration.
- [ ] Backend tests pass with Postgres, frontend `tsc --noEmit` and vitest pass.

## Explicit gaps

- **F3 receipt matching is not built.** A booking is paid on the employee's declaration. Attaching the receipt, matching vendor, amount and dates, and closing the booking as a fully evidenced claim is F3. The record is shaped for it: the same reimbursement row gains documents and line-item evidence.
- **Real PayPal merchant payments are not built.** Mock mode only. Sandbox and production need merchant onboarding (seller permissions or partner referral), eligibility checks, and a decision about who owns the vendor account link. Ticket 03's sandbox path must fail closed with a clear message.
- **No vendor self-service.** Vendors do not log in and do not link their own account. HR attests the account, which is weaker than the employee OAuth proof.
- **No invoice, tax or reconciliation document from the vendor.** The payout ledger reconciles the PayPal transaction, not a vendor invoice.
- **No refunds, cancellations or vendor overpayment recovery.** `Recovery` remains employee-centric.
- **No manager or department-head routing.** "Right approver" in this slice means the existing lane to HR, with two-person review for high amounts, not a named manager.
- **No vendor contracts or rate cards.** The policy check validates category and budget only, not a negotiated nightly rate.
- **Single currency.** The company payout currency is used; employee-selected currency is not supported.

## Risks

| Risk | Mitigation |
|---|---|
| Reusing claims for bookings leaks bookings into employee money totals or reports | Audit every `Reimbursement` query in ticket 01; add `kind` filters and labels; test the employee dashboard totals. |
| A booking is paid before any receipt exists | New vendors need HR; limits and company budget apply; F3 is the follow-up. State this on the HR card and in the demo script. |
| Vendor verification is HR-attested, so a wrong account can be registered | Same-account uniqueness across vendors and employees, masked display, 72-hour pause on change, action log. |
| `Payout.user_id` now means requester, not payee, for bookings | Add `vendor_id`; audit the ledger, reconcile and funding readers; test a booking payout end to end. |
| Category names from the policy may not match free text | UI offers only categories from active policies; API resolves by exact category and fails closed to HR. |
| Employee trust limits are small compared with hotel bills, so most bookings go to HR | Accepted for the slice: HR approval still removes the employee's float. A vendor-specific auto-pay threshold is future work. |
| An HR user books and cannot approve their own booking | Existing self-approval rule applies; another HR user must approve. Document in the empty state. |

## Test strategy

- Pure: booking policy check; vendor dedupe key; link and cooldown rules; ledger with vendor spend.
- Postgres (`TEST_DATABASE_URL`): create booking as new vendor -> `REVIEW` with `PAYEE_NOT_VERIFIED`; seeded verified vendor -> `AUTO_PAY`; approval path; payout to vendor payer ID; employee response redaction; account change -> `PAYEE_COOLDOWN`; budget hard stop.
- Frontend: vitest for pure label and status mapping, `tsc --noEmit`; no rendered-component tests, matching the repo.
- Migration: upgrade a scratch database and confirm the seed still runs.

## Tickets

| # | Ticket | Blocked by |
|---|---|---|
| 01 | Book a vendor and route it to the right lane | None |
| 02 | Pay a verified vendor from the company account | 01 |
| 03 | Verify a new vendor's payout account | 01, 02 |
| 04 | Vendor payout account changes start the 72-hour pause | 02, 03 |
| 05 | Count vendor payments against the company daily budget | 02 |
