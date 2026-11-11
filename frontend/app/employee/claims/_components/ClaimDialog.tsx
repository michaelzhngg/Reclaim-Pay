"use client";

import { useEffect, useRef, type ReactNode } from "react";

interface ClaimDialogProps {
  open: boolean;
  /** id of the heading that names the dialog. */
  labelledBy: string;
  /** Escape pressed. The dialog stays open; the caller decides what happens. */
  onCancel: () => void;
  /** Where focus goes on close when the element that opened the dialog is gone. */
  fallbackFocus?: () => HTMLElement | null;
  className?: string;
  children: ReactNode;
}

/**
 * Native modal <dialog>, the same approach as components/ui/Sheet.tsx: the page
 * behind is inert, so focus stays inside. Fades in over 150 ms (none under
 * reduced motion) and gives focus back to the element that opened it.
 */
export function ClaimDialog({ open, labelledBy, onCancel, fallbackFocus, className = "", children }: ClaimDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const fallback = useRef(fallbackFocus);
  useEffect(() => {
    fallback.current = fallbackFocus;
  });

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      d.showModal();
    }
    if (!open && d.open) {
      d.close();
      // Wait a frame so a re-render that swaps the screen has placed the fallback.
      requestAnimationFrame(() => {
        const target = opener.current?.isConnected ? opener.current : fallback.current?.();
        target?.focus();
      });
    }
  }, [open]);

  // Unmounting while open (leaving the page) must not leave the page inert.
  useEffect(() => {
    const d = ref.current;
    return () => {
      if (d?.open) d.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      aria-labelledby={labelledBy}
      onCancel={e => {
        e.preventDefault();
        onCancel();
      }}
      className={`m-auto w-[calc(100%-2rem)] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-dialog border border-line bg-surface p-0 text-ink shadow-overlay backdrop:bg-ink/40 opacity-100 transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none ${className}`}
    >
      {children}
    </dialog>
  );
}
