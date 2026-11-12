"use client";

import { useState } from "react";
import { RefreshCw, RotateCw } from "lucide-react";
import { getWebhookHealth, retryWebhookEvent, runMaintenanceNow } from "@/lib/actions/webhooks";
import type { StuckPayout, WebhookEvent } from "@/lib/api/reclaim-pay-types";
import { formatMoney } from "@/lib/format";
import { useTabData } from "@/lib/hooks/useTabData";
import { useToast } from "@/components/toast/ToastProvider";
import { TabEmpty, TabError, TabLoading } from "@/components/hr-grid/TabStates";
import { STATUS_META, TONE_CLASSES } from "@/components/hr-grid/ledger";
import {
  ageHours,
  eventLabel,
  eventStatusLabel,
  formatAge,
  maintenanceSummary,
  sortEvents,
  stuckReason,
} from "@/components/hr-grid/webhookHealth";

const BADGE = "inline-flex rounded-full border px-2.5 py-0.5 text-[12px] font-semibold";
const BUTTON = "inline-flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-control border border-line text-sm font-semibold text-ink hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 disabled:opacity-60 disabled:cursor-wait cursor-pointer";

async function fetchHealth() {
  return getWebhookHealth();
}

function EventRow({ event, retrying, onRetry }: { event: WebhookEvent; retrying: boolean; onRetry: (id: string) => void }) {
  const dead = event.status === "DEAD_LETTER";
  return (
    <tr className="align-top">
      <td className="px-4 py-3">
        <p className="font-medium text-ink">{eventLabel(event.event_type)}</p>
        <p className="mt-0.5 break-all font-mono text-[11px] text-ink-muted">{event.event_id}</p>
      </td>
      <td className="px-4 py-3">
        <span className={`${BADGE} ${dead ? "border-danger/30 bg-danger-soft text-danger" : "border-warning/30 bg-warning-soft text-warning"}`}>
          {eventStatusLabel(event.status)}
        </span>
      </td>
      <td className="px-4 py-3 text-ink">{event.attempts}</td>
      <td className="px-4 py-3">
        <p className="max-w-[22rem] break-words text-ink-muted" title={event.error ?? undefined}>
          {event.error ?? "Not set"}
        </p>
        {event.resource_id && <p className="mt-0.5 break-all font-mono text-[11px] text-ink-muted">{event.resource_id}</p>}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{formatAge(ageHours(event.updated_at))}</td>
      <td className="px-4 py-3">
        <button type="button" className={BUTTON} onClick={() => onRetry(event.event_id)} disabled={retrying}>
          <RotateCw className={`h-3.5 w-3.5 ${retrying ? "animate-spin" : ""}`} aria-hidden="true" />
          {retrying ? "Retrying" : "Retry"}
        </button>
      </td>
    </tr>
  );
}

