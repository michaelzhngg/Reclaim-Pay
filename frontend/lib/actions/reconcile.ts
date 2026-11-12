"use server";

import { apiGet, apiPost, API_PREFIX } from "@/lib/api/client";
import { withFixture } from "@/lib/api/fixtures";

export interface ReconcileMismatch {
  payout_id: string;
  reim_id: string;
  claim_ref: string;
  employee_name: string;
  amount: number;
  currency: string;
  created_at: string;
  reason: "MISSING_IN_PAYPAL";
}

export interface ReconcileUnknown {
  transaction_id: string;
  amount: number;
  currency: string;
  occurred_at: string;
}

export interface ReconcileSummary {
  /** "ok" is a real comparison. Otherwise nothing was compared and `message` says why. */
  state: "ok" | "no_data" | "unavailable";
  reconciled: number;
  total: number;
  pending: number;
  mismatches: ReconcileMismatch[];
  unknown_in_paypal: ReconcileUnknown[];
  days: number;
  checked_at: string;
  data_through: string | null;
  mock: boolean;
  message: string | null;
}

export type ReconciliationState = "ok" | "no_data" | "unavailable" | "failed";
export type DifferenceKind = "MISSING_IN_PAYPAL" | "UNKNOWN_IN_PAYPAL";

/** GET /payouts/reconcile/history, one stored comparison. */
export interface ReconciliationRun {
  run_id: string;
  trigger: string;
  started_at: string;
  finished_at: string | null;
  days: number;
  window_start: string;
  window_end: string;
  state: ReconciliationState;
  reconciled: number;
  total: number;
  pending: number;
  differences_new: number;
  differences_open: number;
  data_through: string | null;
  mock: boolean;
  message: string | null;
  error: string | null;
  triggered_by: string | null;
}

/** GET /payouts/reconcile/history, an open difference. */
export interface ReconciliationDifference {
  difference_id: string;
  kind: DifferenceKind;
  payout_id: string | null;
  reim_id: string | null;
  transaction_id: string | null;
  amount: number;
  currency: string;
  employee_name: string | null;
  occurred_at: string;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
  resolution: string | null;
}

export interface ReconciliationHistory {
  latest: ReconciliationRun | null;
  last_success_at: string | null;
  runs: ReconciliationRun[];
  open_differences: ReconciliationDifference[];
}

const HOUR_MS = 3_600_000;
const hoursAgo = (hours: number): string => new Date(Date.now() - hours * HOUR_MS).toISOString();

function runFixture(overrides: Partial<ReconciliationRun> = {}): ReconciliationRun {
  const started = hoursAgo(2);
  return {
    run_id: "00000000-0000-4000-8000-000000000101",
    trigger: "schedule",
    started_at: started,
    finished_at: started,
    days: 3,
    window_start: hoursAgo(74),
    window_end: started,
    state: "ok",
    reconciled: 4,
    total: 5,
    pending: 1,
    differences_new: 1,
    differences_open: 1,
    data_through: hoursAgo(3),
    mock: true,
    message: null,
    error: null,
    triggered_by: null,
    ...overrides,
  };
}

