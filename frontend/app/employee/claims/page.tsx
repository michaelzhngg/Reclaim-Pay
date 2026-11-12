"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import {
  FileText,
  Upload,
  Trash2,
  Loader2,
  Camera,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Pencil,
  Check,
  X,
  AlertTriangle,
} from "lucide-react";

// ─── Types ────────────────────────────────────────────────────────────────────
import type {
  UploadedFile,
  OcrReceiptData,
  ClaimContext,
  ClaimSubmissionPayload,
  DbEmployee,
} from "../../../src/types/claim";



// ─── Screen components ────────────────────────────────────────────────────────
import { ProcessingScreen } from "./_components/ProcessingScreen";
import { VerificationScreen } from "./_components/VerificationScreen";
import { SubmitDialog } from "./_components/SubmitDialog";
import { ClaimDialog } from "./_components/ClaimDialog";
import { closeAttempt, claimSummary, type SubmitPhase } from "./_components/submitDialogState";
import { formatMoney } from "@/lib/format";
// CameraModal removed: using native <input capture="environment"> instead

// ─── Server Actions ───────────────────────────────────────────────────────────
import { uploadDocuments, editDocument, analyzeCompliance, saveDraft, updateDraft, loadDraft, getRawReimbursements } from "@/lib/actions/claims";
import type { SubCategoryConfig, AnalyzeResponseMulti, DocumentUploadResponse } from "@/lib/api/types";

// ─── SSE ─────────────────────────────────────────────────────────────────────
import { subscribeToProgress } from "@/lib/sse";
import { useTimeline } from "@/lib/hooks/useTimeline";

// ─── Stage type ───────────────────────────────────────────────────────────────

type Stage = "form" | "processing" | "verification";

// ─── Constants ────────────────────────────────────────────────────────────────

const MAX_FILES = 10;
const ACCEPT = ".pdf,.jpg,.jpeg,.png,.webp";
const VALID_MIME_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp"]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB

// ─── Helpers ──────────────────────────────────────────────────────────────────

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

function compressImage(file: File, quality = 0.85, maxWidth = 2048): Promise<File> {
  return new Promise(resolve => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > maxWidth) { height = Math.round((height * maxWidth) / width); width = maxWidth; }
      const canvas = document.createElement("canvas");
      canvas.width = width; canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) { URL.revokeObjectURL(url); resolve(file); return; }
      ctx.drawImage(img, 0, 0, width, height);
      URL.revokeObjectURL(url);
      const base = file.name.replace(/\.[^.]+$/, "");
      canvas.toBlob(
        blob => resolve(blob ? new File([blob], `${base}.jpg`, { type: "image/jpeg" }) : file),
        "image/jpeg",
        quality,
      );
    };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(file); };
    img.src = url;
  });
}

// ─── Inline Document Viewer (used in form stage right panel) ──────────────────

interface DocViewerProps {
  file: UploadedFile | null;
}

