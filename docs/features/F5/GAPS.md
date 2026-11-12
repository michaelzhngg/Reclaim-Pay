# F5 gaps

Known limits of the contractor slice, beyond the explicit gaps in `PLAN.md`.

## Access

- Contractor data scoping is by `user_id` on the existing self-scoped endpoints. There is
  no per-contract permission table, so a future second payee on one contract would need
  its own rule.
- The contractor role cannot be changed from the UI. HR changes it through the existing
  user-creation/update path; a role change applies on the next request.
- Main removed `POST /auth/register` in favour of HR invites at `POST /employee/`, so a
  new contractor is created there with an explicit `role`; an omitted role is refused.

## Contracts

- One active contract per contractor. Editing overwrites terms and there is no amendment
  history.
- There is no contractor invite or contract acceptance flow; HR creates the user and the
  contract.
- The supported country and currency tables are static. Adding a destination is a code
  change and a deploy.
- Contract dates are inclusive and checked against the UTC date. There is no timezone per
  contractor.

## Money and FX

- The rate table is fixed and environment-overridable. There is no provider, spread,
  rate history or treasury policy.
- Rate movement between approval and payout is borne by the company; payouts are not
  re-priced.
- Minor units assume two decimals. Zero-decimal currencies (IDR, JPY and similar) are not
  handled for a live payout yet.
- A legacy foreign claim with no rate is shown unquoted and cannot pay until HR fixes its
  currency or a quote exists.
- Payouts now use the contract currency and the approval snapshot. A refused payout is
  recorded for HR but hidden from the claimant, who sees an approved, unpaid claim.
- The MYR guard can only be as right as the country on record. Vendors are created with
  MY and there is no vendor country edit screen yet; a non-Malaysian vendor would need a
  data change before a MYR payout to it is refused correctly.
- Balances are read before a live payout, but HR still has no per-currency funding
  runway alert. The funding card remains company-currency only.

## Contractor claims

- Contract receipt matching is by category label, case-insensitive. A policy edit that
  renames a category can leave a contract pointing at a label the policy no longer lists.
- Receipts outside the contract categories are grouped into one review claim per
  submission, not one claim per receipt.
- Contractor claims never take recovery offsets and contractor recoveries are refused.
  A contractor overpayment needs its own cross-currency design.
- There is no per-contract approval route. Contract claims sit in the normal HR queue. A
  blocked receipt claim is `DUAL_REVIEW` and cannot enter batch approval; an allowed
  contractor claim in `HR_QUICK` with no contract reason can. Batch approval now pays one
  PayPal batch per payout currency (ticket 07).
- A whole currency group that PayPal rejects is rolled back to APPROVED, but nothing
  retries the group automatically. HR pays the still-approved claims through the existing
  single-payout action, one claim at a time, using the per-claim sender key.
- The per-claim `sender_batch_id` is still 37 characters against PayPal's documented
  30-character cap. Batch groups use the new 24-character key; single payouts and their
  idempotency keep the old one until a separate change can migrate them safely.
- Mock PayPal ignores the sender key length and always accepts a batch, so sandbox and
  live mode must re-check the group key and the legacy per-claim key before a real run.
- The ledger's company amount comes from the stored company snapshot. A legacy foreign
  claim without one falls back to its raw claim amount and can overstate the company
  figure, as it already does elsewhere.

## Demo seed

- The contractor demo needs `PAYPAL_MOCK_BALANCES='{"MYR": "25000", "USD": "4000"}'` on
  the API process. The seed writes the payout settings but cannot change a running
  process's environment, so without it mock mode uses one balance for both groups.
- `--reset-demo` recreates the four contractor claims and updates the contracts, but it
  does not reset a contract edited through the UI beyond the fields the seed owns.
- The contract-check demo row is hand-placed at `HR_QUICK`. A real blocked-category claim
  is `DUAL_REVIEW`, so the exclusion is visible in the Quick tab only in the demo.
- Re-running the seed after a demo approval leaves those approved and paid rows in place;
  use `--reset-demo` to get the four claims back in `REVIEW`.
- Contractor invoices are ticket 05 and are live: one line item per invoice, no attachment,
  no generated PDF or tax-invoice fields, and no draft. The invoice period is not checked
  against the contract's effective dates, only the contract's active status on submission.
- An over-rate invoice routes to HR as `NEEDS_INFO`; the contract rate is not a hard cap,
  so HR can still approve the billed price. The reason is HR-only copy.
- An invoice submission does not run Receipt Shield or an LLM review, matching the
  deterministic intake in the plan.
- The contractor trust card reuses the employee badge design. Only its limit label and
  review sentence are contractor-specific.
