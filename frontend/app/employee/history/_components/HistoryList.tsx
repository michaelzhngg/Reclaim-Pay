"use client";

import { ChevronRight } from "lucide-react";
import { HistoryClaim, STATUS_BADGE } from "./historyData";
import { formatClaimRef } from "@/lib/format";

interface HistoryListProps {
  claims: HistoryClaim[];
  onSelectClaim: (claim: HistoryClaim) => void;
}

function StatusChip({ status }: { status: HistoryClaim["status"] }) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${STATUS_BADGE[status]}`}>
      {status}
    </span>
  );
}

export default function HistoryList({ claims, onSelectClaim }: HistoryListProps) {
  if (claims.length === 0) {
    return (
      <div className="p-8 md:p-12 text-center bg-surface rounded-card shadow-ambient">
        <p className="font-display font-semibold text-lg text-ink mb-1">No claims match these filters</p>
        <p className="font-body text-sm text-ink-muted">Change the status, date or category filter, or clear the search.</p>
      </div>
    );
  }

  return (
    <div className="w-full">
      {/* ── Desktop: Full table ───────────────────────── */}
      <div className="hidden md:block overflow-x-auto bg-surface rounded-card shadow-ambient">
        <table className="w-full text-left border-collapse">
          <thead>
            <tr className="text-ink-muted font-body text-xs border-b border-line">
              <th scope="col" className="px-4 py-3 font-medium w-32">Date</th>
              <th scope="col" className="px-4 py-3 font-medium w-40">Main category</th>
              <th scope="col" className="px-4 py-3 font-medium">Sub category / merchant</th>
              <th scope="col" className="px-4 py-3 font-medium w-36 text-right">Amount</th>
              <th scope="col" className="px-4 py-3 font-medium w-40">Status</th>
              <th scope="col" className="px-2 py-3 w-14"><span className="sr-only">Open</span></th>
            </tr>
          </thead>
          <tbody className="font-body text-sm">
            {claims.map((claim) => (
              <tr
                key={claim.id}
                onClick={() => onSelectClaim(claim)}
                className="border-t border-line first:border-t-0 hover:bg-surface-muted transition-colors cursor-pointer group"
              >
                <td className="px-4 py-3 text-ink-muted whitespace-nowrap">{claim.date}</td>
                <td className="px-4 py-3 text-ink font-medium">
                  <span className="flex flex-col">
                    {claim.category}
                    {claim.isVendorBooking && (
                      <span className="mt-1 w-fit rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">
                        Vendor booking
                      </span>
                    )}
                    {claim.isInvoice && (
                      <span className="mt-1 w-fit rounded-full bg-accent-soft px-2 py-0.5 text-xs font-semibold text-accent">
                        Invoice
                      </span>
                    )}
                  </span>
                </td>
                <td className="px-4 py-3 text-ink">
                  <div className="flex flex-col">
                    <span className="font-semibold">{claim.merchant}</span>
                    <span className="text-xs text-ink-muted">
                      {claim.subCategory && claim.subCategory !== claim.merchant ? `${claim.subCategory} · ` : ""}
                      <span className="font-mono">{formatClaimRef(claim.id)}</span>
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3 font-mono font-medium text-ink text-right whitespace-nowrap">
                  {claim.amount}
                </td>
                <td className="px-4 py-3">
                  <StatusChip status={claim.status} />
                </td>
                <td className="px-2 py-1 text-right">
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); onSelectClaim(claim); }}
                    aria-label={`Open claim ${formatClaimRef(claim.id)}`}
                    className="inline-flex items-center justify-center w-11 h-11 rounded-control text-ink-muted group-hover:text-ink hover:bg-surface transition-colors"
                  >
                    <ChevronRight className="w-5 h-5" aria-hidden="true" />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Mobile: list ─────────────────────────── */}
      <ul className="md:hidden bg-surface rounded-card shadow-ambient divide-y divide-line">
        {claims.map((claim) => (
          <li key={claim.id}>
            <button
              type="button"
              onClick={() => onSelectClaim(claim)}
              className="w-full text-left flex items-center justify-between gap-3 px-4 py-3 min-h-[60px] hover:bg-surface-muted transition-colors cursor-pointer"
            >
              <div className="min-w-0">
                <p className="font-body font-semibold text-sm text-ink truncate">
                  {claim.merchant}
                </p>
                <p className="font-body text-xs text-ink-muted truncate mt-0.5">
                  {claim.date.split(",")[0]} · {claim.category}
                  {claim.isVendorBooking ? " · Vendor booking" : ""}
                  {claim.isInvoice ? " · Invoice" : ""}
                </p>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <div className="text-right flex flex-col items-end gap-1">
                  <p className="font-mono font-medium text-sm text-ink whitespace-nowrap">
                    {claim.amount}
                  </p>
                  <StatusChip status={claim.status} />
                </div>
                <ChevronRight className="w-4 h-4 text-ink-muted" aria-hidden="true" />
              </div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
