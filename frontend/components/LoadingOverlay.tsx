"use client";

import Image from "next/image";

// Full-screen cover shown while the session loads or a signed-in route changes (see AuthContext).
export default function LoadingOverlay({ show }: { show: boolean }) {
  if (!show) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-0 z-[10000] flex flex-col items-center justify-center bg-paper px-4"
    >
      <div className="mb-3 flex items-center gap-2.5">
        <Image src="/images/logo.svg" alt="" width={32} height={32} className="w-8 h-8 object-contain" priority />
        <span className="font-display text-2xl font-semibold text-ink select-none">Reclaim Pay</span>
      </div>

      <p className="mb-8 text-center text-sm text-ink-muted">Loading, one moment...</p>

      {/* Indeterminate bar. Under reduced motion the global rule stops it after one pass. */}
      <div aria-hidden className="h-1 w-32 overflow-hidden rounded-full bg-line">
        <div className="h-full w-2/5 rounded-full bg-accent animate-[loading_1.4s_ease-in-out_infinite]" />
      </div>

      <style>{`
        @keyframes loading {
          0%   { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }
      `}</style>
    </div>
  );
}
