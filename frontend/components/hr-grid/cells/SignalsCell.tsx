import type { Severity } from "@/lib/api/reclaim-pay-types";
import { SIGNAL_LABEL, type TriageSignal } from "../rows";

const SEVERITY_TONE: Record<Severity, string> = {
  HIGH: "bg-danger-soft text-danger border-danger/30",
  MEDIUM: "bg-warning-soft text-warning border-warning/30",
  LOW: "bg-surface-muted text-ink-muted border-line",
};

const SEVERITY_WORD: Record<Severity, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

const MAX_CHIPS = 3;

/** Up to three chips, most severe first, then "+N" for the rest. */
export function SignalChips({ signals }: { signals: TriageSignal[] }) {
  if (signals.length === 0) return <span className="text-xs text-ink-muted">None</span>;

  const shown = signals.slice(0, MAX_CHIPS);
  const hidden = signals.slice(MAX_CHIPS);

  return (
    <ul className="flex flex-wrap items-center gap-1 py-1" aria-label="Risk signals">
      {shown.map((s) => (
        <li
          key={s.code}
          title={`${SEVERITY_WORD[s.severity]} risk: ${SIGNAL_LABEL[s.code]}`}
          className={`max-w-[11rem] truncate px-1.5 py-0.5 rounded border text-xs font-semibold leading-4 ${SEVERITY_TONE[s.severity]}`}
        >
          <span className="sr-only">{SEVERITY_WORD[s.severity]} risk: </span>
          {SIGNAL_LABEL[s.code]}
        </li>
      ))}
      {hidden.length > 0 && (
        <li
          title={hidden.map((s) => SIGNAL_LABEL[s.code]).join(", ")}
          className="px-1.5 py-0.5 rounded border border-line text-xs font-semibold leading-4 text-ink-muted"
        >
          <span aria-hidden="true">+{hidden.length}</span>
          <span className="sr-only">and {hidden.length} more: {hidden.map((s) => SIGNAL_LABEL[s.code]).join(", ")}</span>
        </li>
      )}
    </ul>
  );
}
