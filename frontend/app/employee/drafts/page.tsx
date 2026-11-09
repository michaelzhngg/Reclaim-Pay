"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  Search,
  AlertCircle,
  Trash2,
  Loader2,
} from "lucide-react";
import { listDrafts, deleteDraft } from "@/lib/actions/claims";
import type { DraftSummary } from "@/lib/api/types";

export default function DraftsPage() {
  const router = useRouter();
  const [drafts, setDrafts] = useState<DraftSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  useEffect(() => {
    listDrafts().then((d) => {
      setDrafts(d);
      setLoading(false);
    });
  }, []);

  const filteredDrafts = useMemo(() => {
    if (!searchQuery.trim()) return drafts;
    const q = searchQuery.toLowerCase();
    return drafts.filter(
      (d) =>
        d.title?.toLowerCase().includes(q) ||
        d.main_category?.toLowerCase().includes(q)
    );
  }, [drafts, searchQuery]);

  async function handleDelete(draftId: string) {
    setDeletingId(draftId);
    const result = await deleteDraft(draftId);
    if (!result.error) {
      setDrafts((prev) => prev.filter((d) => d.draft_id !== draftId));
    }
    setDeletingId(null);
  }

  function handleResume(draftId: string) {
    router.push(`/employee/claims?draft_id=${draftId}`);
  }

  function formatDate(dateStr: string | null) {
    if (!dateStr) return "Not set";
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  return (
    <div className="px-4 pt-6 pb-24 md:px-8 md:pt-8 md:pb-12 lg:px-12 lg:pt-10 lg:pb-10 max-w-screen-xl mx-auto w-full">
      <div className="flex flex-col gap-6 w-full">
        {/* Header */}
        <div className="flex flex-col gap-1">
          <h2 className="font-display font-semibold text-2xl md:text-3xl text-ink">
            Saved drafts
          </h2>
          <p className="text-base text-ink-muted font-body leading-relaxed">
            Pick up a claim you started and did not submit.
          </p>
        </div>

        {/* ── Localized Search Bar ── */}
        <div className="relative max-w-md w-full">
          <Search
            className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-muted"
            strokeWidth={2}
            aria-hidden="true"
          />
          <input
            type="search"
            aria-label="Search drafts"
            placeholder="Search drafts by title or policy"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full min-h-[44px] bg-surface border border-line-strong text-ink text-base md:text-sm rounded-control pl-10 pr-4 transition-colors placeholder:text-ink-muted"
          />
        </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20" role="status">
          <Loader2 className="w-6 h-6 text-ink-muted motion-safe:animate-spin" strokeWidth={2} aria-hidden="true" />
          <span className="sr-only">Loading drafts</span>
        </div>
      )}

      {/* Empty state */}
      {!loading && drafts.length === 0 && (
        <div className="bg-surface rounded-card shadow-ambient flex flex-col items-start py-8 px-6 max-w-xl">
          <h3 className="text-base font-semibold text-ink font-display mb-1.5">
            No drafts yet
          </h3>
          <p className="text-sm text-ink-muted font-body leading-relaxed mb-5">
            When you save a claim before submitting it, it shows up here so you can finish it later.
          </p>
          <button
            type="button"
            onClick={() => router.push("/employee/claims")}
            className="inline-flex items-center min-h-[44px] px-5 rounded-full bg-accent text-on-accent text-sm font-semibold font-body hover:bg-accent-hover transition-colors"
          >
            Upload New Claim
          </button>
        </div>
      )}

      {/* Search with no match */}
      {!loading && drafts.length > 0 && filteredDrafts.length === 0 && (
        <p className="text-sm text-ink-muted font-body">No drafts match &ldquo;{searchQuery}&rdquo;.</p>
      )}

      {/* Draft list */}
      {!loading && filteredDrafts.length > 0 && (
        <ul className="bg-surface rounded-card shadow-ambient divide-y divide-line">
          {filteredDrafts.map((draft) => {
            const isDeleting = deletingId === draft.draft_id;
            const hasFailed = draft.failed_receipt_count > 0;
            const title = draft.title || "Untitled Draft";

            return (
              <li
                key={draft.draft_id}
                className="flex flex-col sm:flex-row sm:items-center gap-3 sm:gap-4 px-4 py-4 md:px-5"
              >
                {/* Title, policy, meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2 mb-1">
                    <p className="text-sm font-semibold text-ink font-body truncate">
                      {title}
                    </p>
                    {hasFailed && (
                      <span className="shrink-0 text-xs font-medium text-warning bg-warning-soft px-2 py-0.5 rounded-full font-body inline-flex items-center gap-1">
                        <AlertCircle className="w-3 h-3" aria-hidden="true" />
                        {draft.failed_receipt_count} failed
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-ink-muted font-body truncate">
                    {draft.main_category && <>{draft.main_category} · </>}
                    {draft.receipt_count} receipt{draft.receipt_count !== 1 ? "s" : ""} · {formatDate(draft.updated_at)}
                  </p>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => handleDelete(draft.draft_id)}
                    disabled={isDeleting}
                    className="w-11 h-11 rounded-control flex items-center justify-center text-ink-muted hover:bg-danger-soft hover:text-danger transition-colors disabled:opacity-50"
                    aria-label={`Delete draft ${title}`}
                  >
                    {isDeleting ? (
                      <Loader2 className="w-4 h-4 motion-safe:animate-spin" strokeWidth={2} aria-hidden="true" />
                    ) : (
                      <Trash2 className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleResume(draft.draft_id)}
                    aria-label={`Resume draft ${title}`}
                    className="inline-flex items-center min-h-[44px] px-4 rounded-control border border-line-strong bg-surface text-ink text-sm font-semibold font-body hover:bg-surface-muted transition-colors"
                  >
                    Resume
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      </div>
    </div>
  );
}
