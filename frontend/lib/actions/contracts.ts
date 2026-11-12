"use server";

import { apiGet, apiPatch, apiPost, apiPut, API_PREFIX } from "@/lib/api/client";
import type {
  ContractOptions,
  ContractRecord,
  ContractorRow,
  PayoutSetup,
} from "@/lib/contracts";

export interface ContractInput {
  user_id: string;
  country_code: string;
  currency: string;
  rate_amount: number;
  rate_unit: string;
  service_category: string;
  categories: string[];
  max_company_amount_per_claim: number;
  policy_id: string | null;
  effective_from: string;
  effective_to: string | null;
  is_active?: boolean;
}

export async function getContractors(): Promise<{ rows: ContractorRow[]; error: string | null }> {
  const result = await apiGet<ContractorRow[]>(`${API_PREFIX}/contracts/`);
  return { rows: result.data ?? [], error: result.error };
}

export async function getContractOptions(): Promise<ContractOptions | null> {
  const result = await apiGet<ContractOptions>(`${API_PREFIX}/contracts/options`);
  return result.data;
}

export async function createContract(
  input: ContractInput
): Promise<{ contract: ContractRecord | null; error: string | null }> {
  const result = await apiPost<ContractRecord>(`${API_PREFIX}/contracts/`, input);
  return { contract: result.data, error: result.error };
}

export async function updateContract(
  contractId: string,
  input: Partial<ContractInput> & { clear_policy?: boolean; clear_effective_to?: boolean }
): Promise<{ contract: ContractRecord | null; error: string | null }> {
  const result = await apiPatch<ContractRecord>(`${API_PREFIX}/contracts/${contractId}`, input);
  return { contract: result.data, error: result.error };
}

/** The signed-in contractor's own contract. Returns null when none is active. */
export async function getMyContract(): Promise<ContractRecord | null> {
  const result = await apiGet<ContractRecord>(`${API_PREFIX}/contracts/me`);
  return result.error ? null : result.data;
}

export async function getPayoutSetup(): Promise<PayoutSetup | null> {
  const result = await apiGet<PayoutSetup>(`${API_PREFIX}/contracts/payout-settings`);
  return result.data;
}

export async function updatePayoutSetup(
  paypalAccountCountry: string,
  heldCurrencies: string[]
): Promise<{ setup: PayoutSetup | null; error: string | null }> {
  const result = await apiPut<PayoutSetup>(`${API_PREFIX}/contracts/payout-settings`, {
    paypal_account_country: paypalAccountCountry,
    held_currencies: heldCurrencies,
  });
  return { setup: result.data, error: result.error };
}
