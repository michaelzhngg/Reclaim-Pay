import type { AutonomyTier } from "@/lib/api/reclaim-pay-types";
import { TIER_LABEL } from "../rows";

// The tier is the sentence "how much of a person does this claim need", so the
// pill tone rises with human effort. Text always carries the meaning; tone only supports it.
const TIER_TONE: Record<AutonomyTier, string> = {
  AUTO_PAY: "bg-success-soft text-success border-success/30",
  HR_QUICK: "bg-surface-muted text-ink border-line",
  HR_REVIEW: "bg-warning-soft text-warning border-warning/30",
  DUAL_REVIEW: "bg-danger-soft text-danger border-danger/30",
};

export function TierPill({ tier }: { tier: AutonomyTier }) {
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap px-2 py-0.5 rounded-md border text-xs font-semibold ${TIER_TONE[tier]}`}
    >
      {TIER_LABEL[tier]}
    </span>
  );
}
