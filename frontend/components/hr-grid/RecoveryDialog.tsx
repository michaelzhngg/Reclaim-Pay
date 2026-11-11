"use client";

import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { createRecovery } from "@/lib/actions/recoveries";
import type { Recovery } from "@/lib/api/reclaim-pay-types";
import { formatMoney } from "@/lib/format";
import { ErrorLine, Sheet, btnBase } from "@/components/ui/Sheet";
import { recoveryErrorMessage, validateRecovery, type AuditRow } from "./recoveries";

const SEND_FAILED = "Couldn't send the notice. Check your connection and try again.";

function Form({
  row,
  onBusy,
  onClose,
  onCreated,
  onRejected,
}: {
  row: AuditRow;
  onBusy: (busy: boolean) => void;
  onClose: () => void;
  onCreated: (recovery: Recovery) => void;
  onRejected: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const problem = validateRecovery(amount, reason, row.remaining, row.currency);
    setError(problem);
    if (problem) return;

    setSending(true);
    onBusy(true);
    try {
      const res = await createRecovery(row.reimId, Number(amount), reason.trim());
      if (res.recovery) {
        onCreated(res.recovery);
        return;
      }
      setError(recoveryErrorMessage(res.error, SEND_FAILED));
      onRejected();
    } catch {
      setError(SEND_FAILED);
    } finally {
      setSending(false);
      onBusy(false);
    }
  };

  return (
    <form onSubmit={submit} noValidate className="flex flex-col min-h-0 flex-1">
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 text-sm">
        <p className="text-ink-muted">
          {row.employee} gets a notice with this amount and reason, and can dispute it before anything is collected.
        </p>
        <div>
          <label htmlFor="recovery-amount" className="block text-sm font-medium">
            Amount overpaid ({row.currency})
          </label>
          <input
            id="recovery-amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            inputMode="decimal"
            autoComplete="off"
            placeholder="0.00"
            aria-describedby="recovery-amount-hint"
            className="mt-1.5 w-full min-h-[44px] rounded-lg border border-line bg-surface px-3 text-sm tabular-nums placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
          />
          <p id="recovery-amount-hint" className="mt-1 text-xs text-ink-muted">
            Up to {formatMoney(row.currency, row.remaining)}
            {row.inRecovery > 0 && `. ${formatMoney(row.currency, row.inRecovery)} of this claim is already in recovery.`}
          </p>
        </div>
        <div>
          <label htmlFor="recovery-reason" className="block text-sm font-medium">
            Reason <span className="text-ink-muted font-normal">(required)</span>
          </label>
          <textarea
            id="recovery-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="For example: breakfast was included in the hotel rate and also claimed separately"
            className="mt-1.5 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
          />
        </div>
        <ErrorLine error={error} />
      </div>
      <footer className="flex flex-col-reverse gap-2 px-5 py-4 border-t border-line sm:flex-row sm:justify-end">
        <button type="button" onClick={onClose} disabled={sending} className={`${btnBase} text-ink hover:bg-surface-muted focus-visible:outline-accent`}>
          Cancel
        </button>
        <button type="submit" disabled={sending} className={`${btnBase} bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-accent`}>
          {sending && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Send overpayment notice
        </button>
      </footer>
    </form>
  );
}

export default function RecoveryDialog({
  row,
  onClose,
  onCreated,
  onRejected,
}: {
  /** The claim to recover from; null keeps the dialog closed. */
  row: AuditRow | null;
  onClose: () => void;
  onCreated: (recovery: Recovery) => void;
  /** The backend refused, so what's on screen may be out of date. */
  onRejected: () => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Sheet
      open={row !== null}
      titleId="recovery-title"
      title={row ? `Record overpayment on ${row.ref}` : "Record overpayment"}
      busy={busy}
      onClose={onClose}
    >
      {row && <Form key={row.reimId} row={row} onBusy={setBusy} onClose={onClose} onCreated={onCreated} onRejected={onRejected} />}
    </Sheet>
  );
}
