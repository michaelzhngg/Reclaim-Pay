"use server";

// ─── PayPal Server Actions ───────────────────────────────────────────────────
// Payee linking ("Log in with PayPal"), payout status, the HR payout ledger and the funding check.
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, apiDelete, API_PREFIX } from "@/lib/api/client";
import { withFixture } from "@/lib/api/fixtures";
import type { LedgerFilters, PayeeStatus, PayoutInfoV2, PayoutLedgerRow } from "@/lib/api/reclaim-pay-types";
import type { FundingSummary } from "@/components/hr-grid/funding";
import { ledgerRows, payee, payoutS1 } from "@/src/mocks/reclaimPayFixtures";
import { FIXTURE_PAYOUTS_EMPTY } from "@/src/mocks/recoveryFixtures";

/** Current employee's linked PayPal account. */
export async function getPayeeStatus(): Promise<PayeeStatus | null> {
  return withFixture<PayeeStatus | null>(payee, async () => {
    const result = await apiGet<PayeeStatus>(`${API_PREFIX}/paypal/status`);
    return result.data;
  });
}

/** URL that starts "Log in with PayPal". The browser navigates to it. */
export async function getConnectUrl(): Promise<{ url: string | null; error: string | null }> {
  return withFixture({ url: "/employee/settings?paypal=linked", error: null }, async () => {
    const result = await apiGet<{ url: string }>(`${API_PREFIX}/paypal/connect-url`);
    return { url: result.data?.url ?? null, error: result.error };
  });
}

export async function unlinkPayPal(): Promise<{ error: string | null }> {
  return withFixture({ error: null }, async () => {
    const result = await apiDelete<null>(`${API_PREFIX}/paypal/link`);
    return { error: result.error };
  });
}

/** Latest payout for a claim, or null when none exists yet. */
export async function getPayout(reimId: string): Promise<PayoutInfoV2 | null> {
  return withFixture<PayoutInfoV2 | null>({ ...payoutS1, reim_id: reimId }, async () => {
    const result = await apiGet<PayoutInfoV2>(`${API_PREFIX}/payouts/${reimId}`);
    return result.data;
  });
}

/** HR payout ledger. Throws on a failed request so the page can tell an outage from an empty ledger. */
export async function getLedger(filters: LedgerFilters = {}): Promise<PayoutLedgerRow[]> {
  return withFixture(FIXTURE_PAYOUTS_EMPTY ? [] : ledgerRows, async () => {
    const params = new URLSearchParams();
    if (filters.status) params.set("status", filters.status);
    if (filters.from) params.set("from", filters.from);
    if (filters.to) params.set("to", filters.to);
    const query = params.size ? `?${params}` : "";
    const result = await apiGet<PayoutLedgerRow[]>(`${API_PREFIX}/payouts/${query}`);
    if (result.error) throw new Error(result.error);
    return result.data ?? [];
  });
}

const fundingFixture: FundingSummary = {
  status: "low",
  currency: "MYR",
  available: "410.00",
  expected_daily: "205.00",
  committed: "96.00",
  days_of_cover: "2.0",
  threshold_days: 3,
  history_days: 14,
  as_of: "2026-11-12T08:00:00Z",
  checked_at: "2026-11-12T08:00:05Z",
  mock: true,
  message: "MYR 410.00 available covers about 2 days of payouts, under the 3-day minimum, so top up the PayPal business account.",
};

/** PayPal balance against expected payouts. Throws on a failed request; PayPal itself being down is a normal answer. */
export async function getFunding(): Promise<FundingSummary> {
  return withFixture(fundingFixture, async () => {
    const result = await apiGet<FundingSummary>(`${API_PREFIX}/payouts/funding`);
    if (result.error || !result.data) throw new Error(result.error ?? "No response");
    return result.data;
  });
}
