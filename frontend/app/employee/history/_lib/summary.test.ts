import { describe, expect, it } from "vitest";
import type { ReimbursementRaw } from "@/lib/api/types";
import { employeeDashboardStats } from "@/lib/claims/stats";
import type { HistoryClaim } from "../_components/historyData";
import { employeeHistorySummary } from "./summary";

const row = (over: Partial<HistoryClaim>): HistoryClaim =>
  ({
    id: "r1",
    date: "Nov 12, 2026",
    category: "Meals",
    subCategory: "",
    merchant: "Cafe",
    amount: "MYR 0.00",
    amountNumeric: 0,
    approvedAmount: 0,
    status: "Pending",
    isVendorBooking: false,
    lineItems: [],
    receiptCount: 0,
    pdfDownloadUrl: "",
    employee: { name: "", id: "", department: "", position: "" },
    claimContext: { purpose: "", overseas: false },
    ...over,
  }) as HistoryClaim;

const raw = (over: Partial<ReimbursementRaw>): ReimbursementRaw =>
  ({
    reim_id: "r1",
    user_id: "u1",
    policy_id: null,
    settlement_id: null,
    main_category: "Meals",
    currency: "MYR",
    total_claimed_amount: 0,
    total_approved_amount: 0,
    judgment: "APPROVED",
    ai_reasoning: {},
    status: "PAID",
    summary: "",
    sub_categories: [],
    kind: "CLAIM",
    ...over,
  }) as ReimbursementRaw;

describe("employeeHistorySummary", () => {
  it("leaves company-paid vendor bookings out of both header figures", () => {
    const summary = employeeHistorySummary([
      row({ id: "c1", status: "Paid", approvedAmount: 287.45 }),
      row({ id: "b1", status: "Paid", approvedAmount: 95, isVendorBooking: true }),
      row({ id: "b2", status: "Paid", approvedAmount: 50, isVendorBooking: true }),
      row({ id: "c2", status: "Pending", amountNumeric: 10 }),
      row({ id: "b3", status: "Pending", amountNumeric: 300, isVendorBooking: true }),
    ]);
    expect(summary).toEqual({ total: "MYR 287.45", pending: "MYR 10.00", companyCurrency: "MYR" });
  });

  it("matches the dashboard Already paid total when a paid claim was approved for less", () => {
    const claims = [
      row({ id: "c1", status: "Paid", amountNumeric: 300, approvedAmount: 239.45 }),
      row({ id: "c2", status: "Paid", amountNumeric: 48, approvedAmount: 48 }),
    ];
    const dashboard = employeeDashboardStats([
      raw({ reim_id: "c1", kind: "CLAIM", status: "PAID", total_claimed_amount: 300, total_approved_amount: 239.45 }),
      raw({ reim_id: "c2", kind: "CLAIM", status: "PAID", total_claimed_amount: 48, total_approved_amount: 48 }),
      raw({ reim_id: "b1", kind: "VENDOR_BOOKING", status: "PAID", total_claimed_amount: 95, total_approved_amount: 95 }),
      raw({ reim_id: "b2", kind: "VENDOR_BOOKING", status: "PAID", total_claimed_amount: 50, total_approved_amount: 50 }),
    ]);
    expect(employeeHistorySummary(claims).total).toBe("MYR 287.45");
    expect(employeeHistorySummary(claims).total).toBe(dashboard.alreadyPaid.amount);
  });

  it("uses the approved amount for settled rows and skips rejected ones", () => {
    const summary = employeeHistorySummary([
      row({ id: "c1", status: "Approved", amountNumeric: 100, approvedAmount: 80 }),
      row({ id: "c2", status: "Rejected", amountNumeric: 60, approvedAmount: 0 }),
    ]);
    expect(summary).toEqual({ total: "MYR 80.00", pending: "MYR 0.00", companyCurrency: "MYR" });
  });
});
