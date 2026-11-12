"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import dynamic from "next/dynamic";
import { AlertCircle, Inbox, RefreshCw } from "lucide-react";
import { batchApprove } from "@/lib/actions/autonomy";
import { FIXTURES_ON } from "@/lib/api/fixtures";
import { formatClaimRef } from "@/lib/format";
import type { BatchApproveResult } from "@/lib/api/reclaim-pay-types";
import { useToast } from "@/components/toast/ToastProvider";
import BatchApproveSheet from "./BatchApproveSheet";
import {
  TIER_LABEL,
  TIER_TABS,
  approveButtonLabel,
  batchResultMessage,
  isBatchSelectable,
  rowsForTab,
  tierTabs,
  type TierTab,
  type TriageRow,
} from "./rows";

interface TriageQueueProps {
  rows: TriageRow[];
  isLoading: boolean;
  error: string | null;
  selfId: string | null;
  onRetry: () => void;
  /** Called after a batch approval so the page can drop the approved rows and refetch. */
  onApproved: (approvedIds: string[]) => void;
}

const TAB_HINT: Partial<Record<TierTab, string>> = {
  AUTO_PAY: "Paid automatically in the last 24 hours because every fixed rule passed. Open one to see why it qualified.",
  HR_QUICK: "Low-risk claims a hard stop held back from auto-pay. Check and approve them together.",
  DUAL_REVIEW: "High-risk claims. Two different HR members must approve each one.",
};

function emptyCopy(tab: TierTab): string {
  if (tab === "all") return "Nothing needs you right now.";
  if (tab === "AUTO_PAY") return "No claims were paid automatically in the last 24 hours.";
  return `No claims are waiting for ${TIER_LABEL[tab].toLowerCase()}.`;
}

function QueueSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[...Array(5)].map((_, i) => (
        <div key={i} className="h-[52px] rounded-control bg-surface-muted animate-pulse" />
      ))}
    </div>
  );
}

const loadTriageGrid = () => import("./TriageGrid");

// AG Grid is most of this page's JavaScript, so it loads after the shell and tabs are on screen.
const TriageGrid = dynamic(loadTriageGrid, { ssr: false, loading: () => <QueueSkeleton /> });

