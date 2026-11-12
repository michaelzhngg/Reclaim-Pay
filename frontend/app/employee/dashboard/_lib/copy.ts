// Copy builders for the dashboard's fast-track card and overpayment notice.
// Strings follow DETAIL-PLAN §13.4. Kept pure so the wording is unit-tested.

import { formatClaimRef, formatMoney } from "@/lib/format";
import type { DisputeError, Recovery, TrustChange, TrustInfo, TrustTier } from "@/lib/api/reclaim-pay-types";

const TIER_LABEL: Record<TrustTier, string> = { NEW: "New", STANDARD: "Standard", TRUSTED: "Trusted" };

export function tierLabel(tier: TrustTier): string {
  return TIER_LABEL[tier];
}

/** "MYR 100" for whole limits, "MYR 87.50" otherwise. */
export function formatLimit(currency: string, amount: number): string {
  return Number.isInteger(amount) ? `${currency} ${amount}` : formatMoney(currency, amount);
}

export function isTopTier(info: TrustInfo): boolean {
  return info.next_tier === null;
}

/** "Instant payouts up to MYR 100" */
export function limitLine(info: TrustInfo): string {
  return `Instant payouts up to ${formatLimit(info.currency || "MYR", info.auto_limit)}`;
}

/** "Instant payouts up to MYR 100 · 2 more approved claims to reach MYR 200" */
export function trustLine(info: TrustInfo): string {
  const currency = info.currency || "MYR";
  const limit = limitLine(info);
  if (isTopTier(info) || !info.next_tier) return `${limit} · This is the highest level.`;

  const n = Math.max(0, info.claims_to_next_tier);
  const claims = n === 1 ? "1 more approved claim" : `${n} more approved claims`;
  const target = info.next_limit ? formatLimit(currency, info.next_limit) : tierLabel(info.next_tier);
  return `${limit} · ${claims} to reach ${target}`;
}

/**
 * The backend's own employee-facing explanation, e.g. "Instant payouts are
 * limited after a recent correction. They return to normal on 27 Jan 2027."
 * Shown instead of the progress line when present.
 */
export function trustReasonLine(info: TrustInfo): string | null {
  const text = info.reasons.map(r => r.trim()).filter(Boolean).join(" ");
  return text || null;
}

/** Share of the way to the next tier, 0 to 1. */
export function trustProgress(info: TrustInfo): number {
  if (isTopTier(info)) return 1;
  const left = Math.max(0, info.claims_to_next_tier);
  const total = info.paid_claims + left;
  return total === 0 ? 0 : Math.min(1, info.paid_claims / total);
}

// ─── Dates ───────────────────────────────────────────────────────────────────

function parts(iso: string, timeZone: string | undefined, opts: Intl.DateTimeFormatOptions) {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat("en-GB", { ...opts, timeZone }).formatToParts(new Date(iso))) {
    out[p.type] = p.value;
  }
  return out;
}

/** "8 Nov, 6:00 pm" */
export function formatDeadline(iso: string, timeZone?: string): string {
  const p = parts(iso, timeZone, { day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });
  return `${p.day} ${p.month}, ${p.hour}:${p.minute} ${(p.dayPeriod ?? "").toLowerCase()}`.trim();
}

/** "20 Oct" in the current year, "20 Oct 2025" otherwise. */
export function formatShortDate(iso: string, now: Date = new Date(), timeZone?: string): string {
  const p = parts(iso, timeZone, { day: "numeric", month: "short", year: "numeric" });
  const thisYear = parts(now.toISOString(), timeZone, { year: "numeric" }).year;
  return p.year === thisYear ? `${p.day} ${p.month}` : `${p.day} ${p.month} ${p.year}`;
}

// ─── Recent level changes ────────────────────────────────────────────────────

const RANK: Record<TrustTier, number> = { NEW: 0, STANDARD: 1, TRUSTED: 2 };

export const MAX_CHANGES = 3;

/**
 * One level change in plain words. A drop names only the claim, never the
 * check behind it: "a correction on claim X" or "a payout we had to recover".
 */
export function trustChangeLine(
  change: TrustChange,
  info: Pick<TrustInfo, "currency" | "hold_days" | "trusted_clean_days">,
  now: Date = new Date(),
  timeZone?: string,
): string {
  const date = formatShortDate(change.at, now, timeZone);
  const limit = formatLimit(info.currency || "MYR", change.to_limit);
  const claim = change.reim_id ? ` on claim ${formatClaimRef(change.reim_id)}` : "";

  if (RANK[change.to_tier] < RANK[change.from_tier]) {
    const why = change.cause === "recovery" ? `a payout we had to recover${claim}` : `a correction${claim}`;
    return `Your instant-payout limit went down to ${limit} on ${date} after ${why}.`;
  }

  const reached = `You reached ${tierLabel(change.to_tier)} on ${date}: instant payouts up to ${limit}.`;
  if (change.cause !== "time_passed") return reached;
  const days = change.to_tier === "TRUSTED" ? info.trusted_clean_days : info.hold_days;
  return days ? `${reached} It had been ${days} days since your last correction.` : reached;
}

