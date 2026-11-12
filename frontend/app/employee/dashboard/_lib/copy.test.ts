import { describe, it, expect } from "vitest";
import type { Recovery, TrustChange, TrustInfo } from "@/lib/api/reclaim-pay-types";
import {
  badgeName,
  correctionRuleLine,
  formatShortDate,
  recentChangeLines,
  trustChangeLine,
  deadlineLine,
  disputeErrorLine,
  statusLines,
  formatDeadline,
  formatLimit,
  isDisputeOpen,
  limitLine,
  noticeLine,
  payoutLimitPrefix,
  trustReasonLine,
} from "./copy";

const KL = "Asia/Kuala_Lumpur";

const standard: TrustInfo = {
  trust_tier: "STANDARD", auto_limit: 100, paid_claims: 8, next_tier: "TRUSTED",
  claims_to_next_tier: 2, reasons: [], currency: "MYR", next_limit: 200, limited_until: null,
};

const recovery: Recovery = {
  recovery_id: "rec-1", reim_id: "1a2b3c4d-0000-4000-8000-000000000000", user_id: "u-1",
  amount: 30, currency: "MYR", reason: "Breakfast was included in the hotel rate and also claimed separately",
  status: "NOTICE_SENT", dispute_until: "2026-11-08T10:00:00Z", dispute_note: null,
  offset_reim_id: null, paypal_invoice_id: null, created_at: "2026-11-03T10:00:00Z", updated_at: "2026-11-03T10:00:00Z",
};

describe("badge names", () => {
  it("maps each level to a badge", () => {
    expect(badgeName("NEW")).toBe("Bronze");
    expect(badgeName("STANDARD")).toBe("Silver");
    expect(badgeName("TRUSTED")).toBe("Gold");
  });
  it("keeps cents only when the limit has them", () => {
    expect(formatLimit("MYR", 100)).toBe("MYR 100");
    expect(formatLimit("MYR", 87.5)).toBe("MYR 87.50");
  });
});

describe("payout limit label", () => {
  it("says instant payouts for an employee", () => {
    expect(payoutLimitPrefix(standard)).toBe("Instant payouts up to");
    expect(limitLine(standard)).toBe("Instant payouts up to MYR 100");
  });

  it("says reviewed payouts for a contractor", () => {
    const contractor = { ...standard, is_contractor: true };
    expect(payoutLimitPrefix(contractor)).toBe("Reviewed payouts up to");
    expect(limitLine(contractor)).toBe("Reviewed payouts up to MYR 100");
  });
});

describe("trust reason line", () => {  const reason = "Instant payouts are limited after a recent correction. They return to normal on 27 Jan 2027.";
  it("is absent when the backend gives no reasons", () => {
    expect(trustReasonLine(standard)).toBeNull();
    expect(trustReasonLine({ ...standard, reasons: ["  "] })).toBeNull();
  });
  it("shows the backend's text as written", () => {
    expect(trustReasonLine({ ...standard, trust_tier: "NEW", reasons: [reason] })).toBe(reason);
  });
});

describe("overpayment notice copy", () => {
  it("states the amount and claim", () => {
    expect(noticeLine(recovery)).toBe("We paid MYR 30.00 more than approved on claim RC-1A2B3C4D.");
  });
  it("formats the deadline like the spec", () => {
    expect(formatDeadline("2026-11-08T10:00:00Z", KL)).toBe("8 Nov, 6:00 pm");
    expect(formatDeadline("2026-11-08T01:05:00Z", KL)).toBe("8 Nov, 9:05 am");
  });
  it("offers the dispute while the window is open", () => {
    const before = new Date("2026-11-05T00:00:00Z");
    expect(isDisputeOpen(recovery, before)).toBe(true);
    expect(deadlineLine(recovery, before, KL)).toBe("You can dispute until 8 Nov, 6:00 pm.");
  });
  it("says the window has closed once the deadline passes", () => {
    const after = new Date("2026-11-08T10:00:01Z");
    expect(isDisputeOpen(recovery, after)).toBe(false);
    expect(deadlineLine(recovery, after, KL)).toBe("The dispute window closed on 8 Nov, 6:00 pm.");
  });
});

