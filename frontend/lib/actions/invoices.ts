"use server";

import { apiPost, API_PREFIX } from "@/lib/api/client";
import type { ReimbursementRaw } from "@/lib/api/types";

export interface ContractorInvoiceInput {
  period_start: string;
  period_end: string;
  description: string;
  quantity: number;
  unit_price: number;
  claimed_amount: number;
  note?: string;
}

/** Submit an invoice at the contract rate. The backend decides the tier. */
export async function submitContractorInvoice(
  input: ContractorInvoiceInput,
): Promise<{ invoice: ReimbursementRaw | null; error: string | null }> {
  const result = await apiPost<ReimbursementRaw>(`${API_PREFIX}/contractor-invoices/`, input);
  return { invoice: result.data, error: result.error };
}
