"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowRight, History, Loader2 } from "lucide-react";
import { getSettingsHistory } from "@/lib/actions/autonomy";
import type { AgentAction } from "@/lib/api/reclaim-pay-types";
import { describeChange, historyTime } from "@/app/hr/autonomy/_lib/settingsHistory";

const PAGE = 20;

type Load = { state: "loading" } | { state: "failed" } | { state: "ready"; actions: AgentAction[]; hasMore: boolean };

/**
 * Who changed which setting, when, from what to what, and why (D3). Reads the agent log,
 * filtered to `types` and optionally to one policy. Change `refreshKey` after a save to reload.
 */
export function ChangeHistory({
  title,
  description,
  types,
  policyId,
  currency,
  refreshKey,
  emptyText = "No changes recorded yet.",
}: {
  title: string;
  description: string;
  types: readonly string[];
  policyId?: string;
  currency: string;
  refreshKey?: string | number;
  emptyText?: string;
}) {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState<string | null>(null);
  const typesKey = types.join(",");

  useEffect(() => {
    let cancelled = false;
    getSettingsHistory({ types: typesKey.split(","), policyId, limit: PAGE })
      .then(({ result }) => {
        if (cancelled) return;
        setLoad(result ? { state: "ready", actions: result.actions, hasMore: result.actions.length === PAGE } : { state: "failed" });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [typesKey, policyId, refreshKey, attempt]);

  const retry = useCallback(() => {
    setLoad({ state: "loading" });
    setAttempt((n) => n + 1);
  }, []);

  async function showOlder() {
    if (load.state !== "ready" || load.actions.length === 0) return;
    setLoadingMore(true);
    setMoreError(null);
    const before = load.actions[load.actions.length - 1].action_id;
    const { result } = await getSettingsHistory({ types: typesKey.split(","), policyId, before, limit: PAGE }).catch(() => ({ result: null }));
    setLoadingMore(false);
    if (!result) {
      setMoreError("Couldn't load older changes. Try again.");
      return;
    }
    setLoad({ state: "ready", actions: [...load.actions, ...result.actions], hasMore: result.actions.length === PAGE });
  }

  const entries = useMemo(
    () => (load.state === "ready" ? load.actions.map((a) => describeChange(a, currency)) : []),
    [load, currency],
  );

  return (
    // `relative` keeps the absolutely positioned sr-only text inside this panel. Without it, the
    // text is placed against the page and stretches it past the scrolling <main>.
    <section aria-labelledby="change-history-title" className="relative bg-surface shadow-ambient rounded-card overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-line flex items-start gap-3">
        <History className="w-5 h-5 text-ink-muted shrink-0 mt-0.5" aria-hidden="true" />
        <div className="min-w-0">
          <h2 id="change-history-title" className="font-display font-semibold text-lg text-ink">{title}</h2>
          <p className="font-body text-sm text-ink-muted mt-0.5">{description}</p>
        </div>
      </div>

      {load.state === "loading" && (
        <div role="status" className="px-4 sm:px-6 py-6 flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          Loading changes…
        </div>
      )}

      {load.state === "failed" && (
        <div role="alert" className="px-4 sm:px-6 py-6 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink-muted">Couldn&apos;t load the change history.</span>
          <button
            type="button"
            onClick={retry}
            className="min-h-[44px] px-4 rounded-control border border-line-strong text-ink font-semibold hover:bg-surface-muted transition-colors cursor-pointer"
          >
            Try again
          </button>
        </div>
      )}

      {load.state === "ready" && entries.length === 0 && (
        <p className="px-4 sm:px-6 py-6 text-sm text-ink-muted">{emptyText}</p>
      )}

      {entries.length > 0 && (
        <ol className="divide-y divide-line">
          {entries.map((e) => (
            <li key={e.id} className="px-4 sm:px-6 py-4 flex flex-col gap-2">
              <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                <p className="font-body text-sm font-semibold text-ink">{e.title}</p>
                <p className="font-body text-xs text-ink-muted tabular-nums">
                  {e.who} · <time dateTime={e.at}>{historyTime(e.at)}</time>
                </p>
              </div>
              {e.changes.length > 0 && (
                <dl className="flex flex-col gap-1">
                  {e.changes.map((c) => (
                    <div key={c.label} className="flex flex-wrap items-center gap-x-2 text-sm font-body">
                      <dt className="text-ink-muted">{c.label}:</dt>
                      <dd className="flex items-center gap-1.5 text-ink tabular-nums">
                        <span>{c.before}</span>
                        <ArrowRight className="w-3.5 h-3.5 text-ink-muted" aria-label="changed to" />
                        <span className="font-semibold">{c.after}</span>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {e.reason && (
                <p className="font-body text-sm text-ink-muted">
                  <span className="sr-only">Reason: </span>&ldquo;{e.reason}&rdquo;
                </p>
              )}
            </li>
          ))}
        </ol>
      )}

      {load.state === "ready" && load.hasMore && (
        <div className="px-4 sm:px-6 py-3 border-t border-line flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={showOlder}
            disabled={loadingMore}
            className="min-h-[44px] px-4 rounded-control border border-line-strong text-ink text-sm font-semibold hover:bg-surface-muted transition-colors cursor-pointer disabled:opacity-50"
          >
            {loadingMore ? "Loading…" : "Show older changes"}
          </button>
          {moreError && <p role="alert" className="text-sm text-danger">{moreError}</p>}
        </div>
      )}
    </section>
  );
}
