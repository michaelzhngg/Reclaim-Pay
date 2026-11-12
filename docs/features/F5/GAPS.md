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
