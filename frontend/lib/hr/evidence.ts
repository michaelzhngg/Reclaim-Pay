// ─── Decision Evidence ───────────────────────────────────────────────────────
// Pure helpers for the evidence panel on /hr/review/[id]: hard-stop labels,
// signal evidence, the score breakdown and two-person approval progress.
// Wording follows docs/hackathon/DETAIL-PLAN.md §13.1, §13.2, §13.5 and §13.7.
// ──────────────────────────────────────────────────────────────────────────────

import {
  formatMoney,
  type Approval,
  type AutonomyDecision,
  type AutonomyTier,
  type HardStop,
  type ReimbursementAutonomyFields,
  type RiskSignal,
  type Severity,
} from "@/lib/api/reclaim-pay-types";
import { formatClaimRef } from "@/lib/format";
import { SIGNAL_LABEL, TIER_LABEL } from "@/components/hr-grid/rows";

const HARD_STOP_LABEL: Record<HardStop, string> = {
  AUTONOMY_PAUSED: "Auto-pay is paused (kill switch)",
  CIRCUIT_BREAKER: "Auto-pay paused by the circuit breaker",
  AI_NOT_APPROVED: "AI did not recommend approval",
  PAYEE_NOT_VERIFIED: "No verified PayPal account linked",
  PAYEE_COOLDOWN: "PayPal account changed in the last 72 hours",
  HR_SELF_CLAIM: "Claim submitted by an HR user",
  OVER_CATEGORY_BUDGET: "Above the category's auto-approval budget",
  OVER_AUTO_LIMIT: "Above this employee's auto-pay limit",
  EMPLOYEE_DAILY_CAP: "Employee's daily auto-pay cap reached",
  EMPLOYEE_MONTHLY_CAP: "Employee's monthly auto-pay cap reached",
  AGENT_DAILY_BUDGET: "Company's daily auto-pay budget reached",
  HIGH_RISK_SIGNAL: "High-risk signal on this claim",
  EXPECTED_LOSS: "Expected loss is higher than the cost of a review",
  FX_RATE_UNAVAILABLE: "No company-currency rate for this claim",
  CONTRACTOR_NOT_TRUSTED: "Contractor payments are reviewed until trusted",
  OVER_CONTRACT_LIMIT: "Above this contract's limit per claim",
};

/** HR wording for a hard stop. Unknown codes from a newer backend show as they are. */
export function hardStopLabel(code: HardStop): string {
  return HARD_STOP_LABEL[code] ?? code;
}

export function signalLabel(code: RiskSignal["code"]): string {
  return SIGNAL_LABEL[code] ?? code;
}

// ─── The decision as the review page needs it ────────────────────────────────

export interface ClaimAutonomy {
  tier: AutonomyTier;
  riskScore: number;
  decision: Partial<AutonomyDecision>;
  approvals: Approval[];
  currency: string;
}

/**
 * The autonomy fields on a reimbursement, or null for claims decided before the
 * engine existed. A tier on its own is enough to show the panel.
 */
export function toClaimAutonomy(r: ReimbursementAutonomyFields & { currency?: string | null }): ClaimAutonomy | null {
  const decision = r.autonomy ?? {};
  const tier = r.tier ?? decision.tier ?? null;
  if (!tier) return null;
  return {
    tier,
    riskScore: r.risk_score ?? decision.risk_score ?? 0,
    decision,
    approvals: r.approvals ?? [],
    currency: r.currency ?? "MYR",
  };
}

// ─── Summary ─────────────────────────────────────────────────────────────────

/**
 * One sentence for "Why this needs you". The backend explanation repeats the tier
 * and score (shown as the chip and the number) and lists raw stop codes (shown as
 * labelled chips), so only the reason is kept.
 */
export function summarySentence(c: ClaimAutonomy): string {
  const d = c.decision;
  let text = (d.explanation ?? "").replace(/\s*—\s*/g, ": ");
  text = text.split(/\s+(?:Stops|Signals):/)[0].trim();
  const colon = text.indexOf(": ");
  if (colon > 0 && colon < 30) text = text.slice(colon + 2);
  // The backend's own format: "risk 80/100, Standard employee limit MYR 100.00."
  if (/^risk \d+\/100/i.test(text)) text = "";
  const first = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  if (first) return first.charAt(0).toUpperCase() + first.slice(1);

  // Built from the fields instead: the strongest reason, then the employee's limit.
  const trust = d.trust_tier ? d.trust_tier.charAt(0) + d.trust_tier.slice(1).toLowerCase() : null;
  const limit = typeof d.auto_limit === "number" ? formatMoney(c.currency, d.auto_limit) : null;
  const who = trust && limit ? `${trust} employee with a ${limit} auto-pay limit` : null;
  const top = sortSignals(d.signals ?? [])[0];
  const stop = d.hard_stops?.[0];
  if (top) return who ? `Strongest signal: ${signalLabel(top.code)}, on a ${who}.` : `Strongest signal: ${signalLabel(top.code)}.`;
  if (stop) return who ? `${hardStopLabel(stop)}, on a ${who}.` : `${hardStopLabel(stop)}.`;
  if (who) return `No risk signals, on a ${who}.`;
  return `Sent to ${TIER_LABEL[c.tier]}.`;
}

