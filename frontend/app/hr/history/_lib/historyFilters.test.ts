import { describe, it, expect } from "vitest";
import type { HistoryClaim } from "@/lib/actions/hr";
import {
  EMPTY_FILTERS,
  applyHistoryFilters,
  filterChips,
  historySearch,
  parseHistoryParams,
  reportTitle,
} from "./historyFilters";

const parse = (s: string) => parseHistoryParams(new URLSearchParams(s));

const claim = (over: Partial<HistoryClaim>): HistoryClaim => ({
  id: "RC-AAAA1111",
  reim_id: "a",
  employeeName: "Siti Aminah",
  employeeInitial: "S",
  department: "Sales",
  policyName: "Travel Policy",
  amount: 10,
  currency: "MYR",
  category: "Meals",
  resolvedAt: "2026-10-15T04:00:00Z",
  companyAmount: 10,
  companyCurrency: "MYR",
  dateSubmitted: "",
  dateResolved: "",
  status: "Paid",
  payout: null,
  ...over,
});

describe("parseHistoryParams", () => {
  it("reads every plain filter", () => {
    expect(parse("status=Paid&q=siti&category=Meals&department=Sales&from=2026-10-01&to=2026-10-31")).toEqual({
      status: "Paid",
      q: "siti",
      category: "Meals",
      department: "Sales",
      from: "2026-10-01",
      to: "2026-10-31",
      report: null,
    });
  });

  it("ignores values it doesn't understand", () => {
    expect(parse("status=Weird&from=1%20Oct&to=2026-13")).toEqual(EMPTY_FILTERS);
  });

  it("reads a report link, keeping its category for the report query", () => {
    const f = parse("report=2026-10&metric=reimbursed&category=Meals");
    expect(f.report).toEqual({ month: "2026-10", metric: "reimbursed", category: "Meals" });
    expect(f.category).toBeNull();
  });

  it("drops a report link with a bad month or metric", () => {
    expect(parse("report=2026-13&metric=reimbursed").report).toBeNull();
    expect(parse("report=2026-10&metric=everything").report).toBeNull();
  });
});

describe("historySearch", () => {
  it("round-trips through parse", () => {
    for (const s of ["?status=Rejected&q=omar&department=Ops&from=2026-10-01", "?report=2026-10&metric=breach&code=HIGH_RISK_SIGNAL&status=Paid"]) {
      expect(historySearch(parse(s.slice(1)))).toBe(s);
    }
  });

  it("is empty for no filters", () => {
    expect(historySearch(EMPTY_FILTERS)).toBe("");
  });
});

describe("applyHistoryFilters", () => {
  const claims = [
    claim({ reim_id: "1" }),
    claim({ reim_id: "2", status: "Rejected", category: "Transport", department: "Ops", employeeName: "Omar" }),
    claim({ reim_id: "3", resolvedAt: "2026-11-02T04:00:00Z" }),
    claim({ reim_id: "4", resolvedAt: null }),
  ];
  const ids = (s: string) => applyHistoryFilters(claims, parse(s)).map((c) => c.reim_id);

  it("filters by status, category, team and search", () => {
    expect(ids("status=Rejected")).toEqual(["2"]);
    expect(ids("category=Meals")).toEqual(["1", "3", "4"]);
    expect(ids("department=Ops")).toEqual(["2"]);
    expect(ids("q=omar")).toEqual(["2"]);
  });

  it("filters by resolved date, and leaves out claims with none", () => {
    expect(ids("from=2026-10-01&to=2026-10-31")).toEqual(["1", "2"]);
    expect(ids("from=2026-11-01")).toEqual(["3"]);
  });
});

describe("reportTitle and filterChips", () => {
  it("names the number the rows are behind", () => {
    expect(reportTitle({ month: "2026-10", metric: "reimbursed", team: "Sales" })).toBe("Reimbursed in October 2026 · Sales");
    expect(reportTitle({ month: "2026-01", metric: "breach", code: "HIGH_RISK_SIGNAL" })).toBe("Flagged in January 2026 · HIGH_RISK_SIGNAL");
  });

  it("lists the filters that came by link", () => {
    expect(filterChips(parse("category=Meals&from=2026-10-01")).map((c) => c.label)).toEqual(["Category: Meals", "From 2026-10-01"]);
  });
});
