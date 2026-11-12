import { describe, expect, it } from "vitest";

import {
  invoiceAmountMatches,
  invoiceErrorCopy,
  invoicePeriodLabel,
  invoiceTotal,
  quantityLabel,
  roundMoney,
} from "./invoices";

describe("invoiceTotal", () => {
  it("multiplies quantity by unit price to the cent", () => {
    expect(invoiceTotal(2, 50)).toBe(100);
    expect(invoiceTotal(1.5, 19.99)).toBe(29.99);
  });

  it("refuses a missing or non-positive input", () => {
    expect(invoiceTotal(0, 50)).toBeNull();
    expect(invoiceTotal(2, 0)).toBeNull();
    expect(invoiceTotal(Number.NaN, 50)).toBeNull();
  });
});

describe("invoiceAmountMatches", () => {
  it("accepts the exact total and a one-cent float drift", () => {
    expect(invoiceAmountMatches(2, 50, 100)).toBe(true);
    expect(invoiceAmountMatches(3, 0.1, 0.3)).toBe(true);
  });

  it("refuses a different amount", () => {
    expect(invoiceAmountMatches(2, 50, 99)).toBe(false);
  });
});

describe("roundMoney", () => {
  it("rounds half up at two decimals", () => {
    expect(roundMoney(29.985)).toBe(29.99);
  });
});

describe("invoicePeriodLabel", () => {
  it("reads start to end in UTC", () => {
    expect(invoicePeriodLabel("2026-11-01", "2026-11-05")).toBe("1 Nov 2026 to 5 Nov 2026");
  });

  it("shows Not set when a side is missing", () => {
    expect(invoicePeriodLabel(null, "2026-11-05")).toBe("Not set");
  });
});

describe("quantityLabel", () => {
  it("names the contract rate unit", () => {
    expect(quantityLabel(2, "DAY")).toBe("2 days");
    expect(quantityLabel(1, "PROJECT")).toBe("1 project");
    expect(quantityLabel(null, "HOUR")).toBe("Not set");
  });
});

describe("invoiceErrorCopy", () => {
  it("turns a backend code into contractor copy", () => {
    expect(invoiceErrorCopy("AMOUNT_MISMATCH: Quantity times unit price...")).toBe(
      "Quantity times unit price must equal the claimed amount.",
    );
    expect(invoiceErrorCopy("NO_ACTIVE_CONTRACT")).toContain("active contract");
  });

  it("falls back without leaking a code", () => {
    expect(invoiceErrorCopy("SOMETHING_NEW")).toBe(
      "We could not submit this invoice. Check the details and try again.",
    );
    expect(invoiceErrorCopy(null)).not.toContain("_");
  });

  it("never uses an em dash", () => {
    expect(invoiceErrorCopy("AMOUNT_MISMATCH")).not.toContain("—");
  });
});
