// Month-end report (F12): turns the backend's metrics into what the page shows. Every number keeps
// the link to the claims behind it.

import type { HardStop, ReportGroup, ReportMetrics } from "@/lib/api/reclaim-pay-types";
import { formatMoney } from "@/lib/format";
import { hardStopLabel, signalLabel } from "@/lib/hr/evidence";

export interface KpiItem {
  label: string;
  value: string;
  detail: string;
  href: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function kpiItems(m: ReportMetrics): KpiItem[] {
  const a = m.auto_pay;
  return [
    {
      label: "Reimbursed",
      value: formatMoney(m.currency, m.reimbursed.value),
      detail: `${plural(m.reimbursed.count, "paid claim")}`,
      href: m.reimbursed.link,
    },
    {
      label: "Auto-pay rate",
      value: a.rate == null ? "No decisions" : `${a.rate}%`,
      detail: `${a.auto} of ${plural(a.decided, "decided claim")}`,
      href: a.link,
    },
    {
      label: "Suspicious claims caught",
      value: String(m.fakes_caught.count),
      detail: `${formatMoney(m.currency, m.fakes_caught.value)} claimed`,
      href: m.fakes_caught.link,
    },
    {
      label: "Recovered",
      value: formatMoney(m.currency, m.recovered.value),
      detail: plural(m.recovered.count, "recovery", "recoveries"),
      href: m.recovered.link,
    },
  ];
}

export interface BarRow extends ReportGroup {
  amount: string;
  /** Bar width as a share of the largest group, 0 to 1. */
  share: number;
  /** Share of the month's total, as a whole percent. */
  percent: number;
}

export function barRows(groups: ReportGroup[], total: number, currency: string): BarRow[] {
  const max = Math.max(0, ...groups.map((g) => g.value));
  return groups.map((g) => ({
    ...g,
    amount: formatMoney(currency, g.value),
    share: max > 0 ? g.value / max : 0,
    percent: total > 0 ? Math.round((100 * g.value) / total) : 0,
  }));
}

/** HR wording for a hard stop or signal code; unknown codes show as they are. */
export function codeLabel(code: string): string {
  const stop = hardStopLabel(code as HardStop);
  return stop !== code ? stop : signalLabel(code as Parameters<typeof signalLabel>[0]);
}

/** The last `count` months, newest first, ending with the current month in Malaysia time. */
export function monthOptions(now: Date, count = 12): { value: string; label: string }[] {
  const local = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kuala_Lumpur" }));
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date(local.getFullYear(), local.getMonth() - i, 1);
    const value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    const label = d.toLocaleString("en-GB", { month: "long", year: "numeric" });
    out.push({ value, label: i === 0 ? `${label} (so far)` : label });
  }
  return out;
}

/** Last month in Malaysia time: the report finance usually wants. */
export function defaultMonth(now: Date): string {
  return monthOptions(now, 2)[1].value;
}

export function isMonth(v: string | null): v is string {
  return v != null && /^\d{4}-(0[1-9]|1[0-2])$/.test(v);
}
