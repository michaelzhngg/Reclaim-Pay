import { describe, expect, it } from "vitest";
import type { RiskSignal, SignalQuality, SignalReview } from "@/lib/api/reclaim-pay-types";
import { canRateSignals, precisionLabel, reviewFor, reviewSaveError } from "./signalQuality";

const sig = (document_id: string | null): RiskSignal => ({
  code: "NO_CAMERA_METADATA", severity: "LOW", points: 5, message: "", evidence: {}, document_id,
});
const rev = (document_id: string | null, verdict: SignalReview["verdict"]): SignalReview => ({
  signal_code: "NO_CAMERA_METADATA", document_id, verdict, reviewed_by: "hr", updated_at: "2026-11-12T00:00:00Z",
});

describe("reviewFor", () => {
  it("matches code and document", () => {
    expect(reviewFor([rev("d1", "FALSE_ALARM")], sig("d1"))?.verdict).toBe("FALSE_ALARM");
    expect(reviewFor([rev("d2", "FALSE_ALARM")], sig("d1"))).toBeNull();
    expect(reviewFor([rev(null, "CONFIRMED")], sig(null))?.verdict).toBe("CONFIRMED");
  });

  it("does not let a claim-level review stand in for a document's signal", () => {
    expect(reviewFor([rev(null, "CONFIRMED")], sig("d1"))).toBeNull();
  });

  it("ignores reviews of other checks", () => {
    expect(reviewFor([{ ...rev("d1", "CONFIRMED"), signal_code: "SPLIT_CLAIM" }], sig("d1"))).toBeNull();
  });
});

describe("precisionLabel", () => {
  const q: SignalQuality = {
    code: "SPLIT_CLAIM", fired: 12, confirmed: 8, false_alarm: 2, unreviewed: 2, approved_in_full: 1, rejected: 3, precision: 0.8,
  };
  it("shows a percentage once there are enough reviews", () => expect(precisionLabel(q)).toBe("80% real"));
  it("says when there aren't", () => expect(precisionLabel({ ...q, precision: null })).toBe("Not enough reviews"));
});

describe("reviewSaveError", () => {
  it("explains a self-review", () => expect(reviewSaveError("SELF_REVIEW")).toBe("You can't rate checks on your own claim."));
  it("falls back to a retry message", () => expect(reviewSaveError("500: Internal Server Error")).toBe("Couldn't save. Try again."));
});

describe("canRateSignals", () => {
  it("hides the buttons on the viewer's own claim", () => expect(canRateSignals("hr-1", "hr-1")).toBe(false));
  it("shows them on someone else's claim", () => expect(canRateSignals("emp-1", "hr-1")).toBe(true));
  it("shows them when either side is unknown; the server still refuses a self-review", () => {
    expect(canRateSignals(undefined, "hr-1")).toBe(true);
    expect(canRateSignals("emp-1", null)).toBe(true);
  });
});
