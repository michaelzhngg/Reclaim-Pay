"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Search, ChevronRight, FileText, ArrowLeft, X, Upload, Settings, CheckCircle2, AlertCircle, Trash2, Archive } from 'lucide-react';
import {
  LEGACY_STORAGE_KEYS,
  POLICY_STATUS_STYLE,
  budgetInputs,
  budgetsPayload,
  matchesSearch,
  policyMeta,
  sourceFileName,
  toPolicy,
  type MandatoryConditions,
  type Policy,
  type PolicyStatus,
} from './_lib/policy';
import { uploadPolicy } from '@/lib/actions/hr';
import { getPolicies, deletePolicy, deprecatePolicy, updatePolicyCategories } from '@/lib/actions/policies';
import { ChangeHistory } from '../hr_components/ChangeHistory';
import { POLICY_HISTORY_TYPES } from '../autonomy/_lib/settingsHistory';

const SAVE_STEPS = [
  { id: "upload", label: "Uploading documents...", subtitle: "Securely storing policy files." },
  { id: "analyze", label: "Analyzing policy...", subtitle: "Extracting summary and conditions." },
  { id: "save", label: "Saving changes...", subtitle: "Updating policy database." },
];

const POLICY_MAX_SIZE = 10 * 1024 * 1024; // 10 MB

