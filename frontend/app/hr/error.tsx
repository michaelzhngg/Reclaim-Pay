"use client";

import { useEffect } from "react";

export default function HRError({
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
      <h2 className="text-xl font-semibold text-ink">Something went wrong</h2>
      <p className="text-sm text-ink-muted max-w-sm">
        An unexpected error occurred. Your data is safe. Please try again.
      </p>
      <button
        type="button"
        onClick={reset}
        className="min-h-[44px] px-4 bg-accent text-on-accent rounded-full text-sm font-semibold hover:bg-accent-hover transition-colors cursor-pointer"
      >
        Try again
      </button>
    </div>
  );
}
