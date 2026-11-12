"use client";

import { useCallback, useEffect, useId, useState } from "react";
import { Trash2 } from "lucide-react";
import {
  formatMoney,
  type LimitKind,
  type LimitRule,
  type LimitUnit,
  type PolicyLimits,
  type TravelScope,
} from "@/lib/api/reclaim-pay-types";
import { confirmPolicyLimits, getPolicyLimits, suggestPolicyLimits } from "@/lib/actions/policyLimits";
import {
  confirmedMessage,
  gradeLabel,
  limitProblem,
  limitsErrorMessage,
  parseAmount,
  parseGrade,
  rowName,
  unitLabel,
  visibilityNote,
  whereLabel,
  zoneSummary,
} from "@/lib/policy/limits";

type Row = LimitRule & { key: string; suggested: boolean; amountText: string };

type Draft = {
  category: string;
  kind: LimitKind;
  unit: LimitUnit;
  amount: string;
  gradeMin: string;
  gradeMax: string;
  scope: TravelScope;
  zone: string;
};

const EMPTY_DRAFT: Draft = {
  category: "",
  kind: "CAP",
  unit: "PER_NIGHT",
  amount: "",
  gradeMin: "",
  gradeMax: "",
  scope: "ANY",
  zone: "",
};

// Inputs get the app's focus ring explicitly: the global :focus-visible rule only covers buttons and links.
const FIELD =
  "h-11 px-3 rounded-control bg-surface border border-outline text-sm text-ink " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-secondary disabled:bg-surface-muted";
const LABEL = "flex flex-col gap-1 text-xs font-medium text-ink-muted";
const BUTTON_SECONDARY =
  "inline-flex items-center justify-center min-h-11 px-4 rounded-control border border-outline bg-surface " +
  "text-sm font-medium text-ink hover:bg-surface-muted transition-colors disabled:opacity-50";

function toRows(data: PolicyLimits | null): Row[] {
  return (data?.limits ?? []).map(({ limit_id, status, ...rule }) => ({
    ...rule,
    key: limit_id,
    suggested: status === "PROPOSED",
    amountText: rule.amount === null ? "" : rule.amount.toFixed(2),
  }));
}

function toRule(row: Row): LimitRule {
  const { category, kind, unit, amount, currency, grade_min, grade_max, scope, zone, source_section, source_quote } =
    row;
  return { category, kind, unit, amount, currency, grade_min, grade_max, scope, zone, source_section, source_quote };
}

function LimitAmount({ rule }: { rule: LimitRule }) {
  if (rule.unit === "ACTUAL") return <>Actual cost</>;
  if (rule.amount === null) return <>Amount not set</>;
  if (Number.isNaN(rule.amount)) return <>Amount not valid</>;
  const money = <span className="tabular-nums font-medium text-ink">{formatMoney(rule.currency, rule.amount)}</span>;
  return rule.kind === "PRE_APPROVAL" ? (
    <>
      Approval needed above {money} {unitLabel(rule.unit)}
    </>
  ) : (
    <>
      Up to {money} {unitLabel(rule.unit)}
    </>
  );
}

