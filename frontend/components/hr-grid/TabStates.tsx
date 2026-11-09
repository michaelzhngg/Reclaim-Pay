"use client";

import type { ReactNode } from "react";
import { AlertCircle, Inbox, RefreshCw } from "lucide-react";

export function TabLoading({ label }: { label: string }) {
  return (
    <div role="status">
      <p className="sr-only">{label}</p>
      <div className="flex flex-col gap-2" aria-hidden="true">
        {[...Array(5)].map((_, i) => (
          <div key={i} className="h-[52px] rounded-lg bg-surface-muted animate-pulse" />
        ))}
      </div>
    </div>
  );
}

export function TabError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="alert"
      className="flex flex-col sm:flex-row sm:items-center gap-3 rounded-card border border-danger/30 bg-danger-soft px-4 py-4 text-sm text-danger"
    >
      <AlertCircle className="w-4 h-4 shrink-0" aria-hidden="true" />
      <span className="flex-1">{message}</span>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex items-center justify-center gap-1.5 min-h-[44px] px-4 rounded-lg bg-surface border border-danger/30 font-semibold hover:bg-danger-soft focus-visible:outline-2 focus-visible:outline-danger cursor-pointer"
      >
        <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
        Try again
      </button>
    </div>
  );
}

export function TabEmpty({ title, children, action }: { title: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-card shadow-ambient bg-surface px-6 py-14 text-center">
      <Inbox className="w-8 h-8 mx-auto text-ink-muted" aria-hidden="true" />
      <p className="font-display font-semibold text-lg text-ink mt-3">{title}</p>
      <p className="text-sm text-ink-muted mt-1">{children}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}
