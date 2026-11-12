"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronRight } from "lucide-react";
import type { ClaimSummary } from "@/lib/api/types";
import { formatClaimRef } from "@/lib/format";

/* ─── Types ──────────────────────────────────────────── */
type ClaimStatus = "Pending" | "Approved" | "Paid" | "Rejected";

/* ─── Status chips: the only pills on the page, because they mark a state ── */
const STATUS_BADGE: Record<ClaimStatus, string> = {
  Pending:  "bg-surface-muted text-ink",
  Approved: "bg-accent-soft text-accent-hover",
  Paid:     "bg-success-soft text-success",
  Rejected: "bg-danger-soft text-danger",
};

const claimHref = (id: string) => `/employee/history?claimId=${id}`;

function StatusChip({ status }: { status: string }) {
  return (
    <span
      className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium whitespace-nowrap ${
        STATUS_BADGE[status as ClaimStatus] ?? "bg-surface-muted text-ink"
      }`}
    >
      {status}
    </span>
  );
}

/* ─── Component ──────────────────────────────────────── */
/** `claims` is null while loading. The page shows its own empty state when there are none. */
export default function RecentClaimsTable({ claims }: { claims: ClaimSummary[] | null }) {
  const router = useRouter();

  return (
    <section
      aria-labelledby="recent-claims-heading"
      className="bg-surface shadow-ambient rounded-card"
    >
      {/* Section header */}
      <div className="flex justify-between items-center gap-3 pl-4 pr-2 md:pl-6 md:pr-4 py-2 border-b border-line">
        <h3
          id="recent-claims-heading"
          className="font-display text-lg font-semibold text-ink"
        >
          Recent claims
        </h3>
        <Link
          id="recent-claims-view-all-btn"
          href="/employee/history"
          className="inline-flex min-h-11 items-center gap-1 px-2 rounded-control text-accent-hover font-body text-sm font-semibold hover:bg-surface-muted transition-colors"
        >
          View all claims
          <ChevronRight className="w-4 h-4" strokeWidth={2} aria-hidden />
        </Link>
      </div>

      {claims === null && (
        <p className="font-body text-sm text-ink-muted px-4 md:px-6 py-6" role="status">
          Loading your recent claims…
        </p>
      )}

      {claims && claims.length > 0 && (
        <>
          {/* ── Desktop: Full table ───────────────────────── */}
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="text-ink-muted font-body text-xs">
                  <th scope="col" className="px-6 py-3 font-medium">Claim</th>
                  <th scope="col" className="px-6 py-3 font-medium">Date</th>
                  <th scope="col" className="px-6 py-3 font-medium">Policy</th>
                  <th scope="col" className="px-6 py-3 font-medium">Merchant</th>
                  <th scope="col" className="px-6 py-3 font-medium text-right">Amount</th>
                  <th scope="col" className="px-6 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="font-body text-sm">
                {claims.map((claim) => (
                  <tr
                    key={claim.id}
                    onClick={() => router.push(claimHref(claim.id))}
                    className="border-t border-line hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    <td className="px-6 py-3">
                      <Link
                        href={claimHref(claim.id)}
                        onClick={(e) => e.stopPropagation()}
                        className="inline-flex items-center min-h-11 font-mono text-xs text-ink hover:underline underline-offset-4"
                      >
                        {formatClaimRef(claim.id)}
                      </Link>
                    </td>
                    <td className="px-6 py-3 text-ink-muted">{claim.date}</td>
                    <td className="px-6 py-3 text-ink">{claim.category}</td>
                    <td className="px-6 py-3 text-ink">
                      {claim.merchant || <span className="text-ink-muted">{claim.subCategory || "Not set"}</span>}
                    </td>
                    <td className="px-6 py-3 font-mono font-medium text-ink text-right whitespace-nowrap">
                      {claim.amount}
                    </td>
                    <td className="px-6 py-3">
                      <StatusChip status={claim.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* ── Mobile: list ─────────────────────────── */}
          <ul className="md:hidden divide-y divide-line">
            {claims.map((claim) => (
              <li key={claim.id}>
                <Link
                  href={claimHref(claim.id)}
                  className="flex items-center justify-between gap-3 px-4 py-3 min-h-[60px] hover:bg-surface-muted transition-colors"
                >
                  <div className="min-w-0">
                    <p className="font-body font-semibold text-sm text-ink truncate">
                      {claim.merchant || claim.category}
                    </p>
                    <p className="font-body text-xs text-ink-muted truncate mt-0.5">
                      {claim.date.split(",")[0]} · <span className="font-mono">{formatClaimRef(claim.id)}</span>
                    </p>
                  </div>

                  <div className="text-right shrink-0 flex flex-col items-end gap-1">
                    <p className="font-mono font-medium text-sm text-ink whitespace-nowrap">
                      {claim.amount}
                    </p>
                    <StatusChip status={claim.status} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
