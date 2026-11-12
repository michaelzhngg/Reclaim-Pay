"use client";

import { useState } from "react";
import { Calendar, ChevronDown, Filter, Check } from "lucide-react";

export type FilterStatus = "All" | "Pending" | "Approved" | "Partially Approved" | "Paid" | "Rejected";

interface HistoryFilterBarProps {
  currentStatus: FilterStatus;
  onStatusChange: (status: FilterStatus) => void;
  dateRange: string;
  onDateRangeChange: (range: string) => void;
  category: string;
  onCategoryChange: (category: string) => void;
}

const STATUSES: FilterStatus[] = ["All", "Pending", "Approved", "Partially Approved", "Paid", "Rejected"];
const DATE_OPTIONS = ["Last 30 Days", "Last 90 Days", "This Year", "All Time"];
const CATEGORY_OPTIONS = [
  { id: "All", label: "All Categories" },
  { id: "Travel", label: "Travel" },
  { id: "Meals", label: "Meals" },
  { id: "Equipment", label: "Equipment" },
  { id: "Office", label: "Office" },
];

export default function HistoryFilterBar({
  currentStatus,
  onStatusChange,
  dateRange,
  onDateRangeChange,
  category,
  onCategoryChange
}: HistoryFilterBarProps) {
  const [dateOpen, setDateOpen] = useState(false);
  const [categoryOpen, setCategoryOpen] = useState(false);

  return (
    <div
      className="flex flex-col md:flex-row items-start md:items-center justify-between gap-4 mb-6 relative"
      onKeyDown={(e) => { if (e.key === "Escape") { setDateOpen(false); setCategoryOpen(false); } }}
    >

      {/* ── Overlay for Popovers ── */}
      {(dateOpen || categoryOpen) && (
        <div aria-hidden="true"
          className="fixed inset-0 z-40"
          onClick={() => { setDateOpen(false); setCategoryOpen(false); }}
        />
      )}

      {/* ── Status Pills (Horizontal Scroll on Mobile) ── */}
      <div className="w-full md:w-auto overflow-x-auto pb-2 md:pb-0 -mx-4 px-4 md:mx-0 md:px-0 flex items-center gap-2 [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden snap-x scroll-pl-4 relative z-30">
        {STATUSES.map((status) => {
          const isActive = status === currentStatus;
          return (
            <button
              key={status}
              type="button"
              aria-pressed={isActive}
              onClick={() => onStatusChange(status)}
              className={`whitespace-nowrap px-4 min-h-[44px] rounded-full text-sm font-semibold transition-colors cursor-pointer border snap-start ${
                isActive
                  ? "bg-ink text-on-ink border-ink"
                  : "bg-surface text-ink hover:bg-surface-muted border-line"
              }`}
            >
              {status}
            </button>
          );
        })}
      </div>

      {/* ── Secondary Filters (Date / Category) ── */}
      <div className="flex items-center gap-2 w-full md:w-auto relative z-50">

        {/* Date Dropdown */}
        <div className="relative flex-1 md:flex-none shrink-0">
          <button
            type="button"
            onClick={() => { setDateOpen(!dateOpen); setCategoryOpen(false); }}
            aria-haspopup="true"
            aria-expanded={dateOpen}
            aria-label={`Date range: ${dateRange}`}
            className="w-full flex items-center justify-between md:justify-center gap-2 bg-surface border border-line text-ink pl-10 pr-4 rounded-control text-sm font-semibold hover:bg-surface-muted transition-colors min-h-[44px]"
          >
            <Calendar className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted pointer-events-none" aria-hidden="true" />
            <span className="truncate">{dateRange}</span>
            <ChevronDown className={`w-3.5 h-3.5 text-ink-muted transition-transform ${dateOpen ? "rotate-180" : ""}`} aria-hidden="true" />
          </button>

          {dateOpen && (
            <div className="absolute right-0 md:left-0 top-[calc(100%+8px)] w-48 bg-surface shadow-ambient rounded-card shadow-overlay py-1">
              {DATE_OPTIONS.map((opt) => (
                <button
                  key={opt}
                  type="button"
                  aria-pressed={dateRange === opt}
                  onClick={() => { onDateRangeChange(opt); setDateOpen(false); }}
                  className="w-full flex items-center justify-between px-4 min-h-[44px] text-sm text-left hover:bg-surface-muted transition-colors"
                >
                  <span className={dateRange === opt ? "font-semibold text-ink" : "text-ink"}>
                    {opt}
                  </span>
                  {dateRange === opt && <Check className="w-4 h-4 text-ink" aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Category Dropdown */}
        <div className="relative flex-none shrink-0 h-11">
          <button
            type="button"
            onClick={() => { setCategoryOpen(!categoryOpen); setDateOpen(false); }}
            aria-haspopup="true"
            aria-expanded={categoryOpen}
            className="w-11 h-11 flex items-center justify-center bg-surface border border-line text-ink rounded-control hover:bg-surface-muted transition-colors"
            aria-label={category === "All" ? "Filter by category" : `Filter by category: ${category}`}
            title="Filter by category"
          >
            <Filter className="w-4 h-4" aria-hidden="true" />
            {category !== "All" && (
              <span className="absolute top-2 right-2 w-2 h-2 bg-ink rounded-full ring-2 ring-surface" />
            )}
          </button>

          {categoryOpen && (
            <div className="absolute right-0 top-[calc(100%+8px)] w-48 bg-surface shadow-ambient rounded-card shadow-overlay py-1">
              {CATEGORY_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  aria-pressed={category === opt.id}
                  onClick={() => { onCategoryChange(opt.id); setCategoryOpen(false); }}
                  className="w-full flex items-center justify-between px-4 min-h-[44px] text-sm text-left hover:bg-surface-muted transition-colors"
                >
                  <span className={category === opt.id ? "font-semibold text-ink" : "text-ink"}>
                    {opt.label}
                  </span>
                  {category === opt.id && <Check className="w-4 h-4 text-ink" aria-hidden="true" />}
                </button>
              ))}
            </div>
          )}
        </div>

      </div>

    </div>
  );
}
