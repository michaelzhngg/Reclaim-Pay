"use client";

import { useCallback, useMemo } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import type { AgentAction } from "@/lib/api/reclaim-pay-types";
import ClaimLink from "./ClaimLink";
import { actionLabel, actionSummary, actorLabel, hashPrefix } from "./agentLog";
import { tabThroughCell } from "./cellKeyboard";
import { formatUpdated } from "./ledger";
import { hrGridTheme } from "./theme";

/** A native <details>, so opening it works by keyboard and AG Grid's auto height follows the change. */
function PayloadDetails({ action }: { action: AgentAction }) {
  const summary = actionSummary(action);
  return (
    <details className="py-2 leading-snug whitespace-normal">
      <summary className="cursor-pointer min-h-[44px] flex items-center rounded-sm focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2">
        {summary ?? "Show details"}
      </summary>
      <pre className="mt-2 p-3 rounded-lg bg-surface-muted text-xs font-mono whitespace-pre-wrap break-all text-ink">
        {JSON.stringify(action.payload, null, 2)}
      </pre>
      <p className="mt-2 text-xs text-ink-muted break-all">
        Hash <span className="font-mono">{action.hash}</span>
      </p>
      {action.prev_hash && (
        <p className="mt-1 text-xs text-ink-muted break-all">
          Previous <span className="font-mono">{action.prev_hash}</span>
        </p>
      )}
    </details>
  );
}

function LogCard({ action, actorNames }: { action: AgentAction; actorNames: Record<string, string> }) {
  return (
    <li className="bg-surface rounded-card shadow-ambient p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="font-semibold text-sm text-ink min-w-0">{actionLabel(action)}</p>
        <p className="text-xs text-ink-muted shrink-0">{formatUpdated(action.created_at)}</p>
      </div>
      <div className="flex items-center justify-between gap-3 mt-1 text-xs text-ink-muted">
        <span className="min-w-0 truncate">{actorLabel(action.actor, actorNames)}</span>
        {action.reim_id && <ClaimLink reimId={action.reim_id} />}
      </div>
      <div className="mt-1 text-sm text-ink">
        <PayloadDetails action={action} />
      </div>
    </li>
  );
}

export default function AgentLogGrid({ rows, actorNames }: { rows: AgentAction[]; actorNames: Record<string, string> }) {
  const columnDefs = useMemo<ColDef<AgentAction>[]>(
    () => [
      {
        field: "created_at",
        headerName: "Time",
        width: 124,
        valueFormatter: (p) => (p.value ? formatUpdated(p.value) : ""),
      },
      {
        colId: "action",
        headerName: "Action",
        width: 186,
        valueGetter: (p) => (p.data ? actionLabel(p.data) : ""),
      },
      {
        colId: "actor",
        headerName: "Actor",
        width: 130,
        valueGetter: (p) => (p.data ? actorLabel(p.data.actor, actorNames) : ""),
      },
      {
        field: "reim_id",
        headerName: "Claim",
        width: 108,
        suppressKeyboardEvent: tabThroughCell,
        cellRenderer: (p: ICellRendererParams<AgentAction>) =>
          p.data?.reim_id ? <ClaimLink reimId={p.data.reim_id} /> : <span className="text-ink-muted">None</span>,
      },
      {
        colId: "details",
        headerName: "Details",
        flex: 1,
        minWidth: 220,
        sortable: false,
        autoHeight: true,
        suppressKeyboardEvent: tabThroughCell,
        cellRenderer: (p: ICellRendererParams<AgentAction>) => (p.data ? <PayloadDetails action={p.data} /> : null),
      },
      {
        field: "hash",
        headerName: "Hash",
        width: 100,
        sortable: false,
        cellClass: "font-mono text-xs",
        valueFormatter: (p) => (p.value ? hashPrefix(p.value) : ""),
      },
    ],
    [actorNames],
  );

  const getRowId = useCallback((p: { data: AgentAction }) => String(p.data.action_id), []);

  return (
    <>
      <div className="hidden sm:block">
        <AgGridReact<AgentAction>
          theme={hrGridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
          getRowId={getRowId}
          domLayout="autoHeight"
          pagination
          paginationPageSize={25}
          paginationPageSizeSelector={false}
        />
      </div>
      <ul className="sm:hidden flex flex-col gap-3" aria-label="Agent log entries">
        {rows.map((action) => (
          <LogCard key={action.action_id} action={action} actorNames={actorNames} />
        ))}
      </ul>
    </>
  );
}
