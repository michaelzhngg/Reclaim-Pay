"use client";

import { useCallback, useEffect, useState } from "react";
import { RefreshCw, Wallet } from "lucide-react";
import { getFunding } from "@/lib/actions/paypal";
import { formatUpdated } from "@/components/hr-grid/ledger";
import {
  FUNDING_REQUEST_FAILED,
  FUNDING_TONE_CLASSES,
  fundingView,
  type FundingSummary,
} from "@/components/hr-grid/funding";

const CARD = "mb-6 rounded-card bg-surface p-5 shadow-ambient sm:p-6";
// Side by side only from xl: beside the HR sidebar, lg leaves the balance too little room.
const ROW = "flex flex-col gap-5 xl:flex-row xl:items-start xl:justify-between";
const LEFT = "min-w-0 xl:flex-1";
const STATS = "grid grid-cols-1 gap-2 sm:grid-cols-3 xl:w-[480px] xl:shrink-0";

// The check can wait on PayPal for seconds, and server actions run one at a time. Revisits and tab
// switches within a minute reuse the last answer; "Check again" always asks PayPal.
const CACHE_TTL_MS = 60_000;
let cache: { summary: FundingSummary; ts: number } | null = null;

function cached(): FundingSummary | null {
  return cache && Date.now() - cache.ts < CACHE_TTL_MS ? cache.summary : null;
}

function Skeleton() {
  return (
    <section role="status" className={CARD}>
      <span className="sr-only">Checking the PayPal balance</span>
      <div aria-hidden="true" className={ROW}>
        <div className={LEFT}>
          <div className="flex items-center gap-2">
            <span className="h-8 w-8 rounded-[10px] bg-surface-muted" />
            <span className="h-4 w-28 rounded bg-surface-muted" />
          </div>
          <div className="mt-3 h-[28px] w-48 max-w-full rounded-lg bg-surface-muted md:h-[34px]" />
          <div className="mt-3 h-10 w-full max-w-md rounded-control bg-surface-muted" />
          <div className="mt-2 h-4 w-44 max-w-full rounded bg-surface-muted" />
        </div>
        <div className={STATS}>
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-[62px] rounded-control bg-surface-muted" />
          ))}
        </div>
      </div>
    </section>
  );
}

/**
 * PayPal balance against the recent payout rate. An alert only: nothing here pays or holds a claim.
 * `start` holds the check back until the open tab has loaded its own data.
 */
export default function FundingCard({ start }: { start: boolean }) {
  const [summary, setSummary] = useState<FundingSummary | null>(cached);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    () =>
      getFunding()
        .then((data) => {
          cache = { summary: data, ts: Date.now() };
          setSummary(data);
          setFailed(false);
        })
        .catch(() => setFailed(true)),
    [],
  );

  useEffect(() => {
    if (start && !cached()) void load();
  }, [start, load]);

  if (!summary && !failed) return <Skeleton />;

  const view = summary && !failed ? fundingView(summary) : null;
  const tone = FUNDING_TONE_CLASSES[view?.tone ?? "neutral"];
  const notChecked = !view?.figure;
  const retry = () => {
    setSummary(null);
    setFailed(false);
    void load();
  };

  return (
    <section aria-labelledby="funding-title" className={CARD}>
      <div className={ROW}>
        <div className={LEFT}>
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-paypal-blue/10 text-paypal">
              <Wallet className="h-4 w-4" strokeWidth={2} aria-hidden="true" />
            </span>
            <h2 id="funding-title" className="font-body text-[13px] font-medium text-ink-muted">
              PayPal balance{summary?.mock && !failed ? " (mock)" : ""}
            </h2>
            {view?.label && (
              <span className={`rounded-full px-2.5 py-0.5 text-[12px] font-semibold ${tone.pill}`}>{view.label}</span>
            )}
          </div>

          {view?.figure ? (
            <p className="mt-3 whitespace-nowrap font-display text-[24px] sm:text-[28px] font-semibold leading-none tracking-[-0.03em] text-ink tabular-nums md:text-[34px]">
              {view.figure}
            </p>
          ) : (
            <p className="mt-3 font-display text-xl font-semibold leading-[28px] text-ink-muted md:leading-[34px]">
              Balance not checked
            </p>
          )}

          <p role="status" className={`mt-3 text-sm leading-relaxed ${tone.alert}`}>
            {view?.alert ?? FUNDING_REQUEST_FAILED}
          </p>

          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-muted">
            {summary?.as_of && !failed && <span>PayPal figure as of {formatUpdated(summary.as_of)}</span>}
            {notChecked && (
              <button
                type="button"
                onClick={retry}
                className="inline-flex min-h-[44px] items-center gap-1.5 font-semibold text-ink hover:text-paypal-blue cursor-pointer focus-visible:outline-2 focus-visible:outline-secondary focus-visible:outline-offset-2"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                Check again
              </button>
            )}
          </div>
        </div>

        {view && (
          <dl className={STATS}>
            {view.stats.map((s) => (
              <div key={s.label} className="min-w-0 rounded-control bg-surface-muted px-3 py-2.5">
                <dt className="text-xs text-ink-muted">{s.label}</dt>
                <dd className="mt-1 whitespace-nowrap text-sm font-semibold text-ink tabular-nums">{s.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </section>
  );
}