const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** HR checks the limits Reclaim suggested from the policy text, then confirms them. Employees only ever see confirmed limits. */
export default function PolicyLimitsPanel({
  policyId,
  onDirtyChange,
}: {
  policyId: string;
  /** Told whenever there are edits HR hasn't confirmed, so the page can stop them being lost. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const ids = useId();
  const [data, setData] = useState<PolicyLimits | null | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [dirty, setDirty] = useState(false);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState<"reading" | "confirming" | null>(null);
  const [message, setMessage] = useState<{ text: string; tone: "info" | "error" } | null>(null);

  const apply = useCallback((res: { limits: PolicyLimits | null; error: string | null }) => {
    setData(res.limits);
    setLoadError(res.error);
    setRows(toRows(res.limits));
    setDirty(false);
  }, []);

  const load = useCallback(async () => apply(await getPolicyLimits(policyId)), [apply, policyId]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  useEffect(() => {
    let current = true;
    void getPolicyLimits(policyId).then((res) => {
      if (current) apply(res);
    });
    return () => {
      current = false;
    };
  }, [apply, policyId]);

  const suggest = async () => {
    if (dirty) {
      setMessage({ text: "Confirm or undo your changes before reading the policy again.", tone: "error" });
      return;
    }
    setBusy("reading");
    setMessage(null);
    const res = await suggestPolicyLimits(policyId);
    if (res.error) {
      setMessage({ text: res.error, tone: "error" });
    } else {
      await load();
      setMessage({
        text: res.proposed
          ? `Found ${res.proposed} new ${res.proposed === 1 ? "limit" : "limits"}. Check each one, then confirm.`
          : "No new limits found in the policy text. Add them below.",
        tone: "info",
      });
    }
    setBusy(null);
  };

  const confirm = async () => {
    const stale = rows.find((r) => !(data?.categories ?? []).some((c) => sameName(c, r.category)));
    const problem = stale
      ? limitsErrorMessage(`UNKNOWN_CATEGORY: ${stale.category}`, 422)
      : rows.map(limitProblem).find((p) => p !== null);
    if (problem) {
      setMessage({ text: problem, tone: "error" });
      return;
    }
    setBusy("confirming");
    setMessage(null);
    const limits = rows.map(toRule);
    const zones = (data?.zones ?? []).map(({ zone, place }) => ({ zone, place }));
    const res = await confirmPolicyLimits(policyId, limits, zones);
    if (res.limits) {
      setData(res.limits);
      setRows(toRows(res.limits));
      setDirty(false);
      setMessage({ text: confirmedMessage(res.limits, res.limits.limits.length), tone: "info" });
    } else {
      setMessage({ text: res.error ?? "No response from the server. Try again.", tone: "error" });
    }
    setBusy(null);
  };

  const undo = async () => {
    setMessage(null);
    await load();
  };

  const setAmount = (key: string, text: string) => {
    setRows((current) =>
      current.map((row) => (row.key === key ? { ...row, amountText: text, amount: parseAmount(text) } : row)),
    );
    setDirty(true);
    setMessage(null);
  };

  const remove = (key: string) => {
    setRows((current) => current.filter((row) => row.key !== key));
    setDirty(true);
    setMessage(null);
  };

  const add = () => {
    const rule: LimitRule = {
      category: draft.category,
      kind: draft.kind,
      unit: draft.unit,
      amount: draft.unit === "ACTUAL" ? null : parseAmount(draft.amount),
      currency: "MYR",
      grade_min: parseGrade(draft.gradeMin),
      grade_max: parseGrade(draft.gradeMax),
      scope: draft.scope,
      zone: draft.zone || null,
      source_section: null,
      source_quote: null,
    };
    const problem = limitProblem(rule);
    if (problem) {
      setMessage({ text: problem, tone: "error" });
      return;
    }
    const amountText = rule.amount === null ? "" : rule.amount.toFixed(2);
    setRows((current) => [...current, { ...rule, key: `new-${Date.now()}`, suggested: false, amountText }]);
    setDraft({ ...EMPTY_DRAFT, category: draft.category });
    setDirty(true);
    setMessage({ text: `Added a ${rule.category} limit. Confirm to save it.`, tone: "info" });
  };

  const shell = "bg-surface rounded-card p-4 sm:p-6 shadow-ambient shrink-0";
  const heading = (
    <h3 id={`${ids}-heading`} className="font-display text-lg font-bold text-ink">
      Spending limits
    </h3>
  );

  if (data === undefined) {
    return (
      <section aria-labelledby={`${ids}-heading`} aria-busy="true" className={shell}>
        {heading}
        <p className="mt-2 text-sm text-ink-muted">Loading spending limits</p>
      </section>
    );
  }

  if (data === null) {
    return (
      <section aria-labelledby={`${ids}-heading`} className={shell}>
        {heading}
        <p role="alert" className="mt-2 text-sm text-danger">
          {loadError ?? "Couldn't load the spending limits."}
        </p>
        <button type="button" onClick={() => void load()} className={`${BUTTON_SECONDARY} mt-3`}>
          Try again
        </button>
      </section>
    );
  }

  const zones = zoneSummary(data.zones);
  const zoneIds = zones.map((z) => z.zone);
  const suggestedCount = rows.filter((r) => r.suggested).length;
  const noCategories = data.categories.length === 0;
  const fieldId = (name: string) => `${ids}-${name}`;
  const nothingToConfirm = !dirty && !data.has_suggestions;
  const status =
    suggestedCount > 0
      ? `${suggestedCount} suggested ${suggestedCount === 1 ? "limit needs" : "limits need"} checking. Employees don't see suggestions.`
      : rows.length > 0 && nothingToConfirm
        ? data.policy_active
          ? "All limits are confirmed."
          : "All limits are confirmed. Employees will see them once the policy is active."
        : null;

  return (
    <section aria-labelledby={`${ids}-heading`} tabIndex={-1} className={shell}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1 basis-60">
          {heading}
          <p className="mt-1 text-sm text-ink-muted">
            {visibilityNote(data)} Reclaim suggests limits from the policy text; employees only see them after you
            confirm. Separate from auto-approval budgets, which only decide whether a claim is paid without an HR check.
          </p>
        </div>
        {!noCategories && (
          <button type="button" onClick={() => void suggest()} disabled={busy !== null} className={BUTTON_SECONDARY}>
            {busy === "reading" ? "Reading the policy" : "Find limits in the policy"}
          </button>
        )}
      </div>

      <p
        aria-live="polite"
        className={`mt-3 text-sm min-h-5 ${message?.tone === "error" ? "text-danger" : "text-ink"}`}
      >
        {message?.text ?? status}
      </p>

      {noCategories ? (
        <p className="mt-2 text-sm text-ink-muted">
          This policy has no reimbursable categories yet, so it can&apos;t have limits. Add categories to the policy
          first.
        </p>
      ) : (
        <>
          {rows.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">No limits yet. Find them in the policy or add them below.</p>
          ) : (
            <ul className="@container mt-2 divide-y divide-line border-y border-line">
              {rows.map((row) => {
                const name = rowName(row);
                const stale = !data.categories.some((c) => sameName(c, row.category));
                const problem = stale ? "This category isn't in the policy any more. Remove it." : limitProblem(row);
                const errorId = `${ids}-${row.key}-error`;
                return (
                  <li key={row.key} className="py-3 flex flex-col gap-2 @md:flex-row @md:items-center @md:gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-ink break-words">
                        {row.category}
                        {row.suggested && (
                          <span className="mt-1 block w-fit rounded-control bg-warning-soft px-2 py-0.5 text-xs font-medium text-warning">
                            Suggested, not confirmed
                          </span>
                        )}
                      </p>
                      <p className="text-xs text-ink-muted">
                        {gradeLabel(row.grade_min, row.grade_max)}, {whereLabel(row.scope, row.zone).toLowerCase()}.{" "}
                        <LimitAmount rule={row} />
                      </p>
                      {row.source_section && (
                        <p className="mt-0.5 text-xs text-ink-muted break-words">From {row.source_section}</p>
                      )}
                      {row.source_quote && (
                        <p className="mt-0.5 text-xs text-ink-muted break-words">
                          Policy text: &ldquo;{row.source_quote}&rdquo;
                        </p>
                      )}
                      {problem && (
                        <p id={errorId} className="mt-1 text-xs font-medium text-danger">
                          {problem}
                        </p>
                      )}
                    </div>
                    <div className="flex items-end gap-2 shrink-0">
                      {row.unit !== "ACTUAL" && (
                        <label className={LABEL}>
                          Amount ({row.currency})
                          <input
                            type="text"
                            inputMode="decimal"
                            autoComplete="off"
                            value={row.amountText}
                            onChange={(e) => setAmount(row.key, e.target.value)}
                            aria-label={`${name}: Amount (${row.currency})`}
                            aria-invalid={problem !== null}
                            aria-describedby={problem ? errorId : undefined}
                            className={`${FIELD} w-32 font-mono tabular-nums`}
                          />
                        </label>
                      )}
                      <button
                        type="button"
                        aria-label={`Remove limit: ${name}`}
                        aria-describedby={stale ? errorId : undefined}
                        onClick={() => remove(row.key)}
                        className="inline-flex items-center justify-center min-h-11 min-w-11 rounded-control text-ink-muted hover:text-danger hover:bg-danger-soft transition-colors"
                      >
                        <Trash2 size={18} aria-hidden="true" />
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {zones.length > 0 && (
            <div className="mt-4">
              <h4 className="text-sm font-semibold text-ink">Zones</h4>
              <dl className="mt-1 text-xs text-ink-muted">
                {zones.map((z) => (
                  <div key={z.zone} className="flex gap-2">
                    <dt className="shrink-0 font-medium text-ink">Zone {z.zone}:</dt>
                    <dd className="min-w-0 break-words">{z.places}</dd>
                  </div>
                ))}
              </dl>
              <p className="mt-1 text-xs text-ink-muted">
                Zones come from the policy text and are confirmed together with the limits.
              </p>
            </div>
          )}

          <fieldset className="@container mt-5 min-w-0">
            <legend className="text-sm font-semibold text-ink">Add a limit</legend>
            <div className="mt-2 grid grid-cols-1 gap-3 @sm:grid-cols-2 @3xl:grid-cols-4">
              <label className={LABEL} htmlFor={fieldId("category")}>
                Category
                <select
                  id={fieldId("category")}
                  value={draft.category}
                  onChange={(e) => setDraft({ ...draft, category: e.target.value })}
                  className={`${FIELD} w-full`}
                >
                  <option value="">Choose a category</option>
                  {data.categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </label>
              <label className={LABEL} htmlFor={fieldId("kind")}>
                Type
                <select
                  id={fieldId("kind")}
                  value={draft.kind}
                  onChange={(e) => setDraft({ ...draft, kind: e.target.value as LimitKind })}
                  className={`${FIELD} w-full`}
                >
                  <option value="CAP">Reimbursed up to</option>
                  <option value="PRE_APPROVAL">Approval needed above</option>
                </select>
              </label>
              <label className={LABEL} htmlFor={fieldId("unit")}>
                Per
                <select
                  id={fieldId("unit")}
                  value={draft.unit}
                  onChange={(e) => setDraft({ ...draft, unit: e.target.value as LimitUnit })}
                  className={`${FIELD} w-full`}
                >
                  <option value="PER_NIGHT">Night</option>
                  <option value="PER_DAY">Day</option>
                  <option value="PER_MEAL">Meal</option>
                  <option value="PER_ITEM">Item</option>
                  <option value="ACTUAL">Actual cost, no amount</option>
                </select>
              </label>
              <label className={LABEL} htmlFor={fieldId("amount")}>
                Amount (MYR)
                <input
                  id={fieldId("amount")}
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  disabled={draft.unit === "ACTUAL"}
                  value={draft.unit === "ACTUAL" ? "" : draft.amount}
                  onChange={(e) => setDraft({ ...draft, amount: e.target.value })}
                  className={`${FIELD} w-full font-mono tabular-nums`}
                />
              </label>
              <label className={LABEL} htmlFor={fieldId("grade-min")}>
                From grade (optional)
                <input
                  id={fieldId("grade-min")}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={draft.gradeMin}
                  onChange={(e) => setDraft({ ...draft, gradeMin: e.target.value })}
                  className={`${FIELD} w-full tabular-nums`}
                />
              </label>
              <label className={LABEL} htmlFor={fieldId("grade-max")}>
                To grade (optional)
                <input
                  id={fieldId("grade-max")}
                  type="text"
                  inputMode="numeric"
                  autoComplete="off"
                  value={draft.gradeMax}
                  onChange={(e) => setDraft({ ...draft, gradeMax: e.target.value })}
                  className={`${FIELD} w-full tabular-nums`}
                />
              </label>
              <label className={LABEL} htmlFor={fieldId("scope")}>
                Where
                <select
                  id={fieldId("scope")}
                  value={draft.scope}
                  onChange={(e) => setDraft({ ...draft, scope: e.target.value as TravelScope })}
                  className={`${FIELD} w-full`}
                >
                  <option value="ANY">Anywhere</option>
                  <option value="DOMESTIC">Domestic</option>
                  <option value="OVERSEAS">Overseas</option>
                </select>
              </label>
              {zoneIds.length > 0 && (
                <label className={LABEL} htmlFor={fieldId("zone")}>
                  Zone
                  <select
                    id={fieldId("zone")}
                    value={draft.zone}
                    onChange={(e) => setDraft({ ...draft, zone: e.target.value })}
                    className={`${FIELD} w-full`}
                  >
                    <option value="">Every zone</option>
                    {zoneIds.map((z) => (
                      <option key={z} value={z}>
                        Zone {z}
                      </option>
                    ))}
                  </select>
                </label>
              )}
            </div>
            <button type="button" onClick={add} className={`${BUTTON_SECONDARY} mt-3`}>
              Add limit
            </button>
          </fieldset>

          <div className="mt-5 flex flex-wrap items-center justify-end gap-3">
            {dirty && (
              <>
                <span className="text-sm text-ink-muted">You have changes that aren&apos;t confirmed.</span>
                <button type="button" onClick={() => void undo()} disabled={busy !== null} className={BUTTON_SECONDARY}>
                  Undo changes
                </button>
              </>
            )}
            <button
              type="button"
              onClick={() => void confirm()}
              disabled={busy !== null || nothingToConfirm}
              className="inline-flex items-center justify-center min-h-11 px-5 rounded-full bg-accent text-on-accent text-sm font-semibold hover:bg-accent-hover transition-colors disabled:opacity-50"
            >
              {busy === "confirming" ? "Confirming" : "Confirm limits"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
