import { describe, expect, it } from "vitest";
import { homePathForRole, isPersonalPortalRole, portalLabelForRole } from "./roles";

describe("homePathForRole", () => {
  it("sends HR to the HR dashboard", () => {
    expect(homePathForRole("HR")).toBe("/hr/dashboard");
  });

  it("sends employees and contractors to the employee portal", () => {
    expect(homePathForRole("Employee")).toBe("/employee/dashboard");
    expect(homePathForRole("Contractor")).toBe("/employee/dashboard");
  });

  it("falls back to the employee portal when the role is missing", () => {
    expect(homePathForRole(null)).toBe("/employee/dashboard");
    expect(homePathForRole(undefined)).toBe("/employee/dashboard");
  });
});

describe("isPersonalPortalRole", () => {
  it("admits employees and contractors", () => {
    expect(isPersonalPortalRole("Employee")).toBe(true);
    expect(isPersonalPortalRole("Contractor")).toBe(true);
  });

  it("keeps HR out of the personal portal", () => {
    expect(isPersonalPortalRole("HR")).toBe(false);
    expect(isPersonalPortalRole(null)).toBe(false);
  });
});

describe("portalLabelForRole", () => {
  it("names each role", () => {
    expect(portalLabelForRole("HR")).toBe("HR");
    expect(portalLabelForRole("Employee")).toBe("Employee");
    expect(portalLabelForRole("Contractor")).toBe("Contractor");
  });

  it("reads Not set when the role is missing", () => {
    expect(portalLabelForRole(null)).toBe("Not set");
  });
});
