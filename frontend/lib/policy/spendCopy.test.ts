import { describe, expect, it } from "vitest";
import type { LimitRule, SpendCheckResult, TripEstimate } from "@/lib/api/reclaim-pay-types";
import {
  GUIDANCE_NOTE, askErrorMessage, spendErrorMessage, tripLineText, tripNotes, tripSummary, verdictMessage,
} from "./spendCopy";

const cap: LimitRule = {
  category: "Accommodations", kind: "CAP", unit: "PER_NIGHT", amount: 400, currency: "MYR",
  grade_min: 3, grade_max: 4, scope: "ANY", zone: null, source_section: "3.3 Accommodations", source_quote: null,
};
const pre: LimitRule = { ...cap, category: "Equipment", kind: "PRE_APPROVAL", unit: "PER_ITEM", amount: 300 };
const base: SpendCheckResult = {
  verdict: "WITHIN", category: "Accommodations", quantity: 1, zone: null, cap, pre_approval: null,
  limit_total: 400, reimbursable_up_to: 380, employee_pays: null, policy_title: "Demo travel policy", currency: "MYR",
};

describe("verdictMessage", () => {
  it("within the limit", () => {
    expect(verdictMessage(base)).toEqual({ tone: "ok", text: "Within your limit. You can claim the full MYR 380.00." });
  });

  it("over the limit says what the employee pays", () => {
    const r = { ...base, verdict: "OVER" as const, quantity: 3, limit_total: 1200, reimbursable_up_to: 1200, employee_pays: 100 };
    expect(verdictMessage(r)).toEqual({
      tone: "warn",
      text: "Above your limit. You can claim up to MYR 1,200.00 for 3 nights. You pay the other MYR 100.00.",
    });
    expect(verdictMessage({ ...r, quantity: 1, limit_total: 400, employee_pays: 20 }).text).toBe(
      "Above your limit. You can claim up to MYR 400.00. You pay the other MYR 20.00.",
    );
  });

  it("limit only, with the total for several nights", () => {
    expect(verdictMessage({ ...base, verdict: "LIMIT_ONLY", reimbursable_up_to: null }).text).toBe(
      "Your limit: up to MYR 400.00 a night.",
    );
    expect(verdictMessage({ ...base, verdict: "LIMIT_ONLY", quantity: 2, limit_total: 800 }).text).toBe(
      "Your limit: up to MYR 400.00 a night. That's MYR 800.00 for 2 nights.",
    );
    expect(verdictMessage({ ...base, verdict: "LIMIT_ONLY", cap: null, pre_approval: pre, limit_total: null }).text).toBe(
      "HR approval is needed above MYR 300.00 an item. Enter an amount to check yours.",
    );
  });

  it("needs approval first", () => {
    expect(verdictMessage({ ...base, verdict: "NEEDS_PRE_APPROVAL", cap: null, pre_approval: pre })).toEqual({
      tone: "warn", text: "Get HR approval before you buy. The policy needs it above MYR 300.00 an item.",
    });
  });

  it("cases with no number", () => {
    expect(verdictMessage({ ...base, verdict: "NOT_COVERED" }).text).toBe(
      "This isn't in any company policy, so it may not be reimbursed. Ask HR first.",
    );
    expect(verdictMessage({ ...base, verdict: "NEED_DESTINATION" })).toEqual({
      tone: "info", text: "Add where you're going. The limit depends on the destination.",
    });
    expect(verdictMessage({ ...base, verdict: "PLACE_NOT_LISTED" })).toEqual({
      tone: "warn", text: "We couldn't match that place to a zone in the policy. Ask HR which rate applies.",
    });
    expect(verdictMessage({ ...base, verdict: "GRADE_NOT_LISTED" }).text).toBe(
      "The policy doesn't list a limit for your grade. Ask HR before you spend.",
    );
    expect(verdictMessage({ ...base, verdict: "ACTUAL_COST" }).text).toBe(
      "Paid at actual cost for your grade. Keep the itemised receipt.",
    );
    expect(verdictMessage({ ...base, verdict: "NO_LIMIT" }).text).toBe(
      "The policy sets no amount for this. HR checks it against the policy wording when you claim.",
    );
  });

  it("never uses an em dash", () => {
    const verdicts = ["WITHIN", "OVER", "ACTUAL_COST", "NEEDS_PRE_APPROVAL", "LIMIT_ONLY", "NO_LIMIT",
      "NEED_DESTINATION", "PLACE_NOT_LISTED", "GRADE_NOT_LISTED", "NOT_COVERED"] as const;
    for (const v of verdicts) expect(verdictMessage({ ...base, verdict: v }).text).not.toMatch(/—/);
    expect(GUIDANCE_NOTE).toBe("Guidance, not an approval. The decision is made when you submit the claim.");
  });
});