describe("recovery status lines", () => {
  const now = new Date("2026-11-05T00:00:00Z");
  it("covers every status without raw codes", () => {
    expect(statusLines({ ...recovery, status: "DISPUTED" }, now).line).toBe("Disputed · HR will review");
    expect(statusLines({ ...recovery, status: "OFFSET", offset_reim_id: "9c8b7a6d-0000" }, now)).toEqual({
      line: "Deducted from claim RC-9C8B7A6D.", detail: "Nothing more to do." });
    expect(statusLines({ ...recovery, status: "OFFSET" }, now).line).toBe("Deducted from a later claim.");
    expect(statusLines({ ...recovery, status: "INVOICED" }, now).line).toBe("We sent you a PayPal invoice for MYR 30.00.");
    expect(statusLines({ ...recovery, status: "RECOVERED" }, now).line).toBe("Repaid.");
    expect(statusLines({ ...recovery, status: "WAIVED" }, now)).toEqual({ line: "You don't owe anything.", detail: null });
  });
  it("explains what happens after the window closes", () => {
    const after = statusLines(recovery, new Date("2026-11-09T00:00:00Z"), KL);
    expect(after.line).toBe("The dispute window closed on 8 Nov, 6:00 pm.");
    expect(after.detail).toMatch(/next claim.*PayPal invoice/);
    expect(statusLines(recovery, now, KL)).toEqual({ line: "You can dispute until 8 Nov, 6:00 pm.", detail: null });
  });
  it("words dispute refusals calmly", () => {
    for (const code of ["WINDOW_CLOSED", "NOT_DISPUTABLE", "FAILED"] as const) {
      expect(disputeErrorLine(code)).not.toMatch(/[A-Z]{2,}_[A-Z]/);
    }
  });
});

describe("recent level changes", () => {
  const NOW = new Date("2026-11-12T08:00:00Z");
  const info = { ...standard, hold_days: 90, trusted_clean_days: 180 };
  const up: TrustChange = {
    at: "2026-10-20T03:00:00Z", from_tier: "NEW", to_tier: "STANDARD", from_limit: 50, to_limit: 100,
    cause: "approved_claims", reim_id: null,
  };
  const down: TrustChange = {
    at: "2026-11-03T03:00:00Z", from_tier: "STANDARD", to_tier: "NEW", from_limit: 100, to_limit: 50,
    cause: "correction", reim_id: "1a2b3c4d-0000-4000-8000-000000000000",
  };

  it("drops the year inside the current year only", () => {
    expect(formatShortDate("2026-10-20T03:00:00Z", NOW, KL)).toBe("20 Oct");
    expect(formatShortDate("2025-10-20T03:00:00Z", NOW, KL)).toBe("20 Oct 2025");
  });
  it("says when a badge was earned", () => {
    expect(trustChangeLine(up, info, NOW, KL)).toBe("You earned the Silver badge on 20 Oct: instant payouts up to MYR 100.");
  });
  it("names the claim behind a correction and nothing else", () => {
    expect(trustChangeLine(down, info, NOW, KL)).toBe(
      "Your instant-payout limit went down to MYR 50 on 3 Nov after a correction on claim RC-1A2B3C4D.");
  });
  it("calls a recovery a payout we had to recover", () => {
    expect(trustChangeLine({ ...down, cause: "recovery" }, info, NOW, KL)).toBe(
      "Your instant-payout limit went down to MYR 50 on 3 Nov after a payout we had to recover on claim RC-1A2B3C4D.");
  });
  it("still reads when the claim is unknown", () => {
    expect(trustChangeLine({ ...down, reim_id: null }, info, NOW, KL)).toBe(
      "Your instant-payout limit went down to MYR 50 on 3 Nov after a correction.");
  });
  it("explains a limit that came back with time", () => {
    const back = { ...up, cause: "time_passed" as const };
    expect(trustChangeLine(back, info, NOW, KL)).toBe(
      "You earned the Silver badge on 20 Oct: instant payouts up to MYR 100. It had been 90 days since your last correction.");
    expect(trustChangeLine({ ...back, from_tier: "STANDARD", to_tier: "TRUSTED", to_limit: 200 }, info, NOW, KL)).toBe(
      "You earned the Gold badge on 20 Oct: instant payouts up to MYR 200. It had been 180 days since your last correction.");
    expect(trustChangeLine(back, { currency: "MYR" }, NOW, KL)).toBe(
      "You earned the Silver badge on 20 Oct: instant payouts up to MYR 100.");
  });
  it("shows at most three, in the order given", () => {
    const lines = recentChangeLines({ ...info, changes: [down, up, up, up] }, NOW, KL);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^Your instant-payout limit went down/);
  });
  it("is empty for an older backend", () => {
    expect(recentChangeLines(standard, NOW, KL)).toEqual([]);
  });
  it("never mentions a check, score or signal", () => {
    for (const c of [up, down, { ...down, cause: "recovery" as const }, { ...up, cause: "time_passed" as const }]) {
      expect(trustChangeLine(c, info, NOW, KL)).not.toMatch(/risk|score|signal|tier|flag/i);
    }
  });
});

describe("how instant payouts work", () => {
  it("says one correction lowers the limit and for how long", () => {
    expect(correctionRuleLine({ ...standard, hold_days: 90 })).toBe(
      "A correction means HR confirmed a problem with one of your claims, or we had to recover a payout. " +
      "One correction moves you back to Bronze for 90 days. Your approved claims still count after that.");
  });
});
