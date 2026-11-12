"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CheckCircle2, Loader2 } from "lucide-react";

import { getMyContract } from "@/lib/actions/contracts";
import { submitContractorInvoice } from "@/lib/actions/invoices";
import type { ReimbursementRaw } from "@/lib/api/types";
import { formatRate, type ContractRecord } from "@/lib/contracts";
import { formatClaimRef, formatMoney } from "@/lib/format";
import {
  QUANTITY_UNIT_LABEL,
  invoiceErrorCopy,
  invoicePeriodLabel,
  invoiceTotal,
} from "@/lib/invoices";

type Unit = keyof typeof QUANTITY_UNIT_LABEL;

const FIELD =
  "min-h-11 w-full rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink focus:border-accent focus:outline-none";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export default function InvoiceForm() {
  const [contract, setContract] = useState<ContractRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [description, setDescription] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [unitPrice, setUnitPrice] = useState("");
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState<ReimbursementRaw | null>(null);

  useEffect(() => {
    getMyContract().then((row) => {
      setContract(row);
      if (row) setUnitPrice(String(row.rate_amount));
      setPeriodEnd((current) => current || todayIso());
      setLoaded(true);
    });
  }, []);

  const quantityNumber = Number(quantity);
  const unitPriceNumber = Number(unitPrice);
  const total = useMemo(
    () => invoiceTotal(quantityNumber, unitPriceNumber),
    [quantityNumber, unitPriceNumber],
  );
  const aboveContractRate =
    contract !== null && total !== null && unitPriceNumber > contract.rate_amount;

  function reset() {
    setPeriodStart("");
    setPeriodEnd(todayIso());
    setDescription("");
    setQuantity("1");
    setUnitPrice(contract ? String(contract.rate_amount) : "");
    setNote("");
    setError(null);
    setSubmitted(null);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!contract || total === null) return;
    if (!periodStart || !periodEnd) {
      setError("Choose the start and end of the period this invoice covers.");
      return;
    }
    if (periodEnd < periodStart) {
      setError("The period end cannot be before its start.");
      return;
    }
    if (!description.trim()) {
      setError("Describe the work this invoice covers.");
      return;
    }

    setSubmitting(true);
    setError(null);
    const result = await submitContractorInvoice({
      period_start: periodStart,
      period_end: periodEnd,
      description: description.trim(),
      quantity: quantityNumber,
      unit_price: unitPriceNumber,
      claimed_amount: total,
      note: note.trim() || undefined,
    });
    setSubmitting(false);
    if (result.error) {
      setError(invoiceErrorCopy(result.error));
      return;
    }
    setSubmitted(result.invoice);
  }

  if (!loaded) {
    return (
      <div className="flex min-h-[240px] items-center justify-center rounded-card bg-surface shadow-ambient">
        <Loader2 className="h-6 w-6 animate-spin text-accent" aria-hidden="true" />
        <span className="sr-only">Loading your contract</span>
      </div>
    );
  }

  if (!contract) {
    return (
      <section className="rounded-card bg-surface p-5 shadow-ambient">
        <h2 className="font-display text-lg font-semibold text-ink">Invoices need a contract</h2>
        <p className="mt-1 font-body text-sm text-ink-muted">
          Ask HR to add an active contract before you submit an invoice.
        </p>
      </section>
    );
  }

  if (submitted) {
    const reviewed = submitted.status === "REVIEW" || submitted.status === "PENDING";
    return (
      <section className="rounded-card bg-surface p-5 shadow-ambient sm:p-6">
        <div className="flex items-start gap-3">
          <CheckCircle2 className="mt-0.5 h-6 w-6 shrink-0 text-success" aria-hidden="true" />
          <div>
            <h2 className="font-display text-lg font-semibold text-ink">Invoice submitted</h2>
            <p className="mt-1 font-body text-sm text-ink-muted">
              {formatClaimRef(submitted.reim_id)} · {formatMoney(submitted.currency, submitted.total_claimed_amount ?? 0)}
              {" · "}
              {invoicePeriodLabel(submitted.invoice_period_start, submitted.invoice_period_end)}
            </p>
            <p className="mt-2 font-body text-sm text-ink">
              {reviewed
                ? "HR will review this invoice. You will get a notification when it is decided."
                : "This invoice was approved and is on its way through the normal payout path."}
            </p>
          </div>
        </div>
        <div className="mt-5 flex flex-col gap-2 sm:flex-row">
          <Link
            href={`/employee/history?claimId=${submitted.reim_id}`}
            className="inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2.5 font-body text-sm font-semibold text-on-accent hover:bg-accent-hover"
          >
            View in history
          </Link>
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-11 items-center justify-center rounded-control border border-line-strong px-5 py-2.5 font-body text-sm font-semibold text-ink hover:bg-surface-muted"
          >
            Submit another invoice
          </button>
        </div>
      </section>
    );
  }

  const unit = contract.rate_unit as Unit;

  return (
    <form onSubmit={handleSubmit} className="rounded-card bg-surface p-5 shadow-ambient sm:p-6">
      <div className="flex flex-col gap-1">
        <h2 className="font-display text-lg font-semibold text-ink">Invoice details</h2>
        <p className="font-body text-sm text-ink-muted">
          Your contract rate is {formatRate(contract.currency, contract.rate_amount, contract.rate_unit)}.
          Invoices use the {contract.service_category} category and are paid in {contract.currency}.
        </p>
      </div>

      <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invoice-period-start" className="font-body text-sm font-medium text-ink">
            Period start
          </label>
          <input
            id="invoice-period-start"
            type="date"
            required
            value={periodStart}
            onChange={(event) => setPeriodStart(event.target.value)}
            className={FIELD}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invoice-period-end" className="font-body text-sm font-medium text-ink">
            Period end
          </label>
          <input
            id="invoice-period-end"
            type="date"
            required
            value={periodEnd}
            onChange={(event) => setPeriodEnd(event.target.value)}
            className={FIELD}
          />
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="invoice-description" className="font-body text-sm font-medium text-ink">
            Description
          </label>
          <input
            id="invoice-description"
            type="text"
            required
            maxLength={200}
            placeholder="Work covered by this invoice"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            className={FIELD}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invoice-quantity" className="font-body text-sm font-medium text-ink">
            Quantity ({QUANTITY_UNIT_LABEL[unit]})
          </label>
          <input
            id="invoice-quantity"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            required
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
            className={FIELD}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="invoice-unit-price" className="font-body text-sm font-medium text-ink">
            Unit price ({contract.currency})
          </label>
          <input
            id="invoice-unit-price"
            type="number"
            inputMode="decimal"
            min="0.01"
            step="0.01"
            required
            value={unitPrice}
            onChange={(event) => setUnitPrice(event.target.value)}
            className={FIELD}
          />
          <p className="font-body text-xs text-ink-muted">
            The contract rate is {formatMoney(contract.currency, contract.rate_amount)}.
          </p>
        </div>
        <div className="flex flex-col gap-1.5 sm:col-span-2">
          <label htmlFor="invoice-note" className="font-body text-sm font-medium text-ink">
            Note (optional)
          </label>
          <textarea
            id="invoice-note"
            rows={3}
            maxLength={500}
            placeholder="Anything HR should know"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="w-full rounded-control border border-line-strong bg-surface px-3 py-2 font-body text-sm text-ink focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 rounded-control bg-surface-muted px-4 py-3">
        <span className="font-body text-sm text-ink-muted">Claimed amount</span>
        <span className="font-mono text-lg font-semibold text-ink">
          {total === null ? "Not set" : formatMoney(contract.currency, total)}
        </span>
      </div>
      <p className="mt-1.5 font-body text-xs text-ink-muted">
        Quantity times unit price sets the claimed amount.
      </p>

      {aboveContractRate && (
        <p className="mt-3 rounded-control bg-warning-soft px-3 py-2 font-body text-sm text-warning">
          This is above your contract rate, so HR will review the invoice before it is paid.
        </p>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-control bg-danger-soft px-3 py-2 font-body text-sm text-danger">
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={submitting || total === null}
        className="mt-5 inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-full bg-accent px-6 py-2.5 font-body text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:bg-surface-muted disabled:text-ink-muted sm:w-auto"
      >
        {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {submitting ? "Submitting" : "Submit invoice"}
      </button>
    </form>
  );
}
