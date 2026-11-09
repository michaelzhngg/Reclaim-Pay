"use client";

import { Suspense, useEffect, useRef, useSyncExternalStore } from "react";
import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import PayPalConnectCard from "./_components/PayPalConnectCard";
import ProfileCard from "./_components/ProfileCard";
import PushSettingToggle from "@/app/_components/PushSettingToggle";

// The URL hash picks the section, so /employee/settings#paypal opens on PayPal.
function subscribeHash(onChange: () => void) {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
}
const readHash = () => window.location.hash;
const readServerHash = () => "";

const SECTIONS = [
  { id: "paypal", label: "PayPal payouts" },
  { id: "notifications", label: "Notifications" },
  { id: "profile", label: "Profile information" },
] as const;

const navLink =
  "flex items-center min-h-[44px] px-4 rounded-control font-body text-sm font-medium transition-colors";

export default function SettingsLegacyContent() {
  const { user } = useAuth();
  const hash = useSyncExternalStore(subscribeHash, readHash, readServerHash);
  const active = hash === "#profile" ? "profile" : "paypal";
  const paypalRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (hash !== "#paypal") return;
    const el = paypalRef.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    el.focus({ preventScroll: true });
  }, [hash]);

  return (
    <div className="min-h-full px-4 pt-6 pb-24 md:p-10 lg:p-12">
      <div className="max-w-5xl mx-auto">

        {/* ── Header ── */}
        <div className="max-w-2xl mb-8">
          <h2 className="font-display font-semibold text-2xl md:text-3xl text-ink mb-2">
            Settings
          </h2>
          <p className="text-ink-muted text-base font-body">
            Manage your account and the PayPal account your reimbursements are paid to.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-8">
          {/* ── Left Sidebar (Desktop Nav) ── */}
          <nav aria-label="Settings sections" className="hidden md:flex flex-col gap-1">
            {SECTIONS.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                aria-current={active === item.id ? "true" : undefined}
                className={`${navLink} ${
                  active === item.id
                    ? "bg-surface border border-line text-ink font-semibold"
                    : "text-ink-muted hover:bg-surface-muted hover:text-ink"
                }`}
              >
                {item.label}
              </a>
            ))}
            <Link
              href="/employee/support"
              className={`${navLink} text-ink-muted hover:bg-surface-muted hover:text-ink`}
            >
              Help and support
            </Link>
          </nav>

          {/* ── Main Content Area ── */}
          <div className="md:col-span-2 space-y-6 min-w-0">

            {/* PayPal first: it decides whether reimbursements can reach the employee */}
            <div
              id="paypal"
              ref={paypalRef}
              tabIndex={-1}
              className={`scroll-mt-24 rounded-card outline-none ${
                hash === "#paypal" ? "ring-2 ring-accent ring-offset-2 ring-offset-paper" : ""
              }`}
            >
              <Suspense>
                <PayPalConnectCard />
              </Suspense>
            </div>

            <section
              id="notifications"
              aria-labelledby="notifications-title"
              className="scroll-mt-24 bg-surface shadow-ambient rounded-card"
            >
              <h2 id="notifications-title" className="px-5 pt-5 pb-1 font-display font-semibold text-lg text-ink">
                Notifications
              </h2>
              <PushSettingToggle className="px-5 pb-4" />
            </section>

            <ProfileCard key={user?.user_id ?? "anon"} />

            {/* Mobile Support Link */}
            <Link
              href="/employee/support"
              className="md:hidden flex items-center justify-between gap-4 p-4 min-h-[60px] bg-surface shadow-ambient rounded-card hover:bg-surface-muted transition-colors"
            >
              <div>
                <p className="font-body font-semibold text-sm text-ink">Help and support</p>
                <p className="font-body text-xs text-ink-muted">Read FAQs or contact HR</p>
              </div>
              <ChevronRight className="w-5 h-5 text-ink-muted shrink-0" aria-hidden="true" />
            </Link>

          </div>
        </div>
      </div>
    </div>
  );
}
