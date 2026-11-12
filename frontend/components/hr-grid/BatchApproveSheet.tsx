"use client";

import { useEffect, useRef } from "react";
import { AlertCircle, Loader2, X } from "lucide-react";
import { formatMoney, type BatchApproveResult } from "@/lib/api/reclaim-pay-types";
import {
  SKIP_REASON_LABEL,
  approveButtonLabel,
  batchResultMessage,
  exclusionReason,
  exclusionSummary,
  formatTotal,
  type TriageRow,
} from "./rows";

interface BatchApproveSheetProps {
  open: boolean;
  /** Rows HR ticked. */
  selected: TriageRow[];
  /** Every row in the Quick tab, so the sheet can list what is held back and why. */
  tabRows: TriageRow[];
  selfId: string | null;
  submitting: boolean;
  error: string | null;
  /** Set after the backend answers with skipped claims, so HR sees exactly which ones. */
  result: BatchApproveResult | null;
  refFor: (reimId: string) => string;
  onConfirm: () => void;
  onClose: () => void;
}

/**
 * Confirmation before a batch approval. A bottom sheet on phones, a centered
 * dialog from sm up. Native <dialog> gives Escape, focus containment and an inert page.
 */
export default function BatchApproveSheet({
  open,
  selected,
  tabRows,
  selfId,
  submitting,
  error,
  result,
  refFor,
  onConfirm,
  onClose,
}: BatchApproveSheetProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  const excluded = tabRows
    .map((row) => ({ row, reason: exclusionReason(row, selfId) }))
    .filter((x): x is { row: TriageRow; reason: NonNullable<typeof x.reason> } => x.reason !== null);
  const summary = exclusionSummary(tabRows, selfId);

  return (
    <dialog
      ref={ref}
      aria-labelledby="batch-approve-title"
      onCancel={(e) => {
        // Escape is ignored while the request is in flight so the result isn't lost.
        if (submitting) e.preventDefault();
        else onClose();
      }}
      className="m-0 mt-auto w-full max-w-none max-h-[85dvh] rounded-t-dialog p-0 bg-surface text-ink backdrop:bg-ink/40 sm:m-auto sm:max-w-lg sm:rounded-dialog"
    >
      <div className="flex flex-col max-h-[85dvh]">
        <header className="flex items-start justify-between gap-4 px-5 pt-5 pb-3 border-b border-line">
          <div>
            <h2 id="batch-approve-title" className="font-display font-semibold text-lg">
              {result ? "Batch approval finished" : approveButtonLabel(selected)}
            </h2>
            {!result && (
              <p className="text-sm text-ink-muted mt-1">
                Each claim is approved and its PayPal payout starts right away.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label="Close"
            className="inline-flex items-center justify-center w-11 h-11 -mr-2 -mt-2 rounded-lg text-ink-muted hover:bg-surface-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto px-5 py-4 text-sm">
          {result ? (
            <>
              <p className="font-semibold">{batchResultMessage(result)}</p>
              {result.skipped.length > 0 && (
                <>
                  <p className="text-ink-muted mt-3">
                    These changed since the page loaded, so they were left for you to open one by one:
                  </p>
                  <ul className="mt-2 divide-y divide-line">
                    {result.skipped.map((s) => (
                      <li key={s.reim_id} className="flex items-center justify-between gap-3 py-2">
                        <span className="font-mono text-xs">{refFor(s.reim_id)}</span>
                        <span className="text-ink-muted">{SKIP_REASON_LABEL[s.reason]}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </>
          ) : (
            <>
              <ul className="divide-y divide-line" aria-label="Claims to approve">
                {selected.map((row) => (
                  <li key={row.reimId} className="flex items-center justify-between gap-3 py-2">
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{row.employee}</span>
                      <span className="block font-mono text-xs text-ink-muted">{row.ref}</span>
                    </span>
                    <span className="font-mono font-medium shrink-0">{formatMoney(row.currency, row.amount)}</span>
                  </li>
                ))}
              </ul>
              <p className="flex items-center justify-between gap-3 pt-3 mt-1 border-t border-line font-semibold">
                <span>Total</span>
                <span className="font-mono">{formatTotal(selected)}</span>
              </p>

              {summary && (
                <section className="mt-5 rounded-lg bg-surface-muted px-4 py-3" aria-labelledby="batch-excluded">
                  <h3 id="batch-excluded" className="font-semibold">
                    {summary}
                  </h3>
                  <ul className="mt-2 flex flex-col gap-1.5 text-ink-muted">
                    {excluded.map(({ row, reason }) => (
                      <li key={row.reimId} className="flex items-center justify-between gap-3">
                        <span className="min-w-0 truncate">
                          <span className="font-mono text-xs">{row.ref}</span> · {row.employee}
                        </span>
                        <span className="shrink-0">{SKIP_REASON_LABEL[reason]}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {error && (
                <p role="alert" className="mt-4 flex items-start gap-2 rounded-lg border border-danger/30 bg-danger-soft px-3 py-2.5 text-danger">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  {error}
                </p>
              )}
            </>
          )}
        </div>

        <footer className="flex flex-col-reverse gap-2 px-5 py-4 border-t border-line pb-[calc(1rem+env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:pb-4">
          {result ? (
            <button
              type="button"
              onClick={onClose}
              className="min-h-[44px] px-5 rounded-lg bg-accent text-on-accent font-semibold hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 cursor-pointer"
            >
              Done
            </button>
          ) : (
            <>
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="min-h-[44px] px-5 rounded-lg border border-line font-semibold text-ink hover:bg-surface-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 cursor-pointer"
              >
                Keep reviewing
              </button>
              <button
                type="button"
                onClick={onConfirm}
                disabled={submitting || selected.length === 0}
                autoFocus
                className="inline-flex items-center justify-center gap-2 min-h-[44px] px-5 rounded-lg bg-accent text-on-accent font-semibold hover:bg-accent-hover disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 cursor-pointer"
              >
                {submitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {submitting ? "Approving…" : `Approve and pay ${selected.length}`}
              </button>
            </>
          )}
        </footer>
      </div>
    </dialog>
  );
}
