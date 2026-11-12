// Pure helpers for the Autonomy page: validation, the before/after diff, the
// back-test chart mapping and the pause/breaker wording. No React, so vitest covers it.

import { z } from "zod";
import type {
  AgentAction,
  AutonomyConfig,
  BacktestPoint,
  BacktestResult,
} from "@/lib/api/reclaim-pay-types";

// ─── Validation ──────────────────────────────────────────────────────────────

const money = z.number({ error: "Enter an amount" }).min(0, "Can't be negative");
const score = z.number({ error: "Enter a score" }).int("Use a whole number").min(0, "Use 0 to 100").max(100, "Use 0 to 100");
const rate = z.number({ error: "Enter a number" }).min(0, "Use a value from 0 to 1").max(1, "Use a value from 0 to 1");
const count = z.number({ error: "Enter a number" }).int("Use a whole number").min(0, "Can't be negative");

type Pair = [keyof AutonomyConfig, keyof AutonomyConfig, string, string, boolean];

/** Fields that must rise in order: [lower, upper, message on lower, message on upper, strictly above]. */
const ORDERED_PAIRS: Pair[] = [
  ["auto_limit_new", "auto_limit_standard", "Can't be above the Standard limit", "Can't be below the New limit", false],
  ["auto_limit_standard", "auto_limit_trusted", "Can't be above the Trusted limit", "Can't be below the Standard limit", false],
  ["auto_limit_trusted", "dual_approval_above", "Can't be above the two-person amount", "Can't be below the Trusted limit", false],
  ["employee_daily_cap", "employee_monthly_cap", "Can't be above the monthly cap", "Can't be below the daily cap", false],
  ["quick_min_score", "review_min_score", "Must be below the HR review score", "Must be above the quick approval score", true],
  ["review_min_score", "dual_min_score", "Must be below the two-person score", "Must be above the HR review score", true],
];

/** For each field, the fields it is compared with, so editing one re-checks the others. */
export const RELATED_FIELDS: Partial<Record<keyof AutonomyConfig, (keyof AutonomyConfig)[]>> = ORDERED_PAIRS.reduce(
  (acc, [lower, upper]) => {
    (acc[lower] ??= []).push(upper);
    (acc[upper] ??= []).push(lower);
    return acc;
  },
  {} as Partial<Record<keyof AutonomyConfig, (keyof AutonomyConfig)[]>>,
);

/** Mirrors `AutonomyConfig`. Limits rise with trust; score bands rise with risk. */
export const autonomySchema = z
  .object({
    enabled: z.boolean(),
    currency: z.string().min(1),
    auto_limit_new: money,
    auto_limit_standard: money,
    auto_limit_trusted: money,
    dual_approval_above: money,
    employee_daily_cap: money,
    employee_monthly_cap: money,
    agent_daily_budget: money,
    quick_min_score: score,
    review_min_score: score,
    dual_min_score: score,
    review_cost: money,
    review_minutes: count,
    recovery_rate: rate,
    audit_sample_rate: rate,
    payee_cooldown_hours: count,
    breaker_window: count.min(1, "At least 1"),
    breaker_high_ratio: rate,
    breaker_pause_minutes: count,
    dispute_window_hours: count,
    version: z.number().int(),
  })
  .superRefine((c, ctx) => {
    // Each broken pair is reported on both fields, so the message shows on whichever one HR is editing.
    for (const [lower, upper, lowerMsg, upperMsg, strict] of ORDERED_PAIRS) {
      const a = c[lower] as number;
      const b = c[upper] as number;
      if (Number.isNaN(a) || Number.isNaN(b)) continue;
      if (strict ? a >= b : a > b) {
        ctx.addIssue({ code: "custom", path: [lower], message: lowerMsg });
        ctx.addIssue({ code: "custom", path: [upper], message: upperMsg });
      }
    }
  });

export type AutonomyFormValues = z.infer<typeof autonomySchema>;

// ─── Field labels and the before/after diff ──────────────────────────────────

type Kind = "money" | "score" | "rate" | "minutes" | "hours" | "count";

