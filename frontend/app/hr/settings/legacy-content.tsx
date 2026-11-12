"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { User, Bell, Wallet, LifeBuoy, AlertTriangle, Loader2, SunMoon, Coins } from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { getBankingDetails } from "@/lib/actions/settings";
import { getSettings, setKillSwitch } from "@/lib/actions/autonomy";
import type { BankingDetails } from "@/lib/api/types";
import { useToast } from "@/components/toast/ToastProvider";
import PushSettingToggle from "@/app/_components/PushSettingToggle";
import ProfileCard from "@/app/employee/settings/_components/ProfileCard";
import { DensityOptions, ThemeOptions } from "@/components/theme/AppearanceControls";
import PayoutSetupCard from "./_components/PayoutSetupCard";

const TABS = [
  { id: "profile", label: "Profile Information", icon: User },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "appearance", label: "Appearance", icon: SunMoon },
  { id: "banking", label: "Banking & Payouts", icon: Wallet },
  { id: "currencies", label: "Currencies and payouts", icon: Coins },
] as const;

type TabId = (typeof TABS)[number]["id"];

/** Auto-pay is the autonomy kill switch: GET /autonomy/settings `enabled`, changed with POST /autonomy/kill-switch. */
type AutoPay = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; enabled: boolean };

function Section({ title, desc, children }: { title: string; desc: string; children: ReactNode }) {
  return (
    <section className="bg-surface shadow-ambient rounded-card overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-line">
        <h2 className="font-display font-semibold text-lg text-ink">{title}</h2>
        <p className="font-body text-sm text-ink-muted mt-0.5">{desc}</p>
      </div>
      {children}
    </section>
  );
}

function Row({ title, desc, children }: { title: string; desc: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="font-body font-semibold text-sm text-ink">{title}</p>
        <div className="font-body text-sm text-ink-muted mt-0.5">{desc}</div>
      </div>
      {children}
    </div>
  );
}

