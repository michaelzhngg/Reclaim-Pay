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
