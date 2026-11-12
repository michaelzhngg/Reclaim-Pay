import { formatMoney } from "./api/reclaim-pay-types";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "12 Nov 2026, 09:00 UTC" */
export function formatFxTimestamp(iso: string | null | undefined): string {
  if (!iso) return "Not set";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Not set";
  const day = String(d.getUTCDate()).padStart(2, "0");
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${day} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

/**
 * "USD 120.00 ≈ MYR 564.00 at 4.7000 on 12 Nov 2026, 09:00 UTC"
 *
 * Without a quote it reads "USD 120.00 (no company rate)" instead of inventing 1:1.
 * Company-currency claims show the amount and "company currency" only.
 */
export function fxQuoteText(
  currency: string,
  amount: number,
  companyCurrency: string,
  rate: number | null | undefined,
  asOf: string | null | undefined,
): string {
  const claim = formatMoney(currency || "Not set", amount);
  if (!companyCurrency) return claim;
  if (currency === companyCurrency) return `${claim} (company currency)`;
  if (!rate || rate <= 0) return `${claim} (no company rate)`;
  const converted = formatMoney(companyCurrency, amount * rate);
  return `${claim} ≈ ${converted} at ${rate.toFixed(4)} on ${formatFxTimestamp(asOf)}`;
}

/** The company-currency figure for one line, or null when no quote exists. */
export function companyLineAmount(
  companyCurrency: string | null | undefined,
  amount: number | null | undefined,
): string | null {
  if (amount === null || amount === undefined || !companyCurrency) return null;
  return formatMoney(companyCurrency, amount);
}
