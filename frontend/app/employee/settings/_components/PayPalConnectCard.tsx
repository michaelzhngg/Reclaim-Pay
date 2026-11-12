"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, BadgeCheck, Clock, Loader2 } from "lucide-react";
import PayPalMark from "@/components/ui/PayPalMark";
import { getConnectUrl, getPayeeStatus, unlinkPayPal } from "@/lib/actions/paypal";
import type { PayeeStatus } from "@/lib/api/reclaim-pay-types";
import { useToast } from "@/components/toast/ToastProvider";
import { linkChangesPausedUntil, payeeCardState } from "./payeeCardState";
import { callbackToast, connectFailedToast, UNLINK_FAILED_TOAST, UNLINKED_TOAST } from "./paypalToasts";

function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString("en-MY", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function PayPalConnectCard() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast } = useToast();
  const [status, setStatus] = useState<PayeeStatus | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const handledOutcome = useRef<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [confirmingUnlink, setConfirmingUnlink] = useState(false);
  const [unlinking, setUnlinking] = useState(false);

  const fetchStatus = useCallback(() => {
    return getPayeeStatus().then((result) => {
      setStatus(result);
      setLoadState(result ? "ready" : "error");
    });
  }, []);

  const reload = useCallback(() => {
    setLoadState("loading");
    fetchStatus();
  }, [fetchStatus]);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // The PayPal callback lands here with ?paypal=linked|error. Toast it once, then drop it from the URL.
  // The ref keeps React's dev double-run of effects from toasting twice.
  const outcome = searchParams.get("paypal");
  useEffect(() => {
    if (!outcome) {
      handledOutcome.current = null;
      return;
    }
    if (handledOutcome.current === outcome) return;
    handledOutcome.current = outcome;
    const feedback = callbackToast(outcome);
    if (feedback) toast(feedback);
    router.replace("/employee/settings", { scroll: false });
  }, [outcome, router, toast]);

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    const { url, error } = await getConnectUrl();
    if (!url) {
      setConnecting(false);
      toast(connectFailedToast(error));
      return;
    }
    window.location.assign(url);
  }, [toast]);

  const handleUnlink = useCallback(async () => {
    setUnlinking(true);
    const { error } = await unlinkPayPal();
    setUnlinking(false);
    setConfirmingUnlink(false);
    if (error) {
      toast(UNLINK_FAILED_TOAST);
      return;
    }
    toast(UNLINKED_TOAST);
    reload();
  }, [reload, toast]);

  const cardState = status ? payeeCardState(status, new Date()) : null;
  const pausedUntil = status ? linkChangesPausedUntil(status, new Date()) : null;

  return (
    <section
      aria-labelledby="paypal-heading"
      className="bg-surface shadow-ambient rounded-card overflow-hidden"
    >
      <div className="p-5 md:p-6 border-b border-line">
        <h2 id="paypal-heading" className="font-display font-semibold text-lg text-ink mb-1">
          PayPal payouts
        </h2>
        <p className="font-body text-sm text-ink-muted">
          Approved claims are paid straight to the PayPal account you link here.
        </p>
      </div>

      <div className="p-5 md:p-6 space-y-4" aria-live="polite">
        {loadState === "ready" && pausedUntil && (
          <p className="flex items-start gap-2 rounded-control px-4 py-3 bg-warning-soft text-warning text-sm font-body">
            <Clock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
            <span>
              You signed in with PayPal, so payout account changes are paused until {formatWhen(pausedUntil)}. Approved
              claims still pay to this account. To change it sooner, sign out and sign in with your password.
            </span>
          </p>
        )}

        {loadState === "loading" && (
          <div className="flex items-center gap-3 p-4 rounded-control bg-surface-muted text-sm text-ink-muted">
            <Loader2 className="w-4 h-4 motion-safe:animate-spin" aria-hidden="true" />
            Checking your PayPal account…
          </div>
        )}

        {loadState === "error" && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-control bg-danger-soft">
            <p className="flex items-center gap-2 text-sm text-danger font-body">
              <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
              We couldn&apos;t load your PayPal account.
            </p>
            <button
              type="button"
              onClick={reload}
              className="min-h-11 px-4 rounded-control text-sm font-semibold text-ink bg-surface border border-line-strong hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-accent"
            >
              Try again
            </button>
          </div>
        )}

        {loadState === "ready" && status && cardState === "notLinked" && (
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-control border border-line">
            <div className="flex items-center gap-3">
              <PayPalMark className="w-6 h-6 shrink-0" />
              <div>
                <p className="font-body font-semibold text-sm text-ink">No PayPal account linked</p>
                <p className="font-body text-xs text-ink-muted">
                  Link one to get approved claims paid automatically.
                </p>
              </div>
            </div>
            {!pausedUntil && (
              <button
                type="button"
                onClick={handleConnect}
                disabled={connecting}
                className="min-h-11 flex items-center justify-center gap-2 bg-accent text-on-accent px-5 rounded-full font-semibold text-sm hover:bg-accent-hover transition-colors disabled:opacity-60 disabled:cursor-wait focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {connecting && <Loader2 className="w-4 h-4 motion-safe:animate-spin" aria-hidden="true" />}
                {connecting ? "Opening PayPal…" : "Connect PayPal"}
              </button>
            )}
          </div>
        )}

        {loadState === "ready" && status && cardState && cardState !== "notLinked" && (
          <>
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-control border border-line">
              <div className="flex items-center gap-3 min-w-0">
                <PayPalMark className="w-6 h-6 shrink-0" />
                <div className="min-w-0">
                  <p className="font-body text-xs text-ink-muted">Paid to</p>
                  <p className="font-mono font-medium text-sm text-ink truncate">
                    {status.email_masked ?? "PayPal account"}
                  </p>
                  {status.linked_at && (
                    <p className="font-body text-xs text-ink-muted">Linked {formatWhen(status.linked_at)}</p>
                  )}
                </div>
              </div>
              {cardState === "verified" && (
                <span className="inline-flex items-center gap-1.5 self-start sm:self-center px-2.5 py-0.5 rounded-full bg-success-soft text-success text-xs font-medium">
                  <BadgeCheck className="w-3.5 h-3.5" aria-hidden="true" />
                  Instant payouts on
                </span>
              )}
            </div>

            {cardState === "coolDown" && status.cooldown_until && (
              <p className="flex items-start gap-2 rounded-control px-4 py-3 bg-warning-soft text-warning text-sm font-body">
                <Clock className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                Payout account changed. Instant payouts resume {formatWhen(status.cooldown_until)}.
              </p>
            )}

            {cardState === "unverified" && (
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 rounded-control px-4 py-3 bg-warning-soft text-warning">
                <p className="flex items-start gap-2 text-sm font-body">
                  <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
                  Verify your PayPal account to get instant payouts. Once PayPal has verified it, reconnect here.
                </p>
                {!pausedUntil && (
                  <button
                    type="button"
                    onClick={handleConnect}
                    disabled={connecting}
                    className="min-h-11 px-4 rounded-control text-sm font-semibold bg-surface text-ink border border-line-strong hover:bg-surface-muted transition-colors disabled:opacity-60 shrink-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                  >
                    {connecting ? "Opening PayPal…" : "Reconnect PayPal"}
                  </button>
                )}
              </div>
            )}

            {pausedUntil ? null : !confirmingUnlink ? (
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setConfirmingUnlink(true)}
                  className="min-h-11 px-4 rounded-control text-sm font-semibold text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Unlink PayPal
                </button>
              </div>
            ) : (
              <div className="rounded-control border border-line p-4 space-y-3">
                <p className="font-body text-sm text-ink">
                  Unlinking stops automatic payouts. If you link a PayPal account again, instant payouts pause for 72 hours.
                </p>
                <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setConfirmingUnlink(false)}
                    disabled={unlinking}
                    className="min-h-11 px-4 rounded-control text-sm font-semibold text-ink border border-line-strong hover:bg-surface-muted transition-colors focus-visible:outline-2 focus-visible:outline-accent"
                  >
                    Keep it linked
                  </button>
                  <button
                    type="button"
                    onClick={handleUnlink}
                    disabled={unlinking}
                    className="min-h-11 px-4 rounded-control text-sm font-semibold bg-danger text-on-accent hover:opacity-90 transition-opacity disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-danger"
                  >
                    {unlinking ? "Unlinking…" : "Unlink account"}
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
