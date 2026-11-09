"use client";

import { useState, type FormEvent } from "react";
import { Loader2, Save } from "lucide-react";
import { useAuth } from "@/context/AuthContext";
import { useToast } from "@/components/toast/ToastProvider";
import { updateProfile } from "@/lib/actions/settings";
import {
  PROFILE_SAVED_TOAST,
  isProfileChanged,
  normalizeProfile,
  profileError,
  profileFailedToast,
  type ProfileDraft,
} from "./profileForm";

const LABEL = "font-body text-sm font-medium text-ink";
const INPUT =
  "w-full min-h-[44px] bg-surface text-ink text-base md:text-sm px-3 rounded-control border border-line-strong transition-colors aria-invalid:border-danger";

/** Name and email save to PUT /auth/me. The department is set by HR. */
export default function ProfileCard() {
  const { user, updateUser } = useAuth();
  const { toast } = useToast();
  const saved: ProfileDraft = { name: user?.name ?? "", email: user?.email ?? "" };
  const [draft, setDraft] = useState<ProfileDraft>(saved);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const changed = isProfileChanged(draft, saved);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const problem = profileError(draft);
    setError(problem);
    if (problem || !changed) return;
    setSaving(true);
    const body = normalizeProfile(draft);
    const result = await updateProfile(body);
    setSaving(false);
    if (result.error || !result.user) {
      toast(profileFailedToast(result.error));
      return;
    }
    updateUser({ name: result.user.name, email: result.user.email });
    setDraft({ name: result.user.name, email: result.user.email });
    toast(PROFILE_SAVED_TOAST);
  }

  return (
    <section
      id="profile"
      aria-labelledby="profile-heading"
      className="scroll-mt-24 bg-surface shadow-ambient rounded-card overflow-hidden"
    >
      <form onSubmit={onSubmit} noValidate>
        <div className="p-5 md:p-6 border-b border-line">
          <h2 id="profile-heading" className="font-display font-semibold text-lg text-ink mb-1">Profile information</h2>
          <p className="font-body text-sm text-ink-muted">The name and email HR sees on your claims.</p>
        </div>
        <div className="p-5 md:p-6 space-y-5">
          <div className="flex items-center gap-4">
            <div
              aria-hidden="true"
              className="w-14 h-14 rounded-full bg-surface-muted border border-line flex items-center justify-center font-body font-semibold text-xl text-ink"
            >
              {(draft.name || user?.name || "E").charAt(0).toUpperCase()}
            </div>
            <p className="font-body text-sm text-ink-muted">Your initial is used as your picture.</p>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
            <div className="space-y-1.5">
              <label htmlFor="profile-name" className={LABEL}>Full name</label>
              <input
                id="profile-name"
                type="text"
                autoComplete="name"
                value={draft.name}
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                aria-invalid={error?.includes("name") || undefined}
                aria-describedby={error ? "profile-error" : undefined}
                className={INPUT}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="profile-email" className={LABEL}>Email address</label>
              <input
                id="profile-email"
                type="email"
                autoComplete="email"
                inputMode="email"
                value={draft.email}
                onChange={(e) => setDraft((d) => ({ ...d, email: e.target.value }))}
                aria-invalid={error?.includes("email") || undefined}
                aria-describedby={error ? "profile-error" : "profile-email-note"}
                className={INPUT}
              />
              <p id="profile-email-note" className="text-xs text-ink-muted">You also sign in with this address.</p>
            </div>
            <div className="space-y-1.5 sm:col-span-2">
              <label htmlFor="profile-department" className={LABEL}>Department</label>
              <input
                id="profile-department"
                type="text"
                value={user?.department_name || "Not assigned"}
                readOnly
                aria-describedby="profile-department-note"
                className="w-full min-h-[44px] bg-surface-muted text-ink-muted text-base md:text-sm px-3 rounded-control border border-line"
              />
              <p id="profile-department-note" className="text-xs text-ink-muted">HR sets your department.</p>
            </div>
          </div>
          {error && (
            <p id="profile-error" role="alert" className="text-sm font-semibold text-danger">
              {error}
            </p>
          )}
        </div>
        <div className="px-5 py-4 md:px-6 border-t border-line flex justify-end">
          <button
            type="submit"
            disabled={!changed || saving}
            className="flex min-h-11 items-center gap-2 bg-surface text-ink border border-line-strong px-5 rounded-control font-semibold text-sm hover:bg-surface-muted transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            {saving ? <Loader2 className="w-4 h-4 motion-safe:animate-spin" aria-hidden /> : <Save className="w-4 h-4" aria-hidden />}
            {saving ? "Saving…" : "Save profile"}
          </button>
        </div>
      </form>
    </section>
  );
}
