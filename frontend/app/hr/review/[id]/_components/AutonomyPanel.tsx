import { formatMoney } from "@/lib/format";
import { TierPill } from "@/components/hr-grid/cells/TierCell";
import {
  approvalProgress,
  hardStopLabel,
  scoreBreakdown,
  sortSignals,
  summarySentence,
  type ClaimAutonomy,
} from "@/lib/hr/evidence";
import { SignalEvidence } from "./SignalEvidence";

const SHELL = "bg-surface shadow-ambient rounded-card overflow-hidden";
const SUBHEAD = "text-sm font-semibold text-ink mb-2";

/**
 * "Why this needs you": the autonomy engine's decision with its evidence. It
 * replaces the old confidence gauge, which no longer decides anything.
 */
export function AutonomyPanel({
  autonomy,
  aiSummary,
  aiVerdict,
}: {
  autonomy: ClaimAutonomy | null | undefined;
  /** The AI's own summary of the claim, shown when the engine has nothing to add. */
  aiSummary: string;
  aiVerdict: string;
}) {
  if (!autonomy) {
    return (
      <section aria-labelledby="autonomy-heading" className={SHELL}>
        <div className="px-4 sm:px-6 py-4 border-b border-line">
          <h3 id="autonomy-heading" className="font-display font-semibold text-base text-ink">AI Analysis</h3>
        </div>
        <div className="p-4 sm:p-6 flex flex-col gap-3">
          <p className="text-sm font-semibold text-ink">No automated decision recorded for this claim</p>
          <p className="text-sm text-ink-muted">
            There is no tier or risk score to show. Review the receipts and decide below.
          </p>
          {aiVerdict && (
            <p className="text-sm text-ink">
              <span className="text-ink-muted">AI recommendation: </span>
              <span className="font-semibold">{aiVerdict}</span>
            </p>
          )}
          {aiSummary && <p className="text-sm text-ink leading-relaxed">{aiSummary}</p>}
        </div>
      </section>
    );
  }

  const d = autonomy.decision;
  const breakdown = scoreBreakdown(d);
  const stops = d.hard_stops ?? [];
  const signals = sortSignals(d.signals ?? []);
  const progress = approvalProgress(autonomy.approvals, autonomy.tier);
  const score = Math.max(0, Math.min(100, Math.round(autonomy.riskScore)));
  const showAiSummary = aiSummary && aiSummary !== d.explanation;

  return (
    <section aria-labelledby="autonomy-heading" className={SHELL}>
      <div className="px-4 sm:px-6 py-4 border-b border-line">
        <h3 id="autonomy-heading" className="font-display font-semibold text-base text-ink">
          {autonomy.tier === "AUTO_PAY" ? "Why this was paid automatically" : "Why this needs you"}
        </h3>
      </div>

      <div className="p-4 sm:p-6 flex flex-col gap-5">
        <div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <TierPill tier={autonomy.tier} />
            <span className="text-sm font-semibold text-ink">
              Risk <span className="font-mono">{score}/100</span>
            </span>
          </div>
          <p className="mt-3 text-sm text-ink leading-relaxed">{summarySentence(autonomy)}</p>
          {progress && (
            <p className="mt-3 rounded-control bg-surface-muted px-3 py-2 text-sm font-semibold text-ink" role="status">
              {progress}
            </p>
          )}
          {d.audit_selected && (
            <p className="mt-2 text-sm text-ink-muted">Picked for a random audit after payment.</p>
          )}
        </div>

        {stops.length > 0 && (
          <div>
            <h4 className={SUBHEAD}>Why it was not paid automatically</h4>
            <ul className="flex flex-col gap-1.5">
              {stops.map((s) => (
                <li key={s} className="rounded-control border border-line px-3 py-1.5 text-sm text-ink">
                  {hardStopLabel(s)}
                </li>
              ))}
            </ul>
          </div>
        )}

        {breakdown.length > 0 && (
          <div>
            <h4 className={SUBHEAD}>How the score adds up</h4>
            <dl className="text-sm">
              {breakdown.map((row) => (
                <div key={row.label} className="flex items-baseline justify-between gap-4 py-0.5">
                  <dt className="text-ink-muted min-w-0">{row.label}</dt>
                  <dd className="font-mono font-medium text-ink">+{row.points}</dd>
                </div>
              ))}
              <div className="mt-1 flex items-baseline justify-between gap-4 border-t border-line pt-1">
                <dt className="font-semibold text-ink">Risk score{breakdown.reduce((n, r) => n + r.points, 0) > score ? " (capped at 100)" : ""}</dt>
                <dd className="font-mono font-semibold text-ink">{score}</dd>
              </div>
            </dl>
            {typeof d.expected_loss === "number" && d.expected_loss > 0 && (
              <p className="mt-2 text-xs text-ink-muted">
                Expected loss if paid without review: <span className="font-mono">{formatMoney(autonomy.currency, d.expected_loss)}</span>
              </p>
            )}
          </div>
        )}

        {signals.length > 0 && (
          <div>
            <h4 className={SUBHEAD}>Evidence</h4>
            <div className="flex flex-col gap-3">
              {signals.map((s, i) => (
                <SignalEvidence key={`${s.code}-${i}`} id={`signal-${i}`} signal={s} currency={autonomy.currency} />
              ))}
            </div>
          </div>
        )}

        {showAiSummary && (
          <div>
            <h4 className={SUBHEAD}>AI notes</h4>
            <p className="text-sm text-ink leading-relaxed">{aiSummary}</p>
          </div>
        )}
      </div>
    </section>
  );
}
