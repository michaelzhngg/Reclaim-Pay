"use client";

import { useEffect, useRef, useState } from "react";
import type { TrustInfo } from "@/lib/api/reclaim-pay-types";
import { badgeName, formatLimit, payoutLimitPrefix, trustReasonLine } from "../_lib/copy";
import type { TrustTier } from "@/lib/api/reclaim-pay-types";
import { TIER_ORDER, badgeArcLabel, badgeAt, badgeProgress, lockedBadgeHint } from "../_lib/badges";
import BadgeMedal from "./BadgeMedal";
import BadgesDialog from "./BadgesDialog";

const C = 60;
const R = 54;
// 300 degrees of arc, with the 60 degree gap centred at 12 o'clock for the count.
const START = -60;
const END = 240;

function point(deg: number) {
  const rad = (deg * Math.PI) / 180;
  return `${(C + R * Math.cos(rad)).toFixed(2)} ${(C + R * Math.sin(rad)).toFixed(2)}`;
}

const ARC = `M ${point(START)} A ${R} ${R} 0 1 1 ${point(END)}`;

function Gauge({ info }: { info: TrustInfo }) {
  const progress = badgeProgress(info);
  // Starts empty and sweeps to the real value once, so the fill reads as progress.
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = requestAnimationFrame(() => setShown(progress.fraction));
    return () => cancelAnimationFrame(id);
  }, [progress.fraction]);

  return (
    <svg viewBox="0 0 120 120" role="img" aria-label={badgeArcLabel(info)} className="pointer-events-none absolute inset-0 size-full">
      <path d={ARC} fill="none" strokeWidth="6" strokeLinecap="round" className="stroke-line" />
      {progress.fraction > 0 && (
        <path
          d={ARC}
          pathLength={100}
          fill="none"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray="100 100"
          strokeDashoffset={100 - shown * 100}
          className="stroke-accent motion-safe:transition-[stroke-dashoffset] motion-safe:duration-700 motion-safe:ease-out"
        />
      )}
      <text x={C} y={C - R} textAnchor="middle" dominantBaseline="central" fontSize="12" fontWeight="600"
        className="fill-ink font-body tabular-nums">
        {progress.label}
      </text>
    </svg>
  );
}

// Side badges fade toward the outer edge of the card.
const FADE: Record<number, string | undefined> = {
  [-1]: "linear-gradient(to right, transparent, black 80%)",
  1: "linear-gradient(to left, transparent, black 80%)",
};

/** Opacity for a badge by its slot (-1 left, 0 middle, 1 right) and whether it is locked. */
function opacity(offset: number, locked: boolean): number {
  if (Math.abs(offset) > 1) return 0;
  if (offset === 0) return locked ? 0.5 : 1;
  return locked ? 0.4 : 0.6;
}

/**
 * A three-badge carousel. The employee's own badge starts in the middle; the next badge
 * sits inside an arc that fills as approved claims count toward it. Tapping a side badge slides it into the middle: a locked
 * badge shows how many approved claims reach it. The middle medal opens the badges dialog.
 * Every badge stays mounted and moves by transform, so the switch animates and nothing reflows.
 */
