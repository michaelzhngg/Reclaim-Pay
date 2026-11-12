import { describe, expect, it } from "vitest";
import type { ReimbursementRaw } from "@/lib/api/types";
import { employeeDashboardStats, hrClaimStats } from "./stats";

const claim = (over: Partial<ReimbursementRaw>): ReimbursementRaw =>
  ({
    reim_id: "r1",
    user_id: "u1",
    policy_id: null,
    settlement_id: null,
    main_category: "Meals",
    currency: "MYR",
    total_claimed_amount: 100,
    judgment: "APPROVED",
    ai_reasoning: {},
    status: "PAID",
    summary: "",
    sub_categories: [],
    kind: "CLAIM",
    ...over,
  }) as ReimbursementRaw;

describe("employeeDashboardStats", () => {
  it("excludes bookings from all employee money and review totals", () => {
    const booking = claim({ reim_id: "b1", kind: "VENDOR_BOOKING", status: "REVIEW", total_claimed_amount: 240 });
    const paidClaim = claim({ reim_id: "c1", status: "PAID", total_claimed_amount: 48 });
    const reviewClaim = claim({ reim_id: "c2", status: "REVIEW", total_claimed_amount: 20 });
    const stats = employeeDashboardStats([booking, paidClaim, reviewClaim]);
    expect(stats.awaitingReview).toEqual({ amount: "MYR 20.00", count: 1 });
    expect(stats.alreadyPaid).toEqual({ amount: "MYR 48.00", count: 1 });
    expect(stats.reimbursedThisMonth.count).toBe(0);
  });
});

describe("hrClaimStats", () => {
  it("excludes vendor bookings from the dashboard totals", () => {
    const autoClaim = claim({ reim_id: "c1", reviewed_by: null, status: "PAID" });
    const reviewedClaim = claim({ reim_id: "c2", reviewed_by: "hr1", status: "APPROVED" });
    const booking = claim({ reim_id: "b1", kind: "VENDOR_BOOKING", reviewed_by: null, status: "PAID" });
    expect(hrClaimStats([autoClaim, reviewedClaim, booking])).toEqual({ total: 2, autoSolved: 1 });
  });
});
