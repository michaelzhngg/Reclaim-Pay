// Copy and formatting for the HR Reconciliation tab. Pure, so it is tested without React.
import type {
  DifferenceKind,
  ReconciliationDifference,
  ReconciliationRun,
  ReconciliationState,
} from "@/lib/actions/reconcile";

export type ReconciliationTone = "success" | "warning" | "danger" | "neutral";

/** The tab warns when the schedule has not produced a successful check for this long. */
export const STALE_AFTER_HOURS = 36;

export const RECONCILIATION_TONE_CLASSES: Record<ReconciliationTone, string> = {
  success: "border-success/30 bg-success-soft text-success",
  warning: "border-warning/30 bg-warning-soft text-warning",
  danger: "border-danger/30 bg-danger-soft text-danger",
  neutral: "border-line bg-surface-muted text-ink-muted",
};

const STATE_LABEL: Record<ReconciliationState, string> = {
  ok: "Compared",
  no_data: "Nothing to compare",
  unavailable: "PayPal unavailable",
  failed: "Check failed",
};

export function periodLabel(days: number): string {
  return days === 1 ? "last 24 hours" : `last ${days} days`;
}

export function stateLabel(state: ReconciliationState): string {
  return STATE_LABEL[state];
}

export function isStale(lastSuccessAt: string | null, now: number = Date.now()): boolean {
  if (!lastSuccessAt) return false;
  const timestamp = Date.parse(lastSuccessAt);
  if (!Number.isFinite(timestamp)) return false;
  return now - timestamp > STALE_AFTER_HOURS * 3_600_000;
}

export function runTone(
  run: ReconciliationRun | null,
  openDifferences: ReconciliationDifference[],
): ReconciliationTone {
  if (!run) return "neutral";
  if (run.state === "failed" || run.state === "unavailable") return "warning";
  if (run.state === "no_data") return "neutral";
  if (openDifferences.some((d) => d.kind === "MISSING_IN_PAYPAL")) return "danger";
  if (openDifferences.length > 0) return "warning";
  return run.pending > 0 ? "warning" : "success";
}

export function runHeadline(run: ReconciliationRun | null): string {
  if (!run) return "No reconciliation yet";
  switch (run.state) {
    case "ok":
      return `Reconciled ${run.reconciled} of ${run.total}, ${periodLabel(run.days)}`;
    case "no_data":
      return run.message ?? "Nothing to compare in this period.";
    case "unavailable":
      return run.message ?? "PayPal can't be reached right now.";
    case "failed":
      return "The last check failed before it could compare.";
  }
}

export function pendingLine(run: ReconciliationRun | null): string | null {
  if (!run || run.state !== "ok" || run.pending <= 0) return null;
  return run.pending === 1
    ? "1 payout is waiting on PayPal, which can take up to 3 hours to list a transaction."
    : `${run.pending} payouts are waiting on PayPal, which can take up to 3 hours to list a transaction.`;
}

export function differencesLine(openDifferences: ReconciliationDifference[]): string {
  if (openDifferences.length === 0) return "No differences need review.";
  return openDifferences.length === 1
    ? "1 difference needs review."
    : `${openDifferences.length} differences need review.`;
}

export function differenceReason(kind: DifferenceKind): string {
  return kind === "MISSING_IN_PAYPAL"
    ? "not found in PayPal"
    : "in PayPal with no matching claim";
}
