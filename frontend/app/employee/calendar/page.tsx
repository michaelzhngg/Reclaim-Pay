"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getReimbursementsForCalendar } from "@/lib/actions/claims";
import type { ReimbursementRaw } from "@/lib/api/types";
import { buildCalendarEvents } from "./_lib/events";

function CalendarLoading() {
  return (
    <div
      role="status"
      className="flex h-64 items-center justify-center rounded-card shadow-ambient bg-surface font-body text-sm text-ink-muted"
    >
      Loading your claims and payouts…
    </div>
  );
}

// Bryntum needs the browser and ships a 5 MB bundle, so only this page's event view ever loads it.
const ClaimsCalendar = dynamic(() => import("./_components/ClaimsCalendar"), {
  ssr: false,
  loading: CalendarLoading,
});

type LoadState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; rows: ReimbursementRaw[] };

async function loadRows(): Promise<LoadState> {
  try {
    const { data, error } = await getReimbursementsForCalendar();
    return error || !data ? { kind: "error" } : { kind: "ready", rows: data };
  } catch {
    return { kind: "error" };
  }
}

export default function CalendarPage() {
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let live = true;
    loadRows().then((next) => {
      if (live) setState(next);
    });
    return () => {
      live = false;
    };
  }, []);

  const retry = useCallback(() => {
    setState({ kind: "loading" });
    loadRows().then(setState);
  }, []);

  const events = useMemo(() => (state.kind === "ready" ? buildCalendarEvents(state.rows) : []), [state]);

  return (
    <div className="mx-auto flex w-full max-w-screen-xl flex-col gap-4 px-4 pt-6 pb-6 md:px-8 md:pt-8 lg:pt-10">
      <header>
        <h2 className="font-display text-2xl font-semibold text-ink md:text-3xl">Calendar</h2>
        <p className="mt-1 font-body text-base text-ink-muted">The days you submitted claims and got paid.</p>
      </header>

      {state.kind === "loading" && <CalendarLoading />}

      {state.kind === "error" && (
        <div role="alert" className="flex flex-col items-start gap-3 rounded-card shadow-ambient bg-surface p-6">
          <p className="font-body text-sm text-ink">We couldn&apos;t load your claims. Check your connection and try again.</p>
          <button
            type="button"
            onClick={retry}
            className="min-h-11 rounded-full bg-accent px-4 font-body text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
          >
            Try again
          </button>
        </div>
      )}

      {state.kind === "ready" && events.length === 0 && (
        <div className="flex flex-col items-start gap-3 rounded-card shadow-ambient bg-surface p-6">
          <p className="font-body text-sm text-ink">No claims yet. Submit a receipt and it shows up here on the day you sent it, then again on the day you&apos;re paid.</p>
          <Link
            href="/employee/claims"
            className="inline-flex min-h-11 items-center rounded-full bg-accent px-4 font-body text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
          >
            Upload a claim
          </Link>
        </div>
      )}

      {state.kind === "ready" && events.length > 0 && <ClaimsCalendar events={events} />}
    </div>
  );
}
