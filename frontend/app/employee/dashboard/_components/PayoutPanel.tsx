import type { DashboardStats } from "@/lib/api/types";
import type { TrustInfo } from "@/lib/api/reclaim-pay-types";
import BadgeBlock, { BadgeBlockSkeleton } from "./BadgeBlock";

const PLACEHOLDER = "MYR …";

function claimsLine(count: number | undefined, verb: string): string {
  const n = count ?? 0;
  return `${n} ${n === 1 ? "claim" : "claims"} ${verb}`;
}

interface Props {
  /** undefined while loading, null when the endpoint failed: the badge column then drops out. */
  trust: TrustInfo | null | undefined;
  stats: DashboardStats | null;
  /** False on first run, when there are no totals yet and only the badge shows. */
  showTotals?: boolean;
  className?: string;
}

/**
 * One panel for how fast claims get paid and where the money stands: the badge on
 * the left, money in review on the dark block, and the two settled totals under it.
 * Amounts use tabular figures so they line up like a receipt.
 */
export default function PayoutPanel({ trust, stats, showTotals = true, className = "" }: Props) {
  const badge = trust === undefined ? <BadgeBlockSkeleton /> : trust && <BadgeBlock info={trust} />;

  if (!showTotals) {
    if (trust === null) return null;
    return <section aria-label="Instant payouts" className={`rounded-card bg-surface shadow-ambient ${className}`}>{badge}</section>;
  }

  const secondary = [
    {
      label: "Reimbursed this month",
      amount: stats?.reimbursedThisMonth.amount ?? PLACEHOLDER,
      note: claimsLine(stats?.reimbursedThisMonth.count, "settled"),
    },
    {
      label: "Already paid",
      amount: stats?.alreadyPaid.amount ?? PLACEHOLDER,
      note: claimsLine(stats?.alreadyPaid.count, "paid"),
    },
  ];

  return (
    <section
      aria-label="Instant payouts and totals"
      aria-busy={stats === null || trust === undefined}
      className={`overflow-hidden rounded-card bg-surface shadow-ambient ${trust !== null ? "md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]" : ""} ${className}`}
    >
      {trust !== null && <div className="border-b border-line md:border-b-0 md:border-r">{badge}</div>}

      <div className="flex min-w-0 flex-col">
        <div className="mesh-ink relative isolate flex-1 overflow-hidden p-6 text-white md:p-7">
          <div
            aria-hidden="true"
            className="absolute -right-24 -top-24 -z-10 h-72 w-72 rounded-full"
            style={{ background: "radial-gradient(closest-side, rgb(0 156 222 / 0.45), transparent)" }}
          />
          <h3 className="font-body text-sm font-medium text-white/65">Awaiting review</h3>
          <p className="mt-2 font-headline text-4xl font-medium tabular-nums tracking-[-0.03em] text-white break-words md:text-5xl">
            {stats?.awaitingReview.amount ?? PLACEHOLDER}
          </p>
          <p className="mt-3 inline-flex items-center gap-2 font-body text-sm text-white/65">
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-paypal-sky" />
            {claimsLine(stats?.awaitingReview.count, "processing")}
          </p>
        </div>

        <div className="grid grid-cols-2 divide-x divide-line">
          {secondary.map(item => (
            <div key={item.label} className="min-w-0 px-4 py-4 md:px-6 md:py-5">
              <h3 className="font-body text-sm text-ink">{item.label}</h3>
              <p className="mt-1 font-headline text-lg font-medium tabular-nums tracking-[-0.02em] text-ink break-words md:text-xl">
                {item.amount}
              </p>
              <p className="mt-0.5 font-body text-xs text-ink-muted">{item.note}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
