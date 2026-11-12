"use client";

import { Suspense, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowUpRight, FileBarChart, Loader2, RefreshCw, Sparkles, TriangleAlert } from "lucide-react";
import { getMonthlyReport, regenerateMonthlyReport } from "@/lib/actions/reports";
import type { MonthlyReport } from "@/lib/api/reclaim-pay-types";
import { historyTime } from "@/app/hr/autonomy/_lib/settingsHistory";
import { barRows, codeLabel, defaultMonth, isMonth, kpiItems, monthOptions } from "./_lib/report";

type Load = { state: "loading" } | { state: "failed"; error: string } | { state: "ready"; report: MonthlyReport };

// useSearchParams needs a Suspense boundary so the page can still be prerendered.
export default function ReportsPage() {
  return (
    <Suspense>
      <Reports />
    </Suspense>
  );
}

function Reports() {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [now] = useState(() => new Date());
  const options = useMemo(() => monthOptions(now), [now]);
  const asked = params.get("month");
  const month = isMonth(asked) ? asked : defaultMonth(now);

  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [loadedMonth, setLoadedMonth] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [rebuilding, setRebuilding] = useState(false);
  const [rebuildError, setRebuildError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getMonthlyReport(month)
      .then(({ report, error }) => {
        if (cancelled) return;
        setLoadedMonth(month);
        setLoad(report ? { state: "ready", report } : { state: "failed", error: error ?? "Couldn't load the report." });
      })
      .catch(() => {
        if (!cancelled) setLoad({ state: "failed", error: "Couldn't load the report." });
      });
    return () => {
      cancelled = true;
    };
  }, [month, attempt]);

  const showing: Load = loadedMonth === month ? load : { state: "loading" };

  async function rebuild() {
    setRebuilding(true);
    setRebuildError(null);
    const { report, error } = await regenerateMonthlyReport(month).catch(() => ({ report: null, error: "Couldn't rebuild the report." }));
    setRebuilding(false);
    if (report) setLoad({ state: "ready", report });
    else setRebuildError(error);
  }

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <header className="mb-5 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">Month-end report</h1>
          <p className="mt-1 text-sm text-ink-muted">
            What was reimbursed, how much the agent paid on its own, and what it caught. Click any number to see the claims behind it.
          </p>
        </div>
        <label className="flex flex-col gap-1 text-xs font-semibold text-ink-muted shrink-0">
          Month
          <select
            value={month}
            onChange={(e) => router.replace(`${pathname}?month=${e.target.value}`, { scroll: false })}
            className="min-h-[44px] bg-surface border border-line-strong rounded-control px-3 text-sm font-medium text-ink outline-none focus:border-accent cursor-pointer"
          >
            {!options.some((o) => o.value === month) && <option value={month}>{month}</option>}
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
      </header>

      {showing.state === "loading" && (
        <div role="status" className="bg-surface shadow-ambient rounded-card px-6 py-10 flex items-center gap-2 text-sm text-ink-muted">
          <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          Building the report…
        </div>
      )}

      {showing.state === "failed" && (
        <div role="alert" className="bg-surface shadow-ambient rounded-card px-6 py-6 flex flex-wrap items-center gap-3 text-sm">
          <span className="text-ink">{showing.error}</span>
          <button
            type="button"
            onClick={() => {
              setLoadedMonth(null);
              setAttempt((n) => n + 1);
            }}
            className="min-h-[44px] px-4 rounded-control border border-line-strong text-ink font-semibold hover:bg-surface-muted cursor-pointer"
          >
            Try again
          </button>
        </div>
      )}

      {showing.state === "ready" && (
        <ReportBody report={showing.report} rebuilding={rebuilding} rebuildError={rebuildError} onRebuild={rebuild} />
      )}
    </div>
  );
}

function NumberLink({ href, children, label }: { href: string; children: React.ReactNode; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      className="font-mono font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent focus-visible:outline-2 focus-visible:outline-accent rounded-sm"
    >
      {children}
    </Link>
  );
}

