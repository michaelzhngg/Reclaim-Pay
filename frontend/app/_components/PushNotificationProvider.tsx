"use client";

// ─── Push Notification Provider ──────────────────────────────────────────────
// Wraps the app and auto-manages Web Push subscriptions based on auth state.
// - Subscribes on login when permission == "granted"
// - Offers to turn on once (PushInlinePrompt) when permission == "default"
// - Settings row (PushSettingToggle) turns it on or off for both roles
// - Remembers "Not now" and an explicit turn-off in localStorage
// Compatible with iOS Safari 16.4+ (PWA installed) and Android Chrome.
// ──────────────────────────────────────────────────────────────────────────────

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useRef,
} from "react";
import { useAuth } from "@/context/AuthContext";
import {
  getPushPermissionState,
  requestPushPermission,
  subscribeToPush,
  unsubscribeFromPush,
  isPushSupported,
} from "@/lib/push/subscription";
import { savePushSubscription, removePushSubscription } from "@/lib/actions/notifications";

interface PushNotificationContextValue {
  /** null until checked on the client, then whether this browser exposes Web Push. */
  isSupported: boolean | null;
  permission: NotificationPermission | null;
  isSubscribed: boolean;
  isLoading: boolean;
  subscribe: () => Promise<void>;
  unsubscribe: () => Promise<void>;
  showPrompt: boolean;
  dismissPrompt: () => void;
}

const PushNotificationContext = createContext<PushNotificationContextValue>({
  isSupported: null,
  permission: null,
  isSubscribed: false,
  isLoading: false,
  subscribe: async () => {},
  unsubscribe: async () => {},
  showPrompt: false,
  dismissPrompt: () => {},
});

export function usePushNotifications() {
  return useContext(PushNotificationContext);
}

const PROMPT_DISMISSED_KEY = "reclaim_push_prompt_dismissed";
// Set when the person turns notifications off in Settings, so a reload does not silently resubscribe.
const OPTED_OUT_KEY = "reclaim_push_opted_out";

// Storage can throw (private mode, blocked site data); a failed read means "not set".
function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeFlag(key: string, on: boolean): void {
  try {
    if (on) window.localStorage.setItem(key, "1");
    else window.localStorage.removeItem(key);
  } catch {
    // Not remembered this time; nothing else depends on it.
  }
}

export default function PushNotificationProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useAuth();
  const [isSupported, setIsSupported] = useState<boolean | null>(null);
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [showPrompt, setShowPrompt] = useState(false);
  const hasAutoSubscribed = useRef(false);

  const refreshPermission = useCallback(() => {
    const supported = isPushSupported();
    setIsSupported(supported);
    if (!supported) return;
    setPermission(getPushPermissionState());
  }, []);

  useEffect(() => {
    refreshPermission();
  }, [refreshPermission]);

  // Auto-subscribe when user logs in and permission is granted
  useEffect(() => {
    if (!user || !permission || hasAutoSubscribed.current) return;
    if (permission === "granted") {
      hasAutoSubscribed.current = true;
      if (readFlag(OPTED_OUT_KEY)) return;
      setIsLoading(true);
      subscribeToPush()
        .then(async (sub) => {
          if (sub) {
            await savePushSubscription(sub);
            setIsSubscribed(true);
          }
        })
        .catch(console.error)
        .finally(() => setIsLoading(false));
    }
  }, [user, permission]);

  // Show prompt once if permission is default and not dismissed before
  useEffect(() => {
    if (!user || !permission) return;
    if (permission === "default") {
      if (!readFlag(PROMPT_DISMISSED_KEY)) {
        setShowPrompt(true);
      }
    } else {
      setShowPrompt(false);
    }
  }, [user, permission]);

  const handleSubscribe = useCallback(async () => {
    setIsLoading(true);
    try {
      const newPerm = await requestPushPermission();
      setPermission(newPerm);
      if (newPerm === "granted") {
        const sub = await subscribeToPush();
        if (sub) {
          await savePushSubscription(sub);
          setIsSubscribed(true);
          writeFlag(OPTED_OUT_KEY, false);
        }
      }
    } catch (err) {
      console.error("[Push] Subscription failed:", err);
    } finally {
      setIsLoading(false);
      setShowPrompt(false);
    }
  }, []);

  const handleUnsubscribe = useCallback(async () => {
    setIsLoading(true);
    try {
      const ok = await unsubscribeFromPush();
      if (ok) {
        await removePushSubscription();
        setIsSubscribed(false);
        writeFlag(OPTED_OUT_KEY, true);
      }
    } catch (err) {
      console.error("[Push] Unsubscribe failed:", err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const dismissPrompt = useCallback(() => {
    setShowPrompt(false);
    writeFlag(PROMPT_DISMISSED_KEY, true);
  }, []);

  return (
    <PushNotificationContext.Provider
      value={{
        isSupported,
        permission,
        isSubscribed,
        isLoading,
        subscribe: handleSubscribe,
        unsubscribe: handleUnsubscribe,
        showPrompt,
        dismissPrompt,
      }}
    >
      {children}
    </PushNotificationContext.Provider>
  );
}
