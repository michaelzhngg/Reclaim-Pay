import type { RiskSignal, SignalQuality, SignalReview } from "@/lib/api/reclaim-pay-types";

/** HR's saved verdict on this exact signal: same check, same document (or both claim-level). */
export function reviewFor(reviews: SignalReview[], signal: RiskSignal): SignalReview | null {
  return reviews.find(
    (r) => r.signal_code === signal.code && (r.document_id ?? null) === (signal.document_id ?? null),
  ) ?? null;
}

export function precisionLabel(q: SignalQuality): string {
  return q.precision === null ? "Not enough reviews" : `${Math.round(q.precision * 100)}% real`;
}

/** No buttons on your own claim. Unknown IDs still show them, because the server refuses a self-review anyway. */
export function canRateSignals(claimantId: string | null | undefined, viewerId: string | null | undefined): boolean {
  return !claimantId || !viewerId || claimantId !== viewerId;
}

/** The PUT answers SELF_REVIEW with a bare code; anything else is worth a retry. */
export function reviewSaveError(error: string): string {
  return error === "SELF_REVIEW" ? "You can't rate checks on your own claim." : "Couldn't save. Try again.";
}
