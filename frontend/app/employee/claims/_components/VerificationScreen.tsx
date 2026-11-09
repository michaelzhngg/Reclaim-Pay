"use client";

import { useState, useMemo, useRef, useEffect } from "react";
import {
  ChevronLeft,
  Lock,
  ChevronDown,
  ChevronUp,
  AlertCircle,
  ClipboardList,
  Eye,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Loader2,
} from "lucide-react";
import type { DbEmployee, OcrReceiptData, ClaimContext } from "../../../../src/types/claim";
import { formatMoney } from "@/lib/format";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return formatMoney("MYR", n);
}

function receiptRowTotal(r: OcrReceiptData) {
  return r.transport + r.accommodation + r.meals + r.others;
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface VerificationScreenProps {
  dbData:               DbEmployee;
  mainCategory:         string;
  /** uploadedFiles intentionally removed — doc preview lives in the Upload stage */
  ocrReceipts:          OcrReceiptData[];
  claimContext:         ClaimContext;
  onClaimContextChange: (ctx: ClaimContext) => void;
  onReceiptsChange:     (receipts: OcrReceiptData[]) => void;
  onBack:               () => void;
  onSubmit:             () => void;
  isSubmitting?:        boolean;
}

// ─── Locked (read-only) field ─────────────────────────────────────────────────

function LockedField({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-surface-muted rounded-control p-3 border border-line relative">
      <p className="text-xs font-medium text-ink-muted font-body mb-0.5">
        {label}
      </p>
      <div className={`text-sm font-body pr-5 truncate ${value ? "text-ink font-semibold" : "text-ink-muted"}`}>
        {value || "Not set"}
      </div>
      <Lock className="w-3 h-3 text-ink-muted absolute top-3 right-3" aria-hidden="true" />
    </div>
  );
}

// ─── Editable amount input ────────────────────────────────────────────────────

interface AmountInputProps {
  label:    string;
  value:    number;
  onChange: (v: number) => void;
  required?: boolean;
}

function AmountInput({ label, value, onChange, required }: AmountInputProps) {
  const showError = required && value === 0;
  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-semibold text-ink-muted font-body">
        {label}
        {required && <span className="text-danger ml-0.5">*</span>}
      </label>
      <div className={`relative flex items-center min-h-11 bg-surface border rounded-control overflow-hidden transition-colors ${
        showError ? "border-danger" : "border-line-strong focus-within:border-accent"
      }`}>
        <span className="pl-3 pr-1 text-sm text-ink-muted font-mono shrink-0">MYR</span>
        <input
          type="number"
          min={0}
          step={0.01}
          value={value === 0 ? "" : value}
          onChange={e => onChange(parseFloat(e.target.value) || 0)}
          placeholder="0.00"
          aria-label={`${label} amount in MYR`}
          className="flex-1 min-w-0 bg-transparent text-sm text-ink font-mono py-2 pr-3 focus:outline-none placeholder:text-ink-muted"
        />
      </div>
      {showError && (
        <p className="text-xs text-danger font-body flex items-center gap-1">
          <AlertCircle className="w-3 h-3" aria-hidden="true" /> Required
        </p>
      )}
    </div>
  );
}

// ─── Per-receipt editable card ────────────────────────────────────────────────

interface ReceiptCardProps {
  receipt:  OcrReceiptData;
  index:    number;
  onChange: (r: OcrReceiptData) => void;
}

