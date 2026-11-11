"use client";

import { useEffect } from "react";

export default function EmployeeError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4 p-8 text-center">
      <h2 className="font-display text-xl font-semibold text-ink">This page did not load</h2>
      <p className="text-sm text-ink-muted max-w-sm">
        Something failed while loading this page. Claims you already submitted are saved.
        Press Try again to reload it. If it keeps failing, sign out and back in, or contact HR.
      </p>
      <button
        type="button"
        onClick={reset}
        className="inline-flex items-center justify-center min-h-[44px] px-4 bg-accent text-on-accent rounded-full text-sm font-semibold hover:bg-accent-hover transition-colors"
      >
        Try again
      </button>
    </div>
  );
}
