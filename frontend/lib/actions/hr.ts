"use server";

// ─── HR Server Actions ────────────────────────────────────────────────────────
// Fetches reimbursement data for the HR dashboard and detail view.
// HR role receives ALL reimbursements (no user filter on the backend).
// Maps backend ReimbursementRaw → triage rows (dashboard) and ClaimBundle (detail).
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, apiPatch, apiPost, apiPostMultipart, API_PREFIX } from "@/lib/api/client";
import { withFixture } from "@/lib/api/fixtures";
import type { ReimbursementRaw, ClaimBundle, PayoutInfo, AiStatus } from "@/lib/api/types";
import { triageRows, type TriageRow, type TriageSource } from "@/components/hr-grid/rows";
import { triageReimbursements } from "@/src/mocks/triageFixtures";
import { formatClaimRef } from "@/lib/format";
import { toClaimAutonomy } from "@/lib/hr/evidence";
import { hrClaimStats } from "@/lib/claims/stats";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function judgmentToAiStatus(judgment: string): AiStatus {
  const j = judgment.toUpperCase();
  if (j === "NEEDS_INFO") return "Awaiting Review";
  if (j === "REJECTED") return "Policy Flagged";
  if (j === "PARTIAL") return "Policy Flagged";
  // APPROVED
  return "Passed AI Review";
}

function getInitials(name: string): string {
  return name
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join("");
}

function formatDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleDateString("en-MY", { month: "short", day: "numeric", year: "numeric" });
}

