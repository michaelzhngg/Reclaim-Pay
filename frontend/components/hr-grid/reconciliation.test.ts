import { describe, expect, it } from "vitest";
import type { ReconciliationDifference, ReconciliationRun } from "@/lib/actions/reconcile";
import {
  STALE_AFTER_HOURS,
  differencesLine,
  differenceReason,
  isStale,
  pendingLine,
  periodLabel,
  runHeadline,
  runTone,
  stateLabel,
} from "./reconciliation";

const NOW = Date.parse("2026-11-12T12:00:00Z");
const HOUR = 3_600_000;

function run(overrides: Partial<ReconciliationRun> = {}): ReconciliationRun {
  return {
    run_id: "r1",
    trigger: "schedule",
    started_at: "2026-11-12T10:00:00Z",
    finished_at: "2026-11-12T10:00:05Z",
    days: 3,
    window_start: "2026-11-09T10:00:00Z",
    window_end: "2026-11-12T10:00:00Z",
    state: "ok",
    reconciled: 4,
    total: 5,
    pending: 1,
    differences_new: 0,
    differences_open: 0,
    data_through: "2026-11-12T09:00:00Z",
    mock: false,
    message: null,
    error: null,
    triggered_by: null,
    ...overrides,
  };
}

function difference(overrides: Partial<ReconciliationDifference> = {}): ReconciliationDifference {
  return {
    difference_id: "d1",
    kind: "MISSING_IN_PAYPAL",
    payout_id: "p1",
    reim_id: "c1",
    transaction_id: null,
    amount: 48,
    currency: "MYR",
    employee_name: "Aisyah",
    occurred_at: "2026-11-12T06:00:00Z",
    first_seen_at: "2026-11-12T10:00:00Z",
    last_seen_at: "2026-11-12T10:00:00Z",
    resolved_at: null,
    resolution: null,
    ...overrides,
  };
}

describe("periodLabel", () => {
  it("names the 24-hour window and longer ones", () => {
    expect(periodLabel(1)).toBe("last 24 hours");
    expect(periodLabel(3)).toBe("last 3 days");
  });
});

describe("isStale", () => {
  it("warns only past the threshold", () => {
    expect(isStale(null, NOW)).toBe(false);
    expect(isStale("not a date", NOW)).toBe(false);
    expect(isStale(new Date(NOW - 35 * HOUR).toISOString(), NOW)).toBe(false);
    expect(isStale(new Date(NOW - (STALE_AFTER_HOURS + 1) * HOUR).toISOString(), NOW)).toBe(true);
  });
});

describe("runTone", () => {
  it("separates ledger differences from an outage or a wait", () => {
    expect(runTone(null, [])).toBe("neutral");
    expect(runTone(run({ state: "unavailable" }), [])).toBe("warning");
    expect(runTone(run({ state: "failed" }), [])).toBe("warning");
    expect(runTone(run({ state: "no_data" }), [])).toBe("neutral");
    expect(runTone(run(), [])).toBe("warning");
    expect(runTone(run({ pending: 0 }), [])).toBe("success");
    expect(runTone(run({ pending: 0 }), [difference()])).toBe("danger");
    expect(runTone(run({ pending: 0 }), [difference({ kind: "UNKNOWN_IN_PAYPAL" })])).toBe("warning");
  });
});

describe("copy", () => {
  it("summarises the latest run", () => {
    expect(runHeadline(null)).toBe("No reconciliation yet");
    expect(runHeadline(run())).toBe("Reconciled 4 of 5, last 3 days");
    expect(runHeadline(run({ state: "unavailable", message: "PayPal is down." }))).toBe("PayPal is down.");
    expect(runHeadline(run({ state: "failed" }))).toContain("failed");
  });

  it("counts what is waiting and what needs review", () => {
    expect(pendingLine(run())).toContain("1 payout is waiting");
    expect(pendingLine(run({ pending: 2 }))).toContain("2 payouts are waiting");
    expect(pendingLine(run({ pending: 0 }))).toBeNull();
    expect(pendingLine(run({ state: "no_data" }))).toBeNull();
    expect(differencesLine([])).toBe("No differences need review.");
    expect(differencesLine([difference()])).toBe("1 difference needs review.");
    expect(differencesLine([difference(), difference({ difference_id: "d2" })])).toBe("2 differences need review.");
  });

  it("labels a difference and a run state", () => {
    expect(differenceReason("MISSING_IN_PAYPAL")).toBe("not found in PayPal");
    expect(differenceReason("UNKNOWN_IN_PAYPAL")).toBe("in PayPal with no matching claim");
    expect(stateLabel("ok")).toBe("Compared");
    expect(stateLabel("unavailable")).toBe("PayPal unavailable");
  });
});
