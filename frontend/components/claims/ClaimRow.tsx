import { useCallback } from "react";
import { useRouter } from "next/navigation";
import type { Claim } from "@/lib/api/types";
import { StatusBadge } from "./StatusBadge";
import { Avatar } from "@/components/ui/Avatar";

export function ClaimRow({
  claim,
  actionLabel,
}: {
  claim: Claim;
  actionLabel: string;
}) {
  const router = useRouter();

  const navigate = useCallback(() => {
    const path =
      actionLabel === "View"
        ? `/hr/view/${claim.id}`
        : `/hr/review/${claim.id}`;
    router.push(path);
  }, [actionLabel, claim.id, router]);

  return (
    <tr
      onClick={navigate}
      tabIndex={0}
      role="button"
      aria-label={`${actionLabel} claim from ${claim.employee.name}`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          navigate();
        }
      }}
      className="group transition-colors
                 hover:bg-surface-muted
                 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent
                 cursor-pointer"
    >
      {/* Employee */}
      <td className="py-5 px-6">
        <div className="flex items-center gap-3">
          <Avatar name={claim.employee.name} initials={claim.employee.initials} />
          <div>
            <p className="font-semibold text-ink text-sm leading-tight">
              {claim.employee.name}
            </p>
            {claim.note && (
              <p className="text-xs text-ink-muted mt-0.5 leading-tight">
                {claim.note}
              </p>
            )}
          </div>
        </div>
      </td>
      {/* Date */}
      <td className="py-5 px-6 text-ink-muted text-sm hidden sm:table-cell">
        {claim.date}
      </td>
      {/* Amount */}
      <td className="py-5 px-6">
        <span className="font-mono font-medium text-ink text-sm">
          {claim.amount}
        </span>
      </td>
      {/* Category */}
      <td className="py-5 px-6 text-ink-muted text-sm hidden md:table-cell">
        {claim.category}
      </td>
      {/* AI Status */}
      <td className="py-5 px-6 hidden lg:table-cell">
        <StatusBadge status={claim.status} />
      </td>
      {/* Action */}
      <td className="py-5 px-6 text-right">
        <button
          id={`action-btn-${claim.id}`}
          onClick={(e) => {
            e.stopPropagation();
            navigate();
          }}
          type="button"
          className="inline-flex items-center min-h-[44px] px-2 text-accent-hover font-semibold text-sm
                     group-hover:underline"
        >
          {actionLabel}
        </button>
      </td>
    </tr>
  );
}
