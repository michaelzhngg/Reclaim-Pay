"use client";

import type { FieldErrors, UseFormRegister } from "react-hook-form";
import type { AutonomyConfig } from "@/lib/api/reclaim-pay-types";
import { RELATED_FIELDS, formatField, type AutonomyFormValues } from "../_lib/autonomy";

type NumberKey = {
  [K in keyof AutonomyFormValues]: AutonomyFormValues[K] extends number ? K : never;
}[keyof AutonomyFormValues];

interface FieldProps {
  name: NumberKey;
  label: string;
  hint?: string;
  prefix?: string;
  step?: number;
  register: UseFormRegister<AutonomyFormValues>;
  errors: FieldErrors<AutonomyFormValues>;
  saved: AutonomyConfig;
  dirty: boolean;
}

function NumberField({ name, label, hint, prefix, step = 1, register, errors, saved, dirty }: FieldProps) {
  const error = errors[name]?.message;
  const id = `field-${name}`;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className="text-xs text-ink-muted mt-0.5">
          {hint}
        </p>
      )}
      <div
        className={`mt-1.5 flex items-center min-h-[44px] rounded-control border bg-surface focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-accent ${
          error ? "border-danger" : dirty ? "border-ink" : "border-line-strong"
        }`}
      >
        {prefix && <span className="pl-3 text-sm text-ink-muted select-none">{prefix}</span>}
        <input
          id={id}
          type="number"
          inputMode="decimal"
          min={0}
          step={step}
          aria-invalid={!!error}
          aria-describedby={describedBy}
          className="w-full min-w-0 bg-transparent px-3 py-2 text-sm font-mono text-ink outline-none"
          {...register(name, { valueAsNumber: true, deps: RELATED_FIELDS[name] as NumberKey[] | undefined })}
        />
      </div>
      {error ? (
        <p id={`${id}-error`} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      ) : dirty ? (
        <p className="mt-1 text-xs text-ink-muted">Saved: {formatField(name, saved[name], saved.currency)}</p>
      ) : null}
    </div>
  );
}

interface LimitsFormProps {
  register: UseFormRegister<AutonomyFormValues>;
  errors: FieldErrors<AutonomyFormValues>;
  saved: AutonomyConfig;
  dirtyKeys: Set<string>;
  currency: string;
}

/** The limits HR tunes, grouped the way the decision runs: who, how much, how risky. */
export default function LimitsForm({ register, errors, saved, dirtyKeys, currency }: LimitsFormProps) {
  const common = { register, errors, saved };
  const f = (name: NumberKey) => ({ ...common, name, dirty: dirtyKeys.has(name) });

  return (
    <div className="flex flex-col gap-6">
      <fieldset>
        <legend className="font-display font-semibold text-base text-ink">Pay automatically up to</legend>
        <p className="text-sm text-ink-muted mt-1">
          Per claim, by how much history the employee has. Anything above goes to quick HR approval.
        </p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <NumberField {...f("auto_limit_new")} label="New" prefix={currency} hint="Under 3 paid claims" />
          <NumberField {...f("auto_limit_standard")} label="Standard" prefix={currency} hint="3 or more" />
          <NumberField {...f("auto_limit_trusted")} label="Trusted" prefix={currency} hint="10 or more, no issues" />
        </div>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-3">
          <NumberField
            {...f("dual_approval_above")}
            label="Two-person review above"
            prefix={currency}
            hint="Two HR members must approve"
          />
        </div>
      </fieldset>

      <fieldset>
        <legend className="font-display font-semibold text-base text-ink">Caps</legend>
        <p className="text-sm text-ink-muted mt-1">Once a cap is reached, the next claim waits for HR.</p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <NumberField {...f("employee_daily_cap")} label="Per employee, per day" prefix={currency} />
          <NumberField {...f("employee_monthly_cap")} label="Per employee, per month" prefix={currency} />
          <NumberField {...f("agent_daily_budget")} label="Whole company, per day" prefix={currency} />
        </div>
      </fieldset>

      <fieldset>
        <legend className="font-display font-semibold text-base text-ink">Risk score bands</legend>
        <p className="text-sm text-ink-muted mt-1">
          Each claim gets a risk score from 0 to 100. From these scores up, it goes to the matching HR lane.
        </p>
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-3">
          <NumberField {...f("quick_min_score")} label="Quick approval" />
          <NumberField {...f("review_min_score")} label="HR review" />
          <NumberField {...f("dual_min_score")} label="Two-person review" />
        </div>
      </fieldset>
    </div>
  );
}
