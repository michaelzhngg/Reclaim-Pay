"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useState } from "react";
import { getLedger } from "@/lib/actions/paypal";
import type { PayoutLedgerRow, PayoutStatus } from "@/lib/api/reclaim-pay-types";
import ReconcileBadge from "@/components/hr-grid/ReconcileBadge";
import { TabEmpty, TabError, TabLoading } from "@/components/hr-grid/TabStates";
import {
  STATUS_META,
  filterByStatus,
  hasInFlight,
  sortByUpdatedDesc,
  summarize,
  type StatusFilter,
} from "@/components/hr-grid/ledger";

const LedgerGrid = dynamic(() => import("@/components/hr-grid/LedgerGrid"), {
  ssr: false,
  loading: () => <TabLoading label="Loading payouts" />,
});

const POLL_MS = 5000;

const STATUS_OPTIONS = Object.keys(STATUS_META) as PayoutStatus[];

export default function LedgerTab({ onLoaded }: { onLoaded?: () => void }) {
  const [rows, setRows] = useState<PayoutLedgerRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [ledgerLoaded, setLedgerLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<StatusFilter>("ALL");

  const load = useCallback(
    () =>
      getLedger()
        .then((data) => {
          setRows(sortByUpdatedDesc(data));
          setError(null);
        })
        .catch(() => setError("Couldn't load payouts. Check your connection and try again."))
        .finally(() => {
          setIsLoading(false);
          setLedgerLoaded(true);
        }),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (ledgerLoaded) onLoaded?.();
  }, [ledgerLoaded, onLoaded]);

  const inFlight = hasInFlight(rows);

  // Poll only while PayPal is still processing something; stop once everything settles.
  useEffect(() => {
    if (!inFlight) return;
    const id = setInterval(load, POLL_MS);
    return () => clearInterval(id);
  }, [inFlight, load]);

  const visible = useMemo(() => filterByStatus(rows, status), [rows, status]);
  const counts = useMemo(() => summarize(rows), [rows]);

  const retry = () => {
    setIsLoading(true);
    load();
  };

  return (
    <>
      <ReconcileBadge start={ledgerLoaded} />
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between mb-4">
        <p className="text-sm text-ink-muted" aria-live="polite">
          {isLoading ? (
            "Loading payouts…"
          ) : (
            <>
              <span className="font-mono font-medium text-ink">{counts.total}</span>{" "}
              {counts.total === 1 ? "payout" : "payouts"}
              {counts.inFlight > 0 && (
                <>
                  {", "}
                  <span className="font-semibold text-warning">{counts.inFlight} processing</span>
                </>
              )}
              {counts.failed > 0 && (
                <>
                  {", "}
                  <span className="font-semibold text-danger">{counts.failed} failed or reversed</span>
                </>
              )}
            </>
          )}
        </p>

        <label className="flex items-center gap-2 text-sm text-ink-muted">
          Status
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as StatusFilter)}
            className="min-h-[44px] bg-surface border border-line rounded-control px-3 text-sm font-medium text-ink focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
          >
            <option value="ALL">All statuses</option>
            {STATUS_OPTIONS.map((s) => (
              <option key={s} value={s}>
                {STATUS_META[s].label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {isLoading && <TabLoading label="Loading payouts" />}

      {!isLoading && error && <TabError message={error} onRetry={retry} />}

      {!isLoading && !error && visible.length === 0 && (
        <TabEmpty title={rows.length === 0 ? "No payouts yet" : "No payouts with this status"}>
          {rows.length === 0
            ? "Payouts appear here once an approved claim is sent to PayPal."
            : "Choose a different status to see other payouts."}
        </TabEmpty>
      )}

      {!isLoading && !error && visible.length > 0 && <LedgerGrid rows={visible} />}
    </>
  );
}
