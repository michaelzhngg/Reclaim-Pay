"use client";

import { useId } from "react";
import { Check, Monitor, Moon, Rows3, Rows4, Sun, type LucideIcon } from "lucide-react";
import type { Density, ThemePref } from "@/lib/theme/preferences";
import { useAppearance } from "./AppearanceProvider";

export const THEME_OPTIONS: { value: ThemePref; label: string; icon: LucideIcon }[] = [
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
  { value: "system", label: "System", icon: Monitor },
];

const DENSITY_OPTIONS: { value: Density; label: string; icon: LucideIcon }[] = [
  { value: "comfortable", label: "Comfortable", icon: Rows3 },
  { value: "compact", label: "Compact", icon: Rows4 },
];

type Layout = "list" | "tiles";

/**
 * Native radios, so arrow keys move within a group and Tab leaves it. The checked option
 * shows a tick as well as the tint, so the state never rests on colour.
 */
function OptionGroup<T extends string>({
  legend,
  hint,
  options,
  value,
  onChange,
  layout,
}: {
  legend: string;
  hint?: string;
  options: { value: T; label: string; icon: LucideIcon }[];
  value: T;
  onChange: (next: T) => void;
  layout: Layout;
}) {
  const name = useId();
  const hintId = `${name}-hint`;
  const tiles = layout === "tiles";
  return (
    <fieldset aria-describedby={hint ? hintId : undefined} className="min-w-0">
      <legend className={tiles ? "font-body text-sm font-semibold text-ink" : "px-3 pb-1 text-xs font-semibold text-ink-muted"}>
        {legend}
      </legend>
      {hint && (
        <p id={hintId} className={tiles ? "mt-0.5 font-body text-sm text-ink-muted" : "px-3 pb-2 text-xs text-ink-muted"}>
          {hint}
        </p>
      )}
      <div className={tiles ? `mt-3 grid gap-2 ${options.length === 3 ? "grid-cols-3" : "grid-cols-2"}` : "flex flex-col"}>
        {options.map((o) => {
          const checked = o.value === value;
          return (
            <label
              key={o.value}
              className={`relative flex min-h-11 cursor-pointer items-center gap-2.5 rounded-control px-3 font-body text-sm transition-colors has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-secondary ${
                tiles ? "flex-col justify-center gap-1 border py-2.5 text-center" : ""
              } ${
                checked
                  ? `font-semibold text-ink ${tiles ? "border-accent bg-accent-soft" : "bg-surface-muted"}`
                  : `text-ink-muted hover:bg-surface-muted hover:text-ink ${tiles ? "border-line-strong" : ""}`
              }`}
            >
              <input
                type="radio"
                name={name}
                value={o.value}
                checked={checked}
                onChange={() => onChange(o.value)}
                className="sr-only"
              />
              <o.icon aria-hidden="true" className="h-4 w-4 shrink-0" strokeWidth={1.75} />
              <span className="min-w-0 truncate">{o.label}</span>
              {checked && (
                <Check
                  aria-hidden="true"
                  className={`shrink-0 text-accent ${tiles ? "absolute right-1.5 top-1.5 h-3.5 w-3.5" : "ml-auto h-4 w-4"}`}
                  strokeWidth={2.25}
                />
              )}
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function ThemeOptions({ layout }: { layout: Layout }) {
  const { pref, setPref } = useAppearance();
  return (
    <OptionGroup
      legend="Theme"
      hint={layout === "tiles" ? "System follows the light or dark setting on this device." : undefined}
      options={THEME_OPTIONS}
      value={pref}
      onChange={setPref}
      layout={layout}
    />
  );
}

export function DensityOptions({ layout }: { layout: Layout }) {
  const { density, setDensity } = useAppearance();
  return (
    <OptionGroup
      legend="Table density"
      hint={
        layout === "tiles"
          ? "Compact fits more rows into HR tables on screens 768 px and wider. Phones keep full-size rows."
          : undefined
      }
      options={DENSITY_OPTIONS}
      value={density}
      onChange={setDensity}
      layout={layout}
    />
  );
}
