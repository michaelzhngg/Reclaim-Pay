"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { AlertCircle, CheckCircle2, Info, X } from "lucide-react";
import { pushToast, removeToast, TOAST_DURATION_MS, type ToastInput, type ToastItem, type ToastTone } from "./queue";

type ToastFn = (input: ToastInput) => void;

const ToastContext = createContext<ToastFn | null>(null);

const TONE_ICON: Record<ToastTone, { Icon: typeof Info; className: string }> = {
  success: { Icon: CheckCircle2, className: "text-success" },
  error: { Icon: AlertCircle, className: "text-danger" },
  info: { Icon: Info, className: "text-ink-muted" },
};

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const nextId = useRef(0);

  const toast = useCallback<ToastFn>((input) => {
    nextId.current += 1;
    const item = { ...input, id: nextId.current };
    setToasts((q) => pushToast(q, item));
  }, []);

  const dismiss = useCallback((id: number) => setToasts((q) => removeToast(q, id)), []);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Sits above the mobile bottom nav (h-16 plus the safe area) until it disappears at lg. */}
      <div
        className="pointer-events-none fixed inset-x-4 z-[100] flex flex-col items-center gap-2 bottom-[calc(5rem+env(safe-area-inset-bottom))] sm:inset-x-auto sm:right-6 sm:items-end lg:bottom-6"
      >
        <AnimatePresence initial={false}>
          {toasts.map((t) => (
            <ToastCard key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </AnimatePresence>
      </div>
    </ToastContext.Provider>
  );
}

function ToastCard({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: number) => void }) {
  const reduceMotion = useReducedMotion();
  const remaining = useRef(TOAST_DURATION_MS);
  const startedAt = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const start = useCallback(() => {
    if (timer.current) return;
    startedAt.current = Date.now();
    timer.current = setTimeout(() => onDismiss(toast.id), remaining.current);
  }, [onDismiss, toast.id]);

  const pause = useCallback(() => {
    if (!timer.current) return;
    clearTimeout(timer.current);
    timer.current = null;
    remaining.current = Math.max(0, remaining.current - (Date.now() - startedAt.current));
  }, []);

  useEffect(() => {
    start();
    return () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [start]);

  const { Icon, className } = TONE_ICON[toast.tone];
  const offset = reduceMotion ? 0 : 12;

  return (
    <motion.div
      layout={!reduceMotion}
      role={toast.tone === "error" ? "alert" : "status"}
      aria-live={toast.tone === "error" ? "assertive" : "polite"}
      initial={{ opacity: 0, y: offset }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: offset, transition: { duration: 0.15 } }}
      transition={{ duration: reduceMotion ? 0 : 0.2, ease: "easeOut" }}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
      className="pointer-events-auto flex w-full max-w-sm items-start gap-3 rounded-card shadow-ambient bg-surface py-3 pl-4 pr-1 shadow-overlay"
    >
      <Icon aria-hidden className={`mt-0.5 h-5 w-5 shrink-0 ${className}`} />
      <div className="min-w-0 flex-1">
        <p className="font-body text-sm font-semibold text-ink">{toast.title}</p>
        {toast.description && (
          <p className="mt-0.5 font-body text-sm text-ink-muted">{toast.description}</p>
        )}
      </div>
      <button
        type="button"
        onClick={() => onDismiss(toast.id)}
        aria-label="Dismiss notification"
        className="-my-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-control text-ink-muted transition-colors hover:bg-surface-muted hover:text-ink"
      >
        <X aria-hidden className="h-4 w-4" />
      </button>
    </motion.div>
  );
}

export function useToast(): { toast: ToastFn } {
  const toast = useContext(ToastContext);
  if (!toast) throw new Error("useToast must be used within a ToastProvider");
  return useMemo(() => ({ toast }), [toast]);
}
