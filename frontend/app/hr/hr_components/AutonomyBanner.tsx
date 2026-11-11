"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clock, PauseCircle } from "lucide-react";
import { getActions, getStatus } from "@/lib/actions/autonomy";
import type { AutonomyStatus } from "@/lib/api/reclaim-pay-types";
import { breakerActive, breakerLine, latestReason } from "../autonomy/_lib/autonomy";

/** Fired by the Autonomy page after the kill switch or settings change, so the banner refreshes at once. */
export const AUTONOMY_CHANGED_EVENT = "autonomy-status-changed";

interface BannerState {
  status: AutonomyStatus;
  pauseReason: string | null;
  breakerReason: string | null;
}

/**
 * A strip across every HR page while auto-pay is paused by the kill switch or held by the
 * circuit breaker. Hidden on /hr/autonomy, where the status card says the same at full length.
 * If the status can't be loaded it shows nothing rather than guessing.
 */
export default function AutonomyBanner() {
  const pathname = usePathname();
  const [state, setState] = useState<BannerState | null>(null);
  const [, setTick] = useState(0);

  const load = useCallback(
    () =>
      getStatus()
        .then(async (s) => {
          if (!s.status) return null;
          const showsSomething = !s.status.enabled || breakerActive(s.status.breaker_until);
          const actions = showsSomething ? ((await getActions(50)).result?.actions ?? []) : [];
          return {
            status: s.status,
            pauseReason: latestReason(actions, "KILL_SWITCH"),
            breakerReason: latestReason(actions, "BREAKER_TRIPPED"),
          };
        })
        .catch(() => null)
        .then(setState),
    [],
  );

  useEffect(() => {
    void load();
  }, [load, pathname]);

  useEffect(() => {
    const handler = () => void load();
    window.addEventListener(AUTONOMY_CHANGED_EVENT, handler);
    return () => window.removeEventListener(AUTONOMY_CHANGED_EVENT, handler);
  }, [load]);

  // Re-render when the breaker lifts so the strip goes away on time.
  const until = state?.status.breaker_until ?? null;
  useEffect(() => {
    if (!breakerActive(until)) return;
    const ms = new Date(until).getTime() - Date.now() + 1000;
    const t = setTimeout(() => setTick((n) => n + 1), Math.min(ms, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [until]);

  if (!state || pathname.startsWith("/hr/autonomy")) return null;
  const { status, pauseReason, breakerReason } = state;
  const paused = !status.enabled;
  const breaker = breakerActive(status.breaker_until);
  if (!paused && !breaker) return null;

  return (
    <div
      role="status"
      className={`flex flex-col gap-1 px-4 py-2.5 text-sm sm:flex-row sm:items-center sm:justify-between sm:gap-4 sm:px-6 md:px-8 border-b ${
        paused ? "bg-danger/10 border-danger/30" : "bg-warning-soft border-warning/30"
      }`}
    >
      <p className="flex items-start gap-2 min-w-0 text-ink">
        {paused ? (
          <PauseCircle className="w-4 h-4 mt-0.5 text-danger shrink-0" aria-hidden="true" />
        ) : (
          <Clock className="w-4 h-4 mt-0.5 text-warning shrink-0" aria-hidden="true" />
        )}
        <span>
          {paused ? (
            <>
              <span className="font-semibold">Auto-pay is paused.</span> Every new claim waits for HR.
              {pauseReason ? ` Reason: ${pauseReason}` : ""}
            </>
          ) : (
            <>
              <span className="font-semibold">{breakerLine(status.breaker_until!, breakerReason)}</span> Claims go to quick
              approval until then.
            </>
          )}
        </span>
      </p>
      <Link
        href="/hr/autonomy"
        className="self-start sm:self-auto shrink-0 inline-flex items-center min-h-[44px] font-semibold text-accent underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-accent rounded"
      >
        Open Autonomy
      </Link>
    </div>
  );
}
