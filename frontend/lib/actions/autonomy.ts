"use server";

// ─── Autonomy Server Actions ─────────────────────────────────────────────────
// HR actions on the autonomy engine: batch approval, settings, the kill switch,
// today's status, the agent log and the back-test.
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, apiPost, apiPut, API_PREFIX } from "@/lib/api/client";
import { FIXTURES_ON, withFixture } from "@/lib/api/fixtures";
import type {
  AgentActionsResult,
  AutonomyConfig,
  AutonomySettings,
  AutonomyStatus,
  BacktestResult,
  BatchApproveResult,
} from "@/lib/api/reclaim-pay-types";
import { getEmployees } from "@/lib/actions/employees";
import { fixtureBatchApprove } from "@/src/mocks/triageFixtures";
import {
  fixtureActions,
  fixtureActorNames,
  fixtureBacktest,
  fixtureKillSwitch,
  fixtureSaveSettings,
  fixtureSettings,
  fixtureStatus,
} from "@/src/mocks/autonomyFixtures";

type Outcome<K extends string, T> = { [key in K]: T | null } & { error: string | null };

const NO_RESPONSE = "No response from the server.";

/**
 * Approves HR_QUICK claims in one call. The backend re-checks every claim and
 * returns the ones it refused in `skipped`, so a tier change since page load is safe.
 */
export async function batchApprove(
  reimIds: string[],
): Promise<{ result: BatchApproveResult | null; error: string | null }> {
  return withFixture({ result: fixtureBatchApprove(reimIds), error: null }, async () => {
    const res = await apiPost<BatchApproveResult>(`${API_PREFIX}/reimbursements/batch-approve`, { reim_ids: reimIds });
    if (res.error || !res.data) return { result: null, error: res.error ?? "No response from the server." };
    return { result: res.data, error: null };
  });
}

export async function getSettings(): Promise<Outcome<"settings", AutonomySettings>> {
  if (FIXTURES_ON) return { settings: fixtureSettings(), error: null };
  const res = await apiGet<AutonomySettings>(`${API_PREFIX}/autonomy/settings`);
  return { settings: res.data, error: res.data ? null : (res.error ?? NO_RESPONSE) };
}

/**
 * Saves a full config. The backend ignores `enabled` and `version` and raises the version itself.
 * `reason` is stored on the CONFIG_CHANGED log entry, not in the config.
 */
export async function saveSettings(
  config: AutonomyConfig,
  reason: string,
): Promise<Outcome<"settings", AutonomySettings>> {
  if (FIXTURES_ON) return { settings: fixtureSaveSettings(config, reason), error: null };
  const res = await apiPut<AutonomySettings>(`${API_PREFIX}/autonomy/settings`, { ...config, reason });
  return { settings: res.data, error: res.data ? null : (res.error ?? NO_RESPONSE) };
}

/** Pauses (`enabled: false`) or resumes automatic payouts. The backend refuses a blank reason with 422. */
export async function setKillSwitch(
  enabled: boolean,
  reason: string,
): Promise<Outcome<"settings", AutonomySettings>> {
  if (!reason.trim()) return { settings: null, error: "Add a reason first." };
  if (FIXTURES_ON) return { settings: fixtureKillSwitch(enabled, reason.trim()), error: null };
  const res = await apiPost<AutonomySettings>(`${API_PREFIX}/autonomy/kill-switch`, { enabled, reason: reason.trim() });
  return { settings: res.data, error: res.data ? null : (res.error ?? NO_RESPONSE) };
}

export async function getStatus(): Promise<Outcome<"status", AutonomyStatus>> {
  if (FIXTURES_ON) return { status: fixtureStatus(), error: null };
  const res = await apiGet<AutonomyStatus>(`${API_PREFIX}/autonomy/status`);
  return { status: res.data, error: res.data ? null : (res.error ?? NO_RESPONSE) };
}

export async function getActions(limit = 50): Promise<Outcome<"result", AgentActionsResult>> {
  if (FIXTURES_ON) return { result: fixtureActions(limit), error: null };
  const res = await apiGet<AgentActionsResult>(`${API_PREFIX}/autonomy/actions?limit=${limit}`);
  return { result: res.data, error: res.data ? null : (res.error ?? NO_RESPONSE) };
}

/**
 * Status plus the latest log entries. One action instead of two, because the browser runs
 * server actions one at a time; here the two backend calls run side by side.
 */
export async function getStatusWithActions(
  limit = 50,
): Promise<{ status: Outcome<"status", AutonomyStatus>; actions: Outcome<"result", AgentActionsResult> }> {
  const [status, actions] = await Promise.all([getStatus(), getActions(limit)]);
  return { status, actions };
}

/** Everything the Autonomy page shows when it opens, in one round trip. */
export async function getAutonomyOverview(limit = 50): Promise<
  { settings: Outcome<"settings", AutonomySettings> } & Awaited<ReturnType<typeof getStatusWithActions>>
> {
  const [settings, rest] = await Promise.all([getSettings(), getStatusWithActions(limit)]);
  return { settings, ...rest };
}

/** The Agent log tab: the chain plus the names behind the user IDs. Names are a nicety, so losing them isn't an error. */
export async function getAgentLog(
  limit = 200,
): Promise<Outcome<"result", AgentActionsResult> & { actorNames: Record<string, string> }> {
  if (FIXTURES_ON) return { result: fixtureActions(limit), error: null, actorNames: fixtureActorNames() };
  const [log, people] = await Promise.all([getActions(limit), getEmployees().catch(() => [])]);
  return { ...log, actorNames: Object.fromEntries(people.map((p) => [p.user_id, p.name])) };
}

/**
 * Replays the last 90 days under `config`. `unavailable` is true when the server has no
 * back-test route yet (404), so the page can say so calmly instead of showing an error.
 */
export async function runBacktest(
  config: AutonomyConfig,
): Promise<Outcome<"result", BacktestResult> & { unavailable: boolean }> {
  if (FIXTURES_ON) return { result: fixtureBacktest(config), error: null, unavailable: false };
  const res = await apiPost<BacktestResult>(`${API_PREFIX}/autonomy/backtest`, { config });
  if (res.status === 404) return { result: null, error: null, unavailable: true };
  return { result: res.data, error: res.data ? null : (res.error ?? NO_RESPONSE), unavailable: false };
}
