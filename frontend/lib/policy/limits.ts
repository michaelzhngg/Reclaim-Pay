import {
  formatMoney,
  type LimitRule,
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
  if (error === "UNKNOWN_CATEGORY") return "One limit uses a category this policy doesn't have. Remove it and confirm again.";
  if (status === 404) return "This policy no longer exists. Go back to Policy Studio.";
  if (status === 422) return "The server rejected one of the limits. Check the amounts and grades, then confirm again.";
  if (status === 503) return "Couldn't read the policy right now. Try again later or add limits by hand.";
  if (status === 429) return "You can ask Reclaim to read the policy 3 times a minute. Wait a minute and try again.";
  if (status === 403) return "Only HR can change spending limits.";
  if (error?.startsWith("Network request failed")) return "Couldn't reach the server. Check your connection and try again.";
  return "No response from the server. Try again.";
}
