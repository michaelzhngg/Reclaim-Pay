// HR history filters kept in the URL, so other pages can link to a filtered list (the month-end
// report links to the claims behind each number; the HR assistant can later link here too).

import type { HistoryClaim, ReportClaimsQuery } from "@/lib/actions/hr";

export const HISTORY_STATUSES = ["Approved", "Paid", "Rejected"] as const;
export type HistoryStatus = (typeof HISTORY_STATUSES)[number];

export interface HistoryFilters {
  status: HistoryStatus | "All";
  q: string;
  category: string | null;
  department: string | null;
  /** Inclusive dates, YYYY-MM-DD, on the resolved date in the viewer's time zone. */
  from: string | null;
  to: string | null;
  /** Set when the list shows the claims behind a number on the month-end report. */
  report: ReportClaimsQuery | null;
}

export const EMPTY_FILTERS: HistoryFilters = {
  status: "All",
  q: "",
  category: null,
  department: null,
  from: null,
  to: null,
  report: null,
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const METRICS = new Set(["reimbursed", "auto_paid", "decided", "fakes_caught", "recovered", "breach"]);

const text = (v: string | null): string | null => (v && v.trim() ? v.trim() : null);

export function parseHistoryParams(params: URLSearchParams): HistoryFilters {
  const status = params.get("status");
  const from = params.get("from");
  const to = params.get("to");
  const month = params.get("report");
  const metric = params.get("metric");
  const report: ReportClaimsQuery | null =
    month && MONTH.test(month) && metric && METRICS.has(metric)
      ? {
          month,
          metric,
          ...(text(params.get("category")) != null && { category: text(params.get("category"))! }),
          ...(text(params.get("team")) != null && { team: text(params.get("team"))! }),
          ...(text(params.get("code")) != null && { code: text(params.get("code"))! }),
        }
      : null;
  return {
    status: HISTORY_STATUSES.includes(status as HistoryStatus) ? (status as HistoryStatus) : "All",
    q: params.get("q") ?? "",
    // In report mode the category filter belongs to the report query.
    category: report ? null : text(params.get("category")),
    department: text(params.get("department")),
    from: from && DATE.test(from) ? from : null,
    to: to && DATE.test(to) ? to : null,
    report,
  };
}

/** The query string for these filters, leaving out defaults. */
export function historySearch(f: HistoryFilters): string {
  const p = new URLSearchParams();
  if (f.report) {
    p.set("report", f.report.month);
    p.set("metric", f.report.metric);
    if (f.report.category != null) p.set("category", f.report.category);
    if (f.report.team != null) p.set("team", f.report.team);
    if (f.report.code != null) p.set("code", f.report.code);
  }
  if (f.status !== "All") p.set("status", f.status);
  if (f.q.trim()) p.set("q", f.q.trim());
  if (!f.report && f.category) p.set("category", f.category);
  if (f.department) p.set("department", f.department);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  const s = p.toString();
  return s ? `?${s}` : "";
}

function localDate(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function applyHistoryFilters(claims: HistoryClaim[], f: HistoryFilters): HistoryClaim[] {
  const q = f.q.trim().toLowerCase();
  return claims.filter((c) => {
    if (f.status !== "All" && c.status !== f.status) return false;
    if (f.category && c.category !== f.category) return false;
    if (f.department && c.department !== f.department) return false;
    if (f.from || f.to) {
      if (!c.resolvedAt) return false;
      const day = localDate(c.resolvedAt);
      if (f.from && day < f.from) return false;
      if (f.to && day > f.to) return false;
    }
    if (q && ![c.employeeName, c.id, c.policyName].some((v) => v.toLowerCase().includes(q))) return false;
    return true;
  });
}

const METRIC_LABEL: Record<string, string> = {
  reimbursed: "Reimbursed",
  auto_paid: "Paid automatically",
  decided: "Decided",
  fakes_caught: "Suspicious claims caught",
  recovered: "Recovered",
  breach: "Flagged",
};

/** "Reimbursed in October 2026 · Meals", for the banner above a report's rows. */
export function reportTitle(r: ReportClaimsQuery): string {
  const [y, m] = r.month.split("-").map(Number);
  const month = new Date(y, m - 1, 1).toLocaleString("en-GB", { month: "long", year: "numeric" });
  const detail = [r.category, r.team, r.code].filter(Boolean).join(" · ");
  return `${METRIC_LABEL[r.metric] ?? r.metric} in ${month}${detail ? ` · ${detail}` : ""}`;
}

/** Chips for the plain filters that have no control on the page (they arrive by link). */
export function filterChips(f: HistoryFilters): { key: "category" | "department" | "from" | "to"; label: string }[] {
  const chips: { key: "category" | "department" | "from" | "to"; label: string }[] = [];
  if (f.category) chips.push({ key: "category", label: `Category: ${f.category}` });
  if (f.department) chips.push({ key: "department", label: `Team: ${f.department}` });
  if (f.from) chips.push({ key: "from", label: `From ${f.from}` });
  if (f.to) chips.push({ key: "to", label: `To ${f.to}` });
  return chips;
}