/** How the risk score adds up: AI confidence first, then each signal. Zero rows are left out. */
export function scoreBreakdown(d: Partial<AutonomyDecision>): { label: string; points: number }[] {
  const rows: { label: string; points: number }[] = [];
  if (d.confidence_points) rows.push({ label: "AI confidence", points: d.confidence_points });
  for (const s of sortSignals(d.signals ?? [])) {
    if (s.points) rows.push({ label: signalLabel(s.code), points: s.points });
  }
  return rows;
}

// ─── Two-person review ───────────────────────────────────────────────────────

/** "1 of 2 approvals · waiting for a second HR member". Empty for tiers that need one person. */
export function approvalProgress(approvals: unknown[] | null | undefined, tier: AutonomyTier): string {
  if (tier !== "DUAL_REVIEW") return "";
  const n = Math.min(2, approvals?.length ?? 0);
  if (n === 0) return "0 of 2 approvals · needs two different HR members";
  if (n === 1) return "1 of 2 approvals · waiting for a second HR member";
  return "2 of 2 approvals";
}

/** Why this HR user can't approve, or null when they can. */
export function approveBlockedReason(
  c: Pick<ClaimAutonomy, "tier" | "approvals"> | null,
  hrId: string | null | undefined,
): string | null {
  if (!c || c.tier !== "DUAL_REVIEW" || !hrId) return null;
  return c.approvals.some((a) => a.hr_id === hrId) ? "You already approved" : null;
}

const APPROVAL_ERRORS: Record<string, string> = {
  ALREADY_APPROVED: "You already approved. A second HR member has to approve this claim.",
  SELF_APPROVAL: "You can't approve your own claim. Another HR member has to review it.",
  NOTHING_TO_PAY: "This claim has no approved amount to pay. Set the amounts, or reject it with a note.",
  AMOUNT_ABOVE_CLAIMED: "An approved amount is higher than what the employee claimed. Lower it and try again.",
};

/** PATCH /status answers with bare codes for approval conflicts; everything else passes through. */
export function approvalErrorMessage(error: string): string {
  return APPROVAL_ERRORS[error.trim()] ?? error;
}

// ─── Signals ─────────────────────────────────────────────────────────────────

const SEVERITY_RANK: Record<Severity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

export const SEVERITY_LABEL: Record<Severity, string> = { HIGH: "High", MEDIUM: "Medium", LOW: "Low" };

/** Most severe first, then most points. */
export function sortSignals(signals: RiskSignal[]): RiskSignal[] {
  return [...signals].sort(
    (a, b) => (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) || (b.points ?? 0) - (a.points ?? 0),
  );
}

export interface EvidenceFact {
  label: string;
  value: string;
  /** Marks the row that disagrees, such as the printed total. */
  emphasis?: boolean;
}

export interface EvidenceView {
  facts: EvidenceFact[];
  /** Earlier claims this one matches or splits from. */
  claims: { href: string; ref: string }[];
  /** Text lifted from the receipt, shown verbatim in monospace. */
  snippets: string[];
  note: string | null;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null);
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.trim() !== "") : str(v) ? [v as string] : [];

function claimLinks(ids: string[]): EvidenceView["claims"] {
  return [...new Set(ids)].map((id) => ({ href: `/hr/view/${id}`, ref: formatClaimRef(id) }));
}

/** "Lower right" from a box in fractions of the image size. */
function imageArea(r: Record<string, unknown>): string | null {
  const x = num(r.x), y = num(r.y), w = num(r.w), h = num(r.h);
  if (x === null || y === null || w === null || h === null) return null;
  const third = (v: number, names: [string, string, string]) => names[Math.min(2, Math.max(0, Math.floor(v * 3)))];
  const vertical = third(y + h / 2, ["Upper", "Middle", "Lower"]);
  const horizontal = third(x + w / 2, ["left", "centre", "right"]);
  return vertical === "Middle" && horizontal === "centre" ? "Centre" : `${vertical} ${horizontal}`;
}

/**
 * What to show under a signal's message. Evidence keys differ between the
 * backend detectors and the demo fixtures, so each shape is read defensively and
 * anything missing is simply not shown.
 */
