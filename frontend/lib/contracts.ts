import { formatMoney } from "./api/reclaim-pay-types";

export type RateUnit = "HOUR" | "DAY" | "MONTH" | "PROJECT";

export interface ContractRecord {
  contract_id: string;
  user_id: string;
  country_code: string;
  country_name: string | null;
  currency: string;
  currency_name: string | null;
  rate_amount: number;
  rate_unit: RateUnit;
  service_category: string;
  categories: string[];
  policy_id: string | null;
  policy_title: string | null;
  max_company_amount_per_claim: number;
  company_currency: string;
  is_active: boolean;
  effective_from: string;
  effective_to: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface ContractorRow {
  user_id: string;
  user_code: string | null;
  name: string;
  email: string;
  is_active: boolean;
  contract: ContractRecord | null;
}

export interface PayoutSetup {
  paypal_account_country: string;
  paypal_account_country_name: string | null;
  held_currencies: string[];
  company_currency: string;
  updated_by: string | null;
  updated_at: string | null;
}

export interface SelectOption {
  code: string;
  name: string;
}

export interface ContractOptions {
  countries: SelectOption[];
  currencies: SelectOption[];
  rate_units: RateUnit[];
}

export const RATE_UNIT_LABEL: Record<RateUnit, string> = {
  HOUR: "per hour",
  DAY: "per day",
  MONTH: "per month",
  PROJECT: "per project",
};

const NOT_SET = "Not set";

/** "IDR 250,000.00 per day" */
export function formatRate(currency: string, amount: number, unit: RateUnit): string {
  return `${formatMoney(currency || NOT_SET, amount)} ${RATE_UNIT_LABEL[unit] ?? unit.toLowerCase()}`;
}

export interface SummaryRow {
  label: string;
  value: string;
}

/** Reads left to right on the contractor settings card and the HR contract list. */
export function contractSummaryRows(contract: ContractRecord): SummaryRow[] {
  const country = contract.country_name || contract.country_code || NOT_SET;
  return [
    { label: "Country", value: country },
    { label: "Payout currency", value: contract.currency || NOT_SET },
    { label: "Rate", value: formatRate(contract.currency, contract.rate_amount, contract.rate_unit) },
    { label: "Invoice category", value: contract.service_category || NOT_SET },
    { label: "Expense categories", value: contract.categories.length ? contract.categories.join(", ") : NOT_SET },
    { label: "Contract limit per claim", value: formatMoney(contract.company_currency || NOT_SET, contract.max_company_amount_per_claim) },
    { label: "Policy", value: contract.policy_title || "No contract policy" },
    {
      label: "Effective",
      value: contract.effective_to
        ? `${contract.effective_from} to ${contract.effective_to}`
        : `${contract.effective_from} with no end date`,
    },
  ];
}

/** The company setup card: account country and the currencies the company holds. */
export function payoutSetupRows(setup: PayoutSetup): SummaryRow[] {
  return [
    {
      label: "PayPal account country",
      value: setup.paypal_account_country_name || setup.paypal_account_country || NOT_SET,
    },
    {
      label: "Funding currencies",
      value: setup.held_currencies.length ? setup.held_currencies.join(", ") : NOT_SET,
    },
  ];
}