function Events({ events, retrying, onRetry }: { events: WebhookEvent[]; retrying: string | null; onRetry: (id: string) => void }) {
  if (events.length === 0) {
    return (
      <TabEmpty title="No failed PayPal events">
        Every PayPal event was handled. New failures appear here after the automatic retries run out.
      </TabEmpty>
    );
  }
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-ambient">
      <table className="w-full min-w-[760px] text-left text-sm">
        <caption className="sr-only">PayPal events that need attention</caption>
        <thead className="border-b border-line bg-surface-muted text-[11px] uppercase tracking-wide text-ink-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-semibold">Event</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Tries</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Last error</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Age</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Action</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {events.map((event) => (
            <EventRow key={event.event_id} event={event} retrying={retrying === event.event_id} onRetry={onRetry} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StuckTable({ payouts }: { payouts: StuckPayout[] }) {
  return (
    <div className="overflow-x-auto rounded-card border border-line bg-surface shadow-ambient">
      <table className="w-full min-w-[760px] text-left text-sm">
        <caption className="sr-only">PayPal payouts that have not reached a final state</caption>
        <thead className="border-b border-line bg-surface-muted text-[11px] uppercase tracking-wide text-ink-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 font-semibold">Claim</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Employee</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Amount</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Status</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Idle</th>
            <th scope="col" className="px-4 py-2.5 font-semibold">Refresh</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {payouts.map((payout) => {
            const meta = STATUS_META[payout.status];
            const reason = stuckReason(payout.refreshable, payout.provider_batch_id);
            return (
              <tr key={payout.payout_id} className="align-top">
                <td className="px-4 py-3 font-mono font-medium text-ink">{payout.claim_ref}</td>
                <td className="px-4 py-3 text-ink">{payout.employee_name}</td>
                <td className="whitespace-nowrap px-4 py-3 text-ink tabular-nums">{formatMoney(payout.currency, payout.amount)}</td>
                <td className="px-4 py-3">
                  <span className={`${BADGE} ${TONE_CLASSES[meta.tone]}`}>{meta.label}</span>
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-ink-muted">{formatAge(payout.age_hours)}</td>
                <td className="px-4 py-3 text-ink-muted">{reason ?? "Ready"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function WebhooksTab({ onLoaded }: { onLoaded?: () => void }) {
  const { toast } = useToast();
  const { data, isLoading, error, retry, refresh } = useTabData(
    fetchHealth,
    "Couldn't load PayPal event health. Check your connection and try again.",
    onLoaded,
  );
  const [retrying, setRetrying] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const onRetry = async (eventId: string) => {
    setRetrying(eventId);
    const { event, error: retryError } = await retryWebhookEvent(eventId);
    setRetrying(null);
    if (retryError) {
      toast({ tone: "error", title: retryError });
      return;
    }
    const stillDead = event?.status === "DEAD_LETTER";
    toast({
      tone: stillDead ? "error" : "success",
      title: stillDead ? "The retry failed. The event is still a dead letter." : "Event retried.",
    });
    refresh();
  };

  const onRun = async () => {
    setRunning(true);
    const { report, error: runError } = await runMaintenanceNow();
    setRunning(false);
    if (runError || !report) {
      toast({ tone: "error", title: runError ?? "Couldn't run maintenance. Try again." });
      return;
    }
    toast({ tone: "success", title: maintenanceSummary(report) });
    refresh();
  };

  const events = data ? sortEvents(data.events) : [];
  const stuck = data?.stuck;

  return (
    <>
      <p className="mb-6 text-sm text-ink-muted">
        Failed PayPal events retry automatically, then wait here for HR. Stuck payouts are checked once a day.
      </p>

      {isLoading && <TabLoading label="Loading PayPal event health" />}
      {!isLoading && error && <TabError message={error} onRetry={retry} />}

      {!isLoading && !error && data && (
        <>
          <section aria-labelledby="webhook-events-title" className="mb-8">
            <div className="mb-3">
              <h2 id="webhook-events-title" className="font-display text-lg font-semibold text-ink">Events needing attention</h2>
              <p className="mt-1 text-sm text-ink-muted">A retry uses the event PayPal already delivered, so HR can act after a fix without waiting for another delivery.</p>
            </div>
            <Events events={events} retrying={retrying} onRetry={onRetry} />
          </section>

          <section aria-labelledby="stuck-payouts-title">
            <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h2 id="stuck-payouts-title" className="font-display text-lg font-semibold text-ink">Stuck payouts</h2>
                <p className="mt-1 text-sm text-ink-muted">
                  Non-final payouts with no status update for more than {stuck?.older_than_hours ?? 24} hours.
                </p>
                {stuck?.mock && <p className="mt-1 text-xs text-ink-muted">PayPal mock mode is on. The sweep lists stuck payouts but does not call PayPal.</p>}
              </div>
              <button type="button" className={BUTTON} onClick={onRun} disabled={running}>
                <RefreshCw className={`h-3.5 w-3.5 ${running ? "animate-spin" : ""}`} aria-hidden="true" />
                {running ? "Running" : "Run maintenance now"}
              </button>
            </div>
            {stuck && stuck.payouts.length > 0 ? (
              <StuckTable payouts={stuck.payouts} />
            ) : (
              <TabEmpty title="No stuck payouts">
                Nothing has been waiting more than {stuck?.older_than_hours ?? 24} hours for a PayPal status. Final payouts and demo batches are not counted.
              </TabEmpty>
            )}
          </section>
        </>
      )}
    </>
  );
}
