import { describe, it, expect } from "vitest";
import type { Recovery, TrustChange, TrustInfo } from "@/lib/api/reclaim-pay-types";
import {
  correctionRuleLine,
  formatShortDate,
  levelLines,
  recentChangeLines,
  trustChangeLine,
  deadlineLine,
  disputeErrorLine,
  statusLines,
  formatDeadline,
  formatLimit,
  isDisputeOpen,
  noticeLine,
  trustLine,
  trustProgress,
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

describe("trust line", () => {
  it("reads the way the UX report writes it", () => {
    expect(trustLine(standard)).toBe("Instant payouts up to MYR 100 · 2 more approved claims to reach MYR 200");
  });
  it("uses the singular for one claim", () => {
    expect(trustLine({ ...standard, claims_to_next_tier: 1 })).toBe(
      "Instant payouts up to MYR 100 · 1 more approved claim to reach MYR 200");
  });
  it("names the next tier when the backend leaves out its limit", () => {
    expect(trustLine({ ...standard, next_limit: null, currency: "" })).toBe(
      "Instant payouts up to MYR 100 · 2 more approved claims to reach Trusted");
  });
  it("says so plainly at the top tier", () => {
    const top: TrustInfo = { ...standard, trust_tier: "TRUSTED", auto_limit: 200, next_tier: null, claims_to_next_tier: 0, next_limit: null };
    expect(trustLine(top)).toBe("Instant payouts up to MYR 200 · This is the highest level.");
    expect(trustProgress(top)).toBe(1);
  });
  it("keeps cents only when the limit has them", () => {
    expect(formatLimit("MYR", 100)).toBe("MYR 100");
    expect(formatLimit("MYR", 87.5)).toBe("MYR 87.50");
  });
  it("measures progress from paid claims", () => {
    expect(trustProgress(standard)).toBeCloseTo(0.8);
    expect(trustProgress({ ...standard, paid_claims: 0, claims_to_next_tier: 0 })).toBe(0);
  });
});

describe("trust reason line", () => {
  const reason = "Instant payouts are limited after a recent correction. They return to normal on 27 Jan 2027.";
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
  it("says when a level was reached", () => {
    expect(trustChangeLine(up, info, NOW, KL)).toBe("You reached Standard on 20 Oct: instant payouts up to MYR 100.");
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
      "You reached Standard on 20 Oct: instant payouts up to MYR 100. It had been 90 days since your last correction.");
    expect(trustChangeLine({ ...back, from_tier: "STANDARD", to_tier: "TRUSTED", to_limit: 200 }, info, NOW, KL)).toBe(
      "You reached Trusted on 20 Oct: instant payouts up to MYR 200. It had been 180 days since your last correction.");
    expect(trustChangeLine(back, { currency: "MYR" }, NOW, KL)).toBe(
      "You reached Standard on 20 Oct: instant payouts up to MYR 100.");
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
  const info: TrustInfo = {
    ...standard, hold_days: 90, trusted_clean_days: 180,
    levels: [
      { tier: "NEW", auto_limit: 50, min_paid_claims: 0 },
      { tier: "STANDARD", auto_limit: 100, min_paid_claims: 3 },
      { tier: "TRUSTED", auto_limit: 200, min_paid_claims: 10 },
    ],
  };

  it("lists every level with its limit and marks the employee's own", () => {
    expect(levelLines(info)).toEqual([
      { tier: "NEW", text: "New: up to MYR 50. Everyone starts here.", current: false },
      { tier: "STANDARD", text: "Standard: up to MYR 100, after 3 approved claims. This is your level.", current: true },
      { tier: "TRUSTED", text: "Trusted: up to MYR 200, after 10 approved claims, with no correction in the last 180 days.", current: false },
    ]);
  });
  it("lists nothing when the backend sends no levels", () => {
    expect(levelLines(standard)).toEqual([]);
  });
  it("says one correction lowers the limit and for how long", () => {
    expect(correctionRuleLine(info)).toBe(
      "A correction means HR confirmed a problem with one of your claims, or we had to recover a payout. " +
      "One correction moves you back to New for 90 days. Your approved claims still count after that.");
  });
});
