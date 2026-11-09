import type { DashboardStats } from "@/lib/api/types";

const PLACEHOLDER = "MYR …";

function claimsLine(count: number | undefined, verb: string): string {
  const n = count ?? 0;
  return `${n} ${n === 1 ? "claim" : "claims"} ${verb}`;
}

/**
 * The three totals as one panel, ordered by importance: money still in review
 * leads on a dark card, the two settled totals sit beside it as a quieter list.
 * Amounts use tabular figures so they line up like a receipt.
 */
export default function StatSummary({ stats }: { stats: DashboardStats | null }) {
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
      aria-label="Key metrics"
      aria-busy={stats === null}
      className="mb-6 md:mb-10 overflow-hidden rounded-card shadow-ambient bg-surface md:grid md:grid-cols-[3fr_2fr]"
    >
      <div className="mesh-ink relative isolate overflow-hidden p-6 text-white md:p-7">
        <div
          aria-hidden="true"
          className="absolute -right-24 -top-24 -z-10 h-72 w-72 rounded-full"
          style={{ background: "radial-gradient(closest-side, rgb(0 156 222 / 0.45), transparent)" }}
        />
        <h3 className="font-body text-sm font-medium text-white/65">Awaiting review</h3>
        <p className="mt-2 font-headline tabular-nums tracking-[-0.03em] text-4xl md:text-5xl font-medium text-white break-words">
          {stats?.awaitingReview.amount ?? PLACEHOLDER}
        </p>
        <p className="mt-3 inline-flex items-center gap-2 font-body text-sm text-white/65">
          <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-paypal-sky" />
          {claimsLine(stats?.awaitingReview.count, "processing")}
        </p>
      </div>

      <div className="flex flex-col justify-center divide-y divide-line">
        {secondary.map(item => (
          <div key={item.label} className="flex items-baseline justify-between gap-4 px-5 py-5 md:px-6">
            <div className="min-w-0">
              <p className="font-body text-sm text-ink">{item.label}</p>
              <p className="font-body text-xs text-ink-muted mt-0.5">{item.note}</p>
            </div>
            <p className="font-headline tabular-nums tracking-[-0.02em] text-lg md:text-xl font-medium text-ink text-right shrink-0">
              {item.amount}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
