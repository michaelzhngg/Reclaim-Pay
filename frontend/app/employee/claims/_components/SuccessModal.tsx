"use client";

import { ChevronDown } from "lucide-react";
import Link from "next/link";
import AgentTimeline from "@/components/timeline/AgentTimeline";
import DecisionCard from "@/components/timeline/DecisionCard";
import MoneyFlow from "@/components/timeline/MoneyFlow";
import { employeeSafeSteps } from "@/components/timeline/copy";
import { formatMoney, type AutonomyDecision, type TimelineStepState } from "@/lib/api/reclaim-pay-types";
import type { AnalyzeResponse } from "@/lib/api/types";

export type SuccessType = "claim" | "hr";

interface SuccessContentProps {
  type: SuccessType;
  onSubmitAnother: () => void;
  /** Reimbursements from the analysis `complete` event. One submission can create two. */
  reimbursements?: AnalyzeResponse[];
  /** Timeline rows already filtered for the employee. */
  timeline?: TimelineStepState[];
  /** id for the heading, so the surrounding dialog can name itself after it. */
  titleId?: string;
}

function decisionOf(r: AnalyzeResponse): AutonomyDecision | null {
  const a = r.autonomy;
  return a && typeof a === "object" && "tier" in a ? (a as AutonomyDecision) : null;
}

const secondaryBtn =
  "flex-1 inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-surface px-5 text-sm font-semibold text-ink hover:bg-surface-muted transition-colors";
const primaryBtn =
  "flex-1 inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-sm font-semibold text-on-accent hover:bg-accent-hover transition-colors";

/**
 * The result of a submitted claim: tier label, payment steps, the checks one
 * click away, and what to do next. Rendered inside the submit dialog.
 */
export function SuccessContent({
  type,
  onSubmitAnother,
  reimbursements = [],
  timeline = [],
  titleId = "success-title",
}: SuccessContentProps) {
  const isHr = type === "hr";
  const claims = isHr ? [] : reimbursements;
  const hasDecision = claims.some(r => decisionOf(r) !== null);
  const multiple = claims.length > 1;
  const steps = employeeSafeSteps(timeline);

  return (
    <div className="flex flex-col gap-5">
      <h2 id={titleId} tabIndex={-1} className="pr-12 font-display text-xl font-semibold text-ink outline-none">
        {isHr ? "Sent to HR" : "Claim submitted"}
      </h2>

      {hasDecision ? (
        <div className="flex flex-col gap-3">
          {claims.map((r, i) => {
            const decision = decisionOf(r);
            const amount = formatMoney(r.currency, r.total_approved_amount ?? r.total_claimed_amount);
            const caption = multiple ? `Claim ${i + 1} of ${claims.length} · ${r.main_category}` : undefined;
            return (
              <div key={r.reim_id} className="flex flex-col gap-3">
                {decision ? (
                  <DecisionCard decision={decision} amount={amount} audience="employee" caption={caption} />
                ) : (
                  caption && <p className="font-body text-xs text-ink-muted">{caption}</p>
                )}
                <MoneyFlow reimId={r.reim_id} claimStatus={r.status} tier={decision?.tier} />
              </div>
            );
          })}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-1">
            <p className="text-sm text-ink-muted font-body leading-relaxed">
              {isHr
                ? "Your claim and documents have been forwarded to the HR team for manual review."
                : "Your expense claim has been submitted for approval."}
            </p>
            <p className="text-sm text-ink-muted font-body leading-relaxed">
              {isHr
                ? "You'll be notified once they complete the verification."
                : "You'll be notified once it's reviewed by your manager."}
            </p>
          </div>

          {!isHr && (
            <p className="rounded-card shadow-ambient bg-surface-muted px-4 py-3 text-xs text-ink font-body leading-relaxed">
              Policy compliance check is running in the background. No action needed from you.
            </p>
          )}

          {claims.length > 0 && (
            <div className="flex flex-col gap-3">
              {claims.map((r, i) => (
                <div key={r.reim_id} className="flex flex-col gap-2">
                  {multiple && (
                    <p className="font-body text-xs text-ink-muted">
                      Claim {i + 1} of {claims.length} · {r.main_category}
                    </p>
                  )}
                  <MoneyFlow reimId={r.reim_id} claimStatus={r.status} tier={r.tier ?? undefined} />
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* The checks stay one click away: the outcome is the focus, the trail is there for anyone who asks. */}
      {steps.length > 0 && (
        <details className="group rounded-card shadow-ambient">
          <summary className="flex min-h-11 list-none items-center justify-between gap-2 rounded-card px-4 font-body text-sm font-semibold text-ink hover:bg-surface-muted [&::-webkit-details-marker]:hidden">
            See what the agent checked
            <ChevronDown className="w-4 h-4 shrink-0 group-open:rotate-180" aria-hidden="true" />
          </summary>
          <div className="px-4 pb-4 pt-1">
            <AgentTimeline steps={steps} title="Checks on this claim" />
          </div>
        </details>
      )}

      <div className="flex flex-col-reverse sm:flex-row gap-3">
        <button type="button" onClick={onSubmitAnother} className={secondaryBtn}>
          Submit another
        </button>
        <Link href="/employee/dashboard" className={primaryBtn}>
          Go to Dashboard
        </Link>
      </div>
    </div>
  );
}
