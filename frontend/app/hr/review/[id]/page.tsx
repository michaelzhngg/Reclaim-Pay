"use client";
import { useParams, useRouter } from "next/navigation";
import { useState, useEffect, useRef } from "react";

import { ArrowLeft, AlertTriangle, Clock, ShieldCheck, ShieldX, ChevronDown, ZoomIn, Pencil, FileText, ExternalLink, Download, X, Loader2, Send, CheckCircle2 } from "lucide-react";
import type { ClaimBundle } from "@/lib/api/types";
import { formatClaimRef, formatMoney } from "@/lib/format";
import { MOCK_BUNDLES } from "../../hr_components/mockData";
import { SuccessModal, isAwaitingSecondApproval } from "../../hr_components/SuccessModal";
import { useAuth } from "@/context/AuthContext";
import { getHRClaimBundle, updateReimbursementStatus } from "@/lib/actions/hr";
import { FIXTURES_ON } from "@/lib/api/fixtures";
import type { ReimbursementRaw } from "@/lib/api/types";
import { approvalErrorMessage, approveBlockedReason } from "@/lib/hr/evidence";
import { verdictLabel } from "@/components/hr-grid/rows";
import { FIXTURE_HR_USER_ID } from "@/src/mocks/triageFixtures";
import { AutonomyPanel } from "./_components/AutonomyPanel";


type Decision = "approve_full" | "approve_adjusted" | "reject" | null;

const STATUS_CHIP: Record<string, string> = {
  APPROVED: "bg-success-soft text-success",
  REJECTED: "bg-danger-soft text-danger",
  PARTIAL_APPROVE: "bg-warning-soft text-warning",
  PENDING: "bg-surface-muted text-ink-muted",
};
const CAT: Record<string, string> = { meals: "Meals", transportation: "Transport", accommodation: "Stay", others: "Others" };
const fmt = (n: number | undefined | null) => formatMoney("MYR", n ?? 0);
/** Label/value pairs with empty values dropped, so the page never shows a label with nothing under it. */
function presentFields(pairs: Array<[string, string | null | undefined]>): Array<[string, string]> {
  return pairs.filter((p): p is [string, string] => typeof p[1] === "string" && p[1].trim() !== "");
}

function identityFieldsOf(bundle: ClaimBundle) {
  return presentFields([
    ["Entity", bundle.employee.entity],
    ["Employee Name", bundle.employee.name],
    ["Employee No.", bundle.employee.employee_no],
    ["Position", bundle.employee.position],
    ["Department", bundle.employee.department],
    ["Location", bundle.employee.location],
  ]);
}

function contextFieldsOf(bundle: ClaimBundle) {
  return presentFields([
    ["Destination", bundle.travel_destination],
    ["Purpose", bundle.travel_purpose],
    ["Departure", bundle.departure_date],
    ["Arrival", bundle.arrival_date],
    // Overseas is not recorded yet, so only a real "Yes" is shown.
    ["Overseas Travel", bundle.is_overseas ? "Yes" : null],
  ]);
}


function Card({ title, children, right }: { title: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="bg-surface shadow-ambient rounded-card overflow-hidden">
      <div className="px-4 sm:px-6 py-3 min-h-[56px] border-b border-line flex items-center justify-between gap-3">
        <h3 className="font-display font-semibold text-base text-ink">{title}</h3>
        {right}
      </div>
      {children}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-ink-muted mb-0.5">{label}</p>
      <p className="text-sm font-medium text-ink">{value}</p>
    </div>
  );
}