export default function TriageQueue({ rows, isLoading, error, selfId, onRetry, onApproved }: TriageQueueProps) {
  const { toast } = useToast();
  const [tab, setTab] = useState<TierTab>("all");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sheetOpen, setSheetOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [result, setResult] = useState<BatchApproveResult | null>(null);
  const tabRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  // Start the grid download while the claims are still loading.
  useEffect(() => {
    void loadTriageGrid();
  }, []);

  const counts = useMemo(() => tierTabs(rows), [rows]);
  const visible = useMemo(() => rowsForTab(rows, tab), [rows, tab]);
  const isQuick = tab === "HR_QUICK";

  // Ticked rows that are still eligible. A row that changed tier on refetch drops out here.
  const selectedRows = useMemo(
    () => visible.filter((r) => selected.has(r.reimId) && isBatchSelectable(r, selfId)),
    [visible, selected, selfId],
  );

  // Skipped claims stay in `rows`, so their refs are always here.
  const refById = useMemo(() => new Map(rows.map((r) => [r.reimId, r.ref])), [rows]);
  const refFor = useCallback((id: string) => refById.get(id) ?? formatClaimRef(id), [refById]);

  const chooseTab = (next: TierTab) => {
    setTab(next);
    // Opening the Quick tab ticks every eligible claim, so the common case is one click.
    setSelected(next === "HR_QUICK" ? new Set(rowsForTab(rows, next).filter((r) => isBatchSelectable(r, selfId)).map((r) => r.reimId)) : new Set());
  };

  // Arrow keys move between tabs (WAI-ARIA tabs pattern).
  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const nextIndex =
      e.key === "Home" ? 0 : e.key === "End" ? TIER_TABS.length - 1 : (index + step + TIER_TABS.length) % TIER_TABS.length;
    const next = TIER_TABS[nextIndex].id;
    chooseTab(next);
    tabRefs.current[next]?.focus();
  };

  const openSheet = () => {
    setSubmitError(null);
    setResult(null);
    setSheetOpen(true);
  };

  const closeSheet = () => {
    setSheetOpen(false);
    setResult(null);
  };

  const confirm = async () => {
    setSubmitting(true);
    setSubmitError(null);
    const { result: res, error: err } = await batchApprove(selectedRows.map((r) => r.reimId));
    setSubmitting(false);
    if (!res) {
      setSubmitError(err ? `Couldn't approve these claims: ${err}` : "Couldn't approve these claims. Try again.");
      return;
    }
    toast({ tone: res.skipped.length ? "info" : "success", title: batchResultMessage(res) });
    setSelected(new Set());
    onApproved(res.approved);
    // Keep the sheet open on skips so HR sees which claims and why.
    if (res.skipped.length) setResult(res);
    else setSheetOpen(false);
  };

  return (
    <section aria-labelledby="triage-heading">
      <h3 id="triage-heading" className="sr-only">
        Claims by tier
      </h3>

      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between border-b border-line mb-4">
        <div role="tablist" aria-label="Claims by tier" className="flex flex-wrap gap-1 -mx-4 px-4 sm:mx-0 sm:px-0">
          {TIER_TABS.map(({ id, label }, i) => {
            const active = tab === id;
            return (
              <button
                key={id}
                ref={(el) => {
                  tabRefs.current[id] = el;
                }}
                role="tab"
                id={`triage-tab-${id}`}
                aria-selected={active}
                aria-controls="triage-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => chooseTab(id)}
                onKeyDown={(e) => onTabKeyDown(e, i)}
                className={`shrink-0 inline-flex items-center gap-2 min-h-[44px] px-3 -mb-px border-b-2 font-body text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px] cursor-pointer ${
                  active
                    ? "border-ink font-semibold text-ink"
                    : "border-transparent text-ink-muted hover:text-ink hover:border-line-strong"
                }`}
              >
                {label}
                <span
                  className={`min-w-[1.5rem] px-1.5 py-0.5 rounded-control text-center text-xs font-mono font-medium ${
                    active ? "bg-ink text-paper" : "bg-surface-muted text-ink-muted"
                  }`}
                >
                  {isLoading ? "…" : counts[id]}
                </span>
              </button>
            );
          })}
        </div>

        {isQuick && !isLoading && !error && (
          <div className="pb-3">
            <button
              type="button"
              onClick={openSheet}
              disabled={selectedRows.length === 0}
              className="w-full lg:w-auto min-h-[44px] px-4 rounded-full bg-accent text-on-accent text-sm font-semibold tabular-nums hover:bg-accent-hover disabled:bg-line disabled:text-ink-muted disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 cursor-pointer"
            >
              {approveButtonLabel(selectedRows)}
            </button>
          </div>
        )}
      </div>

      <div id="triage-panel" role="tabpanel" aria-labelledby={`triage-tab-${tab}`}>
        {TAB_HINT[tab] && !error && <p className="text-sm text-ink-muted mb-4">{TAB_HINT[tab]}</p>}

        {isLoading && <QueueSkeleton />}

        {!isLoading && error && (
          <div
            role="alert"
            className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-card border border-danger/30 bg-danger-soft px-4 py-4 text-sm text-danger"
          >
            <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            <span className="flex-1">{error}</span>
            <button
              type="button"
              onClick={onRetry}
              className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-lg bg-surface border border-danger/30 font-semibold hover:bg-danger-soft focus-visible:outline-2 focus-visible:outline-danger cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
              Try again
            </button>
          </div>
        )}

        {!isLoading && !error && visible.length === 0 && (
          <div className="rounded-card shadow-ambient bg-surface px-6 py-14 text-center">
            <Inbox className="w-8 h-8 mx-auto text-ink-muted" aria-hidden="true" />
            <p className="font-display font-semibold text-lg text-ink mt-3">{emptyCopy(tab)}</p>
            {tab === "all" && (
              <p className="text-sm text-ink-muted mt-1">
                New claims land here when the fixed rules don&apos;t allow auto-pay.
              </p>
            )}
          </div>
        )}

        {!isLoading && !error && visible.length > 0 && (
          <TriageGrid
            rows={visible}
            selectable={isQuick}
            selfId={selfId}
            selected={selected}
            onSelectedChange={setSelected}
          />
        )}
      </div>

      <BatchApproveSheet
        open={sheetOpen}
        selected={selectedRows}
        tabRows={rowsForTab(rows, "HR_QUICK")}
        selfId={selfId}
        submitting={submitting}
        error={submitError}
        result={result}
        refFor={refFor}
        onConfirm={confirm}
        onClose={closeSheet}
      />

      {FIXTURES_ON && (
        <p className="mt-4 text-xs text-ink-muted">Sample data (fixture mode). Approvals here don&apos;t reach the backend.</p>
      )}
    </section>
  );
}
