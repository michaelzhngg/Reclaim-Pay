"use client";

import { useEffect, useRef, useState } from "react";
import type { TrustInfo } from "@/lib/api/reclaim-pay-types";
import { badgeName, limitLine, trustReasonLine } from "../_lib/copy";
import { badgeArcLabel, badgeProgress, badgeStatusLine } from "../_lib/badges";
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

/**
 * The employee's instant-payout badge inside an arc that fills toward the next badge.
 * The medal and the "See all badges" link both open the badges dialog.
 */
export default function BadgeBlock({ info }: { info: TrustInfo }) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const name = badgeName(info.trust_tier);
  const currency = info.currency || "MYR";
  const held = trustReasonLine(info) !== null;

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
      <div className="flex items-center gap-4 p-5 md:flex-col md:justify-center md:gap-3 md:p-6 md:text-center">
        <div className="relative size-28 shrink-0 md:size-36">
          <Gauge info={info} />
          <button
            type="button"
            onClick={show}
            aria-haspopup="dialog"
            aria-label={`${name} badge. See all badges`}
            className="absolute inset-[17%] rounded-full motion-safe:transition-transform motion-safe:duration-200 hover:scale-[1.04] active:scale-[0.98]"
          >
            <BadgeMedal tier={info.trust_tier} currency={currency} limit={info.auto_limit} className="size-full" />
          </button>
        </div>

        <div className="min-w-0">
          <h3 className="font-display text-lg font-semibold text-ink">{name} badge</h3>
          <p className="mt-0.5 font-body text-sm text-ink">{limitLine(info)}</p>
          <p className={`mt-1 font-body text-sm leading-relaxed text-pretty ${held ? "text-ink" : "text-ink-muted"}`}>
            {badgeStatusLine(info)}
          </p>
          <button
            type="button"
            onClick={show}
            aria-haspopup="dialog"
            className="-ml-1 mt-1 inline-flex min-h-11 items-center rounded-control px-1 font-body text-sm font-semibold text-accent underline-offset-4 hover:underline md:ml-0"
          >
            See all badges
          </button>
        </div>
      </div>
      {/* Outside the centred block so the dialog keeps left-aligned text. */}
      <BadgesDialog info={info} open={open} onClose={close} />
    </>
  );
}

export function BadgeBlockSkeleton() {
  return (
    <div aria-hidden className="flex items-center gap-4 p-5 md:flex-col md:p-6">
      <div className="size-28 shrink-0 rounded-full bg-surface-muted motion-safe:animate-pulse md:size-36" />
      <div className="w-full space-y-2 md:flex md:flex-col md:items-center">
        <div className="h-5 w-28 rounded bg-surface-muted motion-safe:animate-pulse" />
        <div className="h-4 w-44 rounded bg-surface-muted motion-safe:animate-pulse" />
      </div>
    </div>
  );
}
