"use server";

// ─── PayPal Webhook Health Actions ───────────────────────────────────────────
// HR sees failed/dead-lettered events, retries one, and runs the maintenance
// sweep. The event payload never leaves the backend.
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, apiPost, API_PREFIX } from "@/lib/api/client";
import { withFixture } from "@/lib/api/fixtures";
import type {
  MaintenanceReport,
  StuckPayouts,
  WebhookEvent,
} from "@/lib/api/reclaim-pay-types";

export interface WebhookHealth {
  events: WebhookEvent[];
  stuck: StuckPayouts;
}

const fixtureEvent = (over: Partial<WebhookEvent>): WebhookEvent => ({
  event_id: "WH-8F27A1C4D9E2",
  event_type: "PAYMENT.PAYOUTS-ITEM.FAILED",
  resource_id: "MOCKI-5C2E8F104A3B",
  status: "DEAD_LETTER",
  attempts: 5,
  error: "PayPalError: the payout item was rejected",
  created_at: "2026-11-11T09:14:00Z",
  updated_at: "2026-11-11T14:02:00Z",
  processed_at: null,
  ...over,
});

const fixture: WebhookHealth = {
  events: [
    fixtureEvent({}),
    fixtureEvent({
      event_id: "WH-2B61C7E0A4F8",
      event_type: "INVOICING.INVOICE.PAID",
      resource_id: "INV2-MOCK-0001",
      status: "FAILED",
      attempts: 2,
      error: "PayPalError: invoice lookup timed out",
      updated_at: "2026-11-12T08:45:00Z",
    }),
  ],
  stuck: {
    older_than_hours: 24,
    checked_at: "2026-11-12T10:00:00Z",
    mock: true,
    payouts: [
      {
        payout_id: "00000000-0000-4000-8000-000000000011",
        reim_id: "1a2b3c4d-0000-4000-8000-000000000011",
        claim_ref: "RC-1A2B3C4D",
        employee_name: "Demo Employee",
        amount: 48,
        currency: "MYR",
        status: "REQUESTED",
        provider_batch_id: "MOCKB-5C2E8F104A3B",
        created_at: "2026-11-10T09:00:00Z",
        updated_at: "2026-11-10T09:00:05Z",
        age_hours: 52,
        refreshable: false,
      },
    ],
  },
};

const fixtureReport: MaintenanceReport = {
  started_at: "2026-11-12T10:00:00Z",
  finished_at: "2026-11-12T10:00:02Z",
  locked: false,
  payouts: { checked: 1, refreshed: 0, changed: 0, still_open: 1, unrefreshable: 1, errors: 0, mock: true, truncated: false },
  webhooks: { checked: 2, processed: 1, dead_lettered: 0, errors: 1, truncated: false },
};

/** Everything the tab needs. Throws so the tab can tell an outage from an empty queue. */
export async function getWebhookHealth(): Promise<WebhookHealth> {
  return withFixture<WebhookHealth>(fixture, async () => {
    const [dead, failed, stuck] = await Promise.all([
      apiGet<WebhookEvent[]>(`${API_PREFIX}/paypal/events?status=DEAD_LETTER&limit=50`),
      apiGet<WebhookEvent[]>(`${API_PREFIX}/paypal/events?status=FAILED&limit=50`),
      apiGet<StuckPayouts>(`${API_PREFIX}/payouts/stuck?limit=200`),
    ]);
    const error = dead.error || failed.error || stuck.error;
    if (error || !dead.data || !failed.data || !stuck.data) {
      throw new Error(error ?? "No response");
    }
    return { events: [...dead.data, ...failed.data], stuck: stuck.data };
  });
}

export interface RetryWebhookResult {
  event: WebhookEvent | null;
  error: string | null;
}

/** Retry one event from its stored payload. A 409 means it is already handled or in flight. */
export async function retryWebhookEvent(eventId: string): Promise<RetryWebhookResult> {
  return withFixture<RetryWebhookResult>({ event: fixtureEvent({ status: "PROCESSED", error: null, attempts: 1 }), error: null }, async () => {
    const result = await apiPost<WebhookEvent>(
      `${API_PREFIX}/paypal/events/${encodeURIComponent(eventId)}/retry`,
    );
    if (result.data && !result.error) return { event: result.data, error: null };
    if (result.status === 409) return { event: null, error: "This event was already handled or is still in flight." };
    if (result.status === 404) return { event: null, error: "This event no longer exists." };
    return { event: null, error: "Couldn't retry this event. Try again." };
  });
}

export interface MaintenanceResult {
  report: MaintenanceReport | null;
  error: string | null;
}

/** Run the same sweep the startup loop runs, with a smaller batch. */
export async function runMaintenanceNow(): Promise<MaintenanceResult> {
  return withFixture<MaintenanceResult>({ report: fixtureReport, error: null }, async () => {
    const result = await apiPost<MaintenanceReport>(`${API_PREFIX}/payouts/maintenance/run`);
    if (result.data && !result.error) return { report: result.data, error: null };
    if (result.status === 409) return { report: null, error: "Maintenance is already running. Try again in a moment." };
    return { report: null, error: "Couldn't run maintenance. Try again." };
  });
}