export function signalEvidence(s: RiskSignal, currency: string): EvidenceView {
  const e = (s.evidence ?? {}) as Record<string, unknown>;
  const money = (v: unknown) => {
    const n = num(v);
    return n === null ? null : formatMoney(currency, n);
  };
  const view: EvidenceView = { facts: [], claims: [], snippets: [], note: null };
  const fact = (label: string, value: string | null, emphasis = false) => {
    if (value !== null) view.facts.push(emphasis ? { label, value, emphasis } : { label, value });
  };

  switch (s.code) {
    case "ARITHMETIC_MISMATCH": {
      const expected = num(e.expected_total) ?? num(e.items_plus_tax) ?? num(e.expected);
      const printed = num(e.total) ?? num(e.printed);
      fact("Items", money(e.items));
      fact("Tax", money(e.tax));
      fact("Service charge", money(e.service_charge));
      fact("Items + tax", money(expected));
      fact("Receipt says", money(printed), true);
      const diff = num(e.difference) ?? (expected !== null && printed !== null ? Math.abs(printed - expected) : null);
      fact("Difference", money(diff));
      break;
    }
    case "DUPLICATE_RECEIPT": {
      // Backend: matches[] sorted best first, each {reim_id, same_claim, same_user, match, distance}.
      const matches = (Array.isArray(e.matches) ? e.matches : []).filter(
        (m): m is Record<string, unknown> => typeof m === "object" && m !== null,
      );
      const ids = matches.length
        ? matches.filter((m) => !m.same_claim).flatMap((m) => strings(m.reim_id))
        : strings(e.matched_reim_id ?? e.match_reim_id ?? e.reim_id ?? e.matched_claims);
      view.claims = claimLinks(ids);
      const best = matches[0];
      const distance = num(best?.distance) ?? num(e.phash_distance) ?? num(e.distance);
      if (best?.match === "sha256") fact("Best match", "Identical file");
      else fact("Image distance", distance === null ? null : `${distance} (0 means identical)`);
      if (matches.some((m) => m.same_claim)) fact("In this claim", "Attached more than once");
      const others = matches.filter((m) => !m.same_claim);
      if (others.length) fact("Submitted by", others.every((m) => m.same_user) ? "The same employee" : "Another employee");
      break;
    }
    case "AI_PROVENANCE": {
      view.note = "C2PA content credentials say this image was AI-generated.";
      fact("Source type", str(e.c2pa) ?? str(e.digital_source_type));
      fact("Generator", str(e.generator) ?? str(e.claim_generator));
      if (e.verified === false) fact("Signature", "Not verified, read from the file");
      break;
    }
    case "PROMPT_INJECTION": {
      view.snippets = strings(e.matches ?? e.matched);
      view.note = "Text on the receipt tried to instruct the AI. It was ignored.";
      break;
    }
    case "SPLIT_CLAIM": {
      view.claims = claimLinks(strings(e.related));
      const count = num(e.related_claims);
      if (!view.claims.length && count) fact("Related claims", String(count));
      fact("Combined amount", money(e.combined), true);
      fact("Limit", money(e.limit));
      break;
    }
    case "HUMAN_EDIT_HIGH":
    case "HUMAN_EDIT_MEDIUM": {
      const changes = (e.changes ?? {}) as Record<string, { original?: unknown; edited?: unknown }>;
      for (const [field, c] of Object.entries(changes)) {
        const before = c?.original == null ? "empty" : String(c.original);
        const after = c?.edited == null ? "empty" : String(c.edited);
        fact(field.replace(/_/g, " "), `AI read ${before}, employee entered ${after}`);
      }
      break;
    }
    case "EDITING_SOFTWARE":
      fact("Saved by", str(e.software));
      break;
    case "VISUAL_ANOMALY":
      fact("What the AI saw", str(e.description));
      break;
    case "IMAGE_FORENSICS": {
      const regions = (Array.isArray(e.regions) ? e.regions : []).filter(
        (r): r is Record<string, unknown> => typeof r === "object" && r !== null,
      );
      fact("Where on the image", regions.length ? imageArea(regions[0]) : null);
      const score = num(e.score);
      fact("Check score", score === null ? null : `${score}/100`);
      view.note =
        e.scored === true
          ? "Image checks can misfire on filtered or stitched photos. Compare the area with the rest of the receipt."
          : "Not scored: shown for information only. It added no points and did not change the lane.";
      break;
    }
    case "PRICE_ABOVE_MARKET": {
      fact("Claimed", money(e.claimed), true);
      fact("Typical price", money(e.median));
      const offers = num(e.n);
      fact("Offers compared", offers === null ? null : String(offers));
      break;
    }
    case "NEAR_THRESHOLD": {
      fact("Amount", money(e.amount));
      const band = Array.isArray(e.band) ? e.band : [];
      fact("Auto-pay limit", money(band[1]));
      const others = num(e.others_in_band_30d);
      fact("Other claims this close in 30 days", others === null ? null : String(others));
      break;
    }
    default:
      break;
  }
  // Skip the note when the message already says it.
  if (view.note && (view.note === s.message || (s.code === "AI_PROVENANCE" && /c2pa/i.test(s.message)))) view.note = null;
  return view;
}
