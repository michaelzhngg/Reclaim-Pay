"use client";

import { motion, useReducedMotion } from "framer-motion";
import { AlertTriangle, CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { TimelineStatus, TimelineStepState } from "@/lib/api/reclaim-pay-types";

const STATUS_STYLE: Record<TimelineStatus, { icon: typeof CheckCircle2; className: string; srLabel: string }> = {
  running: { icon: Loader2, className: "text-accent animate-spin motion-reduce:animate-none", srLabel: "In progress" },
  done: { icon: CheckCircle2, className: "text-ink", srLabel: "Done" },
  warn: { icon: AlertTriangle, className: "text-warning", srLabel: "Needs attention" },
  fail: { icon: XCircle, className: "text-danger", srLabel: "Failed" },
};

interface AgentTimelineProps {
  steps: TimelineStepState[];
  /** Heading shown above the list. */
  title?: string;
  className?: string;
}

/**
 * The checks the agent runs on a claim, one row per step as it arrives.
 * Steps come pre-filtered for the audience by `reduceTimeline`.
 */
export default function AgentTimeline({ steps, title = "What the agent is checking", className = "" }: AgentTimelineProps) {
  const reduceMotion = useReducedMotion();

  return (
    <section aria-label={title} className={`w-full text-left ${className}`}>
      <h3 className="font-display font-semibold text-sm text-ink mb-3">{title}</h3>
      <ol aria-live="polite" className="flex flex-col gap-2.5">
        {steps.map(s => {
          const { icon: Icon, className: iconClass, srLabel } = STATUS_STYLE[s.status];
          return (
            <motion.li
              key={s.step}
              // Rows fade in as the agent reaches each check, so progress reads as sequence. No movement, no bounce.
              initial={reduceMotion ? false : { opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ duration: 0.15, ease: "linear" }}
              className="flex items-start gap-3"
            >
              <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${iconClass}`} aria-hidden="true" />
              <div className="min-w-0">
                <p className="font-body text-sm text-ink">
                  {s.label}
                  <span className="sr-only">: {srLabel}</span>
                </p>
                {s.detail && (
                  <p className="font-body text-xs text-ink-muted break-words">{s.detail}</p>
                )}
              </div>
            </motion.li>
          );
        })}
      </ol>
    </section>
  );
}
