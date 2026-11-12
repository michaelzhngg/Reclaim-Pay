"use server";

// HR verdicts on Receipt Shield signals (R1a). Employees never call these.

import { apiGet, apiPut, API_PREFIX } from "@/lib/api/client";
import { FIXTURES_ON, withFixture } from "@/lib/api/fixtures";
import type { SignalCode, SignalQuality, SignalReview, SignalVerdict } from "@/lib/api/reclaim-pay-types";
import { reviewSaveError } from "@/lib/hr/signalQuality";

export async function getSignalReviews(reimId: string): Promise<SignalReview[]> {
  return withFixture<SignalReview[]>([], async () => {
    const res = await apiGet<SignalReview[]>(`${API_PREFIX}/reimbursements/${reimId}/signal-reviews`);
    return res.data ?? [];
  });
}

export async function reviewSignal(
  reimId: string, code: SignalCode, documentId: string | null, verdict: SignalVerdict,
): Promise<{ review: SignalReview | null; error: string | null }> {
  if (FIXTURES_ON) {
    const review = { signal_code: code, document_id: documentId, verdict, reviewed_by: "fixture-hr", updated_at: new Date().toISOString() };
    return { review, error: null };
  }
  const res = await apiPut<SignalReview>(`${API_PREFIX}/reimbursements/${reimId}/signal-reviews`, {
    signal_code: code, document_id: documentId, verdict,
  });
  if (res.data) return { review: res.data, error: null };
  return { review: null, error: reviewSaveError(res.error ?? "") };
}

/** null when the report couldn't be loaded, so the table can say so instead of showing an empty list. */
export async function getSignalQuality(days = 90): Promise<SignalQuality[] | null> {
  return withFixture<SignalQuality[] | null>([], async () => {
    const res = await apiGet<SignalQuality[]>(`${API_PREFIX}/autonomy/signal-quality?days=${days}`);
    return res.error ? null : res.data;
  });
}
