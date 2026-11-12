"use client";
import { useParams, useRouter } from "next/navigation";
import { useState, useEffect } from "react";
import { ArrowLeft, Clock, ShieldCheck, ShieldX, ChevronDown, ZoomIn, CheckCircle2, FileText, ExternalLink, Download, X, Loader2 } from "lucide-react";
import type { ClaimBundle } from "@/lib/api/types";
import { formatClaimRef, formatMoney } from "@/lib/format";
import { SuccessModal, isAwaitingSecondApproval } from "../../hr_components/SuccessModal";
import { useAuth } from "@/context/AuthContext";
import { updateReimbursementStatus } from "@/lib/actions/hr";
import { useClaimBundle } from "@/lib/hooks/useClaimBundle";
import { ClaimLoadFallback } from "../../hr_components/ClaimLoadFallback";
import { approvalErrorMessage } from "@/lib/hr/evidence";

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
      className="fixed inset-0 z-[100] bg-scrim/90 overflow-auto"
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
          className="a4-modal-zoom bg-surface rounded-sm shrink-0 border border-line"
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
                  <th className="text-right py-2 px-3 border border-line font-semibold w-28">Requested (RM)</th>
                  <th className="text-right py-2 px-3 border border-line font-semibold w-28">Approved (RM)</th>
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
                    : "bg-surface"
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