/** Every field HR can change, in the order the save dialog lists them. */
export const FIELD_META: Partial<Record<keyof AutonomyConfig, { label: string; kind: Kind }>> = {
  auto_limit_new: { label: "New employee limit", kind: "money" },
  auto_limit_standard: { label: "Standard employee limit", kind: "money" },
  auto_limit_trusted: { label: "Trusted employee limit", kind: "money" },
  dual_approval_above: { label: "Two-person review above", kind: "money" },
  employee_daily_cap: { label: "Per employee per day", kind: "money" },
  employee_monthly_cap: { label: "Per employee per month", kind: "money" },
  agent_daily_budget: { label: "Company auto-pay per day", kind: "money" },
  quick_min_score: { label: "Quick approval from score", kind: "score" },
  review_min_score: { label: "HR review from score", kind: "score" },
  dual_min_score: { label: "Two-person review from score", kind: "score" },
  review_cost: { label: "Cost of one HR review", kind: "money" },
  review_minutes: { label: "Minutes per HR review", kind: "minutes" },
  recovery_rate: { label: "Share of overpayments recovered", kind: "rate" },
  audit_sample_rate: { label: "Audit sample rate", kind: "rate" },
  payee_cooldown_hours: { label: "Payee change cooldown", kind: "hours" },
  breaker_window: { label: "Breaker looks at last", kind: "count" },
  breaker_high_ratio: { label: "Breaker trips at high-risk share", kind: "rate" },
  breaker_pause_minutes: { label: "Breaker pause", kind: "minutes" },
  dispute_window_hours: { label: "Dispute window", kind: "hours" },
};

export function formatField(key: keyof AutonomyConfig, value: unknown, currency: string): string {
  const kind = FIELD_META[key]?.kind;
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  switch (kind) {
    case "money":
      return `${currency} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
    case "rate":
      return `${round(n * 100, 1)}%`;
    case "minutes":
      return `${n} min`;
    case "hours":
      return `${n} h`;
    case "count":
      return `${n} claims`;
    default:
      return String(n);
  }
}

export interface ConfigChange {
  key: keyof AutonomyConfig;
  label: string;
  before: string;
  after: string;
}

/** Fields that differ between the saved config and the form, formatted for the save dialog. */
export function diffConfig(before: AutonomyConfig, after: AutonomyConfig): ConfigChange[] {
  const currency = after.currency || before.currency;
  return (Object.keys(FIELD_META) as (keyof AutonomyConfig)[])
    .filter((key) => before[key] !== after[key])
    .map((key) => ({
      key,
      label: FIELD_META[key]!.label,
      before: formatField(key, before[key], currency),
      after: formatField(key, after[key], currency),
    }));
}

// ─── Back-test chart mapping ─────────────────────────────────────────────────

export interface CurveDatum {
  limit: number;
  /** 0 to 100. */
  automationPct: number;
  leakage: number;
}

export interface ChartData {
  points: CurveDatum[];
  /** Where the form's current standard limit sits, taken from the headline result. */
  current: CurveDatum;
}

/**
 * Sorts the sweep by limit and converts rates to percent. The current point comes from the
 * headline figures, not the curve, because the form's limit is often between two sweep points.
 */
export function toChartData(result: Pick<BacktestResult, "curve" | "automation_rate" | "projected_leakage">, currentLimit: number): ChartData {
  const points = [...result.curve]
    .filter((p: BacktestPoint) => Number.isFinite(p.auto_limit_standard))
    .sort((a, b) => a.auto_limit_standard - b.auto_limit_standard)
    .map((p) => ({
      limit: p.auto_limit_standard,
      automationPct: round(p.automation_rate * 100, 1),
      leakage: round(p.projected_leakage, 2),
    }));
  return {
    points,
    current: {
      limit: currentLimit,
      automationPct: round(result.automation_rate * 100, 1),
      leakage: round(result.projected_leakage, 2),
    },
  };
}

// ─── Status wording ──────────────────────────────────────────────────────────

/** Today's auto-paid amount as a share of the company budget, clamped to 0..100. */
export function budgetPercent(paid: number, budget: number): number {
  if (!(budget > 0)) return 0;
  return Math.max(0, Math.min(100, (paid / budget) * 100));
}

/** The reason on the newest log entry of one type, e.g. why the kill switch was last flipped. */
export function latestReason(actions: AgentAction[], type: AgentAction["action_type"]): string | null {
  const hit = [...actions]
    .filter((a) => a.action_type === type)
    .sort((a, b) => b.action_id - a.action_id)[0];
  const reason = hit?.payload?.reason;
  return typeof reason === "string" && reason.trim() ? reason.trim() : null;
}

/** "14:20" in the viewer's time zone. */
export function clockTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", timeZone });
}

/** True while `breaker_until` is in the future. */
export function breakerActive(until: string | null | undefined, now: number = Date.now()): until is string {
  return !!until && new Date(until).getTime() > now;
}

/** One line for the banner: "Paused until 14:20: 6 of the last 20 decisions had a HIGH signal." */
export function breakerLine(until: string, reason: string | null, timeZone?: string): string {
  const why = reason ?? "too many recent claims looked risky.";
  return `Auto-pay paused until ${clockTime(until, timeZone)}: ${why}`;
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/** Shown above the replay figures when they come from seeded claims, which decide() produced with the defaults. */
export function demoNotice(result: Pick<BacktestResult, "demo_claims"> | null): string | null {
  return result?.demo_claims ? "These numbers come from demo claims. Don't change limits based on them." : null;
}
