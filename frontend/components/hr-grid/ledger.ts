// ─── Payout Ledger Logic ─────────────────────────────────────────────────────
// Pure helpers for the HR payouts ledger: status labels, tier labels, filtering,
// sorting and the "still in flight" check that drives polling.
// ──────────────────────────────────────────────────────────────────────────────

import type { AutonomyTier, PayoutLedgerRow, PayoutStatus } from "@/lib/api/reclaim-pay-types";
import { TIER_LABEL } from "./rows";

export type StatusTone = "success" | "progress" | "danger" | "neutral";

export const STATUS_META: Record<PayoutStatus, { label: string; tone: StatusTone }> = {
  ACCEPTED: { label: "Accepted", tone: "progress" },
  REQUESTED: { label: "Processing", tone: "progress" },
  SUCCEEDED: { label: "Paid", tone: "success" },
  FAILED: { label: "Failed", tone: "danger" },
  CANCELLED: { label: "Cancelled", tone: "neutral" },
  REVERSED: { label: "Reversed", tone: "danger" },
};

export const TONE_CLASSES: Record<StatusTone, string> = {
  success: "bg-success-soft text-success border-success/30",
  progress: "bg-warning-soft text-warning border-warning/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  neutral: "bg-surface-muted text-ink-muted border-line",
};

/** The backend leaves `tier` empty until the autonomy engine records one. */
export function tierLabel(tier: AutonomyTier | null): string {
  return tier ? TIER_LABEL[tier] : "Not recorded";
}

/** The Route column only appears once at least one payout carries a tier. */
export function hasAnyTier(rows: PayoutLedgerRow[]): boolean {
  return rows.some((r) => r.tier != null);
}

export const IN_FLIGHT_STATUSES: readonly PayoutStatus[] = ["ACCEPTED", "REQUESTED"];

export function hasInFlight(rows: PayoutLedgerRow[]): boolean {
  return rows.some((r) => IN_FLIGHT_STATUSES.includes(r.status));
}

export type StatusFilter = PayoutStatus | "ALL";

export function filterByStatus(rows: PayoutLedgerRow[], status: StatusFilter): PayoutLedgerRow[] {
  return status === "ALL" ? rows : rows.filter((r) => r.status === status);
}

export function sortByUpdatedDesc(rows: PayoutLedgerRow[]): PayoutLedgerRow[] {
  return [...rows].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

export function formatUpdated(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-MY", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

/** Counts shown in the page summary line, computed from the rows themselves. */
export function summarize(rows: PayoutLedgerRow[]): { total: number; inFlight: number; failed: number } {
  return {
    total: rows.length,
    inFlight: rows.filter((r) => IN_FLIGHT_STATUSES.includes(r.status)).length,
    failed: rows.filter((r) => r.status === "FAILED" || r.status === "REVERSED").length,
  };
}
