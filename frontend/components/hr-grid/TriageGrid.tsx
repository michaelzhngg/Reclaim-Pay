"use client";

import { useCallback, useEffect, useMemo, useRef } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AgGridReact } from "ag-grid-react";
import type {
  CellKeyDownEvent,
  ColDef,
  GridApi,
  GridSizeChangedEvent,
  ICellRendererParams,
  RowClickedEvent,
  RowSelectionOptions,
  SelectionChangedEvent,
} from "ag-grid-community";
import { formatMoney } from "@/lib/api/reclaim-pay-types";
import { useHrGridTheme } from "./useHrGridTheme";
import { TierPill } from "./cells/TierCell";
import { RiskBar } from "./cells/RiskCell";
import { SignalChips } from "./cells/SignalsCell";
import {
  claimHref,
  formatSubmitted,
  isBatchSelectable,
  statusLabel,
  verdictLabel,
  type TriageRow,
} from "./rows";

// Status only earns a column when there is room; below that it rides in the card list and the review page.
const STATUS_COLUMN_MIN_WIDTH = 1080;

interface TriageGridProps {
  rows: TriageRow[];
  /** Turns on checkboxes. Only the Quick tab passes this. */
  selectable: boolean;
  selfId: string | null;
  selected: ReadonlySet<string>;
  onSelectedChange: (ids: Set<string>) => void;
}

function AiVerdict({ row }: { row: TriageRow }) {
  return (
    <span className="flex flex-col leading-tight">
      <span className="text-xs font-semibold text-ink">{verdictLabel(row.aiVerdict)}</span>
      {row.confidence != null && (
        <span className="text-xs font-mono text-ink-muted">{row.confidence.toFixed(2)}</span>
      )}
    </span>
  );
}

