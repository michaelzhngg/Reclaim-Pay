"use client";

import { useEffect, useState, useCallback, useMemo, useRef } from "react";
import {
  X,
  CheckCircle2,
  Clock,
  AlertCircle,
  FileText,
  Download,
  ExternalLink,
  AlertTriangle,
  Building2,
  MapPin,
  Calendar as CalendarIcon,
  Loader2,
} from "lucide-react";
import type { HistoryClaim, LineItem, ClaimStatus } from "./historyData";
import MoneyFlow from "@/components/timeline/MoneyFlow";
import { formatClaimRef, formatMoney } from "@/lib/format";

// ─── Prop types ───────────────────────────────────────────────────────────────

interface ClaimSidebarProps {
  claim: HistoryClaim | null;
  onClose: () => void;
  isLoading?: boolean;
}

// ─── Currency formatter (MYR) ─────────────────────────────────────────────────

function fmt(v: number) {
  return formatMoney("MYR", v);
}

// ─── Status Cascading Logic ───────────────────────────────────────────────────
// Derives effective parent status from the actual lineItems totals.
// Pending always stays Pending.

function deriveStatus(claim: HistoryClaim): ClaimStatus {
  if (claim.status === "Pending") return "Pending";
  const items      = claim.lineItems ?? [];
  const totalReq   = items.reduce((s, i) => s + i.requested, 0);
  const totalApp   = items.reduce((s, i) => s + i.approved,  0);
  if (totalApp === 0)       return "Rejected";
  if (totalApp >= totalReq) return claim.status === "Paid" ? "Paid" : "Approved";
  return "Partially Approved";
}

// ─── Status Badge ─────────────────────────────────────────────────────────────

const STATUS_STYLE: Record<ClaimStatus, string> = {
  Pending:              "bg-surface-muted text-ink",
  Approved:             "bg-accent-soft text-accent-hover",
  "Partially Approved": "bg-warning-soft text-warning",
  Paid:                 "bg-success-soft text-success",
  Rejected:             "bg-danger-soft text-danger",
};

function StatusBadge({ status }: { status: ClaimStatus }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_STYLE[status]}`}>
      {status}
    </span>
  );
}

// ─── Per-Row Mini Status Badge ────────────────────────────────────────────────

function LineStatusBadge({ s }: { s: LineItem["lineStatus"] }) {
  const cls = {
    Approved: "bg-accent-soft text-accent-hover",
    Adjusted: "bg-warning-soft text-warning",
    Rejected: "bg-danger-soft text-danger",
    Pending:  "bg-surface-muted text-ink",
  }[s];
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium shrink-0 ${cls}`}>
      {s}
    </span>
  );
}

// ─── HR Note Banner ───────────────────────────────────────────────────────────

// Shows only notes HR wrote for the employee. AI text never reaches this view.
function HRNoteBanner({ note }: { note: string }) {
  return (
    <div className="p-4 rounded-card bg-surface shadow-ambient">
      <p className="font-body font-semibold text-sm text-ink mb-1">
        Note from HR
      </p>
      <p className="font-body text-sm text-ink leading-relaxed">{note}</p>
    </div>
  );
}

// ─── Line Item Row ────────────────────────────────────────────────────────────
// masterRejected=true: override all child rows to show Rejected + RM 0.00
// regardless of individual data (Cascading Rejection rule).

