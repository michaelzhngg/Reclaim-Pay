"use server";

// ─── Dashboard Server Actions ─────────────────────────────────────────────────
// Provides dashboard KPI stats and recent claims.
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, API_PREFIX } from "@/lib/api/client";
import type { DashboardStats, ClaimSummary, ReimbursementRaw } from "@/lib/api/types";
import { mapReimbursementToClaim } from "@/lib/api/types";
import { employeeDashboardStats } from "@/lib/claims/stats";

// ─── Actions ─────────────────────────────────────────────────────────────────

/** Fetch all reimbursements and compute KPI stats server-side. */
export async function getDashboardStats(): Promise<DashboardStats> {
  const result = await apiGet<ReimbursementRaw[]>(`${API_PREFIX}/reimbursements/`);
  if (!result.data || result.data.length === 0) {
    return employeeDashboardStats([]);
  }
  return employeeDashboardStats(result.data);
}

/** Fetch the N most recent claims for the dashboard table. */
export async function getRecentClaims(limit = 5): Promise<ClaimSummary[]> {
  const result = await apiGet<ReimbursementRaw[]>(
    `${API_PREFIX}/reimbursements/?limit=${limit}`
  );
  if (!result.data) return [];
  const sorted = [...result.data].sort((a, b) => {
    const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
    const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
    return dateB - dateA;
  });
  return sorted.map(mapReimbursementToClaim);
}
