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
