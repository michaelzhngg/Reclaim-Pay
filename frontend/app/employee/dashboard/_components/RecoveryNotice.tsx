"use client";

import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { disputeRecovery } from "@/lib/actions/recoveries";
import type { DisputeError, Recovery } from "@/lib/api/reclaim-pay-types";
import { disputeErrorLine, isDisputeOpen, noticeLine, statusLines } from "../_lib/copy";

const focusRing = "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent";

/**
 * An overpayment the employee is asked to return. Written to inform, not
 * accuse: the amount, the claim, what happened and where it stands.
 * `linked` marks the notice a notification pointed at (?recovery={id}): it is
 * scrolled into view, outlined, and its dispute form opens if a dispute is possible.
 */
export default function RecoveryNotice({ recovery: initial, linked = false }: { recovery: Recovery; linked?: boolean }) {
  const [recovery, setRecovery] = useState(initial);
  const [formOpen, setFormOpen] = useState(
    () => linked && initial.status === "NOTICE_SENT" && isDisputeOpen(initial),
  );
  const [note, setNote] = useState("");
  // An empty note is a form problem, kept apart from the server's refusals.
  const [emptyNote, setEmptyNote] = useState(false);
  const [error, setError] = useState<DisputeError | null>(null);
  const [sending, setSending] = useState(false);
  // Checked again on submit, so a window that closes while the page is open shows as closed.
  const [now, setNow] = useState(() => new Date());
  // The backend said the window closed, even if this device's clock disagrees.
  const [closedByServer, setClosedByServer] = useState(false);

  const sectionRef = useRef<HTMLElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const disputeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocus = useRef(false);
  const ids = useId();

  const canDispute = recovery.status === "NOTICE_SENT" && isDisputeOpen(recovery, now) && !closedByServer;
  const { line, detail } = statusLines(recovery, closedByServer ? new Date(recovery.dispute_until) : now);
  const formError = emptyNote
    ? "Add a short note so HR knows what to check."
    : error === "FAILED" ? disputeErrorLine("FAILED") : null;
  const cardError = error && error !== "FAILED" ? disputeErrorLine(error) : null;

  useEffect(() => {
    if (linked) sectionRef.current?.scrollIntoView({ block: "center" });
  }, [linked]);

  useEffect(() => {
    if (formOpen) {
      textareaRef.current?.focus();
    } else if (returnFocus.current) {
      // Back to the button that opened the form.
      returnFocus.current = false;
      disputeButtonRef.current?.focus();
    }
  }, [formOpen]);

  function closeForm() {
    returnFocus.current = true;
    setFormOpen(false);
    setEmptyNote(false);
    setError(null);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    const text = note.trim();
    if (!text) {
      setEmptyNote(true);
      textareaRef.current?.focus();
      return;
    }
    const current = new Date();
    setNow(current);
    if (!isDisputeOpen(recovery, current)) {
      setFormOpen(false);
      setError("WINDOW_CLOSED");
      return;
    }
    setSending(true);
    setError(null);
    const res = await disputeRecovery(recovery.recovery_id, text);
    setSending(false);
    if (res.recovery) {
      setRecovery(res.recovery);
      setFormOpen(false);
      return;
    }
    const err = res.error ?? "FAILED";
    setError(err);
    if (err === "WINDOW_CLOSED") setClosedByServer(true);
    if (err !== "FAILED") setFormOpen(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLFormElement>) {
    if (e.key === "Escape" && !sending) closeForm();
  }

  return (
    <section
      ref={sectionRef}
      aria-labelledby={`${ids}-heading`}
      className={`rounded-card border bg-warning-soft p-4 md:p-5 ${
        linked ? "border-accent ring-1 ring-accent" : "border-warning/40"
      }`}
    >
      <h3 id={`${ids}-heading`} className="font-display text-base font-semibold text-ink">
        Overpayment notice
      </h3>
      <p className="mt-1.5 font-body text-sm leading-relaxed text-ink">{noticeLine(recovery)}</p>
      <p className="mt-1 font-body text-sm leading-relaxed text-ink-muted">{recovery.reason}</p>

      <div aria-live="polite">
        <p className="mt-3 font-body text-sm font-semibold text-ink">{line}</p>
        {detail && <p className="mt-1 font-body text-sm leading-relaxed text-ink-muted">{detail}</p>}
        {cardError && <p className="mt-2 font-body text-sm leading-relaxed text-ink">{cardError}</p>}
      </div>

      {canDispute && !formOpen && (
        <button
          ref={disputeButtonRef}
          type="button"
          onClick={() => setFormOpen(true)}
          className={`mt-3 inline-flex min-h-11 items-center rounded-control border border-line-strong bg-surface px-4 py-2 font-body text-sm font-semibold text-ink hover:bg-surface-muted ${focusRing}`}
        >
          Dispute
        </button>
      )}

      {canDispute && formOpen && (
        <form onSubmit={submit} onKeyDown={onKeyDown} noValidate className="mt-3 flex flex-col gap-2">
          <label htmlFor={`${ids}-note`} className="font-body text-sm font-semibold text-ink">
            What should HR know?
          </label>
          <textarea
            ref={textareaRef}
            id={`${ids}-note`}
            value={note}
            onChange={e => {
              setNote(e.target.value);
              setEmptyNote(false);
              if (error === "FAILED") setError(null);
            }}
            rows={3}
            maxLength={1000}
            aria-invalid={formError ? true : undefined}
            aria-describedby={formError ? `${ids}-error` : undefined}
            placeholder="For example: breakfast wasn't included in my room rate."
            className={`w-full rounded-control border border-line-strong bg-surface px-3 py-2 font-body text-base md:text-sm text-ink placeholder:text-ink-muted ${focusRing}`}
          />
          {formError && (
            <p id={`${ids}-error`} role="alert" className="font-body text-sm text-danger">
              {formError}
            </p>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="submit"
              disabled={sending}
              className={`inline-flex min-h-11 items-center rounded-full bg-accent px-4 py-2 font-body text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60 ${focusRing}`}
            >
              {sending ? "Sending…" : "Send dispute"}
            </button>
            <button
              type="button"
              onClick={closeForm}
              disabled={sending}
              className={`inline-flex min-h-11 items-center rounded-control px-4 py-2 font-body text-sm font-semibold text-ink hover:bg-surface ${focusRing}`}
            >
              Cancel
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
