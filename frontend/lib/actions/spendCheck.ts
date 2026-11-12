"use server";

import { apiGet, apiPost, API_PREFIX } from "@/lib/api/client";
import type { CategoryOption, QaAnswer, QuestionSummary, SpendCheckResult, TripEstimate } from "@/lib/api/reclaim-pay-types";
import { askErrorMessage, spendErrorMessage } from "@/lib/policy/spendCopy";

/** null when the request failed; an empty list means no active policy has categories. */
export async function getSpendCategories(): Promise<CategoryOption[] | null> {
  const res = await apiGet<CategoryOption[]>(`${API_PREFIX}/spend-check/categories`);
  return res.error ? null : res.data;
}

export async function checkCost(body: {
  category: string; amount: number | null; quantity: number; destination: string | null; overseas: boolean;
}): Promise<{ result: SpendCheckResult | null; error: string | null }> {
  const res = await apiPost<SpendCheckResult>(`${API_PREFIX}/spend-check/check`, body);
  return res.data ? { result: res.data, error: null } : { result: null, error: spendErrorMessage(res.error, res.status) };
}

export async function planTrip(body: {
  destination: string | null; overseas: boolean; depart: string; return_date: string;
}): Promise<{ estimate: TripEstimate | null; error: string | null }> {
  const res = await apiPost<TripEstimate>(`${API_PREFIX}/spend-check/trip`, body);
  return res.data ? { estimate: res.data, error: null } : { estimate: null, error: spendErrorMessage(res.error, res.status) };
}

/** One model call on the backend, capped at 20 a day per employee. */
export async function askPolicy(question: string): Promise<{ answer: QaAnswer | null; error: string | null }> {
  const res = await apiPost<QaAnswer>(`${API_PREFIX}/spend-check/ask`, { question });
  return res.data ? { answer: res.data, error: null } : { answer: null, error: askErrorMessage(res.error, res.status) };
}

/** HR only. Carries no names, only the question text and the day it was asked. */
export async function getQuestionSummary(days = 30): Promise<QuestionSummary | null> {
  const res = await apiGet<QuestionSummary>(`${API_PREFIX}/spend-check/questions?days=${days}`);
  return res.error ? null : res.data;
}
