// ─── Triage Queue Logic ──────────────────────────────────────────────────────
// Pure helpers for the HR triage grid: mapping raw reimbursements to rows,
// tier tabs and counts, batch-approval eligibility and result wording.
// Labels follow docs/hackathon/DETAIL-PLAN.md §13.1, §13.5 and §13.7.
// ──────────────────────────────────────────────────────────────────────────────

import type { ReimbursementRaw } from "@/lib/api/types";
import {
  formatMoney,
  type AutonomyTier,
  type BatchApproveResult,
  type BatchSkipReason,
  type HardStop,
  type ReimbursementAutonomyFields,
  type Severity,
  type SignalCode,
} from "@/lib/api/reclaim-pay-types";
import { formatClaimRef } from "@/lib/format";

export type TriageSource = ReimbursementRaw & ReimbursementAutonomyFields;

export interface TriageSignal {
  code: SignalCode;
  severity: Severity;
}

export interface TriageRow {
  reimId: string;
  ref: string;
  userId: string;
  employee: string;
  category: string;
  amount: number;
  currency: string;
  aiVerdict: ReimbursementRaw["judgment"];
  confidence: number | null;
  tier: AutonomyTier;
  riskScore: number;
  /** Highest severity first. */
  signals: TriageSignal[];
  hardStops: HardStop[];
  status: ReimbursementRaw["status"];
  submittedAt: string | null;
  approvals: number;
  auditSelected: boolean;
  kind: "CLAIM" | "VENDOR_BOOKING";
  vendorName: string | null;
}

/** HR labels from the copy deck (§13.1). */
export const TIER_LABEL: Record<AutonomyTier, string> = {
  AUTO_PAY: "Auto-pay",
  HR_QUICK: "Quick HR approval",
  HR_REVIEW: "HR review",
  DUAL_REVIEW: "Two-person review",
};

export const SIGNAL_LABEL: Record<SignalCode, string> = {
  PROMPT_INJECTION: "Hidden instructions",
  DUPLICATE_RECEIPT: "Possible duplicate",
  AI_PROVENANCE: "AI-generated image",
  HUMAN_EDIT_HIGH: "Large manual edit",
  ARITHMETIC_MISMATCH: "Totals don't add up",
  EDITING_SOFTWARE: "Edited image",
  SPLIT_CLAIM: "Possible split claim",
  VISUAL_ANOMALY: "Visual anomaly",
  HUMAN_EDIT_MEDIUM: "Manual edit",
  PRICE_ABOVE_MARKET: "Above market price",
  NEAR_THRESHOLD: "Just under the limit",
  NO_CAMERA_METADATA: "No camera data",
  IMAGE_FORENSICS: "Image check: possible edited region",
};

export const SKIP_REASON_LABEL: Record<BatchSkipReason, string> = {
  NOT_HR_QUICK: "not a quick-approval claim",
  NOT_IN_REVIEW: "already decided",
  SELF_APPROVAL: "your own claim",
  NOTHING_TO_PAY: "no approved amount",
  VENDOR_BOOKING: "vendor bookings need individual review",
};

