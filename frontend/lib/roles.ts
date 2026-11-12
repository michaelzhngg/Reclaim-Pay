/**
 * Role helpers shared by the login redirect, the employee shell and its guards.
 *
 * Contractors reuse the employee portal. HR is the only role with its own portal.
 */

export type AppRole = "HR" | "Employee" | "Contractor";

/** Where a signed-in user lands, and the home its guard redirects to. */
export function homePathForRole(role: string | null | undefined): string {
  return role === "HR" ? "/hr/dashboard" : "/employee/dashboard";
}

/** The employee shell admits employees and contractors; HR is redirected to its own portal. */
export function isPersonalPortalRole(role: string | null | undefined): boolean {
  return role === "Employee" || role === "Contractor";
}

/** The portal badge in the shell. Empty values read "Not set". */
export function portalLabelForRole(role: string | null | undefined): string {
  if (role === "Contractor") return "Contractor";
  if (role === "HR") return "HR";
  if (role === "Employee") return "Employee";
  return "Not set";
}
