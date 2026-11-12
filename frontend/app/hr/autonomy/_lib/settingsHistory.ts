// Settings change history (D3): turns agent log entries about settings into lines HR can read.
// Who changed what, from what to what, and why. The log entries themselves are hash-chained on
// the server; this only formats them.

import type { AgentAction, AutonomyConfig } from "@/lib/api/reclaim-pay-types";
import { actorLabel } from "@/components/hr-grid/agentLog";
import { FIELD_META, clockTime, formatField } from "./autonomy";

export const AUTONOMY_HISTORY_TYPES = ["CONFIG_CHANGED", "KILL_SWITCH", "BREAKER_TRIPPED"] as const;
export const POLICY_HISTORY_TYPES = [
  "POLICY_UPLOADED",
  "POLICY_DEPRECATED",
  "POLICY_DELETED",
  "POLICY_BUDGETS_CHANGED",
] as const;
/** Everything the Autonomy page's history lists: limits, the kill switch, the breaker and policies. */
export const SETTINGS_HISTORY_TYPES = [...AUTONOMY_HISTORY_TYPES, ...POLICY_HISTORY_TYPES] as const;

export interface FieldChange {
  label: string;
  before: string;
  after: string;
}

export interface HistoryEntry {
  id: number;
  who: string;
  at: string;
  title: string;
  changes: FieldChange[];
  reason: string | null;
}

const text = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

function humanizeKey(key: string): string {
  const words = key.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Retired policy “Travel Policy”", or "Retired a policy" when the log has no name. */
function policyTitle(verb: string, p: Record<string, unknown>, suffix = ""): string {
  const alias = text(p.alias);
  return alias ? `${verb} policy “${alias}”${suffix}` : `${verb} a policy${suffix}`;
}

function budgetText(value: unknown, currency: string): string {
  if (value === null) return "No limit";
  const n = typeof value === "number" ? value : Number(value);
  if (Number.isNaN(n)) return String(value);
  return `${currency} ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function configChanges(p: Record<string, unknown>, currency: string): FieldChange[] {
  const changed = Array.isArray(p.changed) ? p.changed.filter((k): k is string => typeof k === "string") : [];
  const oldValues = (p.old ?? {}) as Record<string, unknown>;
  const newValues = (p.new ?? {}) as Record<string, unknown>;
  return changed.map((key) => {
    const meta = FIELD_META[key as keyof AutonomyConfig];
    const fmt = (v: unknown) => (meta ? formatField(key as keyof AutonomyConfig, v, currency) : String(v ?? "—"));
    return { label: meta?.label ?? humanizeKey(key), before: fmt(oldValues[key]), after: fmt(newValues[key]) };
  });
}

/** Budgets are keyed by category. A category on only one side was added (no "before") or removed (no "after"). */
function budgetChanges(p: Record<string, unknown>, currency: string): FieldChange[] {
  const oldValues = (p.old ?? {}) as Record<string, unknown>;
  const newValues = (p.new ?? {}) as Record<string, unknown>;
  const categories = [...new Set([...Object.keys(oldValues), ...Object.keys(newValues)])].sort();
  return categories.map((category) => ({
    label: category,
    before: category in oldValues ? budgetText(oldValues[category], currency) : "Not listed",
    after: category in newValues ? budgetText(newValues[category], currency) : "Removed",
  }));
}

/** One history line. `timeZone` is for tests; the page uses the viewer's own. */
export function describeChange(action: AgentAction, currency: string, timeZone?: string): HistoryEntry {
  const p = action.payload ?? {};
  const base = {
    id: action.action_id,
    who: actorLabel(action.actor, action.actor_name ? { [action.actor]: action.actor_name } : {}),
    at: action.created_at,
    reason: text(p.reason),
    changes: [] as FieldChange[],
  };

  switch (action.action_type) {
    case "CONFIG_CHANGED": {
      const changes = configChanges(p, currency);
      const title =
        changes.length === 1
          ? `Changed ${changes[0].label.charAt(0).toLowerCase()}${changes[0].label.slice(1)}`
          : changes.length > 1
            ? `Changed ${changes.length} auto-pay limits`
            : "Saved auto-pay limits";
      return { ...base, title, changes };
    }
    case "KILL_SWITCH":
      return { ...base, title: p.enabled ? "Turned auto-pay back on" : "Paused auto-pay" };
    case "BREAKER_TRIPPED": {
      const until = text(p.until);
      return {
        ...base,
        title: until ? `Circuit breaker paused auto-pay until ${clockTime(until, timeZone)}` : "Circuit breaker paused auto-pay",
      };
    }
    case "POLICY_UPLOADED":
      return { ...base, title: policyTitle("Uploaded", p) };
    case "POLICY_DEPRECATED":
      return { ...base, title: policyTitle("Retired", p) };
    case "POLICY_DELETED":
      return { ...base, title: policyTitle("Deleted", p) };
    case "POLICY_BUDGETS_CHANGED":
      return { ...base, title: text(p.alias) ? `Changed auto-approval budgets on “${text(p.alias)}”` : "Changed auto-approval budgets on a policy", changes: budgetChanges(p, currency) };
    default:
      return { ...base, title: "Settings changed" };
  }
}

/** "12 Nov 2026, 14:20" in the viewer's time zone. */
export function historyTime(iso: string, timeZone?: string): string {
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    timeZone,
  });
}