describe("trip wording", () => {
  const est: TripEstimate = {
    days: 3, nights: 2, zone: "1",
    lines: [
      { category: "Daily Trip Allowance", unit: "PER_DAY", rate: 75, quantity: 3, subtotal: 225, source_section: null },
      { category: "Accommodations", unit: "PER_NIGHT", rate: 375, quantity: 1, subtotal: 375, source_section: null },
      { category: "Meals", unit: "ACTUAL", rate: null, quantity: 3, subtotal: null, source_section: null },
    ],
    other_limits: [{ ...cap, category: "Client meals", unit: "PER_MEAL", amount: 100 }],
    total_up_to: 600, has_actual_cost: true,
    missing: ["Intercity Transport", "Parking", "Laundry"],
    missing_reasons: { "Intercity Transport": "NEED_DESTINATION", Parking: "PLACE_NOT_LISTED", Laundry: "GRADE_NOT_LISTED" },
    currency: "MYR",
  };

  it("sums up the trip", () => {
    expect(tripSummary(est)).toBe("Up to MYR 600.00 for 3 days and 2 nights, plus items paid at actual cost.");
    expect(tripSummary({ ...est, days: 1, nights: 0, has_actual_cost: false })).toBe("Up to MYR 600.00 for 1 day.");
    expect(tripSummary({ ...est, lines: [], total_up_to: 0, has_actual_cost: false })).toBe(
      "No daily or nightly limit in the policy applies to this trip.",
    );
  });

  it("formats lines, singular and plural", () => {
    expect(tripLineText(est.lines[0], "MYR")).toBe("3 days at MYR 75.00 = MYR 225.00");
    expect(tripLineText(est.lines[1], "MYR")).toBe("1 night at MYR 375.00 = MYR 375.00");
    expect(tripLineText(est.lines[2], "MYR")).toBe("Actual cost");
  });

  it("adds notes for per-meal limits and each reason a category is left out", () => {
    expect(tripNotes(est)).toEqual([
      "Also: Client meals up to MYR 100.00 a meal.",
      "Add where you're going to include Intercity Transport.",
      "Not included: Parking. We couldn't match that place to a zone in the policy. Ask HR which rate applies.",
      "Not included: Laundry. The policy doesn't list a limit for your grade. Ask HR.",
    ]);
  });
});

describe("error wording", () => {
  it("maps the check and trip errors", () => {
    expect(spendErrorMessage("RETURN_BEFORE_DEPART", 422)).toBe("The return date is before the departure date.");
    expect(spendErrorMessage("TRIP_TOO_LONG", 422)).toBe("Trips longer than 60 days can't be estimated. Ask HR.");
    expect(spendErrorMessage("Rate limit exceeded: 60 per 1 minute", 429)).toBe("Too many checks in a minute. Wait a moment and try again.");
    expect(spendErrorMessage("Network request failed: x", undefined)).toBe("Couldn't reach Reclaim. Check your connection and try again.");
  });

  it("maps the question errors, telling the daily cap from the per-minute limit", () => {
    expect(askErrorMessage("QUESTION_LENGTH", 422)).toBe("Write a question between 5 and 500 characters.");
    expect(askErrorMessage("DAILY_QUESTION_LIMIT", 429)).toBe(
      "You've asked 20 questions in the last 24 hours. Ask HR, or try again tomorrow.",
    );
    expect(askErrorMessage("Rate limit exceeded: 10 per 1 minute", 429)).toBe("Too many questions in a minute. Wait a moment and try again.");
    expect(askErrorMessage("QA_UNAVAILABLE", 503)).toBe("Couldn't answer right now. Try again in a few minutes, or ask HR.");
  });
});
