// Readable labels and ages for the HR PayPal event-health tab.

import type { MaintenanceReport, WebhookEvent } from "@/lib/api/reclaim-pay-types";

const FAMILY_LABELS: Record<string, string> = {
  PAYMENT: "Payment",
  INVOICING: "Invoice",
};

function humanize(value: string): string {
  const words = value.replace(/[_-]+/g, " ").toLowerCase().trim();
  return words;
}

function capitalize(value: string): string {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : "Not set";
}

/** "PAYMENT.PAYOUTS-ITEM.SUCCEEDED" -> "Payment payout item succeeded". */
export function eventLabel(eventType: string): string {
  if (!eventType.trim()) return "Not set";
  const parts = eventType.split(".").filter(Boolean);
  if (parts.length === 1) return capitalize(humanize(parts[0]));
  const family = FAMILY_LABELS[parts[0]] ?? capitalize(humanize(parts[0]));
  const middle = parts.slice(1, -1)
    .map(humanize)
    .filter((part) => part && part !== family.toLowerCase())
    .join(" ");
  const outcome = humanize(parts[parts.length - 1]);
  return [family, middle, outcome].filter(Boolean).join(" ");
}

export function eventStatusLabel(status: string): string {
  if (status === "DEAD_LETTER") return "Dead letter";
  if (status === "FAILED") return "Failed";
  if (status === "RECEIVED") return "In flight";
  if (status === "PROCESSED") return "Processed";
  if (status === "IGNORED") return "Ignored";
  return capitalize(humanize(status));
}

/** Whole hours or days, never a raw float. */
export function formatAge(hours: number | null | undefined): string {
  if (hours == null || !Number.isFinite(hours) || hours < 0) return "Not set";
  if (hours < 1) return "Under 1h";
  const whole = Math.floor(hours);
  if (whole < 24) return `${whole}h`;
  const days = Math.floor(whole / 24);
  const rest = whole % 24;
  return rest ? `${days}d ${rest}h` : `${days}d`;
}

export function ageHours(iso: string, now: number = Date.now()): number {
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? Number.NaN : (now - parsed) / 3_600_000;
}

export function sortEvents(events: WebhookEvent[]): WebhookEvent[] {
  return [...events].sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at));
}

/** Why a stuck payout cannot be refreshed automatically, or null when it can. */
export function stuckReason(refreshable: boolean, batchId: string | null): string | null {
  if (refreshable) return null;
  if (!batchId) return "No PayPal batch ID, so it cannot be refreshed";
  return "Demo or mock batch, so it cannot be refreshed";
}

export function maintenanceSummary(report: MaintenanceReport): string {
  const { payouts, webhooks } = report;
  const payoutPart = `${payouts.checked} ${payouts.checked === 1 ? "payout" : "payouts"}`;
  const eventPart = `${webhooks.checked} ${webhooks.checked === 1 ? "event" : "events"}`;
  const changed = payouts.changed ? ` ${payouts.changed} changed.` : "";
  return `Checked ${payoutPart} and ${eventPart}.${changed}`.trim();
}
