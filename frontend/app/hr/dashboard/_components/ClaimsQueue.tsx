"use client";

import { useState, useEffect, useCallback } from "react";
import { getHRClaims, type HRClaims } from "@/lib/actions/hr";
import { FIXTURES_ON } from "@/lib/api/fixtures";
import { useAuth } from "@/context/AuthContext";
import TriageQueue from "@/components/hr-grid/TriageQueue";
import type { TriageRow } from "@/components/hr-grid/rows";
import { FIXTURE_HR_USER_ID } from "@/src/mocks/triageFixtures";

const LOAD_ERROR = "Couldn't load claims. Check your connection and try again.";

/** "62.5" stays, "62.0" reads as "62". */
function formatRate(rate: number): string {
  const fixed = rate.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

/** `initial` is the server's first load; null means it failed there and the browser fetches instead. */
export default function ClaimsQueue({ initial }: { initial: HRClaims | null }) {
  const { user } = useAuth();
  // Fixture claims belong to fixture users, so fixture mode stands in a matching HR id.
  const selfId = FIXTURES_ON ? FIXTURE_HR_USER_ID : (user?.user_id ?? null);

  const [rows, setRows] = useState<TriageRow[]>(initial?.rows ?? []);
  const [stats, setStats] = useState(initial?.stats ?? { total: 0, autoSolved: 0 });
  const [isLoadingClaims, setIsLoadingClaims] = useState(initial == null);
  const [loadError, setLoadError] = useState<string | null>(initial?.error ? LOAD_ERROR : null);

  const load = useCallback(
    () =>
      getHRClaims()
        .then(({ rows: triage, stats: counts, error }) => {
          setRows(triage);
          setStats(counts);
          setLoadError(error ? LOAD_ERROR : null);
        })
        .catch(() => setLoadError(LOAD_ERROR))
        .finally(() => setIsLoadingClaims(false)),
    [],
  );

  useEffect(() => {
    if (initial == null) void load();
  }, [initial, load]);

  const retry = () => {
    setIsLoadingClaims(true);
    void load();
  };

  const handleApproved = useCallback(
    (approvedIds: string[]) => {
      const done = new Set(approvedIds);
      setRows((prev) => prev.filter((r) => !done.has(r.reimId)));
      // Fixture data would bring the approved rows straight back, so only refetch against the backend.
      if (!FIXTURES_ON) void load();
    },
    [load],
  );

  const pendingReviews = rows.filter((r) => r.status === "REVIEW").length;
  // Share of all claims that reached a final state with no HR reviewer on record.
  const autoSolveRate = stats.total === 0 ? 0 : (stats.autoSolved / stats.total) * 100;

  const needsYou =
    pendingReviews === 0 ? "nothing needs you" : `${pendingReviews} ${pendingReviews === 1 ? "claim needs" : "claims need"} you`;

  let summary: string;
  if (isLoadingClaims) summary = "Loading claims…";
  else if (loadError) summary = "Claim numbers are not available.";
  else if (stats.total === 0) summary = "No claims yet.";
  else summary = `${formatRate(autoSolveRate)}% of ${stats.total} resolved without HR · ${needsYou}`;

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <header className="mb-4 md:mb-6">
        <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">Claims queue</h1>
        <p className="mt-1 text-sm text-ink-muted" aria-live="polite">
          {summary}
        </p>
      </header>

      <TriageQueue
        rows={rows}
        isLoading={isLoadingClaims}
        error={loadError}
        selfId={selfId}
        onRetry={retry}
        onApproved={handleApproved}
      />
    </div>
  );
}
