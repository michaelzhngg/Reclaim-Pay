"use client";

import { useState } from "react";
import { Loader2 } from "lucide-react";
import { ErrorLine, Sheet, btnBase } from "@/components/ui/Sheet";
import type { ConfigChange } from "../_lib/autonomy";

function ReasonField({
  id,
  value,
  onChange,
  placeholder,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div>
      <label htmlFor={id} className="block text-sm font-medium">
        Reason <span className="text-ink-muted font-normal">(required)</span>
      </label>
      <textarea
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={2}
        maxLength={500}
        placeholder={placeholder}
        className="mt-1.5 w-full rounded-control border border-line-strong bg-surface px-3 py-2 text-sm placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent"
      />
    </div>
  );
}

// ─── Save ────────────────────────────────────────────────────────────────────

export function SaveDialog({
  open,
  nextVersion,
  changes,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  nextVersion: number;
  changes: ConfigChange[];
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  // The parent remounts this dialog (via `key`) each time it opens, so the fields start empty.
  const [reason, setReason] = useState("");

  return (
    <Sheet open={open} titleId="save-title" title={`Save version ${nextVersion}?`} busy={busy} onClose={onClose}>
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 text-sm">
        <p className="text-ink-muted">New claims use these limits as soon as you save. Claims already decided stay as they are.</p>
        <table className="w-full">
          <caption className="sr-only">Changes</caption>
          <thead>
            <tr className="text-left text-xs text-ink-muted">
              <th scope="col" className="pb-1 font-medium">Setting</th>
              <th scope="col" className="pb-1 font-medium text-right">Before</th>
              <th scope="col" className="pb-1 font-medium text-right">After</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {changes.map((c) => (
              <tr key={c.key}>
                <th scope="row" className="py-2 pr-3 text-left font-medium">{c.label}</th>
                <td className="py-2 pl-2 text-right font-mono text-ink-muted whitespace-nowrap">
                  <s>{c.before}</s>
                </td>
                <td className="py-2 pl-2 text-right font-mono font-semibold whitespace-nowrap">{c.after}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ReasonField id="save-reason" value={reason} onChange={setReason} placeholder="For example: raising limits after the Q3 audit" />
        <ErrorLine error={error} />
      </div>
      <footer className="flex flex-col-reverse gap-2 px-5 py-4 border-t border-line sm:flex-row sm:justify-end">
        <button type="button" onClick={onClose} disabled={busy} className={`${btnBase} text-ink hover:bg-surface-muted focus-visible:outline-accent`}>
          Keep editing
        </button>
        <button
          type="button"
          onClick={() => onConfirm(reason.trim())}
          disabled={busy || !reason.trim()}
          className={`${btnBase} bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-accent`}
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Save version {nextVersion}
        </button>
      </footer>
    </Sheet>
  );
}

// ─── Kill switch ─────────────────────────────────────────────────────────────

export const PAUSE_WORD = "PAUSE";

export function KillSwitchDialog({
  open,
  pausing,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** True when the switch is about to pause auto-pay, false when it resumes. */
  pausing: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [typed, setTyped] = useState("");

  const typedOk = !pausing || typed.trim().toUpperCase() === PAUSE_WORD;
  const canConfirm = !busy && !!reason.trim() && typedOk;

  return (
    <Sheet
      open={open}
      titleId="kill-title"
      title={pausing ? "Pause all automatic payouts?" : "Turn automatic payouts back on?"}
      busy={busy}
      onClose={onClose}
    >
      <div className="flex-1 overflow-y-auto px-5 py-4 flex flex-col gap-4 text-sm">
        <p className="text-ink-muted">
          {pausing
            ? "New claims will wait for HR until you turn this back on. Payouts already sent to PayPal are not affected."
            : "Claims that pass every check will be paid to PayPal right away again, within the limits on this page."}
        </p>
        <ReasonField
          id="kill-reason"
          value={reason}
          onChange={setReason}
          placeholder={pausing ? "For example: pausing during month-end close" : "For example: month-end close is done"}
        />
        {pausing && (
          <div>
            <label htmlFor="kill-typed" className="block text-sm font-medium">
              Type <span className="font-mono font-bold">{PAUSE_WORD}</span> to confirm
            </label>
            <input
              id="kill-typed"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="mt-1.5 w-full min-h-[44px] rounded-control border border-line-strong bg-surface px-3 text-sm font-mono uppercase focus-visible:outline-2 focus-visible:outline-accent"
            />
          </div>
        )}
        <ErrorLine error={error} />
      </div>
      <footer className="flex flex-col-reverse gap-2 px-5 py-4 border-t border-line sm:flex-row sm:justify-end">
        <button type="button" onClick={onClose} disabled={busy} className={`${btnBase} text-ink hover:bg-surface-muted focus-visible:outline-accent`}>
          Cancel
        </button>
        <button
          type="button"
          onClick={() => onConfirm(reason.trim())}
          disabled={!canConfirm}
          className={`${btnBase} ${
            pausing ? "bg-danger text-on-accent hover:bg-danger focus-visible:outline-danger" : "bg-accent text-on-accent hover:bg-accent-hover focus-visible:outline-accent"
          }`}
        >
          {busy && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          {pausing ? "Pause auto-pay" : "Resume auto-pay"}
        </button>
      </footer>
    </Sheet>
  );
}