export function HrProcessingScreen({ currentStep, onBack }: { currentStep: number, onBack: () => void }) {
  return (
    <div className="w-full max-w-xl mx-auto flex flex-col justify-center my-8 sm:my-12">
      <div className="rounded-card shadow-ambient bg-surface p-5 sm:p-8" role="status" aria-live="polite">
        <div className="flex items-center gap-3 mb-8">
          <Settings className="w-5 h-5 text-ink-muted shrink-0 motion-safe:animate-spin [animation-duration:3s]" strokeWidth={2} aria-hidden="true" />
          <div>
            <h2 className="font-display text-xl font-semibold text-ink leading-tight">Uploading policy</h2>
            <p className="text-ink-muted text-sm font-body mt-0.5">Reading a policy can take a minute.</p>
          </div>
        </div>

        <ol className="flex flex-col gap-6">
          {SAVE_STEPS.map((step, idx) => {
            const isCompleted = idx < currentStep;
            const isActive = idx === currentStep;
            return (
              <li key={step.id} className="flex items-start gap-4" aria-current={isActive ? "step" : undefined}>
                {isCompleted ? (
                  <CheckCircle2 className="w-6 h-6 text-success shrink-0" strokeWidth={2} aria-hidden="true" />
                ) : isActive ? (
                  <span className="w-6 h-6 rounded-full border-2 border-accent flex items-center justify-center shrink-0" aria-hidden="true">
                    <span className="w-2 h-2 rounded-full bg-accent" />
                  </span>
                ) : (
                  <span className="w-6 h-6 rounded-full border border-line-strong shrink-0" aria-hidden="true" />
                )}
                <div>
                  <p className={`font-semibold text-sm leading-tight ${isActive || isCompleted ? "text-ink" : "text-ink-muted"}`}>
                    {step.label}
                    {isCompleted && <span className="sr-only"> (done)</span>}
                  </p>
                  {(isCompleted || isActive) && (
                    <p className="text-ink-muted text-xs mt-1 font-body leading-relaxed">{step.subtitle}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>

        <div className="mt-10 flex flex-col items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            className="min-h-[44px] px-5 border border-line-strong text-ink text-sm font-semibold rounded-control hover:bg-surface-muted transition-colors cursor-pointer"
          >
            Back to Policy Studio
          </button>
          <p className="text-xs text-ink-muted font-body">The upload keeps going. The policy appears in the list when it&apos;s ready.</p>
        </div>
      </div>
    </div>
  );
}

/** Changes when the saved budgets change, so the history reloads after a save. */
function budgetsSignature(p: Policy): string {
  return p.reimbursable_categories_with_budgets.map((c) => `${c.category}:${c.auto_approval_budget ?? ""}`).join("|");
}

function ReadOnlyField({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="font-body text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="font-body text-sm text-ink break-words">{value}</dd>
    </div>
  );
}

export default function PolicyStudio() {
  const [editingPolicy, setEditingPolicy] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<PolicyStatus>("Active");
  const [searchQuery, setSearchQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  // New policy upload
  const [mainPolicyFile, setMainPolicyFile] = useState<File | null>(null);
  const [appendixFiles, setAppendixFiles] = useState<File[]>([]);
  const mainPolicyInputRef = useRef<HTMLInputElement>(null);
  const appendixInputRef = useRef<HTMLInputElement>(null);
  const [newName, setNewName] = useState("");
  const [isUploading, setIsUploading] = useState(false);
  const [savingStep, setSavingStep] = useState(0);
  const [policyFileError, setPolicyFileError] = useState<string | null>(null);

  const previewUrl = useMemo(
    () => (mainPolicyFile?.type === "application/pdf" ? URL.createObjectURL(mainPolicyFile) : null),
    [mainPolicyFile],
  );
  useEffect(() => () => { if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  // Existing policy: budgets are the only editable field
  const [categoryBudgets, setCategoryBudgets] = useState<Record<string, string>>({});
  const [isSavingBudgets, setIsSavingBudgets] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false);

  // Retire (deprecate)
  const [retireConfirm, setRetireConfirm] = useState(false);
  const [isRetiring, setIsRetiring] = useState(false);
  const [retireError, setRetireError] = useState<string | null>(null);

  // Delete confirmation state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingPolicyId, setDeletingPolicyId] = useState<string | null>(null);
  const [deletingPolicyName, setDeletingPolicyName] = useState<string>("");

  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policiesStatus, setPoliciesStatus] = useState<"loading" | "ready" | "error">("loading");

  const reload = useCallback(
    () =>
      getPolicies()
        .then((list) => {
          setPolicies(list.map(toPolicy));
          setPoliciesStatus("ready");
        })
        // Keep a list that already loaded; only a first load shows the error state.
        .catch(() => setPoliciesStatus((prev) => (prev === "ready" ? "ready" : "error"))),
    [],
  );

  useEffect(() => {
    // An older version of this page kept fake edits and deletions in the browser.
    try {
      LEGACY_STORAGE_KEYS.forEach((key) => localStorage.removeItem(key));
    } catch { /* storage blocked: nothing to clear */ }
    getPolicies()
      .then((list) => {
        setPolicies(list.map(toPolicy));
        setPoliciesStatus("ready");
      })
      .catch(() => setPoliciesStatus("error"));
  }, []);

  const current = editingPolicy && editingPolicy !== "new"
    ? policies.find((p) => p.policy_id === editingPolicy) ?? null
    : null;

  const openPolicy = (id: string) => {
    const p = policies.find((x) => x.policy_id === id);
    setCategoryBudgets(p ? budgetInputs(p) : {});
    setSaveError(null);
    setRetireConfirm(false);
    setRetireError(null);
    setEditingPolicy(id);
  };

  const startNewPolicy = () => {
    setNewName("");
    setMainPolicyFile(null);
    setAppendixFiles([]);
    setPolicyFileError(null);
    setSaveError(null);
    setEditingPolicy("new");
  };

  // Sync scroll refs
  const editContainerRef = useRef<HTMLDivElement>(null);
  const leftColRef = useRef<HTMLDivElement>(null);
  const rightColRef = useRef<HTMLDivElement>(null);
  const [rightOffset, setRightOffset] = useState(0);
  const [leftOffset, setLeftOffset] = useState(0);

  useEffect(() => {
    const container = editContainerRef.current;
    if (!container || !editingPolicy) return;

    const handleScroll = () => {
      const left = leftColRef.current;
      const right = rightColRef.current;
      if (!left || !right) return;

      const leftH = left.scrollHeight;
      const rightH = right.scrollHeight;
      const maxScroll = container.scrollHeight - container.clientHeight;
      if (maxScroll <= 0) return;

      const ratio = Math.min(Math.max(container.scrollTop / maxScroll, 0), 1);
      if (leftH > rightH) {
        // Left is longer, move Right down so they finish together
        setRightOffset((leftH - rightH) * ratio);
        setLeftOffset(0);
      } else if (rightH > leftH) {
        // Right is longer, move Left down
        setLeftOffset((rightH - leftH) * ratio);
        setRightOffset(0);
      } else {
        setLeftOffset(0);
        setRightOffset(0);
      }
    };

    container.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', handleScroll);

    // Use ResizeObserver to handle content changes (like adding appendix files)
    const observer = new ResizeObserver(handleScroll);
    if (leftColRef.current) observer.observe(leftColRef.current);
    if (rightColRef.current) observer.observe(rightColRef.current);

    const timer = setTimeout(handleScroll, 100);

    return () => {
      clearTimeout(timer);
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
      observer.disconnect();
    };
  }, [editingPolicy, appendixFiles, mainPolicyFile, policies, retireConfirm]);

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  const listMessage =
    policiesStatus === "loading"
      ? "Loading policies..."
      : policiesStatus === "error"
        ? "Couldn't load policies. Refresh the page to try again."
        : policies.length === 0
          ? "No policies yet. Create one to start checking claims."
          : "No policies found matching your search or filter.";

  async function handleUpload() {
    setSaveError(null);
    if (!mainPolicyFile) {
      setSaveError("Choose the policy PDF to upload.");
      return;
    }
    const form = new FormData();
    form.append("files", mainPolicyFile);
    appendixFiles.forEach((f) => form.append("files", f));
    form.append("alias", newName.trim() || mainPolicyFile.name.replace(/\.pdf$/i, ""));

    setIsUploading(true);
    setSavingStep(1);
    const result = await uploadPolicy(form);
    if (!result.ok) {
      setSaveError(result.error ?? "Upload failed. Please try again.");
      setIsUploading(false);
      return;
    }
    setSavingStep(2);
    await reload();
    setIsUploading(false);
    setEditingPolicy(null);
  }

  async function handleSaveBudgets() {
    if (!current) return;
    setSaveError(null);
    const payload = budgetsPayload(categoryBudgets);
    if (!payload.ok) {
      setSaveError(payload.error);
      return;
    }
    if (payload.categories.length === 0) {
      setEditingPolicy(null);
      return;
    }
    setIsSavingBudgets(true);
    const result = await updatePolicyCategories(current.policy_id, payload.categories);
    setIsSavingBudgets(false);
    if (!result.ok) {
      setSaveError(result.error ?? "Couldn't save the budgets. Try again.");
      return;
    }
    await reload();
    setEditingPolicy(null);
  }

  async function handleRetire() {
    if (!current) return;
    setIsRetiring(true);
    setRetireError(null);
    const result = await deprecatePolicy(current.policy_id);
    setIsRetiring(false);
    if (!result.ok) {
      setRetireError(result.error ?? "Couldn't retire the policy. Try again.");
      return;
    }
    setRetireConfirm(false);
    await reload();
  }

  async function handleConfirmDelete() {
    if (!deletingPolicyId) return;
    setIsDeleting(true);
    setDeleteError(null);

    const result = await deletePolicy(deletingPolicyId);

    if (!result.ok) {
      setDeleteError(result.error ?? "Failed to delete policy");
      setIsDeleting(false);
      return;
    }

    setPolicies(prev => prev.filter(p => p.policy_id !== deletingPolicyId));
    setIsDeleting(false);
    setDeleteModalOpen(false);
    if (editingPolicy === deletingPolicyId) {
      setEditingPolicy(null);
    }
    setDeletingPolicyId(null);
    setDeletingPolicyName("");
  }

  if (editingPolicy) {
    const isNew = editingPolicy === "new";

    if (isUploading) {
      return (
        <div className="flex-1 flex flex-col relative w-full h-full bg-paper text-ink overflow-hidden p-6 animate-in fade-in duration-500">
          <HrProcessingScreen currentStep={savingStep} onBack={() => setEditingPolicy(null)} />
        </div>
      );
    }

    if (!isNew && !current) {
      return (
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6 text-center">
          <p className="font-body text-sm text-ink-muted">This policy is no longer available. It may have been deleted.</p>
          <button type="button" onClick={() => setEditingPolicy(null)} className="min-h-[44px] px-5 border border-line-strong text-ink text-sm font-semibold rounded-control hover:bg-surface-muted transition-colors cursor-pointer">
            Back to Policy Studio
          </button>
        </div>
      );
    }

    const conditions: MandatoryConditions | null = current?.mandatory_conditions ?? null;
    const conditionEntries = conditions ? Object.entries(conditions) : [];
    const fileName = sourceFileName(current?.source_file_url);

    return (
      <div className="flex-1 flex flex-col relative overflow-hidden w-full h-full bg-paper text-ink">
        <div
          ref={editContainerRef}
          className="flex-1 flex flex-col p-6 max-w-7xl mx-auto w-full min-h-0 overflow-y-auto scroll-smooth"
        >
          <div className="mb-6 flex flex-wrap items-center gap-4 shrink-0">
            <button type="button" onClick={() => setEditingPolicy(null)} className="flex items-center gap-2 min-h-[44px] -ml-1 px-1 rounded-control text-ink-muted hover:text-ink transition-colors cursor-pointer" aria-label="Back to Policy Studio">
              <ArrowLeft size={18} strokeWidth={2.25} aria-hidden="true" />
              <span className="font-semibold font-body text-sm">Back to Policy Studio</span>
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-3 mb-6">
            <h1 className="font-display text-2xl md:text-3xl leading-tight font-semibold text-ink break-words">
              {isNew ? "Create New Policy" : current?.alias}
            </h1>
            {current && (
              <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${POLICY_STATUS_STYLE[current.status]}`}>
                {current.status}
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 flex-1 min-h-0 items-start">
            {/* Left Column: details (edit) or the upload (new) */}
            <div
              ref={leftColRef}
              className="lg:col-span-7 flex flex-col gap-8 pr-2 pb-4 h-fit transition-transform duration-75 ease-out will-change-transform"
              style={{ transform: `translateY(${leftOffset}px)` }}
            >

              {current && (
                <div className="bg-surface rounded-card p-4 sm:p-6 shadow-ambient shrink-0">
                  <h3 className="font-display text-lg font-bold text-ink mb-5">Policy Details</h3>
                  <dl className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                    <ReadOnlyField label="Policy name" value={current.alias} />
                    {current.title && current.title !== current.alias && (
                      <ReadOnlyField label="Title in the document" value={current.title} />
                    )}
                    <ReadOnlyField label="Effective date" value={current.lastModified || "Not stated in the document"} />
                    <ReadOnlyField
                      label="Document"
                      value={
                        <span className="inline-flex items-center gap-2">
                          <FileText size={16} className="text-ink-muted shrink-0" aria-hidden="true" />
                          {fileName || "Policy document"}
                        </span>
                      }
                    />
                  </dl>
                  <p className="mt-5 text-xs text-ink-muted font-body leading-relaxed">
                    The name, dates and conditions come from the uploaded document. To change them, upload the new version as a new policy, then retire this one.
                  </p>
                </div>
              )}

              {isNew && policyFileError && (
                <div role="alert" className="flex items-start gap-3 bg-danger/10 border border-danger/30 text-danger rounded-control px-4 py-3 text-sm font-body">
                  <AlertCircle size={16} className="shrink-0 mt-0.5" aria-hidden="true" />
                  <span className="flex-1">{policyFileError}</span>
                  <button type="button" aria-label="Dismiss" onClick={() => setPolicyFileError(null)} className="shrink-0 w-8 h-8 -m-1 inline-flex items-center justify-center rounded-control hover:bg-danger-soft cursor-pointer">
                    <X size={16} aria-hidden="true" />
                  </button>
                </div>
              )}

              {/* Main Policy (new only) */}
              {isNew && (
                <div className="flex flex-col gap-4">
                  <h3 className="font-display text-xl font-semibold text-ink shrink-0">Main Policy</h3>
                  <input
                    ref={mainPolicyInputRef}
                    type="file"
                    accept=".pdf"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) {
                        if (file.type !== "application/pdf") {
                          setPolicyFileError("Invalid file type. Only PDF files are accepted for policy documents.");
                          e.target.value = '';
                          return;
                        }
                        if (file.size > POLICY_MAX_SIZE) {
                          setPolicyFileError(`File too large. Maximum 10 MB. Your file is ${(file.size / (1024 * 1024)).toFixed(1)} MB.`);
                          e.target.value = '';
                          return;
                        }
                        setPolicyFileError(null);
                        setSaveError(null);
                        setMainPolicyFile(file);
                      }
                      e.target.value = '';
                    }}
                  />

                  {mainPolicyFile ? (
                    <div className="flex flex-col gap-4 shadow-ambient rounded-card overflow-hidden bg-surface">
                      {previewUrl ? (
                        <iframe
                          src={previewUrl}
                          title={`Preview of ${mainPolicyFile.name}`}
                          className="w-full h-[400px] border-b border-line"
                        />
                      ) : (
                        <div className="w-full h-[400px] border-b border-line bg-surface-muted flex flex-col items-center justify-center">
                          <FileText className="text-ink-muted mb-3" size={48} aria-hidden="true" />
                          <p className="font-body text-base font-medium text-ink">{mainPolicyFile.name}</p>
                          <p className="font-body text-xs text-ink-muted">Preview not available</p>
                        </div>
                      )}
                      <div className="p-4 flex items-center justify-between gap-3">
                        <div className="flex flex-col min-w-0">
                          <p className="font-body text-sm font-medium text-ink truncate">{mainPolicyFile.name}</p>
                          <p className="font-body text-xs text-ink-muted">{formatFileSize(mainPolicyFile.size)}</p>
                        </div>
                        <div className="flex gap-2 shrink-0">
                          <button onClick={() => mainPolicyInputRef.current?.click()} type="button" className="min-h-[44px] px-4 border border-line-strong text-ink rounded-control font-body text-sm font-medium hover:bg-surface-muted transition-colors cursor-pointer">
                            Replace
                          </button>
                          <button onClick={() => setMainPolicyFile(null)} type="button" className="min-h-[44px] px-4 text-danger font-body text-sm font-medium hover:bg-danger-soft rounded-control transition-colors cursor-pointer">
                            Remove
                          </button>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => mainPolicyInputRef.current?.click()}
                      className="bg-surface rounded-card p-8 flex flex-col items-center justify-center border-2 border-dashed border-line-strong hover:bg-surface-muted transition-colors cursor-pointer min-h-[240px]"
                    >
                      <Upload className="text-ink-muted mb-4" size={28} aria-hidden="true" />
                      <span className="font-body text-base font-medium text-ink mb-1">Upload Policy Document</span>
                      <span className="font-body text-xs text-ink-muted">Click to browse · PDF · Max 10 MB</span>
                    </button>
                  )}
                </div>
              )}

              {/* Appendix (new only: it is uploaded together with the main policy) */}
              {isNew && (
                <div className="flex flex-col gap-4">
                  <h3 className="font-display text-xl font-semibold text-ink shrink-0">Appendix (Optional)</h3>
                  <input
                    ref={appendixInputRef}
                    type="file"
                    accept=".pdf"
                    multiple
                    className="hidden"
                    onChange={(e) => {
                      const files = Array.from(e.target.files || []);
                      const invalid = files.find(f => f.type !== "application/pdf");
                      if (invalid) {
                        setPolicyFileError(`Invalid file type "${invalid.name}". Only PDF files are accepted.`);
                        e.target.value = '';
                        return;
                      }
                      const oversized = files.find(f => f.size > POLICY_MAX_SIZE);
                      if (oversized) {
                        setPolicyFileError(`File "${oversized.name}" exceeds the 10 MB limit.`);
                        e.target.value = '';
                        return;
                      }
                      setPolicyFileError(null);
                      if (files.length) setAppendixFiles(prev => [...prev, ...files]);
                      e.target.value = '';
                    }}
                  />
                  <div className="flex flex-col gap-3">
                    <button
                      type="button"
                      onClick={() => appendixInputRef.current?.click()}
                      className="w-full border-2 border-dashed border-line-strong bg-surface hover:bg-surface-muted rounded-card p-4 flex flex-col items-center justify-center transition-colors shrink-0 cursor-pointer"
                    >
                      <Plus className="text-ink-muted mb-2" size={20} aria-hidden="true" />
                      <span className="font-body font-medium text-ink text-sm">Add Source</span>
                      <span className="font-body text-xs text-ink-muted mt-1">Click to upload a PDF</span>
                    </button>

                    {appendixFiles.map((file, idx) => (
                      <div key={`appendix-${file.name}-${idx}`} className="bg-surface rounded-control p-3 border border-line flex items-center justify-between gap-2">
                        <div className="flex items-center gap-3 min-w-0">
                          <FileText className="text-ink-muted shrink-0" size={18} aria-hidden="true" />
                          <div className="min-w-0">
                            <span className="font-body text-sm font-medium text-ink truncate block">{file.name}</span>
                            <span className="font-body text-xs text-ink-muted">{formatFileSize(file.size)}</span>
                          </div>
                        </div>
                        <button
                          type="button"
                          aria-label={`Remove ${file.name}`}
                          onClick={() => setAppendixFiles(prev => prev.filter((_, i) => i !== idx))}
                          className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-control text-ink-muted hover:text-danger hover:bg-danger-soft transition-colors cursor-pointer"
                        >
                          <Trash2 size={16} aria-hidden="true" />
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Retire: only an active policy can be retired */}
              {current?.status === "Active" && (
                <div className="rounded-card border border-line bg-surface overflow-hidden shrink-0">
                  <div className="px-4 sm:px-6 py-3 border-b border-line flex items-center gap-2">
                    <Archive size={15} className="text-ink-muted" aria-hidden="true" />
                    <h3 className="font-display text-base font-semibold text-ink">Retire policy</h3>
                  </div>
                  <div className="px-4 sm:px-6 py-4 flex flex-col gap-3">
                    <p className="font-body text-sm text-ink-muted">
                      New claims stop being checked against a retired policy. It moves to Expired and stays there.
                    </p>
                    {retireError && <p role="alert" className="font-body text-sm text-danger">{retireError}</p>}
                    {retireConfirm ? (
                      <div className="flex flex-wrap items-center gap-3">
                        <span className="font-body text-sm font-semibold text-ink">Retire &ldquo;{current.alias}&rdquo;?</span>
                        <button
                          type="button"
                          onClick={handleRetire}
                          disabled={isRetiring}
                          className="min-h-[44px] px-4 rounded-control bg-ink text-paper text-sm font-semibold hover:bg-ink/85 transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          {isRetiring ? "Retiring…" : "Yes, retire it"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setRetireConfirm(false)}
                          disabled={isRetiring}
                          className="min-h-[44px] px-4 rounded-control border border-line-strong text-ink text-sm font-medium hover:bg-surface-muted transition-colors cursor-pointer disabled:opacity-50"
                        >
                          Keep it active
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => { setRetireError(null); setRetireConfirm(true); }}
                        className="self-start min-h-[44px] px-4 rounded-control border border-line-strong text-ink text-sm font-semibold hover:bg-surface-muted transition-colors cursor-pointer"
                      >
                        Retire policy
                      </button>
                    )}
                  </div>
                </div>
              )}

              {current && (
                <ChangeHistory
                  title="Change history"
                  description="Uploads, budget changes and retirement for this policy."
                  types={POLICY_HISTORY_TYPES}
                  policyId={current.policy_id}
                  currency="MYR"
                  refreshKey={`${current.status}-${budgetsSignature(current)}`}
                  emptyText="No changes recorded for this policy yet. Changes made before change history was added aren't listed."
                />
              )}

              {/* ── Danger Zone ─────────────────────────────────────────────── */}
              {current && (
                <div className="rounded-card border border-danger/30 bg-surface overflow-hidden shrink-0">
                  <div className="px-4 sm:px-6 py-3 border-b border-danger/20 flex items-center gap-2">
                    <Trash2 size={15} className="text-danger" aria-hidden="true" />
                    <h3 className="font-display text-base font-semibold text-danger">Delete policy</h3>
                  </div>
                  <div className="px-4 sm:px-6 py-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                    <div>
                      <p className="font-body text-sm font-semibold text-ink">Delete this policy</p>
                      <p className="font-body text-xs text-ink-muted mt-0.5">This action is permanent and cannot be undone.</p>
                    </div>
                    <button
                      onClick={() => { setDeleteError(null); setDeletingPolicyId(current.policy_id); setDeletingPolicyName(current.alias); setDeleteModalOpen(true); }}
                      type="button"
                      className="shrink-0 flex items-center justify-center gap-2 min-h-[44px] px-4 rounded-control border border-danger/40 text-danger text-sm font-semibold font-body hover:bg-danger-soft transition-colors cursor-pointer"
                    >
                      <Trash2 size={15} aria-hidden="true" />
                      Delete Policy
                    </button>
                  </div>
                </div>
              )}

            </div>

            {/* Right Column: name (new) or AI overview and budgets (edit) */}
            <div
              ref={rightColRef}
              className="lg:col-span-5 flex flex-col gap-6 pr-2 pb-4 h-fit transition-transform duration-75 ease-out will-change-transform"
              style={{ transform: `translateY(${rightOffset}px)` }}
            >

              {isNew && (
                <div className="bg-surface rounded-card p-4 sm:p-6 shadow-ambient shrink-0">
                  <h3 className="font-display text-lg font-bold text-ink mb-5">Policy Details</h3>
                  <div className="flex flex-col gap-1.5">
                    <label htmlFor="new-policy-name" className="font-body text-sm font-medium text-ink">Policy name</label>
                    <input
                      id="new-policy-name"
                      type="text"
                      value={newName}
                      onChange={(e) => setNewName(e.target.value)}
                      placeholder="e.g. Travel and Expenses Policy"
                      maxLength={120}
                      className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink placeholder:text-ink-muted focus:border-accent outline-none"
                    />
                    <p className="text-xs text-ink-muted font-body">Left blank, the file name is used. Dates, categories and conditions are read from the document.</p>
                  </div>
                </div>
              )}

              {/* AI Overview Summary */}
              {current && (
                <div className="bg-surface rounded-card shadow-ambient overflow-hidden flex flex-col shrink-0">
                  <div className="px-5 py-4 border-b border-line">
                    <h3 className="font-display font-semibold text-base text-ink">AI Policy Insights</h3>
                    <p className="text-xs text-ink-muted mt-0.5">Generated from the policy document. Check before you rely on it.</p>
                  </div>

                  <div className="p-5 sm:p-6 flex flex-col gap-6">
                    {current.overview_summary && (() => {
                      const { intro, bullets } = parseBulletPoints(current.overview_summary);
                      return (
                        <div className="flex flex-col gap-6">
                          {intro && (
                            <p className="font-body text-sm text-ink leading-relaxed text-pretty">
                              {intro}
                            </p>
                          )}
                          {bullets.length > 0 && (
                            <div className="rounded-card p-4 shadow-ambient">
                              <h4 className="text-sm font-semibold text-ink mb-3">Key Takeaways</h4>
                              <PremiumBulletList items={bullets} />
                            </div>
                          )}
                        </div>
                      );
                    })()}

                    <div className="h-px bg-line w-full" />

                    <div>
                      <h4 className="font-display text-base font-semibold text-ink mb-5">Mandatory Conditions</h4>
                      <div className="flex flex-col gap-4">
                        {conditionEntries.length > 0 ? (
                          <>
                            {conditionEntries.slice(0, 3).map(([category, details]) => (
                              <div key={category} className="rounded-card p-4 shadow-ambient">
                                <h5 className="font-body font-semibold text-sm text-ink mb-3">
                                  {category}
                                </h5>
                                <PremiumBulletList items={details.condition} />
                              </div>
                            ))}
                            {conditionEntries.length > 3 && (
                              <button
                                type="button"
                                onClick={() => setConditionsModalOpen(true)}
                                className="w-full mt-2 min-h-[44px] rounded-control text-sm text-ink font-semibold border border-line-strong hover:bg-surface-muted transition-colors flex items-center justify-center gap-2 cursor-pointer"
                              >
                                <span>View All {conditionEntries.length} Categories</span>
                                <ChevronRight size={18} aria-hidden="true" />
                              </button>
                            )}
                          </>
                        ) : (
                          <p className="text-sm text-ink-muted font-body">
                            No mandatory conditions have been extracted for this policy.
                          </p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Auto-Approval Budgets Card */}
              {current && Object.keys(categoryBudgets).length > 0 && (
                <div className="bg-surface rounded-card shadow-ambient overflow-hidden flex flex-col shrink-0">
                  <div className="px-5 py-4 border-b border-line">
                    <h3 className="font-display font-semibold text-base text-ink">Auto-Approval Budgets</h3>
                    <p className="text-xs text-ink-muted">Max per category for auto-approval. Blank = unlimited.</p>
                  </div>
                  <div className="p-5 flex flex-col gap-3">
                    {Object.keys(categoryBudgets).map((cat) => (
                      <div key={cat} className="flex flex-col">
                        <label htmlFor={`budget-${cat}`} className="text-sm font-medium text-ink mb-1 block truncate">{cat}</label>
                        <div className="relative">
                          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-xs font-medium" aria-hidden="true">MYR</span>
                          <input
                            id={`budget-${cat}`}
                            type="number"
                            inputMode="decimal"
                            min="0"
                            step="0.01"
                            value={categoryBudgets[cat]}
                            onChange={(e) => setCategoryBudgets(prev => ({ ...prev, [cat]: e.target.value }))}
                            placeholder="Unlimited"
                            className="w-full min-h-[44px] pl-12 pr-3 bg-surface border border-line-strong rounded-control text-sm text-ink font-mono focus:border-accent outline-none placeholder:text-ink-muted"
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>

        {/* All mandatory conditions (read-only) */}
        {conditions && (
          <ConditionsModal
            isOpen={conditionsModalOpen}
            onClose={() => setConditionsModalOpen(false)}
            conditions={conditions}
          />
        )}

        {/* Delete Confirmation Modal */}
        {deleteModalOpen && <DeleteConfirmModal
          isOpen={deleteModalOpen}
          onClose={() => {
            if (!isDeleting) {
              setDeleteModalOpen(false);
              setDeletingPolicyId(null);
              setDeletingPolicyName("");
            }
          }}
          policyName={deletingPolicyName}
          isDeleting={isDeleting}
          deleteError={deleteError}
          onConfirm={handleConfirmDelete}
        />}

        {/* Bottom Action Bar */}
        <div className="shrink-0 bg-paper border-t border-line p-4 z-40">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 sm:gap-6 px-4 sm:px-8">
            <button type="button" onClick={() => setEditingPolicy(null)} className="min-h-[44px] px-6 border border-line-strong text-ink rounded-control font-body font-medium hover:bg-surface-muted transition-colors cursor-pointer">
              {isNew || Object.keys(categoryBudgets).length > 0 ? "Cancel" : "Close"}
            </button>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-6">
              {saveError && (
                <p role="alert" className="text-sm text-danger font-body max-w-xs text-center sm:text-right">{saveError}</p>
              )}
              {isNew ? (
                <button type="button" onClick={handleUpload} className="bg-accent text-on-accent rounded-full min-h-[44px] px-6 sm:px-8 font-body font-semibold hover:bg-accent-hover transition-colors cursor-pointer">
                  Create Policy
                </button>
              ) : Object.keys(categoryBudgets).length > 0 ? (
                <button
                  type="button"
                  onClick={handleSaveBudgets}
                  disabled={isSavingBudgets}
                  className="bg-accent text-on-accent rounded-full min-h-[44px] px-6 sm:px-8 font-body font-semibold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed"
                >
                  {isSavingBudgets ? "Saving…" : "Save Budgets"}
                </button>
              ) : null}
            </div>
          </div>
        </div>
      </div>
    );
  }

  const filteredPolicies = policies.filter(p => p.status === activeFilter && matchesSearch(p, searchQuery));

  return (
    <div className="min-h-full px-4 py-5 sm:px-6 md:px-8 md:py-8 font-body antialiased">
      <div className="layout-container flex h-full grow flex-col">
        <div className="flex flex-1 justify-center">
          <div className="layout-content-container flex flex-col w-full flex-1">
            <div className="flex-1 flex flex-col gap-5 max-w-[1440px] mx-auto w-full">
              {/* Header Section */}
              <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4">
                <div className="max-w-2xl">
                  <h1 className="font-display font-semibold text-2xl md:text-3xl text-ink">Policy Studio</h1>
                  <p className="mt-1 text-sm text-ink-muted font-body">
                    Manage, review, and distribute company guidelines.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={startNewPolicy}
                  className="flex items-center justify-center gap-2 rounded-full min-h-[44px] px-5 bg-accent text-on-accent font-body text-sm font-semibold hover:bg-accent-hover transition-colors cursor-pointer"
                >
                  <Plus size={18} aria-hidden="true" />
                  <span>Create New Policy</span>
                </button>
              </div>

              {/* Main content */}
              <div className="bg-surface shadow-ambient rounded-card p-4 sm:p-6 flex flex-col gap-5 overflow-hidden">
                {/* Toolbar Section */}
                <div className="flex flex-col lg:flex-row justify-between items-start lg:items-center gap-4">
                  {/* Search */}
                  <div className="flex items-center w-full lg:w-96 bg-surface border border-line-strong rounded-control px-3 focus-within:border-accent">
                    <Search size={18} className="text-ink-muted" aria-hidden="true" />
                    <input
                      aria-label="Search policies"
                      className="block w-full min-h-[44px] px-3 bg-transparent border-none focus:ring-0 focus:outline-none text-ink placeholder:text-ink-muted font-body"
                      placeholder="Search policies..."
                      type="text"
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                    />
                  </div>

                  <div role="group" aria-label="Filter by status" className="flex items-center bg-surface-muted rounded-control p-1 gap-1 w-full lg:w-auto overflow-x-auto [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden snap-x scroll-pl-1">
                    {(["Active", "Impending", "Expired"] as PolicyStatus[]).map((status) => (
                      <button
                        key={status}
                        type="button"
                        aria-pressed={activeFilter === status}
                        onClick={() => setActiveFilter(status)}
                        className={`flex-1 lg:flex-none min-h-[40px] px-5 rounded-control transition-colors font-medium text-sm cursor-pointer shrink-0 ${activeFilter === status
                          ? "bg-surface text-ink font-semibold border border-line"
                          : "text-ink-muted hover:text-ink"
                          }`}
                      >
                        {status}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Desktop Table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="w-full text-left border-collapse">
                    <thead>
                      <tr className="border-b border-line">
                        <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Name</th>
                        <th className="py-3 px-6 text-xs font-semibold text-ink-muted">
                          Effective
                        </th>
                        <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Status</th>
                        <th className="py-3 px-6 text-xs font-semibold text-ink-muted text-right">Action</th>
                      </tr>
                    </thead>
                    <tbody className="font-body text-ink">
                      {filteredPolicies.length > 0 ? (
                        filteredPolicies.slice(0, 3).map((policy) => (
                          <tr
                            key={policy.policy_id}
                            onClick={() => openPolicy(policy.policy_id)}
                            className="group transition-colors hover:bg-surface-muted cursor-pointer border-b border-line last:border-0"
                          >
                            <td className="py-5 px-6">
                              <div className="flex items-center gap-3">
                                <div>
                                  <p className="font-semibold text-base">{policy.alias}</p>
                                  {policyMeta(policy) && <p className="text-sm text-ink-muted mt-0.5">{policyMeta(policy)}</p>}
                                </div>
                              </div>
                            </td>
                            <td className="py-5 px-6 text-sm">{policy.lastModified}</td>
                            <td className="py-5 px-6">
                              <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${POLICY_STATUS_STYLE[policy.status]}`}>
                                {policy.status}
                              </span>
                            </td>
                            <td className="py-5 px-6 text-right">
                              <button
                                onClick={(e) => { e.stopPropagation(); openPolicy(policy.policy_id); }}
                                type="button"
                                aria-label={`Edit ${policy.alias}`}
                                className="inline-flex items-center min-h-[44px] px-3 rounded-control text-ink font-semibold text-sm underline-offset-2 hover:underline hover:bg-surface-muted cursor-pointer"
                              >
                                Edit
                              </button>
                            </td>
                          </tr>
                        ))
                      ) : (
                        <tr>
                          <td colSpan={4} className="py-12 text-center text-ink-muted font-medium">
                            {listMessage}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Mobile Card List */}
                <div className="md:hidden flex flex-col divide-y divide-line -mx-4 border-t border-line">
                  {filteredPolicies.length > 0 ? (
                    filteredPolicies.slice(0, 3).map((policy) => (
                      <button
                        key={policy.policy_id}
                        type="button"
                        onClick={() => openPolicy(policy.policy_id)}
                        className="px-4 py-3 text-left hover:bg-surface-muted transition-colors flex items-center gap-3 cursor-pointer"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm text-ink truncate">{policy.alias}</p>
                          {policyMeta(policy) && <p className="text-xs text-ink-muted mt-0.5">{policyMeta(policy)}</p>}
                        </div>
                        <div className="flex flex-col items-end gap-1.5 shrink-0">
                          <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold ${POLICY_STATUS_STYLE[policy.status]}`}>
                            {policy.status}
                          </span>
                          <span className="text-ink font-semibold text-xs underline underline-offset-2">Edit</span>
                        </div>
                      </button>
                    ))
                  ) : (
                    <div className="py-12 text-center text-ink-muted font-medium text-sm">
                      {listMessage}
                    </div>
                  )}
                </div>

                {/* View All Button */}
                <div className="pt-4 text-center border-t border-line">
                  <button
                    type="button"
                    onClick={() => setModalOpen(true)}
                    className="inline-flex items-center gap-2 min-h-[44px] text-sm font-semibold text-ink px-4 rounded-control border border-line-strong hover:bg-surface-muted transition-colors cursor-pointer"
                  >
                    View All {activeFilter} Policies
                    <ChevronRight className="w-4 h-4" strokeWidth={2.25} aria-hidden="true" />
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* View All Modal */}
      <ViewAllModal
        isOpen={modalOpen}
        onClose={() => setModalOpen(false)}
        policies={filteredPolicies}
        title={`All ${activeFilter} Policies`}
        onEdit={(id) => {
          setModalOpen(false);
          openPolicy(id);
        }}
      />
    </div>
  );
}


// ─── Delete Confirm Modal ─────────────────────────────────────────────────────

function DeleteConfirmModal({
  isOpen,
  onClose,
  policyName,
  isDeleting,
  deleteError,
  onConfirm,
}: {
  isOpen: boolean;
  onClose: () => void;
  policyName: string;
  isDeleting: boolean;
  deleteError: string | null;
  onConfirm: () => void;
}) {
  // The parent mounts this only while open, so the typed name starts empty each time.
  const [typedName, setTypedName] = React.useState("");

  if (!isOpen) return null;

  const confirmed = typedName.trim() === policyName.trim() && policyName.trim() !== "";

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4 sm:p-6">
      <div
        className="absolute inset-0 bg-ink/50 cursor-pointer"
        onClick={!isDeleting ? onClose : undefined}
      />
      <div role="dialog" aria-modal="true" aria-labelledby="delete-policy-title" className="relative w-full max-w-md bg-surface rounded-dialog border border-line shadow-overlay overflow-hidden">
        {/* Header */}
        <div className="px-6 pt-6 pb-5 border-b border-danger/15 flex items-start gap-4">
          <Trash2 size={20} className="text-danger shrink-0 mt-1" aria-hidden="true" />
          <div className="flex-1 min-w-0">
            <h3 id="delete-policy-title" className="font-display font-semibold text-lg text-ink">Delete Policy</h3>
            <p className="font-body text-sm text-ink-muted mt-0.5 leading-relaxed">
              This will permanently remove <span className="font-semibold text-ink">&ldquo;{policyName}&rdquo;</span> and all its associated data. This action cannot be undone.
            </p>
          </div>
          {!isDeleting && (
            <button type="button" onClick={onClose} aria-label="Close" className="w-11 h-11 -mt-2 -mr-2 inline-flex items-center justify-center rounded-control text-ink-muted hover:bg-surface-muted transition-colors cursor-pointer shrink-0">
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>

        {/* Body */}
        <div className="px-6 py-5 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label htmlFor="delete-policy-confirm" className="font-body text-sm font-medium text-ink">
              Type the policy name to confirm
            </label>
            <input
              id="delete-policy-confirm"
              type="text"
              value={typedName}
              onChange={(e) => setTypedName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && confirmed && !isDeleting) onConfirm(); }}
              placeholder={policyName}
              disabled={isDeleting}
              className={`bg-surface border rounded-control px-3 min-h-[44px] text-sm font-body text-ink placeholder:text-ink-muted outline-none disabled:opacity-50 ${typedName.length > 0
                ? confirmed
                  ? "border-danger"
                  : "border-line-strong"
                : "border-line-strong focus:border-accent"
                }`}
            />
            {typedName.length > 0 && !confirmed && (
              <p className="text-xs text-danger font-body">Name doesn&apos;t match. Check spelling and case.</p>
            )}
          </div>

          {deleteError && (
            <div className="flex items-start gap-2 bg-danger-soft border border-danger/20 rounded-control px-4 py-3">
              <AlertCircle size={15} className="text-danger shrink-0 mt-0.5" />
              <p role="alert" className="font-body text-sm text-danger">{deleteError}</p>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 pb-6 flex items-center justify-between gap-3">
          <button
            onClick={onClose}
            disabled={isDeleting}
            type="button"
            className="min-h-[44px] px-5 rounded-control border border-line-strong text-ink font-body text-sm font-medium hover:bg-surface-muted transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!confirmed || isDeleting}
            type="button"
            className="flex items-center gap-2 min-h-[44px] px-5 rounded-control bg-danger text-on-accent font-body text-sm font-semibold transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer hover:bg-danger/90"
          >
            {isDeleting ? (
              <>
                <div className="w-4 h-4 rounded-full border-2 border-on-accent/30 border-t-on-accent animate-spin" aria-hidden="true" />
                Deleting…
              </>
            ) : (
              <>
                <Trash2 size={15} />
                Delete Policy
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Mandatory Conditions Modal (read-only) ─────────────────────────────────────

function ConditionsModal({
  isOpen,
  onClose,
  conditions,
}: {
  isOpen: boolean;
  onClose: () => void;
  conditions: MandatoryConditions;
}) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-ink/40 cursor-pointer" onClick={onClose} />

      <div role="dialog" aria-modal="true" aria-labelledby="conditions-title" className="relative w-full max-w-2xl max-h-[85vh] bg-surface rounded-dialog border border-line shadow-overlay flex flex-col overflow-hidden">
        <div className="px-5 sm:px-8 py-4 sm:py-6 border-b border-line flex items-center justify-between gap-3 shrink-0">
          <div>
            <h3 id="conditions-title" className="font-display font-semibold text-xl sm:text-2xl text-ink">Mandatory Conditions</h3>
            <p className="text-sm text-ink-muted font-body">Extracted from the policy document by AI. Check before you rely on them.</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="w-11 h-11 shrink-0 rounded-control flex items-center justify-center text-ink-muted hover:bg-surface-muted transition-colors cursor-pointer"
          >
            <X size={20} aria-hidden="true" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5 sm:p-8 flex flex-col gap-6">
          {Object.entries(conditions).map(([category, details]) => (
            <div key={category} className="rounded-card p-4 sm:p-5 shadow-ambient">
              <h4 className="font-display font-semibold text-lg text-ink mb-4">{category}</h4>
              <PremiumBulletList items={details.condition} />
            </div>
          ))}
        </div>

        <div className="px-5 sm:px-6 py-4 border-t border-line flex justify-end shrink-0">
          <button
            onClick={onClose}
            type="button"
            className="min-h-[44px] px-6 bg-accent text-on-accent rounded-full font-body font-semibold hover:bg-accent-hover transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── View All Modal Component ───────────────────────────────────────────────────

function ViewAllModal({
  isOpen,
  onClose,
  title,
  policies,
  onEdit,
}: {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  policies: Policy[];
  onEdit: (id: string) => void;
}) {
  const [modalQuery, setModalQuery] = useState("");

  if (!isOpen) return null;

  const filtered = policies.filter(p => matchesSearch(p, modalQuery));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 sm:p-6">
      <div className="absolute inset-0 bg-ink/40 cursor-pointer" onClick={onClose} />

      <div role="dialog" aria-modal="true" aria-labelledby="view-all-title" className="relative w-full max-w-4xl max-h-[85dvh] flex flex-col bg-surface rounded-dialog border border-line shadow-overlay overflow-hidden">
        <div className="flex items-center justify-between px-6 py-5 border-b border-line shrink-0">
          <div>
            <h3 id="view-all-title" className="font-display font-semibold text-lg text-ink">{title}</h3>
            <p className="text-xs text-ink-muted mt-0.5">{filtered.length} total records</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="w-11 h-11 inline-flex items-center justify-center rounded-control text-ink hover:bg-surface-muted transition-colors cursor-pointer">
            <X className="w-5 h-5" strokeWidth={2} aria-hidden="true" />
          </button>
        </div>

        <div className="px-6 py-4 bg-paper border-b border-line shrink-0">
          <div className="flex items-center gap-2.5 bg-surface rounded-control px-3 border border-line-strong focus-within:border-accent">
            <Search className="w-4 h-4 text-ink-muted shrink-0" strokeWidth={2} aria-hidden="true" />
            <input
              type="text"
              aria-label="Search policies"
              placeholder="Search by name or category..."
              value={modalQuery}
              onChange={(e) => setModalQuery(e.target.value)}
              className="flex-1 min-h-[44px] bg-transparent text-sm text-ink placeholder:text-ink-muted outline-none font-body"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto min-h-0">
          <table className="w-full text-left border-collapse">
            <thead className="sticky top-0 z-10">
              <tr className="bg-surface-muted">
                <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Name</th>
                <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Effective</th>
                <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Status</th>
                <th className="py-3 px-6 text-xs font-semibold text-ink-muted text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {filtered.map((policy) => (
                <tr key={policy.policy_id} className="hover:bg-surface-muted transition-colors cursor-default">
                  <td className="py-4 px-6">
                    <div className="flex items-center gap-3">
                      <div>
                        <p className="font-semibold text-ink text-sm">{policy.alias}</p>
                        {policyMeta(policy) && <p className="text-xs text-ink-muted mt-0.5">{policyMeta(policy)}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="py-4 px-6 text-sm text-ink-muted">{policy.lastModified}</td>
                  <td className="py-4 px-6">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-bold ${POLICY_STATUS_STYLE[policy.status]}`}>
                      {policy.status}
                    </span>
                  </td>
                  <td className="py-4 px-6 text-right">
                    <button
                      type="button"
                      onClick={() => onEdit(policy.policy_id)}
                      aria-label={`Edit ${policy.alias}`}
                      className="inline-flex items-center min-h-[44px] px-3 rounded-control text-ink font-semibold text-sm underline-offset-2 hover:underline hover:bg-surface-muted cursor-pointer"
                    >
                      Edit
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="px-6 py-4 border-t border-line shrink-0 flex items-center justify-end bg-paper">
          <button type="button" onClick={onClose} className="min-h-[44px] px-6 rounded-full bg-accent text-on-accent text-sm font-semibold hover:bg-accent-hover transition-colors cursor-pointer">
            Done
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Beautified UI Components ───────────────────────────────────────────────────

function parseBulletPoints(text: string) {
  const lines = text.split('\n');
  const introLines: string[] = [];
  const bullets: string[] = [];

  lines.forEach(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('-') || trimmed.startsWith('•') || trimmed.startsWith('*')) {
      // Remove the marker and trim
      const content = trimmed.replace(/^[-•*]\s*/, '');
      if (content) bullets.push(content);
    } else if (trimmed) {
      introLines.push(trimmed);
    }
  });

  return {
    intro: introLines.join(' '),
    bullets
  };
}

function PremiumBulletList({ items }: { items: string[] }) {
  return (
    <div className="flex flex-col gap-3.5">
      {items.map((item, i) => (
        <div key={i} className="flex gap-3 items-start">
          <CheckCircle2 className="mt-0.5 w-4 h-4 shrink-0 text-ink-muted" strokeWidth={2} aria-hidden="true" />
          <p className="text-sm text-ink font-body leading-relaxed">
            {item}
          </p>
        </div>
      ))}
    </div>
  );
}
