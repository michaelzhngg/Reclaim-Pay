import {
  FilterState,
  uniqueValues,
} from "@/lib/hooks/useClaimsFilter";
import { STATUS_ICON, STATUS_STYLE } from "./StatusBadge";
import type { AiStatus, Claim } from "@/lib/api/types";

export function FilterPanel({
  claims,
  filters,
  onChange,
  onClear,
}: {
  claims: Claim[];
  filters: FilterState;
  onChange: (next: FilterState) => void;
  onClear: () => void;
}) {
  const allStatuses = uniqueValues(claims, "status") as AiStatus[];
  const allCategories = uniqueValues(claims, "category");

  function toggleStatus(s: AiStatus) {
    const next = filters.statuses.includes(s)
      ? filters.statuses.filter((x) => x !== s)
      : [...filters.statuses, s];
    onChange({ ...filters, statuses: next });
  }

  function toggleCategory(cat: string) {
    const next = filters.categories.includes(cat)
      ? filters.categories.filter((x) => x !== cat)
      : [...filters.categories, cat];
    onChange({ ...filters, categories: next });
  }

  return (
    <div className="px-6 pt-4 pb-5 bg-surface-muted border-b border-line
                    flex flex-col gap-4">

      {/* ── Row 1: Status + Amount Range + Clear ──────────────────────── */}
      <div className="flex flex-wrap items-start gap-6">

        {/* Status chips */}
        <div className="flex-1 min-w-[200px]">
          <p className="text-sm font-medium font-body text-ink mb-2">
            AI Status
          </p>
          <div className="flex flex-wrap gap-2">
            {allStatuses.map((s) => {
              const active = filters.statuses.includes(s);
              return (
                <button
                  key={s}
                  onClick={() => toggleStatus(s)}
                  type="button"
                  aria-pressed={active}
                  className={`inline-flex items-center gap-1.5 px-3 min-h-[44px] rounded-control text-xs
                              font-semibold font-body border transition-colors
                              cursor-pointer ${
                                active
                                  ? `${STATUS_STYLE[s]} border-current`
                                  : "bg-surface border-line text-ink hover:bg-surface-muted"
                              }`}
                >
                  {active && STATUS_ICON[s]}
                  {s}
                </button>
              );
            })}
          </div>
        </div>

        {/* Amount range */}
        <div className="shrink-0">
          <p className="text-sm font-medium font-body text-ink mb-2">
            Amount Range
          </p>
          <div className="flex items-center gap-2">
            <div className="flex items-center bg-surface rounded-control
                            border border-line-strong
                            px-3 min-h-[44px] w-28">
              <span className="text-xs text-ink-muted mr-1">MYR</span>
              <input
                type="number"
                min={0}
                placeholder="Min"
                value={filters.amountMin}
                onChange={(e) => onChange({ ...filters, amountMin: e.target.value })}
                className="w-full bg-transparent text-sm text-ink outline-none font-body"
              />
            </div>
            <span className="text-ink-muted text-xs shrink-0">–</span>
            <div className="flex items-center bg-surface rounded-control
                            border border-line-strong
                            px-3 min-h-[44px] w-28">
              <span className="text-xs text-ink-muted mr-1">MYR</span>
              <input
                type="number"
                min={0}
                placeholder="Max"
                value={filters.amountMax}
                onChange={(e) => onChange({ ...filters, amountMax: e.target.value })}
                className="w-full bg-transparent text-sm text-ink outline-none font-body"
              />
            </div>
          </div>
        </div>

        {/* Clear all, top-right of row 1 */}
        <button
          onClick={onClear}
          type="button"
          className="self-end min-h-[44px] px-2 rounded-control text-xs font-semibold text-ink-muted
                     hover:text-ink hover:bg-surface transition-colors shrink-0"
        >
          Clear all filters
        </button>
      </div>

      {/* ── Row 2: Category, horizontal scroll strip ──────────────────── */}
      <div>
        <p className="text-sm font-medium font-body text-ink mb-2">
          Category
        </p>
        <div className="flex flex-nowrap gap-2 overflow-x-auto pb-1
                        ">
          {allCategories.map((cat) => {
            const active = filters.categories.includes(cat);
            return (
              <button
                key={cat}
                onClick={() => toggleCategory(cat)}
                type="button"
                aria-pressed={active}
                className={`shrink-0 px-3 min-h-[44px] rounded-full text-xs font-semibold font-body
                            border transition-colors cursor-pointer ${
                              active
                                ? "bg-ink text-on-ink border-ink"
                                : "bg-surface border-line text-ink hover:bg-surface-muted"
                            }`}
              >
                {cat}
              </button>
            );
          })}
        </div>
      </div>

    </div>
  );
}
