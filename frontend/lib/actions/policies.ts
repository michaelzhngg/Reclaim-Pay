"use server";

// ─── Policies Server Actions ─────────────────────────────────────────────────
// Provides reimbursement policy categories and rules.
// A failed request throws, so the Policy Studio shows its error state.
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, apiDelete, apiPatch, API_PREFIX } from "@/lib/api/client";
import type { Policy, PolicyCategoryBudget } from "@/lib/api/types";

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Fetch all reimbursable policies from the backend. */
export async function getPolicies(): Promise<Policy[]> {
  const result = await apiGet<unknown[]>(`${API_PREFIX}/policies/`);
  if (result.error) throw new Error(result.error);
  if (!result.data) return [];

  return result.data.map((item: unknown) => {
    const p = item as Record<string, unknown>;
    return {
      policy_id: p.policy_id as string,
      alias: p.alias as string,
      title: p.title as string,
      reimbursable_categories: (p.reimbursable_categories ?? p.reimbursable_category ?? []) as string[],
      reimbursable_categories_with_budgets: (p.reimbursable_categories_with_budgets ?? []) as PolicyCategoryBudget[],
      overview_summary: p.overview_summary as string,
      status: p.status as "DRAFT" | "ACTIVE" | "DEPRECATED",
      effective_date: (p.effective_date as string | null) ?? null,
      expiry_date: (p.expiry_date as string | null) ?? null,
      mandatory_conditions: (p.mandatory_conditions as string) ?? "",
      source_file_url: (p.source_file_url as string) ?? "",
      created_by: (p.created_by as string) ?? undefined,
    };
  });
}

/** Delete a policy by its ID. Returns { ok: true } on success or { ok: false, error } on failure. */
export async function deletePolicy(policyId: string): Promise<{ ok: boolean; error?: string }> {
  const result = await apiDelete<null>(`${API_PREFIX}/policies/${policyId}`);
  if (result.error) return { ok: false, error: result.error };
  return { ok: true };
}

/** Retire a policy: the backend sets it to DEPRECATED and stamps its expiry date. */
export async function deprecatePolicy(policyId: string): Promise<{ ok: boolean; error?: string }> {
  const result = await apiPatch<unknown>(`${API_PREFIX}/policies/${policyId}/deprecate`, {});
  if (result.error) return { ok: false, error: result.error };
  return { ok: true };
}

/** Update auto-approval budgets for policy categories. */
export async function updatePolicyCategories(
  policyId: string,
  categories: { category: string; auto_approval_budget: number | null }[]
): Promise<{ ok: boolean; error?: string }> {
  const result = await apiPatch<void>(`${API_PREFIX}/policies/${policyId}/categories`, {
    categories,
  });
  if (result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}