const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export function toTriageRow(r: TriageSource): TriageRow {
  const decision = r.autonomy ?? {};
  const signals = [...(decision.signals ?? [])]
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || (b.points ?? 0) - (a.points ?? 0))
    .map(({ code, severity }) => ({ code, severity }));

  return {
    reimId: r.reim_id,
    ref: formatClaimRef(r.reim_id),
    userId: r.user_id,
    employee: r.employee_name ?? "Unknown employee",
    category: r.main_category ?? "General",
    amount: r.total_claimed_amount ?? 0,
    currency: r.currency ?? "MYR",
    aiVerdict: r.judgment,
    confidence: r.confidence ?? null,
    // Claims decided before the autonomy engine existed have no tier; a person looks at them.
    tier: r.tier ?? decision.tier ?? "HR_REVIEW",
    riskScore: r.risk_score ?? decision.risk_score ?? 0,
    signals,
    hardStops: decision.hard_stops ?? [],
    status: r.status,
    submittedAt: r.created_at,
    approvals: r.approvals?.length ?? 0,
    auditSelected: r.audit_selected ?? decision.audit_selected ?? false,
    kind: r.kind ?? "CLAIM",
    vendorName: r.vendor_name ?? null,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The queue shows what needs HR (status REVIEW) plus what the agent paid in the
 * last 24 hours, so HR can see both sides of the line. Newest first.
 */
export function triageRows(raws: TriageSource[], now = Date.now()): TriageRow[] {
  return raws
    .map(toTriageRow)
    .filter((row) => {
      if (row.status === "REVIEW") return true;
      const submitted = row.submittedAt ? Date.parse(row.submittedAt) : NaN;
      return row.tier === "AUTO_PAY" && now - submitted <= DAY_MS;
    })
    .sort((a, b) => Date.parse(b.submittedAt ?? "0") - Date.parse(a.submittedAt ?? "0"));
}

export type TierTab = "all" | AutonomyTier;

/** Tab order from the UX QA report: the queue reads from least to most human effort. */
export const TIER_TABS: { id: TierTab; label: string }[] = [
  { id: "all", label: "All" },
  { id: "AUTO_PAY", label: "Auto-paid" },
  { id: "HR_QUICK", label: "Quick approve" },
  { id: "HR_REVIEW", label: "Review" },
  { id: "DUAL_REVIEW", label: "Two-person" },
];

export function tierTabs(rows: TriageRow[]): Record<TierTab, number> {
  const counts: Record<TierTab, number> = { all: rows.length, AUTO_PAY: 0, HR_QUICK: 0, HR_REVIEW: 0, DUAL_REVIEW: 0 };
  for (const row of rows) counts[row.tier] += 1;
  return counts;
}

export function rowsForTab(rows: TriageRow[], tab: TierTab): TriageRow[] {
  return tab === "all" ? rows : rows.filter((r) => r.tier === tab);
}

/** Why a row can't go into a batch approval, or null when it can. Mirrors the backend's skip reasons. */
export function exclusionReason(row: TriageRow, selfId: string | null | undefined): BatchSkipReason | null {
  if (row.tier !== "HR_QUICK") return "NOT_HR_QUICK";
  if (row.status !== "REVIEW") return "NOT_IN_REVIEW";
  if (selfId && row.userId === selfId) return "SELF_APPROVAL";
  if (row.kind === "VENDOR_BOOKING") return "VENDOR_BOOKING";
  return null;
}

export function isBatchSelectable(row: TriageRow, selfId: string | null | undefined): boolean {
  return exclusionReason(row, selfId) === null;
}

/** "MYR 402.00", or "MYR 90.00 + USD 12.00" when currencies are mixed. */
export function formatTotal(rows: Pick<TriageRow, "amount" | "currency">[]): string {
  const byCurrency = new Map<string, number>();
  for (const r of rows) byCurrency.set(r.currency, (byCurrency.get(r.currency) ?? 0) + r.amount);
  if (byCurrency.size === 0) return formatMoney("MYR", 0);
  return [...byCurrency].map(([currency, amount]) => formatMoney(currency, amount)).join(" + ");
}

export function approveButtonLabel(selected: TriageRow[]): string {
  const n = selected.length;
  if (n === 0) return "Select claims to approve";
  return `Approve ${n} ${n === 1 ? "claim" : "claims"} · ${formatTotal(selected)}`;
}

function reasonList(reasons: BatchSkipReason[]): string {
  return [...new Set(reasons)].map((r) => SKIP_REASON_LABEL[r]).join(", ");
}

/** "1 excluded: your own claim", or null when nothing in the tab is held back. */
export function exclusionSummary(rows: TriageRow[], selfId: string | null | undefined): string | null {
  const reasons = rows.map((r) => exclusionReason(r, selfId)).filter((r): r is BatchSkipReason => r !== null);
  if (reasons.length === 0) return null;
  return `${reasons.length} excluded: ${reasonList(reasons)}`;
}

/** Toast text from §13.7: "Approved {n}. Skipped {m}: {reason list}". */
export function batchResultMessage(result: BatchApproveResult): string {
  const approved = `Approved ${result.approved.length}.`;
  if (result.skipped.length === 0) return approved;
  return `${approved} Skipped ${result.skipped.length}: ${reasonList(result.skipped.map((s) => s.reason))}.`;
}

export type RiskBand = "low" | "quick" | "review" | "dual";

/** Bands match the default score cut-offs (20 / 50 / 80) in DETAIL-PLAN §7.1. */
export function riskBand(score: number): RiskBand {
  if (score >= 80) return "dual";
  if (score >= 50) return "review";
  if (score >= 20) return "quick";
  return "low";
}

const VERDICT_LABEL: Record<ReimbursementRaw["judgment"], string> = {
  APPROVED: "Approve",
  PARTIAL: "Partial",
  REJECTED: "Reject",
  NEEDS_INFO: "Needs info",
};

export function verdictLabel(verdict: ReimbursementRaw["judgment"]): string {
  return VERDICT_LABEL[verdict] ?? verdict;
}

export const STATUS_LABEL: Record<ReimbursementRaw["status"], string> = {
  PENDING: "Analysing",
  REVIEW: "Needs review",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  APPEALED: "Appealed",
  DISBURSING: "Paying",
  PAID: "Paid",
  DISBURSEMENT_FAILED: "Payout failed",
};

export function statusLabel(row: Pick<TriageRow, "status" | "tier" | "approvals">): string {
  if (row.status === "REVIEW" && row.tier === "DUAL_REVIEW" && row.approvals === 1) return "1 of 2 approvals";
  return STATUS_LABEL[row.status] ?? row.status;
}

/** Same-day claims show the time; older ones show the date. */
export function formatSubmitted(iso: string | null, now = new Date(), timeZone?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  const sameDay =
    new Intl.DateTimeFormat("en-CA", { timeZone }).format(d) === new Intl.DateTimeFormat("en-CA", { timeZone }).format(now);
  return new Intl.DateTimeFormat("en-MY", {
    ...(sameDay ? { hour: "2-digit", minute: "2-digit", hour12: false } : { day: "numeric", month: "short" }),
    timeZone,
  }).format(d);
}

/** Review page for claims waiting on HR, read-only view for everything else. */
export function claimHref(row: Pick<TriageRow, "reimId" | "status">): string {
  return row.status === "REVIEW" ? `/hr/review/${row.reimId}` : `/hr/view/${row.reimId}`;
}
