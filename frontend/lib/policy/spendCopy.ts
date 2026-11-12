import {
  formatMoney,
  type LimitRule,
  type LimitUnit,
  type SpendCheckResult,
  type SpendVerdict,
  type TripEstimate,
  type TripLine,
} from "@/lib/api/reclaim-pay-types";
import { unitLabel } from "./limits";

export const GUIDANCE_NOTE = "Guidance, not an approval. The decision is made when you submit the claim.";

export type SpendTone = "ok" | "warn" | "info";

const PLACE_NOT_LISTED = "We couldn't match that place to a zone in the policy. Ask HR which rate applies.";
const NO_RESPONSE = "Couldn't reach Reclaim. Check your connection and try again.";

const COUNT: Record<LimitUnit, [string, string] | null> = {
  PER_DAY: ["day", "days"],
  PER_NIGHT: ["night", "nights"],
  PER_MEAL: ["meal", "meals"],
  PER_ITEM: ["item", "items"],
  ACTUAL: null,
};

const plural = (n: number, [one, many]: [string, string]) => `${n} ${n === 1 ? one : many}`;

function counted(unit: LimitUnit | undefined, quantity: number): string {
  const words = unit ? COUNT[unit] : null;
  return words && quantity > 1 ? ` for ${plural(quantity, words)}` : "";
}

const upTo = (rule: LimitRule) => `up to ${formatMoney(rule.currency, rule.amount ?? 0)} ${unitLabel(rule.unit)}`;

export function verdictMessage(r: SpendCheckResult): { tone: SpendTone; text: string } {
  const m = (n: number | null) => formatMoney(r.currency, n ?? 0);
  switch (r.verdict) {
    case "WITHIN":
      return { tone: "ok", text: `Within your limit. You can claim the full ${m(r.reimbursable_up_to)}.` };
    case "OVER":
      return {
        tone: "warn",
        text: `Above your limit. You can claim up to ${m(r.limit_total)}${counted(r.cap?.unit, r.quantity)}. You pay the other ${m(r.employee_pays)}.`,
      };
    case "ACTUAL_COST":
      return { tone: "ok", text: "Paid at actual cost for your grade. Keep the itemised receipt." };
    case "NEEDS_PRE_APPROVAL": {
      const above = r.pre_approval?.amount != null
        ? ` above ${formatMoney(r.pre_approval.currency, r.pre_approval.amount)} ${unitLabel(r.pre_approval.unit)}`
        : "";
      return { tone: "warn", text: `Get HR approval before you buy. The policy needs it${above}.` };
    }
    case "LIMIT_ONLY": {
      if (r.cap && r.cap.unit !== "ACTUAL") {
        const total = r.quantity > 1 && r.limit_total !== null ? ` That's ${m(r.limit_total)}${counted(r.cap.unit, r.quantity)}.` : "";
        return { tone: "info", text: `Your limit: ${upTo(r.cap)}.${total}` };
      }
      if (r.pre_approval?.amount != null) {
        const p = r.pre_approval;
        return {
          tone: "info",
          text: `HR approval is needed above ${formatMoney(p.currency, p.amount!)} ${unitLabel(p.unit)}. Enter an amount to check yours.`,
        };
      }
      return { tone: "info", text: "Enter an amount to check it against the policy." };
    }
    case "NO_LIMIT":
      return { tone: "info", text: "The policy sets no amount for this. HR checks it against the policy wording when you claim." };
    case "NEED_DESTINATION":
      return { tone: "info", text: "Add where you're going. The limit depends on the destination." };
    case "PLACE_NOT_LISTED":
      return { tone: "warn", text: PLACE_NOT_LISTED };
    case "GRADE_NOT_LISTED":
      return { tone: "warn", text: "The policy doesn't list a limit for your grade. Ask HR before you spend." };
    case "NOT_COVERED":
      return { tone: "warn", text: "This isn't in any company policy, so it may not be reimbursed. Ask HR first." };
  }
}

/** "Zone 2 rate (everywhere else)": shown with a result so an employee can spot a wrong place match. */
export function zoneText(zone: string | null, place: string | null): string | null {
  if (zone === null) return null;
  if (place === null) return `Zone ${zone} rate`;
  return `Zone ${zone} rate (${place === "*" ? "everywhere else" : place})`;
}

export function tripSummary(est: TripEstimate): string {
  if (est.lines.length === 0) return "No daily or nightly limit in the policy applies to this trip.";
  const span = est.nights > 0
    ? `${plural(est.days, ["day", "days"])} and ${plural(est.nights, ["night", "nights"])}`
    : plural(est.days, ["day", "days"]);
  const actual = est.has_actual_cost ? ", plus items paid at actual cost" : "";
  return `Up to ${formatMoney(est.currency, est.total_up_to)} for ${span}${actual}.`;
}

export function tripLineText(line: TripLine, currency: string): string {
  const words = COUNT[line.unit];
  if (line.subtotal === null || line.rate === null || !words) return "Actual cost";
  return `${plural(line.quantity, words)} at ${formatMoney(currency, line.rate)} = ${formatMoney(currency, line.subtotal)}`;
}

const MISSING_NOTE: Partial<Record<SpendVerdict, (categories: string) => string>> = {
  NEED_DESTINATION: (c) => `Add where you're going to include ${c}.`,
  PLACE_NOT_LISTED: (c) => `Not included: ${c}. ${PLACE_NOT_LISTED}`,
  GRADE_NOT_LISTED: (c) => `Not included: ${c}. The policy doesn't list a limit for your grade. Ask HR.`,
};

export function tripNotes(est: TripEstimate): string[] {
  const notes = est.other_limits
    .filter((r) => r.amount !== null)
    .map((r) => `Also: ${r.category} ${upTo(r)}.`);
  const byReason = new Map<SpendVerdict | undefined, string[]>();
  for (const c of est.missing) {
    const reason = est.missing_reasons[c];
    byReason.set(reason, [...(byReason.get(reason) ?? []), c]);
  }
  for (const [reason, categories] of byReason) {
    const note = reason ? MISSING_NOTE[reason] : undefined;
    notes.push(note ? note(categories.join(", ")) : `Not included: ${categories.join(", ")}. Ask HR.`);
  }
  return notes;
}

export function spendErrorMessage(error: string | null, status: number | undefined): string {
  if (error === "RETURN_BEFORE_DEPART") return "The return date is before the departure date.";
  if (error === "TRIP_TOO_LONG") return "Trips longer than 60 days can't be estimated. Ask HR.";
  if (status === 429) return "Too many checks in a minute. Wait a moment and try again.";
  return NO_RESPONSE;
}

export function askErrorMessage(error: string | null, status: number | undefined): string {
  if (error === "QUESTION_LENGTH") return "Write a question between 5 and 500 characters.";
  if (error === "DAILY_QUESTION_LIMIT") return "You've asked 20 questions in the last 24 hours. Ask HR, or try again tomorrow.";
  if (status === 429) return "Too many questions in a minute. Wait a moment and try again.";
  if (status === 503) return "Couldn't answer right now. Try again in a few minutes, or ask HR.";
  return NO_RESPONSE;
}