export default function BadgeBlock({ info }: { info: TrustInfo }) {
  const [open, setOpen] = useState(false);
  const [viewed, setViewed] = useState<TrustTier>(info.trust_tier);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const currency = info.currency || "MYR";
  const reason = trustReasonLine(info);
  const centre = TIER_ORDER.indexOf(viewed);
  // The arc is progress toward the next badge, so it only surrounds that badge.
  const showArc = viewed === info.next_tier;

  function show(e: React.MouseEvent<HTMLButtonElement>) {
    trigger.current = e.currentTarget;
    setOpen(true);
  }

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  return (
    <>
      <div className="flex h-full flex-col justify-center gap-4 p-5 md:p-6">
        <div className="relative mx-auto h-36 w-full max-w-80 [--step:6.25rem] md:h-40 md:[--step:7rem]">
          <div
            className={`absolute left-1/2 top-1/2 size-36 -translate-x-1/2 -translate-y-1/2 motion-safe:transition-opacity motion-safe:duration-300 md:size-40 ${showArc ? "opacity-100" : "opacity-0"}`}
            aria-hidden={!showArc}
          >
            <Gauge info={info} />
          </div>

          {TIER_ORDER.map((tier, i) => {
            const slot = badgeAt(info, tier);
            const offset = i - centre;
            const locked = slot.state === "locked";
            const onScreen = Math.abs(offset) <= 1;
            const middle = offset === 0;
            const status = slot.state === "current" ? "" : `, ${slot.state}`;
            return (
              <button
                key={tier}
                type="button"
                tabIndex={onScreen ? 0 : -1}
                aria-hidden={!onScreen}
                aria-haspopup={middle ? "dialog" : undefined}
                aria-label={middle ? `${badgeName(tier)} badge${status}. See all badges` : `Show the ${badgeName(tier)} badge${status}`}
                onClick={middle ? show : () => setViewed(tier)}
                className={`absolute left-1/2 top-1/2 size-24 rounded-full md:size-[6.75rem] motion-safe:transition-[transform,opacity,filter] motion-safe:duration-500 motion-safe:ease-[cubic-bezier(0.22,1,0.36,1)] ${locked ? "grayscale" : ""} ${middle ? "" : "drop-shadow-md"} ${onScreen ? "" : "pointer-events-none"}`}
                style={{
                  transform: `translate(-50%, -50%) translateX(calc(${offset} * var(--step))) scale(${middle ? 1 : 0.5})`,
                  opacity: opacity(offset, locked),
                  maskImage: FADE[offset],
                  WebkitMaskImage: FADE[offset],
                }}
              >
                <BadgeMedal tier={tier} currency={currency} limit={slot.limit} className="size-full" />
              </button>
            );
          })}
        </div>

        {/* Every badge's text sits in the same grid cell, so the block is always as tall as the longest one. */}
        <div className="grid text-center" aria-live="polite">
          {TIER_ORDER.map(tier => {
            const slot = badgeAt(info, tier);
            const shown = tier === viewed;
            const status = slot.state === "current" ? "" : `${badgeName(tier)} · ${slot.state === "locked" ? "Locked" : "Unlocked"} · `;
            const note = slot.state === "locked" ? lockedBadgeHint(info, tier) : slot.state === "current" ? reason : null;
            return (
              <div
                key={tier}
                aria-hidden={!shown}
                className={`[grid-area:1/1] motion-safe:transition-opacity motion-safe:duration-300 ${shown ? "opacity-100" : "pointer-events-none opacity-0"}`}
              >
                <p className="font-body text-sm text-ink-muted">{status}{payoutLimitPrefix(info)}</p>
                <p className={`mt-0.5 font-headline text-3xl font-medium tabular-nums tracking-[-0.02em] md:text-4xl ${slot.state === "current" ? "text-ink" : "text-ink-muted"}`}>
                  {formatLimit(currency, slot.limit)}
                </p>
                {note && <p className="mt-2 font-body text-sm leading-relaxed text-pretty text-ink">{note}</p>}
              </div>
            );
          })}
        </div>
      </div>
      {/* Outside the centred block so the dialog keeps left-aligned text. */}
      <BadgesDialog info={info} open={open} onClose={close} />
    </>
  );
}

export function BadgeBlockSkeleton() {
  return (
    <div aria-hidden className="flex flex-col items-center gap-4 p-5 md:p-6">
      <div className="size-36 rounded-full bg-surface-muted motion-safe:animate-pulse md:size-40" />
      <div className="h-4 w-36 rounded bg-surface-muted motion-safe:animate-pulse" />
      <div className="h-8 w-28 rounded bg-surface-muted motion-safe:animate-pulse" />
    </div>
  );
}
