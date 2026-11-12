import { describe, expect, it } from "vitest";
import {
  CONTRACTOR_LINKS,
  EMPLOYEE_LINKS,
  drawerLinksForRole,
  navLinksForRole,
} from "./navLinks";

const hrefs = (links: { href: string }[]) => links.map((l) => l.href);

describe("navLinksForRole", () => {
  it("keeps the full employee nav for employees", () => {
    expect(navLinksForRole("Employee")).toBe(EMPLOYEE_LINKS);
    expect(hrefs(navLinksForRole("Employee"))).toContain("/employee/bookings");
  });

  it("gives a contractor only their own money pages", () => {
    expect(navLinksForRole("Contractor")).toBe(CONTRACTOR_LINKS);
    expect(hrefs(CONTRACTOR_LINKS)).toEqual([
      "/employee/dashboard",
      "/employee/claims",
      "/employee/history",
      "/employee/settings",
    ]);
  });

  it("hides bookings, the vendor directory and company surfaces from a contractor", () => {
    const links = navLinksForRole("Contractor");
    for (const hidden of ["/employee/bookings", "/employee/calendar", "/employee/drafts"]) {
      expect(hrefs(links)).not.toContain(hidden);
    }
    expect(links.every((l) => !l.label.toLowerCase().includes("vendor"))).toBe(true);
  });

  it("treats a missing role as an employee, matching the guard's fallback", () => {
    expect(navLinksForRole(undefined)).toBe(EMPLOYEE_LINKS);
  });
});

describe("drawerLinksForRole", () => {
  it("drops the booking and calendar drawer links for a contractor", () => {
    expect(hrefs(drawerLinksForRole("Contractor"))).not.toContain("/employee/bookings");
    expect(hrefs(drawerLinksForRole("Contractor"))).toContain("/employee/settings");
  });

  it("keeps the employee drawer unchanged", () => {
    expect(hrefs(drawerLinksForRole("Employee"))).toContain("/employee/bookings");
  });
});
