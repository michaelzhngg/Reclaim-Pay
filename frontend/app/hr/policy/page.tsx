"use client";

import React, { JSX, useRef, useState, useEffect } from 'react';
import { Plus, Search, ChevronUp, ChevronDown, ChevronRight, FileText, Shield, Archive, Pencil, Trash2, ArrowLeft, X, SlidersHorizontal, Upload, Settings, CheckCircle2, History, Clock, User, PlusCircle, AlertCircle, ShieldCheck, Users, Calendar, BarChart3 } from 'lucide-react';
import { POLICY_STATUS_STYLE, type Policy, type PolicyStatus } from '../hr_components/mockData';
import type { Policy as BackendPolicy } from '@/lib/api/types';
import { uploadPolicy } from '@/lib/actions/hr';
import { getPolicies, deletePolicy, updatePolicyCategories } from '@/lib/actions/policies';

const SAVE_STEPS = [
  { id: "upload", label: "Uploading documents...", subtitle: "Securely storing policy files." },
  { id: "analyze", label: "Analyzing policy...", subtitle: "Extracting summary and conditions." },
  { id: "save", label: "Saving changes...", subtitle: "Updating policy database." },
];

export function HrProcessingScreen({ currentStep, onBack }: { currentStep: number, onBack: () => void }) {
  return (
    <div className="w-full max-w-xl mx-auto flex flex-col justify-center my-8 sm:my-12">
      <div className="rounded-card shadow-ambient bg-surface p-5 sm:p-8" role="status" aria-live="polite">
        <div className="flex items-center gap-3 mb-8">
          <Settings className="w-5 h-5 text-ink-muted shrink-0 motion-safe:animate-spin [animation-duration:3s]" strokeWidth={2} aria-hidden="true" />
          <div>
            <h2 className="font-display text-xl font-semibold text-ink leading-tight">Saving changes</h2>
            <p className="text-ink-muted text-sm font-body mt-0.5">Please do not close this window.</p>
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

        <div className="mt-10 flex justify-center">
          <button
            type="button"
            onClick={onBack}
            className="min-h-[44px] px-5 border border-line-strong text-ink text-sm font-semibold rounded-control hover:bg-surface-muted transition-colors cursor-pointer"
          >
            Abort and Go Back
          </button>
        </div>
      </div>
    </div>
  );
}

