"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { ArrowRight, BriefcaseBusiness, CheckCircle2, Clock, Loader2, AlertCircle } from "lucide-react";
import { createVendorBooking, getVendors } from "@/lib/actions/bookings";
import { getPolicies } from "@/lib/actions/policies";
import type { ReimbursementRaw, VendorOption } from "@/lib/api/types";
import { formatClaimRef, formatMoney } from "@/lib/format";
import { bookingResultCopy, isBookingPending } from "./_lib/resultCopy";

const NEW_VENDOR = "__new__";
const DEFAULT_CATEGORIES = ["Accommodations", "Equipment", "Meals", "Transportation", "Other"];

export default function BookVendorPage() {
  const [vendors, setVendors] = useState<VendorOption[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [vendorId, setVendorId] = useState("");
  const [newVendorName, setNewVendorName] = useState("");
  const [category, setCategory] = useState("");
  const [amount, setAmount] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [purpose, setPurpose] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ReimbursementRaw | null>(null);

  useEffect(() => {
    getVendors().then(setVendors);
    getPolicies()
      .then((policies) => {
        const names = new Set<string>(DEFAULT_CATEGORIES);
        for (const policy of policies) {
          if (policy.status !== "ACTIVE") continue;
          for (const name of policy.reimbursable_categories ?? []) names.add(name);
        }
        setCategories([...names].sort());
      })
      .catch(() => setCategories(DEFAULT_CATEGORIES));
  }, []);

  const chosenVendor = useMemo(
    () => vendors.find((vendor) => vendor.vendor_id === vendorId),
    [vendorId, vendors],
  );

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (!vendorId) return setError("Choose a vendor.");
    if (vendorId === NEW_VENDOR && !newVendorName.trim()) return setError("Enter the vendor name.");
    if (!category) return setError("Choose a category.");
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) return setError("Enter an amount above zero.");
    if (!start || !end) return setError("Choose the service dates.");
    if (end < start) return setError("The end date cannot be before the start date.");
    if (purpose.trim().length < 2) return setError("Describe what the booking is for.");

    setSubmitting(true);
    const { data, error: apiError } = await createVendorBooking({
      vendor_id: vendorId === NEW_VENDOR ? undefined : vendorId,
      vendor_name: vendorId === NEW_VENDOR ? newVendorName.trim() : undefined,
      category,
      amount: parsed,
      service_start: start,
      service_end: end,
      purpose: purpose.trim(),
    });
    setSubmitting(false);
    if (apiError || !data) {
      setError(apiError ?? "The booking could not be created.");
      return;
    }
    setResult(data);
    setAmount("");
    setPurpose("");
    setStart("");
    setEnd("");
    setNewVendorName("");
  }

  if (result) {
    const copy = bookingResultCopy(result.status);
    return (
      <div className="px-4 py-6 md:p-10 max-w-2xl">
        <div className="bg-surface shadow-ambient rounded-card p-6 md:p-8">
          <span className={`inline-flex items-center gap-2 rounded-full px-3 py-1 text-xs font-semibold ${copy.tone}`}>
            {isBookingPending(result.status)
              ? <Clock className="h-3.5 w-3.5" aria-hidden />
              : result.status === "DISBURSEMENT_FAILED"
                ? <AlertCircle className="h-3.5 w-3.5" aria-hidden />
                : <CheckCircle2 className="h-3.5 w-3.5" aria-hidden />}
            {copy.title}
          </span>
          <h1 className="font-display text-2xl font-semibold text-ink mt-4">Vendor booking created</h1>
          <p className="font-body text-sm text-ink-muted mt-2">{copy.body}</p>
          <dl className="grid grid-cols-2 gap-4 mt-6 text-sm">
            <div>
              <dt className="text-ink-muted text-xs">Reference</dt>
              <dd className="font-mono text-ink mt-0.5">{formatClaimRef(result.reim_id)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted text-xs">Vendor</dt>
              <dd className="text-ink mt-0.5">{result.vendor_name ?? "Not set"}</dd>
            </div>
            <div>
              <dt className="text-ink-muted text-xs">Amount</dt>
              <dd className="font-mono text-ink mt-0.5">{formatMoney(result.currency ?? "MYR", result.total_claimed_amount ?? 0)}</dd>
            </div>
            <div>
              <dt className="text-ink-muted text-xs">Dates</dt>
              <dd className="text-ink mt-0.5">
                {result.service_start ?? "Not set"} to {result.service_end ?? "Not set"}
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-3 mt-8">
            <Link
              href={`/employee/history?id=${result.reim_id}`}
              className="inline-flex min-h-11 items-center gap-2 rounded-full bg-accent px-5 py-2.5 font-body text-sm font-semibold text-on-accent hover:bg-accent-hover"
            >
              View booking
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="inline-flex min-h-11 items-center rounded-full border border-line-strong px-5 py-2.5 font-body text-sm font-semibold text-ink hover:bg-surface-muted"
            >
              Book another vendor
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 md:p-10 max-w-2xl">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-accent-soft text-accent">
          <BriefcaseBusiness className="h-5 w-5" aria-hidden />
        </span>
        <div>
          <h1 className="font-display text-2xl font-semibold text-ink">Book a vendor</h1>
          <p className="font-body text-sm text-ink-muted">
            The company pays the vendor directly. You never front the money.
          </p>
        </div>
      </div>

      <form onSubmit={submit} className="mt-6 bg-surface shadow-ambient rounded-card p-5 md:p-7 flex flex-col gap-5">
        <label className="flex flex-col gap-1.5">
          <span className="font-body text-sm font-semibold text-ink">Vendor</span>
          <select
            value={vendorId}
            onChange={(event) => setVendorId(event.target.value)}
            className="min-h-11 rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink"
          >
            <option value="">Choose a vendor</option>
            {vendors.map((vendor) => (
              <option key={vendor.vendor_id} value={vendor.vendor_id}>
                {vendor.name}
              </option>
            ))}
            <option value={NEW_VENDOR}>Add a new vendor</option>
          </select>
          {chosenVendor && !chosenVendor.paypal_ready && (
            <span className="font-body text-xs text-ink-muted">
              This vendor is new to Reclaim Pay. HR will check the payout account first.
            </span>
          )}
        </label>

        {vendorId === NEW_VENDOR && (
          <label className="flex flex-col gap-1.5">
            <span className="font-body text-sm font-semibold text-ink">New vendor name</span>
            <input
              value={newVendorName}
              onChange={(event) => setNewVendorName(event.target.value)}
              maxLength={200}
              placeholder="e.g. Hotel Seri Kenanga"
              className="min-h-11 rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink"
            />
            <span className="font-body text-xs text-ink-muted">
              A new vendor always needs HR approval before any payment.
            </span>
          </label>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <label className="flex flex-col gap-1.5">
            <span className="font-body text-sm font-semibold text-ink">Amount (MYR)</span>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              placeholder="0.00"
              className="min-h-11 rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-body text-sm font-semibold text-ink">Category</span>
            <select
              value={category}
              onChange={(event) => setCategory(event.target.value)}
              className="min-h-11 rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink"
            >
              <option value="">Choose a category</option>
              {categories.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-body text-sm font-semibold text-ink">Service start</span>
            <input
              type="date"
              value={start}
              onChange={(event) => setStart(event.target.value)}
              className="min-h-11 rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="font-body text-sm font-semibold text-ink">Service end</span>
            <input
              type="date"
              value={end}
              onChange={(event) => setEnd(event.target.value)}
              className="min-h-11 rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink"
            />
          </label>
        </div>

        <label className="flex flex-col gap-1.5">
          <span className="font-body text-sm font-semibold text-ink">Purpose</span>
          <textarea
            value={purpose}
            onChange={(event) => setPurpose(event.target.value)}
            rows={3}
            maxLength={1000}
            placeholder="Client visit, regional meeting, team offsite"
            className="rounded-control border border-line-strong bg-surface px-3 py-2 font-body text-sm text-ink"
          />
        </label>

        {error && (
          <p role="alert" className="rounded-control bg-danger-soft px-3 py-2 font-body text-sm text-danger">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={submitting}
          className="inline-flex min-h-11 items-center justify-center gap-2 rounded-full bg-accent px-5 py-2.5 font-body text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
        >
          {submitting && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
          {submitting ? "Creating booking" : "Create booking"}
        </button>
      </form>
    </div>
  );
}
