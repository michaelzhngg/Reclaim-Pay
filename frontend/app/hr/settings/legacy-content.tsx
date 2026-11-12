"use client";

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  User, Bell, Shield, Wallet, Save, LifeBuoy,
  AlertTriangle, Loader2, SunMoon,
} from "lucide-react";
import Link from "next/link";
import { useAuth } from "@/context/AuthContext";
import { getBankingDetails } from "@/lib/actions/settings";
import type { BankingDetails } from "@/lib/api/types";
import { useToast } from "@/components/toast/ToastProvider";
import PushSettingToggle from "@/app/_components/PushSettingToggle";
import { DensityOptions, ThemeOptions } from "@/components/theme/AppearanceControls";

const NOT_BUILT = "Feature has not been implemented yet.";

const TABS = [
  { id: "profile", label: "Profile Information", icon: User },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "appearance", label: "Appearance", icon: SunMoon },
  { id: "security", label: "Security & Login", icon: Shield },
  { id: "banking", label: "Banking & Payouts", icon: Wallet },
] as const;

type TabId = (typeof TABS)[number]["id"];

const secondaryBtn =
  "shrink-0 inline-flex items-center justify-center min-h-[44px] px-4 text-sm font-semibold text-ink border border-line-strong rounded-control hover:bg-surface-muted transition-colors cursor-pointer";
const primaryBtn =
  "inline-flex items-center justify-center gap-2 min-h-[44px] bg-accent text-on-accent px-5 rounded-full font-semibold text-sm hover:bg-accent-hover transition-colors cursor-pointer";
const inputCls =
  "w-full min-h-[44px] bg-surface text-ink px-3 rounded-control border border-line-strong focus:border-accent outline-none";

function Section({ title, desc, children, footer }: { title: string; desc: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <section className="bg-surface shadow-ambient rounded-card overflow-hidden">
      <div className="px-4 sm:px-6 py-4 border-b border-line">
        <h2 className="font-display font-semibold text-lg text-ink">{title}</h2>
        <p className="font-body text-sm text-ink-muted mt-0.5">{desc}</p>
      </div>
      {children}
      {footer && <div className="px-4 sm:px-6 py-3 border-t border-line flex justify-end">{footer}</div>}
    </section>
  );
}

function Row({ title, desc, children }: { title: string; desc: ReactNode; children?: ReactNode }) {
  return (
    <div className="px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
      <div className="min-w-0">
        <p className="font-body font-semibold text-sm text-ink">{title}</p>
        <p className="font-body text-sm text-ink-muted mt-0.5">{desc}</p>
      </div>
      {children}
    </div>
  );
}

