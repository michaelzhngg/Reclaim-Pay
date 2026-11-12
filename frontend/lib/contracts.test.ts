import { describe, expect, it } from "vitest";
import {
  contractSummaryRows,
  formatRate,
  payoutSetupRows,
  type ContractRecord,
  type PayoutSetup,
} from "./contracts";

const contract: ContractRecord = {
  contract_id: "c1",
  user_id: "u1",
  country_code: "ID",
  country_name: "Indonesia",
  currency: "IDR",
  currency_name: "Indonesian Rupiah",
  rate_amount: 250000,
  rate_unit: "DAY",
  service_category: "Consulting",
  categories: ["Meals", "Transportation"],
  policy_id: null,
  policy_title: null,
  max_company_amount_per_claim: 1500,
  company_currency: "MYR",
  is_active: true,
  effective_from: "2026-01-01",
  effective_to: null,
  created_at: null,
  updated_at: null,
};

describe("formatRate", () => {
  it("puts the currency and the unit around the amount", () => {
    expect(formatRate("IDR", 250000, "DAY")).toBe("IDR 250,000.00 per day");
    expect(formatRate("USD", 45.5, "HOUR")).toBe("USD 45.50 per hour");
  });
});

describe("contractSummaryRows", () => {
  it("shows country, payout currency, rate, categories and the company-currency limit", () => {
    const rows = Object.fromEntries(contractSummaryRows(contract).map((r) => [r.label, r.value]));
    expect(rows["Country"]).toBe("Indonesia");
    expect(rows["Payout currency"]).toBe("IDR");
    expect(rows["Rate"]).toBe("IDR 250,000.00 per day");
    expect(rows["Expense categories"]).toBe("Meals, Transportation");
    expect(rows["Contract limit per claim"]).toBe("MYR 1,500.00");
    expect(rows["Policy"]).toBe("No contract policy");
    expect(rows["Effective"]).toBe("2026-01-01 with no end date");
  });

  it("reads Not set for an empty value", () => {
    const rows = Object.fromEntries(
      contractSummaryRows({ ...contract, country_name: null, service_category: "", categories: [] })
        .map((r) => [r.label, r.value]),
    );
    expect(rows["Country"]).toBe("ID");
    expect(rows["Invoice category"]).toBe("Not set");
    expect(rows["Expense categories"]).toBe("Not set");
  });
});

describe("payoutSetupRows", () => {
  it("names the account country and the funding currencies", () => {
    const setup: PayoutSetup = {
      paypal_account_country: "MY",
      paypal_account_country_name: "Malaysia",
      held_currencies: ["MYR", "USD"],
      company_currency: "MYR",
      updated_by: null,
      updated_at: null,
    };
    expect(payoutSetupRows(setup).map((r) => r.value)).toEqual(["Malaysia", "MYR, USD"]);
  });

  it("reads Not set when no currency is held", () => {
    const setup: PayoutSetup = {
      paypal_account_country: "MY",
      paypal_account_country_name: null,
      held_currencies: [],
      company_currency: "MYR",
      updated_by: null,
      updated_at: null,
    };
    expect(payoutSetupRows(setup).map((r) => r.value)).toEqual(["MY", "Not set"]);
  });
});
