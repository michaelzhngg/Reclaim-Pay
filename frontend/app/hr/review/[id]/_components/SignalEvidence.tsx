import Link from "next/link";
import type { RiskSignal, Severity } from "@/lib/api/reclaim-pay-types";
import { SEVERITY_LABEL, signalEvidence, signalLabel } from "@/lib/hr/evidence";

// Severity is a small written label; the text colour only backs it up.
const SEVERITY_TONE: Record<Severity, string> = {
  HIGH: "text-danger",
  MEDIUM: "text-warning",
  LOW: "text-ink-muted",
};

const FOCUS = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/** One signal: what was found, how many points it added, and the evidence behind it. */
export function SignalEvidence({ id, signal, currency }: { id: string; signal: RiskSignal; currency: string }) {
  const view = signalEvidence(signal, currency);
  const headingId = `${id}-heading`;

  return (
    <article aria-labelledby={headingId} className="rounded-card shadow-ambient bg-surface p-4 min-w-0">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h5 id={headingId} className="font-body font-semibold text-sm text-ink">
          {signalLabel(signal.code)}
        </h5>
        <span className="flex items-baseline gap-2 text-xs">
          <span className={`font-semibold ${SEVERITY_TONE[signal.severity] ?? SEVERITY_TONE.LOW}`}>
            {SEVERITY_LABEL[signal.severity] ?? signal.severity} severity
          </span>
          {signal.points > 0 && <span className="font-mono text-ink-muted">+{signal.points}</span>}
        </span>
      </div>

      {signal.message && <p className="mt-2 text-sm text-ink leading-relaxed">{signal.message}</p>}
      {view.note && <p className="mt-2 text-sm text-ink leading-relaxed">{view.note}</p>}

      {view.snippets.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-semibold text-ink-muted mb-1">Text found on the receipt</p>
          {view.snippets.map((s, i) => (
            <pre
              key={i}
              className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere] rounded-control bg-surface-muted px-3 py-2 font-mono text-xs text-ink"
            >
              {s}
            </pre>
          ))}
        </div>
      )}

      {view.facts.length > 0 && (
        <dl className="mt-3 divide-y divide-line border-y border-line text-sm">
          {view.facts.map((f) => (
            <div key={f.label} className="flex items-baseline justify-between gap-4 py-1.5">
              <dt className="text-ink-muted min-w-0">{f.label}</dt>
              <dd className={`text-right font-mono min-w-0 break-words ${f.emphasis ? "font-semibold text-danger" : "font-medium text-ink"}`}>
                {f.value}
              </dd>
            </div>
          ))}
        </dl>
      )}

      {view.claims.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 text-sm">
          <span className="text-ink-muted">
            {signal.code === "DUPLICATE_RECEIPT" ? "Matches earlier claim" : "Related claims"}
          </span>
          {view.claims.map((c) => (
            <Link
              key={c.href}
              href={c.href}
              className={`inline-flex min-h-11 items-center font-mono font-medium text-ink underline underline-offset-2 hover:text-accent-hover rounded ${FOCUS}`}
            >
              {c.ref}
            </Link>
          ))}
        </div>
      )}
    </article>
  );
}