/** Plain on/off switch with a 44 px hit area. */
function Switch({ checked, onClick, label, disabled }: { checked: boolean; onClick: () => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="self-start sm:self-auto shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-0.5 rounded-control cursor-pointer disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span
        aria-hidden="true"
        className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${
          checked ? "bg-ink border-ink" : "bg-surface-muted border-line-strong"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 rounded-full bg-surface border border-line transition-transform ${
            checked ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </span>
    </button>
  );
}

export default function SettingsLegacyContent() {
  const { user } = useAuth();
  const { toast } = useToast();
  const [banking, setBanking] = useState<BankingDetails | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>("profile");

  const [autoPay, setAutoPay] = useState<AutoPay>({ state: "loading" });
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [reason, setReason] = useState("");
  const [isUpdating, setIsUpdating] = useState(false);
  const [updateError, setUpdateError] = useState<string | null>(null);

  useEffect(() => {
    getBankingDetails().then(setBanking);
    getSettings().then(({ settings, error }) =>
      setAutoPay(settings ? { state: "ready", enabled: settings.enabled } : { state: "error", message: error ?? "Couldn't load the auto-pay setting." }),
    );
    // An older version of this page faked the switch in the browser.
    try {
      localStorage.removeItem("reclaim_auto_reimburse");
    } catch { /* storage blocked: nothing to clear */ }
  }, []);

  // Escape closes the confirmation dialog unless an update is running.
  useEffect(() => {
    if (!showConfirmModal) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isUpdating) setShowConfirmModal(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [showConfirmModal, isUpdating]);

  const enabled = autoPay.state === "ready" && autoPay.enabled;

  const openConfirm = () => {
    setReason("");
    setUpdateError(null);
    setShowConfirmModal(true);
  };

  const handleConfirmToggle = async () => {
    if (autoPay.state !== "ready") return;
    if (!reason.trim()) {
      setUpdateError("Add a reason. It goes in the agent log with your name.");
      return;
    }
    setIsUpdating(true);
    setUpdateError(null);
    const { settings, error } = await setKillSwitch(!autoPay.enabled, reason);
    setIsUpdating(false);
    if (!settings) {
      setUpdateError(error ?? "Couldn't change auto-pay. Try again.");
      return;
    }
    setAutoPay({ state: "ready", enabled: settings.enabled });
    setShowConfirmModal(false);
    toast({ tone: "success", title: settings.enabled ? "Auto-pay is on" : "Auto-pay is paused" });
  };

  const tabClass = (active: boolean) =>
    `shrink-0 flex items-center gap-3 min-h-[44px] px-3 rounded-control font-body text-sm transition-colors text-left whitespace-nowrap cursor-pointer ${
      active ? "bg-surface-muted font-semibold text-ink" : "font-medium text-ink-muted hover:bg-surface-muted hover:text-ink"
    }`;

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-5">
          <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">Settings</h1>
          <p className="mt-1 text-sm text-ink-muted">Your profile, notifications and how claims are paid.</p>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 md:gap-8">
          {/* Section nav: a scrolling row on phones, a list on wider screens. */}
          <nav aria-label="Settings sections" className="flex md:flex-col gap-1 overflow-x-auto -mx-4 px-4 md:mx-0 md:px-0 border-b border-line pb-2 md:border-0 md:pb-0">
            {TABS.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-current={item.id === activeTab ? "page" : undefined}
                onClick={() => setActiveTab(item.id)}
                className={tabClass(item.id === activeTab)}
              >
                <item.icon className="w-4 h-4 shrink-0" aria-hidden="true" />
                {item.label}
              </button>
            ))}
            <Link href="/hr/support" className={tabClass(false)}>
              <LifeBuoy className="w-4 h-4 shrink-0" aria-hidden="true" />
              Help & Support
            </Link>
          </nav>

          <div className="md:col-span-2 space-y-6 min-w-0">
            {activeTab === "banking" && (
              <Section title="Banking & Payouts" desc="Where reimbursements are paid from, and whether claims can pay without review.">
                <div className="divide-y divide-line">
                  <Row
                    title="Corporate Bank Account"
                    desc={
                      banking?.bank_code ? (
                        <span className="font-mono">
                          {banking.bank_code} {banking.bank_account_number ? "•••• " + banking.bank_account_number.slice(-4) : ""}
                        </span>
                      ) : (
                        "No bank account set up"
                      )
                    }
                  />

                  <Row title="Payment Gateway" desc="PayPal Payouts" />

                  <Row
                    title="Auto-Reimbursement"
                    desc={
                      autoPay.state === "error" ? (
                        <span className="text-danger">{autoPay.message}</span>
                      ) : autoPay.state === "loading" ? (
                        "Checking the current setting…"
                      ) : (
                        <>
                          {autoPay.enabled ? "On." : "Paused."} Claims that pass every fixed rule pay without HR review. The AI only reads receipts; it never starts a payment.
                        </>
                      )
                    }
                  >
                    <Switch checked={enabled} onClick={openConfirm} label="Auto-Reimbursement" disabled={autoPay.state !== "ready"} />
                  </Row>

                  <div className="px-4 sm:px-6 py-3 bg-warning-soft flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
                    <p className="text-sm leading-relaxed text-warning font-medium">
                      This is the same switch as the kill switch on the{" "}
                      <Link href="/hr/autonomy" className="underline underline-offset-2">Autonomy page</Link>, where the limits are set.
                    </p>
                  </div>
                </div>
              </Section>
            )}

            {activeTab === "profile" && <ProfileCard key={user?.user_id ?? "anon"} />}

            {activeTab === "currencies" && <PayoutSetupCard />}

            {activeTab === "notifications" && (
              <Section title="Notifications" desc="Choose how you are notified.">
                <div className="divide-y divide-line">
                  <PushSettingToggle className="px-4 sm:px-6" />
                </div>
              </Section>
            )}

            {activeTab === "appearance" && (
              <Section title="Appearance" desc="Saved in this browser only.">
                <div className="p-4 sm:p-6 space-y-6">
                  <ThemeOptions layout="tiles" />
                  <DensityOptions layout="tiles" />
                </div>
              </Section>
            )}
          </div>
        </div>
      </div>

      {showConfirmModal && autoPay.state === "ready" && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 sm:p-6">
          <div className="absolute inset-0 bg-scrim/40" onClick={() => !isUpdating && setShowConfirmModal(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="auto-reimburse-title"
            className="relative w-full max-w-md bg-surface rounded-dialog border border-line shadow-overlay overflow-hidden"
          >
            <div className="p-6 sm:p-8">
              {autoPay.enabled && <AlertTriangle className="w-7 h-7 text-danger mb-4" aria-hidden="true" />}
              <h3 id="auto-reimburse-title" className="text-xl font-semibold font-display text-ink mb-2">
                {autoPay.enabled ? "Pause auto-pay?" : "Turn on auto-pay?"}
              </h3>
              <p className="text-ink-muted font-body leading-relaxed mb-5">
                {autoPay.enabled
                  ? "Every new claim will wait for HR review before it is paid, until auto-pay is turned back on."
                  : "Claims that pass every fixed rule will be paid to the employee's PayPal without HR review, within the limits on the Autonomy page. The AI never starts a payment."}
              </p>
              <div className="flex flex-col gap-1.5 mb-6">
                <label htmlFor="auto-pay-reason" className="font-body text-sm font-medium text-ink">Reason</label>
                <textarea
                  id="auto-pay-reason"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  rows={3}
                  disabled={isUpdating}
                  aria-describedby="auto-pay-reason-help"
                  aria-invalid={updateError !== null && !reason.trim()}
                  className="w-full bg-surface text-ink text-sm px-3 py-2 rounded-control border border-line-strong focus:border-accent outline-none resize-y"
                />
                <p id="auto-pay-reason-help" className="text-xs text-ink-muted">Saved in the agent log with your name.</p>
                {updateError && <p role="alert" className="text-sm text-danger">{updateError}</p>}
              </div>
              <div className="flex flex-col-reverse sm:flex-row gap-3">
                <button
                  type="button"
                  autoFocus
                  disabled={isUpdating}
                  onClick={() => setShowConfirmModal(false)}
                  className="flex-1 min-h-[44px] px-6 rounded-control text-sm font-semibold text-ink border border-line-strong hover:bg-surface-muted transition-colors disabled:opacity-50 cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  disabled={isUpdating}
                  onClick={handleConfirmToggle}
                  className={`flex-1 flex items-center justify-center gap-2 min-h-[44px] px-6 rounded-full text-sm font-semibold text-on-accent transition-colors disabled:opacity-50 cursor-pointer ${
                    autoPay.enabled ? "bg-danger hover:bg-danger/90" : "bg-accent hover:bg-accent-hover"
                  }`}
                >
                  {isUpdating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      Updating…
                    </>
                  ) : autoPay.enabled ? (
                    "Pause auto-pay"
                  ) : (
                    "Turn on auto-pay"
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
