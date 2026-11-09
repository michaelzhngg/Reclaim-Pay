"use client";

import { useEffect, useRef, useState } from "react";
import { CheckCircle2 } from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProcessingScreenProps {
  /** Total number of uploaded receipts being processed. */
  totalFiles:   number;
  /** Index of the receipt currently being processed (0-based). */
  currentIndex: number;
  /**
   * Trail log step within the current receipt:
   *   0 = Scanning document
   *   1 = Reading content
   *   2 = Extracting data
   */
  currentStep:  number;
  /** Names of fully-completed receipts (for the log list below the stepper). */
  completedFileNames: string[];
  /** Current SSE progress stage name. */
  currentStage?: string;
  /** Live data payload from the current SSE progress stage. */
  stageData?: Record<string, unknown>;
}

// ─── Trail log steps ──────────────────────────────────────────────────────────

const TRAIL_STEPS = [
  {
    id:       "scan",
    label:    "Scanning document",
    subtitle: "Document image captured.",
  },
  {
    id:       "read",
    label:    "Reading content",
    subtitle: "Text layer extracted.",
  },
  {
    id:       "extract",
    label:    "Extracting data",
    subtitle: "Fields identified and mapped.",
  },
] as const;

// ─── Component ────────────────────────────────────────────────────────────────

export function ProcessingScreen({
  totalFiles,
  currentIndex,
  currentStep,
  completedFileNames,
  currentStage,
  stageData,
}: ProcessingScreenProps) {
  const [animPct, setAnimPct] = useState(0);
  const animRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    animRef.current = setInterval(() => {
      setAnimPct(prev => {
        if (prev >= 93) return prev;
        const bump = 0.3 + Math.random() * 0.8;
        return Math.min(Math.round(prev + bump), 93);
      });
    }, 180);

    return () => {
      if (animRef.current) clearInterval(animRef.current);
    };
  }, []);

  const realPct = stageData?.current != null && stageData?.total != null
    ? Math.round(((stageData.current as number) / (stageData.total as number)) * 100)
    : totalFiles > 0
      ? Math.round((currentIndex / totalFiles) * 100)
      : 0;

  const overallPct = currentStage === "complete" ? 100 : Math.max(animPct, realPct);

  const stageLabel = currentStage === "saving"
    ? "Saving your receipts..."
    : null;

  const receiptLine = `Receipt ${Math.min(currentIndex + 1, totalFiles)} of ${totalFiles}`;
  const fileName = stageData?.filename ? String(stageData.filename) : null;

  return (
    <div className="w-full max-w-xl mx-auto mt-6 md:mt-12">
      <section
        aria-labelledby="processing-title"
        className="rounded-card shadow-ambient bg-surface p-6 sm:p-8 flex flex-col gap-6"
      >
        <div className="flex flex-col gap-1">
          <h2 id="processing-title" className="font-display text-2xl font-semibold text-ink">
            Reading your receipts
          </h2>
          <p className="text-sm text-ink-muted font-body leading-relaxed">
            Please keep this window open.
          </p>
        </div>

        {/* Overall progress. The bar shows motion; the receipt count is the real number. */}
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-4">
            <p className="min-w-0 truncate text-sm font-semibold text-ink font-body">{fileName || receiptLine}</p>
            <p className="shrink-0 text-xs text-ink-muted font-mono">{receiptLine}</p>
          </div>
          <div aria-hidden="true" className="h-1.5 bg-surface-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-accent rounded-full transition-[width] duration-700 ease-out motion-reduce:transition-none"
              style={{ width: `${overallPct}%` }}
            />
          </div>
          <p role="status" className="text-xs text-ink-muted font-body">
            {stageLabel || "Reading the text and amounts on each receipt."}
          </p>
        </div>

        {/* Steps for the current receipt */}
        <ol className="flex flex-col gap-3">
          {TRAIL_STEPS.map((step, idx) => {
            const isCompleted = idx < currentStep;
            const isActive = idx === currentStep;
            return (
              <li key={step.id} className="flex items-start gap-3">
                <span aria-hidden="true" className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center">
                  {isCompleted ? (
                    <CheckCircle2 className="h-5 w-5 text-ink" strokeWidth={1.75} />
                  ) : (
                    <span className={`h-3 w-3 rounded-full border-2 ${isActive ? "border-accent bg-accent" : "border-line-strong"}`} />
                  )}
                </span>
                <div>
                  <p className={`text-sm font-body ${isActive ? "font-semibold text-ink" : isCompleted ? "text-ink" : "text-ink-muted"}`}>
                    {step.label}
                    <span className="sr-only">{isCompleted ? ": done" : isActive ? ": in progress" : ": not started"}</span>
                  </p>
                  {(isCompleted || isActive) && (
                    <p className="text-xs text-ink-muted font-body mt-0.5">{step.subtitle}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        {/* Completed receipts log */}
        {completedFileNames.length > 0 && (
          <div className="pt-4 border-t border-line">
            <h3 className="text-xs font-semibold text-ink-muted font-body mb-2">Completed</h3>
            <ul className="flex flex-col gap-1.5 max-h-28 overflow-y-auto pr-1">
              {completedFileNames.map((name, i) => (
                <li key={i} className="flex items-center gap-2 text-xs font-body text-ink-muted">
                  <CheckCircle2 className="w-3.5 h-3.5 text-ink shrink-0" strokeWidth={2} aria-hidden="true" />
                  <span className="truncate">{name}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </section>
    </div>
  );
}
