import { describe, it, expect } from "vitest";
import { coverPhrase, fundingView, type FundingSummary } from "./funding";

const base: FundingSummary = {
  status: "ok",
  currency: "MYR",
  available: "25000.00",
  expected_daily: "205.00",
  committed: "0.00",
  days_of_cover: "121.9",
  threshold_days: 3,
  history_days: 14,
  as_of: "2026-11-12T08:00:00Z",
  checked_at: "2026-11-12T08:00:05Z",
  mock: false,
  message: "",
};

describe("coverPhrase", () => {
  it("rounds down to whole days and never says zero days", () => {
    expect(coverPhrase("2.9")).toBe("about 2 days");
    expect(coverPhrase("1.0")).toBe("about 1 day");
    expect(coverPhrase("0.4")).toBe("less than a day");
    expect(coverPhrase("0.0")).toBe("less than a day");
    expect(coverPhrase(null)).toBe("less than a day");
    expect(coverPhrase("1234.5")).toBe("about 1,234 days");
  });
});

describe("fundingView", () => {
  it("shows a funded balance calmly", () => {
    const v = fundingView(base);
    expect(v).toMatchObject({ tone: "success", label: "Funded", figure: "MYR 25,000.00" });
    expect(v.alert).toBe("Covers about 121 days of payouts at the recent rate.");
    expect(v.stats.map((s) => s.value)).toEqual(["MYR 205.00", "MYR 0.00", "3 days of payouts"]);
  });

  it("warns when the balance is under the threshold", () => {
    const v = fundingView({ ...base, status: "low", available: "410.00", days_of_cover: "2.0" });
    expect(v.tone).toBe("warning");
    expect(v.figure).toBe("MYR 410.00");
    expect(v.alert).toContain("Covers about 2 days of payouts, under the 3-day minimum.");
  });

  it("names the approved amount it can't cover", () => {
    const v = fundingView({ ...base, status: "short", available: "300.00", committed: "520.00" });
    expect(v.tone).toBe("danger");
    expect(v.alert).toContain("Not enough for the MYR 520.00 of approved claims waiting to be paid.");
  });

  it("calls a negative balance with nothing owed overdrawn, not short of MYR 0.00", () => {
    const v = fundingView({ ...base, status: "short", available: "-50.00", committed: "0.00", days_of_cover: "0.0" });
    expect(v).toMatchObject({ tone: "danger", label: "Overdrawn", figure: "MYR -50.00" });
    expect(v.alert).toBe("The PayPal account is overdrawn. Top up the PayPal business account before any payout is sent.");
    expect(v.alert).not.toContain("MYR 0.00");
  });

  it("explains a missing rate instead of guessing one", () => {
    const v = fundingView({ ...base, status: "no_history", expected_daily: "0.00", days_of_cover: null });
    expect(v).toMatchObject({ tone: "neutral", label: "No recent payouts" });
    expect(v.alert).toBe("No payouts in the last 14 days, so there is no daily rate to measure against.");
  });

  it("passes the backend's reason through when PayPal didn't answer", () => {
    const message =
      'PayPal refused to share the balance. Tick "Transaction search" under the PayPal app\'s features in the developer dashboard.';
    const v = fundingView({ ...base, status: "unavailable", available: null, days_of_cover: null, message });
    // No pill: the card already says "Balance not checked" once.
    expect(v).toMatchObject({ tone: "neutral", label: null, figure: null, alert: message });
  });

  it("falls back to a plain sentence when the reason is empty", () => {
    const v = fundingView({ ...base, status: "unavailable", available: null, message: "" });
    expect(v.alert).toBe("Couldn't load the balance check.");
  });

  it("keeps copy free of exclamation marks and em dashes", () => {
    for (const status of ["ok", "low", "short", "no_history", "unavailable"] as const) {
      const v = fundingView({ ...base, status, message: "x" });
      const text = [v.label ?? "", v.alert, ...v.stats.flatMap((s) => [s.label, s.value])].join(" ");
      expect(text).not.toMatch(/[!—]/);
    }
  });
});
