import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { getQuestionSummary } from "@/lib/actions/spendCheck";

const DAYS = 30;
const MAX_LISTED = 10; // the backend returns at most this many unanswered questions

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// asked_on is a UTC calendar day, so format it in UTC to keep the same day everywhere.
const day = (iso: string) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-MY", { day: "numeric", month: "short", timeZone: "UTC" });

/** What employees asked before spending. HR sees the questions, never who asked them. */
export default async function PolicyQuestionsPage() {
  const s = await getQuestionSummary(DAYS);

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8">
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-5">
        <Link href="/hr/policy"
          className="inline-flex w-fit min-h-11 items-center gap-2 rounded-control text-sm font-semibold text-ink-muted hover:text-ink">
          <ArrowLeft size={18} aria-hidden="true" /> Policy Studio
        </Link>

        <div>
          <h1 className="font-display text-2xl font-semibold text-ink md:text-3xl">Policy questions</h1>
          <p className="mt-1 text-sm text-ink-muted">
            What employees asked before spending, from the last {DAYS} days. Names are never shown here, so people can ask freely.
          </p>
          {s && (
            <p className="mt-3 text-sm text-ink tabular-nums">
              {s.total === 0
                ? `No questions in the last ${DAYS} days.`
                : `${plural(s.total, "question", "questions")} in the last ${DAYS} days. The policy couldn't answer ${s.unanswered} of them.`}
            </p>
          )}
        </div>

        {!s ? (
          <p className="text-sm text-danger">Couldn&apos;t load the questions. Reload the page to try again.</p>
        ) : (
          <>
            <section aria-labelledby="open-heading" className="rounded-card bg-surface p-4 shadow-ambient md:p-6">
              <h2 id="open-heading" className="font-display text-lg font-semibold text-ink">
                Questions the policy didn&apos;t answer
              </h2>
              <p className="mt-1 text-sm text-ink-muted">
                Each one points to a gap or unclear wording worth fixing in the policy.
                {s.recent_unanswered.length === MAX_LISTED && ` Showing the ${MAX_LISTED} most recent.`}
              </p>
              {s.recent_unanswered.length === 0 ? (
                <p className="mt-3 text-sm text-ink-muted">None in the last {DAYS} days.</p>
              ) : (
                <ul className="mt-3 divide-y divide-line border-y border-line">
                  {s.recent_unanswered.map((q, i) => (
                    <li key={`${q.asked_on}-${i}`} className="flex flex-col gap-0.5 py-3 text-sm sm:flex-row sm:items-baseline sm:justify-between sm:gap-4">
                      <p className="min-w-0 break-words text-ink">{q.question}</p>
                      <p className="shrink-0 text-xs text-ink-muted tabular-nums">{day(q.asked_on)}</p>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section aria-labelledby="top-heading" className="rounded-card bg-surface p-4 shadow-ambient md:p-6">
              <h2 id="top-heading" className="font-display text-lg font-semibold text-ink">Parts of the policy asked about most</h2>
              <p className="mt-1 text-sm text-ink-muted">From answered questions. Wording people keep asking about may need to be clearer.</p>
              {s.top_sections.length === 0 ? (
                <p className="mt-3 text-sm text-ink-muted">No answered questions in the last {DAYS} days.</p>
              ) : (
                <ol className="mt-3 divide-y divide-line border-y border-line">
                  {s.top_sections.map((t) => (
                    <li key={`${t.policy_title}-${t.section}`} className="py-3 text-sm">
                      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-0.5">
                        <p className="min-w-0 break-words font-semibold text-ink">{t.section}</p>
                        <p className="shrink-0 text-xs text-ink-muted tabular-nums">{plural(t.count, "question", "questions")}</p>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-muted">{t.policy_title}</p>
                      <p className="mt-1 break-words text-ink-muted">{t.excerpt}</p>
                    </li>
                  ))}
                </ol>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}
