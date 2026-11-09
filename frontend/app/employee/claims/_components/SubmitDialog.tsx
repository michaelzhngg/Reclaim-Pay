"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import AgentTimeline from "@/components/timeline/AgentTimeline";
import { employeeSafeSteps } from "@/components/timeline/copy";
import type { TimelineStepState } from "@/lib/api/reclaim-pay-types";
import type { AnalyzeResponse } from "@/lib/api/types";
import { ClaimDialog } from "./ClaimDialog";
import { SuccessContent } from "./SuccessModal";
import type { SubmitPhase } from "./submitDialogState";

interface SubmitDialogProps {
  phase: SubmitPhase;
  /** Merchant line for the claim being checked. */
  claimTitle: string;
  /** Claim total, already formatted (for example "MYR 48.00"). */
  amount: string;
  /** Live timeline rows for the employee. */
  steps: TimelineStepState[];
  error: string | null;
  /** True after someone tried to close mid-check. */
  showLeaveNotice: boolean;
  /** Escape or the close button. */
  onCloseAttempt: () => void;
  onRetry: () => void;
  onBackToForm: () => void;
  onLeave: () => void;
  onSubmitAnother: () => void;
  reimbursements: AnalyzeResponse[];
  fallbackFocus?: () => HTMLElement | null;
}

const TITLE_ID: Record<Exclude<SubmitPhase, "closed">, string> = {
  checking: "submit-checking-title",
  result: "success-title",
  error: "submit-error-title",
};

const secondaryBtn =
  "inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-surface px-5 text-sm font-semibold text-ink hover:bg-surface-muted transition-colors";
const primaryBtn =
  "inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-sm font-semibold text-on-accent hover:bg-accent-hover transition-colors";

/**
 * One dialog for the whole submit: it opens on Submit, shows the agent's checks
 * as they arrive, then turns into the result, or into an error with a way back.
 */
export function SubmitDialog({
  phase,
  claimTitle,
  amount,
  steps,
  error,
  showLeaveNotice,
  onCloseAttempt,
  onRetry,
  onBackToForm,
  onLeave,
  onSubmitAnother,
  reimbursements,
  fallbackFocus,
}: SubmitDialogProps) {
  const open = phase !== "closed";
  const titleId = open ? TITLE_ID[phase] : TITLE_ID.checking;
  const body = useRef<HTMLDivElement>(null);
  const retryRef = useRef<HTMLButtonElement>(null);

  // Each new state names itself: focus moves to its heading (or to "Try again" on an error).
  useEffect(() => {
    if (phase === "closed") return;
    const target = phase === "error" ? retryRef.current : body.current?.querySelector<HTMLElement>(`#${TITLE_ID[phase]}`);
    target?.focus();
  }, [phase]);

  const safeSteps = employeeSafeSteps(steps);

  return (
    <ClaimDialog open={open} labelledBy={titleId} onCancel={onCloseAttempt} fallbackFocus={fallbackFocus} className="max-w-lg">
      <div ref={body} className="relative p-5 sm:p-6">
        <button
          type="button"
          onClick={onCloseAttempt}
          aria-label="Close"
          className="absolute right-3 top-3 inline-flex h-11 w-11 items-center justify-center rounded-control text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </button>

        {phase === "checking" && (
          <div className="flex flex-col gap-5">
            <h2 id={TITLE_ID.checking} tabIndex={-1} className="pr-12 font-display text-xl font-semibold text-ink outline-none">
              Checking your claim
            </h2>

            <div className="flex items-baseline justify-between gap-4">
              <p className="min-w-0 truncate font-body text-sm font-semibold text-ink">{claimTitle}</p>
              <p className="shrink-0 font-mono text-lg font-medium text-ink">{amount}</p>
            </div>

            <hr className="perforated" />

            {safeSteps.length > 0 ? (
              <AgentTimeline steps={safeSteps} />
            ) : (
              <p role="status" className="font-body text-sm text-ink-muted">
                Reading your claim...
              </p>
            )}

            {showLeaveNotice && (
              <div role="status" className="flex flex-col gap-3 rounded-card shadow-ambient bg-surface-muted p-4 sm:flex-row sm:items-center sm:justify-between">
                <p className="font-body text-sm text-ink">You can leave this page, we&apos;ll notify you.</p>
                <button type="button" onClick={onLeave} className={`${secondaryBtn} shrink-0`}>
                  Go to Dashboard
                </button>
              </div>
            )}
          </div>
        )}

        {phase === "error" && (
          <div className="flex flex-col gap-5">
            <h2 id={TITLE_ID.error} className="pr-12 font-display text-xl font-semibold text-ink">
              We couldn&apos;t check your claim
            </h2>
            <div className="flex flex-col gap-1">
              <p role="alert" className="font-body text-sm text-danger">
                {error ?? "Something went wrong while submitting."}
              </p>
              <p className="font-body text-sm text-ink-muted">Nothing you entered was lost.</p>
            </div>
            <div className="flex flex-col-reverse gap-3 sm:flex-row">
              <button type="button" onClick={onBackToForm} className={`${secondaryBtn} flex-1`}>
                Back to the form
              </button>
              <button ref={retryRef} type="button" onClick={onRetry} className={`${primaryBtn} flex-1`}>
                Try again
              </button>
            </div>
          </div>
        )}

        {phase === "result" && (
          <SuccessContent
            type="claim"
            titleId={TITLE_ID.result}
            onSubmitAnother={onSubmitAnother}
            reimbursements={reimbursements}
            timeline={steps}
          />
        )}
      </div>
    </ClaimDialog>
  );
}
