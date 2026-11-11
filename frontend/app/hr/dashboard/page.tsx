"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import type { ReimbursementRaw } from "@/lib/api/types";
import { getHRClaims } from "@/lib/actions/hr";
import { FIXTURES_ON } from "@/lib/api/fixtures";
import { useAuth } from "@/context/AuthContext";
import TriageQueue from "@/components/hr-grid/TriageQueue";
import type { TriageRow } from "@/components/hr-grid/rows";
import { FIXTURE_HR_USER_ID } from "@/src/mocks/triageFixtures";

/** "62.5" stays, "62.0" reads as "62". */
function formatRate(rate: number): string {
  const fixed = rate.toFixed(1);
  return fixed.endsWith(".0") ? fixed.slice(0, -2) : fixed;
}

export default function HRDashboardPage() {
  const { user } = useAuth();
  // Fixture claims belong to fixture users, so fixture mode stands in a matching HR id.
  const selfId = FIXTURES_ON ? FIXTURE_HR_USER_ID : (user?.user_id ?? null);

  const [rows, setRows] = useState<TriageRow[]>([]);
  const [allReims, setAllReims] = useState<ReimbursementRaw[]>([]);
  const [isLoadingClaims, setIsLoadingClaims] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(
    () =>
      getHRClaims()
        .then(({ rows: triage, allReims: reims, error }) => {
          setRows(triage);
          setAllReims(reims);
          setLoadError(error ? "Couldn't load claims. Check your connection and try again." : null);
        })
        .catch(() => setLoadError("Couldn't load claims. Check your connection and try again."))
        .finally(() => setIsLoadingClaims(false)),
    [],
  );

  useEffect(() => {
    void load();
  }, [load]);

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
  const { autoSolveRate, totalClaims } = useMemo(() => {
    const total = allReims.length;
    if (total === 0) return { autoSolveRate: 0, totalClaims: 0 };
    const autoSolved = allReims.filter(
      (r) => r.reviewed_by == null && ["APPROVED", "DISBURSING", "PAID", "REJECTED"].includes(r.status),
    ).length;
    return { autoSolveRate: (autoSolved / total) * 100, totalClaims: total };
  }, [allReims]);

  const needsYou =
    pendingReviews === 0 ? "nothing needs you" : `${pendingReviews} ${pendingReviews === 1 ? "claim needs" : "claims need"} you`;

  let summary: string;
  if (isLoadingClaims) summary = "Loading claims…";
  else if (loadError) summary = "Claim numbers are not available.";
  else if (totalClaims === 0) summary = "No claims yet.";
  else summary = `${formatRate(autoSolveRate)}% of ${totalClaims} resolved without HR · ${needsYou}`;

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