function TriageCard({
  row,
  selectable,
  canSelect,
  checked,
  onToggle,
}: {
  row: TriageRow;
  selectable: boolean;
  canSelect: boolean;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <li className="flex items-stretch gap-1 bg-surface rounded-card shadow-ambient">
      {selectable && (
        <label className="flex items-start justify-center pt-4 pl-3 min-w-[44px] cursor-pointer has-disabled:cursor-not-allowed">
          <input
            type="checkbox"
            checked={checked}
            disabled={!canSelect}
            onChange={onToggle}
            aria-label={canSelect ? `Select ${row.ref} for approval` : `${row.ref} can't be batch approved`}
            className="w-5 h-5 accent-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
          />
        </label>
      )}
      <Link
        href={claimHref(row)}
        className="flex-1 min-w-0 p-4 rounded-card focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="font-semibold text-sm text-ink truncate">{row.employee}</p>
            <p className="text-xs text-ink-muted mt-0.5 truncate">
              <span className="font-mono">{row.ref}</span> · {row.category}
            </p>
          </div>
          <p className="font-mono font-medium text-sm text-ink shrink-0">
            {formatMoney(row.currency, row.amount)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 mt-3">
          <TierPill tier={row.tier} />
          <RiskBar score={row.riskScore} />
          <span className="text-xs text-ink-muted ml-auto">{formatSubmitted(row.submittedAt)}</span>
        </div>
        {row.signals.length > 0 && (
          <div className="mt-2">
            <SignalChips signals={row.signals} />
          </div>
        )}
        <p className="mt-2 text-xs text-ink-muted">
          AI: {verdictLabel(row.aiVerdict)}
          {row.confidence != null && ` ${row.confidence.toFixed(2)}`} · {statusLabel(row)}
        </p>
      </Link>
    </li>
  );
}

export default function TriageGrid({ rows, selectable, selfId, selected, onSelectedChange }: TriageGridProps) {
  const gridTheme = useHrGridTheme();
  const router = useRouter();
  const apiRef = useRef<GridApi<TriageRow> | null>(null);

  const columnDefs = useMemo<ColDef<TriageRow>[]>(
    () => [
      {
        field: "ref",
        headerName: "Claim",
        width: 104,
        cellRenderer: (p: ICellRendererParams<TriageRow>) =>
          p.data ? (
            <Link
              href={claimHref(p.data)}
              tabIndex={-1}
              className="font-mono text-xs text-ink hover:text-accent hover:underline"
            >
              {p.data.ref}
            </Link>
          ) : null,
      },
      {
        field: "employee",
        headerName: "Employee",
        flex: 1,
        minWidth: 124,
        cellRenderer: (p: ICellRendererParams<TriageRow>) =>
          p.data ? (
            <span className="flex flex-col leading-tight min-w-0">
              <span className="truncate font-medium text-ink">{p.data.employee}</span>
              <span className="truncate text-xs text-ink-muted">{p.data.category}</span>
            </span>
          ) : null,
      },
      {
        field: "amount",
        headerName: "Amount",
        width: 128,
        type: "rightAligned",
        cellClass: "font-mono font-medium",
        valueFormatter: (p) => (p.data ? formatMoney(p.data.currency, p.data.amount) : ""),
      },
      {
        field: "aiVerdict",
        headerName: "AI",
        width: 84,
        cellRenderer: (p: ICellRendererParams<TriageRow>) => (p.data ? <AiVerdict row={p.data} /> : null),
      },
      {
        field: "tier",
        headerName: "Tier",
        width: 140,
        cellRenderer: (p: ICellRendererParams<TriageRow>) => (p.data ? <TierPill tier={p.data.tier} /> : null),
      },
      {
        field: "riskScore",
        headerName: "Risk",
        width: 92,
        cellRenderer: (p: ICellRendererParams<TriageRow>) => (p.data ? <RiskBar score={p.data.riskScore} /> : null),
      },
      {
        colId: "signals",
        headerName: "Signals",
        flex: 1.4,
        minWidth: 176,
        sortable: false,
        autoHeight: true,
        valueGetter: (p) => p.data?.signals.length ?? 0,
        cellRenderer: (p: ICellRendererParams<TriageRow>) => (p.data ? <SignalChips signals={p.data.signals} /> : null),
      },
      {
        field: "submittedAt",
        headerName: "When",
        width: 72,
        sort: "desc",
        valueFormatter: (p) => formatSubmitted(p.value ?? null),
      },
      {
        colId: "status",
        headerName: "Status",
        width: 116,
        hide: true,
        valueGetter: (p) => (p.data ? statusLabel(p.data) : ""),
      },
    ],
    [],
  );

  const rowSelection = useMemo<RowSelectionOptions<TriageRow> | undefined>(
    () =>
      selectable
        ? {
            mode: "multiRow",
            checkboxes: true,
            headerCheckbox: true,
            selectAll: "filtered",
            enableClickSelection: false,
            hideDisabledCheckboxes: true,
            isRowSelectable: (node) => (node.data ? isBatchSelectable(node.data, selfId) : false),
          }
        : undefined,
    [selectable, selfId],
  );

  // React state owns the selection so the grid and the phone card list agree. Push it into the grid
  // whenever the selection changes or the grid finishes taking new rows.
  const selectedRef = useRef(selected);
  const syncSelection = useCallback(() => {
    const api = apiRef.current;
    if (!api || !selectable) return;
    const toSelect: Parameters<GridApi<TriageRow>["setNodesSelected"]>[0]["nodes"] = [];
    const toClear: typeof toSelect = [];
    api.forEachNode((node) => {
      const want = !!node.data && selectedRef.current.has(node.data.reimId);
      if (want !== !!node.isSelected()) (want ? toSelect : toClear).push(node);
    });
    if (toSelect.length) api.setNodesSelected({ nodes: toSelect, newValue: true, source: "api" });
    if (toClear.length) api.setNodesSelected({ nodes: toClear, newValue: false, source: "api" });
  }, [selectable]);

  useEffect(() => {
    selectedRef.current = selected;
    syncSelection();
  }, [selected, rows, syncSelection]);

  const onSelectionChanged = useCallback(
    (e: SelectionChangedEvent<TriageRow>) => {
      if (e.source === "api") return;
      onSelectedChange(new Set(e.api.getSelectedRows().map((r) => r.reimId)));
    },
    [onSelectedChange],
  );

  const onGridSizeChanged = useCallback((e: GridSizeChangedEvent<TriageRow>) => {
    e.api.setColumnsVisible(["status"], e.clientWidth >= STATUS_COLUMN_MIN_WIDTH);
  }, []);

  const open = useCallback((row: TriageRow | undefined) => row && router.push(claimHref(row)), [router]);

  const onRowClicked = useCallback(
    (e: RowClickedEvent<TriageRow>) => {
      const target = e.event?.target as HTMLElement | null;
      // Checkbox clicks select; link clicks already navigate.
      if (target?.closest(".ag-selection-checkbox, .ag-checkbox, a, input")) return;
      open(e.data);
    },
    [open],
  );

  const onCellKeyDown = useCallback(
    (e: CellKeyDownEvent<TriageRow>) => {
      const key = (e.event as KeyboardEvent | null)?.key;
      if (key === "Enter" && e.column.getColId() !== "ag-Grid-SelectionColumn") open(e.data);
    },
    [open],
  );

  const getRowId = useCallback((p: { data: TriageRow }) => p.data.reimId, []);

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    onSelectedChange(next);
  };

  return (
    <>
      <div className="hidden sm:block">
        <AgGridReact<TriageRow>
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
          selectionColumnDef={{ width: 44, minWidth: 44, maxWidth: 44, pinned: false }}
          rowSelection={rowSelection}
          getRowId={getRowId}
          domLayout="autoHeight"
          pagination
          paginationPageSize={20}
          paginationPageSizeSelector={false}
          rowClass="cursor-pointer"
          onGridReady={(e) => {
            apiRef.current = e.api;
          }}
          onFirstDataRendered={syncSelection}
          onRowDataUpdated={syncSelection}
          onSelectionChanged={onSelectionChanged}
          onGridSizeChanged={onGridSizeChanged}
          onRowClicked={onRowClicked}
          onCellKeyDown={onCellKeyDown}
        />
      </div>
      <ul className="sm:hidden flex flex-col gap-3" aria-label="Claims">
        {rows.map((row) => (
          <TriageCard
            key={row.reimId}
            row={row}
            selectable={selectable}
            canSelect={isBatchSelectable(row, selfId)}
            checked={selected.has(row.reimId)}
            onToggle={() => toggle(row.reimId)}
          />
        ))}
      </ul>
    </>
  );
}
