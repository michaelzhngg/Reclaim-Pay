"use server";

import { apiGet, apiPost, apiPut, API_PREFIX } from "@/lib/api/client";
import type { LimitRule, PolicyLimits, ZonePlace } from "@/lib/api/reclaim-pay-types";
import { limitsErrorMessage } from "@/lib/policy/limits";

type LimitsResult = { limits: PolicyLimits | null; error: string | null };

export async function getPolicyLimits(policyId: string): Promise<LimitsResult> {
  const res = await apiGet<PolicyLimits>(`${API_PREFIX}/policies/${policyId}/limits`);
  return res.data ? { limits: res.data, error: null } : { limits: null, error: limitsErrorMessage(res.error, res.status) };
}

/** Confirms HR's checked set. It replaces every limit and zone row of the policy. */
export async function confirmPolicyLimits(policyId: string, limits: LimitRule[], zones: ZonePlace[]): Promise<LimitsResult> {
  const res = await apiPut<PolicyLimits>(`${API_PREFIX}/policies/${policyId}/limits`, { limits, zones });
  return res.data ? { limits: res.data, error: null } : { limits: null, error: limitsErrorMessage(res.error, res.status) };
}

/** Asks the backend to read the policy text again (one LLM call). Suggestions stay hidden from employees. */
export async function suggestPolicyLimits(policyId: string): Promise<{ proposed: number | null; error: string | null }> {
  const res = await apiPost<{ proposed: number; zone_places: number; dropped: number }>(
    `${API_PREFIX}/policies/${policyId}/limits/extract`,
  );
  return res.data ? { proposed: res.data.proposed, error: null } : { proposed: null, error: limitsErrorMessage(res.error, res.status) };
}
