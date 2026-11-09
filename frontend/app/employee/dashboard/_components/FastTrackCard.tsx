import type { TrustInfo } from "@/lib/api/reclaim-pay-types";
import { isTopTier, limitLine, tierLabel, trustLine, trustProgress, trustReasonLine } from "../_lib/copy";

/**
 * How fast this employee's claims get paid. Shows the tier, the auto-pay limit
 * and the way to the next tier. Never shows risk scores or signal names.
 */
export default function FastTrackCard({ info }: { info: TrustInfo }) {
  const limited = trustReasonLine(info);
  const top = isTopTier(info);
  const pct = Math.round(trustProgress(info) * 100);

  return (
    <section
      aria-labelledby="fast-track-heading"
      className="rounded-card shadow-ambient bg-surface p-4 md:p-5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <h3 id="fast-track-heading" className="font-display text-base font-semibold text-ink">
          Fast-track
        </h3>
        <p className="font-body text-sm font-semibold text-ink">{tierLabel(info.trust_tier)}</p>
      </div>

      <p className="mt-1.5 font-body text-sm leading-relaxed text-pretty text-ink">
        {limited ? limitLine(info) : trustLine(info)}
      </p>
      {limited && <p className="mt-1 font-body text-sm leading-relaxed text-ink-muted">{limited}</p>}

      {/* The sentence above carries the meaning; the bar repeats it visually. */}
      {!limited && !top && (
        <div aria-hidden className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted">
          <div className="h-full rounded-full bg-linear-to-r from-primary to-paypal-sky" style={{ width: `${pct}%` }} />
        </div>
      )}
    </section>
  );
}

export function FastTrackCardSkeleton() {
  return <div aria-hidden className="h-24 rounded-card bg-surface-muted motion-safe:animate-pulse" />;
}