function ReportBody({
  report,
  rebuilding,
  rebuildError,
  onRebuild,
}: {
  report: MonthlyReport;
  rebuilding: boolean;
  rebuildError: string | null;
  onRebuild: () => void;
}) {
  const m = report.metrics;
  const kpis = kpiItems(m);
  const categories = barRows(m.by_category, m.reimbursed.value, m.currency);
  const teams = barRows(m.by_team, m.reimbursed.value, m.currency);

  return (
    <div className="flex flex-col gap-6">
      {/* Summary */}
      <section aria-labelledby="summary-title" className="bg-surface shadow-ambient rounded-card px-4 sm:px-6 py-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 id="summary-title" className="font-display font-semibold text-lg text-ink">{m.label}</h2>
          <span className="inline-flex items-center gap-1.5 text-xs text-ink-muted">
            {report.narrative_source === "model" ? (
              <>
                <Sparkles className="w-3.5 h-3.5" aria-hidden="true" />
                Written by AI. Every number was checked against the figures below.
              </>
            ) : (
              <>
                <FileBarChart className="w-3.5 h-3.5" aria-hidden="true" />
                Summary built from the figures below.
              </>
            )}
          </span>
        </div>
        <p className="mt-3 font-body text-base text-ink leading-relaxed max-w-3xl">{report.narrative}</p>
        <div className="mt-4 pt-4 border-t border-line flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-ink-muted">
          <span>
            {report.final ? "Generated" : "Month in progress, figures as of"} {historyTime(report.generated_at)}. Months follow {m.timezone}. Amounts in {m.currency}.
          </span>
          {report.final && (
            <button
              type="button"
              onClick={onRebuild}
              disabled={rebuilding}
              className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-control border border-line-strong text-ink text-sm font-semibold hover:bg-surface-muted disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`w-4 h-4 ${rebuilding ? "animate-spin" : ""}`} aria-hidden="true" />
              {rebuilding ? "Rebuilding…" : "Regenerate"}
            </button>
          )}
          {rebuildError && <span role="alert" className="text-danger">{rebuildError}</span>}
        </div>
        {m.other_currency_claims > 0 && (
          <p className="mt-3 flex items-center gap-2 text-sm text-warning">
            <TriangleAlert className="w-4 h-4 shrink-0" aria-hidden="true" />
            {m.other_currency_claims} {m.other_currency_claims === 1 ? "claim" : "claims"} in other currencies {m.other_currency_claims === 1 ? "is" : "are"} not counted.
          </p>
        )}
      </section>

      {/* Headline numbers */}
      <dl className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-px bg-line shadow-ambient rounded-card overflow-hidden">
        {kpis.map((k) => (
          <div key={k.label} className="bg-surface px-4 py-4 min-w-0">
            <dt className="text-xs text-ink-muted">{k.label}</dt>
            <dd className="mt-1 text-xl truncate">
              <NumberLink href={k.href} label={`${k.label}: ${k.value}. Show the claims`}>{k.value}</NumberLink>
            </dd>
            <dd className="mt-0.5 text-xs text-ink-muted">{k.detail}</dd>
          </div>
        ))}
      </dl>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* By category */}
        <section aria-labelledby="category-title" className="bg-surface shadow-ambient rounded-card px-4 sm:px-6 py-5 min-w-0">
          <h2 id="category-title" className="font-display font-semibold text-lg text-ink">Reimbursed by category</h2>
          {categories.length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">No claims were paid this month.</p>
          ) : (
            <ul className="mt-4 flex flex-col gap-3">
              {categories.map((c) => (
                <li key={c.key} className="min-w-0">
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-ink truncate">{c.key}</span>
                    <span className="shrink-0 tabular-nums">
                      <NumberLink href={c.link} label={`${c.key}: ${c.amount}. Show the claims`}>{c.amount}</NumberLink>
                      <span className="ml-2 text-xs text-ink-muted">{c.percent}%</span>
                    </span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-full bg-surface-muted overflow-hidden" aria-hidden="true">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${Math.max(c.share * 100, 1)}%` }} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* By team */}
        <section aria-labelledby="team-title" className="bg-surface shadow-ambient rounded-card px-4 sm:px-6 py-5 min-w-0">
          <h2 id="team-title" className="font-display font-semibold text-lg text-ink">Reimbursed by team</h2>
          {teams.length === 0 ? (
            <p className="mt-3 text-sm text-ink-muted">No claims were paid this month.</p>
          ) : (
            <table className="mt-3 w-full text-sm">
              <thead>
                <tr className="text-xs text-ink-muted text-left">
                  <th scope="col" className="py-2 font-semibold">Team</th>
                  <th scope="col" className="py-2 font-semibold text-right">Claims</th>
                  <th scope="col" className="py-2 font-semibold text-right">Amount</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {teams.map((t) => (
                  <tr key={t.key}>
                    <th scope="row" className="py-2.5 pr-3 font-normal text-ink text-left">{t.key}</th>
                    <td className="py-2.5 text-right tabular-nums text-ink-muted">{t.count}</td>
                    <td className="py-2.5 pl-3 text-right tabular-nums">
                      <NumberLink href={t.link} label={`${t.key}: ${t.amount}. Show the claims`}>{t.amount}</NumberLink>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>

      {/* Breaches */}
      <section aria-labelledby="breach-title" className="bg-surface shadow-ambient rounded-card px-4 sm:px-6 py-5">
        <h2 id="breach-title" className="font-display font-semibold text-lg text-ink">Most frequent flags</h2>
        <p className="mt-0.5 text-sm text-ink-muted">
          Rules that stopped auto-pay and risk signals on claims decided this month, counted once per claim.
        </p>
        {m.breaches.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">No claims were flagged.</p>
        ) : (
          <ol className="mt-3 divide-y divide-line">
            {m.breaches.map((b) => (
              <li key={b.code} className="py-2.5 flex items-center justify-between gap-3 text-sm">
                <span className="min-w-0">
                  <span className="text-ink">{codeLabel(b.code)}</span>
                  <span className="ml-2 font-mono text-xs text-ink-muted">{b.code}</span>
                </span>
                <Link
                  href={b.link}
                  aria-label={`${codeLabel(b.code)}: ${b.count} claims. Show them`}
                  className="shrink-0 inline-flex items-center gap-1 min-h-[44px] px-2 font-mono font-medium text-ink underline decoration-line-strong underline-offset-4 hover:decoration-accent"
                >
                  {b.count}
                  <ArrowUpRight className="w-3.5 h-3.5" aria-hidden="true" />
                </Link>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
