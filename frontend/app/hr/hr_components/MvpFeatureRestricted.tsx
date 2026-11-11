import Link from "next/link";
import { ArrowLeft, type LucideIcon } from "lucide-react";

type MvpFeatureRestrictedProps = {
  icon: LucideIcon;
  title: string;
  description: string;
  badge?: string;
  backHref?: string;
  backLabel?: string;
};

export default function MvpFeatureRestricted({
  icon: Icon,
  title,
  description,
  badge = "Feature Restricted - MVP Production",
  backHref = "/employee/dashboard",
  backLabel = "Back to Dashboard",
}: MvpFeatureRestrictedProps) {
  return (
    <main className="min-h-dvh pb-24 md:pb-12 bg-paper">
      <div className="w-full max-w-4xl mx-auto px-4 md:px-6 pt-8 md:pt-10">
        <section className="bg-surface shadow-ambient rounded-card p-6 md:p-8">
          <span className="inline-flex items-center rounded-full bg-surface-muted text-ink-muted px-3 py-1 text-xs font-medium">
            {badge}
          </span>

          <div className="mt-5 flex items-start gap-3">
            <Icon className="w-6 h-6 mt-1 text-ink-muted shrink-0" aria-hidden="true" />
            <div>
              <h1 className="font-display text-2xl md:text-3xl font-semibold text-ink">
                {title}
              </h1>
              <p className="font-body text-sm md:text-base text-ink-muted mt-2 max-w-2xl">
                {description}
              </p>
            </div>
          </div>

          <div className="mt-8 rounded-card shadow-ambient bg-surface-muted p-4">
            <p className="font-body text-sm text-ink">
              This screen is intentionally simplified for MVP production. The previous full UI is preserved in code and can be restored later.
            </p>
          </div>

          <div className="mt-8">
            <Link
              href={backHref}
              className="inline-flex items-center gap-2 min-h-[44px] rounded-full bg-accent text-on-accent px-4 text-sm font-semibold hover:bg-accent-hover transition-colors"
            >
              <ArrowLeft className="w-4 h-4" />
              {backLabel}
            </Link>
          </div>
        </section>
      </div>
    </main>
  );
}
