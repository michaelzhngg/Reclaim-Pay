"use client";

import { useState, useMemo, useEffect } from "react";
import {
  Search,
  ChevronRight,
  ChevronLeft,
  ExternalLink,
  Inbox,
  CheckCircle2,
  XCircle,
  Clock,
  Banknote,
  Filter,
} from "lucide-react";
import Link from "next/link";
import { getHRHistory, type HistoryClaim } from "@/lib/actions/hr";
import { formatMoney } from "@/lib/format";
import PayoutCell, { payoutDisplay } from "./_components/PayoutCell";
// ─── Types ────────────────────────────────────────────────────────────────────

type ClaimStatus = "Approved" | "Rejected" | "Paid";

// ─── Status Config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<
  ClaimStatus,
  { label: string; bg: string; text: string; icon: typeof CheckCircle2; dot: string }
> = {
  Paid: {
    label: "Paid",
    bg: "bg-success-soft border border-success/30",
    text: "text-success",
    icon: Banknote,
    dot: "bg-success",
  },
  Approved: {
    label: "Approved",
    bg: "bg-surface-muted border border-line",
    text: "text-ink",
    icon: CheckCircle2,
    dot: "bg-ink-muted",
  },
  Rejected: {
    label: "Rejected",
    bg: "bg-danger-soft border border-danger/30",
    text: "text-danger",
    icon: XCircle,
    dot: "bg-danger",
  },
};

// ─── Skeleton Row ─────────────────────────────────────────────────────────────

