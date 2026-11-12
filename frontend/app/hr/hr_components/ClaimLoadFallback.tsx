"use client";

import { Loader2 } from "lucide-react";
import type { ClaimLoad } from "@/lib/hooks/useClaimBundle";

/** What the HR claim pages show until a claim has loaded: loading, not found, or a retry. */
export function ClaimLoadFallback({
  load,
  id,
  onRetry,
  onBack,
}: {
  load: Exclude<ClaimLoad, { state: "ready" }>;
  id: string;
  onRetry: () => void;
  onBack: () => void;
}) {
  if (load.state === "loading") {
    return (
      <div role="status" className="flex items-center justify-center min-h-[60vh] gap-3 text-ink-muted">
        <Loader2 className="w-5 h-5 animate-spin" aria-hidden="true" />
        <span className="text-sm">Loading claim...</span>
      </div>
    );
  }

  const backButton = (
    <button
      type="button"
      onClick={onBack}
      className="min-h-[44px] px-5 rounded-full border border-line-strong text-ink text-sm font-semibold hover:bg-surface-muted transition-colors cursor-pointer"
    >
      Back to Dashboard
    </button>
  );

  if (load.state === "missing") {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4 text-center">
        <p className="text-ink-muted">
          No claim found with ID <code className="font-mono break-all">{id}</code>. It may have been deleted, or the link is wrong.
        </p>
        {backButton}
      </div>
    );
  }

  return (
    <div role="alert" className="flex flex-col items-center justify-center min-h-[60vh] gap-4 px-4 text-center">
      <p className="text-ink-muted">Couldn&apos;t load this claim. Check your connection, then try again.</p>
      <div className="flex flex-wrap justify-center gap-3">
        <button
          type="button"
          onClick={onRetry}
          className="min-h-[44px] px-5 rounded-full bg-accent text-on-accent text-sm font-semibold hover:bg-accent-hover transition-colors cursor-pointer"
        >
          Try again
        </button>
        {backButton}
      </div>
    </div>
  );
}
