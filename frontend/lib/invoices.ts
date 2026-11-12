// ─── Contractor invoice helpers ───────────────────────────────────────────────
// Pure arithmetic and copy for the contractor invoice form and the HR invoice
// card. The backend repeats every check; these keep the form honest first.
// ──────────────────────────────────────────────────────────────────────────────

import type { RateUnit } from "./contracts";

const NOT_SET = "Not set";

/** 2 decimal money, matching the backend's Numeric(12, 2). */
export function roundMoney(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Quantity times unit price, or null when either input is missing or not positive. */
export function invoiceTotal(quantity: number, unitPrice: number): number | null {
  if (!Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return null;
  if (quantity <= 0 || unitPrice <= 0) return null;
  return roundMoney(quantity * unitPrice);
}

/** True when the claimed amount equals quantity times unit price to the cent. */
export function invoiceAmountMatches(
  quantity: number,
  unitPrice: number,
  claimedAmount: number,
): boolean {
  const total = invoiceTotal(quantity, unitPrice);
  return total !== null && Math.abs(total - claimedAmount) < 0.005;
}

/** "1 Nov 2026 to 5 Nov 2026", or "Not set" when either side is missing. */
export function invoicePeriodLabel(
  start: string | null | undefined,
  end: string | null | undefined,
): string {
  if (!start || !end) return NOT_SET;
  const fmt = (iso: string) => {
    const d = new Date(`${iso}T00:00:00Z`);
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleDateString("en-MY", {
      day: "numeric", month: "short", year: "numeric", timeZone: "UTC",
    });
  };
  return `${fmt(start)} to ${fmt(end)}`;
}

export const QUANTITY_UNIT_LABEL: Record<RateUnit, string> = {
  HOUR: "hours",
  DAY: "days",
  MONTH: "months",
  PROJECT: "projects",
};

/** "2 days", for the HR invoice card. */
export function quantityLabel(quantity: number | null | undefined, unit: RateUnit): string {
  if (quantity === null || quantity === undefined) return NOT_SET;
  const label = QUANTITY_UNIT_LABEL[unit] ?? "units";
  const shown = quantity === 1 && label.endsWith("s") ? label.slice(0, -1) : label;
  return `${quantity} ${shown}`;
}

const ERROR_COPY: Record<string, string> = {
  NO_ACTIVE_CONTRACT: "Ask HR to add an active contract before you submit an invoice.",
  AMOUNT_MISMATCH: "Quantity times unit price must equal the claimed amount.",
  CURRENCY_MISMATCH: "Invoices are paid in your contract currency.",
  CATEGORY_OVERRIDE: "Invoices use the category on your contract.",
  PERIOD_REQUIRED: "Choose the start and end of the period this invoice covers.",
  PERIOD_INVALID: "The period end cannot be before its start.",
  DESCRIPTION_REQUIRED: "Describe the work this invoice covers.",
  QUANTITY_INVALID: "Quantity must be more than zero.",
  UNIT_PRICE_INVALID: "Unit price must be more than zero.",
  AMOUNT_INVALID: "Enter a valid amount.",
  NOT_A_CONTRACTOR: "Only contractors can submit invoices.",
};

/** A backend detail such as "AMOUNT_MISMATCH: ..." becomes a sentence the contractor can act on. */
export function invoiceErrorCopy(detail: string | null | undefined): string {
  const code = (detail ?? "").split(":")[0].trim();
  return ERROR_COPY[code] ?? "We could not submit this invoice. Check the details and try again.";
}
