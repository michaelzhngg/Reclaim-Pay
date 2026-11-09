"use client";

import { CheckCircle2, ShieldX, AlertTriangle, UserCheck } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";

export type HRDecision = "approve_full" | "approve_adjusted" | "reject" | "confirm" | "flag" | null;

/** True when the backend recorded the first of two approvals on a two-person (DUAL_REVIEW) claim. */
export function isAwaitingSecondApproval(data: unknown): boolean {
  return !!data && typeof data === "object" && (data as { awaiting_second_approval?: unknown }).awaiting_second_approval === true;
}

export function SuccessModal({
  decision,
  id,
  awaitingSecondApproval = false,
}: {
  decision: HRDecision;
  id: string;
  /** First approval of two: nothing is paid yet, so the modal must not say the claim is done. */
  awaitingSecondApproval?: boolean;
}) {
  const actionRef = useRef<HTMLAnchorElement>(null);

  // The decision is final, so the one way on is the dashboard link: focus it.
  useEffect(() => {
    actionRef.current?.focus();
  }, []);

  let title = "Review submitted";
  let subtitle = "The claim has been processed.";

  if (decision === "approve_full") {
    title = "Claim approved";
    subtitle = `Claim bundle ${id} is fully approved.`;
  } else if (decision === "approve_adjusted") {
    title = "Claim approved";
    subtitle = `Claim bundle ${id} is approved with your adjustments.`;
  } else if (decision === "reject") {
    title = "Claim rejected";
    subtitle = `You rejected claim bundle ${id}.`;
  } else if (decision === "confirm") {
    title = "Approval finalised";
    subtitle = `Claim bundle ${id} is finalised and the employee has been notified.`;
  } else if (decision === "flag") {
    title = "Claim flagged";
    subtitle = `Claim bundle ${id} is flagged for another review.`;
  }

  if (awaitingSecondApproval) {
    title = "Approval recorded";
    subtitle = "A second HR member must approve before the payout is sent.";
  }

  const tone = decision === "reject" ? "danger" : decision === "flag" ? "warning" : "success";
  const Icon = tone === "danger" ? ShieldX : tone === "warning" ? AlertTriangle : awaitingSecondApproval ? UserCheck : CheckCircle2;
  const iconColor = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-success";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-ink/40">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hr-success-title"
        aria-describedby="hr-success-desc"
        className="w-full max-w-md bg-surface rounded-dialog border border-line shadow-overlay flex flex-col items-center text-center p-8"
      >
        <Icon className={`w-10 h-10 mb-5 ${iconColor}`} strokeWidth={1.75} aria-hidden="true" />

        <h2 id="hr-success-title" className="font-display text-2xl font-semibold text-ink mb-2">
          {title}
        </h2>

        <p id="hr-success-desc" className="text-sm text-ink-muted font-body leading-relaxed max-w-xs mb-7">
          {subtitle}
        </p>

        <Link
          ref={actionRef}
          href="/hr/dashboard"
          className="flex items-center justify-center min-h-[44px] px-5 w-full rounded-full font-semibold text-sm font-body bg-accent text-on-accent hover:bg-accent-hover transition-colors"
        >
          Return to Dashboard
        </Link>
      </div>
    </div>
  );
}
