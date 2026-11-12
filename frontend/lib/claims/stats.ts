import type { DashboardStats, ReimbursementRaw } from "@/lib/api/types";

const FINAL_STATUSES = ["APPROVED", "DISBURSING", "PAID", "REJECTED"];

function money(amount: number): string {
  return `MYR ${amount.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function isClaim(r: ReimbursementRaw): boolean {
  return (r.kind ?? "CLAIM") !== "VENDOR_BOOKING";
}

const claimed = (r: ReimbursementRaw): number => r.total_claimed_amount ?? 0;
/** What a payout is actually built from, before recovery offsets. */
const approved = (r: ReimbursementRaw): number => r.total_approved_amount ?? 0;

/** Employee money totals exclude vendor bookings; only the review count includes them. */
export function employeeDashboardStats(reims: ReimbursementRaw[]): DashboardStats {
  const bucket = (statuses: string[], amountOf: (r: ReimbursementRaw) => number) => {
    const items = reims.filter((r) => statuses.includes(r.status) && isClaim(r));
    return { amount: money(items.reduce((sum, r) => sum + amountOf(r), 0)), count: items.length };
  };
  return {
    // Money and review counts describe employee claims; vendor bookings have their own screen.
    awaitingReview: bucket(["REVIEW", "PENDING", "APPEALED"], claimed),
    reimbursedThisMonth: bucket(["APPROVED"], claimed),
    // PayPal pays the approved amount, so an HR cut makes the claimed figure overstate
    // what was paid. The employee history total reads the same approved figure.
    alreadyPaid: bucket(["PAID"], approved),
  };
}

/** HR dashboard totals describe employee claims, not vendor bookings. */
export function hrClaimStats(reims: ReimbursementRaw[]): { total: number; autoSolved: number } {
  const claims = reims.filter(isClaim);
  return {
    total: claims.length,
    autoSolved: claims.filter((r) => r.reviewed_by == null && FINAL_STATUSES.includes(r.status)).length,
  };
}
