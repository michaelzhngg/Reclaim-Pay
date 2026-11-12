"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, Loader2 } from "lucide-react";
import { executeRecovery, getInvoicePreview } from "@/lib/actions/recoveries";
import type { Recovery, RecoveryInvoicePreview } from "@/lib/api/reclaim-pay-types";
import { formatClaimRef, formatMoney } from "@/lib/format";
import { ErrorLine, Sheet, btnBase } from "@/components/ui/Sheet";
import { formatUpdated } from "./ledger";
import { errorChangesRow, errorNeedsNewPreview, recoveryErrorMessage, type HRRecovery } from "./recoveries";

const LOAD_FAILED = "Couldn't draft the invoice. Check your connection and try again.";
const SEND_FAILED = "Couldn't reach the server, so nothing was confirmed as sent. Refresh the list before trying again.";

const closeBtn = `${btnBase} text-ink hover:bg-surface-muted focus-visible:outline-accent`;
const primaryBtn = `${btnBase} bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-accent`;

function Sent({ recovery, preview }: { recovery: Recovery; preview: RecoveryInvoicePreview }) {
  const ref = useRef<HTMLDivElement>(null);
  // The button that had focus is gone now, so keep keyboard and screen reader users on the result.
  useEffect(() => ref.current?.focus(), []);
  const money = formatMoney(recovery.currency, recovery.amount);
  return (
    <div ref={ref} tabIndex={-1} role="status" className="flex items-start gap-3 outline-none">
      <CheckCircle2 className="w-5 h-5 mt-0.5 shrink-0 text-success" aria-hidden="true" />
      {recovery.status === "OFFSET" ? (
        <div>
          <p className="font-semibold">No invoice was sent.</p>
          <p className="mt-1 text-ink-muted">
            {money} will be deducted from{" "}
            {recovery.offset_reim_id ? `claim ${formatClaimRef(recovery.offset_reim_id)}` : "an unpaid claim"}, which this
            employee still has waiting.
          </p>
        </div>
      ) : (
        <div>
          <p className="font-semibold">Invoice sent via PayPal.</p>
          <p className="mt-1 text-ink-muted break-words">
            {money} to {preview.recipient_email_masked}
            {recovery.paypal_invoice_id && `, invoice ${recovery.paypal_invoice_id}`}.
          </p>
        </div>
      )}
    </div>
  );
}

function Body({
  recovery,
  onBusy,
  onClose,
  onChanged,
}: {
  recovery: HRRecovery;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [preview, setPreview] = useState<RecoveryInvoicePreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<{ message: string; canRetry: boolean } | null>(null);
  const [sending, setSending] = useState(false);
  const [sendCode, setSendCode] = useState<string | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);
  const [sent, setSent] = useState<Recovery | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await getInvoicePreview(recovery.recovery_id);
      if (res.preview) {
        setPreview(res.preview);
        setLoadError(null);
      } else {
        setLoadError({ message: recoveryErrorMessage(res.error, LOAD_FAILED), canRetry: !errorChangesRow(res.error) });
        if (errorChangesRow(res.error)) onChanged();
      }
    } catch {
      setLoadError({ message: LOAD_FAILED, canRetry: true });
    } finally {
      setLoading(false);
    }
  }, [recovery.recovery_id, onChanged]);

  useEffect(() => {
    void load();
  }, [load]);

  const previewAgain = () => {
    setLoading(true);
    setLoadError(null);
    setSendCode(null);
    setSendError(null);
    void load();
  };

  const send = async () => {
    setSending(true);
    onBusy(true);
    setSendCode(null);
    setSendError(null);
    try {
      const res = await executeRecovery(recovery.recovery_id);
      if (res.recovery) {
        setSent(res.recovery);
        onChanged();
        return;
      }
      setSendCode(res.error);
      setSendError(recoveryErrorMessage(res.error, SEND_FAILED));
      onChanged();
    } catch {
      setSendError(SEND_FAILED);
    } finally {
      setSending(false);
      onBusy(false);
    }
  };

  const footer = (primary?: React.ReactNode, closeLabel = "Close") => (
    <footer className="flex flex-col-reverse gap-2 px-5 py-4 border-t border-line sm:flex-row sm:justify-end">
      <button type="button" onClick={onClose} disabled={sending} className={closeBtn}>
        {closeLabel}
      </button>
      {primary}
    </footer>
  );

  if (loading) {
    return (
      <>
        <div role="status" className="flex-1 px-5 py-8 flex items-center gap-3 text-sm text-ink-muted">
          <Loader2 className="w-5 h-5 animate-spin shrink-0" aria-hidden="true" />
          Drafting the invoice note. This can take a few seconds.
        </div>
        {footer()}
      </>
    );
  }

  if (loadError || !preview) {
    return (
      <>
        <div className="flex-1 px-5 py-6">
          <ErrorLine error={loadError?.message ?? LOAD_FAILED} />
        </div>
        {footer(
          loadError?.canRetry !== false && (
            <button type="button" onClick={previewAgain} className={primaryBtn}>
              Try again
            </button>
          ),
        )}
      </>
    );
  }

  if (sent) {
    return (
      <>
        <div className="flex-1 overflow-y-auto px-5 py-6 text-sm">
          <Sent recovery={sent} preview={preview} />
        </div>
        {footer(undefined, "Done")}
      </>
    );
  }

  const waiting = preview.path === "WAIT";
  const blocked = sendCode === "DISPUTE_WINDOW_OPEN" || errorChangesRow(sendCode);

  return (
    <>
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 text-sm">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
          <dt className="text-ink-muted">Amount</dt>
          <dd className="font-mono font-medium">{formatMoney(preview.currency, preview.amount)}</dd>
          <dt className="text-ink-muted">Send to</dt>
          <dd className="font-medium break-all">{preview.recipient_email_masked}</dd>
        </dl>
        <div>
          <p className="text-ink-muted">Note on the invoice, drafted by AI. Read it before you send.</p>
          <p className="mt-1.5 rounded-lg bg-surface-muted px-3 py-2.5 whitespace-pre-wrap break-words">{preview.note}</p>
        </div>
        {waiting && (
          <p className="text-ink-muted">
            The employee can dispute until {formatUpdated(recovery.dispute_until)}, so you can send this after that.
          </p>
        )}
        {preview.path === "OFFSET" && (
          <p className="text-ink-muted">
            This employee has an unpaid claim that covers the amount, so it will be deducted from that claim. No invoice goes out.
          </p>
        )}
        <ErrorLine error={sendError} />
      </div>
      {footer(
        errorNeedsNewPreview(sendCode) ? (
          <button type="button" onClick={previewAgain} className={primaryBtn}>
            Preview again
          </button>
        ) : (
          <button type="button" onClick={send} disabled={sending || waiting || blocked} className={primaryBtn}>
            {sending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
            {preview.path === "OFFSET" ? "Deduct from unpaid claim" : "Send via PayPal"}
          </button>
        ),
      )}
    </>
  );
}

export default function InvoicePreviewDialog({
  recovery,
  onClose,
  onChanged,
}: {
  /** The recovery to preview; null keeps the dialog closed. */
  recovery: HRRecovery | null;
  onClose: () => void;
  /** The recovery's status may have moved, so the list behind should reload. */
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open={recovery !== null}
      titleId="invoice-title"
      title={recovery ? `Invoice for ${formatClaimRef(recovery.reim_id)}` : "Invoice"}
      busy={busy}
      onClose={onClose}
    >
      {recovery && <Body key={recovery.recovery_id} recovery={recovery} onBusy={setBusy} onClose={onClose} onChanged={onChanged} />}
    </Sheet>
  );
}
