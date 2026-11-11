"use client";

import { useCallback, useState } from "react";
import { listHRRecoveries } from "@/lib/actions/recoveries";
import type { Recovery } from "@/lib/api/reclaim-pay-types";
import { formatClaimRef } from "@/lib/format";
import { useTabData } from "@/lib/hooks/useTabData";
import { useToast } from "@/components/toast/ToastProvider";
import InvoicePreviewDialog from "@/components/hr-grid/InvoicePreviewDialog";
import RecoveriesGrid from "@/components/hr-grid/RecoveriesGrid";
import { TabEmpty, TabError, TabLoading } from "@/components/hr-grid/TabStates";
import WaiveDialog from "@/components/hr-grid/WaiveDialog";
import type { HRRecovery } from "@/components/hr-grid/recoveries";

async function fetchRecoveries(): Promise<HRRecovery[]> {
  const { recoveries, error } = await listHRRecoveries();
  if (!recoveries) throw new Error(error ?? "failed");
  return recoveries;
}

export default function RecoveriesTab({ onOpenAudit }: { onOpenAudit: () => void }) {
  const { toast } = useToast();
  const { data, isLoading, error, retry, refresh } = useTabData(
    fetchRecoveries,
    "Couldn't load recoveries. Check your connection and try again.",
  );
  const [previewing, setPreviewing] = useState<HRRecovery | null>(null);
  const [waiving, setWaiving] = useState<HRRecovery | null>(null);

  const onPreview = useCallback((r: HRRecovery) => setPreviewing(r), []);
  const onWaive = useCallback((r: HRRecovery) => setWaiving(r), []);

  const onWaived = (recovery: Recovery) => {
    setWaiving(null);
    toast({ tone: "success", title: `Recovery on ${formatClaimRef(recovery.reim_id)} waived. The employee has been told.` });
    refresh();
  };

  return (
    <>
      <p className="text-sm text-ink-muted mb-4">
        The employee can dispute a notice until its deadline. After that you can send the invoice. A disputed recovery can only be waived.
      </p>

      {isLoading && <TabLoading label="Loading recoveries" />}
      {!isLoading && error && <TabError message={error} onRetry={retry} />}
      {!isLoading && !error && data?.length === 0 && (
        <TabEmpty
          title="No recoveries yet"
          action={
            <button
              type="button"
              onClick={onOpenAudit}
              className="inline-flex items-center justify-center min-h-[44px] px-4 rounded-control border border-line text-sm font-semibold text-ink hover:bg-surface-muted focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 cursor-pointer"
            >
              Open the Audit queue
            </button>
          }
        >
          A recovery starts when HR records an overpayment on an audited claim.
        </TabEmpty>
      )}
      {!isLoading && !error && !!data?.length && <RecoveriesGrid rows={data} onPreview={onPreview} onWaive={onWaive} />}

      <InvoicePreviewDialog recovery={previewing} onClose={() => setPreviewing(null)} onChanged={refresh} />
      <WaiveDialog recovery={waiving} onClose={() => setWaiving(null)} onWaived={onWaived} onRejected={refresh} />
    </>
  );
}
