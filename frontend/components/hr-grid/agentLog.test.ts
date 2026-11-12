import { describe, expect, it } from "vitest";
import { actionLabel, actionSummary, actorLabel, chainBadgeLabel, hashPrefix } from "./agentLog";

describe("actionLabel", () => {
  it("reads the kill switch direction from the payload", () => {
    expect(actionLabel({ action_type: "KILL_SWITCH", payload: { enabled: false } })).toBe("Auto-pay paused");
    expect(actionLabel({ action_type: "KILL_SWITCH", payload: { enabled: true } })).toBe("Auto-pay resumed");
  });
  it("turns an unknown type into words", () => {
    expect(actionLabel({ action_type: "SOMETHING_NEW", payload: {} })).toBe("Something new");
  });
});

describe("actorLabel", () => {
  const id = "0000a11c-0000-4000-8000-000000000001";
  it("names the agent", () => expect(actorLabel("agent")).toBe("Reclaim agent"));
  it("resolves a user ID to a name", () => expect(actorLabel(id, { [id]: "Demo HR" })).toBe("Demo HR"));
  it("shortens an unresolved user ID", () => expect(actorLabel(id)).toBe("User 0000a11c"));
});

describe("actionSummary", () => {
  it.each([
    [{ action_type: "DECISION", payload: { tier: "AUTO_PAY", risk_score: 4 } }, "Auto-pay, risk score 4"],
    [{ action_type: "PAYOUT_CREATED", payload: { amount: "48.00", currency: "MYR" } }, "MYR 48.00"],
    [{ action_type: "PAYOUT_STATUS", payload: { from: "REQUESTED", to: "SUCCEEDED" } }, "Processing to Paid"],
    [{ action_type: "RECOVERY_STATUS", payload: { from: "NOTICE_SENT", to: "DISPUTED" } }, "Notice sent to Disputed"],
    [{ action_type: "CONFIG_CHANGED", payload: { version: 3, reason: "After the Q3 audit" } }, "After the Q3 audit"],
    [{ action_type: "CONFIG_CHANGED", payload: { version: 3 } }, "Saved version 3"],
    [{ action_type: "KILL_SWITCH", payload: { reason: "Month-end close" } }, "Month-end close"],
    [{ action_type: "RECOVERY_INVOICED", payload: { invoice_id: "INV2-1" } }, "PayPal invoice INV2-1"],
    [{ action_type: "HR_APPROVAL", payload: { approvals: 1, required: 2 } }, "1 of 2 approvals"],
  ])("%j", (action, expected) => {
    expect(actionSummary(action)).toBe(expected);
  });

  it("returns null rather than guessing at a malformed or unknown payload", () => {
    expect(actionSummary({ action_type: "PAYOUT_STATUS", payload: {} })).toBeNull();
    expect(actionSummary({ action_type: "DECISION", payload: { tier: "NOPE" } })).toBeNull();
    expect(actionSummary({ action_type: "SOMETHING_NEW", payload: { a: 1 } })).toBeNull();
  });
});

describe("chainBadgeLabel", () => {
  it("counts entries when the chain holds", () => {
    expect(chainBadgeLabel(true, 12, 200)).toBe("Chain intact · 12 entries");
    expect(chainBadgeLabel(true, 1, 200)).toBe("Chain intact · 1 entry");
  });
  it("doesn't understate the count when the page limit was hit", () => {
    expect(chainBadgeLabel(true, 200, 200)).toBe("Chain intact · 200+ entries");
  });
  it("says so when the chain is broken", () => {
    expect(chainBadgeLabel(false, 12, 200)).toBe("Chain broken");
  });
});

describe("hashPrefix", () => {
  it("keeps the first 8 characters", () => expect(hashPrefix("9f2c4b1a77")).toBe("9f2c4b1a"));
});

describe("signal reviews in the log", () => {
  const rated = (verdict: string, previous: unknown = null) =>
    ({ action_type: "SIGNAL_REVIEWED", payload: { code: "SPLIT_CLAIM", document_id: null, verdict, previous } });
  it("labels the entry", () => expect(actionLabel(rated("CONFIRMED"))).toBe("Check rated"));
  it("names the check and the answer", () => {
    expect(actionSummary(rated("CONFIRMED"))).toBe("Possible split claim: Real problem");
    expect(actionSummary(rated("FALSE_ALARM"))).toBe("Possible split claim: False alarm");
  });
  it("marks an answer that replaced an earlier one", () => {
    expect(actionSummary(rated("FALSE_ALARM", { verdict: "CONFIRMED", reviewed_by: "hr-1" })))
      .toBe("Possible split claim: False alarm (changed)");
  });
  it("gives nothing for an unknown verdict", () => expect(actionSummary(rated("MAYBE"))).toBeNull());
});
