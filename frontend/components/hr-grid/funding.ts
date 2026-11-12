// Copy and formatting for the funding card on the HR Payouts page. Pure, so it is tested without React.
import { formatMoney } from "@/lib/format";

export type FundingStatus = "ok" | "low" | "short" | "no_history" | "unavailable";

/** GET /payouts/funding. Money arrives as decimal strings, such as "1240.00". */
export interface FundingSummary {
  status: FundingStatus;
  currency: string;
  available: string | null;
  expected_daily: string;
  committed: string;
  days_of_cover: string | null;
  threshold_days: number;
  history_days: number;
  as_of: string | null;
  checked_at: string;
  mock: boolean;
  message: string;
}

export type FundingTone = "success" | "warning" | "danger" | "neutral";

export interface FundingView {
  tone: FundingTone;
  /** Status pill. Null when the balance wasn't checked: the card already says so. */
  label: string | null;
  /** The balance, or null when PayPal didn't return one. */
  figure: string | null;
  alert: string;
  stats: { label: string; value: string }[];
}

export const FUNDING_TONE_CLASSES: Record<FundingTone, { pill: string; alert: string }> = {
  success: { pill: "bg-success-soft text-success", alert: "text-ink-muted" },
  warning: { pill: "bg-warning-soft text-warning", alert: "rounded-control border border-warning/30 bg-warning-soft px-3 py-2 text-warning" },
  danger: { pill: "bg-danger-soft text-danger", alert: "rounded-control border border-danger/30 bg-danger-soft px-3 py-2 text-danger" },
  neutral: { pill: "bg-surface-muted text-ink-muted", alert: "text-ink-muted" },
};

export const FUNDING_REQUEST_FAILED = "Couldn't load the balance check.";

const LABEL: Record<FundingStatus, string | null> = {
  ok: "Funded",
  low: "Low balance",
  short: "Short of approved claims",
  no_history: "No recent payouts",
  unavailable: null,
};

/** Short with nothing owed means the balance itself is below zero. */
function overdrawn(s: FundingSummary): boolean {
  return s.status === "short" && !(Number(s.committed) > 0);
}

const TONE: Record<FundingStatus, FundingTone> = {
  ok: "success",
  low: "warning",
  short: "danger",
  no_history: "neutral",
  unavailable: "neutral",
};

function money(currency: string, value: string | null): string {
  const n = Number(value);
  return formatMoney(currency, Number.isFinite(n) ? n : 0);
}

/** Days are rounded down by the backend; "about" keeps the copy honest about an average. */
export function coverPhrase(days: string | number | null): string {
  const n = Number(days);
  if (days === null || !Number.isFinite(n) || n < 1) return "less than a day";
  const whole = Math.floor(n);
  return whole === 1 ? "about 1 day" : `about ${whole.toLocaleString("en-US")} days`;
}

function alertFor(s: FundingSummary): string {
  switch (s.status) {
    case "ok":
      return `Covers ${coverPhrase(s.days_of_cover)} of payouts at the recent rate.`;
    case "low":
      return `Covers ${coverPhrase(s.days_of_cover)} of payouts, under the ${s.threshold_days}-day minimum. Top up the PayPal business account before payouts start failing.`;
    case "short":
      if (overdrawn(s)) return "The PayPal account is overdrawn. Top up the PayPal business account before any payout is sent.";
      return `Not enough for the ${money(s.currency, s.committed)} of approved claims waiting to be paid. Top up the PayPal business account before they are sent.`;
    case "no_history":
      return `No payouts in the last ${s.history_days} days, so there is no daily rate to measure against.`;
    case "unavailable":
      return s.message || FUNDING_REQUEST_FAILED;
  }
}

export function fundingView(s: FundingSummary): FundingView {
  return {
    tone: TONE[s.status],
    label: overdrawn(s) ? "Overdrawn" : LABEL[s.status],
    figure: s.available === null ? null : money(s.currency, s.available),
    alert: alertFor(s),
    stats: [
      { label: `Paid per day, last ${s.history_days} days`, value: money(s.currency, s.expected_daily) },
      { label: "Approved, not yet paid", value: money(s.currency, s.committed) },
      { label: "Alert below", value: s.threshold_days === 1 ? "1 day of payouts" : `${s.threshold_days} days of payouts` },
    ],
  };
}
