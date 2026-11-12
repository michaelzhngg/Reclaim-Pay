import { describe, it, expect } from "vitest";
import { claimSummary, closeAttempt } from "./submitDialogState";

describe("closeAttempt", () => {
  it("keeps the dialog open mid-check and shows the notice", () => expect(closeAttempt("checking")).toBe("notice"));
  it("closes on the result", () => expect(closeAttempt("result")).toBe("close"));
  it("closes on an error", () => expect(closeAttempt("error")).toBe("close"));
});

describe("claimSummary", () => {
  it("names a single receipt by merchant", () => expect(claimSummary(["LINTAS TEKSI BANDAR"])).toBe("LINTAS TEKSI BANDAR"));
  it("counts the other receipts", () => expect(claimSummary(["Grab", "Hotel", ""])).toBe("Grab and 2 more receipts"));
  it("falls back when no merchant was read", () => expect(claimSummary([""])).toBe("Receipt 1"));
  it("handles no receipts", () => expect(claimSummary([])).toBe("Your claim"));
});
