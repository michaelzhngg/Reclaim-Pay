import { describe, it, expect } from "vitest";
import {
  autonomySchema,
  breakerActive,
  breakerLine,
  budgetPercent,
  demoNotice,
  diffConfig,
  latestReason,
  toChartData,
} from "./autonomy";
import { DEFAULT_CONFIG, fixtureBacktest } from "@/src/mocks/autonomyFixtures";
import type { AgentAction } from "@/lib/api/reclaim-pay-types";

describe("autonomySchema", () => {
  it("accepts the spec defaults", () => expect(autonomySchema.safeParse(DEFAULT_CONFIG).success).toBe(true));

  it("rejects limits out of order", () => {
    const r = autonomySchema.safeParse({ ...DEFAULT_CONFIG, auto_limit_new: 150 });
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.path[0])).toEqual(["auto_limit_new", "auto_limit_standard"]);
  });

  it("rejects overlapping score bands", () =>
    expect(autonomySchema.safeParse({ ...DEFAULT_CONFIG, review_min_score: 15 }).success).toBe(false));

  it("rejects equal score bands", () =>
    expect(autonomySchema.safeParse({ ...DEFAULT_CONFIG, dual_min_score: 50 }).success).toBe(false));

  it("rejects rates outside 0..1", () =>
    expect(autonomySchema.safeParse({ ...DEFAULT_CONFIG, audit_sample_rate: 1.5 }).success).toBe(false));

  it("rejects an empty number field", () =>
    expect(autonomySchema.safeParse({ ...DEFAULT_CONFIG, auto_limit_trusted: Number.NaN }).success).toBe(false));
});

describe("diffConfig", () => {
  it("returns nothing when nothing changed", () => {
    expect(diffConfig(DEFAULT_CONFIG, { ...DEFAULT_CONFIG })).toEqual([]);
  });

  it("lists each changed field with formatted before and after", () => {
    const changes = diffConfig(DEFAULT_CONFIG, {
      ...DEFAULT_CONFIG,
      auto_limit_standard: 200,
      review_min_score: 60,
      audit_sample_rate: 0.1,
    });
    expect(changes).toEqual([
      { key: "auto_limit_standard", label: "Standard employee limit", before: "MYR 100", after: "MYR 200" },
      { key: "review_min_score", label: "HR review from score", before: "50", after: "60" },
      { key: "audit_sample_rate", label: "Audit sample rate", before: "5%", after: "10%" },
    ]);
  });

  it("ignores server-owned fields", () => {
    expect(diffConfig(DEFAULT_CONFIG, { ...DEFAULT_CONFIG, version: 9, enabled: false })).toEqual([]);
  });
});

describe("toChartData", () => {
  const result = {
    automation_rate: 0.608,
    projected_leakage: 84,
    curve: [
      { auto_limit_standard: 200, automation_rate: 0.7, projected_leakage: 120.456 },
      { auto_limit_standard: 25, automation_rate: 0.18, projected_leakage: 6 },
      { auto_limit_standard: 100, automation_rate: 0.6, projected_leakage: 80 },
    ],
  };

  it("sorts by limit and converts rates to percent", () => {
    const { points } = toChartData(result, 120);
    expect(points.map((p) => p.limit)).toEqual([25, 100, 200]);
    expect(points[0]).toEqual({ limit: 25, automationPct: 18, leakage: 6 });
    expect(points[2].leakage).toBe(120.46);
  });

  it("places the current marker from the headline figures, not the curve", () => {
    expect(toChartData(result, 120).current).toEqual({ limit: 120, automationPct: 60.8, leakage: 84 });
  });

  it("handles an empty curve", () => {
    expect(toChartData({ ...result, curve: [] }, 100).points).toEqual([]);
  });
});

describe("fixture back-test", () => {
  it("returns 8 curve points and moves with the standard limit", () => {
    const low = fixtureBacktest({ ...DEFAULT_CONFIG, auto_limit_standard: 100 });
    const high = fixtureBacktest({ ...DEFAULT_CONFIG, auto_limit_standard: 200 });
    expect(low.curve).toHaveLength(8);
    expect(high.automation_rate).toBeGreaterThanOrEqual(low.automation_rate);
    expect(high.projected_leakage).toBeGreaterThanOrEqual(low.projected_leakage);
  });
});

describe("status wording", () => {
  const act = (id: number, type: string, reason?: string): AgentAction => ({
    action_id: id,
    action_type: type,
    actor: "hr",
    reim_id: null,
    payload: reason ? { reason } : {},
    hash: "x",
    created_at: "2026-11-04T00:00:00Z",
  });

  it("finds the newest reason of a type", () => {
    const actions = [act(3, "KILL_SWITCH", "Month-end close"), act(5, "CONFIG_CHANGED", "x"), act(1, "KILL_SWITCH", "old")];
    expect(latestReason(actions, "KILL_SWITCH")).toBe("Month-end close");
    expect(latestReason(actions, "BREAKER_TRIPPED")).toBeNull();
  });

  it("clamps the budget meter", () => {
    expect(budgetPercent(148, 2000)).toBeCloseTo(7.4);
    expect(budgetPercent(3000, 2000)).toBe(100);
    expect(budgetPercent(10, 0)).toBe(0);
  });

  it("writes the breaker line with the time and reason", () => {
    expect(breakerLine("2026-11-04T06:20:00Z", "6 of the last 20 decisions had a HIGH signal.", "UTC")).toBe(
      "Auto-pay paused until 06:20: 6 of the last 20 decisions had a HIGH signal.",
    );
  });

  it("treats a past breaker time as inactive", () => {
    const now = Date.parse("2026-11-04T06:00:00Z");
    expect(breakerActive("2026-11-04T06:20:00Z", now)).toBe(true);
    expect(breakerActive("2026-11-04T05:20:00Z", now)).toBe(false);
    expect(breakerActive(null, now)).toBe(false);
  });
});

describe("demoNotice", () => {
  it("warns when every replayed claim is a demo claim", () =>
    expect(demoNotice({ demo_claims: 120, total_claims: 120 })).toBe(
      "These numbers come from demo claims. Don't change limits based on them.",
    ));

  it("counts the demo claims when only some are", () => {
    expect(demoNotice({ demo_claims: 2, total_claims: 5 })).toBe(
      "2 of 5 replayed claims are demo claims. Don't change limits based on these numbers.",
    );
    expect(demoNotice({ demo_claims: 1, total_claims: 5 })).toBe(
      "1 of 5 replayed claims is a demo claim. Don't change limits based on these numbers.",
    );
  });

  it("says nothing for real claims or an older backend", () => {
    expect(demoNotice({ demo_claims: 0, total_claims: 5 })).toBeNull();
    expect(demoNotice({ total_claims: 5 })).toBeNull();
    expect(demoNotice(null)).toBeNull();
  });
});
