# F5 gaps

Known limits of the contractor slice, beyond the explicit gaps in `PLAN.md`.

## Access

- Contractor data scoping is by `user_id` on the existing self-scoped endpoints. There is
  no per-contract permission table, so a future second payee on one contract would need
  its own rule.
- The contractor role cannot be changed from the UI. HR changes it through the existing
  user-creation/update path; a role change applies on the next request.

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
- Payouts still send the company currency in this stage. The payout snapshot fields and
  the contract payout currency land in ticket 06.

## Contractor claims

- Contract receipt matching is by category label, case-insensitive. A policy edit that
  renames a category can leave a contract pointing at a label the policy no longer lists.
- Receipts outside the contract categories are grouped into one review claim per
  submission, not one claim per receipt.
- There is no per-contract approval route or contract-specific batch rule yet. Contract
  claims sit in the normal HR queue. A blocked receipt claim is `DUAL_REVIEW` and cannot
  enter batch approval; an allowed contractor claim in `HR_QUICK` can. Per-currency
  batching belongs to ticket 07.
- Contractor invoices are ticket 05 and are live: one line item per invoice, no attachment,
  no generated PDF or tax-invoice fields, and no draft. The invoice period is not checked
  against the contract's effective dates, only the contract's active status on submission.
- An over-rate invoice routes to HR as `NEEDS_INFO`; the contract rate is not a hard cap,
  so HR can still approve the billed price. The reason is HR-only copy.
- An invoice submission does not run Receipt Shield or an LLM review, matching the
  deterministic intake in the plan.
- The contractor trust card reuses the employee badge design. Only its limit label and
  review sentence are contractor-specific.
