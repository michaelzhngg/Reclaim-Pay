// Turns agent log entries into sentences an HR person can read.

import type { AgentAction, AutonomyTier, PayoutStatus, RecoveryStatus, SignalCode } from "@/lib/api/reclaim-pay-types";
import { STATUS_META } from "./ledger";
import { RECOVERY_STATUS_META } from "./recoveries";
import { SIGNAL_LABEL, TIER_LABEL } from "./rows";

const ACTION_LABEL: Record<string, string> = {
  DECISION: "Claim decided",
  PAYOUT_CREATED: "Payout sent",
  PAYOUT_STATUS: "Payout status changed",
  CONFIG_CHANGED: "Limits changed",
  BREAKER_TRIPPED: "Circuit breaker tripped",
  RECOVERY_CREATED: "Overpayment notice sent",
  RECOVERY_PREVIEWED: "Invoice previewed",
  RECOVERY_INVOICED: "Invoice sent",
  RECOVERY_STATUS: "Recovery status changed",
  HR_APPROVAL: "HR approved",
  PAYEE_LINKED: "PayPal account linked",
  EMPLOYEE_CREATED: "Account created",
  INVITE_RESENT: "Invitation re-sent",
  EMPLOYEE_UPDATED: "Account updated",
  SIGNAL_REVIEWED: "Check rated",
  WEBHOOK_DEAD_LETTER: "PayPal event dead-lettered",
  WEBHOOK_RETRY: "PayPal event retried",
};

const VERDICT_LABEL: Record<string, string> = { CONFIRMED: "Real problem", FALSE_ALARM: "False alarm" };

export function actionLabel(action: Pick<AgentAction, "action_type" | "payload">): string {
  if (action.action_type === "KILL_SWITCH") return action.payload.enabled ? "Auto-pay resumed" : "Auto-pay paused";
  return ACTION_LABEL[action.action_type] ?? humanize(action.action_type);
}

function humanize(code: string): string {
  const words = code.replace(/_/g, " ").toLowerCase();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The backend logs people by user ID. `names` resolves them; without a match the ID prefix still tells two people apart. */
export function actorLabel(actor: string, names: Record<string, string> = {}): string {
  if (actor === "agent") return "Reclaim agent";
  if (names[actor]) return names[actor];
  return UUID_RE.test(actor) ? `User ${actor.slice(0, 8)}` : actor;
}

const FIELD_CHANGED: Record<string, string> = {
  name: "name changed",
  user_code: "company ID changed",
  department_id: "department changed",
};

function employeeChanges(p: Record<string, unknown>): string | null {
  const changes = p.changes;
  if (!changes || typeof changes !== "object") return null;
  const c = changes as Record<string, { from?: unknown; to?: unknown } | undefined>;
  const parts: string[] = [];
  if (c.is_active && typeof c.is_active.to === "boolean") parts.push(c.is_active.to ? "reactivated" : "deactivated");
  if (c.role && str(c.role.from) && str(c.role.to)) parts.push(`role ${c.role.from} to ${c.role.to}`);
  for (const field of Object.keys(FIELD_CHANGED)) if (c[field]) parts.push(FIELD_CHANGED[field]);
  if (parts.length === 0) return null;
  const line = parts.join(", ");
  return line.charAt(0).toUpperCase() + line.slice(1);
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function statusChange(p: Record<string, unknown>, labelOf: (code: string) => string | undefined): string | null {
  const from = str(p.from);
  const to = str(p.to);
  if (!from || !to) return null;
  return `${labelOf(from) ?? humanize(from)} to ${labelOf(to) ?? humanize(to)}`;
}

/** One line of what happened, or null when the payload has nothing readable. The full payload stays one click away. */
export function actionSummary(action: Pick<AgentAction, "action_type" | "payload">): string | null {
  const p = action.payload;
  switch (action.action_type) {
    case "DECISION": {
      const tier = TIER_LABEL[p.tier as AutonomyTier];
      if (!tier) return null;
      return typeof p.risk_score === "number" ? `${tier}, risk score ${p.risk_score}` : tier;
    }
    case "PAYOUT_CREATED":
      return str(p.amount) && str(p.currency) ? `${p.currency} ${p.amount}` : null;
    case "PAYOUT_STATUS":
      return statusChange(p, (c) => STATUS_META[c as PayoutStatus]?.label);
    case "RECOVERY_STATUS":
      return statusChange(p, (c) => RECOVERY_STATUS_META[c as RecoveryStatus]?.label);
    case "CONFIG_CHANGED": {
      const reason = str(p.reason);
      if (reason) return reason;
      return typeof p.version === "number" ? `Saved version ${p.version}` : null;
    }
    case "KILL_SWITCH":
    case "BREAKER_TRIPPED":
      return str(p.reason);
    case "RECOVERY_CREATED":
      return str(p.amount) ? `Amount ${p.amount}` : null;
    case "RECOVERY_PREVIEWED":
      return str(p.recipient_email_masked) ? `For ${p.recipient_email_masked}` : null;
    case "RECOVERY_INVOICED":
      return str(p.invoice_id) ? `PayPal invoice ${p.invoice_id}` : null;
    case "HR_APPROVAL":
      return typeof p.approvals === "number" && typeof p.required === "number"
        ? `${p.approvals} of ${p.required} ${p.required === 1 ? "approval" : "approvals"}`
        : null;
    case "PAYEE_LINKED":
      return str(p.email);
    case "EMPLOYEE_CREATED":
      return p.role === "HR" ? "HR account" : p.role === "Employee" ? "Employee account" : null;
    case "EMPLOYEE_UPDATED":
      return employeeChanges(p);
    case "SIGNAL_REVIEWED": {
      const code = str(p.code);
      const verdict = VERDICT_LABEL[str(p.verdict) ?? ""];
      if (!code || !verdict) return null;
      const check = SIGNAL_LABEL[code as SignalCode] ?? humanize(code);
      return `${check}: ${verdict}${p.previous ? " (changed)" : ""}`;
    }
    default:
      return null;
  }
}

export function hashPrefix(hash: string): string {
  return hash.slice(0, 8);
}

/** The API caps the page, so a full page means there may be older entries than the ones counted. */
export function chainBadgeLabel(chainValid: boolean, shown: number, limit: number): string {
  if (!chainValid) return "Chain broken";
  const n = shown.toLocaleString("en-US");
  const count = shown >= limit ? `${n}+` : n;
  return `Chain intact · ${count} ${shown === 1 ? "entry" : "entries"}`;
}
