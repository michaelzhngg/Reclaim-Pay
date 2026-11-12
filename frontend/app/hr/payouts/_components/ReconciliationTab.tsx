"use client";

import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  getReconciliationHistory,
  runReconciliation,
  type ReconciliationDifference,
} from "@/lib/actions/reconcile";
import { useTabData } from "@/lib/hooks/useTabData";
import ClaimLink from "@/components/hr-grid/ClaimLink";
import { TabEmpty, TabError, TabLoading } from "@/components/hr-grid/TabStates";
import { formatMoney } from "@/lib/format";
import { formatUpdated } from "@/components/hr-grid/ledger";
import {
  RECONCILIATION_TONE_CLASSES,
  differenceReason,
  differencesLine,
  isStale,
  pendingLine,
  runHeadline,
  runTone,
  stateLabel,
} from "@/components/hr-grid/reconciliation";

const LOAD_FAILED = "Couldn't load the reconciliation history. Check your connection and try again.";
const RUN_FAILED = "Couldn't run the check. The previous history is still shown.";

const fetchHistory = () => getReconciliationHistory(14);

function DifferenceRow({ difference }: { difference: ReconciliationDifference }) {
  return (
    <li className="rounded-control border border-line bg-surface px-3 py-3 text-sm">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <div className="min-w-0 break-words">
          {difference.reim_id ? (
            <ClaimLink reimId={difference.reim_id} />
          ) : (
            <span className="font-mono text-xs text-ink">{difference.transaction_id}</span>
          )}
          <span className="text-ink-muted">
            {" "}
            · {difference.employee_name ?? "Not set"} · {formatMoney(difference.currency, difference.amount)}
          </span>
        </div>
        <span className="shrink-0 text-xs text-ink-muted">
          First seen {formatUpdated(difference.first_seen_at)}
        </span>
      </div>
      <p className="mt-1 text-ink-muted">
        {difference.kind === "MISSING_IN_PAYPAL" ? "Sent" : "Posted"}{" "}
        {formatUpdated(difference.occurred_at)}: {differenceReason(difference.kind)}
      </p>
    </li>
  );
}

export default function ReconciliationTab({ onLoaded }: { onLoaded?: () => void }) {
  const { data, isLoading, error, retry, refresh } = useTabData(
    fetchHistory,
    LOAD_FAILED,
    onLoaded,
  );
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);

  const checkNow = async () => {
    setRunning(true);
    setRunError(null);
    try {
      await runReconciliation();
      refresh();
    } catch {
      setRunError(RUN_FAILED);
    } finally {
      setRunning(false);
    }
  };

  const checkButton = (
    <button
      type="button"
      onClick={checkNow}
      disabled={running}
      className="inline-flex min-h-[44px] shrink-0 items-center justify-center gap-1.5 rounded-control border border-current px-4 text-sm font-semibold hover:bg-surface/60 focus-visible:outline-2 focus-visible:outline-current focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-60 cursor-pointer"
    >
      <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} aria-hidden="true" />
      {running ? "Checking" : "Check now"}
    </button>
  );

  return (
    <>
      <p className="mb-4 max-w-3xl text-sm text-ink-muted">
        Each daily check compares our payouts with the company&apos;s PayPal ledger. A difference is
        for review only: it never blocks or reverses a payout.
      </p>

      {isLoading && <TabLoading label="Loading reconciliation history" />}
      {!isLoading && error && <TabError message={error} onRetry={retry} />}

      {!isLoading && !error && data && !data.latest && (
        <TabEmpty title="No reconciliation yet" action={checkButton}>
          The first daily check will appear here. You can run one now.
        </TabEmpty>
      )}

      {!isLoading && !error && data && data.latest && (
        <>
          {data.last_success_at && isStale(data.last_success_at) && (
            <div
              role="status"
              className="mb-4 rounded-control border border-warning/30 bg-warning-soft px-3 py-2 text-sm text-warning"
            >
              The daily check has not run since {formatUpdated(data.last_success_at)}. Check the
              schedule or run it now.
            </div>
          )}

          <section
            aria-labelledby="reconcile-latest"
            className={`mb-5 rounded-card border px-4 py-4 sm:px-5 ${RECONCILIATION_TONE_CLASSES[runTone(data.latest, data.open_differences)]}`}
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h2 id="reconcile-latest" className="font-display text-lg font-semibold">
                  {runHeadline(data.latest)}
                </h2>
                <p className="mt-1 text-sm">
                  Checked {formatUpdated(data.latest.started_at)}
                  {data.latest.mock && " (mock data)"}
                  {data.latest.data_through && ` · PayPal data through ${formatUpdated(data.latest.data_through)}`}
                </p>
                {pendingLine(data.latest) && <p className="mt-1 text-sm">{pendingLine(data.latest)}</p>}
                <p className="mt-1 text-sm">{differencesLine(data.open_differences)}</p>
              </div>
              {checkButton}
            </div>
          </section>

          {runError && (
            <div role="alert" className="mb-4 rounded-control border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger">
              {runError}
            </div>
          )}

          {data.open_differences.length > 0 && (
            <section aria-labelledby="reconcile-differences" className="mb-6">
              <h2 id="reconcile-differences" className="mb-2 font-display text-lg font-semibold text-ink">
                Open differences
              </h2>
              <ul className="flex flex-col gap-2">
                {data.open_differences.map((difference) => (
                  <DifferenceRow key={difference.difference_id} difference={difference} />
                ))}
              </ul>
            </section>
          )}

          <section aria-labelledby="reconcile-history">
            <h2 id="reconcile-history" className="mb-2 font-display text-lg font-semibold text-ink">
              Recent checks
            </h2>
            <ol className="rounded-card bg-surface px-4 shadow-ambient">
              {data.runs.map((run) => (
                <li
                  key={run.run_id}
                  className="flex flex-col gap-1 border-b border-line py-3 text-sm last:border-0 sm:flex-row sm:flex-wrap sm:items-baseline sm:justify-between sm:gap-2"
                >
                  <span className="font-mono text-xs text-ink-muted">{formatUpdated(run.started_at)}</span>
                  <span className="font-semibold text-ink">{stateLabel(run.state)}</span>
                  <span className="text-ink-muted">
                    {run.reconciled} of {run.total} reconciled
                    {run.pending > 0 && `, ${run.pending} waiting`}
                    {run.differences_new > 0 && `, ${run.differences_new} new`}
                    {run.mock && ", mock"}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </>
  );
}
