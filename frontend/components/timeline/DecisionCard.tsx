import type { AutonomyDecision, AutonomyTier } from "@/lib/api/reclaim-pay-types";
import { employeeTierCopy, tierLabel } from "./copy";

// Auto-pay is the only outcome that means money is moving now, so it alone takes the brand color.
const PILL: Record<AutonomyTier, string> = {
  AUTO_PAY: "bg-accent-soft text-accent-hover",
  HR_QUICK: "bg-surface-muted text-ink",
  HR_REVIEW: "bg-surface-muted text-ink",
  DUAL_REVIEW: "bg-surface-muted text-ink",
};

interface DecisionCardProps {
  decision: AutonomyDecision;
  /** Amount as the backend formats it, e.g. "MYR 48.00". */
  amount: string;
  audience: "employee" | "hr";
  /** Shown above the outcome when a submission produced more than one claim. */
  caption?: string;
}

export default function DecisionCard({ decision, amount, audience, caption }: DecisionCardProps) {
  // Employees never see DUAL_REVIEW as its own pill: that alone would hint a high-risk check fired.
  const pillTier: AutonomyTier = audience === "employee" && decision.tier === "DUAL_REVIEW" ? "HR_REVIEW" : decision.tier;

  return (
    <div className="w-full text-left rounded-card shadow-ambient bg-surface p-4">
      {caption && <p className="font-body text-xs text-ink-muted mb-2">{caption}</p>}
      <span className={`inline-block rounded-full px-2.5 py-0.5 font-body text-xs font-semibold ${PILL[pillTier]}`}>
        {tierLabel(decision.tier, audience)}
      </span>
      {audience === "employee" ? (
        <p className="mt-2 font-body text-sm text-ink">{employeeTierCopy(decision.tier, amount)}</p>
      ) : (
        <>
          <p className="mt-2 font-body text-sm text-ink">{decision.explanation}</p>
          <p className="mt-1 font-body text-xs text-ink-muted">
            Risk <span className="font-mono">{decision.risk_score}/100</span> · <span className="font-mono">{amount}</span>
            {decision.hard_stops.length > 0 && ` · ${decision.hard_stops.length} hard stop${decision.hard_stops.length === 1 ? "" : "s"}`}
          </p>
        </>
      )}
    </div>
  );
}
