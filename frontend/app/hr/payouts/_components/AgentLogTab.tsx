"use client";

import { ShieldAlert, ShieldCheck } from "lucide-react";
import { getAgentLog } from "@/lib/actions/autonomy";
import { useTabData } from "@/lib/hooks/useTabData";
import AgentLogGrid from "@/components/hr-grid/AgentLogGrid";
import { TabEmpty, TabError, TabLoading } from "@/components/hr-grid/TabStates";
import { chainBadgeLabel } from "@/components/hr-grid/agentLog";

const LIMIT = 200;

async function fetchLog() {
  const { result, actorNames, error } = await getAgentLog(LIMIT);
  if (!result) throw new Error(error ?? "failed");
  return { ...result, actorNames };
}

export default function AgentLogTab() {
  const { data, isLoading, error, retry } = useTabData(
    fetchLog,
    "Couldn't load the agent log. Check your connection and try again.",
  );

  const count = data?.actions.length ?? 0;

  return (
    <>
      <p className="text-sm text-ink-muted mb-4">
        What the agent and HR did, newest first. Each entry is hashed with the one before it, so changing or deleting an entry breaks the chain.
      </p>

      {isLoading && <TabLoading label="Loading the agent log" />}
      {!isLoading && error && <TabError message={error} onRetry={retry} />}

      {!isLoading && !error && data && !data.chain_valid && (
        <div role="alert" className="flex items-start gap-3 rounded-card bg-danger text-on-accent px-4 py-3 mb-4">
          <ShieldAlert className="w-5 h-5 mt-0.5 shrink-0" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-semibold">{chainBadgeLabel(false, count, LIMIT)}</p>
            <p className="mt-0.5">An entry was changed or removed after it was written, so don&apos;t rely on this log until it has been investigated.</p>
          </div>
        </div>
      )}

      {!isLoading && !error && data?.chain_valid && count > 0 && (
        <p className="inline-flex items-center gap-1.5 px-2.5 py-1 mb-4 rounded-md border border-success/30 bg-success-soft text-success text-sm font-semibold">
          <ShieldCheck className="w-4 h-4 shrink-0" aria-hidden="true" />
          {chainBadgeLabel(true, count, LIMIT)}
        </p>
      )}

      {!isLoading && !error && count >= LIMIT && (
        <p className="text-xs text-ink-muted mb-3">Showing the latest {LIMIT} entries. The chain check covers the whole log.</p>
      )}

      {!isLoading && !error && data && count === 0 && (
        <TabEmpty title="Nothing logged yet">Entries appear when the agent decides a claim or HR changes a limit.</TabEmpty>
      )}

      {!isLoading && !error && data && count > 0 && <AgentLogGrid rows={data.actions} actorNames={data.actorNames} />}
    </>
  );
}
