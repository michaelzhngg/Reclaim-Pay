"use server";

// ─── Recovery Server Actions ─────────────────────────────────────────────────
// Employees see their overpayment notices and dispute them. HR audits auto-paid
// claims and runs recoveries. HR actions return the API's error code in `error`;
// recoveryErrorMessage in components/hr-grid/recoveries.ts turns it into a sentence.
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, apiPost, API_PREFIX } from "@/lib/api/client";
import { FIXTURES_ON, pickFixture, withFixture } from "@/lib/api/fixtures";
import type {
  DisputeError,
  PayoutLedgerRow,
  Recovery,
  RecoveryInvoicePreview,
  RecoveryStatus,
} from "@/lib/api/reclaim-pay-types";
import type { TriageSource } from "@/components/hr-grid/rows";
import { toAuditRows, type AuditRow, type HRRecovery } from "@/components/hr-grid/recoveries";
import { recoveryVariants } from "@/src/mocks/reclaimPayFixtures";
import {
  fixtureAuditClaims,
  fixtureCreateRecovery,
  fixtureEmployeeNames,
  fixtureExecuteRecovery,
  fixtureHRRecoveries,
  fixtureInvoicePreview,
  fixtureWaiveRecovery,
} from "@/src/mocks/recoveryFixtures";

/**
 * GET /recoveries?status=…. For an employee the backend returns only their own.
 * Returns null on any failure, a 404 included, so the notice stays hidden.
 */
export async function listRecoveries(status?: RecoveryStatus): Promise<Recovery[] | null> {
  const variant = pickFixture(recoveryVariants, process.env.RECLAIM_PAY_FIXTURE_RECOVERY, "open");
  const fixture = variant?.filter(r => !status || r.status === status) ?? null;
  return withFixture(fixture, async () => {
    const query = status ? `?status=${status}` : "";
    const result = await apiGet<Recovery[]>(`${API_PREFIX}/recoveries${query}`);
    return result.error ? null : (result.data ?? []);
  });
}

/**
 * POST /recoveries/{id}/dispute. The recovery moves to DISPUTED and HR is told.
 * The backend's 409 codes come back as DisputeError values, never as raw text.
 */
export async function disputeRecovery(
  recoveryId: string,
  note: string,
): Promise<{ recovery: Recovery | null; error: DisputeError | null }> {
  const base = recoveryVariants.open?.[0];
  const fixture = base
    ? { recovery: { ...base, recovery_id: recoveryId, status: "DISPUTED" as const, dispute_note: note }, error: null }
    : { recovery: null, error: "FAILED" as const };
  return withFixture(fixture, async () => {
    const result = await apiPost<Recovery>(`${API_PREFIX}/recoveries/${encodeURIComponent(recoveryId)}/dispute`, { note });
    if (result.data && !result.error) return { recovery: result.data, error: null };
    if (result.error?.includes("DISPUTE_WINDOW_CLOSED")) return { recovery: null, error: "WINDOW_CLOSED" };
    if (result.error?.includes("NOT_DISPUTABLE")) return { recovery: null, error: "NOT_DISPUTABLE" };
    return { recovery: null, error: "FAILED" };
  });
}

type RecoveryOutcome = { recovery: Recovery | null; error: string | null };

const NO_RESPONSE = "No response from the server.";
const RECOVERIES_PATH = `${API_PREFIX}/recoveries`;
const recoveryPath = (id: string) => `${RECOVERIES_PATH}/${encodeURIComponent(id)}`;

function toOutcome(res: { data: Recovery | null; error: string | null }): RecoveryOutcome {
  return res.data && !res.error ? { recovery: res.data, error: null } : { recovery: null, error: res.error ?? NO_RESPONSE };
}

/** Auto-paid claims picked for audit, with what each can still have recovered. */
export async function getAuditQueue(): Promise<{ rows: AuditRow[] | null; error: string | null }> {
  if (FIXTURES_ON) return { rows: toAuditRows(fixtureAuditClaims(), fixtureHRRecoveries()), error: null };
  const [claims, recoveries] = await Promise.all([
    apiGet<TriageSource[]>(`${API_PREFIX}/reimbursements/?audit_selected=true&kind=CLAIM&limit=200`),
    apiGet<Recovery[]>(RECOVERIES_PATH),
  ]);
  if (claims.error || !claims.data) return { rows: null, error: claims.error ?? NO_RESPONSE };
  // Without the recoveries the backend still enforces the ceiling, and its 422 reads as a plain sentence.
  return { rows: toAuditRows(claims.data, recoveries.data ?? []), error: null };
}

/**
 * Every recovery, newest first. The recovery API has no employee name, so it comes from
 * the payout ledger, where each paid claim is listed with one.
 */
export async function listHRRecoveries(): Promise<{ recoveries: HRRecovery[] | null; error: string | null }> {
  if (FIXTURES_ON) {
    const names = fixtureEmployeeNames();
    return {
      recoveries: fixtureHRRecoveries().map((r) => ({ ...r, employee_name: names[r.reim_id] ?? null })),
      error: null,
    };
  }
  const [recoveries, ledger] = await Promise.all([
    apiGet<Recovery[]>(RECOVERIES_PATH),
    apiGet<PayoutLedgerRow[]>(`${API_PREFIX}/payouts/`),
  ]);
  if (recoveries.error || !recoveries.data) return { recoveries: null, error: recoveries.error ?? NO_RESPONSE };
  const names = new Map((ledger.data ?? []).map((row) => [row.reim_id, row.employee_name]));
  return {
    recoveries: recoveries.data.map((r) => ({ ...r, employee_name: names.get(r.reim_id) ?? null })),
    error: null,
  };
}

/** POST /recoveries. Sends the employee an overpayment notice and starts the dispute window. */
export async function createRecovery(reimId: string, amount: number, reason: string): Promise<RecoveryOutcome> {
  if (FIXTURES_ON) return fixtureCreateRecovery(reimId, amount, reason);
  return toOutcome(await apiPost<Recovery>(RECOVERIES_PATH, { reim_id: reimId, amount, reason }));
}

/** GET /recoveries/{id}/invoice-preview. Drafts the note with AI and logs it; execute sends that same note. */
export async function getInvoicePreview(
  recoveryId: string,
): Promise<{ preview: RecoveryInvoicePreview | null; error: string | null }> {
  if (FIXTURES_ON) return fixtureInvoicePreview(recoveryId);
  const res = await apiGet<RecoveryInvoicePreview>(`${recoveryPath(recoveryId)}/invoice-preview`);
  return res.data && !res.error ? { preview: res.data, error: null } : { preview: null, error: res.error ?? NO_RESPONSE };
}

/** POST /recoveries/{id}/execute. Comes back INVOICED, or OFFSET when an unpaid claim covers the amount. */
export async function executeRecovery(recoveryId: string): Promise<RecoveryOutcome> {
  if (FIXTURES_ON) return fixtureExecuteRecovery(recoveryId);
  return toOutcome(await apiPost<Recovery>(`${recoveryPath(recoveryId)}/execute`));
}

/** POST /recoveries/{id}/waive. */
export async function waiveRecovery(recoveryId: string): Promise<RecoveryOutcome> {
  if (FIXTURES_ON) return fixtureWaiveRecovery(recoveryId);
  return toOutcome(await apiPost<Recovery>(`${recoveryPath(recoveryId)}/waive`));
}
