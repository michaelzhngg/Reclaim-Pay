"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Upload } from "lucide-react";
import { getDashboardStats, getRecentClaims } from "@/lib/actions/dashboard";
import { getMyTrust } from "@/lib/actions/settings";
import { listRecoveries } from "@/lib/actions/recoveries";
import { useAuth } from "@/context/AuthContext";
import type { ClaimSummary, DashboardStats } from "@/lib/api/types";
import type { Recovery, TrustInfo } from "@/lib/api/reclaim-pay-types";

import StatSummary       from "./_components/StatSummary";
import RecentClaimsTable from "./_components/RecentClaimsTable";
import PayPalStatusChip  from "./_components/PayPalStatusChip";
import AccountStatus     from "./_components/AccountStatus";
import PushInlinePrompt  from "@/app/_components/PushInlinePrompt";

/**
 * Open notices, plus the one a notification linked to with ?recovery={id}
 * when it has moved past NOTICE_SENT (disputed, offset, invoiced, waived).
 */
async function loadRecoveries(): Promise<{ items: Recovery[] | null; linkedId: string | null }> {
  const linkedId = new URLSearchParams(window.location.search).get("recovery");
  const open = await listRecoveries("NOTICE_SENT");
  if (!linkedId || open?.some(r => r.recovery_id === linkedId)) return { items: open, linkedId };
  const linked = (await listRecoveries())?.find(r => r.recovery_id === linkedId);
  if (!linked) return { items: open, linkedId: null };
  return { items: [linked, ...(open ?? [])], linkedId };
}

export default function EmployeeDashboardPage() {
  const { user } = useAuth();
  const [stats, setStats] = useState<DashboardStats | null>(null);
  // null while loading, so the empty state never flashes before data arrives
  const [claims, setClaims] = useState<ClaimSummary[] | null>(null);
  const [today, setToday] = useState("");
  // undefined while loading, null when the endpoint failed: both cards then stay hidden
  const [trust, setTrust] = useState<TrustInfo | null | undefined>(undefined);
  const [recoveries, setRecoveries] = useState<Recovery[] | null | undefined>(undefined);
  const [linkedRecoveryId, setLinkedRecoveryId] = useState<string | null>(null);

  // Show only the first name in the greeting
  const firstName = user?.name?.split(" ")[0] ?? "there";

  useEffect(() => {
    getDashboardStats().then(setStats);
    getRecentClaims(3).then(setClaims).catch(() => setClaims([]));
    getMyTrust().then(setTrust).catch(() => setTrust(null));
    loadRecoveries()
      .then(({ items, linkedId }) => {
        setRecoveries(items);
        setLinkedRecoveryId(linkedId);
      })
      .catch(() => setRecoveries(null));
  }, []);

  // Render date client-only to avoid hydration mismatch
  useEffect(() => {
    setToday(
      new Date().toLocaleDateString("en-US", {
        weekday: "short",
        month: "long",
        day: "numeric",
      })
    );
  }, []);

  const isEmpty = claims !== null && claims.length === 0;

  return (
    /*
     * The nav shell (SideNav, TopNav, BottomNav) is provided by
     * app/employee/layout.tsx; this page only owns the scrollable content.
     */
    <div className="px-4 pt-6 pb-20 md:p-8 lg:p-12 lg:pb-8">

      {/* ── 1. Greeting + where payouts go ─────────── */}
      <section
        aria-label="Welcome section"
        className="mb-6 md:mb-8"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-3 min-w-0">
            <h2 className="font-display text-2xl md:text-3xl font-semibold text-ink">
              Welcome back, {firstName}
            </h2>
            <PayPalStatusChip />
          </div>

          {/* Current date, md+ only */}
          {today && (
            <p className="hidden md:block font-body text-sm text-ink-muted shrink-0 pt-2">
              {today}
            </p>
          )}
        </div>
      </section>

      {/* Inline, after the first claim, so it never covers content. */}
      <PushInlinePrompt hasSubmittedClaim={!!claims && claims.length > 0} className="mb-6" />

      {/* Fast-track and overpayment notices sit under the PayPal chip, except on
          first run, where they follow the upload prompt so it stays in view on phones. */}
      {!isEmpty && (
        <AccountStatus trust={trust} recoveries={recoveries} linkedRecoveryId={linkedRecoveryId} className="mb-6 md:mb-10" />
      )}

      {isEmpty ? (
        /* ── First run: one clear next step instead of zero cards ── */
        <section
          aria-labelledby="empty-claims-heading"
          className="bg-surface shadow-ambient rounded-card p-6 md:p-8 flex flex-col items-start gap-4 max-w-xl"
        >
          <h3 id="empty-claims-heading" className="font-display text-xl font-semibold text-ink">
            No claims yet
          </h3>
          <p className="font-body text-sm text-ink-muted leading-relaxed">
            Snap or upload a receipt. We read it, check it against your policy, and pay approved claims to your PayPal.
          </p>
          <Link
            href="/employee/claims"
            className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 py-2.5 font-body text-sm font-semibold text-on-accent hover:bg-accent-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            <Upload className="h-4 w-4" aria-hidden />
            Upload your first receipt
          </Link>
        </section>
      ) : (
        <>
          {/* ── 2. Totals: one lead figure, two quieter ones ── */}
          <StatSummary stats={stats} />

          {/* ── 3. Recent Claims ──────────────────── */}
          <RecentClaimsTable claims={claims} />
        </>
      )}

      {isEmpty && (
        <AccountStatus trust={trust} recoveries={recoveries} linkedRecoveryId={linkedRecoveryId} className="mt-6 max-w-xl md:max-w-none" />
      )}

    </div>
  );
}
