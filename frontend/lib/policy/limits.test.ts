import { describe, expect, it } from "vitest";
import type { LimitRule } from "@/lib/api/reclaim-pay-types";
import {
  DISCARD_LIMITS_TEXT, LIMITS_UNCONFIRMED, confirmedMessage, gradeLabel, limitLabel, limitProblem, limitsErrorMessage, parseAmount, parseGrade, quantityLabel,
  rowName, unitLabel, visibilityNote, whereLabel, zoneSummary,
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
    expect(parseAmount("9999999999.99")).toBe(9999999999.99);
    expect(parseAmount("10000000000")).toBeNaN();
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
    expect(limitsErrorMessage("UNKNOWN_CATEGORY: Parking", 422)).toBe(
      "Parking isn't a category in this policy any more. Remove that limit and confirm again.",
    );
    expect(limitsErrorMessage("CONFLICTING_LIMITS", 422)).toBe(
      "Two limits cover the same grades and place with different amounts. Remove one.",
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

describe("policy limit visibility", () => {
  const view = (over: Partial<{ policy_active: boolean; categories: string[]; employee_visible_categories: string[] }>) => ({
    policy_active: true,
    categories: ["Meals", "Accommodations"],
    employee_visible_categories: ["Meals", "Accommodations"],
    ...over,
  });

  it("says whether employees see the limits", () => {
    expect(visibilityNote(view({}))).toBe("Employees see these limits before they spend.");
    expect(visibilityNote(view({ policy_active: false, employee_visible_categories: [] }))).toBe(
      "Employees won't see these limits: the policy isn't active.",
    );
    expect(visibilityNote(view({ employee_visible_categories: ["Accommodations"] }))).toBe(
      "Employees see these limits before they spend, except for Meals: a newer active policy covers it.",
    );
    expect(visibilityNote(view({ employee_visible_categories: [] }))).toBe(
      "Employees won't see these limits: a newer active policy covers Meals and Accommodations.",
    );
  });

  it("confirms in words that match what employees see", () => {
    expect(confirmedMessage(view({}), 3)).toBe("Limits confirmed. Employees see them from now on.");
    expect(confirmedMessage(view({ policy_active: false, employee_visible_categories: [] }), 3)).toBe(
      "Limits confirmed. Employees will see them once the policy is active.",
    );
    expect(confirmedMessage(view({}), 0)).toBe("No limits confirmed. Employees see no limits for this policy.");
    expect(confirmedMessage(view({ employee_visible_categories: ["Accommodations"] }), 3)).toBe(
      "Limits confirmed. Employees see them from now on, except for Meals: a newer active policy covers it.",
    );
    expect(confirmedMessage(view({ employee_visible_categories: [] }), 3)).toBe(
      "Limits confirmed. Employees won't see them: a newer active policy covers Meals and Accommodations.",
    );
  });

  it("names a row uniquely for screen readers", () => {
    expect(rowName(rule({ grade_min: 4, grade_max: 7, scope: "DOMESTIC", zone: "1" }))).toBe(
      "Accommodations, Grades 4 to 7, Domestic, zone 1, per night",
    );
    expect(rowName(rule({ kind: "PRE_APPROVAL", unit: "PER_ITEM" }))).toBe(
      "Accommodations, Every grade, Anywhere, per item, approval threshold",
    );
    expect(rowName(rule({ unit: "PER_DAY" }))).not.toBe(rowName(rule({ unit: "PER_NIGHT" })));
    expect(rowName(rule({ unit: "ACTUAL", amount: null }))).toBe("Accommodations, Every grade, Anywhere, actual cost");
  });
});

describe("leaving with unconfirmed limit edits", () => {
  it("asks first without promising what employees see", () => {
    expect(LIMITS_UNCONFIRMED).toBe("Confirm or undo your spending limit changes first.");
    expect(DISCARD_LIMITS_TEXT).toBe("You changed spending limits but didn't confirm them. If you leave now, those changes are lost.");
    expect(DISCARD_LIMITS_TEXT).not.toMatch(/employees/i);
  });
});