/** The newest changes first, at most three. */
export function recentChangeLines(info: TrustInfo, now: Date = new Date(), timeZone?: string): string[] {
  return (info.changes ?? []).slice(0, MAX_CHANGES).map(c => trustChangeLine(c, info, now, timeZone));
}

// ─── How instant payouts work ────────────────────────────────────────────────

export const EXPLAINER_TITLE = "How instant payouts work";

export const EXPLAINER_INTRO =
  "Claims at or under your limit can be paid to your PayPal straight away. Larger claims wait for HR.";

export const EXPLAINER_OPEN_NOTICE_LINE =
  "A recovery notice that is still open, or that you are disputing, doesn't change your limit.";

/** "Standard: up to MYR 100, after 3 approved claims." One line per level, lowest first. */
export function levelLines(info: TrustInfo): { tier: TrustTier; text: string; current: boolean }[] {
  const currency = info.currency || "MYR";
  return (info.levels ?? []).map(level => {
    const head = `${tierLabel(level.tier)}: up to ${formatLimit(currency, level.auto_limit)}`;
    let when = "Everyone starts here.";
    if (level.min_paid_claims > 0) {
      const claims = level.min_paid_claims === 1 ? "1 approved claim" : `${level.min_paid_claims} approved claims`;
      when = level.tier === "TRUSTED" && info.trusted_clean_days
        ? `after ${claims}, with no correction in the last ${info.trusted_clean_days} days.`
        : `after ${claims}.`;
    }
    const current = level.tier === info.trust_tier;
    const text = `${level.min_paid_claims > 0 ? `${head}, ${when}` : `${head}. ${when}`}${current ? " This is your level." : ""}`;
    return { tier: level.tier, text, current };
  });
}

/** What a correction is and what it does to the limit. */
export function correctionRuleLine(info: TrustInfo): string {
  const what = "A correction means HR confirmed a problem with one of your claims, or we had to recover a payout.";
  const hold = info.hold_days
    ? `One correction moves you back to New for ${info.hold_days} days. Your approved claims still count after that.`
    : "One correction moves you back to New for a while. Your approved claims still count after that.";
  return `${what} ${hold}`;
}

// ─── Overpayment notice ──────────────────────────────────────────────────────

export function isDisputeOpen(rec: Recovery, now: Date = new Date()): boolean {
  return new Date(rec.dispute_until).getTime() > now.getTime();
}

/** "We paid MYR 30.00 more than approved on claim RC-1A2B3C4D." */
export function noticeLine(rec: Recovery): string {
  return `We paid ${formatMoney(rec.currency, rec.amount)} more than approved on claim ${formatClaimRef(rec.reim_id)}.`;
}

export function deadlineLine(rec: Recovery, now: Date = new Date(), timeZone?: string): string {
  const when = formatDeadline(rec.dispute_until, timeZone);
  return isDisputeOpen(rec, now) ? `You can dispute until ${when}.` : `The dispute window closed on ${when}.`;
}

export const AFTER_WINDOW_LINE =
  "After HR reviews it, the amount comes off your next claim. If no claim covers it, you'll get a PayPal invoice instead.";

export const DISPUTED_LINE = "Disputed · HR will review";

/**
 * Where the recovery stands, as a bold line and an optional follow-up.
 * NOTICE_SENT depends on the clock: open until `dispute_until`, then closed.
 */
export function statusLines(rec: Recovery, now: Date = new Date(), timeZone?: string): { line: string; detail: string | null } {
  switch (rec.status) {
    case "NOTICE_SENT":
      return isDisputeOpen(rec, now)
        ? { line: deadlineLine(rec, now, timeZone), detail: null }
        : { line: deadlineLine(rec, now, timeZone), detail: AFTER_WINDOW_LINE };
    case "DISPUTED":
      return { line: DISPUTED_LINE, detail: null };
    case "OFFSET":
      return {
        line: rec.offset_reim_id
          ? `Deducted from claim ${formatClaimRef(rec.offset_reim_id)}.`
          : "Deducted from a later claim.",
        detail: "Nothing more to do.",
      };
    case "INVOICED":
      return {
        line: `We sent you a PayPal invoice for ${formatMoney(rec.currency, rec.amount)}.`,
        detail: "Check your email to pay it.",
      };
    case "RECOVERED":
      return { line: "Repaid.", detail: "Nothing more to do." };
    case "WAIVED":
      return { line: "You don't owe anything.", detail: null };
  }
}

/** Calm wording for a dispute the backend refused. Never shows the raw code. */
export function disputeErrorLine(err: DisputeError): string {
  switch (err) {
    case "WINDOW_CLOSED":
      return "The dispute window closed before your note arrived, so it wasn't sent.";
    case "NOT_DISPUTABLE":
      return "This notice has already been handled. Refresh the page to see where it stands.";
    case "FAILED":
      return "We couldn't send your dispute. Please try again.";
  }
}
