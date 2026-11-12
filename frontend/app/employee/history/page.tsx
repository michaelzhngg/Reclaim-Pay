"use client";

import { useState, useMemo, useEffect, useCallback, Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { Search } from "lucide-react";
import HistoryFilterBar, { FilterStatus } from "./_components/HistoryFilterBar";
import HistoryList from "./_components/HistoryList";
import ClaimSidebar from "./_components/ClaimSidebar";
import { type HistoryClaim, type ClaimStatus, type LineItem, categoryIcon } from "./_components/historyData";
import { merchantLabel, type ReimbursementRaw } from "@/lib/api/types";
import { formatClaimRef, formatMoney } from "@/lib/format";
import { getRawReimbursements, getRawReimbursement } from "@/lib/actions/claims";

// ─── Map backend ReimbursementRaw → HistoryClaim ─────────────────────────────

function mapToHistoryClaim(r: ReimbursementRaw): HistoryClaim {
  const statusMap: Record<string, ClaimStatus> = {
    APPROVED: "Approved",
    REJECTED: "Rejected",
    PENDING: "Pending",
    REVIEW: "Pending",
    APPEALED: "Pending",
    DISBURSING: "Approved",
    DISBURSEMENT_FAILED: "Approved",
    Paid: "Paid",
    PAID: "Paid",
  };
  const claimStatus: ClaimStatus = statusMap[r.status] ?? "Pending";

  const net = r.total_approved_amount ?? 0;
  const requested = r.total_claimed_amount ?? 0;

  const lineItems: LineItem[] = (r.line_items ?? []).map((li, idx) => ({
    receiptRef: `REC-${String(idx + 1).padStart(2, "0")}`,
    category: li.description ?? li.category ?? `Receipt ${idx + 1}`,
    requested: li.claimed_amount ?? 0,
    approved: li.approved_amount ?? 0,
    lineStatus: li.judgment === "APPROVED" ? "Approved"
      : li.judgment === "REJECTED" ? "Rejected"
      : (li.claimed_amount ?? 0) > (li.approved_amount ?? 0) ? "Adjusted"
      : "Pending",
    // Line-level reasons come from the AI checks. Employees never see which check flagged them.
    adjustments: [],
  }));

  const displayDate = r.created_at
    ? new Date(r.created_at).toLocaleDateString("en-MY", { month: "short", day: "numeric", year: "numeric" })
    : "";

  return {
    id: r.reim_id,
    date: displayDate,
    category: r.main_category ?? "General",
    subCategory: r.sub_categories?.[0] ?? "",
    categoryIcon: categoryIcon(r.main_category, ...(r.sub_categories ?? [])),
    // Merchant and category only. r.summary is the AI's verdict and stays out of employee views.
    merchant: merchantLabel(r) || r.sub_categories?.[0] || r.main_category || "Claim",
    amount: formatMoney(r.currency ?? "MYR", requested),
    amountNumeric: requested,
    approvedAmount: net,
    status: claimStatus,
    hrNote: (r.ai_reasoning?.['hr_note'] as string | undefined),
    lineItems,
    receiptCount: lineItems.length,
    pdfDownloadUrl: `/api/v1/reimbursements/${r.reim_id}/pdf`,
    settlementId: r.settlement_id,
    settlementTemplateUrl: r.settlement_id
      ? `/api/v1/documents/settlement/${r.settlement_id}/template`
      : undefined,
    employee: {
      name: r.employee_name ?? "Unknown",
      id: r.employee_code ?? "",
      department: r.department_name ?? "",
      position: "",
    },
    claimContext: {
      purpose: r.purpose ?? "",
      destination: r.destination ?? undefined,
      departurDate: r.departure_date ?? undefined,
      arrivalDate: r.arrival_date ?? undefined,
      overseas: false,
    },
  };
}

function HistoryPageContent() {
  const [currentStatus, setCurrentStatus] = useState<FilterStatus>("All");
  const [selectedClaim, setSelectedClaim] = useState<HistoryClaim | null>(null);
  const [isLoadingDetail, setIsLoadingDetail] = useState(false);
  const [dateRange, setDateRange] = useState("All Time");
  const [selectedCategory, setSelectedCategory] = useState("All");
  const [claims, setClaims] = useState<HistoryClaim[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const searchParams = useSearchParams();

  useEffect(() => {
    getRawReimbursements().then((raw) => {
      if (raw.length > 0) {
        const sorted = [...raw].sort((a, b) => {
          const dateA = a.created_at ? new Date(a.created_at).getTime() : 0;
          const dateB = b.created_at ? new Date(b.created_at).getTime() : 0;
          return dateB - dateA;
        });
        setClaims(sorted.map(mapToHistoryClaim));
      }
    });
  }, []);

  const handleSelectClaim = useCallback(async (claim: HistoryClaim) => {
    setIsLoadingDetail(true);
    try {
      const raw = await getRawReimbursement(claim.id);
      if (raw) {
        setSelectedClaim(mapToHistoryClaim(raw));
        return;
      }
    } finally {
      setIsLoadingDetail(false);
    }
    setSelectedClaim(claim);
  }, []);

  useEffect(() => {
    const claimId = searchParams.get("claimId");
    if (!claimId || claims.length === 0) return;
    const match = claims.find((c) => c.id === claimId);
    if (match) handleSelectClaim(match);
  }, [claims, searchParams, handleSelectClaim]);

  // Filter claims based on the selected filters
  const filteredClaims = useMemo(() => {
    let result = claims;
    if (currentStatus !== "All") result = result.filter((c) => c.status === currentStatus);
    if (selectedCategory !== "All") result = result.filter((c) => c.category === selectedCategory);
    if (dateRange !== "All Time") {
      const now = new Date();
      let days = Infinity;
      if (dateRange === "Last 30 Days") days = 30;
      else if (dateRange === "Last 90 Days") days = 90;
      else if (dateRange === "This Year") days = 365;
      result = result.filter(c => {
        const diff = (now.getTime() - new Date(c.date).getTime()) / (1000 * 3600 * 24);
        return diff <= days && diff >= 0;
      });
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (c) =>
          c.merchant.toLowerCase().includes(q) ||
          formatClaimRef(c.id).toLowerCase().includes(q) ||
          c.category.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q)
      );
    }

    return result;
  }, [currentStatus, selectedCategory, dateRange, claims, searchQuery]);

  // KPI summary
  const summary = useMemo(() => {
    const fmt = (v: number) => formatMoney("MYR", v);
    const reimbursed = claims.filter((c) => c.status === "Approved" || c.status === "Paid").reduce((acc, c) => acc + c.approvedAmount, 0);
    const pending = claims.filter((c) => c.status === "Pending").reduce((acc, c) => acc + c.amountNumeric, 0);
    return { total: fmt(reimbursed), pending: fmt(pending) };
  }, [claims]);

  return (
    <div className="px-4 pt-6 pb-24 md:px-8 md:pt-8 md:pb-12 lg:px-12 lg:pt-10 lg:pb-10 max-w-screen-xl mx-auto w-full">
      <div className="flex flex-col gap-6">

        {/* ── Header ── */}
        <div className="flex flex-col gap-1">
          <h2 className="font-display font-semibold text-2xl md:text-3xl text-ink">
            History
          </h2>
          <p className="text-sm md:text-base text-ink-muted font-body leading-relaxed flex flex-wrap items-center gap-x-4 gap-y-1">
            <span>Total reimbursed <span className="font-mono font-medium text-ink">{summary.total}</span></span>
            <span>Pending <span className="font-mono font-medium text-ink">{summary.pending}</span></span>
          </p>
        </div>

        {/* ── Localized Search Bar ── */}
        <div className="relative max-w-md w-full">
          <Search
            className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted"
            strokeWidth={2}
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Search claims"
            placeholder="Search by merchant, category or ID"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full min-h-[44px] bg-surface border border-line-strong text-ink text-base md:text-sm rounded-control pl-10 pr-4 transition-colors placeholder:text-ink-muted"
          />
        </div>

        {/* ── Filter Bar ── */}
        <div aria-label="Filters" className="relative z-10 w-full">
          <HistoryFilterBar
            currentStatus={currentStatus}
            onStatusChange={setCurrentStatus}
            dateRange={dateRange}
            onDateRangeChange={setDateRange}
            category={selectedCategory}
            onCategoryChange={setSelectedCategory}
          />
        </div>

        {/* ── Claims List ── */}
        <div aria-label="Claims List" className="relative z-0">
          <HistoryList
            claims={filteredClaims}
            onSelectClaim={handleSelectClaim}
          />
        </div>

      </div>

      {/* ── Claim Sidebar Drawer ── */}
      <ClaimSidebar
        claim={selectedClaim}
        onClose={() => setSelectedClaim(null)}
        isLoading={isLoadingDetail}
      />
    </div>
  );
}

export default function HistoryPage() {
  return (
    <Suspense fallback={<div className="min-h-dvh flex items-center justify-center text-sm text-ink-muted">Loading claims…</div>}>
      <HistoryPageContent />
    </Suspense>
  );
}
