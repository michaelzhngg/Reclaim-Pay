"use client";

import { Suspense, useRef, type KeyboardEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FIXTURES_ON } from "@/lib/api/fixtures";
import AgentLogTab from "./_components/AgentLogTab";
import AuditQueueTab from "./_components/AuditQueueTab";
import LedgerTab from "./_components/LedgerTab";
import RecoveriesTab from "./_components/RecoveriesTab";

const TABS = [
  { id: "ledger", label: "Ledger" },
  { id: "audit", label: "Audit queue" },
  { id: "recoveries", label: "Recoveries" },
  { id: "log", label: "Agent log" },
] as const;

type TabId = (typeof TABS)[number]["id"];

function PayoutTabs() {
  const router = useRouter();
  const params = useSearchParams();
  const requested = params.get("tab");
  const tab: TabId = TABS.find((t) => t.id === requested)?.id ?? "ledger";
  const tabRefs = useRef<Partial<Record<TabId, HTMLButtonElement | null>>>({});

  // The tab lives in the URL, so coming back from a claim lands on the same tab.
  const choose = (next: TabId) => router.replace(next === "ledger" ? "/hr/payouts" : `/hr/payouts?tab=${next}`, { scroll: false });

  const onTabKeyDown = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = e.key === "ArrowRight" ? 1 : e.key === "ArrowLeft" ? -1 : 0;
    if (!step && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const nextIndex = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (index + step + TABS.length) % TABS.length;
    const next = TABS[nextIndex].id;
    choose(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <>
      <div role="tablist" aria-label="Payouts" className="flex gap-1 overflow-x-auto border-b border-line mb-4 -mx-4 px-4 sm:mx-0 sm:px-0">
        {TABS.map(({ id, label }, i) => {
          const active = tab === id;
          return (
            <button
              key={id}
              ref={(el) => {
                tabRefs.current[id] = el;
              }}
              type="button"
              role="tab"
              id={`payouts-tab-${id}`}
              aria-selected={active}
              aria-controls="payouts-panel"
              tabIndex={active ? 0 : -1}
              onClick={() => choose(id)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={`shrink-0 min-h-[44px] px-2.5 sm:px-3 -mb-px border-b-2 font-body text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-[-2px] cursor-pointer ${
                active ? "border-ink font-semibold text-ink" : "border-transparent text-ink-muted hover:text-ink hover:border-line-strong"
              }`}
            >
              {label}
            </button>
          );
        })}
      </div>

      <section id="payouts-panel" role="tabpanel" aria-labelledby={`payouts-tab-${tab}`}>
        {tab === "ledger" && <LedgerTab />}
        {tab === "audit" && <AuditQueueTab />}
        {tab === "recoveries" && <RecoveriesTab onOpenAudit={() => choose("audit")} />}
        {tab === "log" && <AgentLogTab />}
      </section>
    </>
  );
}

export default function HRPayoutsPage() {
  return (
    <div className="min-h-full px-4 py-6 sm:px-6 md:px-8 md:py-10">
      <header className="mb-6 max-w-3xl">
        <h1 className="font-display font-semibold text-ink text-2xl md:text-3xl">
          Payouts
        </h1>
        <p className="text-ink-muted text-base font-body mt-2">
          Every PayPal payout, the auto-paid claims picked for audit, and any overpayments being recovered.
        </p>
      </header>

      <Suspense fallback={<p className="text-sm text-ink-muted">Loading payouts…</p>}>
        <PayoutTabs />
      </Suspense>

      {FIXTURES_ON && (
        <p className="mt-4 text-xs text-ink-muted">Sample data (fixture mode). Actions here don&apos;t reach the backend or PayPal.</p>
      )}
    </div>
  );
}