function DocViewer({ file }: DocViewerProps) {
  const [zoom, setZoom] = useState(1);

  // Reset zoom when file changes
  useEffect(() => { setZoom(1); }, [file?.id]);

  if (!file) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-2 bg-surface rounded-card border border-dashed border-line-strong min-h-[360px]">
        <div className="text-center px-6">
          <p className="text-sm font-semibold text-ink font-body">No receipt selected</p>
          <p className="text-xs text-ink-muted font-body mt-1">Click a receipt from the list to preview it here.</p>
        </div>
      </div>
    );
  }

  const isImage = file.type.startsWith("image/");
  const isPDF = file.type === "application/pdf";

  return (
    <div className="flex-1 flex flex-col bg-surface rounded-card shadow-ambient overflow-hidden min-h-[360px]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-4 py-1.5 border-b border-line shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <FileText className="w-4 h-4 text-ink-muted shrink-0" strokeWidth={1.75} aria-hidden="true" />
          <span className="text-sm font-medium text-ink font-body truncate">{file.name}</span>
        </div>
        {isImage && (
          <div className="flex items-center gap-0.5 shrink-0 ml-3">
            <button onClick={() => setZoom(z => Math.max(0.5, +(z - 0.25).toFixed(2)))} aria-label="Zoom out"
              className="w-11 h-11 rounded-control flex items-center justify-center text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors">
              <ZoomOut className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
            <span className="text-xs text-ink-muted w-10 text-center font-mono">
              {Math.round(zoom * 100)}%
            </span>
            <button onClick={() => setZoom(z => Math.min(3, +(z + 0.25).toFixed(2)))} aria-label="Zoom in"
              className="w-11 h-11 rounded-control flex items-center justify-center text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors">
              <ZoomIn className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
            <button onClick={() => setZoom(1)} aria-label="Reset zoom"
              className="w-11 h-11 rounded-control flex items-center justify-center text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors">
              <Maximize2 className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          </div>
        )}
      </div>

      {/* Body */}
      <div className="flex-1 overflow-auto bg-surface-muted flex items-center justify-center" style={{ minHeight: 0 }}>
        {isImage ? (
          <div className="w-full h-full overflow-auto flex items-center justify-center p-4" style={{ touchAction: "pinch-zoom" }}>
            <img
              src={file.previewUrl}
              alt={file.name}
              draggable={false}
              style={{
                transform: `scale(${zoom})`,
                transformOrigin: "center center",
                transition: "transform 0.15s ease",
                maxWidth: "100%",
                display: "block",
              }}
              className="rounded-control select-none"
            />
          </div>
        ) : isPDF ? (
          <iframe src={file.previewUrl} title={file.name} className="w-full h-full border-0" />
        ) : (
          <div className="flex flex-col items-center gap-4 py-16">
            <FileText className="w-12 h-12 text-line-strong" strokeWidth={1.25} aria-hidden="true" />
            <p className="text-sm text-ink-muted font-body">Preview not available</p>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── File card in the upload list ─────────────────────────────────────────────

interface FileCardProps {
  file: UploadedFile;
  index: number;
  isActive: boolean;
  onSelect: () => void;
  onRemove: () => void;
  onRename: (newName: string) => void;
}

function FileCard({ file, index, isActive, onSelect, onRemove, onRename }: FileCardProps) {
  const [editing, setEditing] = useState(false);
  const [draftName, setDraftName] = useState(file.name);
  const inputRef = useRef<HTMLInputElement>(null);

  function commitRename() {
    const trimmed = draftName.trim();
    if (trimmed && trimmed !== file.name) onRename(trimmed);
    else setDraftName(file.name);
    setEditing(false);
  }

  function startEdit(e: React.MouseEvent) {
    e.stopPropagation(); // don't trigger card click
    setDraftName(file.name);
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 30);
  }

  const isImage = file.type.startsWith("image/");

  return (
    <div
      onClick={onSelect}
      className={`flex items-center gap-3 rounded-card border pl-3 pr-1 py-1.5 cursor-pointer transition-colors duration-150 ${isActive
        ? "bg-accent-soft border-accent"
        : "bg-surface border-line hover:bg-surface-muted"
        }`}
    >
      {/* Thumbnail */}
      <div className="w-9 h-9 rounded-control bg-surface-muted overflow-hidden flex items-center justify-center shrink-0">
        {isImage
          ? <img src={file.previewUrl} alt={file.name} className="w-full h-full object-cover" />
          : <FileText className="w-4 h-4 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
        }
      </div>

      {/* Name / rename input */}
      <div className="flex-1 min-w-0" onClick={e => editing && e.stopPropagation()}>
        {editing ? (
          <input
            ref={inputRef}
            type="text"
            value={draftName}
            onChange={e => setDraftName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={e => {
              if (e.key === "Enter") commitRename();
              if (e.key === "Escape") { setDraftName(file.name); setEditing(false); }
            }}
            aria-label="Receipt name"
            className="w-full min-h-11 text-sm font-medium text-ink font-body bg-surface border border-line-strong rounded-control px-2 focus:border-accent"
            onClick={e => e.stopPropagation()}
          />
        ) : (
          <p className="text-sm font-medium text-ink font-body truncate">{file.name}</p>
        )}
        <p className="text-xs text-ink-muted font-mono mt-0.5">
          {(file.size / 1024).toFixed(0)} KB
        </p>
      </div>

      {/* Index badge */}
      <span className={`text-xs font-mono shrink-0 ${isActive ? "text-accent-hover" : "text-ink-muted"}`}>
        #{index + 1}
      </span>

      {/* Action icons, always visible: 44 px targets for touch, hover fill on desktop */}
      <div className="flex items-center shrink-0">
        {editing ? (
          <>
            <button
              onClick={e => { e.stopPropagation(); commitRename(); }}
              aria-label="Confirm rename"
              className="w-11 h-11 inline-flex items-center justify-center rounded-control text-success hover:bg-success-soft transition-colors"
            >
              <Check className="w-3.5 h-3.5" strokeWidth={2.5} />
            </button>
            <button
              onClick={e => { e.stopPropagation(); setDraftName(file.name); setEditing(false); }}
              aria-label="Cancel rename"
              className="w-11 h-11 inline-flex items-center justify-center rounded-control text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
            >
              <X className="w-3.5 h-3.5" strokeWidth={2} />
            </button>
          </>
        ) : (
          <>
            <button
              onClick={startEdit}
              aria-label={`Rename ${file.name}`}
              className="w-11 h-11 inline-flex items-center justify-center rounded-control text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
            >
              <Pencil className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
            <button
              id={`remove-file-${index}`}
              onClick={e => { e.stopPropagation(); onRemove(); }}
              aria-label={`Remove ${file.name}`}
              className="w-11 h-11 inline-flex items-center justify-center rounded-control text-ink-muted hover:bg-danger-soft hover:text-danger transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" strokeWidth={1.75} />
            </button>
          </>
        )}
      </div>
    </div>
  );
}

// ─── BatchDropzone (dropzone only — no file list) ─────────────────────────────

interface BatchDropzoneProps {
  isFull: boolean;
  isLoading: boolean;
  onAdd: (files: File[]) => void;
  inputRef: React.RefObject<HTMLInputElement | null>;
  cameraRef: React.RefObject<HTMLInputElement | null>;
  /** True before any file is added: the drop zone fills the whole upload area. */
  expanded?: boolean;
}

/** Enter or Space opens the picker, so the drop zone works without a mouse. */
function activateOnKey(open: () => void) {
  return (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      open();
    }
  };
}

function BatchDropzone({ isFull, isLoading, onAdd, inputRef, cameraRef, expanded = false }: BatchDropzoneProps) {
  const [dragging, setDragging] = useState(false);

  function handleDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!isFull && e.dataTransfer.files.length) onAdd(Array.from(e.dataTransfer.files));
  }

  if (isFull) return null; // ceiling hit — hide dropzone entirely

  return (
    <>
      {/* Mobile: tap to open native camera / gallery */}
      <div
        role="button"
        tabIndex={0}
        aria-label="Scan or upload receipts"
        className={`md:hidden flex flex-col items-center justify-center gap-3 ${expanded ? "py-14" : "py-7"} px-4 rounded-card border-2 border-dashed border-line-strong bg-surface active:bg-surface-muted transition-colors`}
        onClick={() => cameraRef.current?.click()}
        onKeyDown={activateOnKey(() => cameraRef.current?.click())}
      >
        <Camera className="w-6 h-6 text-ink-muted" strokeWidth={1.75} aria-hidden="true" />
        <div className="text-center">
          <p className="text-sm font-semibold text-ink font-body">Tap to scan or upload</p>
          <p className="text-xs text-ink-muted font-body mt-0.5">PDF, JPG or PNG · Max limit: 10 receipts.</p>
        </div>
      </div>

      {/* Desktop: drag-and-drop */}
      <div
        onDragOver={e => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={handleDrop}
        onClick={() => inputRef.current?.click()}
        onKeyDown={activateOnKey(() => inputRef.current?.click())}
        role="button"
        tabIndex={0}
        aria-label="Upload receipts"
        className={`hidden md:flex border-2 border-dashed rounded-card flex-col items-center justify-center ${expanded ? "min-h-[360px] py-16" : "py-9"} px-6 text-center cursor-pointer transition-colors duration-150 ${dragging
          ? "border-accent bg-accent-soft"
          : "border-line-strong bg-surface hover:bg-surface-muted"
          }`}
      >
        {isLoading ? (
          <Loader2 className="w-6 h-6 text-ink-muted animate-spin motion-reduce:animate-none mb-3" strokeWidth={1.75} aria-hidden="true" />
        ) : (
          <Upload className={`w-6 h-6 mb-3 ${dragging ? "text-accent" : "text-ink-muted"}`} strokeWidth={1.75} aria-hidden="true" />
        )}
        <p className="text-sm font-semibold text-ink font-body">Click to upload or drag & drop</p>
        <p className="text-xs text-ink-muted font-body mt-1">PDF, JPG or PNG · Max limit: 10 receipts.</p>
      </div>
    </>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

function CaptureReceiptContent() {
  const searchParams = useSearchParams();
  const router = useRouter();

  // ── Stage ──────────────────────────────────────────────────────────────────
  const [stage, setStage] = useState<Stage>("form");

  // ── Form state ─────────────────────────────────────────────────────────────
  const [files, setFiles] = useState<UploadedFile[]>([]);
  const [activeDocId, setActiveDocId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Native camera input — OS handles Retake/Use Photo, no custom modal needed
  const cameraInputRef = useRef<HTMLInputElement>(null);
  // Track actual File objects alongside UploadedFile metadata
  const fileMapRef = useRef<Map<string, File>>(new Map());

  // ── Processing state ───────────────────────────────────────────────────────
  const [processingIndex, setProcessingIndex] = useState(0);
  const [processingStep, setProcessingStep] = useState(0);
  const [completedNames, setCompletedNames] = useState<string[]>([]);

  // ── Verification state ─────────────────────────────────────────────────────
  const [ocrReceipts, setOcrReceipts] = useState<OcrReceiptData[]>([]);
  const [claimContext, setClaimContext] = useState<ClaimContext>({
    travelDestination: "",
    travelPurpose: "",
    overseas: false,
    departureDate: "",
    arrivalDate: "",
  });

  // ── Backend settlement/document state ──────────────────────────────────────
  const [settlementId, setSettlementId] = useState<string | null>(null);
  const [documentIds, setDocumentIds] = useState<string[]>([]);
  const [employeeData, setEmployeeData] = useState<DbEmployee | null>(null);
  const [analysisResult, setAnalysisResult] = useState<AnalyzeResponseMulti | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [currentStage, setCurrentStage] = useState("");
  const [stageData, setStageData] = useState<Record<string, unknown> | undefined>(undefined);
  const originalOcrRef = useRef<OcrReceiptData[]>([]);
  const sseCloseRef = useRef<{ close: () => void } | null>(null);

  useEffect(() => {
    return () => { sseCloseRef.current?.close(); };
  }, []);

  // ── Submit dialog ──────────────────────────────────────────────────────────
  // Opens on Submit: checking (live timeline), then the result or an error.
  const [submitPhase, setSubmitPhase] = useState<SubmitPhase>("closed");
  const [showLeaveNotice, setShowLeaveNotice] = useState(false);

  // ── Draft state ────────────────────────────────────────────────────────────
  const [isSavingDraft, setIsSavingDraft] = useState(false);
  const [draftSaved, setDraftSaved] = useState(false);
  const [loadedDraftId, setLoadedDraftId] = useState<string | null>(null);
  /**
   * Ref mirror of loadedDraftId — written synchronously so click handlers
   * can never read a stale null due to React batching or render timing.
   */
  const loadedDraftIdRef = useRef<string | null>(null);
  /** Always call this instead of setLoadedDraftId directly. */
  function setDraftId(id: string | null) {
    loadedDraftIdRef.current = id; // synchronous — safe to read in any handler
    setLoadedDraftId(id);
  }
  /**
   * Explicit dirty flag — true only after the USER makes a change.
   * Computed state caused bugs: loading a draft immediately triggered the guard,
   * and saving could never clear it.
   */
  const [isDirty, setIsDirty] = useState(false);

  // ── Compliance analysis stream ─────────────────────────────────────────────
  // useTimeline owns the analysis SSE: the backend queue serves one listener per task.
  const [complianceTaskId, setComplianceTaskId] = useState<string | null>(null);
  const complianceSettlementRef = useRef<string | null>(null);
  const compliance = useTimeline(complianceTaskId, {
    audience: "employee",
    // If the stream drops or goes quiet, the claim is done once its reimbursement rows exist.
    poll: async () => {
      const sid = complianceSettlementRef.current;
      if (!sid) return null;
      const rows = (await getRawReimbursements()).filter(r => r.settlement_id === sid);
      return rows.length ? { reimbursements: rows } : null;
    },
    onComplete: completeResult => {
      setIsSubmitting(false);
      setAnalysisResult(completeResult as unknown as AnalyzeResponseMulti);
      setIsDirty(false);
      setSubmitPhase("result");
    },
    onError: error => {
      console.error("Compliance SSE error:", error);
      setSubmitError(error);
      setIsSubmitting(false);
      setSubmitPhase("error");
    },
  });

  // ── Unsaved-changes guard state ────────────────────────────────────────────
  const [showLeaveModal, setShowLeaveModal] = useState(false);
  const [leaveModalStep, setLeaveModalStep] = useState<"confirm" | "name">("confirm");
  /**
   * "leaving"  → triggered by nav interception; after save, navigate to pendingNavHref.
   * "saving"   → triggered by the explicit Save Draft button; after save, just close.
   */
  const [leaveModalMode, setLeaveModalMode] = useState<"leaving" | "saving">("leaving");
  const [pendingNavHref, setPendingNavHref] = useState<string | null>(null);
  const [pendingDraftTitle, setPendingDraftTitle] = useState("");
  const [isSavingLeave, setIsSavingLeave] = useState(false);
  /** Names of original File objects (can't serialise blobs — shown in resume banner) */
  const [restoredFileNames, setRestoredFileNames] = useState<string[]>([]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const canProcess = files.length > 0;
  const isFull = files.length >= MAX_FILES;
  const activeFile = files.find(f => f.id === activeDocId) ?? null;

  // ── Browser refresh / tab-close guard ─────────────────────────────────────
  useEffect(() => {
    if (!isDirty) return;
    const handler = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [isDirty]);

  // ── In-app navigation intercept (captures <a> clicks in sidebar / bottom nav)
  useEffect(() => {
    if (!isDirty) return;
    const handleClick = (e: MouseEvent) => {
      const anchor = (e.target as HTMLElement).closest("a");
      if (!anchor) return;
      const href = anchor.getAttribute("href");
      // Ignore same-page links or fragment/query links
      if (!href || href === "/employee/claims" || href.startsWith("#") || href.startsWith("?")) return;
      e.preventDefault();
      e.stopPropagation();
      setPendingNavHref(href);
      setLeaveModalStep("confirm");
      setPendingDraftTitle("");
      setShowLeaveModal(true);
    };
    document.addEventListener("click", handleClick, true); // capture phase
    return () => document.removeEventListener("click", handleClick, true);
  }, [isDirty]);

  // ── File handlers ──────────────────────────────────────────────────────────
  async function handleAddFiles(rawFiles: File[]) {
    const remaining = MAX_FILES - files.length;
    if (remaining <= 0) return;

    const invalidType = rawFiles.find(f => !VALID_MIME_TYPES.has(f.type));
    if (invalidType) {
      setFileError(`Invalid file type "${invalidType.name}". Only JPG, PNG, WebP, and PDF files are accepted.`);
      return;
    }
    const oversized = rawFiles.find(f => f.size > MAX_FILE_SIZE);
    if (oversized) {
      setFileError(`File "${oversized.name}" exceeds the 10 MB limit (${(oversized.size / (1024 * 1024)).toFixed(1)} MB).`);
      return;
    }
    setFileError(null);

    const list = rawFiles.slice(0, remaining);
    setIsLoading(true);
    const processed = await Promise.all(
      list.map(f => f.type.startsWith("image/") ? compressImage(f) : Promise.resolve(f)),
    );
    const added: UploadedFile[] = processed.map(f => ({
      id: uid(),
      name: f.name,
      size: f.size,
      previewUrl: URL.createObjectURL(f),
      type: f.type,
    }));
    processed.forEach((f, idx) => fileMapRef.current.set(added[idx].id, f));
    setFiles(prev => {
      const next = [...prev, ...added].slice(0, MAX_FILES);
      if (added.length > 0) setActiveDocId(added[0].id);
      return next;
    });
    setIsLoading(false);
    setIsDirty(true); // user added files
  }

  function handleRemoveFile(id: string) {
    fileMapRef.current.delete(id);
    setFiles(prev => {
      const target = prev.find(f => f.id === id);
      if (target?.previewUrl) URL.revokeObjectURL(target.previewUrl);
      const next = prev.filter(f => f.id !== id);
      if (activeDocId === id) {
        const idx = prev.findIndex(f => f.id === id);
        setActiveDocId(next[Math.max(0, idx - 1)]?.id ?? null);
      }
      return next;
    });
    setIsDirty(true); // user removed a file
  }

  function handleRenameFile(id: string, newName: string) {
    setFiles(prev => prev.map(f => f.id === id ? { ...f, name: newName } : f));
  }

  // ── Real OCR via backend upload (with SSE live progress) ───────────────────
  function handleProcessResult(result: any, fileNames: string[]) {
    setSettlementId(result.settlement_id);
    setCompletedNames(fileNames);
    setProcessingIndex(fileNames.length - 1);
    setProcessingStep(3);

    // Map successful receipts
    const successReceipts: OcrReceiptData[] = ((result.receipts as any[]) || []).map((r: any, idx: number) => ({
      receiptIndex: idx,
      success: true,
      expenseDate: r.date ?? "",
      merchant: (r.extracted_data?.merchant_name as string) ?? r.description ?? "",
      transport: r.transportation ?? 0,
      accommodation: r.accommodation ?? 0,
      meals: r.meals ?? 0,
      others: r.others ?? 0,
      notes: r.description ?? "",
    }));

    // Map failed/skipped receipts — these were previously dropped entirely
    const skippedReceipts: OcrReceiptData[] = ((result.skipped_receipts as any[]) || []).map((r: any, idx: number) => {
      // Detect low-confidence: backend adds "Low confidence OCR result: …" to warnings when confidence < 0.7
      const warnings: string[] = r.warnings ?? [];
      const isLowConfidence = warnings.some((w: string) => w.toLowerCase().startsWith("low confidence"));
      return {
        receiptIndex: successReceipts.length + idx,
        success: false,
        lowConfidence: isLowConfidence,
        expenseDate: r.date ?? "",
        merchant: (r.extracted_data?.merchant_name as string) ?? r.description ?? "",
        transport: r.transportation ?? 0,
        accommodation: r.accommodation ?? 0,
        meals: r.meals ?? 0,
        others: r.others ?? 0,
        notes: r.description ?? "",
      };
    });

    // Merge both — successful first, then failed (for display order)
    const mappedReceipts = [...successReceipts, ...skippedReceipts];

    // Collect document IDs from both successful and skipped receipts
    const successIds = ((result.receipts as any[]) || []).map((r: any) => r.document_id).filter(Boolean);
    const skippedIds = ((result.skipped_receipts as any[]) || []).map((r: any) => r.document_id).filter(Boolean);
    setDocumentIds([...successIds, ...skippedIds]);

    originalOcrRef.current = mappedReceipts.map(r => ({ ...r }));
    setOcrReceipts(mappedReceipts);

    // Auto-fill travel context from successful receipts
    const receipts = (result.receipts as any[]) || [];
    if (receipts.length > 0) {
      // Extract destinations - unique, case-insensitive, comma-separated
      const destinationsSet = new Set<string>();
      receipts.forEach((r: any) => {
        const dest = r.extracted_data?.destination as string | undefined;
        if (dest && dest !== "Not found in Receipt" && dest.trim()) {
          destinationsSet.add(dest.trim());
        }
      });
      const travelDestination = Array.from(destinationsSet).join(", ");

      // Extract dates - use departure_date/arrival_date, fallback to receipt date
      const departureDates: string[] = [];
      const arrivalDates: string[] = [];

      receipts.forEach((r: any) => {
        const extracted = r.extracted_data || {};
        const depDate = extracted.departure_date as string | undefined;
        const arrDate = extracted.arrival_date as string | undefined;
        const receiptDate = r.date as string | undefined;

        // For departure: prefer departure_date, fallback to date
        if (depDate && depDate !== "Not found in Receipt" && depDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
          departureDates.push(depDate);
        } else if (receiptDate && receiptDate !== "Not found in Receipt" && receiptDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
          departureDates.push(receiptDate);
        }

        // For arrival: prefer arrival_date, fallback to date
        if (arrDate && arrDate !== "Not found in Receipt" && arrDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
          arrivalDates.push(arrDate);
        } else if (receiptDate && receiptDate !== "Not found in Receipt" && receiptDate.match(/^\d{4}-\d{2}-\d{2}$/)) {
          arrivalDates.push(receiptDate);
        }
      });

      // Find earliest departure and latest arrival
      const sortedDepartures = departureDates.sort();
      const sortedArrivals = arrivalDates.sort();
      const departureDate = sortedDepartures.length > 0 ? sortedDepartures[0] : "";
      const arrivalDate = sortedArrivals.length > 0 ? sortedArrivals[sortedArrivals.length - 1] : "";

      // Check if any receipt indicates overseas travel
      const anyOverseas = receipts.some((r: any) => {
        const overseas = r.extracted_data?.overseas as boolean | undefined;
        return overseas === true;
      });

      // Auto-fill claim context
      setClaimContext(prev => ({
        ...prev,
        travelDestination: prev.travelDestination || travelDestination,
        departureDate: prev.departureDate || departureDate,
        arrivalDate: prev.arrivalDate || arrivalDate,
        overseas: prev.overseas || anyOverseas,
      }));
    }

    if (result.employee) {
      const emp: any = result.employee;
      setEmployeeData({
        entityName: "Reclaim",
        employeeName: emp.name ?? "",
        employeeNumber: emp.user_code ?? "",
        position: "",
        location: emp.destination ?? emp.location ?? "",
        department: emp.department ?? "",
      });
    }

    setStage("verification");
  }

  async function runOcr(filesList: UploadedFile[]) {
    setProcessingIndex(0);
    setProcessingStep(1);
    setCompletedNames([]);

    const filesToUpload = filesList
      .map(f => fileMapRef.current.get(f.id))
      .filter((f): f is File => f !== undefined);

    if (filesToUpload.length === 0) {
      setStage("form");
      return;
    }

    const result = await uploadDocuments(filesToUpload);

    if ("error" in result) {
      setStage("form");
      setSubmitError(result.error);
      return;
    }

    const taskId = (result as unknown as Record<string, unknown>).task_id as string | undefined;

    if (!taskId) {
      handleProcessResult(result, filesList.map(f => f.name));
      return;
    }

    sseCloseRef.current = subscribeToProgress(taskId, "documents", {
      onProgress: (stage: string, data: Record<string, unknown>) => {
        setCurrentStage(stage);
        setStageData(data);

        if (stage === "ocr_processing") {
          const current = data.current as number;
          const filename = data.filename as string;
          setProcessingIndex(current - 1);
          setProcessingStep(2);
          if (filename) {
            setCompletedNames((prev: string[]) => [...prev, filename]);
          }
        } else if (stage === "saving") {
          setProcessingStep(2);
        }
      },
      onComplete: (completeResult: Record<string, unknown>) => {
        handleProcessResult(completeResult, filesList.map(f => f.name));
      },
      onError: (error: string) => {
        console.error("OCR SSE error:", error);
        handleProcessResult(result as unknown as DocumentUploadResponse, files.map(f => f.name));
      },
    });
  }

  async function handleProcessReceipts() {
    if (!canProcess) return;
    setProcessingIndex(0);
    setProcessingStep(0);
    setStage("processing");
    await runOcr(files);
  }

  // ── Submit ─────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    // The dialog opens the moment Submit is pressed, before any request goes out.
    setShowLeaveNotice(false);
    setSubmitPhase("checking");
    setComplianceTaskId(null);

    if (!settlementId) {
      setSubmitError("No settlement found. Please re-upload your receipts.");
      setSubmitPhase("error");
      return;
    }

    setIsSubmitting(true);
    setSubmitError(null);

    // Send edits for any receipt that changed from original
    for (let i = 0; i < ocrReceipts.length; i++) {
      const curr = ocrReceipts[i];
      const orig = originalOcrRef.current[i];
      const docId = documentIds[i];
      if (!docId || !orig) continue;

      const changed =
        curr.merchant !== orig.merchant ||
        curr.expenseDate !== orig.expenseDate ||
        curr.transport !== orig.transport ||
        curr.accommodation !== orig.accommodation ||
        curr.meals !== orig.meals ||
        curr.others !== orig.others;

      if (changed) {
        await editDocument(docId, {
          merchant_name: curr.merchant,
          date: curr.expenseDate,
          total_amount: curr.transport + curr.accommodation + curr.meals + curr.others,
        });
      }
    }

    // Run compliance analysis. Whether a claim may auto-pay is decided on the server.
    const analyzeResult = await analyzeCompliance({
      settlement_id: settlementId,
      document_ids: documentIds,
    });

    if ("error" in analyzeResult) {
      setIsSubmitting(false);
      setSubmitError(analyzeResult.error);
      setSubmitPhase("error");
      return;
    }

    const taskId = (analyzeResult as unknown as Record<string, unknown>).task_id as string | undefined;

    if (taskId) {
      complianceSettlementRef.current = settlementId;
      setComplianceTaskId(taskId);
    } else {
      setIsSubmitting(false);
      setAnalysisResult(analyzeResult);
      setIsDirty(false);
      setSubmitPhase("result");
    }
  }

  /** Escape or the close button. Mid-check the dialog stays and says the person can leave. */
  function handleDialogCloseAttempt() {
    const action = closeAttempt(submitPhase);
    if (action === "notice") setShowLeaveNotice(true);
    if (action !== "close") return;
    // The claim is in once the result shows, so closing starts a fresh upload.
    if (submitPhase === "result") handleSubmitAnother();
    else setSubmitPhase("closed");
  }

  // ── Reset ──────────────────────────────────────────────────────────────────
  function resetAll() {
    files.forEach(f => { if (f.previewUrl) URL.revokeObjectURL(f.previewUrl); });
    fileMapRef.current.clear();
    setFiles([]);
    setActiveDocId(null);
    setOcrReceipts([]);
    setSettlementId(null);
    setDocumentIds([]);
    setEmployeeData(null);
    setAnalysisResult(null);
    setComplianceTaskId(null);
    complianceSettlementRef.current = null;
    setSubmitError(null);
    setIsSubmitting(false);
    setSubmitPhase("closed");
    setShowLeaveNotice(false);
    originalOcrRef.current = [];
    setClaimContext({ travelDestination: "", travelPurpose: "", overseas: false, departureDate: "", arrivalDate: "" });
    setProcessingIndex(0);
    setProcessingStep(0);
    setCompletedNames([]);
    setCurrentStage("");
    setStageData(undefined);
    setDraftId(null);
    setDraftSaved(false);
    setRestoredFileNames([]);
    setIsDirty(false); // reset guard — form is now clean
  }

  function handleSubmitAnother() {
    resetAll();
    setStage("form");
  }

  // ── Draft: Save / Update ────────────────────────────────────────────────────
  /**
   * Persists the current form state as a draft.
   * - If `loadedDraftId` is set  → PUT (update existing, no title change needed).
   * - Otherwise                  → POST (create new, `customTitle` required).
   * Returns true on success, false on error.
   */
  async function handleSaveDraft(customTitle?: string): Promise<boolean> {
    setIsSavingDraft(true);
    setDraftSaved(false);

    const fileNames = files.map(f => f.name);
    const draftData: Record<string, unknown> = {
      ocrReceipts, claimContext, settlementId,
      documentIds, employeeData, stage, fileNames,
    };
    const failedCount = ocrReceipts.filter(r => !r.success).length;
    const payload = {
      main_category: null,
      settlement_id: settlementId || null,
      draft_data: draftData,
      receipt_count: ocrReceipts.length,
      failed_receipt_count: failedCount,
    };

    let result;
    const currentDraftId = loadedDraftIdRef.current; // read ref — always current
    if (currentDraftId) {
      // Scenario C — updating an existing draft silently
      result = await updateDraft(currentDraftId, payload);
    } else {
      // New draft — needs a title
      const today = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" });
      result = await saveDraft({ ...payload, title: customTitle?.trim() || `Draft, ${today}` });
    }

    setIsSavingDraft(false);

    if ("error" in result) {
      setSubmitError(result.error);
      return false;
    }
    setDraftSaved(true);
    setIsDirty(false);
    if (!currentDraftId) setDraftId((result as any).draft_id);
    setTimeout(() => setDraftSaved(false), 3000);
    return true;
  }

  /**
   * Called by the explicit "Save Draft" button.
   * - Existing draft → silent update (no name prompt).
   * - New draft      → open naming dialog.
   */
  function handleSaveDraftButton() {
    const currentDraftId = loadedDraftIdRef.current;
    console.log('[Draft] Save button clicked. Current draft ID:', currentDraftId);
    if (currentDraftId) {
      // Existing draft — silent update, no name prompt
      handleSaveDraft();
    } else {
      // New draft — ask for a name
      setLeaveModalMode("saving");
      setLeaveModalStep("name");
      setPendingDraftTitle("");
      setPendingNavHref(null);
      setShowLeaveModal(true);
    }
  }

  // ── Draft: Load from query param ────────────────────────────────────────────
  const handleLoadDraft = useCallback(async (draftId: string) => {
    const result = await loadDraft(draftId);
    if ("error" in result) {
      setSubmitError(result.error);
      return;
    }

    const data = result.draft_data as Record<string, unknown>;
    setDraftId(result.draft_id);

    if (result.settlement_id) setSettlementId(result.settlement_id);
    if (data.documentIds) setDocumentIds(data.documentIds as string[]);
    if (data.claimContext) setClaimContext(data.claimContext as ClaimContext);
    if (data.employeeData) setEmployeeData(data.employeeData as DbEmployee);

    console.log('[Draft] Loaded draft ID:', result.draft_id, '— loadedDraftIdRef:', loadedDraftIdRef.current);

    // Store original file names so we can show a re-upload banner
    if (data.fileNames) setRestoredFileNames(data.fileNames as string[]);

    if (data.ocrReceipts) {
      const receipts = data.ocrReceipts as OcrReceiptData[];
      setOcrReceipts(receipts);
      originalOcrRef.current = receipts.map(r => ({ ...r }));
    }

    // Restore to the saved stage (verification if OCR was done)
    const savedStage = data.stage as Stage | undefined;
    if (savedStage === "verification" && data.ocrReceipts) {
      setStage("verification");
    } else {
      setStage("form");
    }
    setIsDirty(false); // loading a draft → start clean, guard only fires after user edits

    // Strip the ?draft_id= query param so the URL is clean and this effect
    // doesn't re-fire on every subsequent re-render (which would reset loadedDraftId).
    if (typeof window !== "undefined") {
      const clean = window.location.pathname;
      window.history.replaceState(null, "", clean);
    }
  }, []);

  useEffect(() => {
    const draftId = searchParams.get("draft_id");
    if (draftId) {
      handleLoadDraft(draftId);
    }
  }, [searchParams, handleLoadDraft]);

  // ── Leave / Save modal handlers ────────────────────────────────────────────
  async function handleSaveAndLeave() {
    // Existing draft: no title input needed — ref holds the ID synchronously.
    // New draft: title must have been entered in the name step.
    if (!loadedDraftIdRef.current && !pendingDraftTitle.trim()) return;
    setIsSavingLeave(true);
    const ok = await handleSaveDraft(pendingDraftTitle || undefined);
    setIsSavingLeave(false);
    if (!ok) return;
    setShowLeaveModal(false);
    if (leaveModalMode === "leaving" && pendingNavHref) {
      resetAll();
      router.push(pendingNavHref);
    }
    // "saving" mode → just close, stay on page
  }

  function handleDiscardAndLeave() {
    setShowLeaveModal(false);
    const href = pendingNavHref;
    resetAll();
    if (href) router.push(href);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Render
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div className="px-4 pt-6 pb-24 md:px-8 md:pt-8 md:pb-12 lg:px-12 lg:pt-10 lg:pb-10 max-w-screen-xl mx-auto w-full">

      <div className="flex flex-col gap-6">

        {/* ── Page Header (form stage only) ─────────────────────────────────── */}
        {stage === "form" && (
          <div className="flex flex-col gap-1">
            <h2 id="claims-page-title" tabIndex={-1} className="font-display font-semibold text-3xl md:text-4xl text-ink outline-none">
              Capture receipts
            </h2>
            <p className="text-base text-ink-muted font-body leading-relaxed">
              Upload your receipts and Reclaim AI will extract the data for you.
            </p>
          </div>
        )}

        {/* ── Re-upload banner (shown when resuming a form-stage draft) ───────── */}
        {loadedDraftId && stage === "form" && restoredFileNames.length > 0 && files.length === 0 && (
          <div className="rounded-card border border-warning/30 bg-warning-soft px-4 py-3.5 flex items-start gap-3">
            <AlertTriangle className="w-4 h-4 text-warning shrink-0 mt-0.5" strokeWidth={1.75} aria-hidden="true" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-warning font-body">
                Receipt files need to be re-added
              </p>
              <p className="text-xs text-warning font-body mt-0.5 leading-relaxed">
                Draft restored, but uploaded files can’t be stored in a draft.
                Please re-add: <span className="font-semibold">{restoredFileNames.join(", ")}</span>
              </p>
            </div>
          </div>
        )}

        {/* ── Stage Router ──────────────────────────────────────────────────── */}

        {stage === "processing" && (
          <ProcessingScreen
            totalFiles={files.length}
            currentIndex={processingIndex}
            currentStep={processingStep}
            completedFileNames={completedNames}
            currentStage={currentStage}
            stageData={stageData}
          />
        )}

        {stage === "verification" && (
          <>
            <VerificationScreen
              dbData={employeeData ?? {
                entityName: "Reclaim",
                employeeName: "Unknown",
                employeeNumber: "",
                position: "",
                location: "",
                department: "",
              }}
              mainCategory=""
              ocrReceipts={ocrReceipts}
              claimContext={claimContext}
              onClaimContextChange={ctx => { setClaimContext(ctx); setIsDirty(true); }}
              onReceiptsChange={receipts => { setOcrReceipts(receipts); setIsDirty(true); }}
              onBack={() => setStage("form")}
              onSubmit={handleSubmit}
              isSubmitting={isSubmitting}
            />
            {/* Progress and the result live in the submit dialog; an error stays here after "Back to the form". */}
            {submitError && submitPhase === "closed" && (
              <p role="alert" className="text-sm text-danger font-body mt-2 text-center">{submitError}</p>
            )}
          </>
        )}

        {/* ── FORM STAGE ────────────────────────────────────────────────────── */}
        {stage === "form" && (
          <div className="flex flex-col gap-6">

            {fileError && (
              <div role="alert" className="flex items-center gap-3 bg-danger-soft border border-danger/30 text-danger rounded-card pl-4 pr-1 py-1 text-sm font-body">
                <span className="flex-1 py-2">{fileError}</span>
                <button
                  type="button"
                  onClick={() => setFileError(null)}
                  aria-label="Dismiss error"
                  className="shrink-0 w-11 h-11 inline-flex items-center justify-center rounded-control hover:bg-surface transition-colors"
                >
                  <X className="w-4 h-4" strokeWidth={2} aria-hidden="true" />
                </button>
              </div>
            )}

            {/* Split-view upload area */}
            {/* Until a file is added there is nothing to preview, so the drop zone takes the full width. */}
            <div className="flex flex-col lg:flex-row gap-5 items-stretch" style={files.length > 0 ? { minHeight: 480 } : undefined}>

                {/* ── Left: Dropzone + file list ─────────────────────────── */}
                <div className={`w-full ${files.length > 0 ? "lg:w-[380px]" : ""} shrink-0 flex flex-col gap-4`}>

                  {/* Dropzone */}
                  <BatchDropzone
                    isFull={isFull}
                    isLoading={isLoading}
                    onAdd={handleAddFiles}
                    inputRef={fileInputRef}
                    cameraRef={cameraInputRef}
                    expanded={files.length === 0}
                  />

                  {/* File list */}
                  {files.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center justify-between ml-1">
                        <span className="text-xs font-semibold text-ink-muted font-body">
                          Uploaded Receipts
                        </span>
                        <span className="text-xs text-ink-muted font-body">
                          Max limit: 10 receipts.
                        </span>
                      </div>
                      <div className="flex flex-col gap-2">
                        {files.map((f, idx) => (
                          <FileCard
                            key={f.id}
                            file={f}
                            index={idx}
                            isActive={activeDocId === f.id}
                            onSelect={() => setActiveDocId(f.id)}
                            onRemove={() => handleRemoveFile(f.id)}
                            onRename={name => handleRenameFile(f.id, name)}
                          />
                        ))}
                      </div>

                      {/* Add more — only visible on desktop when not full */}
                      {!isFull && (
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="hidden md:flex min-h-11 items-center justify-center gap-2 text-sm font-semibold text-ink font-body rounded-control border border-dashed border-line-strong hover:bg-surface-muted transition-colors"
                        >
                          <Upload className="w-4 h-4" strokeWidth={1.75} aria-hidden="true" />
                          Add more receipts
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* ── Right: Document preview ────────────────────────────── */}
                {files.length > 0 && (
                  <div className="flex-1 flex flex-col">
                    <DocViewer file={activeFile} />
                  </div>
                )}
              </div>

            {/* Hidden file input — desktop multi-file picker */}
            <input
              ref={fileInputRef}
              id="batch-file-input"
              type="file"
              accept={ACCEPT}
              multiple
              className="hidden"
              onChange={e => { if (e.target.files) handleAddFiles(Array.from(e.target.files)); e.target.value = ""; }}
            />

            {/* Native file picker — shows camera + photo library on mobile */}
            <input
              ref={cameraInputRef}
              id="camera-file-input"
              type="file"
              accept="image/*,application/pdf"
              className="hidden"
              onChange={e => {
                if (e.target.files?.[0]) handleAddFiles([e.target.files[0]]);
                e.target.value = "";
              }}
            />

            {/* Bottom Action Bar */}
            <div className="flex flex-row items-center gap-3 pt-4 border-t border-line w-full max-w-2xl lg:max-w-none">
              <button
                id="save-draft-btn"
                onClick={handleSaveDraftButton}
                disabled={isSavingDraft || (files.length === 0 && ocrReceipts.length === 0)}
                className={`flex-1 min-h-11 px-6 rounded-control border font-semibold text-sm font-body text-center transition-colors duration-150 ${draftSaved
                    ? "bg-success-soft text-success border-success/30"
                    : isSavingDraft
                      ? "bg-surface-muted text-ink-muted border-line cursor-wait"
                      : "text-ink bg-surface border-line-strong hover:bg-surface-muted disabled:text-ink-muted disabled:border-line"
                  }`}
              >
                {isSavingDraft ? "Saving…" : draftSaved ? "✓ Draft Saved!" : "Save Draft"}
              </button>
              <button
                id="process-receipts-btn"
                disabled={!canProcess}
                aria-describedby={canProcess ? undefined : "process-receipts-hint"}
                onClick={handleProcessReceipts}
                className={`flex-1 min-h-11 flex items-center justify-center gap-2 px-6 rounded-full font-semibold text-sm font-body transition-colors duration-150 ${canProcess
                  ? "bg-accent text-on-accent hover:bg-accent-hover"
                  : "bg-surface-muted text-ink-muted"
                  }`}
              >
                {files.length > 0
                  ? `Process ${files.length} Receipt${files.length !== 1 ? "s" : ""}`
                  : "Process Receipts"}
              </button>
            </div>
            {!canProcess && (
              <p id="process-receipts-hint" className="-mt-3 text-xs text-ink-muted font-body text-right max-w-2xl lg:max-w-none">
                Add at least one receipt to continue.
              </p>
            )}
          </div>
        )}

      </div>

      {/* Submit dialog: checking, then result or error */}
      <SubmitDialog
        phase={submitPhase}
        claimTitle={claimSummary(ocrReceipts.map(r => r.merchant))}
        amount={formatMoney("MYR", ocrReceipts.reduce((sum, r) => sum + r.transport + r.accommodation + r.meals + r.others, 0))}
        steps={compliance.steps}
        error={submitError}
        showLeaveNotice={showLeaveNotice}
        onCloseAttempt={handleDialogCloseAttempt}
        onRetry={handleSubmit}
        onBackToForm={() => setSubmitPhase("closed")}
        onLeave={() => router.push("/employee/dashboard")}
        onSubmitAnother={handleSubmitAnother}
        reimbursements={analysisResult?.reimbursements ?? []}
        fallbackFocus={() => document.getElementById("claims-page-title")}
      />

      {/* ── Leave / Unsaved-Changes dialog ──────────────────────────────────── */}
      <ClaimDialog
        open={showLeaveModal}
        labelledBy={leaveModalStep === "confirm" ? "leave-modal-title" : "draft-name-title"}
        onCancel={() => { if (!isSavingLeave) setShowLeaveModal(false); }}
        className="max-w-sm"
      >
        {leaveModalStep === "confirm" ? (
          /* Step 1: confirm save or discard */
          <div className="flex flex-col gap-5 p-5 sm:p-6">
            <div className="flex flex-col gap-1.5">
              <h3 id="leave-modal-title" className="text-lg font-semibold text-ink font-display">
                You have unsaved changes
              </h3>
              <p className="text-sm text-ink-muted font-body leading-relaxed">
                Do you want to save this as a draft before leaving? You can resume it later from the Drafts tab.
              </p>
            </div>

            <div className="flex flex-col gap-2">
              <button
                id="leave-modal-save-btn"
                type="button"
                onClick={() => {
                  setLeaveModalMode("leaving");
                  if (loadedDraftIdRef.current) {
                    // Existing draft: save silently without asking for a name
                    handleSaveAndLeave();
                  } else {
                    // New draft: must enter a name first
                    setLeaveModalStep("name");
                  }
                }}
                className="w-full min-h-11 rounded-full bg-accent text-on-accent font-semibold text-sm font-body hover:bg-accent-hover transition-colors"
              >
                Save Draft
              </button>
              <button
                id="leave-modal-discard-btn"
                type="button"
                onClick={handleDiscardAndLeave}
                className="w-full min-h-11 rounded-control border border-line-strong text-danger font-semibold text-sm font-body hover:bg-danger-soft transition-colors"
              >
                Discard & Leave
              </button>
              <button
                id="leave-modal-cancel-btn"
                type="button"
                onClick={() => setShowLeaveModal(false)}
                className="w-full min-h-11 rounded-control text-ink font-medium text-sm font-body hover:bg-surface-muted transition-colors"
              >
                Stay on this page
              </button>
            </div>
          </div>
        ) : (
          /* Step 2: name input (new draft); an existing draft saves without this step */
          <div className="flex flex-col gap-5 p-5 sm:p-6">
            <div className="flex flex-col">
              {leaveModalMode === "leaving" && (
                <button
                  type="button"
                  onClick={() => setLeaveModalStep("confirm")}
                  className="self-start -ml-2 mb-2 min-h-11 px-2 rounded-control text-sm font-semibold text-ink-muted hover:text-ink hover:bg-surface-muted flex items-center gap-1 transition-colors"
                >
                  <span aria-hidden="true">←</span> Back
                </button>
              )}
              <h3 id="draft-name-title" className="text-lg font-semibold text-ink font-display">
                Name your draft
              </h3>
              <p className="text-sm text-ink-muted font-body mt-1 mb-4 leading-relaxed">
                Give it a meaningful name so you can find it easily later.
              </p>

              <label htmlFor="draft-title-input" className="sr-only">Draft name</label>
              <input
                id="draft-title-input"
                type="text"
                autoFocus
                value={pendingDraftTitle}
                onChange={e => setPendingDraftTitle(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && pendingDraftTitle.trim()) handleSaveAndLeave(); }}
                placeholder="e.g. Kuching trip, April 2026"
                className="w-full min-h-11 bg-surface border border-line-strong rounded-control px-3 text-sm text-ink font-body focus:border-accent placeholder:text-ink-muted"
              />
            </div>

            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowLeaveModal(false)}
                className="flex-1 min-h-11 rounded-control border border-line-strong bg-surface text-ink font-semibold text-sm font-body hover:bg-surface-muted transition-colors"
              >
                Cancel
              </button>
              <button
                id="draft-save-confirm-btn"
                type="button"
                onClick={handleSaveAndLeave}
                disabled={(!loadedDraftId && !pendingDraftTitle.trim()) || isSavingLeave}
                className="flex-1 min-h-11 rounded-full font-semibold text-sm font-body transition-colors bg-accent text-on-accent hover:bg-accent-hover disabled:bg-surface-muted disabled:text-ink-muted"
              >
                {isSavingLeave ? "Saving…" : leaveModalMode === "saving" ? "Save Draft" : "Save & Leave"}
              </button>
            </div>
          </div>
        )}
      </ClaimDialog>
    </div>
  );
}

export default function CaptureReceiptPage() {
  return (
    <Suspense fallback={
      <div className="flex items-center justify-center min-h-screen bg-surface">
        <div className="flex flex-col items-center gap-4">
          <Loader2 className="w-10 h-10 text-accent animate-spin" />
          <p className="text-sm font-medium text-ink-muted font-body">Loading Capture Receipts...</p>
        </div>
      </div>
    }>
      <CaptureReceiptContent />
    </Suspense>
  );
}