export default function ViewPage() {
  const { id } = useParams() as { id: string };
  const router = useRouter();
  const { user } = useAuth();

  const { load, retry } = useClaimBundle(id);
  const bundle = load.state === "ready" ? load.bundle : null;
  const [hrDecision, setHrDecision] = useState<"confirm" | "flag" | null>(null);
  const [note, setNote] = useState("");
  const [auditOpen, setAuditOpen] = useState(false);
  const [lightbox, setLightbox] = useState<string | null>(null);
  const [showFormModal, setShowFormModal] = useState(false);
  const [showSuccessModal, setShowSuccessModal] = useState(false);
  const [awaitingSecond, setAwaitingSecond] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Escape closes the receipt image.
  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setLightbox(null); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [lightbox]);

  if (load.state !== "ready" || !bundle) return (
    <ClaimLoadFallback load={load.state === "ready" ? { state: "missing" } : load} id={id} onRetry={retry} onBack={() => router.push("/hr/dashboard")} />
  );

  const pct = Math.round(bundle.confidence * 100);
  const identityFields = identityFieldsOf(bundle);
  const contextFields = contextFieldsOf(bundle);

  async function submit() {
    if (!hrDecision) return;
    setSubmitting(true);
    setSubmitError(null);
    const status = hrDecision === "confirm" ? "APPROVED" : hrDecision === "flag" ? "REVIEW" : "REJECTED";
    const res = await updateReimbursementStatus(bundle!.id, status, user!.user_id, {
      hrNote: note || undefined,
    });
    setSubmitting(false);
    if (!res.ok) {
      setSubmitError(res.error ? approvalErrorMessage(res.error) : "Failed to update status.");
      return;
    }

    const awaiting = isAwaitingSecondApproval(res.data);
    setAwaitingSecond(awaiting);
    setShowSuccessModal(true);
    if (!awaiting) router.push("/hr/dashboard");
  }

  return (
    <div className="relative min-h-full px-4 py-5 sm:px-6 md:p-10 pb-32 lg:pb-10">
      <div className="mb-6 md:mb-8">
        <button type="button" onClick={() => router.push("/hr/dashboard")} className="inline-flex items-center gap-2 min-h-[44px] -ml-1 px-1 mb-2 rounded-control text-sm font-semibold text-ink-muted hover:text-ink transition-colors cursor-pointer">
          <ArrowLeft className="w-4 h-4" strokeWidth={2.25} aria-hidden="true" /> Back to Dashboard
        </button>
        <div className="flex flex-col sm:flex-row sm:items-center gap-3">
          <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">
            Confirm Claim
          </h1>
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-success-soft text-success w-fit">
            <CheckCircle2 className="w-3.5 h-3.5" strokeWidth={2.25} aria-hidden="true" /> Passed every check
          </span>
        </div>
        <p className="text-sm text-ink-muted mt-1">
          Claim <span className="font-mono font-medium text-ink">{formatClaimRef(bundle.id)}</span> · Submitted {new Date(bundle.submitted_at).toLocaleString("en-MY")} · <span className="font-mono">{pct}%</span> AI confidence
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

          {/* Official Document */}
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

          {/* Financial Breakdown */}
          <Card title={<>Financial Breakdown <span className="ml-2 text-xs font-body font-normal text-ink-muted">{bundle.line_items.length} receipts, all passed</span></>}>
            {/* Desktop Table */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-sm border-collapse">
                <thead>
                  <tr className="bg-surface-muted">
                    {["#", "Date", "Category", "Description", "Amount (MYR)", "Status"].map(h => (
                      <th key={h} className="py-3 px-4 text-xs font-semibold text-ink-muted whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-line">
                  {bundle.line_items.map((li, idx) => (
                    <tr key={`table-${li.document_id}-${idx}`} className="hover:bg-surface-muted transition-colors">
                      <td className="py-1 px-3 text-ink-muted">
                        {li.receipt_url
                          ? <button type="button" onClick={() => setLightbox(li.receipt_url!)} aria-label={`View receipt ${idx + 1}`} className="inline-flex items-center gap-1 min-h-[44px] min-w-[44px] px-1 rounded-control text-ink underline underline-offset-2 hover:bg-surface-muted text-xs cursor-pointer"><ZoomIn className="w-3.5 h-3.5" aria-hidden="true" />{idx + 1}</button>
                          : <span className="inline-flex items-center min-h-[44px] px-1 text-xs">{idx + 1}</span>}
                      </td>
                      <td className="py-3 px-4 text-ink-muted whitespace-nowrap text-xs">{li.date}</td>
                      <td className="py-3 px-4 text-xs text-ink-muted">{CAT[li.category]}</td>
                      <td className="py-3 px-4 text-ink">{li.description}</td>
                      <td className="py-3 px-4 font-mono font-medium text-ink whitespace-nowrap">{fmt(li.approved_amount)}</td>
                      <td className="py-3 px-4">
                        <span className={`text-xs font-semibold px-2 py-0.5 rounded-full whitespace-nowrap ${STATUS_CHIP[li.status]}`}>{li.status.replace("_", " ")}</span>
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
                  <p className="text-sm text-ink font-medium mt-1">{li.description}</p>
                  <div className="flex items-center justify-between mt-2">
                    <span className="text-xs text-ink-muted">{li.date}</span>
                    <span className="text-sm font-mono font-medium text-ink">{fmt(li.approved_amount)}</span>
                  </div>
                </div>
              ))}
            </div>
          </Card>

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

          {/* Approval Summary */}
          <div className="bg-surface rounded-card shadow-ambient overflow-hidden">
            <div className="px-4 sm:px-6 py-3 min-h-[56px] border-b border-line flex items-center gap-2">
              <CheckCircle2 className="w-4 h-4 text-success" strokeWidth={2.25} aria-hidden="true" />
              <h3 className="font-display font-semibold text-base text-ink">Check summary</h3>
            </div>
            <div className="p-4 sm:p-6 flex flex-col gap-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-xs text-ink-muted mb-1">AI confidence</p>
                  <p className="text-xl font-mono font-medium text-ink">{pct}%</p>
                </div>
                <div>
                  <p className="text-xs text-ink-muted mb-1">Receipts passed</p>
                  <p className="text-xl font-mono font-medium text-ink">{bundle.line_items.length} / {bundle.line_items.length}</p>
                </div>
              </div>
              <div className="border-t border-line pt-4">
                <p className="text-xs text-ink-muted mb-1">AI suggested total</p>
                <p className="text-2xl font-headline tabular-nums tracking-[-0.02em] font-medium text-success">{fmt(bundle.totals.net_approved)}</p>
              </div>
            </div>
          </div>

          {/* AI Analysis */}
          <Card title="AI Analysis">
            <div className="p-4 sm:p-6">
              <div
                className="w-full h-2 rounded-full bg-surface-muted ring-1 ring-inset ring-line mb-4 overflow-hidden"
                role="meter"
                aria-label="AI confidence"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={pct}
              >
                <div className="h-full rounded-full bg-ink-muted" style={{ width: `${pct}%` }} />
              </div>
              <p className="text-sm text-ink leading-relaxed">{bundle.summary}</p>
            </div>
          </Card>

          {/* HR Confirmation */}
          <Card title={<><span>HR Confirmation</span><span className="text-xs font-normal text-ink-muted ml-2">Verify before finalising</span></>}>
            <div className="p-4 sm:p-6 flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <button id="decision-confirm" type="button" aria-pressed={hrDecision === "confirm"} onClick={() => setHrDecision("confirm")}
                  className={`flex items-center gap-3 w-full min-h-[56px] px-4 py-3 rounded-control text-sm font-semibold font-body transition-colors cursor-pointer border text-left bg-surface ${hrDecision === "confirm" ? "bg-success-soft text-success border-success" : "border-line text-ink hover:border-line-strong"}`}>
                  <ShieldCheck className="w-5 h-5 shrink-0" strokeWidth={2} aria-hidden="true" />
                  <div>
                    <p>Confirm & Finalise Approval</p>
                    <p className="text-xs font-normal mt-0.5 text-ink-muted">Approve <span className="font-mono">{fmt(bundle.totals.net_approved)}</span> and notify employee</p>
                  </div>
                </button>
                <button id="decision-flag" type="button" aria-pressed={hrDecision === "flag"} onClick={() => setHrDecision("flag")}
                  className={`flex items-center gap-3 w-full min-h-[56px] px-4 py-3 rounded-control text-sm font-semibold font-body transition-colors cursor-pointer border text-left bg-surface ${hrDecision === "flag" ? "bg-warning-soft text-warning border-warning" : "border-line text-ink hover:border-line-strong"}`}>
                  <ShieldX className="w-5 h-5 shrink-0" strokeWidth={2} aria-hidden="true" />
                  <div>
                    <p>Flag for Re-review</p>
                    <p className="text-xs font-normal mt-0.5 text-ink-muted">Move to Requires Attention queue</p>
                  </div>
                </button>
              </div>

              {hrDecision === "flag" && (
                <div className="flex items-start gap-3 rounded-control bg-warning-soft border border-warning/40 px-4 py-3">
                  <p className="text-sm text-warning leading-relaxed">This claim will be moved to <span className="font-semibold">Requires Attention</span> for manual HR investigation.</p>
                </div>
              )}

              <div>
                <label htmlFor="hr-note" className="text-sm font-semibold text-ink mb-2 block">
                  HR Note <span className="font-normal text-ink-muted">(optional)</span>
                </label>
                <textarea id="hr-note" rows={3} placeholder="Add a note for the record…" value={note} onChange={e => setNote(e.target.value)}
                  className="w-full bg-surface rounded-control px-3 py-2.5 text-sm text-ink placeholder:text-ink-muted border border-line-strong focus:border-accent outline-none resize-none" />
              </div>

              <button id="submit-hr-decision" type="button" onClick={submit} disabled={!hrDecision || submitting}
                className={`w-full min-h-[48px] rounded-full text-sm font-semibold font-body transition-colors flex items-center justify-center gap-2 ${
                  hrDecision === "confirm" ? "bg-accent text-on-accent hover:bg-accent-hover cursor-pointer"
                  : hrDecision === "flag" ? "bg-warning text-on-accent hover:bg-warning/90 cursor-pointer"
                  : "bg-surface-muted text-ink-muted cursor-not-allowed"}`}>
                {submitting && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
                {hrDecision === "confirm" ? "Confirm & Finalise Approval" : hrDecision === "flag" ? "Flag for Re-review" : "Select a decision"}
              </button>
              {submitError && (
                <p role="alert" className="text-sm text-danger text-center font-body mt-1">{submitError}</p>
              )}
            </div>
          </Card>
        </div>
      </div>

      {lightbox && (
        <div role="dialog" aria-modal="true" aria-label="Receipt image" className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4 sm:p-6" onClick={() => setLightbox(null)}>
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

      {showSuccessModal && <SuccessModal decision={hrDecision} id={formatClaimRef(bundle.id)} awaitingSecondApproval={awaitingSecond} />}
    </div>
  );
}