function differenceFixture(overrides: Partial<ReconciliationDifference> = {}): ReconciliationDifference {
  return {
    difference_id: "00000000-0000-4000-8000-000000000201",
    kind: "MISSING_IN_PAYPAL",
    payout_id: "00000000-0000-4000-8000-000000000301",
    reim_id: "1a2b3c4d-0000-4000-8000-000000000001",
    transaction_id: null,
    amount: 48,
    currency: "MYR",
    employee_name: "Demo Employee",
    occurred_at: hoursAgo(6),
    first_seen_at: hoursAgo(2),
    last_seen_at: hoursAgo(2),
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

function historyFixture(): ReconciliationHistory {
  const latest = runFixture();
  return {
    latest,
    last_success_at: latest.started_at,
    runs: [
      latest,
      runFixture({
        run_id: "00000000-0000-4000-8000-000000000102",
        started_at: hoursAgo(26),
        finished_at: hoursAgo(26),
        window_start: hoursAgo(98),
        window_end: hoursAgo(26),
        reconciled: 3,
        total: 4,
        pending: 0,
        differences_new: 0,
        differences_open: 1,
        data_through: hoursAgo(27),
      }),
      runFixture({
        run_id: "00000000-0000-4000-8000-000000000103",
        started_at: hoursAgo(50),
        finished_at: hoursAgo(50),
        window_start: hoursAgo(122),
        window_end: hoursAgo(50),
        state: "unavailable",
        reconciled: 0,
        total: 2,
        pending: 0,
        differences_new: 0,
        differences_open: 0,
        data_through: null,
        message: "PayPal can't be reached right now, so these payouts were not compared.",
      }),
    ],
    open_differences: [differenceFixture()],
  };
}

const summaryFixture = (days: number): ReconcileSummary => ({
  state: "ok",
  reconciled: 2,
  total: 4,
  pending: 1,
  mismatches: [
    {
      payout_id: "00000000-0000-4000-8000-000000000001",
      reim_id: "1a2b3c4d-0000-4000-8000-000000000001",
      claim_ref: "RC-1A2B3C4D",
      employee_name: "Demo Employee",
      amount: 48,
      currency: "MYR",
      created_at: "2026-11-03T10:00:05Z",
      reason: "MISSING_IN_PAYPAL",
    },
  ],
  unknown_in_paypal: [],
  days,
  checked_at: "2026-11-04T10:00:00Z",
  data_through: "2026-11-04T09:00:00Z",
  mock: true,
  message: null,
});

/** HR ledger reconciliation. A failed request reads as "unavailable", never as a mismatch. */
export async function getReconciliation(days = 7): Promise<ReconcileSummary> {
  return withFixture(summaryFixture(days), async () => {
    const result = await apiGet<ReconcileSummary>(`${API_PREFIX}/payouts/reconcile?days=${days}`);
    if (result.data && !result.error) return result.data;
    return {
      state: "unavailable",
      reconciled: 0,
      total: 0,
      pending: 0,
      mismatches: [],
      unknown_in_paypal: [],
      days,
      checked_at: new Date().toISOString(),
      data_through: null,
      mock: false,
      message: "Couldn't check payouts against PayPal.",
    };
  });
}

/** The stored daily checks, newest first. Throws so the tab can show an error without clearing rows. */
export async function getReconciliationHistory(runs = 14): Promise<ReconciliationHistory> {
  return withFixture(historyFixture(), async () => {
    const result = await apiGet<ReconciliationHistory>(
      `${API_PREFIX}/payouts/reconcile/history?runs=${runs}`,
    );
    if (result.data && !result.error) return result.data;
    throw new Error(result.error ?? "No response");
  });
}

/** Run a check now and store it. Throws so the tab can keep the previous history on failure. */
export async function runReconciliation(): Promise<ReconciliationRun> {
  return withFixture(runFixture({ trigger: "manual" }), async () => {
    const result = await apiPost<ReconciliationRun>(`${API_PREFIX}/payouts/reconcile/run`);
    if (result.data && !result.error) return result.data;
    throw new Error(result.error ?? "No response");
  });
}

/** Close a reviewed difference. Throws so the row stays visible when the request fails. */
export async function dismissDifference(differenceId: string): Promise<ReconciliationDifference> {
  return withFixture(
    differenceFixture({
      difference_id: differenceId,
      resolved_at: new Date().toISOString(),
      resolution: "DISMISSED",
    }),
    async () => {
      const result = await apiPost<ReconciliationDifference>(
        `${API_PREFIX}/payouts/reconcile/differences/${encodeURIComponent(differenceId)}/dismiss`,
      );
      if (result.data && !result.error) return result.data;
      throw new Error(result.error ?? "No response");
    },
  );
}
