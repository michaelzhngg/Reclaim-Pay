"use client";

import { useEffect } from "react";
import type { TrustInfo } from "@/lib/api/reclaim-pay-types";
import { Sheet, btnBase } from "@/components/ui/Sheet";
import {
  EXPLAINER_INTRO,
  EXPLAINER_OPEN_NOTICE_LINE,
  EXPLAINER_TITLE,
  correctionRuleLine,
  recentChangeLines,
} from "../_lib/copy";
import { badgeLevels } from "../_lib/badges";
import BadgeMedal from "./BadgeMedal";

/** Stops the page behind the dialog from scrolling: the window on phones, <main> from lg up. */
function useScrollLock(locked: boolean) {
  useEffect(() => {
    if (!locked) return;
    const targets = [document.documentElement, document.getElementById("main-content")].filter(
      (el): el is HTMLElement => el !== null,
    );
    const before = targets.map(el => el.style.overflow);
    targets.forEach(el => (el.style.overflow = "hidden"));
    return () => targets.forEach((el, i) => (el.style.overflow = before[i]));
  }, [locked]);
}

export default function BadgesDialog({ info, open, onClose }: { info: TrustInfo; open: boolean; onClose: () => void }) {
  useScrollLock(open);
  const levels = badgeLevels(info);
  const changes = recentChangeLines(info);
  const currency = info.currency || "MYR";

  return (
    <Sheet open={open} titleId="badges-dialog-title" title="Instant payout badges" busy={false} onClose={onClose}>
      <div className="flex-1 space-y-6 overflow-y-auto px-5 py-4 font-body text-sm leading-relaxed text-pretty">
        <p className="text-ink-muted">{EXPLAINER_INTRO}</p>

        <ul className="space-y-2" aria-label="Badges">
          {levels.map(level => (
            <li
              key={level.tier}
              className={`flex items-center gap-3 rounded-control p-3 ${level.current ? "bg-accent-soft" : "bg-surface-muted"}`}
            >
              <BadgeMedal
                tier={level.tier}
                currency={currency}
                limit={level.autoLimit}
                className="size-12 shrink-0"
              />
              <div className="min-w-0">
                <p className="flex flex-wrap items-baseline gap-x-2 font-semibold text-ink">
                  {level.name}
                  {level.current && <span className="text-xs font-semibold text-accent">Your badge</span>}
                </p>
                <p className="text-ink">{level.limit}</p>
                <p className="text-ink-muted">{level.howTo}</p>
              </div>
            </li>
          ))}
        </ul>

        {changes.length > 0 && (
          <section aria-labelledby="badges-changes-heading">
            <h3 id="badges-changes-heading" className="font-semibold text-ink">Recent changes</h3>
            <ul className="mt-1.5 space-y-1.5 text-ink-muted">
              {changes.map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </section>
        )}

        <section aria-labelledby="badges-how-heading" className="space-y-2 text-ink-muted">
          <h3 id="badges-how-heading" className="font-semibold text-ink">{EXPLAINER_TITLE}</h3>
          <p>{correctionRuleLine(info)}</p>
          <p>{EXPLAINER_OPEN_NOTICE_LINE}</p>
        </section>
      </div>

      <footer className="flex justify-end border-t border-line px-5 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
        <button
          type="button"
          onClick={onClose}
          className={`${btnBase} w-full bg-ink text-on-ink hover:bg-ink-3 sm:w-auto`}
        >
          Close
        </button>
      </footer>
    </Sheet>
  );
}