/** Plain on/off switch with a 44 px hit area. */
function Switch({ checked, onClick, label }: { checked: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={onClick}
      className="self-start sm:self-auto shrink-0 inline-flex items-center justify-center min-h-[44px] min-w-[44px] px-0.5 rounded-control cursor-pointer"
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

  const showToast = () => toast({ tone: "info", title: NOT_BUILT });

  const [activeTab, setActiveTab] = useState<TabId>("profile");

  // ── Auto-Reimbursement state ──
  const [isAutoReimburseEnabled, setIsAutoReimburseEnabled] = useState(false);
  const [showConfirmModal, setShowConfirmModal] = useState(false);
  const [isUpdating, setIsUpdating] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem("reclaim_auto_reimburse");
    if (saved === "true") setIsAutoReimburseEnabled(true);
  }, []);

  const toggleAutoReimbursementAPI = async (newState: boolean): Promise<boolean> => {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    localStorage.setItem("reclaim_auto_reimburse", newState.toString());
    return true;
  };

  useEffect(() => {
    getBankingDetails().then(setBanking);
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

  const handleToggleClick = () => setShowConfirmModal(true);

  const handleConfirmToggle = async () => {
    setIsUpdating(true);
    try {
      const success = await toggleAutoReimbursementAPI(!isAutoReimburseEnabled);
      if (success) {
        setIsAutoReimburseEnabled(!isAutoReimburseEnabled);
        setShowConfirmModal(false);
      }
    } catch (error) {
      console.error("Failed to update auto-reimbursement setting", error);
    } finally {
      setIsUpdating(false);
    }
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
          <p className="mt-1 text-sm text-ink-muted">Manage your account preferences and banking details for reimbursements.</p>
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
              <Section title="Banking & Payouts" desc="Manage disbursement accounts, schedules, and auto-payout settings.">
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
                  >
                    <button type="button" onClick={showToast} className={secondaryBtn}>
                      Update
                    </button>
                  </Row>

                  <Row title="Disbursement Schedule" desc="Weekly (Fridays)">
                    <button type="button" onClick={showToast} className={secondaryBtn}>
                      Change
                    </button>
                  </Row>

                  <Row title="Payment Gateway" desc="PayPal Payouts (sandbox)">
                    <span className="self-start sm:self-auto shrink-0 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-surface-muted text-ink">
                      Sandbox
                    </span>
                  </Row>

                  <Row
                    title="Auto-Reimbursement"
                    desc="Pay claims automatically when every fixed rule passes. The AI only reads receipts; it never starts a payment."
                  >
                    <Switch checked={isAutoReimburseEnabled} onClick={handleToggleClick} label="Auto-Reimbursement" />
                  </Row>

                  <div className="px-4 sm:px-6 py-3 bg-warning-soft flex items-start gap-3">
                    <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" aria-hidden="true" />
                    <p className="text-sm leading-relaxed text-warning font-medium">
                      Turning this on lets claims that pass every fixed rule pay without HR review. Limits and the kill switch
                      are on the Autonomy page.
                    </p>
                  </div>
                </div>
              </Section>
            )}

            {activeTab === "profile" && (
              <Section
                title="Profile Information"
                desc="Update your personal details below."
                footer={
                  <button type="button" onClick={showToast} className={primaryBtn}>
                    <Save className="w-4 h-4" aria-hidden="true" />
                    Save Changes
                  </button>
                }
              >
                <div className="p-4 sm:p-6 space-y-5">
                  <div className="flex items-center gap-4">
                    <div className="w-16 h-16 rounded-full bg-surface-muted border border-line flex items-center justify-center font-display font-semibold text-xl text-ink">
                      {user?.name?.charAt(0) || "H"}
                    </div>
                    <button type="button" onClick={showToast} className={secondaryBtn}>
                      Change Avatar
                    </button>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <div className="space-y-1.5">
                      <label htmlFor="hr-settings-name" className="font-body text-sm font-medium text-ink">Full Name</label>
                      <input id="hr-settings-name" type="text" defaultValue={user?.name || "HR Admin"} className={inputCls} />
                    </div>
                    <div className="space-y-1.5">
                      <label htmlFor="hr-settings-email" className="font-body text-sm font-medium text-ink">Email Address</label>
                      <input id="hr-settings-email" type="email" defaultValue={user?.email || "hr@reclaim.inc"} className={inputCls} />
                    </div>
                    <div className="space-y-1.5 sm:col-span-2">
                      <label htmlFor="hr-settings-dept" className="font-body text-sm font-medium text-ink">Department</label>
                      <input
                        id="hr-settings-dept"
                        type="text"
                        defaultValue={user?.department_name || "Human Resources"}
                        disabled
                        className="w-full min-h-[44px] bg-surface-muted text-ink-muted px-3 rounded-control border border-line cursor-not-allowed"
                      />
                    </div>
                  </div>
                </div>
              </Section>
            )}

            {activeTab === "notifications" && (
              <Section
                title="Notifications"
                desc="Choose when and how you are notified."
                footer={
                  <button type="button" onClick={showToast} className={primaryBtn}>
                    <Save className="w-4 h-4" aria-hidden="true" />
                    Save Preferences
                  </button>
                }
              >
                <div className="divide-y divide-line">
                  <PushSettingToggle className="px-4 sm:px-6" />
                  {[
                    { label: "Claim Submitted", desc: "Notify when an employee submits a new claim." },
                    { label: "Claim Auto-Paid", desc: "Notify when a claim is paid automatically because every fixed rule passed." },
                    { label: "Disbursement Sent", desc: "Notify after a payout is processed." },
                  ].map((row) => (
                    <Row key={row.label} title={row.label} desc={row.desc}>
                      <Switch checked={false} onClick={showToast} label={row.label} />
                    </Row>
                  ))}
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

            {activeTab === "security" && (
              <Section title="Security & Login" desc="Manage your password and access credentials.">
                <div className="divide-y divide-line">
                  {[
                    { label: "Change Password", desc: "Last updated 3 months ago." },
                    { label: "Two-Factor Authentication", desc: "Add an extra layer of security to your account." },
                    { label: "Active Sessions", desc: "1 active session on this device." },
                  ].map((row) => (
                    <Row key={row.label} title={row.label} desc={row.desc}>
                      <button type="button" onClick={showToast} aria-label={`Manage ${row.label}`} className={secondaryBtn}>
                        Manage
                      </button>
                    </Row>
                  ))}
                </div>
              </Section>
            )}
          </div>
        </div>
      </div>

      {showConfirmModal && typeof document !== "undefined" && createPortal(
        <div className="fixed inset-0 z-[10000] flex items-center justify-center p-4 sm:p-6">
          <div className="absolute inset-0 bg-scrim/40" onClick={() => !isUpdating && setShowConfirmModal(false)} />
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="auto-reimburse-title"
            className="relative w-full max-w-md bg-surface rounded-dialog border border-line shadow-overlay overflow-hidden"
          >
            <div className="p-6 sm:p-8">
              {isAutoReimburseEnabled && <AlertTriangle className="w-7 h-7 text-danger mb-4" aria-hidden="true" />}
              <h3 id="auto-reimburse-title" className="text-xl font-semibold font-display text-ink mb-2">
                {isAutoReimburseEnabled ? "Disable Auto-Reimbursement?" : "Enable Auto-Reimbursement?"}
              </h3>
              <p className="text-ink-muted font-body leading-relaxed mb-7">
                {isAutoReimburseEnabled
                  ? "Are you sure you want to disable automatic payouts? All future claims will require manual HR review before disbursement."
                  : "Are you sure? Claims that pass every fixed rule will be paid to the employee's PayPal without manual HR review. The AI never starts a payment."}
              </p>
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
                    isAutoReimburseEnabled ? "bg-danger hover:bg-danger/90" : "bg-accent hover:bg-accent-hover"
                  }`}
                >
                  {isUpdating ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
                      Updating…
                    </>
                  ) : isAutoReimburseEnabled ? (
                    "Disable Feature"
                  ) : (
                    "Enable Feature"
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
