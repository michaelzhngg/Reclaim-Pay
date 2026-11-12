import { describe, it, expect } from "vitest";
import type { ReportMetrics } from "@/lib/api/reclaim-pay-types";
import { barRows, codeLabel, defaultMonth, isMonth, kpiItems, monthOptions } from "./report";

const metrics: ReportMetrics = {
  month: "2026-10",
  label: "October 2026",
  timezone: "Malaysia time (UTC+8)",
  currency: "MYR",
  reimbursed: { value: 1234.5, count: 3, link: "/hr/history?report=2026-10&metric=reimbursed" },
  by_category: [
    { key: "Meals", value: 1000, count: 2, link: "/m" },
    { key: "Transport", value: 234.5, count: 1, link: "/t" },
  ],
  by_team: [],
  auto_pay: { auto: 7, decided: 8, rate: 87.5, link: "/a", decided_link: "/d" },
  fakes_caught: { count: 1, value: 300, link: "/f" },
  recovered: { value: 0, count: 0, link: "/r" },
  breaches: [],
  other_currency_claims: 0,
};

describe("kpiItems", () => {
  it("shows each headline number with its link", () => {
    const items = kpiItems(metrics);
    expect(items.map((i) => i.label)).toEqual(["Reimbursed", "Auto-pay rate", "Suspicious claims caught", "Recovered"]);
    expect(items[0]).toMatchObject({ detail: "3 paid claims", href: "/hr/history?report=2026-10&metric=reimbursed" });
    expect(items[0].value).toContain("1,234.50");
    expect(items[1]).toMatchObject({ value: "87.5%", detail: "7 of 8 decided claims", href: "/a" });
    expect(items[3].detail).toBe("0 recoveries");
  });

  it("says so when nothing was decided", () => {
    const empty = { ...metrics, auto_pay: { ...metrics.auto_pay, auto: 0, decided: 0, rate: null } };
    expect(kpiItems(empty)[1]).toMatchObject({ value: "No decisions", detail: "0 of 0 decided claims" });
  });
});

describe("barRows", () => {
  it("scales bars to the largest group and gives each group's share of the total", () => {
    const rows = barRows(metrics.by_category, 1234.5, "MYR");
    expect(rows.map((r) => [r.key, r.share, r.percent])).toEqual([
      ["Meals", 1, 81],
      ["Transport", 0.2345, 19],
    ]);
    expect(rows[0].link).toBe("/m");
  });

  it("handles an empty month", () => {
    expect(barRows([], 0, "MYR")).toEqual([]);
    expect(barRows([{ key: "Meals", value: 0, count: 1, link: "" }], 0, "MYR")[0]).toMatchObject({ share: 0, percent: 0 });
  });
});

describe("codeLabel", () => {
  it("uses HR wording for hard stops, falls back to the code", () => {
    expect(codeLabel("HIGH_RISK_SIGNAL")).toBe("High-risk signal on this claim");
    expect(codeLabel("SOMETHING_NEW")).toBe("SOMETHING_NEW");
  });
});

describe("months", () => {
  // 31 Oct 17:00 UTC is already 1 Nov in Malaysia.
  const now = new Date("2026-10-31T17:00:00Z");

  it("lists months newest first in Malaysia time", () => {
    const opts = monthOptions(now, 3);
    expect(opts.map((o) => o.value)).toEqual(["2026-11", "2026-10", "2026-09"]);
    expect(opts[0].label).toBe("November 2026 (so far)");
    expect(opts[1].label).toBe("October 2026");
  });

  it("defaults to last month", () => {
    expect(defaultMonth(now)).toBe("2026-10");
    expect(defaultMonth(new Date("2027-01-10T00:00:00Z"))).toBe("2026-12");
  });

  it("validates a month", () => {
    expect(isMonth("2026-10")).toBe(true);
    expect(isMonth("2026-13")).toBe(false);
    expect(isMonth(null)).toBe(false);
  });
});
