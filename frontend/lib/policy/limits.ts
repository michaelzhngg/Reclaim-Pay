import {
  formatMoney,
  type LimitRule,
  type PolicyLimits,
  type LimitUnit,
  type TravelScope,
  type ZonePlace,
} from "@/lib/api/reclaim-pay-types";

const UNIT: Record<LimitUnit, string> = {
  PER_DAY: "a day",
  PER_NIGHT: "a night",
  PER_MEAL: "a meal",
  PER_ITEM: "an item",
  ACTUAL: "at actual cost",
};

const QUANTITY: Record<LimitUnit, string | null> = {
  PER_DAY: "Days",
  PER_NIGHT: "Nights",
  PER_MEAL: "Meals",
  PER_ITEM: "Items",
  ACTUAL: null,
};

/** Same bounds as the backend: NUMERIC(12, 2) and grades 0 to 50. */
const MAX_AMOUNT = 9_999_999_999.99;
const MAX_GRADE = 50;

export const unitLabel = (unit: LimitUnit): string => UNIT[unit];
export const quantityLabel = (unit: LimitUnit): string | null => QUANTITY[unit];

export function gradeLabel(min: number | null, max: number | null): string {
  if (min === null && max === null) return "Every grade";
  if (min !== null && max !== null) return min === max ? `Grade ${min}` : `Grades ${min} to ${max}`;
  return min !== null ? `Grade ${min} and above` : `Grade ${max} and below`;
}

export function whereLabel(scope: TravelScope, zone: string | null): string {
  const place = scope === "DOMESTIC" ? "Domestic" : scope === "OVERSEAS" ? "Overseas" : "Anywhere";
  return zone ? `${place}, zone ${zone}` : place;
}

export function limitLabel(rule: LimitRule): string {
  if (rule.unit === "ACTUAL") return "Actual cost";
  if (rule.amount === null || Number.isNaN(rule.amount)) return "Amount not set";
  const money = formatMoney(rule.currency, rule.amount);
  return rule.kind === "PRE_APPROVAL"
    ? `Approval needed above ${money} ${UNIT[rule.unit]}`
    : `Up to ${money} ${UNIT[rule.unit]}`;
}

/** One line per zone, in the order the policy lists them. "*" reads as "Everywhere else". */
export function zoneSummary(zones: ZonePlace[]): { zone: string; places: string }[] {
  const byZone = new Map<string, string[]>();
  for (const z of zones) {
    const list = byZone.get(z.zone) ?? [];
    list.push(z.place === "*" ? "Everywhere else" : z.place);
    byZone.set(z.zone, list);
  }
  return [...byZone].map(([zone, places]) => ({ zone, places: places.join(", ") }));
}

/** Empty input is null; anything that isn't plain money (up to 2 decimals) is NaN. */
export function parseAmount(value: string): number | null {
  const v = value.trim();
  if (v === "") return null;
  if (!/^\d+(\.\d{1,2})?$/.test(v)) return Number.NaN;
  const n = Number(v);
  return n <= MAX_AMOUNT ? n : Number.NaN;
}

export function parseGrade(value: string): number | null {
  const v = value.trim();
  if (v === "") return null;
  if (!/^\d+$/.test(v)) return Number.NaN;
  const n = Number(v);
  return n <= MAX_GRADE ? n : Number.NaN;
}

const badGrade = (g: number | null) => g !== null && (Number.isNaN(g) || g < 0 || g > MAX_GRADE);

/** The first thing HR has to fix before this limit can be confirmed, or null when it is ready. */
export function limitProblem(rule: LimitRule): string | null {
  if (!rule.category) return "Pick a category.";
  const name = rule.category;
  if (rule.unit === "ACTUAL") {
    if (rule.kind === "PRE_APPROVAL") return `${name}: an approval threshold needs an amount, not actual cost.`;
  } else if (rule.amount === null) {
    return `Enter an amount for ${name}.`;
  } else if (Number.isNaN(rule.amount) || rule.amount < 0 || rule.amount > MAX_AMOUNT) {
    return `${name}: enter the amount as a number with up to 2 decimals.`;
  }
  if (badGrade(rule.grade_min) || badGrade(rule.grade_max)) return `${name}: grades are whole numbers from 0 to 50.`;
  if (rule.grade_min !== null && rule.grade_max !== null && rule.grade_min > rule.grade_max) {
    return `${name}: the lowest grade is above the highest grade.`;
  }
  return null;
}

/** Maps an error from the limits endpoints to a sentence HR can act on. */
export function limitsErrorMessage(error: string | null, status: number | undefined): string {
  if (error?.startsWith("UNKNOWN_CATEGORY")) {
    const name = error.slice("UNKNOWN_CATEGORY".length).replace(/^:\s*/, "") || "One category";
    return `${name} isn't a category in this policy any more. Remove that limit and confirm again.`;
  }
  if (error === "CONFLICTING_LIMITS")
    return "Two limits cover the same grades and place with different amounts. Remove one.";
  if (status === 404) return "This policy no longer exists. Go back to Policy Studio.";
  if (status === 422) return "The server rejected one of the limits. Check the amounts and grades, then confirm again.";
  if (status === 503) return "Couldn't read the policy right now. Try again later or add limits by hand.";
  if (status === 429) return "You can ask Reclaim to read the policy 3 times a minute. Wait a minute and try again.";
  if (status === 403) return "Only HR can change spending limits.";
  if (error?.startsWith("Network request failed"))
    return "Couldn't reach the server. Check your connection and try again.";
  return "No response from the server. Try again.";
}

type Visibility = Pick<PolicyLimits, "policy_active" | "categories" | "employee_visible_categories">;

const listOf = (items: string[]) =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;

/** Whether employees see this policy's confirmed limits, and which categories a newer policy takes over. */
export function visibilityNote(v: Visibility): string {
  if (!v.policy_active) return "Employees won't see these limits: the policy isn't active.";
  const hidden = v.categories.filter((c) => !v.employee_visible_categories.includes(c));
  if (hidden.length === 0) return "Employees see these limits before they spend.";
  if (v.employee_visible_categories.length === 0) {
    return `Employees won't see these limits: a newer active policy covers ${listOf(hidden)}.`;
  }
  const it = hidden.length === 1 ? "it" : "them";
  return `Employees see these limits before they spend, except for ${listOf(hidden)}: a newer active policy covers ${it}.`;
}

export function confirmedMessage(v: Visibility, count: number): string {
  if (count === 0) return "No limits confirmed. Employees see no limits for this policy.";
  if (!v.policy_active) return "Limits confirmed. Employees will see them once the policy is active.";
  return "Limits confirmed. Employees see them from now on.";
}

/** Category, grades and place, so each row's controls have a distinct accessible name. */
export function rowName(rule: LimitRule): string {
  const parts = [rule.category, gradeLabel(rule.grade_min, rule.grade_max), whereLabel(rule.scope, rule.zone)];
  if (rule.kind === "PRE_APPROVAL") parts.push("approval threshold");
  return parts.join(", ");
}
