"use server";

// ─── Month-end report (F12) ──────────────────────────────────────────────────
// HR only. Every number comes from SQL on the backend; the model only writes the summary.
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, apiPost, API_PREFIX } from "@/lib/api/client";
import type { MonthlyReport } from "@/lib/api/reclaim-pay-types";

export async function getMonthlyReport(month?: string): Promise<{ report: MonthlyReport | null; error: string | null }> {
  const query = month ? `?month=${encodeURIComponent(month)}` : "";
  const result = await apiGet<MonthlyReport>(`${API_PREFIX}/reports/monthly${query}`);
  return { report: result.data ?? null, error: result.data ? null : (result.error ?? "Couldn't load the report.") };
}

export async function regenerateMonthlyReport(month: string): Promise<{ report: MonthlyReport | null; error: string | null }> {
  const result = await apiPost<MonthlyReport>(`${API_PREFIX}/reports/monthly/${encodeURIComponent(month)}/regenerate`);
  return { report: result.data ?? null, error: result.data ? null : (result.error ?? "Couldn't rebuild the report.") };
}
