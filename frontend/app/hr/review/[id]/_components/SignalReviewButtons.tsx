"use client";

import { useId, useState } from "react";
import type { SignalCode, SignalReview, SignalVerdict } from "@/lib/api/reclaim-pay-types";
import { reviewSignal } from "@/lib/actions/signalReviews";

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";
const OPTIONS: [SignalVerdict, string][] = [["CONFIRMED", "Real problem"], ["FALSE_ALARM", "False alarm"]];

/**
 * Optional HR verdict on one signal. It never blocks approving or rejecting; the saved
 * labels only measure how accurate each check is.
 */
export function SignalReviewButtons({ reimId, code, documentId, initial, viewerId }: {
  reimId: string;
  code: SignalCode;
  documentId: string | null;
  initial: SignalReview | null;
  viewerId?: string | null;
}) {
  const labelId = useId();
  const [verdict, setVerdict] = useState<SignalVerdict | null>(initial?.verdict ?? null);
  const [reviewedBy, setReviewedBy] = useState<string | null>(initial?.reviewed_by ?? null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; error: boolean } | null>(null);

  // Buttons stay enabled while saving so keyboard focus isn't dropped; extra presses are ignored.
  const choose = async (v: SignalVerdict) => {
    if (busy || v === verdict) return;
    const before = verdict;
    setVerdict(v);
    setBusy(true);
    setNote(null);
    const res = await reviewSignal(reimId, code, documentId, v);
    setBusy(false);
    if (res.review) {
      setReviewedBy(res.review.reviewed_by);
      setNote({ text: "Saved", error: false });
    } else {
      setVerdict(before);
      setNote({ text: res.error ?? "Couldn't save. Try again.", error: true });
    }
  };

  const byOther = verdict && reviewedBy && viewerId && reviewedBy !== viewerId;

  return (
    <div className="mt-3">
      <div role="group" aria-labelledby={labelId} className="flex flex-wrap items-center gap-2">
        {/* Own line, so the two answers never split across rows in a narrow card. */}
        <span id={labelId} className="basis-full text-sm text-ink-muted">Was this check right?</span>
        {OPTIONS.map(([v, label]) => {
          const pressed = verdict === v;
          return (
            <button
              key={v}
              type="button"
              aria-pressed={pressed}
              aria-busy={busy && pressed}
              onClick={() => void choose(v)}
              className={`min-h-11 rounded-control border px-3 text-sm font-semibold cursor-pointer transition-colors ${FOCUS} ${
                pressed ? "border-ink bg-ink text-paper" : "border-outline bg-surface text-ink hover:bg-surface-muted"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>
      <p aria-live="polite" className={`text-sm empty:hidden mt-2 ${note?.error ? "text-danger" : "text-ink-muted"}`}>
        {note?.text ?? (byOther ? "Marked by another reviewer. Your answer replaces theirs." : "")}
      </p>
    </div>
  );
}
