"use client";

import { useCallback, useEffect, useState } from "react";
import { getReconciliation, type ReconcileSummary } from "@/lib/actions/reconcile";
import { formatMoney } from "@/lib/format";
import { TONE_CLASSES, formatUpdated, type StatusTone } from "./ledger";

const FAILED_REQUEST = "Couldn't check payouts against PayPal.";

function periodLabel(days: number): string {
  return days === 1 ? "last 24 hours" : `last ${days} days`;
}

function toneFor(s: ReconcileSummary): StatusTone {
  if (s.state === "unavailable") return "progress";
  if (s.state === "no_data") return "neutral";
  if (s.mismatches.length > 0 || s.unknown_in_paypal.length > 0) return "danger";
  return s.pending > 0 ? "progress" : "success";
}

function Differences({ summary }: { summary: ReconcileSummary }) {
  const { mismatches, unknown_in_paypal: unknown } = summary;
  const count = mismatches.length + unknown.length;
  if (count === 0) return null;
  return (
    <details className="mt-1">
      <summary className="inline-flex items-center min-h-[44px] font-semibold cursor-pointer focus-visible:outline-2 focus-visible:outline-current">
        Show {count === 1 ? "1 difference" : `${count} differences`}
      </summary>
      <ul className="flex flex-col gap-2 pb-1 text-ink">
        {mismatches.map((m) => (
          <li key={m.payout_id} className="break-words">
            <span className="font-mono font-medium">{m.claim_ref}</span> · {m.employee_name} ·{" "}
            {formatMoney(m.currency, m.amount)} · sent {formatUpdated(m.created_at)}: not found in PayPal
          </li>
        ))}
        {unknown.map((u) => (
          <li key={u.transaction_id} className="break-words">
            <span className="font-mono font-medium">{u.transaction_id}</span> · {formatMoney(u.currency, u.amount)} ·{" "}
            {formatUpdated(u.occurred_at)}: in PayPal with no matching payout
          </li>
        ))}
      </ul>
    </details>
  );
}

export default function ReconcileBadge() {
  const [summary, setSummary] = useState<ReconcileSummary | null>(null);
  const [failed, setFailed] = useState(false);

  const load = useCallback(
    () =>
      getReconciliation()
        .then((data) => {
          setSummary(data);
          setFailed(false);
        })
        .catch(() => setFailed(true)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const retry = () => {
    setSummary(null);
    setFailed(false);
    void load();
  };

  if (!summary && !failed) {
    return (
      <div role="status" className="mb-4 h-[44px] w-56 max-w-full rounded-lg bg-surface-muted animate-pulse">
        <span className="sr-only">Checking payouts against PayPal</span>
      </div>
    );
  }

  const unavailable = failed || summary?.state === "unavailable";
  const tone = !summary || failed ? "progress" : toneFor(summary);

  return (
    <div
      aria-live="polite"
      className={`mb-4 max-w-3xl rounded-lg border px-3 py-2 text-sm ${TONE_CLASSES[tone]}`}
    >
      {summary?.state === "ok" && !failed ? (
        <>
          <p>
            <span className="font-semibold">
              Reconciled {summary.reconciled} of {summary.total}
            </span>
            , {periodLabel(summary.days)}
            {summary.mock && " (mock data)"}
          </p>
          {summary.pending > 0 && (
            <p className="mt-1">
              {summary.pending} waiting on PayPal, which can take up to 3 hours to list a payout.
            </p>
          )}
          <Differences summary={summary} />
        </>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <p>{(!failed && summary?.message) || FAILED_REQUEST}</p>
          {unavailable && (
            <button
              type="button"
              onClick={retry}
              className="min-h-[44px] shrink-0 rounded-lg border border-current px-4 font-semibold cursor-pointer focus-visible:outline-2 focus-visible:outline-current"
            >
              Check again
            </button>
          )}
        </div>
      )}
    </div>
  );
}