function ClaimFormModal({
  bundle,
  onClose,
}: {
  bundle: ClaimBundle;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const totalRequested = bundle?.totals?.total_requested || 0;
  const totalApproved = bundle?.totals?.net_approved || 0;
  const totalDeducted = bundle?.totals?.total_deduction || 0;
  const effectiveStatus = (bundle?.overall_judgment || "").replace("_", " ");

  const statusChip: Record<string, string> = {
    APPROVED:             "bg-success-soft text-success",
    PARTIAL_APPROVE: "bg-warning-soft text-warning",
    REJECTED:             "bg-danger-soft text-danger",
    PENDING:              "bg-surface-muted text-ink-muted",
  };
  const statusClass = statusChip[bundle.overall_judgment] || "bg-surface-muted text-ink-muted";

  return (
    <div
      className="fixed inset-0 z-[100] bg-ink/90 overflow-auto"
      role="dialog"
      aria-modal="true"
      aria-label="Official claim form"
      onClick={onClose}
    >
      <style>{`
        .a4-modal-zoom { zoom: 1; }
        @media (max-width: 850px) {
          .a4-modal-zoom { zoom: calc((100vw - 32px) / 794); }
        }
      `}</style>

      {/* High-visibility fixed close button */}
      <button
        type="button"
        autoFocus
        onClick={onClose}
        className="fixed top-4 right-4 md:top-8 md:right-8 z-[200] inline-flex items-center justify-center w-12 h-12 bg-surface text-ink rounded-control border border-line hover:bg-surface-muted transition-colors cursor-pointer"
        aria-label="Close preview"
      >
        <X className="w-5 h-5 md:w-6 md:h-6" />
      </button>

      {/* Scrollable canvas region */}
      <div className="min-h-full w-full flex justify-center p-4 md:p-12 pb-24 touch-pan-x touch-pan-y">
        {/* A4 Physical Paper */}
        <div
          className="a4-modal-zoom bg-white rounded-sm shrink-0 border border-line"
          style={{ width: "794px", minHeight: "1123px", fontFamily: "sans-serif" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="p-12 md:p-16 text-ink" style={{ fontSize: "12px" }}>
            {/* Letterhead */}
          <div className="flex items-start justify-between border-b-2 border-ink pb-6 mb-8">
            <div>
              <div className="flex items-center gap-2 mb-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src="/images/logo.svg" alt="" className="w-8 h-8" />
                <span className="font-display font-semibold text-xl text-ink">Reclaim Pay</span>
              </div>
              <p className="text-ink-muted text-xs">Automated Reimbursement Management System</p>
            </div>
            <div className="text-right">
              <p className="font-bold text-base text-ink">EXPENSE CLAIM FORM</p>
              <p className="text-ink-muted font-mono text-xs">{formatClaimRef(bundle.id)}</p>
              <p className="text-ink-muted text-xs mt-1">Date: {new Date(bundle.submitted_at).toLocaleDateString()}</p>
              <span className={`inline-block mt-1 px-2 py-0.5 rounded text-xs font-semibold ${statusClass}`}>
                {effectiveStatus}
              </span>
            </div>
          </div>

          {/* Employee Details */}
          <section className="mb-8">
            <h3 className="font-bold text-xs text-ink-muted mb-3 border-b border-line pb-1">
              Employee Information
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2">
              {presentFields([
                ["Full Name",   bundle.employee.name],
                ["Employee ID", bundle.employee.employee_no],
                ["Department",  bundle.employee.department],
                ["Position",    bundle.employee.position],
              ]).map(([label, value]) => (
                <div key={label} className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">{label}:</span>
                  <span className="font-semibold text-ink">{value}</span>
                </div>
              ))}
            </div>
          </section>

          {/* Claim Context */}
          <section className="mb-8">
            <h3 className="font-bold text-xs text-ink-muted mb-3 border-b border-line pb-1">
              Claim Context
            </h3>
            <div className="grid grid-cols-2 gap-x-8 gap-y-2">
              {bundle.travel_purpose && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Purpose:</span>
                  <span className="font-semibold">{bundle.travel_purpose}</span>
                </div>
              )}
              {bundle.travel_destination && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Destination:</span>
                  <span className="font-semibold">{bundle.travel_destination}</span>
                </div>
              )}
              {bundle.departure_date && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Departure:</span>
                  <span className="font-semibold">{bundle.departure_date}</span>
                </div>
              )}
              {bundle.arrival_date && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Arrival:</span>
                  <span className="font-semibold">{bundle.arrival_date}</span>
                </div>
              )}
              {bundle.is_overseas && (
                <div className="flex gap-2">
                  <span className="text-ink-muted w-28 shrink-0">Overseas:</span>
                  <span className="font-semibold">Yes</span>
                </div>
              )}
            </div>
          </section>

          {/* Line Items Table */}
          <section className="mb-8">
            <h3 className="font-bold text-xs text-ink-muted mb-3 border-b border-line pb-1">
              Expense Line Items ({bundle.line_items.length} Receipts)
            </h3>
            <table className="w-full border-collapse" style={{ fontSize: "12px" }}>
              <thead>
                <tr className="bg-surface-muted text-ink-muted text-xs">
                  <th className="text-left py-2 px-3 border border-line font-semibold w-16">Ref</th>
                  <th className="text-left py-2 px-3 border border-line font-semibold">Category / Audit Notes</th>
                  <th className="text-right py-2 px-3 border border-line font-semibold w-28">Requested (MYR)</th>
                  <th className="text-right py-2 px-3 border border-line font-semibold w-28">Approved (MYR)</th>
                  <th className="text-center py-2 px-3 border border-line font-semibold w-24">Status</th>
                </tr>
              </thead>
              <tbody>
                {bundle.line_items.map((item, i) => {
                  return (
                    <tr key={i} className={
                      item.status === "REJECTED" ? "bg-danger-soft"
                    : item.status === "PARTIAL_APPROVE" ? "bg-warning-soft"
                    : item.status === "PENDING"  ? "bg-surface-muted"
                    : "bg-white"
                    }>
                      <td className="py-2 px-3 border border-line font-mono text-xs text-ink-muted">
                        {item.document_id.slice(0, 8)}
                      </td>
                      <td className="py-2 px-3 border border-line">
                        {item.category} - {item.description}
                        {item.audit_notes.length > 0 && (
                          <div className="mt-1 space-y-0.5">
                            {item.audit_notes.map((adj, j) => (
                              <div key={j} className="text-xs text-ink-muted flex gap-1">
                                <span className="text-ink-muted">↳</span>
                                <span>{adj.tag} {adj.message}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="py-2 px-3 border border-line text-right tabular-nums">
                        {(item.requested_amount || 0).toFixed(2)}
                      </td>
                      <td className="py-2 px-3 border border-line text-right tabular-nums font-semibold">
                        {(item.approved_amount || 0).toFixed(2)}
                      </td>
                      <td className="py-2 px-3 border border-line text-center">
                        <span className={`px-1.5 py-0.5 rounded text-xs font-semibold ${
                          item.status === "APPROVED" ? "bg-success-soft text-success"
                        : item.status === "PARTIAL_APPROVE" ? "bg-warning-soft text-warning"
                        : item.status === "PENDING"  ? "bg-surface-muted text-ink-muted"
                        : "bg-danger-soft text-danger"
                        }`}>
                          {item.status.replace("_", " ")}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-surface-muted font-bold">
                  <td colSpan={2} className="py-2 px-3 border border-line text-right text-ink">Total Requested</td>
                  <td className="py-2 px-3 border border-line text-right tabular-nums">{totalRequested.toFixed(2)}</td>
                  <td className="py-2 px-3 border border-line text-right tabular-nums text-ink">{totalApproved.toFixed(2)}</td>
                  <td className="py-2 px-3 border border-line" />
                </tr>
                {totalDeducted > 0 && (
                  <tr className="bg-danger-soft">
                     <td colSpan={2} className="py-2 px-3 border border-line text-right text-danger font-semibold">Total Deduction</td>
                     <td className="py-2 px-3 border border-line" />
                     <td className="py-2 px-3 border border-line text-right tabular-nums text-danger font-bold">({totalDeducted.toFixed(2)})</td>
                     <td className="py-2 px-3 border border-line" />
                  </tr>
                )}
                <tr className="bg-surface-muted">
                  <td colSpan={2} className="py-3 px-3 border border-line text-right text-ink font-bold">Net approved</td>
                  <td className="py-3 px-3 border border-line" />
                  <td className="py-3 px-3 border border-line text-right font-mono text-ink font-semibold text-base">{totalApproved.toFixed(2)}</td>
                  <td className="py-3 px-3 border border-line" />
                </tr>
              </tfoot>
            </table>
          </section>

          {/* Signature Block */}
          <div className="mt-12 grid grid-cols-2 gap-12 border-t border-line pt-6">
            {["Employee Signature", "HR Authorisation"].map((label) => (
              <div key={label}>
                <div className="h-12 border-b border-line-strong mb-2" />
                <p className="text-xs text-ink-muted">{label}</p>
                <p className="text-xs text-ink-muted mt-0.5">Date: ___________</p>
              </div>
            ))}
          </div>

          {/* Footer */}
          <div className="mt-8 pt-4 border-t border-surface-muted flex justify-between text-ink-muted text-xs">
            <span>Generated by Reclaim Pay · {formatClaimRef(bundle.id)}</span>
            <span>Confidential, internal use only</span>
          </div>
        </div>
      </div>
      </div>
    </div>
  );
}

export default function ReviewPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { user } = useAuth();

  const [bundle, setBundle] = useState<ClaimBundle | undefined | null>(undefined); // undefined = loading
  const [approvals, setApprovals] = useState<Record<string, string>>({});
  const [decision, setDecision] = useState<Decision>(null);
  const [note, setNote] = useState("");
  const [auditOpen, setAuditOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [awaitingSecond, setAwaitingSecond] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [payoutSubmitting, setPayoutSubmitting] = useState(false);
  const [payoutError, setPayoutError] = useState<string | null>(null);
  const [payoutInfo, setPayoutInfo] = useState<any>(null);
  const [reviewedStatus, setReviewedStatus] = useState<string | null>(null);
  const [vendorBusy, setVendorBusy] = useState(false);
  const [vendorError, setVendorError] = useState<string | null>(null);
  const [verifyEmail, setVerifyEmail] = useState("");
  const [showAccountChange, setShowAccountChange] = useState(false);
  const [vendorEmail, setVendorEmail] = useState("");

  const didInitRef = useRef(false);

  useEffect(() => {
    const fallback = MOCK_BUNDLES[id];
    getHRClaimBundle(id)
      .then((b) => {
        setBundle(b ?? fallback ?? null);
      })
      .catch(() => {
        setBundle(fallback ?? null);
      });
  }, [id]);

  useEffect(() => {
    if (!bundle || didInitRef.current) return;
    didInitRef.current = true;
    setApprovals(Object.fromEntries(
      bundle.line_items.map(li => [li.document_id, String(li.approved_amount ?? 0)])
    ));
  }, [bundle]);

  // Escape closes the receipt image.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  if (bundle === undefined) return (
    <div className="flex items-center justify-center min-h-[60vh] gap-3 text-ink-muted">
      <Loader2 className="w-5 h-5 animate-spin" />
      <span className="text-sm">Loading claim...</span>
    </div>
  );

  if (!bundle) return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
      <p className="text-ink-muted">No bundle found for <code className="font-mono">{id}</code></p>
      <button type="button" onClick={() => router.push("/hr/dashboard")} className="min-h-[44px] px-5 rounded-full bg-accent text-on-accent text-sm font-semibold hover:bg-accent-hover transition-colors cursor-pointer">Back to Dashboard</button>
    </div>
  );

  // Two-person claims: the first approver can't also be the second.
  const approveBlocked = approveBlockedReason(bundle.autonomy ?? null, FIXTURES_ON ? FIXTURE_HR_USER_ID : user?.user_id);
  // Editing an amount picks "approve adjusted", which a blocked approver can't send.
  const submittable: Decision = approveBlocked && decision !== "reject" ? null : decision;
  const identityFields = identityFieldsOf(bundle);
  const contextFields = contextFieldsOf(bundle);
  const netHR = Object.values(approvals).reduce((sum, s) => sum + (parseFloat(s) || 0), 0);
  const allFlags = bundle.line_items.flatMap(li => li.audit_notes.map(n => ({ ...n, receipt: li.description })));

  function preset(mode: "full" | "ai" | "zero") {
    setApprovals(Object.fromEntries(bundle!.line_items.map(li => [
      li.document_id,
      String(mode === "full" ? li.requested_amount : mode === "ai" ? li.approved_amount : 0),
    ])));
    if (mode === "full") setDecision("approve_full");
    else if (mode === "ai") setDecision("approve_adjusted");
    else setDecision("reject");
  }

  async function submit() {
    if (!submittable) return;
    setSubmitting(true);
    setSubmitError(null);
    const status = decision === "reject" ? "REJECTED" : "APPROVED";
    const lineItems = bundle!.line_items.map(li => ({
      line_item_id: li.line_item_id ?? li.document_id,
      approved_amount: parseFloat(approvals[li.document_id] || "0"),
    }));
    const res = await updateReimbursementStatus(bundle!.id, status, user!.user_id, {
      lineItems,
      hrNote: note || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      setSubmitError(res.error ? approvalErrorMessage(res.error) : "Failed to update status.");
      return;
    }
    // First of two approvals on a two-person claim: the claim stays in review and nothing is paid.
    const awaiting = isAwaitingSecondApproval(res.data);
    setAwaitingSecond(awaiting);
    setReviewedStatus(awaiting ? (res.data?.status ?? "REVIEW") : status);
    if (status === "APPROVED") {
      setDecision(null);
    }
    setShowSuccessModal(true);
    // Stay on the page so the approver reads that a second approval is still needed.
    if (!awaiting) router.push("/hr/dashboard");
  }

  async function handleTriggerPayout() {
    setPayoutSubmitting(true);
    setPayoutError(null);
    const { triggerPayout } = await import("@/lib/actions/hr");
    const res = await triggerPayout(bundle!.id);
    setPayoutSubmitting(false);
    if (res.error) {
      setPayoutError(approvalErrorMessage(res.error));
      return;
    }
    setPayoutInfo(res.payout);
    setReviewedStatus("DISBURSING");
  }

  async function handleVerifyVendor() {
    if (!bundle?.vendor_id) return;
    setVendorBusy(true);
    setVendorError(null);
    const { verifyVendorAccount } = await import("@/lib/actions/bookings");
    const res = await verifyVendorAccount(bundle.vendor_id, verifyEmail.trim() || undefined);
    setVendorBusy(false);
    if (!res.ok) {
      setVendorError(approvalErrorMessage(res.error ?? "Could not verify the vendor account."));
      return;
    }
    const updated = await getHRClaimBundle(bundle.id);
    if (updated) setBundle(updated);
  }

  async function handleChangeVendorAccount() {
    if (!bundle?.vendor_id || !vendorEmail.trim()) return;
    setVendorBusy(true);
    setVendorError(null);
    const { changeVendorAccount } = await import("@/lib/actions/bookings");
    const res = await changeVendorAccount(bundle.vendor_id, vendorEmail.trim());
    setVendorBusy(false);
    if (!res.ok) {
      setVendorError(approvalErrorMessage(res.error ?? "Could not change the vendor account."));
      return;
    }
    setShowAccountChange(false);
    setVendorEmail("");
    const updated = await getHRClaimBundle(bundle.id);
    if (updated) setBundle(updated);
  }

  return (
    <div className="relative min-h-full px-4 py-5 sm:px-6 md:p-10 pb-32 lg:pb-10">
      <div className="mb-6 md:mb-8">
        <button type="button" onClick={() => router.push("/hr/dashboard")} className="inline-flex items-center gap-2 min-h-[44px] -ml-1 px-1 mb-2 rounded-control text-sm font-semibold text-ink-muted hover:text-ink transition-colors cursor-pointer">
          <ArrowLeft className="w-4 h-4" strokeWidth={2.25} aria-hidden="true" /> Back to Dashboard
        </button>
        <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">
          {bundle.kind === "VENDOR_BOOKING" ? "Review Vendor Booking" : "Review Claim"}{" "}
          <span className="font-mono font-normal text-ink-muted text-lg md:text-xl">{formatClaimRef(bundle.id)}</span>
        </h1>
        <p className="text-sm text-ink-muted mt-1" suppressHydrationWarning>
  Submitted {new Date(bundle.submitted_at).toLocaleString("en-MY")} 
</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_380px] gap-6 min-w-0">

        {/* ═══ LEFT ═══ */}
        <div className="flex flex-col gap-6 min-w-0">

          {/* Employee Identity */}
          <Card title="Employee Identity">
            <div className="p-4 sm:p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
              {identityFields.map(([l, v]) => <Field key={l} label={l} value={v} />)}
            </div>
          </Card>

          {/* Claim Context: shown only when at least one value was recorded */}
          {contextFields.length > 0 && (
            <Card title="Claim Context">
              <div className="p-4 sm:p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
                {contextFields.map(([l, v]) => <Field key={l} label={l} value={v} />)}
              </div>
            </Card>
          )}

          {/* Vendor booking details */}
          {bundle.kind === "VENDOR_BOOKING" && (
            <Card title="Vendor">
              <div className="p-4 sm:p-6 grid grid-cols-2 sm:grid-cols-3 gap-4">
                <Field label="Vendor" value={bundle.vendor_name || "Not set"} />
                <Field label="Service start" value={bundle.service_start || "Not set"} />
                <Field label="Service end" value={bundle.service_end || "Not set"} />
                <Field label="PayPal account" value={bundle.vendor_paypal_masked || "Not set"} />
                <Field label="Payout account" value={bundle.vendor_verified ? "Verified" : "Not verified"} />
                {bundle.vendor_cooldown_until && (
                  <Field label="Auto-pay paused until" value={bundle.vendor_cooldown_until} />
                )}
              </div>
              <p className="px-4 sm:px-6 pb-4 text-xs text-ink-muted">
                This is a company-paid booking. There is no receipt yet. The vendor is paid directly and no employee float is involved.
              </p>
              {!bundle.vendor_verified && (
                <div className="px-4 sm:px-6 pb-5 flex flex-col gap-2">
                  <input
                    type="email"
                    value={verifyEmail}
                    onChange={(event) => setVerifyEmail(event.target.value)}
                    placeholder="Vendor billing email (optional)"
                    className="min-h-11 w-full rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink"
                  />
                  <button
                    type="button"
                    onClick={handleVerifyVendor}
                    disabled={vendorBusy}
                    className="inline-flex w-fit min-h-11 items-center gap-2 rounded-full bg-accent px-5 py-2.5 font-body text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
                  >
                    {vendorBusy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
                    {vendorBusy ? "Verifying" : "Verify payout account"}
                  </button>
                  <p className="font-body text-xs text-ink-muted">
                    Verification lets future bookings for this vendor skip the manual check. This booking still needs your decision.
                  </p>
                  {vendorError && (
                    <p role="alert" className="font-body text-xs text-danger">{vendorError}</p>
                  )}
                </div>
              )}
              {bundle.vendor_verified && (
                <div className="px-4 sm:px-6 pb-5 flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => setShowAccountChange((open) => !open)}
                    className="inline-flex w-fit min-h-11 items-center rounded-full border border-line-strong px-5 py-2.5 font-body text-sm font-semibold text-ink hover:bg-surface-muted"
                  >
                    Change payout account
                  </button>
                  <p className="font-body text-xs text-ink-muted">
                    Changing the account pauses vendor auto-pay for {bundle.vendor_cooldown_hours ?? 72} hours.
                  </p>
                  {showAccountChange && (
                    <div className="flex flex-col sm:flex-row gap-2 mt-1">
                      <input
                        type="email"
                        value={vendorEmail}
                        onChange={(event) => setVendorEmail(event.target.value)}
                        placeholder="vendor-billing@example.com"
                        className="min-h-11 flex-1 rounded-control border border-line-strong bg-surface px-3 font-body text-sm text-ink"
                      />
                      <button
                        type="button"
                        onClick={handleChangeVendorAccount}
                        disabled={vendorBusy || !vendorEmail.trim()}
                        className="inline-flex min-h-11 items-center justify-center rounded-full bg-accent px-5 py-2.5 font-body text-sm font-semibold text-on-accent hover:bg-accent-hover disabled:opacity-60"
                      >
                        {vendorBusy ? "Saving" : "Save account"}
                      </button>
                    </div>
                  )}
                  {vendorError && (
                    <p role="alert" className="font-body text-xs text-danger">{vendorError}</p>
                  )}
                </div>
              )}
            </Card>
          )}

          {/* Official Document */}
          {bundle.kind !== "VENDOR_BOOKING" && (
          <Card title="Official Document">
            <div className="p-4 sm:p-6">
              <div className="flex items-center gap-3 mb-4">
                <FileText className="w-5 h-5 text-ink-muted shrink-0" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <p className="font-body font-semibold text-sm text-ink">Official Claim Form</p>
                  <p className="font-mono text-xs text-ink-muted break-all">
                    {formatClaimRef(bundle.id)}_claim_form.pdf
                  </p>
                </div>
              </div>
              <div className="flex flex-col sm:flex-row gap-2">
                <button
                  id={`view-form-${bundle.id}`}
                  type="button"
                  onClick={() => setShowFormModal(true)}
                  className="flex-1 flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-control border border-line-strong bg-surface text-ink font-body font-semibold text-sm hover:bg-surface-muted transition-colors cursor-pointer"
                >
                  <ExternalLink className="w-4 h-4" aria-hidden="true" />
                  View Official Claim Form
                </button>
                <button
                  id={`download-pdf-${bundle.id}`}
                  type="button"
                  disabled
                  className="flex items-center justify-center gap-1.5 min-h-[44px] px-3 rounded-control border border-line text-ink-muted font-body font-semibold text-sm disabled:opacity-60"
                  aria-label="Download PDF, not available yet"
                >
                  <Download className="w-4 h-4" aria-hidden="true" />
                  Download PDF (not available yet)
                </button>
              </div>
            </div>
          </Card>
          )}

          {/* Financial Breakdown */}
          <Card title={<>Financial Breakdown <span className="ml-2 text-xs font-body font-normal text-ink-muted">{bundle.line_items.length} {bundle.kind === "VENDOR_BOOKING" ? "booking" : "receipts"}</span></>}>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-surface-muted">
                    {["#", "Date", "Cat.", "Description", "Requested", "AI suggested", "Status"].map(h => (
                      <th key={h} className="py-3 px-3 text-xs font-semibold text-ink-muted whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {bundle.line_items.map((li, idx) => (
                    <tr key={`table-${li.document_id}-${idx}`} className="hover:bg-surface-muted transition-colors align-top">
                      <td className="py-1 px-2 text-ink-muted">
                        {li.receipt_url
                          ? <button type="button" onClick={() => setLightbox(li.receipt_url!)} aria-label={`View receipt ${idx + 1}`} className="inline-flex items-center gap-1 min-h-[44px] min-w-[44px] px-1 rounded-control text-ink underline underline-offset-2 hover:bg-surface-muted text-xs cursor-pointer"><ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />{idx + 1}</button>
                          : <span className="inline-flex items-center min-h-[44px] px-1 text-xs">{idx + 1}</span>}
                      </td>
                      <td className="py-3 px-3 text-ink-muted whitespace-nowrap text-xs">{li.date}</td>
                      <td className="py-3 px-3 text-xs text-ink-muted">{CAT[li.category]}</td>
                      <td className="py-3 px-3 max-w-[160px]">
                        <p className="text-ink text-xs truncate">{li.description}</p>
                        {li.human_edited && (
                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-warning mt-1">
                            Edited by employee · OCR read <span className="font-mono">{fmt(li.ocr_amount ?? 0)}</span>
                          </span>
                        )}
                        {li.audit_notes.map((n, i) => (
                          <p key={i} className="text-xs font-mono font-medium text-danger mt-0.5">{n.tag}</p>
                        ))}
                      </td>
                      <td className="py-3 px-3 font-mono font-medium whitespace-nowrap text-xs">{fmt(li.requested_amount)}</td>
                      <td className="py-3 px-3 font-mono font-medium whitespace-nowrap text-xs">{fmt(li.approved_amount)}</td>
                      <td className="py-3 px-3">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_CHIP[li.status]}`}>{li.status.replace("_", " ")}</span>
                        {li.deduction_amount > 0 && <p className="text-xs font-mono text-danger mt-0.5">-{fmt(li.deduction_amount)}</p>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile Card List */}
            <div className="md:hidden flex flex-col divide-y divide-line">
              {bundle.line_items.map((li, idx) => (
                <div key={`mobile-${li.document_id}-${idx}`} className="px-4 py-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {li.receipt_url ? (
                        <button type="button" onClick={() => setLightbox(li.receipt_url!)} aria-label={`View receipt ${idx + 1}`} className="inline-flex items-center gap-1 min-h-[44px] min-w-[44px] -ml-1 px-1 rounded-control text-ink underline underline-offset-2 hover:bg-surface-muted text-xs cursor-pointer">
                          <ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />{idx + 1}
                        </button>
                      ) : (
                        <span className="text-xs text-ink-muted font-semibold">#{idx + 1}</span>
                      )}
                      <span className="text-xs text-ink-muted">{CAT[li.category]}</span>
                    </div>
                    <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_CHIP[li.status]}`}>{li.status.replace("_", " ")}</span>
                  </div>
                  <p className="text-sm text-ink font-medium mt-1 truncate">{li.description}</p>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-ink-muted">{li.date}</span>
                    <div className="text-right">
                      <p className="text-xs font-mono font-medium text-ink">{fmt(li.approved_amount)}</p>
                      {li.deduction_amount > 0 && <p className="text-xs font-mono text-danger">-{fmt(li.deduction_amount)}</p>}
                    </div>
                  </div>
                  {li.human_edited && (
                    <span className="inline-flex items-center gap-1 text-xs font-semibold text-warning mt-2">
                      Edited by employee · OCR read <span className="font-mono">{fmt(li.ocr_amount ?? 0)}</span>
                    </span>
                  )}
                  {li.audit_notes.map((n, i) => (
                    <p key={i} className="text-xs font-mono font-medium text-danger mt-0.5">{n.tag}</p>
                  ))}
                </div>
              ))}
            </div>
          </Card>

          {/* Policy Flags */}
          {allFlags.length > 0 && (
            <Card title={
              <span className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-danger" strokeWidth={2.25} aria-hidden="true" />
                Policy Flags
                <span className="text-sm font-mono font-normal text-danger">{allFlags.length}</span>
              </span>
            }>
              <div className="p-4 sm:p-6 flex flex-col gap-3">
                {allFlags.map((f, i) => (
                  <div key={i} className="rounded-card p-4 shadow-ambient">
                    <p className="text-xs font-mono font-medium text-danger mb-1">{f.tag}</p>
                    <p className="text-sm text-ink leading-relaxed">{f.message}</p>
                    <p className="text-xs text-ink-muted mt-1">Receipt: {f.receipt}</p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Audit Trail */}
          <Card title={
            <button type="button" aria-expanded={auditOpen} onClick={() => setAuditOpen(o => !o)} className="w-full min-h-[44px] flex items-center justify-between cursor-pointer">
              <span className="flex items-center gap-2 font-display font-semibold text-base text-ink">
                <Clock className="w-4 h-4 text-ink-muted" strokeWidth={2} aria-hidden="true" /> Audit Trail
                <span className="text-sm font-mono font-normal text-ink-muted">{bundle.audit_log.length}</span>
              </span>
              <ChevronDown className={`w-4 h-4 text-ink-muted transition-transform ${auditOpen ? "rotate-180" : ""}`} aria-hidden="true" />
            </button>
          }>
            <div className={`overflow-hidden transition-all duration-300 ${auditOpen ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"}`}>
              <div className="px-4 sm:px-6 pt-4 pb-6 ml-2 pl-6 border-l-2 border-line flex flex-col gap-4">
                {bundle.audit_log.map(e => (
                  <div key={e.id} className="relative">
                    <div className="absolute -left-[31px] top-1 w-3 h-3 rounded-full bg-surface border-2 border-line-strong" />
                    <p className="text-xs text-ink-muted">{e.timestamp}</p>
                    <p className="text-sm text-ink"><span className="font-semibold">{e.actor}</span>: {e.action}</p>
                  </div>
                ))}
              </div>
            </div>
          </Card>
        </div>

        {/* ═══ RIGHT ═══ */}
        <div className="flex flex-col gap-6 lg:sticky lg:top-6 lg:h-fit">

          <AutonomyPanel
            autonomy={bundle.autonomy}
            aiSummary={bundle.kind === "VENDOR_BOOKING" ? "" : bundle.summary}
            aiVerdict={bundle.kind === "VENDOR_BOOKING" ? "" : verdictLabel(bundle.overall_judgment as ReimbursementRaw["judgment"])}
          />

          {/* Financial Totals */}
          <Card title="Financial Summary">
            <div className="p-4 sm:p-6 flex flex-col gap-3">
              {([["Total Requested", fmt(bundle.totals.total_requested), "text-ink"],
                ["AI suggested deduction", `-${fmt(bundle.totals.total_deduction)}`, "text-danger"],
                ["AI suggested total", fmt(bundle.totals.net_approved), "text-ink"]] as [string, string, string][])
                .map(([l, v, cls]) => (
                  <div key={l} className="flex items-center justify-between gap-3">
                    <p className="text-sm text-ink-muted">{l}</p>
                    <p className={`text-sm font-mono font-medium ${cls}`}>{v}</p>
                  </div>
                ))}
              <div className="border-t border-line pt-3 flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-ink">HR Approved Total</p>
                <p className="text-base font-mono font-semibold text-ink">{fmt(netHR)}</p>
              </div>
            </div>
          </Card>

          {/* Per-Receipt Inputs */}
          <Card
            title="Per-Receipt Decision"
            right={
              <div className="flex gap-1">
                {(["full", "ai"] as const).map(m => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => preset(m)}
                    disabled={!!approveBlocked}
                    aria-label={m === "full" ? "Fill every receipt with the requested amount" : "Fill every receipt with the AI suggested amount"}
                    className="min-h-[44px] px-3 rounded-control border border-line text-xs font-semibold text-ink hover:bg-surface-muted transition-colors disabled:opacity-50 cursor-pointer"
                  >
                    {m === "full" ? "Max" : "AI"}
                  </button>
                ))}
              </div>
            }
          >
            <div className="p-4 flex flex-col gap-3">
              {bundle.line_items.map((li, idx) => (
                <div key={`approval-${li.document_id}-${idx}`} className="flex items-center gap-3">
                  <span className="text-xs text-ink-muted w-5 shrink-0">#{idx + 1}</span>
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-medium text-ink truncate">{li.description}</p>
                    <p className="text-xs text-ink-muted">Requested <span className="font-mono">{fmt(li.requested_amount)}</span></p>
                  </div>
                  <label className="flex items-center min-h-[44px] bg-surface rounded-control border border-line-strong focus-within:border-accent px-2 w-32 shrink-0 cursor-text">
                    <span className="text-xs text-ink-muted mr-1">MYR</span>
                    <span className="sr-only">Approved amount for receipt {idx + 1}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      value={approvals[li.document_id] ?? ""}
                      onChange={e => {
                        const raw = e.target.value;
                        if (raw === "") {
                          setApprovals(p => ({ ...p, [li.document_id]: "" }));
                          return;
                        }
                        // Allow only digits and at most one decimal point
                        const cleaned = raw.replace(/[^0-9.]/g, "").replace(/\.(?=.*\.)/g, "");
                        setApprovals(p => ({ ...p, [li.document_id]: cleaned }));
                        if (decision !== "approve_adjusted") setDecision("approve_adjusted");
                      }}
                      onBlur={() => {
                        const raw = approvals[li.document_id] ?? "";
                        const num = raw === "" ? 0 : parseFloat(raw) || 0;
                        setApprovals(p => ({ ...p, [li.document_id]: String(Math.max(0, num)) }));
                      }}
                      className="w-full min-w-0 bg-transparent text-sm font-mono font-medium text-ink outline-none"
                    />
                  </label>
                </div>
              ))}
            </div>
          </Card>

          {/* Decision */}
          <Card title="Your Decision">
            <div className="p-4 sm:p-6 flex flex-col gap-4">
              {approveBlocked && (
                <p id="approve-blocked" role="status" className="rounded-control bg-surface-muted px-3 py-2 text-sm text-ink">
                  <span className="font-semibold">{approveBlocked}.</span> A second HR member has to approve this claim. You can still reject it.
                </p>
              )}
              <div className="flex flex-col gap-2">
                {([
                  ["approve_full", ShieldCheck, "Force Full Approval", `Approve full ${fmt(bundle.totals.total_requested)}`, "emerald", "full"],
                  ["approve_adjusted", Pencil, "Approve Adjusted Amount", `HR total: ${fmt(netHR)}`, "amber", "ai"],
                  ["reject", ShieldX, "Confirm Rejection", "Reject entire claim bundle", "error", "zero"],
                ] as const).map(([val, Icon, label, sub, color, p]) => {
                  const active = decision === val;
                  const blocked = !!approveBlocked && val !== "reject";
                  const s = {
                    emerald: active ? "bg-success-soft text-success border-success" : "border-line text-ink hover:border-line-strong",
                    amber: active ? "bg-warning-soft text-warning border-warning" : "border-line text-ink hover:border-line-strong",
                    error: active ? "bg-danger-soft text-danger border-danger" : "border-line text-ink hover:border-line-strong",
                  };
                  return (
                    <button key={val} type="button" aria-pressed={active} disabled={blocked} aria-describedby={blocked ? "approve-blocked" : undefined} onClick={() => {
                      setDecision(val);
                      if (val === "approve_adjusted") {
                        const hasCustomAmounts = bundle!.line_items.some(li => approvals[li.document_id] !== String(li.approved_amount ?? 0));
                        if (!hasCustomAmounts) preset("ai");
                      } else {
                        preset(p as "full" | "ai" | "zero");
                      }
                    }}
                      className={`flex items-center gap-3 w-full min-h-[56px] px-4 py-3 rounded-control text-sm font-semibold font-body transition-colors cursor-pointer border text-left bg-surface disabled:cursor-not-allowed disabled:opacity-50 ${blocked ? "border-line text-ink-muted" : s[color]}`}>
                      <Icon className="w-5 h-5 shrink-0" strokeWidth={2} aria-hidden="true" />
                      <div><p>{label}</p><p className="text-xs font-normal mt-0.5 text-ink-muted">{sub}</p></div>
                    </button>
                  );
                })}
              </div>

              <div>
                <label htmlFor="hr-note" className="text-sm font-semibold text-ink mb-2 block">
                  HR Note <span className="font-normal text-ink-muted">(optional)</span>
                </label>
                <textarea id="hr-note" rows={3} placeholder="Add a note for the employee…" value={note} onChange={e => setNote(e.target.value)}
                  className="w-full bg-surface rounded-control px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted border border-line-strong focus:border-accent outline-none resize-none" />
              </div>

              <button id="submit-review" type="button" onClick={submit} disabled={!submittable || submitting}
                className={`w-full min-h-[48px] rounded-full text-sm font-semibold font-body transition-colors flex items-center justify-center gap-2 ${submittable ? "bg-accent text-on-accent hover:bg-accent-hover cursor-pointer" : "bg-surface-muted text-ink-muted cursor-not-allowed"}`}>
                {submitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {submittable === "approve_full" ? "Submit Full Approval" : submittable === "approve_adjusted" ? "Submit Adjusted Approval" : submittable === "reject" ? "Submit Rejection" : "Select a decision"}
              </button>
              {submitError && (
                <p role="alert" className="text-sm text-danger text-center font-body mt-1">{submitError}</p>
              )}

              {reviewedStatus === "APPROVED" && !payoutInfo && (
                <div className="border-t border-line pt-4">
                  <p className="text-xs text-ink-muted font-body mb-3">This claim has been approved and is ready for payout.</p>
                  <button
                    type="button"
                    onClick={handleTriggerPayout}
                    disabled={payoutSubmitting}
                    className="w-full min-h-[48px] rounded-control text-sm font-semibold font-body transition-colors flex items-center justify-center gap-2 bg-success text-on-accent hover:bg-success/90 cursor-pointer disabled:opacity-60"
                  >
                    {payoutSubmitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                    <Send className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
                    Send Payout (<span className="font-mono">{fmt(bundle.totals.net_approved)}</span>)
                  </button>
                  {payoutError && (
                    <p role="alert" className="text-sm text-danger text-center font-body mt-2">{payoutError}</p>
                  )}
                </div>
              )}

              {payoutInfo && payoutInfo.status === "ACCEPTED" && (
                <div className="border-t border-line pt-4">
                  <div className="flex items-center gap-2 text-ink" role="status">
                    <Clock className="w-4 h-4" aria-hidden="true" />
                    <p className="text-sm font-semibold font-body">Payout processing…</p>
                  </div>
                  <p className="text-xs text-ink-muted mt-1">Funds are on their way to PayPal. Status will update shortly.</p>
                </div>
              )}

              {payoutInfo && payoutInfo.status === "SUCCEEDED" && (
                <div className="border-t border-line pt-4">
                  <div className="flex items-center gap-2 text-success" role="status">
                    <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
                    <p className="text-sm font-semibold font-body">Payment Sent</p>
                  </div>
                  <p className="text-xs text-ink-muted mt-1">Funds have been disbursed successfully.</p>
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>

      {lightbox && (
        <div role="dialog" aria-modal="true" aria-label="Receipt image" className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 sm:p-6" onClick={() => setLightbox(null)}>
          <div className="relative max-w-3xl max-h-[85vh] rounded-card overflow-hidden bg-surface">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={lightbox} alt="Receipt" className="w-full h-full object-contain" />
            <button type="button" autoFocus onClick={() => setLightbox(null)} aria-label="Close receipt" className="absolute top-2 right-2 w-11 h-11 rounded-control bg-surface border border-line text-ink flex items-center justify-center hover:bg-surface-muted cursor-pointer"><X className="w-5 h-5" aria-hidden="true" /></button>
          </div>
        </div>
      )}

      {showFormModal && (
        <ClaimFormModal
          bundle={bundle}
          onClose={() => setShowFormModal(false)}
        />
      )}

      {showSuccessModal && <SuccessModal decision={decision} id={formatClaimRef(bundle.id)} awaitingSecondApproval={awaitingSecond} />}
    </div>
  );
}