export default function PolicyStudio() {
  const [editingPolicy, setEditingPolicy] = useState<string | null>(null);
  const [activeFilter, setActiveFilter] = useState<PolicyStatus>("Active");
  const [searchQuery, setSearchQuery] = useState("");
  const [modalOpen, setModalOpen] = useState(false);

  // File upload state
  const [mainPolicyFile, setMainPolicyFile] = useState<File | null>(null);
  const [appendixFiles, setAppendixFiles] = useState<File[]>([]);
  const mainPolicyInputRef = useRef<HTMLInputElement>(null);
  const appendixInputRef = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (mainPolicyFile && mainPolicyFile.type === "application/pdf") {
      const url = URL.createObjectURL(mainPolicyFile);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [mainPolicyFile]);

  // Form state
  const [editName, setEditName] = useState("");
  const [editDepartment, setEditDepartment] = useState("");
  const [editVersion, setEditVersion] = useState("");
  const [editDate, setEditDate] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [isLoadingDetails, setIsLoadingDetails] = useState(false);
  const [savingStep, setSavingStep] = useState(0);
  const [policyFileError, setPolicyFileError] = useState<string | null>(null);
  const POLICY_MAX_SIZE = 10 * 1024 * 1024; // 10 MB
  const [conditionsModalOpen, setConditionsModalOpen] = useState(false);
  const [editConditions, setEditConditions] = useState<Record<string, any> | null>(null);
  const [categoryBudgets, setCategoryBudgets] = useState<Record<string, string>>({});
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [editOverviewSummary, setEditOverviewSummary] = useState<string>("");
  const [existingMainPolicyFilename, setExistingMainPolicyFilename] = useState<string>("");
  const [editHistory, setEditHistory] = useState<{ user: string, action: string, date: string, details?: string }[]>([]);

  // Delete confirmation state
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingPolicyId, setDeletingPolicyId] = useState<string | null>(null);
  const [deletingPolicyName, setDeletingPolicyName] = useState<string>("");

  // Existing files state (for edit view)
  const [existingMainPolicyDeleted, setExistingMainPolicyDeleted] = useState(false);
  const [existingAppendix, setExistingAppendix] = useState<{ name: string, size: string }[]>([
    { name: "W10_Requirements_Review.pdf", size: "1.2 MB" },
    { name: "Ergonomic_Guidelines_2023.pdf", size: "845 KB" }
  ]);

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
      const containerH = container.clientHeight;
      const scrollT = container.scrollTop;
      const maxScroll = container.scrollHeight - containerH;

      if (maxScroll <= 0) return;

      const ratio = Math.min(Math.max(scrollT / maxScroll, 0), 1);

      if (leftH > rightH) {
        // Left is longer, move Right down so they finish together
        const diff = leftH - rightH;
        setRightOffset(diff * ratio);
        setLeftOffset(0);
      } else if (rightH > leftH) {
        // Right is longer, move Left down
        const diff = rightH - leftH;
        setLeftOffset(diff * ratio);
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

    // Initial calculation
    setTimeout(handleScroll, 100);

    return () => {
      container.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
      observer.disconnect();
    };
  }, [editingPolicy, editConditions, appendixFiles, existingAppendix, existingMainPolicyDeleted, editName, editDepartment]);

  useEffect(() => {
    if (editingPolicy) {
      setIsLoadingDetails(true);
      const timer = setTimeout(() => setIsLoadingDetails(false), 600);
      return () => clearTimeout(timer);
    }
  }, [editingPolicy]);

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function parseMandatoryConditions(raw: string | Record<string, any> | undefined | null): Record<string, any> | null {
    if (!raw) return null;
    if (typeof raw === 'object') return raw as Record<string, any>;
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch {
      // Not valid JSON, ignore
    }
    return null;
  }

  // Map the backend Policy (lib/api/types) to the shape this page renders.
  function toLocalPolicy(p: BackendPolicy): Policy {
    return {
      policy_id: p.policy_id,
      alias: p.alias,
      title: p.title,
      version: "",
      department: "",
      lastModified: p.effective_date
        ? new Date(p.effective_date).toLocaleDateString("en-MY", { month: "short", day: "numeric", year: "numeric" })
        : "",
      status: (p.status === "ACTIVE" ? "Active" : p.status === "DEPRECATED" ? "Expired" : "Impending") as PolicyStatus,
      icon: FileText,
      overview_summary: p.overview_summary,
      mandatory_conditions: parseMandatoryConditions(p.mandatory_conditions) ?? undefined,
      reimbursable_categories_with_budgets: p.reimbursable_categories_with_budgets ?? [],
      history: [],
      source_file_url: p.source_file_url,
      effective_date: p.effective_date,
    };
  }

  const [policies, setPolicies] = useState<Policy[]>([]);
  const [policiesStatus, setPoliciesStatus] = useState<"loading" | "ready" | "error">("loading");
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    getPolicies()
      .then((backendPolicies) => {
        setPolicies(backendPolicies.map(toLocalPolicy));
        setPoliciesStatus("ready");
      })
      .catch(() => setPoliciesStatus("error"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const listMessage =
    policiesStatus === "loading"
      ? "Loading policies..."
      : policiesStatus === "error"
        ? "Couldn't load policies. Refresh the page to try again."
        : policies.length === 0
          ? "No policies yet. Create one to start checking claims."
          : "No policies found matching your search or filter.";

  // Status dropdown & edit states
  const [editStatus, setEditStatus] = useState<PolicyStatus>("Active");
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);

  useEffect(() => {
    if (editingPolicy && editingPolicy !== "new") {
      const p = policies.find(x => x.policy_id === editingPolicy);
      if (p) {
        setEditStatus(p.status);
        setEditName(p.alias);
        setEditDepartment(p.department || "");
        setEditVersion(p.version || "");
        setEditDate(p.effective_date ? new Date(p.effective_date).toISOString().slice(0, 10) : "");
        setExistingMainPolicyDeleted(false);
        setEditOverviewSummary(p.overview_summary || "");
        setEditConditions(p.mandatory_conditions || null);
        setEditingPolicyId(p.policy_id || null);
        setExistingMainPolicyFilename(
          p.source_file_url ? p.source_file_url.split(/[\\/]/).pop() ?? "" : ""
        );

        // Initialize budgets from policy data (or from categories)
        const budgets: Record<string, string> = {};
        if (p.reimbursable_categories_with_budgets) {
          p.reimbursable_categories_with_budgets.forEach((cat: any) => {
            budgets[cat.category] = cat.auto_approval_budget?.toString() ?? "";
          });
        } else if (p.mandatory_conditions) {
          Object.keys(p.mandatory_conditions).forEach(cat => {
            budgets[cat] = "";
          });
        }
        setCategoryBudgets(budgets);

        setEditHistory(p.history ?? []);
        setExistingAppendix(p.existingAppendix ?? []);
        setAppendixFiles(p.appendixFiles || []);
        setMainPolicyFile(p.mainFile || null);
      }
    } else if (editingPolicy === "new") {
      setEditStatus("Active");
      setEditName("");
      setEditDepartment("");
      setEditVersion("");
      setEditDate("");
      setEditOverviewSummary("");
      setEditConditions(null);
      setEditingPolicyId(null);
      setCategoryBudgets({});
      setExistingMainPolicyFilename("");
      setMainPolicyFile(null);
      setAppendixFiles([]);
    }
    setStatusDropdownOpen(false);
  }, [editingPolicy, policies]);

  const StatusDropdown = () => (
    <div className="relative">
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={statusDropdownOpen}
        aria-label={`Policy status: ${editStatus}`}
        onClick={() => setStatusDropdownOpen(!statusDropdownOpen)}
        className={`flex items-center justify-between gap-2 min-h-[44px] rounded-control px-3 text-sm font-body font-medium transition-colors w-[140px] cursor-pointer border ${statusDropdownOpen ? 'bg-surface-muted border-line-strong' : 'bg-surface border-line-strong hover:bg-surface-muted'
          }`}
      >
        <div className="flex items-center gap-2">
          <span className={`w-2 h-2 rounded-full ${editStatus === 'Active' ? 'bg-success' : editStatus === 'Impending' ? 'bg-warning' : 'bg-line'}`} />
          <span className="text-ink">{editStatus}</span>
        </div>
        <ChevronDown className={`text-ink-muted transition-transform ${statusDropdownOpen ? 'rotate-180' : ''}`} size={16} />
      </button>

      {statusDropdownOpen && (
        <div className="absolute bottom-full mb-2 left-0 w-full bg-surface shadow-ambient rounded-card shadow-overlay py-1 z-50">
          {(["Active", "Impending", "Expired"] as PolicyStatus[]).map((s) => (
            <button
              key={s}
              onClick={() => {
                setEditStatus(s);
                setStatusDropdownOpen(false);
              }}
              type="button"
              className="w-full text-left min-h-[44px] px-4 text-sm font-body text-ink hover:bg-surface-muted transition-colors flex items-center gap-2 cursor-pointer"
            >
              <span className={`w-2 h-2 rounded-full ${s === 'Active' ? 'bg-success' : s === 'Impending' ? 'bg-warning' : 'bg-line'}`} />
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );

  const handleSave = async () => {
    if (!editingPolicy) return;
    setSaveError(null);
    setIsSaving(true);
    setSavingStep(0);

    // ── New policy: upload to backend ──────────────────────────────────────
    if (editingPolicy === "new" && mainPolicyFile) {
      const form = new FormData();
      form.append("files", mainPolicyFile);
      form.append("alias", editName || "New Policy");
      // Append appendix files too
      appendixFiles.forEach((f) => form.append("files", f));

      setSavingStep(1);
      const result = await uploadPolicy(form);
      setSavingStep(2);
      await new Promise((r) => setTimeout(r, 800)); // brief delay for UI

      if (!result.ok) {
        setSaveError(result.error ?? "Upload failed. Please try again.");
        setIsSaving(false);
        return;
      }

      // Refresh policy list from backend
      try {
        const updated = await getPolicies();
        setPolicies(updated.map(toLocalPolicy));
      } catch { /* keep existing list */ }

      setIsSaving(false);
      setEditingPolicy(null);
      return;
    }

    // ── Edit existing ────────────────────────────────────────────────────
    setSavingStep(1);

    // Save category budgets to backend
    if (editingPolicyId && Object.keys(categoryBudgets).length > 0) {
      const categoriesWithBudgets = Object.entries(categoryBudgets).map(([category, budget]) => ({
        category,
        auto_approval_budget: budget !== "" ? parseFloat(budget) : null,
      }));
      const budgetResult = await updatePolicyCategories(editingPolicyId, categoriesWithBudgets);
      if (!budgetResult.ok) {
        setSaveError(budgetResult.error ?? "Failed to update category budgets");
        setIsSaving(false);
        return;
      }
    }

    setSavingStep(2);
    await new Promise(r => setTimeout(r, 500));

    // Record History
    const now = new Date();
    const formattedDate = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
      ' ' + now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });

    const newHistoryEntry = {
      user: "HR Admin",
      action: editingPolicy === "new" ? "Policy Created" : "Policy Updated",
      date: formattedDate,
      details: editingPolicy === "new" ? `Initial policy creation: ${editName}` : `Modified policy: ${editName}`
    };
    const updatedHistory = [newHistoryEntry, ...editHistory];

    if (editingPolicy === "new") {
      const newPolicy: Policy = {
        policy_id: "pol-" + Math.random().toString(36).substr(2, 9),
        alias: editName || "New Policy",
        title: editName || "New Policy",
        version: editVersion || "V1.0",
        department: editDepartment || "General",
        lastModified: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
        status: editStatus,
        icon: FileText,
        mainFile: mainPolicyFile,
        appendixFiles: appendixFiles,
        existingAppendix: existingAppendix,
        mandatory_conditions: editConditions || undefined,
        history: updatedHistory
      };
      setPolicies([newPolicy, ...policies]);
    } else {
      const updatedPolicyData = {
        status: editStatus,
        alias: editName,
        title: editName,
        department: editDepartment,
        version: editVersion,
        existingAppendix: existingAppendix,
        mandatory_conditions: editConditions || undefined,
        history: updatedHistory
      };

      // Persist edit to LocalStorage
      const localEdits = JSON.parse(localStorage.getItem('local_policy_edits') || '{}');
      localEdits[editingPolicy] = updatedPolicyData;
      localStorage.setItem('local_policy_edits', JSON.stringify(localEdits));

      setPolicies(policies.map(p => p.policy_id === editingPolicy ? {
        ...p,
        ...updatedPolicyData,
        mainFile: mainPolicyFile,
        appendixFiles: appendixFiles,
      } : p));
    }

    setIsSaving(false);
    setEditingPolicy(null);
  };

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
    
    // Remove from local state
    setPolicies(prev => prev.filter(p => p.policy_id !== deletingPolicyId));
    
    // Persist deletion in LocalStorage (like the edit-view delete does)
    const deletedIds = JSON.parse(localStorage.getItem('deleted_policy_ids') || '[]');
    if (!deletedIds.includes(deletingPolicyId)) {
      deletedIds.push(deletingPolicyId);
      localStorage.setItem('deleted_policy_ids', JSON.stringify(deletedIds));
    }
    
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

    if (isSaving) {
      return (
        <div className="flex-1 flex flex-col relative w-full h-full bg-paper text-ink overflow-hidden p-6 animate-in fade-in duration-500">
          <style>{`
             @keyframes pulse-scan {
               0% { transform: translateY(-100%); opacity: 0; }
               50% { opacity: 1; }
               100% { transform: translateY(400px); opacity: 0; }
             }
             .animate-pulse-scan {
               animation: pulse-scan 3s linear infinite;
             }
           `}</style>
          <HrProcessingScreen currentStep={savingStep} onBack={() => setIsSaving(false)} />
        </div>
      );
    }

    if (isLoadingDetails) {
      return (
        <div className="flex-1 flex flex-col p-6 max-w-7xl mx-auto w-full h-full bg-paper">
          <div className="flex items-center gap-4 mb-8">
            <div className="h-8 w-48 bg-surface-muted animate-pulse rounded-lg" />
          </div>
          <div className="grid grid-cols-12 gap-8 h-full">
            <div className="col-span-7 flex flex-col gap-8">
              <div className="h-64 bg-surface-muted animate-pulse rounded-card" />
              <div className="h-96 bg-surface-muted animate-pulse rounded-card" />
            </div>
            <div className="col-span-5 flex flex-col gap-8">
              <div className="h-48 bg-surface-muted animate-pulse rounded-card" />
              <div className="h-64 bg-surface-muted animate-pulse rounded-card" />
            </div>
          </div>
        </div>
      );
    }

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

          <div className="flex items-center gap-4 mb-6">
            <h1 className="font-display text-2xl md:text-3xl leading-tight font-semibold text-ink break-words">
              {isNew ? "Create New Policy" : `${editName || "Edit Policy"}`}
            </h1>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 flex-1 min-h-0 items-start">
            {/* Left Column: Policy Details (if edit), Main Policy & Appendix */}
            <div
              ref={leftColRef}
              className="lg:col-span-7 flex flex-col gap-8 pr-2 pb-4 h-fit transition-transform duration-75 ease-out will-change-transform"
              style={{ transform: `translateY(${leftOffset}px)` }}
            >

              {/* Form Details (Only shown here in Edit View) */}
              {!isNew && (
                <div className="bg-surface rounded-card p-4 sm:p-6 shadow-ambient shrink-0">
                  <h3 className="font-display text-lg font-bold text-ink mb-5">Policy Details</h3>
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-1.5">
                      <label className="font-body text-sm font-medium text-ink">Policy Name</label>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="e.g. Remote Work Policy"
                        className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink placeholder:text-ink-muted focus:border-accent outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="font-body text-sm font-medium text-ink">Department</label>
                      <input
                        type="text"
                        value={editDepartment}
                        onChange={(e) => setEditDepartment(e.target.value)}
                        placeholder="e.g. Human Resources"
                        className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink placeholder:text-ink-muted focus:border-accent outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="font-body text-sm font-medium text-ink">Version</label>
                      <input
                        type="text"
                        value={editVersion}
                        onChange={(e) => setEditVersion(e.target.value)}
                        placeholder="e.g. v1.0"
                        className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink placeholder:text-ink-muted focus:border-accent outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="font-body text-sm font-medium text-ink">Effective Date</label>
                      <input
                        type="date"
                        value={editDate}
                        onChange={(e) => setEditDate(e.target.value)}
                        className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink focus:border-accent outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {policyFileError && (
                <div className="flex items-start gap-3 bg-danger/10 border border-danger/30 text-danger rounded-control px-4 py-3 text-sm font-body">
                  <span className="shrink-0 font-bold">✕</span>
                  <span className="flex-1">{policyFileError}</span>
                  <button onClick={() => setPolicyFileError(null)} className="shrink-0 font-bold hover:opacity-70">✕</button>
                </div>
              )}

              {/* Main Policy */}
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
                      setMainPolicyFile(file);
                    }
                    e.target.value = '';
                  }}
                />

                {mainPolicyFile ? (
                  <div className="flex flex-col gap-4 shadow-ambient rounded-card overflow-hidden bg-surface">
                    {mainPolicyFile.type === "application/pdf" && previewUrl ? (
                      <iframe
                        src={previewUrl}
                        className="w-full h-[400px] border-b border-line"
                      />
                    ) : (
                      <div className="w-full h-[400px] border-b border-line bg-surface-muted flex flex-col items-center justify-center">
                        <FileText className="text-ink-muted mb-3" size={48} aria-hidden="true" />
                        <p className="font-body text-base font-medium text-ink">{mainPolicyFile.name}</p>
                        <p className="font-body text-xs text-ink-muted">Preview not available</p>
                      </div>
                    )}
                    <div className="p-4 flex items-center justify-between">
                      <div className="flex flex-col">
                        <p className="font-body text-sm font-medium text-ink truncate">{mainPolicyFile.name}</p>
                        <p className="font-body text-xs text-ink-muted">{formatFileSize(mainPolicyFile.size)}</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => mainPolicyInputRef.current?.click()} type="button" className="min-h-[44px] px-4 border border-line-strong text-ink rounded-control font-body text-sm font-medium hover:bg-surface-muted transition-colors cursor-pointer">
                          Replace
                        </button>
                        <button onClick={() => setMainPolicyFile(null)} type="button" className="min-h-[44px] px-4 text-danger font-body text-sm font-medium hover:bg-danger-soft rounded-control transition-colors cursor-pointer">
                          Remove
                        </button>
                      </div>
                    </div>
                  </div>
                ) : !isNew && !existingMainPolicyDeleted ? (
                  <div className="flex flex-col gap-4 shadow-ambient rounded-card overflow-hidden bg-surface">
                    {/* PDF Viewer for existing file */}
                    <div className="w-full h-[400px] border-b border-line bg-surface flex flex-col items-center justify-center p-8 text-center relative overflow-hidden group">
                      <FileText className="text-ink-muted mb-4" size={56} strokeWidth={1} aria-hidden="true" />
                      <p className="font-display text-lg font-medium text-ink mb-2">{existingMainPolicyFilename || "Policy Document"}</p>
                      <p className="font-body text-sm text-ink-muted mb-6">Existing Document</p>
                    </div>
                    <div className="p-4 flex items-center justify-between">
                      <div className="flex flex-col">
                        <p className="font-body text-sm font-medium text-ink truncate">{existingMainPolicyFilename || "Policy Document"}</p>
                        <p className="font-body text-xs text-ink-muted">Saved on server</p>
                      </div>
                      <div className="flex gap-2">
                        <button onClick={() => mainPolicyInputRef.current?.click()} type="button" className="min-h-[44px] px-4 border border-line-strong text-ink rounded-control font-body text-sm font-medium hover:bg-surface-muted transition-colors cursor-pointer">
                          Replace
                        </button>
                        <button onClick={() => setExistingMainPolicyDeleted(true)} type="button" className="min-h-[44px] px-4 text-danger font-body text-sm font-medium hover:bg-danger-soft rounded-control transition-colors cursor-pointer">
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div
                    onClick={() => mainPolicyInputRef.current?.click()}
                    className="bg-surface rounded-card p-8 flex flex-col items-center justify-center border-2 border-dashed border-line-strong hover:bg-surface-muted transition-colors cursor-pointer min-h-[240px]"
                  >
                    <Upload className="text-ink-muted mb-4" size={28} aria-hidden="true" />
                    <p className="font-body text-base font-medium text-ink mb-1">Upload Policy Document</p>
                    <p className="font-body text-xs text-ink-muted mb-4">Drag and drop or click to browse</p>
                    <p className="font-body text-xs text-ink-muted">Supports PDF · Max 10 MB</p>
                  </div>
                )}
              </div>

              {/* Appendix */}
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
                  {/* Upload button for Appendix */}
                  <button
                    type="button"
                    onClick={() => appendixInputRef.current?.click()}
                    className="w-full border-2 border-dashed border-line-strong bg-surface hover:bg-surface-muted rounded-card p-4 flex flex-col items-center justify-center transition-colors shrink-0 cursor-pointer"
                  >
                    <Plus className="text-ink-muted mb-2" size={20} aria-hidden="true" />
                    <p className="font-body font-medium text-ink text-sm">Add Source</p>
                    <p className="font-body text-xs text-ink-muted mt-1">Drag and drop or click to upload</p>
                  </button>

                  {/* Existing Appendix Items */}
                  {!isNew && existingAppendix.map((item, idx) => (
                    <div key={`existing-${idx}`} className="bg-surface rounded-control p-3 border border-line flex items-center justify-between gap-2">
                      <div className="flex items-center gap-3 min-w-0">
                        <FileText className="text-ink-muted shrink-0" size={18} />
                        <div className="min-w-0">
                          <span className="font-body text-sm font-medium text-ink truncate block">{item.name}</span>
                          <span className="font-body text-xs text-ink-muted">{item.size}</span>
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label={`Remove ${item.name}`}
                        onClick={() => setExistingAppendix(prev => prev.filter((_, i) => i !== idx))}
                        className="w-11 h-11 shrink-0 inline-flex items-center justify-center rounded-control text-ink-muted hover:text-danger hover:bg-danger-soft transition-colors cursor-pointer"
                      >
                        <Trash2 size={16} aria-hidden="true" />
                      </button>
                    </div>
                  ))}

                  {/* Newly uploaded appendix files */}
                  {appendixFiles.map((file, idx) => (
                    <div key={`edit-${file.name}-${idx}`} className="bg-surface rounded-control p-3 border border-line flex items-center justify-between gap-2">
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

              {/* Change History Panel (Moved to Bottom Left) */}

              {/* ── Danger Zone ─────────────────────────────────────────────── */}
              {!isNew && (
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
                      onClick={() => { setDeleteError(null); setDeletingPolicyId(editingPolicy); setDeletingPolicyName(editName); setDeleteModalOpen(true); }}
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

            {/* Right Column: Policy Details (if new) & AI Overview (if edit) */}
            <div
              ref={rightColRef}
              className="lg:col-span-5 flex flex-col gap-6 pr-2 pb-4 h-fit transition-transform duration-75 ease-out will-change-transform"
              style={{ transform: `translateY(${rightOffset}px)` }}
            >

              {/* Form Details (Only shown here in New/Upload View) */}
              {isNew && (
                <div className="bg-surface rounded-card p-4 sm:p-6 shadow-ambient shrink-0">
                  <h3 className="font-display text-lg font-bold text-ink mb-5">Policy Details</h3>
                  <div className="flex flex-col gap-5">
                    <div className="flex flex-col gap-1.5">
                      <label className="font-body text-sm font-medium text-ink">Policy Name</label>
                      <input
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        placeholder="e.g. Remote Work Policy"
                        className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink placeholder:text-ink-muted focus:border-accent outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="font-body text-sm font-medium text-ink">Department</label>
                      <input
                        type="text"
                        value={editDepartment}
                        onChange={(e) => setEditDepartment(e.target.value)}
                        placeholder="e.g. Human Resources"
                        className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink placeholder:text-ink-muted focus:border-accent outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="font-body text-sm font-medium text-ink">Version</label>
                      <input
                        type="text"
                        value={editVersion}
                        onChange={(e) => setEditVersion(e.target.value)}
                        placeholder="e.g. v1.0"
                        className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink placeholder:text-ink-muted focus:border-accent outline-none"
                      />
                    </div>
                    <div className="flex flex-col gap-1.5">
                      <label className="font-body text-sm font-medium text-ink">Effective Date</label>
                      <input
                        type="date"
                        value={editDate}
                        onChange={(e) => setEditDate(e.target.value)}
                        className="bg-surface border border-line-strong rounded-control px-3 min-h-[44px] text-sm font-body text-ink focus:border-accent outline-none"
                      />
                    </div>
                  </div>
                </div>
              )}

              {/* AI Overview Summary (Beautified) */}
              {!isNew && (
                <div className="bg-surface rounded-card shadow-ambient overflow-hidden flex flex-col shrink-0">
                  <div className="px-5 py-4 border-b border-line">
                    <h3 className="font-display font-semibold text-base text-ink">AI Policy Insights</h3>
                    <p className="text-xs text-ink-muted mt-0.5">Generated from the policy document. Check before you rely on it.</p>
                  </div>

                  <div className="p-5 sm:p-6 flex flex-col gap-6">
                    {editOverviewSummary && (() => {
                      const { intro, bullets } = parseBulletPoints(editOverviewSummary);
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

                    <>
                      <div className="h-px bg-line w-full" />

                      <div>
                        <div className="flex items-center justify-between mb-5">
                          <h4 className="font-display text-base font-semibold text-ink">Mandatory Conditions</h4>
                          <span className="px-2 py-0.5 bg-warning-soft rounded-full text-xs font-semibold text-warning">
                            Review required
                          </span>
                        </div>

                        <div className="flex flex-col gap-4">
                          {editConditions && Object.entries(editConditions).length > 0 ? (
                            <>
                              {Object.entries(editConditions).slice(0, 3).map(([category, details]: [string, any]) => (
                                <div key={category} className="rounded-card p-4 shadow-ambient">
                                  <h5 className="font-body font-semibold text-sm text-ink mb-3">
                                    {category}
                                  </h5>
                                  <PremiumBulletList items={details.condition ?? []} />
                                </div>
                              ))}
                              {Object.entries(editConditions).length > 3 && (
                                <button
                                  type="button"
                                  onClick={() => setConditionsModalOpen(true)}
                                  className="w-full mt-2 min-h-[44px] rounded-control text-sm text-ink font-semibold border border-line-strong hover:bg-surface-muted transition-colors flex items-center justify-center gap-2 cursor-pointer"
                                >
                                  <span>View & Edit All {Object.entries(editConditions).length} Categories</span>
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
                    </>
                  </div>
                </div>
              )}

              {/* Auto-Approval Budgets Card */}
              {!isNew && Object.keys(categoryBudgets).length > 0 && (
                <div className="bg-surface rounded-card shadow-ambient overflow-hidden flex flex-col shrink-0">
                  <div className="px-5 py-4 border-b border-line">
                    <div>
                      <h3 className="font-display font-semibold text-base text-ink">Auto-Approval Budgets</h3>
                      <p className="text-xs text-ink-muted">Max per category for auto-approval. Blank = unlimited.</p>
                    </div>
                  </div>
                  <div className="p-5 flex flex-col gap-3">
                    {Object.keys(categoryBudgets).map((cat) => (
                      <div key={cat} className="flex items-center gap-3">
                        <div className="flex-1">
                          <label htmlFor={`budget-${cat}`} className="text-sm font-medium text-ink mb-1 block truncate">{cat}</label>
                          <div className="relative group">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-xs font-medium">MYR</span>
                            <input
                              id={`budget-${cat}`}
                              type="number"
                              min="0"
                              step="0.01"
                              value={categoryBudgets[cat]}
                              onChange={(e) => setCategoryBudgets(prev => ({ ...prev, [cat]: e.target.value }))}
                              placeholder="Unlimited"
                              className="w-full min-h-[44px] pl-12 pr-3 bg-surface border border-line-strong rounded-control text-sm text-ink font-mono focus:border-accent outline-none placeholder:text-ink-muted"
                            />
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

            </div>
          </div>
        </div>

        {/* Mandatory Conditions Modal */}
        {editConditions && (
          <ConditionsModal
            isOpen={conditionsModalOpen}
            onClose={() => setConditionsModalOpen(false)}
            conditions={editConditions}
            categoryBudgets={categoryBudgets}
            policyId={editingPolicyId}
            onSave={(newConditions, newBudgets) => {
              setEditConditions(newConditions);
              if (newBudgets) setCategoryBudgets(newBudgets);
              setConditionsModalOpen(false);
            }}
          />
        )}

        {/* Delete Confirmation Modal */}
        <DeleteConfirmModal
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
        />
        
        {/* Bottom Action Bar */}
        <div className="shrink-0 bg-paper border-t border-line p-4 z-40">
          <div className="max-w-7xl mx-auto flex flex-col sm:flex-row justify-between items-stretch sm:items-center gap-3 sm:gap-6 px-4 sm:px-8">
            <button type="button" onClick={() => setEditingPolicy(null)} className="min-h-[44px] px-6 border border-line-strong text-ink rounded-control font-body font-medium hover:bg-surface-muted transition-colors cursor-pointer">
              Cancel
            </button>
            <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3 sm:gap-6">
              {saveError && (
                <p role="alert" className="text-sm text-danger font-body max-w-xs text-center sm:text-right">{saveError}</p>
              )}
              <div className="flex items-center justify-center sm:justify-start gap-3">
                <span className="font-body text-sm text-ink-muted hidden sm:block">Policy Status:</span>
                <StatusDropdown />
              </div>
              <button type="button" onClick={handleSave} className="bg-accent text-on-accent rounded-full min-h-[44px] px-6 sm:px-8 font-body font-semibold hover:bg-accent-hover transition-colors cursor-pointer">
                {isNew ? "Create Policy" : "Save Changes"}
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const filteredPolicies = policies.filter(p => {
    const matchesStatus = p.status === activeFilter;
    const matchesSearch = p.alias.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.department.toLowerCase().includes(searchQuery.toLowerCase());
    return matchesStatus && matchesSearch;
  });

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
                  onClick={() => setEditingPolicy("new")}
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
                        <th className="py-3 px-6 text-xs font-semibold text-ink-muted cursor-pointer group">
                          <div className="flex items-center gap-1">
                            Last Modified
                            <div className="flex flex-col -space-y-2 opacity-50 group-hover:opacity-100 transition-opacity">
                              <ChevronUp size={14} className="mb-[-2px]" />
                              <ChevronDown size={14} className="text-ink" />
                            </div>
                          </div>
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
                            onClick={() => setEditingPolicy(policy.policy_id)}
                            className="group transition-colors hover:bg-surface-muted cursor-pointer border-b border-line last:border-0"
                          >
                            <td className="py-5 px-6">
                              <div className="flex items-center gap-3">
                                <div>
                                  <p className="font-semibold text-base">{policy.alias}</p>
                                  <p className="text-sm text-ink-muted mt-0.5">{policy.version} • {policy.department}</p>
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
                                onClick={(e) => { e.stopPropagation(); setEditingPolicy(policy.policy_id); }}
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
                        onClick={() => setEditingPolicy(policy.policy_id)}
                        className="px-4 py-3 text-left hover:bg-surface-muted transition-colors flex items-center gap-3 cursor-pointer"
                      >
                        <div className="flex-1 min-w-0">
                          <p className="font-semibold text-sm text-ink truncate">{policy.alias}</p>
                          <p className="text-xs text-ink-muted mt-0.5">{policy.version} · {policy.department}</p>
                          <p className="text-xs text-ink-muted mt-0.5">{policy.lastModified}</p>
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
          setEditingPolicy(id);
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
  const [typedName, setTypedName] = React.useState("");

  // Reset input each time modal opens
  React.useEffect(() => {
    if (isOpen) setTypedName("");
  }, [isOpen]);

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

// ─── Mandatory Conditions Modal ──────────────────────────────────────────────────

function ConditionsModal({
  isOpen,
  onClose,
  conditions,
  categoryBudgets,
  policyId,
  onSave
}: {
  isOpen: boolean;
  onClose: () => void;
  conditions: Record<string, any>;
  categoryBudgets: Record<string, string>;
  policyId: string | null;
  onSave: (newConditions: Record<string, any>, newBudgets?: Record<string, string>) => void;
}) {
  const [localConditions, setLocalConditions] = useState(conditions);
  const [localBudgets, setLocalBudgets] = useState<Record<string, string>>(categoryBudgets);
  const [isSaving, setIsSaving] = useState(false);
  const [newCategoryName, setNewCategoryName] = useState("");
  const [isAddingCategory, setIsAddingCategory] = useState(false);

  useEffect(() => {
    setLocalConditions(conditions);
  }, [conditions]);

  useEffect(() => {
    setLocalBudgets(categoryBudgets);
  }, [categoryBudgets]);

  if (!isOpen) return null;

  const handleUpdateCondition = (category: string, index: number, value: string) => {
    setLocalConditions(prev => {
      const next = { ...prev };
      const nextCategory = { ...next[category] };
      const nextConditions = [...nextCategory.condition];
      nextConditions[index] = value;
      nextCategory.condition = nextConditions;
      next[category] = nextCategory;
      return next;
    });
  };

  const handleAddCondition = (category: string) => {
    setLocalConditions(prev => {
      const next = { ...prev };
      const nextCategory = { ...next[category] };
      nextCategory.condition = [...nextCategory.condition, ""];
      next[category] = nextCategory;
      return next;
    });
  };

  const handleRemoveCondition = (category: string, index: number) => {
    setLocalConditions(prev => {
      const next = { ...prev };
      const nextCategory = { ...next[category] };
      nextCategory.condition = nextCategory.condition.filter((_: any, i: number) => i !== index);
      next[category] = nextCategory;
      return next;
    });
  };

  const handleAddNewCategory = () => {
    if (newCategoryName.trim()) {
      setLocalConditions(prev => ({
        ...prev,
        [newCategoryName.trim()]: { condition: [""] }
      }));
      setNewCategoryName("");
      setIsAddingCategory(false);
    }
  };

  const handleUpdateBudget = (category: string, value: string) => {
    setLocalBudgets(prev => ({
      ...prev,
      [category]: value,
    }));
  };

  const handleSaveBudgets = async () => {
    if (!policyId) {
      onSave(localConditions, localBudgets);
      return;
    }

    setIsSaving(true);
    try {
      const categoriesWithBudgets = Object.keys(localConditions).map(category => ({
        category,
        auto_approval_budget: localBudgets[category] !== ""
          ? parseFloat(localBudgets[category])
          : null,
      }));

      const result = await updatePolicyCategories(policyId, categoriesWithBudgets);

      if (result.ok) {
        onSave(localConditions, localBudgets);
      } else {
        alert(result.error || "Failed to update policy budgets");
      }
    } catch (error) {
      console.error("Error saving budgets:", error);
      alert("Failed to save budgets");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-6">
      <div className="absolute inset-0 bg-ink/40 cursor-pointer" onClick={onClose} />

      <div role="dialog" aria-modal="true" aria-labelledby="conditions-title" className="relative w-full max-w-2xl max-h-[85vh] bg-surface rounded-dialog border border-line shadow-overlay flex flex-col overflow-hidden">
        <div className="px-5 sm:px-8 py-4 sm:py-6 border-b border-line flex items-center justify-between gap-3 shrink-0">
          <div className="flex items-center gap-4">
            <div>
              <h3 id="conditions-title" className="font-display font-semibold text-xl sm:text-2xl text-ink">Mandatory Conditions</h3>
              <p className="text-sm text-ink-muted font-body">Review and edit AI extracted rules</p>
            </div>
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
          {Object.entries(localConditions).map(([category, details]) => (
            <div key={category} className="rounded-card p-4 sm:p-5 shadow-ambient">
              <div className="flex items-center justify-between gap-2 mb-4">
                <h4 className="font-display font-semibold text-lg text-ink">
                  {category}
                </h4>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => handleAddCondition(category)}
                    className="w-11 h-11 inline-flex items-center justify-center text-ink hover:bg-surface-muted rounded-control transition-colors cursor-pointer"
                    title="Add condition"
                    aria-label={`Add a condition to ${category}`}
                  >
                    <Plus size={18} aria-hidden="true" />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Are you sure you want to remove the entire "${category}" category?`)) {
                        setLocalConditions(prev => {
                          const next = { ...prev };
                          delete next[category];
                          return next;
                        });
                      }
                    }}
                    type="button"
                    className="w-11 h-11 inline-flex items-center justify-center text-ink-muted hover:text-danger hover:bg-danger-soft rounded-control transition-colors cursor-pointer"
                    title="Delete category"
                    aria-label={`Delete the ${category} category`}
                  >
                    <Trash2 size={16} aria-hidden="true" />
                  </button>
                </div>
              </div>
              <div className="space-y-3">
                {details.condition.map((cond: string, i: number) => (
                  <div key={i} className="flex gap-2 group/item">
                    <div className="flex-1 relative">
                      <input
                        type="text"
                        value={cond}
                        onChange={(e) => handleUpdateCondition(category, i, e.target.value)}
                        aria-label={`${category} condition ${i + 1}`}
                        className="w-full min-h-[44px] bg-surface border border-line-strong rounded-control px-3 text-sm text-ink font-body focus:border-accent outline-none"
                        placeholder="Enter condition..."
                      />
                    </div>
                    <button
                      onClick={() => handleRemoveCondition(category, i)}
                      type="button"
                      aria-label={`Remove ${category} condition ${i + 1}`}
                      className="w-11 h-11 inline-flex items-center justify-center text-ink-muted hover:text-danger hover:bg-danger-soft rounded-control transition-colors cursor-pointer shrink-0"
                    >
                      <Trash2 size={16} aria-hidden="true" />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Auto-Approval Budgets Section */}
          <div className="rounded-card p-4 sm:p-5 shadow-ambient">
            <div className="flex items-center gap-3 mb-4">
              <div>
                <h4 className="font-display font-semibold text-base text-ink">Auto-Approval Budgets</h4>
                <p className="text-xs text-ink-muted">
                  Set the maximum amount per category for auto-approval. Leave blank for unlimited.
                </p>
              </div>
            </div>

            <div className="space-y-3">
              {Object.keys(localConditions).map((category) => {
                const currentBudget = localBudgets[category] ?? "";

                return (
                  <div key={category} className="flex items-center gap-3">
                    <div className="flex-1">
                      <label htmlFor={`modal-budget-${category}`} className="text-sm font-medium text-ink mb-1 block">
                        {category}
                      </label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-muted text-xs font-medium">
                          MYR
                        </span>
                        <input
                          id={`modal-budget-${category}`}
                          type="number"
                          min="0"
                          step="0.01"
                          value={currentBudget}
                          onChange={(e) => handleUpdateBudget(category, e.target.value)}
                          placeholder="Unlimited"
                          className="w-full min-h-[44px] pl-12 pr-3 bg-surface border border-line-strong rounded-control text-sm text-ink font-mono focus:border-accent outline-none placeholder:text-ink-muted"
                        />
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Add New Category UI */}
          {isAddingCategory ? (
            <div className="rounded-card p-4 sm:p-5 border-2 border-dashed border-line-strong">
              <h4 className="text-sm font-semibold text-ink mb-3">New Mandatory Category</h4>
              <div className="flex flex-wrap sm:flex-nowrap gap-2">
                <input
                  autoFocus
                  type="text"
                  value={newCategoryName}
                  onChange={(e) => setNewCategoryName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAddNewCategory()}
                  placeholder="e.g. Travel Limits, Eligibility..."
                  aria-label="New category name"
                  className="flex-1 min-w-0 min-h-[44px] bg-surface border border-line-strong rounded-control px-3 text-sm text-ink font-body focus:border-accent outline-none"
                />
                <button
                  type="button"
                  onClick={handleAddNewCategory}
                  className="min-h-[44px] px-5 bg-ink text-paper text-sm font-semibold rounded-full hover:bg-ink/85 transition-colors cursor-pointer"
                >
                  Add
                </button>
                <button
                  type="button"
                  aria-label="Cancel new category"
                  onClick={() => { setIsAddingCategory(false); setNewCategoryName(""); }}
                  className="w-11 h-11 inline-flex items-center justify-center text-ink-muted hover:bg-surface-muted rounded-control transition-colors cursor-pointer"
                >
                  <X size={20} aria-hidden="true" />
                </button>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsAddingCategory(true)}
              className="w-full py-5 border-2 border-dashed border-line-strong rounded-card flex flex-col items-center justify-center gap-2 text-ink hover:bg-surface-muted transition-colors cursor-pointer"
            >
              <PlusCircle size={20} className="text-ink-muted" aria-hidden="true" />
              <span className="text-sm font-semibold">Add New Mandatory Category</span>
            </button>
          )}
        </div>

        <div className="px-5 sm:px-6 py-4 border-t border-line flex flex-col-reverse sm:flex-row justify-between sm:items-center gap-2 shrink-0">
          <button
            onClick={onClose}
            disabled={isSaving}
            type="button"
            className="min-h-[44px] px-6 text-ink font-body font-semibold border border-line-strong hover:bg-surface-muted rounded-control transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Cancel
          </button>
          <button
            onClick={handleSaveBudgets}
            disabled={isSaving}
            type="button"
            className="min-h-[44px] px-6 bg-accent text-on-accent rounded-full font-body font-semibold hover:bg-accent-hover transition-colors cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed flex items-center justify-center gap-2"
          >
            {isSaving ? (
              <>
                <Settings className="w-4 h-4 animate-spin" />
                Saving...
              </>
            ) : (
              "Save Conditions & Budgets"
            )}
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

  const filtered = policies.filter(p =>
    p.alias.toLowerCase().includes(modalQuery.toLowerCase()) ||
    p.department.toLowerCase().includes(modalQuery.toLowerCase())
  );

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
              placeholder="Search by name or department..."
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
                <th className="py-3 px-6 text-xs font-semibold text-ink-muted">Modified</th>
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
                        <p className="text-xs text-ink-muted mt-0.5">{policy.version} • {policy.department}</p>
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
