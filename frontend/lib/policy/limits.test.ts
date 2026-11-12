import { describe, expect, it } from "vitest";
import type { LimitRule } from "@/lib/api/reclaim-pay-types";
import {
  gradeLabel, limitLabel, limitProblem, limitsErrorMessage, parseAmount, parseGrade, quantityLabel, unitLabel,
  whereLabel, zoneSummary,
} from "./limits";

const rule = (over: Partial<LimitRule>): LimitRule => ({
  category: "Accommodations", kind: "CAP", unit: "PER_NIGHT", amount: 375, currency: "MYR",
  grade_min: null, grade_max: null, scope: "ANY", zone: null, source_section: null, source_quote: null, ...over,
});

describe("policy limit labels", () => {
  it("describes grade ranges", () => {
    expect(gradeLabel(null, null)).toBe("Every grade");
    expect(gradeLabel(4, 7)).toBe("Grades 4 to 7");
    expect(gradeLabel(3, 3)).toBe("Grade 3");
    expect(gradeLabel(8, null)).toBe("Grade 8 and above");
    expect(gradeLabel(null, 2)).toBe("Grade 2 and below");
  });

  it("describes where a limit applies", () => {
    expect(whereLabel("ANY", null)).toBe("Anywhere");
    expect(whereLabel("DOMESTIC", "1")).toBe("Domestic, zone 1");
    expect(whereLabel("OVERSEAS", null)).toBe("Overseas");
  });

  it("formats the limit itself", () => {
    expect(limitLabel(rule({}))).toBe("Up to MYR 375.00 a night");
    expect(limitLabel(rule({ unit: "ACTUAL", amount: null }))).toBe("Actual cost");
    expect(limitLabel(rule({ kind: "PRE_APPROVAL", unit: "PER_ITEM", amount: 300 }))).toBe(
      "Approval needed above MYR 300.00 an item",
    );
  });

  it("says Not set when a capped limit has no amount yet", () => {
    expect(limitLabel(rule({ amount: null }))).toBe("Amount not set");
  });

  it("names units and quantities", () => {
    expect(unitLabel("PER_MEAL")).toBe("a meal");
    expect(quantityLabel("PER_NIGHT")).toBe("Nights");
    expect(quantityLabel("ACTUAL")).toBeNull();
  });

  it("summarises zones, naming the catch-all", () => {
    expect(zoneSummary([])).toEqual([]);
    expect(
      zoneSummary([
        { zone: "1", place: "Kuala Lumpur" },
        { zone: "2", place: "*" },
        { zone: "1", place: "Ipoh" },
      ]),
    ).toEqual([
      { zone: "1", places: "Kuala Lumpur, Ipoh" },
      { zone: "2", places: "Everywhere else" },
    ]);
  });
});

describe("policy limit input", () => {
  it("reads amounts as money and rejects anything else", () => {
    expect(parseAmount("375")).toBe(375);
    expect(parseAmount(" 99.5 ")).toBe(99.5);
    expect(parseAmount("")).toBeNull();
    expect(parseAmount("-1")).toBeNaN();
    expect(parseAmount("1e3")).toBeNaN();
    expect(parseAmount("12.345")).toBeNaN();
  });

  it("reads grades as whole numbers", () => {
    expect(parseGrade("4")).toBe(4);
    expect(parseGrade("")).toBeNull();
    expect(parseGrade("4.5")).toBeNaN();
    expect(parseGrade("51")).toBeNaN();
  });

  it("explains what is wrong with a limit before it is sent", () => {
    expect(limitProblem(rule({}))).toBeNull();
    expect(limitProblem(rule({ category: "" }))).toBe("Pick a category.");
    expect(limitProblem(rule({ amount: null }))).toBe("Enter an amount for Accommodations.");
    expect(limitProblem(rule({ amount: Number.NaN }))).toBe(
      "Accommodations: enter the amount as a number with up to 2 decimals.",
    );
    expect(limitProblem(rule({ unit: "ACTUAL", amount: null }))).toBeNull();
    expect(limitProblem(rule({ grade_min: 5, grade_max: 3 }))).toBe(
      "Accommodations: the lowest grade is above the highest grade.",
    );
    expect(limitProblem(rule({ grade_min: Number.NaN }))).toBe("Accommodations: grades are whole numbers from 0 to 50.");
    expect(limitProblem(rule({ kind: "PRE_APPROVAL", unit: "ACTUAL", amount: null }))).toBe(
      "Accommodations: an approval threshold needs an amount, not actual cost.",
    );
  });

  it("turns server errors into sentences HR can act on", () => {
    expect(limitsErrorMessage("UNKNOWN_CATEGORY", 422)).toBe(
      "One limit uses a category this policy doesn't have. Remove it and confirm again.",
    );
    expect(limitsErrorMessage('[{"loc":["body"]}]', 422)).toBe(
      "The server rejected one of the limits. Check the amounts and grades, then confirm again.",
    );
    expect(limitsErrorMessage("POLICY_NOT_FOUND", 404)).toBe("This policy no longer exists. Go back to Policy Studio.");
    expect(limitsErrorMessage("LIMITS_EXTRACTION_FAILED", 503)).toBe(
      "Couldn't read the policy right now. Try again later or add limits by hand.",
    );
    expect(limitsErrorMessage("Rate limit exceeded", 429)).toBe(
      "You can ask Reclaim to read the policy 3 times a minute. Wait a minute and try again.",
    );
    expect(limitsErrorMessage(null, undefined)).toBe("No response from the server. Try again.");
  });
});
