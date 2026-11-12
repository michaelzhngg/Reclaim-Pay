"use server";

import { apiGet, apiPatch, apiPost, API_PREFIX } from "@/lib/api/client";
import type { Department } from "@/lib/api/types";

export type InviteStatus = "pending" | "expired" | null;

export interface EmployeeRecord {
  user_id: string;
  user_code: string | null;
  name: string;
  email: string;
  role: string;
  department_id: string | null;
  department_name: string | null;
  rank: number | null;
  privilege_level: string;
  is_active: boolean;
  bank_code: string | null;
  bank_account_number: string | null;
  bank_account_holder_name: string | null;
  created_at: string | null;
  invite_status: InviteStatus;
}

export interface NewEmployee {
  name: string;
  email: string;
  user_code?: string;
  department_id?: string;
  role: "Employee" | "HR";
}

/** Only the fields being changed. Email is the sign-in and can't be changed here. */
export interface EmployeeChanges {
  name?: string;
  user_code?: string | null;
  department_id?: string | null;
  role?: "Employee" | "HR";
  is_active?: boolean;
}

/** The link is in this response only. The backend never returns it again. */
export interface InviteResult {
  email: string;
  invite_link: string;
  invite_expires_at: string;
  /** "sent", "off" (the server has no email key) or "failed" (the email service refused it). */
  email_status: "sent" | "off" | "failed";
  email_error: string | null;
}

export async function listEmployees(): Promise<{ data: EmployeeRecord[]; error: string | null }> {
  const result = await apiGet<EmployeeRecord[]>(`${API_PREFIX}/employee/`);
  return { data: result.data ?? [], error: result.error };
}

export async function getEmployees(): Promise<EmployeeRecord[]> {
  return (await listEmployees()).data;
}

export async function getDepartments(): Promise<{ data: Department[]; error: string | null }> {
  const result = await apiGet<Department[]>(`${API_PREFIX}/departments/`);
  return { data: result.data ?? [], error: result.error };
}

export async function createEmployee(input: NewEmployee): Promise<{ data: InviteResult | null; error: string | null }> {
  const result = await apiPost<Omit<InviteResult, "email"> & { employee: EmployeeRecord }>(
    `${API_PREFIX}/employee/`,
    {
      name: input.name,
      email: input.email,
      user_code: input.user_code || null,
      department_id: input.department_id || null,
      role: input.role,
    },
  );
  if (result.status === 422) return { data: null, error: "Check the name and email, then try again." };
  if (!result.data) return { data: null, error: result.error ?? "We couldn't create the account. Try again." };
  const { employee, ...invite } = result.data;
  return { data: { email: employee.email, ...invite }, error: null };
}

export async function resendInvite(userId: string): Promise<{ data: InviteResult | null; error: string | null }> {
  const result = await apiPost<InviteResult>(`${API_PREFIX}/employee/${encodeURIComponent(userId)}/invite`);
  if (!result.data) return { data: null, error: result.error ?? "We couldn't send a new invitation. Try again." };
  return { data: result.data, error: null };
}

export async function updateEmployee(
  userId: string,
  changes: EmployeeChanges,
): Promise<{ data: EmployeeRecord | null; error: string | null }> {
  const result = await apiPatch<EmployeeRecord>(`${API_PREFIX}/employee/${encodeURIComponent(userId)}`, changes);
  if (result.status === 422) return { data: null, error: "Check the name and company ID, then try again." };
  if (!result.data) return { data: null, error: result.error ?? "We couldn't save the changes. Try again." };
  return { data: result.data, error: null };
}
