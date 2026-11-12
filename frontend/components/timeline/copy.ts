import type { AutonomyTier, TimelineStepState } from "@/lib/api/reclaim-pay-types";

/**
 * What the employee is told about a decision. Anything other than AUTO_PAY gets
 * generic wording, so the copy never teaches someone which check to beat.
 */
export function employeeTierCopy(tier: AutonomyTier, amount: string): string {
  switch (tier) {
    case "AUTO_PAY":
      return `Approved automatically. Sending ${amount} to your PayPal.`;
    case "HR_QUICK":
      return "Sent to HR for a quick check.";
    case "HR_REVIEW":
    case "DUAL_REVIEW":
      return "Sent to HR for review.";
  }
}

/** Pill text per audience. Employees see the same label for both review tiers. */
export function tierLabel(tier: AutonomyTier, audience: "employee" | "hr"): string {
  if (tier === "AUTO_PAY") return audience === "hr" ? "Auto-pay" : "Paid automatically";
  if (tier === "HR_QUICK") return audience === "hr" ? "One-click approval" : "Quick HR check";
  if (audience === "hr" && tier === "DUAL_REVIEW") return "Two-person review";
  return "HR review";
}

/**
 * Timeline rows as the employee may see them. A step that warned keeps its row
 * and status but loses its detail, since the detail can name the check that fired.
 */
export function employeeSafeSteps(steps: TimelineStepState[]): TimelineStepState[] {
  return steps.map(s => (s.status === "warn" && s.detail ? { ...s, detail: null } : s));
}