function SkeletonRow() {
  return (
    <tr className="border-b border-line">
      <td className="py-4 px-6 w-32"><div className="h-4 bg-surface-muted rounded-full animate-pulse w-full" /></td>
      <td className="py-4 px-6"><div className="h-4 bg-surface-muted rounded-full animate-pulse w-3/4" /></td>
      <td className="py-4 px-6"><div className="h-4 bg-surface-muted rounded-full animate-pulse w-2/3" /></td>
      <td className="py-4 px-6 w-32"><div className="h-4 bg-surface-muted rounded-full animate-pulse w-full" /></td>
      <td className="py-4 px-6 w-32"><div className="h-4 bg-surface-muted rounded-full animate-pulse w-full" /></td>
      <td className="py-4 px-6 w-28"><div className="h-4 bg-surface-muted rounded-full animate-pulse w-full" /></td>
      <td className="py-4 px-6 w-24"><div className="h-4 bg-surface-muted rounded-full animate-pulse w-full" /></td>
      <td className="py-4 px-6 w-24"><div className="h-4 bg-surface-muted rounded-full animate-pulse w-full" /></td>
    </tr>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────

const ITEMS_PER_PAGE = 6;

export default function HRHistoryPage() {
  const [data, setData] = useState<HistoryClaim[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<"All" | ClaimStatus>("All");
  const [currentPage, setCurrentPage] = useState(1);

  useEffect(() => {
    setIsLoading(true);
    getHRHistory()
      .then(setData)
      .catch(() => setError("Failed to load claim history. Please try again."))
      .finally(() => setIsLoading(false));
  }, []);

  // ── Filtering ──
  const filtered = useMemo(() => {
    let result = data;
    if (statusFilter !== "All") {
      result = result.filter((c) => c.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) =>
          c.employeeName.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q) ||
          c.policyName.toLowerCase().includes(q),
      );
    }
    return result;
  }, [data, searchQuery, statusFilter]);

  // ── Pagination ──
  const totalPages = Math.max(1, Math.ceil(filtered.length / ITEMS_PER_PAGE));
  const paginated = filtered.slice(
    (currentPage - 1) * ITEMS_PER_PAGE,
    currentPage * ITEMS_PER_PAGE,
  );

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery, statusFilter]);

  // ── KPI Summary ──
  const kpis = useMemo(() => {
    const fmt = (v: number) => formatMoney("MYR", v);
    const approved = data.filter((c) => c.status === "Approved" || c.status === "Paid");
    const rejected = data.filter((c) => c.status === "Rejected");
    const totalPaid = data
      .filter((c) => c.status === "Paid")
      .reduce((s, c) => s + c.amount, 0);
    return {
      total: data.length,
      approved: approved.length,
      rejected: rejected.length,
      totalPaid: fmt(totalPaid),
    };
  }, [data]);

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <div>
        <header className="mb-5">
          <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">Claim History</h1>
          <p className="mt-1 text-sm text-ink-muted">Every resolved claim, paid automatically or decided by HR.</p>
        </header>

        {/* ── Totals: one flat row, numbers in mono ── */}
        <dl className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-line shadow-ambient rounded-card overflow-hidden mb-6">
          {[
            { label: "Total resolved", value: kpis.total.toString(), color: "text-ink" },
            { label: "Approved or paid", value: kpis.approved.toString(), color: "text-ink" },
            { label: "Rejected", value: kpis.rejected.toString(), color: "text-danger" },
            { label: "Total disbursed", value: kpis.totalPaid, color: "text-success" },
          ].map((stat) => (
            <div key={stat.label} className="bg-surface px-4 py-3 min-w-0">
              <dt className="text-xs text-ink-muted">{stat.label}</dt>
              <dd className={`mt-0.5 font-mono font-medium text-lg truncate ${stat.color}`}>{isLoading ? "…" : stat.value}</dd>
            </div>
          ))}
        </dl>

        {/* ── Search & Filter Bar ── */}
        <div className="mb-4 flex flex-col sm:flex-row gap-3">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted w-4 h-4" aria-hidden="true" />
            <input
              type="search"
              aria-label="Search claims"
              placeholder="Search by employee name, claim ID, or policy…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full min-h-[44px] pl-10 pr-3 bg-surface border border-line-strong rounded-control text-sm focus:border-accent outline-none placeholder:text-ink-muted"
            />
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <Filter className="w-4 h-4 text-ink-muted shrink-0" aria-hidden="true" />
            <select
              aria-label="Filter by status"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)}
              className="flex-1 sm:flex-none min-h-[44px] bg-surface border border-line-strong rounded-control px-3 text-sm font-medium text-ink outline-none focus:border-accent cursor-pointer"
            >
              <option value="All">All Statuses</option>
              <option value="Approved">Approved</option>
              <option value="Paid">Paid</option>
              <option value="Rejected">Rejected</option>
            </select>
          </div>
        </div>

        {/* ── Error State ── */}
        {error && (
          <div role="alert" className="bg-danger-soft border border-danger/30 text-danger text-sm rounded-card px-4 py-3 mb-6 flex items-center gap-3">
            <XCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        )}

        {/* ── Table / Cards ── */}
        <div className="bg-surface shadow-ambient rounded-card overflow-hidden">

          {/* Desktop Table */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full table-fixed text-left border-collapse">
              <thead>
                <tr className="bg-surface-muted text-ink-muted text-xs font-semibold">
                  <th className="py-4 px-4 w-32">Claim</th>
                  <th className="py-4 px-4">Employee</th>
                  <th className="py-4 px-4">Policy</th>
                  <th className="py-4 px-4 w-32 text-right">Amount</th>
                  <th className="py-4 px-4 w-24">Resolved</th>
                  <th className="py-4 px-4 w-28">Status</th>
                  <th className="py-4 px-4 w-44">Payout</th>
                  <th className="py-4 px-4 w-20 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {/* Skeleton */}
                {isLoading &&
                  [...Array(ITEMS_PER_PAGE)].map((_, i) => <SkeletonRow key={i} />)}

                {/* Rows */}
                {!isLoading &&
                  paginated.map((claim) => {
                    const cfg = STATUS_CONFIG[claim.status];
                    const StatusIcon = cfg.icon;
                    const formatted = formatMoney(claim.currency, claim.amount);

                    return (
                      <tr
                        key={claim.id}
                        className="hover:bg-surface-muted transition-colors group"
                      >
                        {/* Claim ID */}
                        <td className="py-4 px-4 align-middle whitespace-nowrap">
                          <span className="font-mono text-xs font-medium text-ink">
                            {claim.id}
                          </span>
                        </td>

                        {/* Employee */}
                        <td className="py-4 px-4 align-middle overflow-hidden">
                          <div className="flex items-center gap-3">
                            <div className="w-9 h-9 rounded-full bg-surface-muted border border-line flex items-center justify-center font-semibold text-xs text-ink shrink-0">
                              {claim.employeeInitial}
                            </div>
                            <div className="min-w-0 flex-1">
                              <p className="font-semibold text-sm text-ink truncate">
                                {claim.employeeName}
                              </p>
                              <p className="text-xs text-ink-muted truncate">
                                {claim.department}
                              </p>
                            </div>
                          </div>
                        </td>

                        {/* Policy */}
                        <td className="py-4 px-4 align-middle overflow-hidden">
                          <p className="text-sm text-ink-muted line-clamp-2" title={claim.policyName}>
                            {claim.policyName}
                          </p>
                        </td>

                        {/* Amount */}
                        <td className="py-4 px-4 text-right align-middle">
                          <div className="flex items-center justify-end gap-1 whitespace-nowrap">
                            <span className="font-medium text-sm text-ink font-mono">
                              {formatted}
                            </span>
                          </div>
                        </td>

                        {/* Resolved Date */}
                        <td className="py-4 px-4 align-middle whitespace-nowrap">
                          <div className="flex items-center gap-1.5">
                            <Clock className="w-3 h-3 text-ink-muted shrink-0" aria-hidden="true" />
                            <span className="text-xs text-ink-muted">
                              {claim.dateResolved}
                            </span>
                          </div>
                        </td>

                        {/* Status Badge */}
                        <td className="py-4 px-4 align-middle">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.bg} ${cfg.text}`}
                          >
                            <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${cfg.dot}`} aria-hidden="true" />
                            {cfg.label}
                          </span>
                        </td>

                        {/* Payout: where the money is, and why if it has not moved */}
                        <td className="py-4 px-4 align-middle">
                          <PayoutCell state={claim.payout} />
                        </td>

                        {/* View Action */}
                        <td className="py-4 px-4 text-right align-middle whitespace-nowrap">
                          <Link
                            href={`/hr/view/${claim.reim_id}`}
                            aria-label={`View claim ${claim.id}`}
                            className="inline-flex items-center gap-1.5 min-h-[44px] px-3 rounded-control text-sm font-semibold text-ink hover:bg-surface-muted transition-colors cursor-pointer"
                          >
                            View
                            <ExternalLink className="w-3.5 h-3.5" strokeWidth={2} aria-hidden="true" />
                          </Link>
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>

          {/* Mobile Card List */}
          <div className="md:hidden flex flex-col divide-y divide-line">
            {isLoading &&
              [...Array(ITEMS_PER_PAGE)].map((_, i) => (
                <div key={i} className="p-4 flex items-center gap-3 animate-pulse">
                  <div className="w-9 h-9 rounded-full bg-surface-muted shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 bg-surface-muted rounded-full w-2/3" />
                    <div className="h-2.5 bg-surface-muted rounded-full w-1/2" />
                  </div>
                  <div className="h-3 bg-surface-muted rounded-full w-16 shrink-0" />
                </div>
              ))}

            {!isLoading &&
              paginated.map((claim) => {
                const cfg = STATUS_CONFIG[claim.status];
                const formatted = formatMoney(claim.currency, claim.amount);
                const payout = payoutDisplay(claim.payout);

                return (
                  <Link
                    href={`/hr/view/${claim.reim_id}`}
                    key={claim.id}
                    className="p-4 flex items-center justify-between gap-2 hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-3 overflow-hidden">
                      <div className="w-9 h-9 rounded-full bg-surface-muted border border-line flex items-center justify-center font-semibold text-xs text-ink shrink-0">
                        {claim.employeeInitial}
                      </div>
                      <div className="min-w-0 pr-2">
                        <h4 className="font-body font-semibold text-sm text-ink mb-0.5 truncate">
                          {claim.employeeName}
                        </h4>
                        <p className="font-body text-xs text-ink-muted truncate">
                          <span className="font-mono">{claim.id}</span> · {claim.policyName}
                        </p>
                        <p className={`font-body text-xs font-semibold truncate ${payout.className}`}>
                          Payout: {payout.label}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <div className="text-right shrink-0">
                        <p className="font-mono font-medium text-sm text-ink mb-1">
                          {formatted}
                        </p>
                        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold ${cfg.bg} ${cfg.text}`}>
                          <span className={`w-1 h-1 rounded-full ${cfg.dot}`} aria-hidden="true" />
                          {cfg.label}
                        </span>
                      </div>
                      <ChevronRight className="w-4 h-4 text-ink-muted" aria-hidden="true" />
                    </div>
                  </Link>
                );
              })}
          </div>

        </div>

          {/* Empty State */}
          {!isLoading && filtered.length === 0 && (
            <div className="p-16 text-center">
              <Inbox className="w-8 h-8 mx-auto mb-3 text-ink-muted" aria-hidden="true" />
              <p className="font-display font-semibold text-lg text-ink">
                No claims found
              </p>
              <p className="text-ink-muted text-sm mt-1">
                {data.length === 0
                  ? "Resolved claims will appear here once they age out of the dashboard."
                  : "Try adjusting your search or filter criteria."}
              </p>
            </div>
          )}

          {/* ── Pagination Footer ── */}
          {!isLoading && filtered.length > 0 && (
            <div className="px-4 sm:px-6 py-3 border-t border-line flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <p className="text-xs text-ink-muted">
                Showing{" "}
                <span className="font-semibold text-ink">
                  {(currentPage - 1) * ITEMS_PER_PAGE + 1}–
                  {Math.min(currentPage * ITEMS_PER_PAGE, filtered.length)}
                </span>{" "}
                of{" "}
                <span className="font-semibold text-ink">{filtered.length}</span>{" "}
                results
              </p>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                  disabled={currentPage === 1}
                  className="inline-flex items-center justify-center w-11 h-11 rounded-control text-ink hover:bg-surface-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  aria-label="Previous page"
                >
                  <ChevronLeft className="w-4 h-4" aria-hidden="true" />
                </button>
                {[...Array(Math.min(totalPages, 7))].map((_, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setCurrentPage(i + 1)}
                    aria-label={`Page ${i + 1}`}
                    aria-current={currentPage === i + 1 ? "page" : undefined}
                    className={`hidden sm:inline-flex items-center justify-center w-11 h-11 rounded-control text-sm font-mono font-medium transition-colors cursor-pointer ${
                      currentPage === i + 1
                        ? "bg-ink text-paper"
                        : "text-ink-muted hover:bg-surface-muted"
                    }`}
                  >
                    {i + 1}
                  </button>
                ))}
                <span className="sm:hidden px-2 text-sm text-ink-muted font-mono">
                  {currentPage} / {totalPages}
                </span>
                <button
                  type="button"
                  onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                  disabled={currentPage === totalPages}
                  className="inline-flex items-center justify-center w-11 h-11 rounded-control text-ink hover:bg-surface-muted disabled:opacity-30 disabled:cursor-not-allowed transition-colors cursor-pointer"
                  aria-label="Next page"
                >
                  <ChevronRight className="w-4 h-4" aria-hidden="true" />
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
  );
}