function ReceiptCard({ receipt, index, onChange }: ReceiptCardProps) {
  const [open, setOpen] = useState(true);
  const total = receiptRowTotal(receipt);

  function patch<K extends keyof OcrReceiptData>(key: K, val: OcrReceiptData[K]) {
    onChange({ ...receipt, [key]: val });
  }

  return (
    <div className={`rounded-card border ${
      !receipt.success
        ? "border-warning/40 bg-surface"
        : "border-line bg-surface"
    }`}>

      {/* Card header */}
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full min-h-11 flex items-center justify-between px-4 py-3 gap-3 text-left rounded-card hover:bg-surface-muted transition-colors"
      >
        <div className="flex items-center gap-3 min-w-0">
          <span className={`shrink-0 text-xs font-mono ${receipt.success ? "text-ink-muted" : "text-warning"}`}>
            #{index + 1}
          </span>
          <div className="min-w-0">
            <p className="text-sm font-semibold text-ink font-body truncate">
              {receipt.merchant || `Receipt #${index + 1}`}
            </p>
            {receipt.expenseDate && (
              <p className="text-xs text-ink-muted font-mono">{receipt.expenseDate}</p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {!receipt.success && (
            <span className="text-xs font-semibold text-warning bg-warning-soft px-2 py-0.5 rounded-full font-body">
              Manual entry
            </span>
          )}
          <span className="text-sm font-medium text-ink font-mono">{fmt(total)}</span>
          {open
            ? <ChevronUp   className="w-4 h-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
            : <ChevronDown className="w-4 h-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
          }
        </div>
      </button>

      {/* OCR failure warning */}
      {!receipt.success && (
        <div className="mx-4 mb-3 px-3 py-2.5 rounded-control bg-warning-soft flex items-start gap-2">
          <AlertCircle className="w-4 h-4 text-warning shrink-0 mt-0.5" strokeWidth={1.75} aria-hidden="true" />
          <p className="text-xs text-warning font-body leading-relaxed">
            {receipt.lowConfidence
              ? "Low confidence: the receipt may have been misread. Please check each field."
              : "OCR could not read this receipt. Please fill in all fields manually."}
          </p>
        </div>
      )}

      {/* Expanded form */}
      {open && (
        <div className="px-4 pb-4 flex flex-col gap-4">

          {/* Date + Merchant */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-ink-muted font-body">
                Expense Date<span className="text-danger ml-0.5">*</span>
              </label>
              <input
                type="date"
                value={receipt.expenseDate}
                onChange={e => patch("expenseDate", e.target.value)}
                aria-label="Expense date"
                className={`w-full min-h-11 bg-surface border rounded-control px-3 py-2 text-sm text-ink font-body focus:border-accent transition-colors ${
                  !receipt.expenseDate ? "border-danger" : "border-line-strong"
                }`}
              />
              {!receipt.expenseDate && (
                <p className="text-xs text-danger font-body flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" aria-hidden="true" /> Required
                </p>
              )}
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-semibold text-ink-muted font-body">
                Merchant / Description<span className="text-danger ml-0.5">*</span>
              </label>
              <input
                type="text"
                value={receipt.merchant}
                onChange={e => patch("merchant", e.target.value)}
                placeholder="e.g. Grab, Hotel Istana"
                aria-label="Merchant or description"
                className={`w-full min-h-11 bg-surface border rounded-control px-3 py-2 text-sm text-ink font-body focus:border-accent transition-colors placeholder:text-ink-muted ${
                  !receipt.merchant ? "border-danger" : "border-line-strong"
                }`}
              />
              {!receipt.merchant && (
                <p className="text-xs text-danger font-body flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" aria-hidden="true" /> Required
                </p>
              )}
            </div>
          </div>

          {/* Amount grid */}
          <div className="grid grid-cols-2 gap-3">
            <AmountInput label="Transport"     value={receipt.transport}     onChange={v => patch("transport",     v)} />
            <AmountInput label="Accommodation" value={receipt.accommodation} onChange={v => patch("accommodation", v)} />
            <AmountInput label="Meals"         value={receipt.meals}         onChange={v => patch("meals",         v)} />
            <AmountInput label="Others"        value={receipt.others}        onChange={v => patch("others",        v)} />
          </div>

          {/* Notes */}
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-ink-muted font-body">
              Notes <span className="text-ink-muted font-normal">(optional)</span>
            </label>
            <textarea
              value={receipt.notes}
              onChange={e => patch("notes", e.target.value)}
              placeholder="Any additional context for this receipt…"
              rows={2}
              aria-label="Notes"
              className="w-full min-h-11 bg-surface border rounded-control px-3 py-2 text-sm text-ink font-body focus:border-accent transition-colors border-line-strong resize-none placeholder:text-ink-muted"
            />
          </div>

          {/* Row subtotal */}
          <div className="flex items-center justify-end gap-2 pt-3 border-t border-line">
            <span className="text-xs text-ink-muted font-body">Receipt subtotal</span>
            <span className="text-sm font-medium text-ink font-mono">{fmt(total)}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Live A4 HTML Preview ─────────────────────────────────────────────────────

interface A4PreviewProps {
  dbData:       DbEmployee;
  mainCategory: string;
  claimContext: ClaimContext;
  receipts:     OcrReceiptData[];
  subTotal:     number;
}

function A4Preview({ dbData, mainCategory, claimContext, receipts, subTotal }: A4PreviewProps) {
  const blank = (v: string | number) => {
    if (typeof v === "number") return v > 0 ? fmt(v) : "___________";
    return v || "___________";
  };

  const categories = ["Transport", "Accommodation", "Meals", "Others"];

  return (
    <div
      style={{
        width: 794,
        minHeight: 1123,
        background: "var(--color-surface)",
        padding: "48px 56px",
        fontFamily: "'Times New Roman', Georgia, serif",
        fontSize: 12,
        lineHeight: 1.6,
        color: "var(--color-ink)",
        border: "1px solid var(--color-line)",
      }}
    >
      {/* Header */}
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontWeight: 700, fontSize: 15, letterSpacing: 1, textTransform: "uppercase" }}>
          {dbData.entityName}
        </div>
        <div style={{ fontSize: 11, color: "var(--color-ink-muted)", marginTop: 2 }}>Expense Reimbursement</div>
        <div
          style={{
            fontWeight: 700,
            fontSize: 14,
            marginTop: 14,
            paddingBottom: 4,
            borderBottom: "2px solid var(--color-ink)",
            textTransform: "uppercase",
            letterSpacing: 0.5,
          }}
        >
          {mainCategory || "Business Travel Expense Claim"}
        </div>
      </div>

      {/* Identity table */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 20, fontSize: 11 }}>
        <tbody>
          {[
            ["Employee Name", dbData.employeeName],
            ["Employee No.",  dbData.employeeNumber],
            ["Position",      dbData.position],
            ["Department",    dbData.department],
            ["Location",      dbData.location],
          ].map(([label, val]) => (
            <tr key={label}>
              <td style={{ width: "30%", paddingBottom: 4, color: "var(--color-ink-muted)", fontWeight: 600 }}>{label}</td>
              <td style={{ width: "3%",  color: "var(--color-ink-muted)" }}>:</td>
              <td style={{ fontWeight: 500 }}>{val || "___________"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Claim context */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 20, fontSize: 11 }}>
        <tbody>
          {[
            ["Travel Destination", blank(claimContext.travelDestination)],
            ["Travel Purpose",     blank(claimContext.travelPurpose)],
            ["Overseas",          claimContext.overseas ? "Yes" : "No"],
            ["Departure Date",     blank(claimContext.departureDate)],
            ["Arrival Date",      blank(claimContext.arrivalDate)],
          ].map(([label, val]) => (
            <tr key={label}>
              <td style={{ width: "30%", paddingBottom: 4, color: "var(--color-ink-muted)", fontWeight: 600 }}>{label}</td>
              <td style={{ width: "3%",  color: "var(--color-ink-muted)" }}>:</td>
              <td style={{ fontWeight: 500 }}>{val}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Expense table */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: 4, fontSize: 11 }}>
        <thead>
          <tr style={{ borderTop: "1.5px solid var(--color-ink)", borderBottom: "1px solid var(--color-ink-muted)" }}>
            <th style={{ textAlign: "left",  padding: "6px 4px", fontWeight: 700, width: "5%"  }}>#</th>
            <th style={{ textAlign: "left",  padding: "6px 4px", fontWeight: 700, width: "12%" }}>Date</th>
            <th style={{ textAlign: "left",  padding: "6px 4px", fontWeight: 700, width: "22%" }}>Merchant / Description</th>
            {categories.map(c => (
              <th key={c} style={{ textAlign: "right", padding: "6px 4px", fontWeight: 700 }}>{c} (RM)</th>
            ))}
            <th style={{ textAlign: "right", padding: "6px 4px", fontWeight: 700 }}>Total (RM)</th>
          </tr>
        </thead>
        <tbody>
          {receipts.map((r, i) => (
            <tr key={i} style={{ borderBottom: "0.5px solid var(--color-line)" }}>
              <td style={{ padding: "5px 4px" }}>{i + 1}</td>
              {/* An empty value reads "Not set" for text and stays an empty cell for amounts (DESIGN.md: never a dash). */}
              <td style={{ padding: "5px 4px" }}>{r.expenseDate || "Not set"}</td>
              <td style={{ padding: "5px 4px" }}>{r.merchant    || "Not set"}</td>
              <td style={{ textAlign: "right", padding: "5px 4px" }}>{r.transport     > 0 ? r.transport.toFixed(2)     : ""}</td>
              <td style={{ textAlign: "right", padding: "5px 4px" }}>{r.accommodation > 0 ? r.accommodation.toFixed(2) : ""}</td>
              <td style={{ textAlign: "right", padding: "5px 4px" }}>{r.meals         > 0 ? r.meals.toFixed(2)         : ""}</td>
              <td style={{ textAlign: "right", padding: "5px 4px" }}>{r.others        > 0 ? r.others.toFixed(2)        : ""}</td>
              <td style={{ textAlign: "right", padding: "5px 4px", fontWeight: 600 }}>{receiptRowTotal(r).toFixed(2)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: "1.5px solid var(--color-ink)" }}>
            <td colSpan={7} style={{ padding: "6px 4px", fontWeight: 700, textAlign: "right" }}>
              TOTAL SUB-TOTAL
            </td>
            <td style={{ padding: "6px 4px", fontWeight: 700, textAlign: "right" }}>
              {subTotal.toFixed(2)}
            </td>
          </tr>
        </tfoot>
      </table>

      {/* Declaration */}
      <div style={{ marginTop: 32, fontSize: 11, color: "var(--color-ink-muted)", lineHeight: 1.7 }}>
        <strong>Declaration:</strong><br />
        I hereby certify that the expenses listed above were incurred solely for official business purposes
        and conform to the Company&apos;s Reimbursement Policy. All original supporting documents are attached herewith.
      </div>

      {/* Signature */}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 48, fontSize: 11 }}>
        {["Employee Signature", "Approved By"].map(label => (
          <div key={label} style={{ width: "40%", textAlign: "center" }}>
            <div style={{ borderTop: "1px solid var(--color-ink-muted)", paddingTop: 6 }}>{label}</div>
            <div style={{ marginTop: 4, color: "var(--color-ink-muted)" }}>
              {label === "Employee Signature" ? dbData.employeeName : ""}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function VerificationScreen({
  dbData,
  mainCategory,
  ocrReceipts,
  claimContext,
  onClaimContextChange,
  onReceiptsChange,
  onBack,
  onSubmit,
  isSubmitting = false,
}: VerificationScreenProps) {
  const [activeTab,    setActiveTab]    = useState<"form" | "preview">("form");
  const [identityOpen, setIdentityOpen] = useState(true);
  const [previewZoom,  setPreviewZoom]  = useState(1);

  // Computed sub-total
  const subTotal = useMemo(
    () => ocrReceipts.reduce((acc, r) => acc + receiptRowTotal(r), 0),
    [ocrReceipts],
  );

  // Validation
  const contextValid =
    claimContext.travelDestination.trim() !== "" &&
    claimContext.departureDate             !== "" &&
    claimContext.arrivalDate               !== "";

  const receiptsValid = ocrReceipts.every(r => r.expenseDate !== "" && r.merchant !== "");
  const canSubmit     = contextValid && receiptsValid;

  function handleReceiptChange(idx: number, updated: OcrReceiptData) {
    const next = [...ocrReceipts];
    next[idx] = updated;
    onReceiptsChange(next);
  }

  function patchContext<K extends keyof ClaimContext>(key: K, val: ClaimContext[K]) {
    onClaimContextChange({ ...claimContext, [key]: val });
  }

  // ── Form panel (left column) ────────────────────────────────────────────────

  const formPanel = (
    <div className="h-full min-h-0 w-full lg:w-[480px] shrink-0 flex flex-col gap-5 overflow-y-auto
      [&::-webkit-scrollbar]:w-1.5
      [&::-webkit-scrollbar-track]:bg-transparent
      [&::-webkit-scrollbar-thumb]:bg-line/30
      [&::-webkit-scrollbar-thumb]:rounded-full
      pb-4">

      {/* Back button (desktop only — mobile has it in the header) */}
      <button
        onClick={onBack}
        type="button"
        className="hidden lg:flex min-h-11 items-center gap-1.5 self-start text-ink text-sm font-semibold font-body pl-2 pr-4 rounded-control hover:bg-surface-muted transition-colors"
      >
        <ChevronLeft className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
        Back to Upload
      </button>

      {/* Section 1: Identity Block */}
      <div className="shrink-0 bg-surface rounded-card shadow-ambient overflow-hidden">
        <button
          type="button"
          onClick={() => setIdentityOpen(o => !o)}
          aria-expanded={identityOpen}
          className="w-full min-h-11 flex items-center justify-between px-5 py-3.5 text-left hover:bg-surface-muted transition-colors"
        >
          <div className="flex items-center gap-2.5">
            <span className="text-sm font-semibold text-ink font-display">Employee identity</span>
            <span className="text-xs text-ink-muted font-body">Read-only</span>
          </div>
          {identityOpen
            ? <ChevronUp   className="w-4 h-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
            : <ChevronDown className="w-4 h-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
          }
        </button>
        {identityOpen && (
          <div className="px-5 pb-5 grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <LockedField label="Entity Name"   value={dbData.entityName}     />
            <LockedField label="Employee Name" value={dbData.employeeName}   />
            <LockedField label="Employee No."  value={dbData.employeeNumber} />
            <LockedField label="Position"      value={dbData.position}       />
            <LockedField label="Location"      value={dbData.location}       />
            <LockedField label="Department"    value={dbData.department}     />
          </div>
        )}
      </div>

      {/* Section 2: Claim Context */}
      <div className="shrink-0 bg-surface rounded-card shadow-ambient p-5 flex flex-col gap-4">
        <div>
          <h3 className="text-sm font-semibold text-ink font-display">Claim context</h3>
          <p className="text-xs text-ink-muted font-body mt-0.5">Trip details for this expense report.</p>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-ink-muted font-body">
            Travel Destination<span className="text-danger ml-0.5">*</span>
          </label>
          <input
            type="text"
            value={claimContext.travelDestination}
            onChange={e => patchContext("travelDestination", e.target.value)}
            placeholder="e.g. Kuching, Sarawak"
            aria-label="Travel destination"
            className="w-full min-h-11 bg-surface border rounded-control px-3 py-2 text-sm text-ink font-body focus:border-accent transition-colors border-line-strong placeholder:text-ink-muted"
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-semibold text-ink-muted font-body">
            Travel Purpose
          </label>
          <textarea
            value={claimContext.travelPurpose}
            onChange={e => patchContext("travelPurpose", e.target.value)}
            placeholder="Briefly describe the business purpose of this trip…"
            rows={2}
            aria-label="Travel purpose"
            className="w-full min-h-11 bg-surface border rounded-control px-3 py-2 text-sm text-ink font-body focus:border-accent transition-colors border-line-strong resize-none placeholder:text-ink-muted"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-ink-muted font-body">
              Departure Date<span className="text-danger ml-0.5">*</span>
            </label>
            <input
              type="date"
              value={claimContext.departureDate}
              onChange={e => patchContext("departureDate", e.target.value)}
              aria-label="Departure date"
              className="w-full min-h-11 bg-surface border rounded-control px-3 py-2 text-sm text-ink font-body focus:border-accent transition-colors border-line-strong"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs font-semibold text-ink-muted font-body">
              Arrival Date<span className="text-danger ml-0.5">*</span>
            </label>
            <input
              type="date"
              value={claimContext.arrivalDate}
              min={claimContext.departureDate}
              onChange={e => patchContext("arrivalDate", e.target.value)}
              aria-label="Arrival date"
              className="w-full min-h-11 bg-surface border rounded-control px-3 py-2 text-sm text-ink font-body focus:border-accent transition-colors border-line-strong"
            />
          </div>
        </div>

        {/* Overseas toggle */}
        <button
          type="button"
          role="switch"
          aria-checked={claimContext.overseas}
          onClick={() => patchContext("overseas", !claimContext.overseas)}
          className="flex min-h-11 w-full items-center justify-between py-2 px-3 bg-surface-muted rounded-control text-left hover:bg-line transition-colors"
        >
          <span className="text-sm font-medium text-ink font-body">Overseas travel</span>
          <span aria-hidden="true" className={`relative w-11 h-6 rounded-full border transition-colors duration-150 ${
            claimContext.overseas ? "bg-ink border-ink" : "bg-surface border-line-strong"
          }`}>
            <span className={`absolute top-0.5 left-0.5 w-[18px] h-[18px] rounded-full transition-transform duration-150 ${
              claimContext.overseas ? "translate-x-5 bg-surface" : "translate-x-0 bg-line-strong"
            }`} />
          </span>
        </button>
      </div>

      {/* Section 3: Financial Breakdown */}
      <div className="shrink-0 flex flex-col gap-3">
        <div>
          <h3 className="text-sm font-semibold text-ink font-display">Financial breakdown</h3>
          <p className="text-xs text-ink-muted font-body mt-0.5">
            Check and correct what was read from each receipt.
          </p>
        </div>
        {ocrReceipts.map((r, i) => (
          <ReceiptCard
            key={i}
            receipt={r}
            index={i}
            onChange={updated => handleReceiptChange(i, updated)}
          />
        ))}
      </div>

      {/* Section 4: Summary & Action */}
      <div className="shrink-0 bg-surface rounded-card shadow-ambient p-5">
        <div className="flex items-baseline justify-between mb-5">
          <span className="text-sm font-semibold text-ink font-display">Sub-total</span>
          <span className="text-xl font-medium text-ink font-mono">{fmt(subTotal)}</span>
        </div>
        {!canSubmit && (
          <div className="mb-4 px-3 py-2.5 rounded-control bg-warning-soft flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-warning shrink-0" strokeWidth={1.75} aria-hidden="true" />
            <p className="text-xs text-warning font-body">
              {!contextValid
                ? "Please complete the Claim Context section."
                : "Please fill in all required receipt fields."}
            </p>
          </div>
        )}
        <button
          id="submit-claim-btn"
          disabled={!canSubmit || isSubmitting}
          onClick={onSubmit}
          className={`w-full min-h-11 rounded-full font-semibold text-sm font-body transition-colors duration-150 flex items-center justify-center gap-2 ${
            canSubmit && !isSubmitting
              ? "bg-accent text-on-accent hover:bg-accent-hover"
              : "bg-surface-muted text-ink-muted"
          }`}
        >
          {isSubmitting && <Loader2 className="w-4 h-4 animate-spin motion-reduce:animate-none" strokeWidth={2} aria-hidden="true" />}
          {isSubmitting ? "Submitting…" : "Submit Claim"}
        </button>
      </div>
    </div>
  );

  // ── A4 preview panel (right column) ────────────────────────────────────────

  // Measure the scroll container to compute an auto-fit base scale for the
  // rigid 794px A4 canvas. User zoom (previewZoom) multiplies on top.
  const A4_WIDTH                          = 794;
  const scrollContainerRef               = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(794);

  useEffect(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect.width;
      if (w) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // baseScale auto-fits the 794px doc into the available container width
  // (with 32px total side padding so it doesn't hug the edges)
  const baseScale   = Math.min(1, (containerWidth - 32) / A4_WIDTH);
  const totalScale  = +(baseScale * previewZoom).toFixed(3);

  const previewPanel = (
    <div className="flex-1 bg-surface-muted rounded-card shadow-ambient flex flex-col overflow-hidden min-h-[500px] lg:min-h-0">
      {/* Preview toolbar */}
      <div className="pl-4 pr-1 py-1 border-b border-line bg-surface shrink-0 flex items-center justify-between">
        <p className="text-sm font-semibold text-ink font-body">
          Document preview
        </p>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setPreviewZoom(z => Math.max(0.4, +(z - 0.2).toFixed(1)))}
            aria-label="Zoom out preview"
            className="w-11 h-11 rounded-control flex items-center justify-center text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
          >
            <ZoomOut className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <span className="hidden sm:inline text-xs text-ink-muted w-10 text-center font-mono">
            {Math.round(previewZoom * 100)}%
          </span>
          <button
            type="button"
            onClick={() => setPreviewZoom(z => Math.min(2.5, +(z + 0.2).toFixed(1)))}
            aria-label="Zoom in preview"
            className="w-11 h-11 rounded-control flex items-center justify-center text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
          >
            <ZoomIn className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
          <button
            type="button"
            onClick={() => setPreviewZoom(1)}
            aria-label="Reset preview zoom"
            className="hidden sm:flex w-11 h-11 rounded-control items-center justify-center text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
          >
            <Maximize2 className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
          </button>
        </div>
      </div>
      {/*
        Outer scroll container: overflow:auto for panning when zoomed > 1.
        ref is used by ResizeObserver to compute the container width.
      */}
      <div
        ref={scrollContainerRef}
        className="flex-1 overflow-auto
          [&::-webkit-scrollbar]:w-1.5
          [&::-webkit-scrollbar-track]:bg-transparent
          [&::-webkit-scrollbar-thumb]:bg-line/30
          [&::-webkit-scrollbar-thumb]:rounded-full"
        style={{ touchAction: "pinch-zoom" }}
      >
        {/*
          Centering row: when the scaled doc is narrower than the container
          (zoomed out), margin:auto centres it. When wider (zoomed in),
          overflow:auto on the parent produces the correct scrollbars.
        */}
        <div style={{ display: "flex", justifyContent: "center", padding: "16px" }}>
          {/*
            Dynamic bounding box: physically sized to the scaled dimensions so
            overflow:auto sees the true footprint and generates accurate scrollbars.
            transform-origin: top left paired with this approach eliminates clipping.
          */}
          <div
            style={{
              width:     A4_WIDTH * totalScale,
              minHeight: 1123    * totalScale,
              flexShrink: 0,
            }}
          >
            <div
              style={{
                width:           A4_WIDTH,
                transformOrigin: "top left",
                transform:       `scale(${totalScale})`,
              }}
            >
              <A4Preview
                dbData={dbData}
                mainCategory={mainCategory}
                claimContext={claimContext}
                receipts={ocrReceipts}
                subTotal={subTotal}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );

  // ── Render ──────────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Desktop ≥ lg: strict 2-column (form left | A4 preview right) ─── */}
      <div
        className="hidden lg:flex gap-5 items-stretch w-full"
        style={{ height: "calc(100vh - 140px)" }}
      >
        {formPanel}
        {previewPanel}
      </div>

      {/* ── Mobile / Tablet < lg: Back button + tab switcher ────────────── */}
      <div className="flex lg:hidden flex-col gap-4 w-full">

        {/* Back button */}
        <button
          onClick={onBack}
          type="button"
          className="flex min-h-11 items-center gap-1.5 self-start text-ink text-sm font-semibold font-body pl-2 pr-4 rounded-control hover:bg-surface-muted transition-colors"
        >
          <ChevronLeft className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
          Back to Upload
        </button>

        {/* Tab bar */}
        <div role="tablist" aria-label="Review view" className="flex bg-surface-muted rounded-control p-1 gap-1">
          <button
            type="button"
            id="tab-form"
            role="tab"
            aria-selected={activeTab === "form"}
            onClick={() => setActiveTab("form")}
            className={`flex-1 min-h-11 flex items-center justify-center gap-2 rounded-control text-sm font-semibold font-body transition-colors duration-150 ${
              activeTab === "form"
                ? "bg-surface text-ink border border-line"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <ClipboardList className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            Form details
          </button>
          <button
            type="button"
            id="tab-preview"
            role="tab"
            aria-selected={activeTab === "preview"}
            onClick={() => setActiveTab("preview")}
            className={`flex-1 min-h-11 flex items-center justify-center gap-2 rounded-control text-sm font-semibold font-body transition-colors duration-150 ${
              activeTab === "preview"
                ? "bg-surface text-ink border border-line"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            <Eye className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
            Preview
          </button>
        </div>

        {/* Tab content */}
        {activeTab === "form" && formPanel}
        {activeTab === "preview" && <div className="min-h-[600px]">{previewPanel}</div>}
      </div>
    </>
  );
}
