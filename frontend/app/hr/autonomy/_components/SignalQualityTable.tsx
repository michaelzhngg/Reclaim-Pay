"use client";

import { useEffect, useState } from "react";
import { AlertCircle } from "lucide-react";
import type { SignalQuality } from "@/lib/api/reclaim-pay-types";
import { getSignalQuality } from "@/lib/actions/signalReviews";
import { signalLabel } from "@/lib/hr/evidence";
import { precisionLabel } from "@/lib/hr/signalQuality";

const DAYS = 90;
const NUM = "font-mono tabular-nums text-ink";
type CountKey = "fired" | "confirmed" | "false_alarm" | "unreviewed" | "approved_in_full";
const COUNTS: [CountKey, string][] = [
  ["fired", "Times flagged"],
  ["confirmed", "Real problem"],
  ["false_alarm", "False alarm"],
  ["unreviewed", "Not rated"],
  ["approved_in_full", "Approved in full"],
];

/** Per-check accuracy from HR's verdicts: the labels R1 calibration will tune check points with. */
export default function SignalQualityTable() {
  const [rows, setRows] = useState<SignalQuality[] | null | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let live = true;
    getSignalQuality(DAYS)
      .then((r) => { if (live) setRows(r); })
      .catch(() => { if (live) setRows(null); });
    return () => { live = false; };
  }, [attempt]);

  return (
    <section aria-labelledby="quality-title" className="rounded-card shadow-ambient bg-surface px-4 py-5 sm:px-5">
      <h3 id="quality-title" className="font-display font-semibold text-base text-ink">How accurate are the checks</h3>
      <p className="mt-1 max-w-prose text-sm text-ink-muted">
        Counted from the &ldquo;Real problem&rdquo; and &ldquo;False alarm&rdquo; answers HR gave on claims from the last {`${DAYS} days`}.
        Accuracy is the share of answers that were a real problem, shown once a check has 10 answers.
        &ldquo;Approved in full&rdquo; counts flagged claims that HR approved for the whole amount claimed, a hint
        that it may have been wrong.
      </p>

      <div className="mt-4">
        {rows === undefined && <p role="status" className="text-sm text-ink-muted">Loading check accuracy&hellip;</p>}

        {rows === null && (
          <p role="alert" className="flex flex-wrap items-center gap-2 text-sm text-ink">
            <AlertCircle className="w-4 h-4 text-danger" aria-hidden="true" />
            Couldn&apos;t load check accuracy.
            <button
              type="button"
              onClick={() => { setRows(undefined); setAttempt((n) => n + 1); }}
              className="min-h-[44px] px-2 font-semibold text-ink underline underline-offset-2 rounded-control focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
            >
              Try again
            </button>
          </p>
        )}

        {rows && rows.length === 0 && (
          <div className="rounded-card bg-surface-muted px-4 py-6 text-sm">
            <p className="font-semibold text-ink">No checks flagged a claim in the last {`${DAYS} days`}</p>
            <p className="mt-1 text-ink-muted">
              When Receipt Shield flags a claim, mark each finding on the review page and the results show up here.
            </p>
          </div>
        )}

        {rows && rows.length > 0 && (
          <>
            {/* Phones: one block per check, so seven columns never need a sideways scroll. */}
            <ul className="sm:hidden divide-y divide-line border-y border-line">
              {rows.map((q) => (
                <li key={q.code} className="py-3">
                  <div className="flex items-baseline justify-between gap-3">
                    <p className="min-w-0 text-sm font-semibold text-ink">{signalLabel(q.code)}</p>
                    <p className="shrink-0 text-sm font-semibold text-ink">{precisionLabel(q)}</p>
                  </div>
                  <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
                    {COUNTS.map(([key, label]) => (
                      <div key={key} className="flex items-baseline justify-between gap-2">
                        <dt className="text-ink-muted">{label}</dt>
                        <dd className={NUM}>{q[key]}</dd>
                      </div>
                    ))}
                  </dl>
                </li>
              ))}
            </ul>

            <div className="hidden sm:block overflow-x-auto">
              <table className="w-full text-sm">
                <caption className="sr-only">Accuracy per check, last {`${DAYS} days`}</caption>
                <thead>
                  <tr className="border-b border-line text-left text-ink-muted">
                    <th scope="col" className="py-2 pr-3 font-medium">Check</th>
                    {COUNTS.map(([key, label]) => (
                      <th key={key} scope="col" className="py-2 px-3 font-medium text-right">{label}</th>
                    ))}
                    <th scope="col" className="py-2 pl-3 font-medium text-right">Accuracy</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {rows.map((q) => (
                    <tr key={q.code}>
                      <th scope="row" className="py-2 pr-3 text-left font-medium text-ink">{signalLabel(q.code)}</th>
                      {COUNTS.map(([key]) => (
                        <td key={key} className={`py-2 px-3 text-right ${NUM}`}>{q[key]}</td>
                      ))}
                      <td className="py-2 pl-3 text-right font-semibold text-ink whitespace-nowrap">{precisionLabel(q)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
