"use client";

import { useCallback, useState } from "react";
import { getAuditQueue } from "@/lib/actions/recoveries";
import type { Recovery } from "@/lib/api/reclaim-pay-types";
import { useTabData } from "@/lib/hooks/useTabData";
import { formatClaimRef } from "@/lib/format";
import { useToast } from "@/components/toast/ToastProvider";
import AuditQueueGrid from "@/components/hr-grid/AuditQueueGrid";
import RecoveryDialog from "@/components/hr-grid/RecoveryDialog";
import { TabEmpty, TabError, TabLoading } from "@/components/hr-grid/TabStates";
import { formatUpdated } from "@/components/hr-grid/ledger";
import type { AuditRow } from "@/components/hr-grid/recoveries";

async function fetchQueue(): Promise<AuditRow[]> {
  const { rows, error } = await getAuditQueue();
  if (!rows) throw new Error(error ?? "failed");
  return rows;
}

export default function AuditQueueTab() {
  const { toast } = useToast();
  const { data, isLoading, error, retry, refresh } = useTabData(
    fetchQueue,
    "Couldn't load the audit queue. Check your connection and try again.",
  );
  const [target, setTarget] = useState<AuditRow | null>(null);

  const onCreated = (recovery: Recovery) => {
    setTarget(null);
    toast({
      tone: "success",
      title: `Notice sent for ${formatClaimRef(recovery.reim_id)}. The employee can dispute until ${formatUpdated(recovery.dispute_until)}.`,
    });
    refresh();
  };

  const onRecord = useCallback((row: AuditRow) => setTarget(row), []);

  return (
    <>
      <p className="text-sm text-ink-muted mb-4">
        Auto-paid claims picked for a second look. Open a claim to check it, and record an overpayment if it was paid too much.
      </p>

      {isLoading && <TabLoading label="Loading the audit queue" />}
      {!isLoading && error && <TabError message={error} onRetry={retry} />}
      {!isLoading && !error && data?.length === 0 && (
        <TabEmpty title="No claims picked for audit">
          Auto-paid claims appear here when they are sampled at random or a later claim shows they were part of a split.
        </TabEmpty>
      )}
      {!isLoading && !error && !!data?.length && <AuditQueueGrid rows={data} onRecord={onRecord} />}

      <RecoveryDialog row={target} onClose={() => setTarget(null)} onCreated={onCreated} onRejected={refresh} />
    </>
  );
}