function LineItemRow({
  item,
  masterRejected,
  masterPending,
}: {
  item: LineItem;
  masterRejected: boolean;
  masterPending: boolean;
}) {
  const effectiveStatus: LineItem["lineStatus"] = masterPending ? "Pending" : masterRejected ? "Rejected" : item.lineStatus;
  const effectiveApproved = (masterPending || masterRejected) ? 0 : item.approved;

  const isRejected = effectiveStatus === "Rejected";
  const isAdjusted = effectiveStatus === "Adjusted";
  const isPending  = effectiveStatus === "Pending";
  const isDeducted = isRejected || isAdjusted;

  const amountColor = isRejected ? "text-danger"
                    : isAdjusted ? "text-warning"
                    : isPending  ? "text-ink-muted"
                    : "text-ink";

  return (
    <div className="px-4 py-3">
      {/* Row header: category + receipt ref tag + mini badge */}
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-body font-semibold text-sm text-ink">
              {item.category}
            </p>
            <span className="font-mono text-xs text-ink-muted">
              {item.receiptRef}
            </span>
          </div>
        </div>
        <LineStatusBadge s={effectiveStatus} />
      </div>

      {/* Requested vs Approved amounts */}
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs text-ink-muted">
          {isDeducted ? (
            <>Requested <del className="font-mono">{fmt(item.requested)}</del></>
          ) : (
            isPending ? "Requested" : <span className="font-mono">{fmt(item.requested)}</span>
          )}
        </span>
        <span className={`font-mono font-medium text-sm ${amountColor}`}>
          {isPending ? fmt(item.requested) : fmt(effectiveApproved)}
        </span>
      </div>

      {/* Why the amount changed, when there are deduction reasons. The internal
          check code is never shown: employees don't see which check fired. */}
      {item.adjustments.length > 0 && (
        <div className="mt-2.5 rounded-control bg-warning-soft p-2.5">
          <p className="text-xs font-semibold text-warning mb-1">
            Why this changed
          </p>
          <ul className="space-y-1">
            {item.adjustments.map((adj, i) => (
              <li key={i} className="flex items-start gap-1.5 text-xs text-ink">
                <AlertTriangle className="w-3 h-3 text-warning shrink-0 mt-0.5" aria-hidden="true" />
                <span>{adj.description}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ─── A4 HTML Claim Form Modal ─────────────────────────────────────────────────

function ClaimFormModal({
  claim,
  effectiveStatus,
  totalRequested,
  totalApproved,
  masterRejected,
  masterPending,
  onClose,
}: {
  claim: HistoryClaim;
  effectiveStatus: ClaimStatus;
  totalRequested: number;
  totalApproved: number;
  masterRejected: boolean;
  masterPending: boolean;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // Close only the form preview, not the drawer underneath.
        e.stopImmediatePropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [onClose]);

  const totalDeducted = totalRequested - totalApproved;

  const statusChip = {
    Approved:             "bg-success-soft text-success",
    "Partially Approved": "bg-warning-soft text-warning",
    Rejected:             "bg-danger-soft text-danger",
    Paid:                 "bg-success-soft text-success",
    Pending:              "bg-surface-muted text-ink-muted",
  }[effectiveStatus];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Official claim form"
      className="fixed inset-0 z-[100] bg-scrim/90 overflow-auto"
      onClick={onClose}
    >
      <style>{`
        .a4-modal-zoom { zoom: 1; }
        @media (max-width: 850px) {
          .a4-modal-zoom { zoom: calc((100vw - 32px) / 794); }
        }
      `}</style>

      {/* High-visibility fixed close button */}
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        className="fixed top-4 right-4 md:top-8 md:right-8 z-[200] inline-flex items-center justify-center w-12 h-12 bg-surface text-ink rounded-control shadow-overlay hover:bg-surface-muted transition-colors focus-visible:outline-on-accent"
        aria-label="Close preview"
      >
        <X className="w-5 h-5 md:w-6 md:h-6" aria-hidden="true" />
      </button>

      {/* Scrollable canvas region */}
      <div className="min-h-full w-full flex justify-center p-4 md:p-12 pb-24 touch-pan-x touch-pan-y">
        {/* A4 Physical Paper */}
        <div
          className="a4-modal-zoom bg-surface rounded-sm shrink-0 border border-line"
          style={{ width: "794px", minHeight: "1123px" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-12 md:p-16 text-ink" style={{ fontSize: "12px" }}>
            {/* Letterhead */}
          <div className="flex items-start justify-between border-b-2 border-ink pb-6 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/logo.svg" alt="" width={28} height={28} className="w-7 h-7" />
                <span className="font-display font-semibold text-xl text-ink">Reclaim Pay</span>
              </div>
              <p className="text-ink-muted text-xs">Expense reimbursement</p>
            </div>
            <div className="text-right">
              <p className="font-display font-semibold text-base text-ink">Expense claim form</p>
              <p className="text-ink-muted font-mono text-xs">{formatClaimRef(claim.id)}</p>
              <p className="text-ink-muted text-xs mt-1">Date: {claim.date}</p>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded-full text-xs font-medium ${statusChip}`}>
                {effectiveStatus}
              </span>
            </div>
          </div>

          {/* Employee Details */}
          <section className="mb-8">
            <h3 className="font-body font-semibold text-sm text-ink mb-3 border-b border-line pb-1">
              Employee information
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2">
              {[
                ["Full Name",   claim.employee.name     || "Not set"],
                ...(claim.employee.id ? [["Employee ID", claim.employee.id]] : []),
                ["Department",  claim.employee.department || "Not set"],
                ["Position",    claim.employee.position || "Not set"],
              ].map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">{label}:</span>
                  <span className="font-semibold text-ink">{value}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Claim Context */}
          <section className="mb-8">
            <h3 className="font-body font-semibold text-sm text-ink mb-3 border-b border-line pb-1">
              Claim context
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2">
              {claim.claimContext.vendorName && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Vendor:</span>
                  <span className="font-semibold">{claim.claimContext.vendorName}</span>
                </div>
              )}
              {claim.claimContext.serviceStart && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Service start:</span>
                  <span className="font-semibold">{claim.claimContext.serviceStart}</span>
                </div>
              )}
              {claim.claimContext.serviceEnd && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Service end:</span>
                  <span className="font-semibold">{claim.claimContext.serviceEnd}</span>
                </div>
              )}
              {claim.claimContext.purpose && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Purpose:</span>
                  <span className="font-semibold">{claim.claimContext.purpose}</span>
                </div>
              )}
              {claim.claimContext.destination && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Destination:</span>
                  <span className="font-semibold">{claim.claimContext.destination}</span>
                </div>
              )}
              {claim.claimContext.departurDate && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Departure:</span>
                  <span className="font-semibold">{claim.claimContext.departurDate}</span>
                </div>
              )}
              {claim.claimContext.arrivalDate && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Arrival:</span>
                  <span className="font-semibold">{claim.claimContext.arrivalDate}</span>
                </div>
              )}
              <div className="flex gap-2">
                <span className="text-ink-muted w-28 shrink-0">Overseas:</span>
                <span className="font-semibold">{claim.claimContext.overseas ? "Yes" : "No"}</span>
              </div>
            </div>
          </section>

          {/* Line Items Table */}
          <section className="mb-8">
            <h3 className="font-body font-semibold text-sm text-ink mb-3 border-b border-line pb-1">
              Expense line items ({claim.lineItems.length} {claim.isVendorBooking ? "booking" : claim.lineItems.length === 1 ? "receipt" : "receipts"})
            </h3>
            <table className="w-full border-collapse" style={{ fontSize: "12px" }}>
              <thead>
                <tr className="bg-surface-muted text-ink-muted text-xs">
                  <th className="text-left py-2 px-3 border border-line font-semibold w-16">Ref</th>
                  <th className="text-left py-2 px-3 border border-line font-semibold">Category / notes</th>
                  <th className="text-right py-2 px-3 border border-line font-semibold w-28">Requested (MYR)</th>
                  <th className="text-right py-2 px-3 border border-line font-semibold w-28">Approved (MYR)</th>
                  <th className="text-center py-2 px-3 border border-line font-semibold w-24">Status</th>
                </tr>
              </thead>
              <tbody>
                {claim.lineItems.map((item, i) => {
                  const effStatus   = masterPending ? "Pending" : masterRejected ? "Rejected" : item.lineStatus;
                  const effApproved = (masterPending || masterRejected) ? 0 : item.approved;
                  return (
                    <tr key={i} className={
                      effStatus === "Rejected" ? "bg-danger-soft"
                    : effStatus === "Adjusted" ? "bg-warning-soft"
                    : effStatus === "Pending"  ? "bg-surface-muted"
                    : "bg-surface"
                    }>
                      <td className="py-2 px-3 border border-line font-mono text-[10px] text-ink-muted">
                        {item.receiptRef}
                      </td>
                      <td className="py-2 px-3 border border-line">
                        {item.category}
                        {item.adjustments.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {item.adjustments.map((adj, j) => (
                              <div key={j} className="text-[11px] text-ink-muted flex gap-1">
                                <span className="text-ink-muted" aria-hidden="true">↳</span>
                                <span>{adj.description}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 border border-line text-right font-mono">
                        {item.requested.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 border border-line text-right font-mono font-medium">
                        {effApproved.toFixed(2)}
                      </td>
                      <td className="py-2 px-3 border border-line text-center">
                        <span className={`px-1.5 py-0.5 rounded-full text-[11px] font-medium ${
                          effStatus === "Approved" ? "bg-success-soft text-success"
                        : effStatus === "Adjusted" ? "bg-warning-soft text-warning"
                        : effStatus === "Pending"  ? "bg-surface-muted text-ink-muted"
                        : "bg-danger-soft text-danger"
                        }`}>
                          {effStatus}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-surface-muted font-bold">
                  <td colSpan={2} className="py-2 px-3 border border-line text-right text-ink">Total Requested</td>
                  <td className="py-2 px-3 border border-line text-right font-mono">{totalRequested.toFixed(2)}</td>
                  <td className="py-2 px-3 border border-line text-right font-mono text-ink">{totalApproved.toFixed(2)}</td>
                  <td className="py-2 px-3 border border-line" />
                </tr>
                {totalDeducted > 0 && (
                  <tr className="bg-danger-soft">
                    <td colSpan={2} className="py-2 px-3 border border-line text-right text-danger font-semibold">Total Deduction</td>
                    <td className="py-2 px-3 border border-line" />
                    <td className="py-2 px-3 border border-line text-right font-mono text-danger font-medium">({totalDeducted.toFixed(2)})</td>
                    <td className="py-2 px-3 border border-line" />
                  </tr>
                )}
                <tr className="bg-surface">
                  <td colSpan={2} className="py-3 px-3 border border-line text-right text-ink font-semibold">Net approved</td>
                  <td className="py-3 px-3 border border-line" />
                  <td className="py-3 px-3 border border-line text-right font-mono text-ink font-medium text-base">{totalApproved.toFixed(2)}</td>
                  <td className="py-3 px-3 border border-line" />
                </tr>
              </tfoot>
            </table>
          </section>

          {/* HR Comments */}
          {claim.hrNote && (
            <section className="mb-8">
              <h3 className="font-body font-semibold text-sm text-ink mb-2 border-b border-line pb-1">
                Note from HR
              </h3>
              <p className="text-ink leading-relaxed">&ldquo;{claim.hrNote}&rdquo;</p>
            </section>
          )}

          {/* Signature Block */}
          <div className="mt-12 grid grid-cols-2 gap-12 border-t border-line pt-6">
            {["Employee Signature", "HR Authorisation"].map((label) => (
              <div key={label}>
                <div className="h-12 border-b border-line-strong mb-2" />
                <p className="text-xs text-ink-muted">{label}</p>
                <p className="text-xs text-ink-muted mt-0.5">Date: ___________</p>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="mt-8 pt-4 border-t border-line flex justify-between text-ink-muted text-[11px]">
            <span>Generated by Reclaim Pay · <span className="font-mono">{formatClaimRef(claim.id)}</span></span>
            <span>Confidential, internal use only</span>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

// ─── Main ClaimSidebar Component ──────────────────────────────────────────────

export default function ClaimSidebar({ claim, onClose, isLoading = false }: ClaimSidebarProps) {
  const API_BASE = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";
  const [isVisible,     setIsVisible]     = useState(false);
  const [showFormModal, setShowFormModal] = useState(false);
  const closeBtnRef = useRef<HTMLButtonElement>(null);
  const openerRef = useRef<HTMLElement | null>(null);

  const onCloseRef = useRef(onClose);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  const isOpen = claim !== null;

  // Escape closes the drawer; focus moves into it on open and back to the opener on close.
  useEffect(() => {
    if (!isOpen) {
      openerRef.current?.focus?.();
      openerRef.current = null;
      return;
    }
    openerRef.current = document.activeElement as HTMLElement | null;
    closeBtnRef.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onCloseRef.current(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen]);

  useEffect(() => {
    if (claim) {
      setIsVisible(true);
      document.body.style.overflow = "hidden";
    } else {
      // Let the exit animation finish before unmounting
      document.body.style.overflow = "auto";
      const timer = setTimeout(() => {
        setIsVisible(false);
        setShowFormModal(false);
      }, 420);
      return () => clearTimeout(timer);
    }
    return () => { document.body.style.overflow = "auto"; };
  }, [claim]);

  const openFormModal  = useCallback(() => setShowFormModal(true),  []);
  const closeFormModal = useCallback(() => setShowFormModal(false), []);

  // ── Derived values (cached) ─────────────────────────────────────────────────
  const effectiveStatus = useMemo(
    () => (claim ? deriveStatus(claim) : ("Pending" as ClaimStatus)),
    [claim]
  );
  const items = useMemo(() => claim?.lineItems ?? [], [claim]);
  const totalRequested = useMemo(() => items.reduce((s, i) => s + i.requested, 0), [items]);
  const totalApproved  = useMemo(() => {
    if (effectiveStatus === "Rejected") return 0;
    return items.reduce((s, i) => s + i.approved, 0);
  }, [items, effectiveStatus]);
  const totalDeducted  = totalRequested - totalApproved;

  const masterRejected = effectiveStatus === "Rejected";
  const isPending      = effectiveStatus === "Pending";
  const isPartial      = effectiveStatus === "Partially Approved";

  if (!claim && !isVisible) return null;

  return (
    <>
      {/* ── Overlay ── */}
      <div
        className={`fixed inset-0 bg-scrim/40 z-60 transition-opacity duration-400 motion-reduce:transition-none ${
          claim ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={onClose}
        aria-hidden="true"
      />

      {/* ── Drawer (max-w-2xl on desktop) ── */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="claim-drawer-title"
        aria-hidden={!claim}
        style={{ transitionTimingFunction: claim ? "cubic-bezier(0.32,0.72,0,1)" : "cubic-bezier(0.4,0,1,1)" }}
        className={`fixed top-0 right-0 h-dvh w-full md:max-w-2xl bg-paper z-70 shadow-overlay transform transition-transform duration-[420ms] motion-reduce:transition-none flex flex-col ${
          claim ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between gap-3 pl-5 pr-3 py-2 border-b border-line bg-surface shrink-0">
          <div className="min-w-0">
            <h2 id="claim-drawer-title" className="font-display font-semibold text-lg text-ink">Claim details</h2>
            <p className="font-mono text-xs text-ink-muted">{claim ? formatClaimRef(claim.id) : ""}</p>
          </div>
          <button
            ref={closeBtnRef}
            type="button"
            onClick={onClose}
            aria-label="Close claim details"
            className="inline-flex items-center justify-center w-11 h-11 rounded-control text-ink hover:bg-surface-muted transition-colors"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </div>

        {/* ── Scrollable body ── */}
        {claim && isLoading ? (
          <div className="flex-1 flex items-center justify-center" role="status">
            <Loader2 className="w-6 h-6 motion-safe:animate-spin text-ink-muted" aria-hidden="true" />
            <span className="sr-only">Loading claim</span>
          </div>
        ) : claim && (
          <div className="flex-1 overflow-y-auto px-5 py-5 space-y-6">

            {/* ① CONDITIONAL HEADER ─────────────────────────────────────── */}
            <div className="bg-surface shadow-ambient rounded-card p-5">

              {/* PENDING: show requested only, no approved field */}
              {isPending && (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <p className="font-body text-sm text-ink-muted mb-1">
                      Amount submitted
                    </p>
                    <span className="font-headline tabular-nums tracking-[-0.02em] font-medium text-3xl text-ink">
                      {claim.amount}
                    </span>
                  </div>
                  <StatusBadge status={effectiveStatus} />
                </div>
              )}

              {/* REJECTED: requested | RM 0.00 approved */}
              {masterRejected && (
                <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                  <div>
                    <p className="font-body text-sm text-ink-muted mb-1">
                      Amount requested
                    </p>
                    <span className="font-headline tabular-nums tracking-[-0.02em] font-medium text-3xl text-ink">
                      {claim.amount}
                    </span>
                  </div>
                  <div className="sm:text-right">
                    <p className="font-body text-sm text-ink-muted mb-1">
                      Total approved
                    </p>
                    <span className="font-headline tabular-nums tracking-[-0.02em] font-medium text-3xl text-danger">MYR 0.00</span>
                    <div className="mt-2"><StatusBadge status={effectiveStatus} /></div>
                  </div>
                </div>
              )}

              {/* PARTIALLY APPROVED: approved primary | requested strikethrough */}
              {isPartial && (
                <>
                  <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
                    <div>
                      <p className="font-body text-sm text-ink-muted mb-1">
                        Total approved
                      </p>
                      <span className="font-headline tabular-nums tracking-[-0.02em] font-medium text-3xl text-ink">
                        {fmt(totalApproved)}
                      </span>
                    </div>
                    <div className="sm:text-right">
                      <p className="font-body text-sm text-ink-muted mb-1">
                        Amount requested
                      </p>
                      <del className="font-mono text-xl text-ink-muted">
                        {claim.amount}
                      </del>
                    </div>
                  </div>
                  <div className="mt-3"><StatusBadge status={effectiveStatus} /></div>
                </>
              )}

              {/* APPROVED / PAID */}
              {!isPending && !masterRejected && !isPartial && (
                <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div>
                    <p className="font-body text-sm text-ink-muted mb-1">
                      Total approved
                    </p>
                    <span className="font-headline tabular-nums tracking-[-0.02em] font-medium text-3xl text-ink">
                      {fmt(totalApproved)}
                    </span>
                  </div>
                  <StatusBadge status={effectiveStatus} />
                </div>
              )}
            </div>

            {!isPending && !masterRejected && (
              <MoneyFlow
                key={claim.id}
                reimId={claim.id}
                claimStatus={effectiveStatus === "Paid" ? "PAID" : "APPROVED"}
              />
            )}

            {/* ② HR NOTE ─────────────────────────────────────────────────── */}
            {claim.hrNote && <HRNoteBanner note={claim.hrNote} />}

            {/* CONTEXT META ──────────────────────────────────────────────── */}
            <div className="flex flex-wrap gap-3 text-xs text-ink-muted">
              {claim.employee.department && (
                <span className="flex items-center gap-1.5">
                  <Building2 className="w-3.5 h-3.5" aria-hidden="true" />
                  {claim.employee.department}
                </span>
              )}
              {claim.claimContext.destination && (
                <span className="flex items-center gap-1.5">
                  <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
                  {claim.claimContext.destination}
                </span>
              )}
              {claim.claimContext.departurDate && (
                <span className="flex items-center gap-1.5">
                  <CalendarIcon className="w-3.5 h-3.5" aria-hidden="true" />
                  {claim.claimContext.departurDate}
                  {claim.claimContext.arrivalDate && ` → ${claim.claimContext.arrivalDate}`}
                </span>
              )}
            </div>

            {/* ③ AUDIT TABLE ──────────────────────────────────────────────── */}
            <div>
              <h4 className="font-display font-semibold text-sm text-ink mb-3">
                Financial breakdown
                <span className="ml-2 text-xs font-normal text-ink-muted">
                  ({items.length} receipt{items.length !== 1 ? "s" : ""})
                </span>
              </h4>

              <div className="rounded-card shadow-ambient bg-surface overflow-hidden">
                <div className="divide-y divide-line">
                  {items.map((item, i) => (
                    <LineItemRow key={i} item={item} masterRejected={masterRejected} masterPending={isPending} />
                  ))}
                </div>

                {/* Footer totals, printed like the bottom of a receipt */}
                <div className="perforated" aria-hidden="true" />
                <div className="flex items-center justify-between px-4 py-2.5">
                  <span className="font-body text-sm text-ink-muted">Total requested</span>
                  <span className="font-mono font-medium text-sm text-ink">
                    {fmt(totalRequested)}
                  </span>
                </div>
                {totalDeducted > 0 && (
                  <div className="flex items-center justify-between px-4 py-2.5 border-t border-line">
                    <span className="font-body text-sm text-danger">Total deduction</span>
                    <span className="font-mono font-medium text-sm text-danger">
                      − {fmt(totalDeducted)}
                    </span>
                  </div>
                )}
                <div className="flex items-center justify-between px-4 py-3 border-t border-line">
                  <span className="font-body text-sm font-semibold text-ink">
                    Net approved
                  </span>
                  <span className="font-mono font-medium text-base text-ink">
                    {fmt(totalApproved)}
                  </span>
                </div>
              </div>
            </div>

            {/* ④ TIMELINE ─────────────────────────────────────────────────── */}
            <div>
              <h4 className="font-display font-semibold text-sm text-ink mb-3">Timeline</h4>
              <ol className="relative space-y-3 before:absolute before:left-[11px] before:top-3 before:bottom-3 before:w-px before:bg-line">

                {/* Submitted */}
                <li className="relative flex items-start gap-4">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-paper shrink-0 z-10">
                    <CheckCircle2 className="w-5 h-5 text-ink" aria-hidden="true" />
                  </span>
                  <div className="w-full min-w-0 p-3 rounded-card bg-surface shadow-ambient">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 mb-1">
                      <span className="font-semibold text-sm text-ink">Submitted</span>
                      <time className="font-mono text-xs text-ink-muted">{claim.date}</time>
                    </div>
                    <p className="text-sm text-ink-muted">Via the employee app</p>
                  </div>
                </li>

                {/* Automatic checks */}
                <li className="relative flex items-start gap-4">
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-paper shrink-0 z-10">
                    {isPending
                      ? <Clock className="w-5 h-5 text-ink-muted" aria-hidden="true" />
                      : <CheckCircle2 className="w-5 h-5 text-ink" aria-hidden="true" />}
                  </span>
                  <div className="w-full min-w-0 p-3 rounded-card bg-surface shadow-ambient">
                    <div className="flex flex-wrap items-center justify-between gap-x-3 mb-1">
                      <span className="font-semibold text-sm text-ink">AI Validation</span>
                      {!isPending && (
                        <time className="font-mono text-xs text-ink-muted">{claim.date}</time>
                      )}
                    </div>
                    <p className="text-sm text-ink-muted">
                      {isPending
                        ? "Reading the receipt and checking it against policy…"
                        : `${items.length} receipt${items.length !== 1 ? "s" : ""} read. Policy check completed.`}
                    </p>
                  </div>
                </li>

                {/* HR Review, only for non-pending */}
                {!isPending && (
                  <li className="relative flex items-start gap-4">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-paper shrink-0 z-10">
                      {masterRejected
                        ? <AlertCircle className="w-5 h-5 text-danger" aria-hidden="true" />
                        : isPartial
                        ? <AlertTriangle className="w-5 h-5 text-warning" aria-hidden="true" />
                        : <CheckCircle2 className="w-5 h-5 text-ink" aria-hidden="true" />}
                    </span>
                    <div className="w-full min-w-0 p-3 rounded-card bg-surface shadow-ambient">
                      <div className="flex flex-wrap items-center justify-between gap-x-3 mb-1">
                        <span className="font-semibold text-sm text-ink">
                          {masterRejected ? "HR Rejected" : isPartial ? "HR Partially Approved" : "HR Approved"}
                        </span>
                        <time className="font-mono text-xs text-ink-muted">{claim.date}</time>
                      </div>
                      <p className="text-sm text-ink-muted">
                        {masterRejected
                          ? "Claim rejected. It does not meet the reimbursement policy."
                          : isPartial
                          ? <>Adjusted to company policy. <span className="font-mono">{fmt(totalApproved)}</span> of <span className="font-mono">{claim.amount}</span> approved.</>
                          : <>Fully approved. <span className="font-mono">{fmt(totalApproved)}</span> queued for payment.</>}
                      </p>
                    </div>
                  </li>
                )}

                {/* Paid, only if Paid */}
                {effectiveStatus === "Paid" && (
                  <li className="relative flex items-start gap-4">
                    <span className="flex items-center justify-center w-6 h-6 rounded-full bg-paper shrink-0 z-10">
                      <CheckCircle2 className="w-5 h-5 text-success" aria-hidden="true" />
                    </span>
                    <div className="w-full min-w-0 p-3 rounded-card bg-surface shadow-ambient">
                      <div className="flex items-center justify-between mb-1">
                        <span className="font-semibold text-sm text-success">Paid</span>
                      </div>
                      <p className="text-sm text-ink-muted">Sent to your PayPal account.</p>
                    </div>
                  </li>
                )}
              </ol>
            </div>

            {/* ⑤ DOCUMENT ACTIONS: official form only ─────────────────────── */}
            <div>
              <h4 className="font-display font-semibold text-sm text-ink mb-3">Documents</h4>
              <div className="bg-surface shadow-ambient rounded-card p-4">
                <div className="flex items-center gap-3 mb-3">
                  <FileText className="w-5 h-5 text-ink-muted shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="font-body font-semibold text-sm text-ink">Official claim form</p>
                    <p className="font-mono text-xs text-ink-muted break-all">
                      {formatClaimRef(claim.id)}_claim_form.pdf
                    </p>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-2">
                  {/* Primary: opens A4 HTML modal */}
                  <button
                    id={`view-form-${claim.id}`}
                    type="button"
                    onClick={openFormModal}
                    className="flex-1 flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-full bg-accent text-on-accent font-body font-semibold text-sm hover:bg-accent-hover transition-colors"
                  >
                    <ExternalLink className="w-4 h-4" aria-hidden="true" />
                    View official claim form
                  </button>
                  {/* Secondary: download PDF via settlement template */}
                  <a
                    id={`download-pdf-${claim.id}`}
                    href={claim.settlementTemplateUrl ? `${API_BASE}${claim.settlementTemplateUrl}` : "#"}
                    onClick={(e) => {
                      if (!claim.settlementTemplateUrl) {
                        e.preventDefault();
                      }
                    }}
                    download
                    aria-disabled={!claim.settlementTemplateUrl || undefined}
                    title={claim.settlementTemplateUrl ? undefined : "The PDF is ready once HR has settled this claim"}
                    className={`flex items-center justify-center gap-1.5 px-4 min-h-[44px] rounded-control border border-line-strong bg-surface text-ink font-body font-semibold text-sm transition-colors ${
                      claim.settlementTemplateUrl ? "hover:bg-surface-muted" : "opacity-50 cursor-not-allowed"
                    }`}
                    aria-label="Download official form (PDF)"
                  >
                    <Download className="w-4 h-4" aria-hidden="true" />
                    Download PDF
                  </a>
                </div>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* A4 Claim Form Modal */}
      {showFormModal && claim && (
        <ClaimFormModal
          claim={claim}
          effectiveStatus={effectiveStatus}
          totalRequested={totalRequested}
          totalApproved={totalApproved}
          masterRejected={masterRejected}
          masterPending={isPending}
          onClose={closeFormModal}
        />
      )}
    </>
  );
}
