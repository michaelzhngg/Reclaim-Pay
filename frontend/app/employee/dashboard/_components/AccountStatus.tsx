import type { Recovery } from "@/lib/api/reclaim-pay-types";
import RecoveryNotice from "./RecoveryNotice";

interface Props {
  recoveries: Recovery[] | null | undefined;
  /** The recovery a notification linked to with ?recovery={id}; shown first and outlined. */
  linkedRecoveryId?: string | null;
  className?: string;
}

/**
 * Overpayment notices, two to a row from md up.
 * Renders nothing without notices, so a missing endpoint leaves no gap.
 */
export default function AccountStatus({ recoveries, linkedRecoveryId = null, className = "" }: Props) {
  const notices = [...(recoveries ?? [])].sort(
    (a, b) => Number(b.recovery_id === linkedRecoveryId) - Number(a.recovery_id === linkedRecoveryId),
  );
  if (notices.length === 0) return null;

  return (
    <div className={`grid grid-cols-1 items-start gap-3 md:grid-cols-2 md:gap-6 ${className}`}>
      {notices.map(r => (
        <RecoveryNotice key={r.recovery_id} recovery={r} linked={r.recovery_id === linkedRecoveryId} />
      ))}
    </div>
  );
}