/** "3 Nov": short enough for a table column. */
function formatShortDate(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

/** Map a raw reimbursement to the ClaimBundle detail shape. */
function mapToBundle(r: TriageSource): ClaimBundle {
  const employeeName = r.employee_name ?? "Unknown";
  const deptName = r.department_name ?? "Unknown";

  const lineItems = (r.line_items ?? []).map((li) => ({
    document_id: li.document_id ?? `${r.reim_id}-li-unknown`,
    line_item_id: li.line_item_id ?? undefined,
    date: li.expense_date ?? r.created_at?.split("T")[0] ?? "",
    category: (li.category ?? "others").toLowerCase().includes("meal")
      ? "meals" as const
      : (li.category ?? "others").toLowerCase().includes("transport")
        ? "transportation" as const
        : (li.category ?? "others").toLowerCase().includes("accom")
          ? "accommodation" as const
          : "others" as const,
    description: li.description ?? "Receipt",
    status: (li.judgment ?? "PENDING") as "APPROVED" | "REJECTED" | "PARTIAL_APPROVE" | "PENDING",
    requested_amount: li.claimed_amount ?? 0,
    approved_amount: li.approved_amount ?? 0,
    deduction_amount: (li.claimed_amount ?? 0) - (li.approved_amount ?? 0),
    audit_notes: li.rejection_reason
      ? [{ tag: "", message: li.rejection_reason }]
      : [],
    human_edited: li.human_edited ?? false,
  }));

  return {
    id: r.reim_id,
    employee: {
      name: employeeName,
      initials: getInitials(employeeName),
      // The staff number, never the user UUID. Empty hides the field.
      employee_no: r.employee_code ?? "",
      position: "",
      department: deptName,
      location: "",
      entity: "Reclaim Sdn. Bhd.",
      email: "",
    },
    submitted_at: r.created_at ?? new Date().toISOString(),
    travel_destination: r.destination ?? "",
    // The settlement's stated purpose. r.summary is the AI's risk summary and belongs in the AI panel only.
    travel_purpose: r.purpose ?? "",
    departure_date: r.departure_date ?? "",
    arrival_date: r.arrival_date ?? "",
    is_overseas: false,
    kind: r.kind ?? "CLAIM",
    vendor_id: r.vendor_id ?? "",
    vendor_name: r.vendor_name ?? "",
    vendor_verified: r.vendor_verified ?? false,
    vendor_paypal_masked: r.vendor_paypal_masked ?? "",
    vendor_cooldown_until: r.vendor_cooldown_until ?? "",
    vendor_cooldown_hours: r.vendor_cooldown_hours ?? 72,
    service_start: r.service_start ?? "",
    service_end: r.service_end ?? "",
    line_items: lineItems,
    totals: {
      total_requested: r.total_claimed_amount ?? 0,
      total_deduction: r.total_rejected_amount ?? 0,
      net_approved: r.total_approved_amount ?? 0,
    },
    overall_judgment: (r.judgment ?? "PENDING") as "APPROVED" | "REJECTED" | "PARTIAL_APPROVE" | "PENDING",
    confidence: r.confidence ?? 0,
    summary: r.summary ?? "",
    overall_status: judgmentToAiStatus(r.judgment),
    audit_log: [
      {
        id: "al-auto",
        timestamp: formatDate(r.created_at),
        actor: "Reclaim AI",
        action: `Judgment: ${r.judgment} (confidence ${Math.round((r.confidence ?? 0) * 100)}%)`,
      },
    ],
    autonomy: toClaimAutonomy(r),
    claimant_id: r.user_id,
  };
}

// ─── Actions ─────────────────────────────────────────────────────────────────

export interface HRClaims {
  /** Triage queue rows: claims waiting on HR plus the last 24 hours of auto-pays. */
  rows: TriageRow[];
  /** All loaded claims, and how many reached a final state with no HR reviewer on record. */
  stats: { total: number; autoSolved: number };
  error: string | null;
}

/**
 * The HR dashboard's data. Rows and counts are worked out here, so the page receives
 * the triage rows instead of every raw claim.
 */
export async function getHRClaims(): Promise<HRClaims> {
  return withFixture(summarizeClaims(triageReimbursements), async () => {
    const result = await apiGet<TriageSource[]>(`${API_PREFIX}/reimbursements/`);
    if (result.error) return { ...summarizeClaims([]), error: result.error };
    return summarizeClaims(result.data ?? []);
  });
}

function summarizeClaims(reims: TriageSource[]): HRClaims {
  return { rows: triageRows(reims), stats: hrClaimStats(reims), error: null };
}

export interface HistoryClaim {
  id: string;        // display: RC-XXXXXXXX
  reim_id: string;   // full UUID for navigation
  employeeName: string;
  employeeInitial: string;
  department: string;
  policyName: string;
  amount: number;
  currency: string;
  /** main_category, for the category filter. */
  category: string | null;
  /** ISO time the claim was resolved (reviewed, else last updated), for the date filter. */
  resolvedAt: string | null;
  dateSubmitted: string;
  dateResolved: string;
  status: "Approved" | "Rejected" | "Paid";
  /** Where the money is. null for rejected claims, which never pay out. */
  payout: PayoutState | null;
}

export type PayoutState =
  | { kind: "paid" }
  | { kind: "sending" }
  | { kind: "waiting_link" }
  | { kind: "not_sent" }
  | { kind: "failed"; reason: string | null };

/** Payout state for an approved claim, from the claim status, its latest payout and the payee link. */
function payoutStateOf(r: ReimbursementRaw): PayoutState | null {
  if (r.status === "REJECTED") return null;
  const p = r.payout?.status;
  if (r.status === "PAID" || p === "SUCCEEDED") return { kind: "paid" };
  if (r.status === "DISBURSEMENT_FAILED" || p === "FAILED" || p === "CANCELLED" || p === "REVERSED") {
    return { kind: "failed", reason: r.payout?.failure_code ?? null };
  }
  if (r.status === "DISBURSING" || p === "ACCEPTED" || p === "REQUESTED") return { kind: "sending" };
  if ((r.kind ?? "CLAIM") === "VENDOR_BOOKING") {
    return r.vendor_verified ? { kind: "not_sent" } : { kind: "waiting_link" };
  }
  if (r.payee_linked === false) return { kind: "waiting_link" };
  return { kind: "not_sent" };
}

/**
 * Fetch all resolved reimbursements for the history tab.
 * Includes:
 *   - All HR-reviewed claims (reviewed_by != null), any age
 *   - Auto-processed claims older than 24 h (reviewed_by == null, created_at < cutoff)
 * Excludes REVIEW status (lives in Required Attention) and
 * auto-processed claims within 24 h (lives in dashboard tabs).
 */
export async function getHRHistory(): Promise<HistoryClaim[]> {
  // The list endpoint returns 50 rows unless told otherwise; history needs every resolved claim.
  const result = await apiGet<ReimbursementRaw[]>(`${API_PREFIX}/reimbursements/?limit=5000`);
  if (!result.data) return [];

  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const statusMap = HISTORY_STATUS;

  return result.data
    .filter((r) => {
      if (r.status === "REVIEW" || r.status === "PENDING" || r.status === "APPEALED") return false;
      const isAutoProcessed = r.reviewed_by == null;
      const createdAt = r.created_at ? new Date(r.created_at) : null;
      const isRecent = createdAt != null && createdAt >= cutoff;
      const isResolved = ["APPROVED", "DISBURSING", "PAID", "REJECTED", "DISBURSEMENT_FAILED"].includes(r.status);
      if (isAutoProcessed && isRecent && !isResolved) return false; // exclude only unresolved
      return statusMap[r.status] != null;
    })
    .sort(
      (a, b) =>
        new Date(b.created_at ?? 0).getTime() - new Date(a.created_at ?? 0).getTime(),
    )
    .map((r) => toHistoryClaim(r));
}

const HISTORY_STATUS: Record<string, "Approved" | "Rejected" | "Paid" | null> = {
  APPROVED: "Approved",
  DISBURSING: "Approved",
  PAID: "Paid",
  REJECTED: "Rejected",
  // A failed payout is still an approved claim. The payout column shows the failure.
  DISBURSEMENT_FAILED: "Approved",
};

/** One history row. `amount` replaces the claimed amount: a report row shows what it adds to the number. */
function toHistoryClaim(r: ReimbursementRaw, amount?: number): HistoryClaim {
  const name = r.employee_name ?? "Unknown";
  const resolvedDate = r.reviewed_at ?? r.updated_at ?? r.created_at;
  return {
    id: formatClaimRef(r.reim_id),
    reim_id: r.reim_id,
    employeeName: name,
    employeeInitial: name.charAt(0).toUpperCase(),
    department: r.department_name ?? "—",
    policyName: (r.kind ?? "CLAIM") === "VENDOR_BOOKING"
      ? `Vendor booking · ${r.vendor_name ?? "Unknown vendor"}`
      : (r.policy_name ?? r.main_category ?? "General"),
    amount: amount ?? r.total_claimed_amount ?? 0,
    currency: r.currency ?? "MYR",
    category: r.main_category ?? null,
    resolvedAt: resolvedDate ?? null,
    dateSubmitted: formatShortDate(r.created_at),
    dateResolved: formatShortDate(resolvedDate ?? null),
    status: HISTORY_STATUS[r.status] ?? "Approved",
    payout: payoutStateOf(r),
  };
}

export interface ReportClaimsQuery {
  month: string;
  metric: string;
  category?: string;
  team?: string;
  code?: string;
}

export interface ReportClaims {
  count: number;
  total: number;
  currency: string;
  claims: HistoryClaim[];
}

/** The claims behind one number on the month-end report (F12), from the same query as the number. */
export async function getReportClaims(q: ReportClaimsQuery): Promise<ReportClaims | null> {
  const params = new URLSearchParams({ metric: q.metric });
  for (const key of ["category", "team", "code"] as const) {
    const value = q[key];
    if (value != null) params.set(key, value);
  }
  const result = await apiGet<{ count: number; total: number; currency: string; claims: (ReimbursementRaw & { report_amount: number })[] }>(
    `${API_PREFIX}/reports/monthly/${encodeURIComponent(q.month)}/claims?${params}`,
  );
  if (!result.data) return null;
  const { count, total, currency, claims } = result.data;
  return { count, total, currency, claims: claims.map((r) => toHistoryClaim(r, r.report_amount)) };
}

/**
 * Fetch a single reimbursement by reim_id and map to ClaimBundle for detail view.
 * Returns null when the claim doesn't exist (404, or an ID that isn't a UUID: 400/422).
 * Throws on any other failure, so the page can offer a retry instead of "not found".
 */
export async function getHRClaimBundle(reimId: string): Promise<ClaimBundle | null> {
  const fixture = triageReimbursements.find((r) => r.reim_id === reimId);
  return withFixture(fixture ? mapToBundle(fixture) : null, async () => {
    const result = await apiGet<TriageSource>(`${API_PREFIX}/reimbursements/${reimId}`);
    if (result.data) return mapToBundle(result.data);
    if (result.status === 404 || result.status === 400 || result.status === 422) return null;
    throw new Error(result.error ?? "Couldn't load the claim");
  });
}

/** HR updates the status of a reimbursement (approve / reject). */
export async function updateReimbursementStatus(
  reimId: string,
  status: "APPROVED" | "REJECTED" | "REVIEW",
  reviewedBy: string,
  options?: {
    lineItems?: Array<{ line_item_id: string; approved_amount: number }>;
    hrNote?: string;
  },
): Promise<{ ok: boolean; data?: ReimbursementRaw; error?: string }> {
  const body: Record<string, unknown> = { status, reviewed_by: reviewedBy };
  if (options?.lineItems?.length) {
    body.line_items = options.lineItems;
  }
  if (options?.hrNote) {
    body.hr_note = options.hrNote;
  }
  const result = await apiPatch<ReimbursementRaw>(`${API_PREFIX}/reimbursements/${reimId}/status`, body);
  if (result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: true, data: result.data ?? undefined };
}

/** Upload a policy PDF to the backend. */
export async function uploadPolicy(formData: FormData): Promise<{ ok: boolean; error?: string }> {
  const result = await apiPostMultipart<void>(`${API_PREFIX}/policies/upload`, formData);
  if (result.error) {
    return { ok: false, error: result.error };
  }
  return { ok: true };
}

export async function triggerPayout(reimId: string): Promise<{ payout: PayoutInfo | null; error: string | null }> {
  const result = await apiPost<PayoutInfo>(`${API_PREFIX}/payouts/`, { reim_id: reimId });
  if (result.error) return { payout: null, error: result.error };
  return { payout: result.data, error: null };
}
