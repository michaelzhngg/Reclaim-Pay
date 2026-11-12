"use client";

// Settings row for push notifications, for employees and HR. Shows the current state and a
// switch that subscribes or unsubscribes this device through PushNotificationProvider.
// When the browser blocks notifications the switch is disabled and the row says how to allow them.

import { useEffect, useId, useState } from "react";
import { usePushNotifications } from "./PushNotificationProvider";
import { isStandaloneDisplayMode } from "@/lib/push/subscription";

export interface PushSettingToggleProps {
  /** Extra classes for the row container (for example a top border inside a settings card). */
  className?: string;
}

type RowState = "checking" | "unsupported" | "ios-install" | "blocked" | "on" | "off";

export default function PushSettingToggle({ className = "" }: PushSettingToggleProps) {
  const { isSupported, permission, isSubscribed, isLoading, subscribe, unsubscribe } = usePushNotifications();
  const labelId = useId();
  const descId = useId();
  // The iOS check reads navigator, so it runs after mount to keep server and client HTML equal.
  const [needsIosInstall, setNeedsIosInstall] = useState(false);

  useEffect(() => {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    setNeedsIosInstall(isIos && !isStandaloneDisplayMode());
  }, []);

  let state: RowState;
  if (isSupported === null) state = "checking";
  else if (!isSupported) state = needsIosInstall ? "ios-install" : "unsupported";
  else if (permission === "denied") state = "blocked";
  else if (permission === "granted" && isSubscribed) state = "on";
  else state = "off";

  const description: Record<RowState, string> = {
    checking: "Checking this browser.",
    unsupported: "This browser can't show push notifications. Try a recent Chrome, Edge, Firefox or Safari.",
    "ios-install":
      "On iPhone and iPad, add Reclaim Pay to your Home Screen first (tap Share, then Add to Home Screen), then open it from there.",
    blocked:
      "Notifications are blocked for this site. To allow them, open your browser's site settings for this page, set Notifications to Allow, then reload.",
    on: "On for this device. You'll be notified when a claim changes status or a payment is sent. To stop the browser asking again, change Notifications in its site settings.",
    off: "Off for this device. Turn on to be notified when a claim changes status or a payment is sent.",
  };

  const checked = state === "on";
  const canToggle = state === "on" || state === "off";
  const disabled = !canToggle || isLoading;

  const onToggle = () => {
    if (disabled) return;
    void (checked ? unsubscribe() : subscribe());
  };

  return (
    <div className={`flex items-start justify-between gap-4 py-3 ${className}`}>
      <div className="min-w-0 flex-1">
        <p id={labelId} className="text-sm font-semibold text-ink">
          Push notifications
        </p>
        <p id={descId} className="mt-1 text-sm text-ink-muted">
          {isLoading ? (checked ? "Turning off..." : "Turning on...") : description[state]}
        </p>
      </div>
      {/* 44 px hit area around a smaller visual switch. */}
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={descId}
        aria-busy={isLoading}
        disabled={disabled}
        onClick={onToggle}
        className="group -my-1 inline-flex h-11 min-w-11 shrink-0 items-center justify-center rounded-control disabled:opacity-50"
      >
        <span
          aria-hidden
          className={`relative inline-flex h-6 w-11 items-center rounded-full border transition-colors ${
            checked
              ? "border-accent bg-accent group-enabled:group-hover:bg-accent-hover"
              : "border-line-strong bg-surface-muted group-enabled:group-hover:bg-line"
          }`}
        >
          <span
            className={`inline-block h-4 w-4 rounded-full transition-transform ${
              checked ? "translate-x-6 bg-on-accent" : "translate-x-1 bg-ink-muted"
            }`}
          />
        </span>
      </button>
    </div>
  );
}
