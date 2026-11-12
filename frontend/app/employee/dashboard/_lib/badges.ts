// Instant-payout badges: Bronze, Silver and Gold stand for the NEW, STANDARD and
// TRUSTED levels. Pure, so the arc maths and wording are unit-tested.

import type { TrustInfo, TrustLevel, TrustTier } from "@/lib/api/reclaim-pay-types";
import { badgeName, formatLimit, isTopTier, trustReasonLine, type BadgeName } from "./copy";

export const TIER_ORDER: readonly TrustTier[] = ["NEW", "STANDARD", "TRUSTED"];

/** Mirrors backend/engine/risk/autonomy.py. Used only when an older backend sends no `levels`. */
export const FALLBACK_LEVELS: readonly TrustLevel[] = [
  { tier: "NEW", auto_limit: 50, min_paid_claims: 0 },
  { tier: "STANDARD", auto_limit: 100, min_paid_claims: 3 },
  { tier: "TRUSTED", auto_limit: 200, min_paid_claims: 10 },
];

/**
 * All three levels, lowest first. Without `levels` from the backend the fallback
 * thresholds apply, with the live limits for the employee's current and next level.
 */
export function resolveLevels(info: TrustInfo): TrustLevel[] {
  const sent = info.levels?.length ? info.levels : null;
  return TIER_ORDER.map(tier => {
    const base = sent?.find(l => l.tier === tier) ?? FALLBACK_LEVELS.find(l => l.tier === tier)!;
    if (sent) return base;
    if (tier === info.trust_tier) return { ...base, auto_limit: info.auto_limit };
    if (tier === info.next_tier && info.next_limit != null) return { ...base, auto_limit: info.next_limit };
    return base;
  });
}

export interface BadgeProgress {
  /** Approved claims already counted toward the next badge. */
  done: number;
  /** Approved claims between the current badge and the next one. */
  total: number;
  /** Share of the arc to fill, 0 to 1. */
  fraction: number;
  /** Text in the gap at the top of the arc: "3/7", or "Max" at the top level. */
  label: string;
  top: boolean;
}

function threshold(levels: TrustLevel[], tier: TrustTier): number {
  return Math.max(0, levels.find(l => l.tier === tier)?.min_paid_claims ?? 0);
}

function count(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * Progress from the current badge's claim threshold to the next one's.
 * Silver to Gold needs 10 - 3 = 7 claims; with 4 still to go the arc reads 3/7.
 */
export function badgeProgress(info: TrustInfo): BadgeProgress {
  const levels = resolveLevels(info);
  if (isTopTier(info) || !info.next_tier) {
    return { done: 0, total: 0, fraction: 1, label: "Max", top: true };
  }
  const gap = threshold(levels, info.next_tier) - threshold(levels, info.trust_tier);
  const left = count(info.claims_to_next_tier);
  const total = gap > 0 ? gap : Math.max(1, left);
  const done = total - Math.min(left, total);
  return { done, total, fraction: done / total, label: `${done}/${total}`, top: false };
}

function claimsText(n: number): string {
  return n === 1 ? "1 more approved claim" : `${n} more approved claims`;
}

function nextBadgeText(info: TrustInfo): string | null {
  if (!info.next_tier) return null;
  const level = resolveLevels(info).find(l => l.tier === info.next_tier)!;
  return `${badgeName(info.next_tier)} (${formatLimit(info.currency || "MYR", level.auto_limit)})`;
}

/**
 * The line under the badge. A held-back employee sees the backend's reason instead,
 * e.g. "Instant payouts are limited after a recent correction. They return to normal on 27 Jan 2027."
 */
export function badgeStatusLine(info: TrustInfo): string {
  const reason = trustReasonLine(info);
  if (reason) return reason;
  const next = nextBadgeText(info);
  if (isTopTier(info) || !next) return "Highest level";
  const { done, total } = badgeProgress(info);
  const left = total - done;
  return left > 0
    ? `${claimsText(left)} to unlock ${next}`
    : `You have the approved claims for ${next}.`;
}

/** Accessible name for the arc: "3 of 7 approved claims toward Gold". */
export function badgeArcLabel(info: TrustInfo): string {
  const p = badgeProgress(info);
  if (p.top || !info.next_tier) return `${badgeName(info.trust_tier)} badge, the highest level`;
  return `${p.done} of ${p.total} approved claims toward ${badgeName(info.next_tier)}`;
}

export interface BadgeLevel {
  tier: TrustTier;
  name: BadgeName;
  autoLimit: number;
  /** "Instant payouts up to MYR 100" */
  limit: string;
  /** "After 3 approved claims." */
  howTo: string;
  current: boolean;
}

/** Every badge with its limit and how to earn it, lowest first. */
export function badgeLevels(info: TrustInfo): BadgeLevel[] {
  const currency = info.currency || "MYR";
  return resolveLevels(info).map(level => {
    let howTo = "Everyone starts here.";
    if (level.min_paid_claims > 0) {
      const claims = level.min_paid_claims === 1 ? "1 approved claim" : `${level.min_paid_claims} approved claims`;
      howTo = level.tier === "TRUSTED" && info.trusted_clean_days
        ? `After ${claims}, with no correction in the last ${info.trusted_clean_days} days.`
        : `After ${claims}.`;
    }
    return {
      tier: level.tier,
      name: badgeName(level.tier),
      autoLimit: level.auto_limit,
      limit: `Instant payouts up to ${formatLimit(currency, level.auto_limit)}`,
      howTo,
      current: level.tier === info.trust_tier,
    };
  });
}
