import type { EmployeeChanges, EmployeeRecord } from "@/lib/actions/employees";

export interface EditValues {
  name: string;
  user_code: string;
  department_id: string;
  role: "Employee" | "HR";
  is_active: boolean;
}

export function initialEditValues(emp: EmployeeRecord): EditValues {
  return {
    name: emp.name,
    user_code: emp.user_code ?? "",
    department_id: emp.department_id ?? "",
    role: emp.role === "HR" ? "HR" : "Employee",
    is_active: emp.is_active,
  };
}

/** Only what differs from the saved record, in the shape the API takes. Missing fields count as unchanged. */
export function diffEmployee(before: EditValues, after: Partial<EditValues>): EmployeeChanges {
  const changes: EmployeeChanges = {};
  const name = (after.name ?? before.name).trim();
  const code = (after.user_code ?? before.user_code).trim();
  const dept = after.department_id ?? before.department_id;
  const role = after.role ?? before.role;
  const active = after.is_active ?? before.is_active;
  if (name !== before.name) changes.name = name;
  if (code !== before.user_code) changes.user_code = code || null;
  if (dept !== before.department_id) changes.department_id = dept || null;
  if (role !== before.role) changes.role = role;
  if (active !== before.is_active) changes.is_active = active;
  return changes;
}

/** Deactivating or taking away HR access ends access straight away, so it gets a confirm step. */
export function needsConfirm(before: EditValues, changes: EmployeeChanges): boolean {
  return changes.is_active === false || (before.role === "HR" && changes.role === "Employee");
}
