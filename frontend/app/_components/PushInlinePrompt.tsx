"use client";

// Inline (not fixed) offer to turn on push notifications. It renders itself only when
// push is supported, permission is still "default", the person has not chosen "Not now",
// and they have submitted at least one claim. Subscription logic lives in PushNotificationProvider.

import { useId } from "react";
import { Bell } from "lucide-react";
import { usePushNotifications } from "./PushNotificationProvider";

export interface PushInlinePromptProps {
  /** True once the signed-in employee has submitted at least one claim. */
  hasSubmittedClaim: boolean;
  /** Extra classes for spacing in the parent layout (for example "mb-6"). */
  className?: string;
}

export default function PushInlinePrompt({ hasSubmittedClaim, className = "" }: PushInlinePromptProps) {
  const { isSupported, permission, showPrompt, isLoading, subscribe, dismissPrompt } = usePushNotifications();
  const headingId = useId();

  // showPrompt already means: signed in, permission "default", and "Not now" not chosen before.
  if (!hasSubmittedClaim || !isSupported || permission !== "default" || !showPrompt) return null;

  return (
    <section
      aria-labelledby={headingId}
      className={`flex flex-col gap-4 rounded-card shadow-ambient bg-surface p-4 sm:flex-row sm:items-center sm:p-5 ${className}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-3">
        <Bell aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-ink-muted" />
        <div className="min-w-0">
          <h2 id={headingId} className="font-body text-sm font-semibold text-ink">
            Get notified when your claims change
          </h2>
          <p className="mt-1 text-sm text-ink-muted">
            We&apos;ll send a notification to this device when HR reviews a claim or a payment is sent to your PayPal.
            You can change this later in Settings.
          </p>
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2 sm:ml-auto">
        <button
          type="button"
          onClick={() => void subscribe()}
          disabled={isLoading}
          aria-busy={isLoading}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-control border border-line-strong bg-surface px-4 text-sm font-semibold text-ink transition-colors hover:bg-surface-muted disabled:opacity-50 sm:flex-none"
        >
          {isLoading ? "Turning on..." : "Turn on"}
        </button>
        <button
          type="button"
          onClick={dismissPrompt}
          disabled={isLoading}
          className="inline-flex min-h-11 flex-1 items-center justify-center rounded-control px-4 text-sm font-semibold text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink disabled:opacity-50 sm:flex-none"
        >
          Not now
        </button>
      </div>
    </section>
  );
}
