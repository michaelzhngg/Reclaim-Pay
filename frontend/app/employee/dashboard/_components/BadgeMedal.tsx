import { useId } from "react";
import type { TrustTier } from "@/lib/api/reclaim-pay-types";

// Light, mid and dark stops of each metal, plus a dark ink for the engraved amount.
const METAL: Record<TrustTier, { light: string; mid: string; dark: string; ink: string }> = {
  NEW: { light: "#f0c69c", mid: "#c58447", dark: "#7c4a1e", ink: "#3a1f08" },
  STANDARD: { light: "#fbfcfe", mid: "#cdd2da", dark: "#8a919e", ink: "#262a33" },
  TRUSTED: { light: "#fbe6a2", mid: "#dcae3f", dark: "#946813", ink: "#3b2904" },
};

/**
 * A medal in the badge's metal with the instant-payout amount engraved on its face.
 * Decorative: the badge name and limit are always written out next to it.
 */
export default function BadgeMedal({
  tier,
  currency,
  limit,
  className = "",
}: {
  tier: TrustTier;
  currency: string;
  limit: number;
  className?: string;
}) {
  const id = useId();
  const amount = Number.isInteger(limit) ? String(limit) : limit.toFixed(2);
  const m = METAL[tier];
  const amountSize = amount.length <= 3 ? 27 : amount.length === 4 ? 22 : 17;

  return (
    <svg viewBox="0 0 100 100" aria-hidden="true" focusable="false" className={className}>
      <defs>
        <linearGradient id={`${id}-face`} x1="0.15" y1="0.05" x2="0.85" y2="0.95">
          <stop offset="0" stopColor={m.light} />
          <stop offset="1" stopColor={m.mid} />
        </linearGradient>
        <linearGradient id={`${id}-rim`} x1="0.85" y1="0.95" x2="0.15" y2="0.05">
          <stop offset="0" stopColor={m.light} />
          <stop offset="0.5" stopColor={m.mid} />
          <stop offset="1" stopColor={m.dark} />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill={`url(#${id}-rim)`} stroke={m.dark} strokeWidth="1" />
      <circle cx="50" cy="50" r="40" fill={`url(#${id}-face)`} />
      <circle cx="50" cy="50" r="40" fill="none" stroke={m.dark} strokeOpacity="0.45" strokeWidth="1" />
      <text x="50" y="39" textAnchor="middle" fill={m.ink} fontSize="11" fontWeight="600" letterSpacing="0.5"
        className="font-body">
        {currency}
      </text>
      <text x="50" y={amountSize > 20 ? 66 : 62} textAnchor="middle" fill={m.ink} fontSize={amountSize}
        fontWeight="600" className="font-headline tabular-nums">
        {amount}
      </text>
    </svg>
  );
}
