"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { AlertCircle, X } from "lucide-react";

export const btnBase =
  "inline-flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-control text-sm font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer";

/** Bottom sheet on phones, centered dialog from sm up. Native <dialog> gives Escape and focus containment. */
export function Sheet({
  open,
  titleId,
  title,
  busy,
  onClose,
  children,
}: {
  open: boolean;
  titleId: string;
  title: string;
  busy: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose();
      }}
      className="m-0 mt-auto w-full max-w-none max-h-[90dvh] rounded-t-dialog p-0 bg-surface text-ink shadow-overlay backdrop:bg-ink/40 sm:m-auto sm:max-w-lg sm:rounded-dialog"
    >
      <div className="flex flex-col max-h-[90dvh]">
        <header className="flex items-start justify-between gap-4 px-5 pt-5 pb-3 border-b border-line">
          <h2 id={titleId} className="font-display font-semibold text-lg">
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label="Close"
            className="inline-flex items-center justify-center w-11 h-11 -mr-2 -mt-2 rounded-lg text-ink-muted hover:bg-surface-muted disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent cursor-pointer"
          >
            <X className="w-5 h-5" aria-hidden="true" />
          </button>
        </header>
        {children}
      </div>
    </dialog>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="flex items-start gap-2 text-sm text-danger font-medium">
      <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" aria-hidden="true" />
      {error}
    </p>
  );
}
