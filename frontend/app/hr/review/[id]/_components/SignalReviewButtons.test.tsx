import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SignalReview } from "@/lib/api/reclaim-pay-types";

vi.mock("@/lib/actions/signalReviews", () => ({ reviewSignal: vi.fn() }));
const { SignalReviewButtons } = await import("./SignalReviewButtons");

const review = (reviewed_by: string): SignalReview => ({
  signal_code: "NO_CAMERA_METADATA", document_id: "d1", verdict: "FALSE_ALARM", reviewed_by, updated_at: "2026-11-12T00:00:00Z",
});

const render = (initial: SignalReview | null, viewerId = "hr-1") =>
  renderToStaticMarkup(
    <SignalReviewButtons reimId="r1" code="NO_CAMERA_METADATA" documentId="d1" initial={initial} viewerId={viewerId} />,
  );

describe("SignalReviewButtons", () => {
  it("starts with neither answer pressed", () => {
    const html = render(null);
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).toContain("Real problem");
    expect(html).toContain("False alarm");
  });

  it("presses the saved answer and keeps 44px targets", () => {
    const html = render(review("hr-1"));
    expect(html).toMatch(/aria-pressed="true"[^>]*>False alarm</);
    expect(html.match(/min-h-11/g)).toHaveLength(2);
    expect(html).not.toContain("another reviewer");
  });

  it("says when another reviewer gave the saved answer", () => {
    expect(render(review("hr-2"))).toContain("Marked by another reviewer. Your answer replaces theirs.");
  });
});
