import { describe, expect, it } from "vitest";
import { companyLineAmount, formatFxTimestamp, fxQuoteText } from "./fx";

describe("formatFxTimestamp", () => {
  it("prints the UTC date and time", () => {
    expect(formatFxTimestamp("2026-11-12T09:00:00+00:00")).toBe("12 Nov 2026, 09:00 UTC");
  });

  it("reads Not set for a missing timestamp", () => {
    expect(formatFxTimestamp(null)).toBe("Not set");
    expect(formatFxTimestamp("not-a-date")).toBe("Not set");
  });
});

describe("fxQuoteText", () => {
  it("prints the claim, the company equivalent, the rate and the date", () => {
    expect(fxQuoteText("USD", 120, "MYR", 4.7, "2026-11-12T09:00:00+00:00")).toBe(
      "USD 120.00 ≈ MYR 564.00 at 4.7000 on 12 Nov 2026, 09:00 UTC",
    );
  });

  it("labels a company-currency claim instead of repeating the rate", () => {
    expect(fxQuoteText("MYR", 120, "MYR", 1, "2026-11-12T09:00:00+00:00")).toBe(
      "MYR 120.00 (company currency)",
    );
  });

  it("never guesses a missing rate", () => {
    expect(fxQuoteText("XYZ", 120, "MYR", null, null)).toBe("XYZ 120.00 (no company rate)");
  });
});

describe("companyLineAmount", () => {
  it("formats a line's company amount", () => {
    expect(companyLineAmount("MYR", 564)).toBe("MYR 564.00");
  });

  it("returns null when the line has no company amount", () => {
    expect(companyLineAmount("MYR", null)).toBeNull();
    expect(companyLineAmount(null, 564)).toBeNull();
  });
});
