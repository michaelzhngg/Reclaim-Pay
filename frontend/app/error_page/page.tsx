"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import Image from "next/image";

// ─── 404 Page ─────────────────────────────────────────────────────────────────
// Also rendered by app/not-found.tsx.

export default function ErrorPage() {
  const router = useRouter();

  return (
    <main className="min-h-dvh bg-paper flex flex-col items-center justify-center px-4 py-12 sm:px-6">
      <div className="w-full max-w-md">
        <Link href="/" className="mb-8 inline-flex min-h-11 items-center gap-2 rounded-control text-ink">
          <Image src="/images/logo.svg" alt="" width={24} height={24} className="w-6 h-6 object-contain" />
          <span className="font-display text-lg font-semibold">Reclaim Pay</span>
        </Link>

        <div className="rounded-card shadow-ambient bg-surface p-6 sm:p-8">
          <p className="font-mono text-sm text-ink-muted">Error 404</p>
          <h1 className="mt-2 font-display text-2xl sm:text-3xl font-semibold text-ink">
            We can&apos;t find this page
          </h1>
          <p className="mt-3 text-sm leading-relaxed text-ink-muted">
            The link may be out of date or mistyped, or the page has moved. Your claims and data are not affected.
            Go back to where you were, or start again from the home page.
          </p>

          <div className="mt-8 flex flex-col gap-2 sm:flex-row sm:gap-3">
            <button
              type="button"
              onClick={() => router.back()}
              className="inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong bg-surface px-5 text-sm font-semibold text-ink transition-colors hover:bg-surface-muted"
            >
              Go back
            </button>
            <Link
              href="/"
              className="inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 text-sm font-semibold text-on-accent transition-colors hover:bg-accent-hover"
            >
              Go to the home page
            </Link>
          </div>
        </div>
      </div>
    </main>
  );
}
