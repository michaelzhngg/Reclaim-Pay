"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgGridReact } from "ag-grid-react";
import type { ColDef, ICellRendererParams } from "ag-grid-community";
import { Check, Copy } from "lucide-react";
import { formatMoney, type PayoutLedgerRow, type PayoutStatus } from "@/lib/api/reclaim-pay-types";
import { formatClaimRef } from "@/lib/format";
import { STATUS_META, TONE_CLASSES, formatUpdated, hasAnyTier, tierLabel } from "./ledger";
import { useHrGridTheme } from "./useHrGridTheme";

export function StatusPill({ status }: { status: PayoutStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-md border text-xs font-semibold ${TONE_CLASSES[meta.tone]}`}
    >
      {meta.label}
    </span>
  );
}

export function CopyBatchId({ value }: { value: string | null }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  if (!value) return <span className="text-ink-muted">Not issued yet</span>;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button
      type="button"
      onClick={copy}
      aria-label={copied ? `Copied ${value}` : `Copy PayPal batch ID ${value}`}
      className="inline-flex items-center gap-1.5 min-h-[44px] -my-2 px-1.5 rounded-md font-mono text-xs text-ink hover:text-accent focus-visible:outline-2 focus-visible:outline-accent focus-visible:outline-offset-2 cursor-pointer"
    >
      <span className="truncate">{value}</span>
      {copied ? (
        <Check className="w-3.5 h-3.5 text-success shrink-0" aria-hidden="true" />
      ) : (
        <Copy className="w-3.5 h-3.5 text-ink-muted shrink-0" aria-hidden="true" />
      )}
      <span aria-live="polite" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </button>
  );
}

function LedgerCard({ row }: { row: PayoutLedgerRow }) {
  return (
    <li className="bg-surface rounded-card shadow-ambient p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold text-sm text-ink truncate">{row.payee_name}</p>
          <p className="text-xs text-ink-muted truncate">Requested by {row.employee_name}</p>
          <p className="font-mono text-xs text-ink-muted mt-0.5">{formatClaimRef(row.claim_ref)}</p>
        </div>
        <p className="font-mono font-medium text-sm text-ink shrink-0">
          {formatMoney(row.currency, row.amount)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mt-3 text-xs text-ink-muted">
        <StatusPill status={row.status} />
        {row.tier && <span>{tierLabel(row.tier)}</span>}
        <span>Attempt {row.attempt}</span>
        <span className="ml-auto">{formatUpdated(row.updated_at)}</span>
      </div>
      <div className="mt-2 text-xs min-w-0">
        <CopyBatchId value={row.provider_batch_id} />
      </div>
    </li>
  );
}

export default function LedgerGrid({ rows }: { rows: PayoutLedgerRow[] }) {
  const gridTheme = useHrGridTheme();
  // Tiers aren't stored on payouts yet. Until one is, a Route column would say "Not recorded" on every row.
  const showRoute = hasAnyTier(rows);

  // Minimum widths add up to 956 px with Route and 826 px without, so every column fits the
  // ~960 px content area at a 1280 px window (sidebar 256 px, page padding 64 px).
  const columnDefs = useMemo<ColDef<PayoutLedgerRow>[]>(
    () => [
      {
        field: "claim_ref",
        headerName: "Claim",
        width: 112,
        cellClass: "font-mono text-xs",
        valueFormatter: (p) => (p.value ? formatClaimRef(p.value) : ""),
      },
      { field: "payee_name", headerName: "Paid to", flex: 1, minWidth: 130 },
      { field: "employee_name", headerName: "Requester", width: 130 },
      {
        field: "amount",
        headerName: "Amount",
        width: 112,
        type: "rightAligned",
        cellClass: "font-mono font-medium",
        valueFormatter: (p) => (p.data ? formatMoney(p.data.currency, p.data.amount) : ""),
      },
      {
        field: "status",
        headerName: "Status",
        width: 104,
        cellRenderer: (p: ICellRendererParams<PayoutLedgerRow>) =>
          p.data ? <StatusPill status={p.data.status} /> : null,
      },
      {
        field: "tier",
        headerName: "Route",
        width: 130,
        hide: !showRoute,
        valueFormatter: (p) => tierLabel(p.value ?? null),
      },
      { field: "attempt", headerName: "Attempt", width: 88, type: "rightAligned" },
      {
        field: "provider_batch_id",
        headerName: "PayPal batch ID",
        flex: 1,
        minWidth: 160,
        sortable: false,
        cellRenderer: (p: ICellRendererParams<PayoutLedgerRow>) => (
          <CopyBatchId value={p.data?.provider_batch_id ?? null} />
        ),
      },
      {
        field: "updated_at",
        headerName: "Updated",
        width: 120,
        sort: "desc",
        valueFormatter: (p) => (p.value ? formatUpdated(p.value) : ""),
      },
    ],
    [showRoute],
  );

  const getRowId = useCallback((p: { data: PayoutLedgerRow }) => p.data.payout_id, []);

  return (
    <>
      <div className="hidden sm:block">
        <AgGridReact<PayoutLedgerRow>
          theme={gridTheme}
          rowData={rows}
          columnDefs={columnDefs}
          defaultColDef={{ sortable: true, resizable: true, suppressMovable: true }}
          getRowId={getRowId}
          domLayout="autoHeight"
          pagination
          paginationPageSize={20}
          paginationPageSizeSelector={false}
          suppressCellFocus={false}
        />
      </div>
      <ul className="sm:hidden flex flex-col gap-3" aria-label="Payouts">
        {rows.map((row) => (
          <LedgerCard key={row.payout_id} row={row} />
        ))}
      </ul>
    </>
  );
}
