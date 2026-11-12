import { describe, expect, it } from "vitest";
import { bookingResultCopy, isBookingPending } from "./resultCopy";

describe("bookingResultCopy", () => {
  it("never shows With HR for a booking that already paid or is sending", () => {
    for (const status of ["DISBURSING", "PAID"]) {
      const copy = bookingResultCopy(status);
      expect(copy.title).not.toBe("With HR");
      expect(copy.body).toContain("vendor");
    }
  });

  it("explains a failed vendor payment without asking the employee to pay", () => {
    const copy = bookingResultCopy("DISBURSEMENT_FAILED");
    expect(copy.title).toBe("Payment did not go through");
    expect(copy.body).toContain("HR");
    expect(copy.body).toContain("do not need to pay");
  });

  it("keeps review and rejection distinct", () => {
    expect(bookingResultCopy("REVIEW").title).toBe("With HR");
    expect(bookingResultCopy("REJECTED").title).toBe("Not approved");
    expect(bookingResultCopy(undefined).title).toBe("With HR");
  });

  it("marks only review and approved as pending", () => {
    expect(isBookingPending("REVIEW")).toBe(true);
    expect(isBookingPending("APPROVED")).toBe(true);
    expect(isBookingPending("DISBURSING")).toBe(false);
    expect(isBookingPending("PAID")).toBe(false);
    expect(isBookingPending("DISBURSEMENT_FAILED")).toBe(false);
  });
});
