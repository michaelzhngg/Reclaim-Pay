import { describe, it, expect } from "vitest";
import type { Policy as BackendPolicy } from "@/lib/api/types";
import {
  budgetInputs,
  budgetsPayload,
  matchesSearch,
  parseMandatoryConditions,
  policyMeta,
  sourceFileName,
  statusFromBackend,
  toPolicy,
} from "./policy";

const backend = (over: Partial<BackendPolicy> = {}): BackendPolicy => ({
  policy_id: "p1",
  alias: "Travel Policy",
  title: "Travel and Expenses",
  reimbursable_categories: ["Meals", "Transport"],
  reimbursable_categories_with_budgets: [
    { category: "Meals", auto_approval_budget: 50 },
    { category: "Transport", auto_approval_budget: null },
  ],
  overview_summary: "Intro\n- one",
  mandatory_conditions: JSON.stringify({ Meals: { condition: ["Itemised receipt", ""] } }),
  status: "ACTIVE",
  effective_date: "2026-11-01T00:00:00Z",
  source_file_url: "storage/policies/travel.pdf",
  ...over,
});

describe("statusFromBackend", () => {
  it("maps every backend status", () => {
    expect(statusFromBackend("ACTIVE")).toBe("Active");
    expect(statusFromBackend("DEPRECATED")).toBe("Expired");
    expect(statusFromBackend("DRAFT")).toBe("Impending");
  });
});

describe("parseMandatoryConditions", () => {
  it("parses the JSON string and drops blank conditions", () => {
    expect(parseMandatoryConditions('{"Meals":{"condition":["A",""," "]}}')).toEqual({ Meals: { condition: ["A"] } });
  });

  it("accepts an object", () => {
    expect(parseMandatoryConditions({ Meals: { condition: ["A"] } })).toEqual({ Meals: { condition: ["A"] } });
  });

  it("returns null for empty, invalid or wrongly shaped input", () => {
    expect(parseMandatoryConditions("")).toBeNull();
    expect(parseMandatoryConditions("not json")).toBeNull();
    expect(parseMandatoryConditions("[1,2]")).toBeNull();
    expect(parseMandatoryConditions({ Meals: { condition: "A" } })).toBeNull();
    expect(parseMandatoryConditions(null)).toBeNull();
  });
});

describe("toPolicy", () => {
  it("keeps only what the backend sends", () => {
    const p = toPolicy(backend());
    expect(p.status).toBe("Active");
    expect(p.mandatory_conditions).toEqual({ Meals: { condition: ["Itemised receipt"] } });
    expect(p.reimbursable_categories_with_budgets).toHaveLength(2);
    expect(p.lastModified).not.toBe("");
    expect(Object.keys(p)).not.toContain("department");
    expect(Object.keys(p)).not.toContain("version");
  });

  it("falls back to the title, then a placeholder, for the name", () => {
    expect(toPolicy(backend({ alias: "" })).alias).toBe("Travel and Expenses");
    expect(toPolicy(backend({ alias: "", title: "" })).alias).toBe("Untitled policy");
  });

  it("has no date text without an effective date", () => {
    expect(toPolicy(backend({ effective_date: null })).lastModified).toBe("");
  });
});

describe("policyMeta", () => {
  it("joins the date and category count", () => {
    expect(policyMeta(toPolicy(backend()))).toMatch(/^Effective .+ · 2 categories$/);
  });

  it("is empty when there is nothing to say", () => {
    expect(policyMeta(toPolicy(backend({ effective_date: null, reimbursable_categories_with_budgets: [] })))).toBe("");
  });

  it("uses the singular for one category", () => {
    const one = toPolicy(backend({ effective_date: null, reimbursable_categories_with_budgets: [{ category: "Meals", auto_approval_budget: 1 }] }));
    expect(policyMeta(one)).toBe("1 category");
  });
});

describe("matchesSearch", () => {
  const p = toPolicy(backend());
  it("matches the name, title or a category, ignoring case", () => {
    expect(matchesSearch(p, "travel")).toBe(true);
    expect(matchesSearch(p, "EXPENSES")).toBe(true);
    expect(matchesSearch(p, "transport")).toBe(true);
    expect(matchesSearch(p, "   ")).toBe(true);
    expect(matchesSearch(p, "payroll")).toBe(false);
  });
});

describe("sourceFileName", () => {
  it("takes the last path segment on either slash", () => {
    expect(sourceFileName("storage/policies/travel.pdf")).toBe("travel.pdf");
    expect(sourceFileName("C:\\data\\travel.pdf")).toBe("travel.pdf");
    expect(sourceFileName("")).toBe("");
    expect(sourceFileName(undefined)).toBe("");
  });
});

describe("budgetInputs", () => {
  it("uses the stored budgets, blank for no limit", () => {
    expect(budgetInputs(toPolicy(backend()))).toEqual({ Meals: "50", Transport: "" });
  });

  it("falls back to the condition categories", () => {
    expect(budgetInputs(toPolicy(backend({ reimbursable_categories_with_budgets: [] })))).toEqual({ Meals: "" });
  });
});

describe("budgetsPayload", () => {
  it("turns blanks into no limit and rounds to cents", () => {
    expect(budgetsPayload({ Meals: "50.456", Transport: " " })).toEqual({
      ok: true,
      categories: [
        { category: "Meals", auto_approval_budget: 50.46 },
        { category: "Transport", auto_approval_budget: null },
      ],
    });
  });

  it("rejects negative and non-numeric amounts, naming the category", () => {
    const neg = budgetsPayload({ Meals: "-1" });
    expect(neg.ok).toBe(false);
    if (!neg.ok) expect(neg.error).toContain("Meals");
    expect(budgetsPayload({ Meals: "abc" }).ok).toBe(false);
  });

  it("accepts zero", () => {
    expect(budgetsPayload({ Meals: "0" })).toEqual({ ok: true, categories: [{ category: "Meals", auto_approval_budget: 0 }] });
  });
});
