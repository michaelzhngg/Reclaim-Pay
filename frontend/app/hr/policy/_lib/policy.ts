// Pure helpers for the Policy Studio (/hr/policy). Everything the page shows comes from
// GET /api/v1/policies/. The only edits the backend accepts are category budgets,
// retiring (deprecate) and deleting a policy, so the page offers nothing else.

import type { Policy as BackendPolicy } from "@/lib/api/types";

export type PolicyStatus = "Active" | "Impending" | "Expired";

export interface SubCategoryCondition {
  condition: string[];
}

export type MandatoryConditions = Record<string, SubCategoryCondition>;

/** One policy as the Policy Studio renders it. */
export interface Policy {
  policy_id: string;
  alias: string;
  title: string;
  status: PolicyStatus;
  /** Effective date formatted for display, or "" when the policy has none. */
  lastModified: string;
  overview_summary: string;
  mandatory_conditions: MandatoryConditions | null;
  reimbursable_categories_with_budgets: { category: string; auto_approval_budget: number | null }[];
  source_file_url: string;
  effective_date: string | null;
}

export const POLICY_STATUS_STYLE: Record<PolicyStatus, string> = {
  Active: "bg-success-soft text-success",
  Impending: "bg-warning-soft text-warning",
  Expired: "bg-line text-ink-muted",
};

/** Browser keys an older Policy Studio used to fake edits and deletions. Cleared on load. */
export const LEGACY_STORAGE_KEYS = ["local_policy_edits", "deleted_policy_ids"] as const;

export function statusFromBackend(status: BackendPolicy["status"]): PolicyStatus {
  if (status === "ACTIVE") return "Active";
  if (status === "DEPRECATED") return "Expired";
  return "Impending";
}

/** Accepts the JSON string or object the backend stores; keeps only well-formed categories. */
export function parseMandatoryConditions(raw: unknown): MandatoryConditions | null {
  let value = raw;
  if (typeof value === "string") {
    if (!value.trim()) return null;
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const out: MandatoryConditions = {};
  for (const [category, details] of Object.entries(value as Record<string, unknown>)) {
    const list = (details as { condition?: unknown } | null)?.condition;
    if (!Array.isArray(list)) continue;
    out[category] = { condition: list.filter((c): c is string => typeof c === "string" && c.trim() !== "") };
  }
  return Object.keys(out).length > 0 ? out : null;
}

export function formatPolicyDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-MY", { month: "short", day: "numeric", year: "numeric" });
}

export function toPolicy(p: BackendPolicy): Policy {
  return {
    policy_id: p.policy_id,
    alias: p.alias || p.title || "Untitled policy",
    title: p.title ?? "",
    status: statusFromBackend(p.status),
    lastModified: formatPolicyDate(p.effective_date),
    overview_summary: p.overview_summary ?? "",
    mandatory_conditions: parseMandatoryConditions(p.mandatory_conditions),
    reimbursable_categories_with_budgets: (p.reimbursable_categories_with_budgets ?? []).map((c) => ({
      category: c.category,
      auto_approval_budget: c.auto_approval_budget ?? null,
    })),
    source_file_url: p.source_file_url ?? "",
    effective_date: p.effective_date ?? null,
  };
}

/** The stored file's name, from a server path like "storage/policies/travel.pdf". */
export function sourceFileName(url: string | null | undefined): string {
  if (!url) return "";
  return url.split(/[\\/]/).pop() ?? "";
}

/** Second line under a policy's name in lists, e.g. "Effective Nov 1, 2026 · 4 categories". */
export function policyMeta(p: Policy): string {
  const parts: string[] = [];
  if (p.lastModified) parts.push(`Effective ${p.lastModified}`);
  const n = p.reimbursable_categories_with_budgets.length;
  if (n > 0) parts.push(`${n} ${n === 1 ? "category" : "categories"}`);
  return parts.join(" · ");
}

export function matchesSearch(p: Policy, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [p.alias, p.title, ...p.reimbursable_categories_with_budgets.map((c) => c.category)]
    .some((text) => text.toLowerCase().includes(q));
}

/** Budget inputs keyed by category: the policy's categories, else its condition categories. */
export function budgetInputs(p: Policy): Record<string, string> {
  const out: Record<string, string> = {};
  if (p.reimbursable_categories_with_budgets.length > 0) {
    for (const c of p.reimbursable_categories_with_budgets) {
      out[c.category] = c.auto_approval_budget == null ? "" : String(c.auto_approval_budget);
    }
  } else if (p.mandatory_conditions) {
    for (const category of Object.keys(p.mandatory_conditions)) out[category] = "";
  }
  return out;
}

export type BudgetPayload =
  | { ok: true; categories: { category: string; auto_approval_budget: number | null }[] }
  | { ok: false; error: string };

/** Turns the budget inputs into the PATCH body. Blank means no limit; anything else must be a number ≥ 0. */
export function budgetsPayload(inputs: Record<string, string>): BudgetPayload {
  const categories: { category: string; auto_approval_budget: number | null }[] = [];
  for (const [category, raw] of Object.entries(inputs)) {
    const text = raw.trim();
    if (text === "") {
      categories.push({ category, auto_approval_budget: null });
      continue;
    }
    const value = Number(text);
    if (!Number.isFinite(value) || value < 0) {
      return { ok: false, error: `Enter an amount of 0 or more for ${category}, or leave it blank for no limit.` };
    }
    categories.push({ category, auto_approval_budget: Math.round(value * 100) / 100 });
  }
  return { ok: true, categories };
}
