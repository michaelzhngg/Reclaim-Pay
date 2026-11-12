import type { SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";

/**
 * Native select with the OS arrow turned off, a reserved right gutter and a
 * drawn chevron so the arrow sits inside the field on Chrome and Safari.
 * Callers own border, height, type and focus styling through className.
 */
export function Select({
  className = "",
  children,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative">
      <select
        {...props}
        className={`w-full cursor-pointer appearance-none rounded-control border bg-surface pl-3 pr-10 text-ink ${className}`}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-ink-muted"
        aria-hidden="true"
      />
    </div>
  );
}
