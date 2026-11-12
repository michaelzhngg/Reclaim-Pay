import { describe, expect, it } from "vitest";
import type { EmployeeRecord } from "@/lib/actions/employees";
import { diffEmployee, initialEditValues, needsConfirm } from "./editEmployee";

const record: EmployeeRecord = {
  user_id: "u1",
  user_code: "E-1",
  name: "Aisha Rahman",
  email: "aisha@example.com",
  role: "HR",
  department_id: "d1",
  department_name: "Finance",
  rank: 1,
  privilege_level: "Standard",
  is_active: true,
  bank_code: null,
  bank_account_number: null,
  bank_account_holder_name: null,
  created_at: null,
  invite_status: null,
};
const before = initialEditValues(record);

describe("diffEmployee", () => {
  it("is empty when nothing changed, including stray spaces", () => {
    expect(diffEmployee(before, { ...before, name: " Aisha Rahman  " })).toEqual({});
    expect(diffEmployee(before, {})).toEqual({});
  });

  it("sends cleared fields as null", () => {
    expect(diffEmployee(before, { ...before, user_code: "  ", department_id: "" }))
      .toEqual({ user_code: null, department_id: null });
  });

  it("sends only the changed fields", () => {
    expect(diffEmployee(before, { ...before, name: "Aisha R", role: "Employee", is_active: false }))
      .toEqual({ name: "Aisha R", role: "Employee", is_active: false });
  });

  it("treats a missing value from a disabled control as unchanged", () => {
    expect(diffEmployee(before, { name: "Aisha R", role: undefined, is_active: undefined })).toEqual({ name: "Aisha R" });
  });
});

describe("needsConfirm", () => {
  it("asks before deactivating or removing HR access", () => {
    expect(needsConfirm(before, { is_active: false })).toBe(true);
    expect(needsConfirm(before, { role: "Employee" })).toBe(true);
  });

  it("doesn't ask for renames, reactivation or granting HR", () => {
    expect(needsConfirm(before, { name: "New" })).toBe(false);
    expect(needsConfirm({ ...before, is_active: false }, { is_active: true })).toBe(false);
    expect(needsConfirm({ ...before, role: "Employee" }, { role: "HR" })).toBe(false);
  });
});
