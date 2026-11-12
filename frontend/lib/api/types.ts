// ─── Shared API Types ─────────────────────────────────────────────────────────
// Central TypeScript type definitions matching the FastAPI backend responses.
// These types are used by both server actions and UI components.
// ──────────────────────────────────────────────────────────────────────────────

import { formatMoney, type AutonomyDecision, type AutonomyTier } from "./reclaim-pay-types";
import type { ClaimAutonomy } from "@/lib/hr/evidence";
import type { ContractRecord } from "@/lib/contracts";

// ─── Generic API Result ──────────────────────────────────────────────────────

/** Standardised wrapper for all API client responses. */
export interface ApiResult<T> {
  data: T | null;
  error: string | null;
  /** HTTP status code, present on error responses. Use to distinguish 429 (rate limit) from 401/403/500. */
  status?: number;
}

// ─── Auth ────────────────────────────────────────────────────────────────────

/** Matches GET /api/v1/auth/me → UserResponse */
export interface User {
  user_id: string;
  user_code?: string | null;
  email: string;
  name: string;
  role: "HR" | "Employee" | "Contractor";
  department_id?: string | null;
  department_name?: string | null;
  rank?: number;
  privilege_level?: string;
  is_active?: boolean;
  created_at?: string | null;
}

// ─── Departments ─────────────────────────────────────────────────────────────

export interface Department {
  department_id: string;
  name: string;
  cost_center_code?: string | null;
}

// ─── Dashboard & Statistics ──────────────────────────────────────────────────

export interface DashboardStats {
  awaitingReview: {
    amount: string;
    count: number;
  };
  reimbursedThisMonth: {
    amount: string;
    count: number;
  };
  alreadyPaid: {
    amount: string;
    count: number;
  };
}

// ─── Claims ──────────────────────────────────────────────────────────────────

export type ClaimStatus = "Pending" | "Approved" | "Paid" | "Rejected" | "Disbursing";

export interface ClaimSummary {
  id: string;
  date: string;
  category: string;
  subCategory: string;
  merchant: string;
  amount: string;
  amountNumeric: number;
  status: ClaimStatus;
}

/** One line item inside a reimbursement (from the normalized line_items table). */
export interface LineItem {
  line_item_id: string;
  reim_id: string;
  document_id?: string | null;
  description: string;
  category: string;
  quantity?: number;
  unit_price?: number;
  claimed_amount: number;
  approved_amount?: number | null;
  /** Company-currency equivalents, when the backend has a quote. */
  claimed_company_amount?: number | null;
  approved_company_amount?: number | null;
  currency: string;
  expense_date?: string | null;
  judgment?: "APPROVED" | "REJECTED" | "PARTIAL" | "NEEDS_INFO" | null;
  rejection_reason?: string | null;
  policy_section_ref?: string | null;
  human_edited?: boolean | null;
  /** Frontend route that streams the uploaded receipt file; null when the file is missing. */
  receipt_url?: string | null;
}

/** Raw shape returned by the FastAPI GET /reimbursements/ and /reimbursements/{id} endpoints. */
/** A vendor the employee can book. Payout details stay on the server. */
export interface VendorOption {
  vendor_id: string;
  name: string;
  default_category?: string | null;
  paypal_ready: boolean;
}

export interface VendorBookingRequest {
  vendor_id?: string;
  vendor_name?: string;
  category: string;
  amount: number;
  service_start: string;
  service_end: string;
  purpose: string;
}

export interface ReimbursementRaw {
  reim_id: string;
  user_id: string;
  /** CLAIM for an ordinary expense claim, VENDOR_BOOKING for a company-paid vendor booking. */
  kind?: "CLAIM" | "VENDOR_BOOKING";
  employee_name?: string;
  department_name?: string;
  policy_id: string | null;
  policy_name?: string | null;
  /** Set for a contractor claim. */
  contract_id?: string | null;
  contract?: ContractRecord | null;
  /** True for a contractor invoice. It is still a CLAIM row with an invoice period. */
  is_invoice?: boolean;
  invoice_period_start?: string | null;
  invoice_period_end?: string | null;
  settlement_id: string | null;
  main_category: string;
  currency: string;
  company_currency?: string;
  total_claimed_amount: number;
  total_approved_amount: number | null;
  total_rejected_amount: number | null;
  /** Company-currency snapshots, and the quote behind them. */
  amount_company?: number | null;
  approved_company_amount?: number | null;
  fx_rate_to_company?: number | null;
  fx_rate_at?: string | null;
  fx_source?: string | null;
  fx_unavailable?: boolean;
  /** What approval locked: the amount and currency PayPal will send. */
  payout_amount?: number | null;
  payout_currency?: string | null;
  payout_fx_rate?: number | null;
  payout_fx_at?: string | null;
  /** What the payout would be if HR approved now. HR only, nothing is locked. */
  payout_preview?: PayoutPreview | null;
  line_items?: LineItem[];
  judgment: "APPROVED" | "REJECTED" | "PARTIAL" | "NEEDS_INFO";
  confidence: number | null;
  ai_reasoning: Record<string, unknown>;
  status: "PENDING" | "REVIEW" | "APPROVED" | "REJECTED" | "APPEALED" | "DISBURSING" | "PAID" | "DISBURSEMENT_FAILED";
  summary: string;
  reviewed_by?: string | null;
  reviewed_at?: string | null;
  ready_for_payout?: boolean;
  payout?: PayoutInfo | null;
  /** The backend reports DUAL_REVIEW as HR_REVIEW to employees. */
  tier?: AutonomyTier | null;
  created_at: string | null;
  updated_at?: string | null;
  sub_categories: string[];
  receipt_count?: number;
  /** Display-only fields (backend api/reimbursements.py). Never AI or HR judgment text. */
  employee_code?: string | null;
  payee_linked?: boolean;
  merchant_names?: string[];
  purpose?: string | null;
  destination?: string | null;
  location?: string | null;
  departure_date?: string | null;
  arrival_date?: string | null;
  /** Vendor booking display. Payout details are HR-only. */
  vendor_id?: string | null;
  vendor_name?: string | null;
  vendor_verified?: boolean | null;
  vendor_paypal_masked?: string | null;
  vendor_cooldown_until?: string | null;
  vendor_cooldown_hours?: number | null;
  service_start?: string | null;
  service_end?: string | null;
}

/** The expected payout HR sees before approving. Nothing is locked until approval. */
export interface PayoutPreview {
  amount: number;
  currency: string;
  /** Claim currency to payout currency. */
  rate: number | null;
  as_of: string | null;
  source: string | null;
  company_amount: number | null;
}

/** Merchant names for a claim, e.g. "Grab, Hilton +1". Empty when none were read. */
export function merchantLabel(r: Pick<ReimbursementRaw, "merchant_names">): string {
  const names = r.merchant_names ?? [];
  if (names.length === 0) return "";
  const shown = names.slice(0, 2).join(", ");
  return names.length > 2 ? `${shown} +${names.length - 2}` : shown;
}

/** Map a backend ReimbursementRaw into the frontend ClaimSummary shape. */
export function mapReimbursementToClaim(r: ReimbursementRaw): ClaimSummary {
  const amountValue = r.total_claimed_amount ?? 0;
  const formattedAmount = formatMoney(r.currency ?? "MYR", amountValue);

  let displayDate = "";
  if (r.created_at) {
    const d = new Date(r.created_at);
    displayDate = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  }

  const statusMap: Record<string, ClaimStatus> = {
    APPROVED: "Approved",
    REJECTED: "Rejected",
    PENDING: "Pending",
    REVIEW: "Pending",
    APPEALED: "Pending",
    DISBURSING: "Disbursing",
    PAID: "Paid",
    DISBURSEMENT_FAILED: "Rejected",
    Paid: "Paid",
  };

  return {
    id: r.reim_id,
    date: displayDate,
    category: r.policy_name ?? r.main_category ?? "General",
    subCategory: (r.kind ?? "CLAIM") === "VENDOR_BOOKING"
      ? "Vendor booking"
      : `${r.receipt_count ?? 0} receipts`,
    // Never r.summary: that is the AI's verdict, and employees must not see it.
    merchant: (r.kind ?? "CLAIM") === "VENDOR_BOOKING"
      ? (r.vendor_name || "Vendor booking")
      : merchantLabel(r),
    amount: formattedAmount,
    amountNumeric: amountValue,
    status: statusMap[r.status] ?? "Pending",
  };
}

export interface TimelineEvent {
  type: "Submitted" | "AI_Validation" | "HR_Review" | "Paid";
  status: "Completed" | "Pending" | "Failed";
  timestamp: string;
  description: string;
}

export interface DetailedClaim extends ClaimSummary {
  timeline: TimelineEvent[];
  receipts: {
    name: string;
    url: string;
    type: string;
    size: number;
  }[];
  clientName: string;
  purpose: string;
}

export interface HistorySummary {
  totalReimbursed: string;
  pendingAmount: string;
}

// ─── Frontend HR Dashboard Types (moved from mockData.ts) ────────────────────

/** Drives which dashboard tab a bundle appears in. */
export type AiStatus =
  | "Policy Flagged"
  | "Awaiting Review"
  | "Passed AI Review"
  | "Low Confidence"
  | "Auto-Approved"
  | "Auto-Rejected";

/** Per-receipt AI judgment — mirrors backend LineItemStatus. */
export type LineItemStatus = "APPROVED" | "REJECTED" | "PARTIAL_APPROVE" | "PENDING";

export interface AuditNote {
  tag: string;
  message: string;
}

export interface AuditLogEntry {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
}

/** One line item inside a ClaimBundle (frontend shape, not backend DB shape). */
export interface BundleLineItem {
  document_id: string;
  line_item_id?: string;
  date: string;
  category: "meals" | "transportation" | "accommodation" | "others";
  description: string;
  status: LineItemStatus;
  requested_amount: number;
  approved_amount: number;
  /** Invoice line quantity and rate, when the row is a contractor invoice. */
  quantity?: number | null;
  unit_price?: number | null;
  /** Company-currency equivalents for the receipt row, when a quote exists. */
  requested_company_amount?: number | null;
  approved_company_amount?: number | null;
  deduction_amount: number;
  audit_notes: AuditNote[];
  /** True if the employee manually edited the AI-extracted amount — Fraud Trap. */
  human_edited?: boolean;
  /** Original OCR-extracted amount before employee edit. */
  ocr_amount?: number;
  /** URL to the uploaded receipt image. */
  receipt_url?: string;
}

/** Claim Bundle (top-level — contains all receipts for one claim). */
export interface ClaimBundle {
  id: string;
  employee: {
    name: string;
    initials: string;
    employee_no: string;
    position: string;
    department: string;
    location: string;
    entity: string;
    email: string;
  };
  submitted_at: string;
  /** Claim currency and the company currency its limits and reports use. */
  currency: string;
  company_currency: string;
  amount_company: number | null;
  approved_company_amount: number | null;
  fx_rate_to_company: number | null;
  fx_rate_at: string | null;
  fx_source: string | null;
  fx_unavailable: boolean;
  /** What approval locked: the amount and currency PayPal will send. */
  payout_amount: number | null;
  payout_currency: string | null;
  payout_fx_rate: number | null;
  payout_fx_at: string | null;
  /** What the payout would be if HR approved now. */
  payout_preview: PayoutPreview | null;
  /** The contractor's terms, when this claim came from a contract. */
  contract: ContractRecord | null;
  /** True for a contractor invoice; the period is the work it covers. */
  is_invoice: boolean;
  invoice_period_start: string;
  invoice_period_end: string;
  /** HR-only reason from intake. Empty for a normal claim or an invoice at the contract rate. */
  invoice_contract_reason: string;
  invoice_over_contract_rate: boolean;
  travel_destination: string;
  travel_purpose: string;
  departure_date: string;
  arrival_date: string;
  is_overseas: boolean;
  /** Vendor booking fields. Empty for a claim. */
  kind?: "CLAIM" | "VENDOR_BOOKING";
  vendor_id?: string;
  vendor_name?: string;
  vendor_verified?: boolean;
  vendor_paypal_masked?: string;
  vendor_cooldown_until?: string;
  vendor_cooldown_hours?: number;
  service_start?: string;
  service_end?: string;
  line_items: BundleLineItem[];
  totals: {
    total_requested: number;
    total_deduction: number;
    net_approved: number;
  };
  overall_judgment: LineItemStatus;
  confidence: number;
  summary: string;
  overall_status: AiStatus;
  audit_log: AuditLogEntry[];
  /** The autonomy engine's decision. null for claims decided before it existed. */
  autonomy?: ClaimAutonomy | null;
  /** The claimant's user ID, so HR screens can tell when the viewer filed the claim. */
  claimant_id?: string;
}

/** Dashboard list row. */
export interface Claim {
  id: string;
  employee: { name: string; initials: string };
  date: string;
  amount: string;
  category: string;
  status: AiStatus;
  note?: string;
}

// ─── Reimbursement & Policy ──────────────────────────────────────────────────

export interface SubCategoryConfig {
  required_documents: string[];
  condition: string[];
}

/** Matches GET /api/v1/policies/ list items. */
export interface Policy {
  policy_id: string;
  alias: string;
  title: string;
  reimbursable_categories: string[];
  reimbursable_categories_with_budgets?: PolicyCategoryBudget[];
  overview_summary: string;
  mandatory_conditions: string;
  status: "DRAFT" | "ACTIVE" | "DEPRECATED";
  effective_date: string | null;
  expiry_date?: string | null;
  source_file_url: string;
  created_by?: string;
  created_at?: string | null;
}

export interface PolicyCategoryBudget {
  category: string;
  auto_approval_budget: number | null;
}

export interface ExtractedData {
  merchant: string;
  amount: string;
  date: string;
}

export interface ClaimSubmissionPayload {
  mainCategory: string;
  subCategory: string;
  clientName: string;
  purpose: string;
  extractedData: ExtractedData;
  files: string[];
}

// ─── Notifications ───────────────────────────────────────────────────────────

export interface Notification {
  id: string;
  type: "success" | "error" | "info" | "warning";
  title: string;
  message: string;
  timestamp: string;
  isRead: boolean;
  link?: string;
}

// ─── Settings & Banking ──────────────────────────────────────────────────────

export interface BankingDetails {
  bank_code: string | null;
  bank_account_number: string | null;
  bank_account_holder_name: string | null;
  bank_name: string | null;
}

export interface BankingUpdateRequest {
  bank_code: string;
  bank_account_number: string;
  bank_account_holder_name: string;
}

export interface UserProfileUpdate {
  name: string;
  email: string;
}

// ─── Payouts ──────────────────────────────────────────────────────────────────

export interface PayoutInfo {
  payout_id: string;
  amount: number;
  currency: string;
  status: "ACCEPTED" | "REQUESTED" | "SUCCEEDED" | "FAILED" | "CANCELLED" | "REVERSED";
  xendit_id?: string | null;
  channel_code: string;
  failure_code?: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface PayoutChannel {
  channel_code: string;
  channel_category: string;
  currency: string;
  channel_name: string;
  amount_limits: {
    minimum: number;
    maximum: number;
    minimum_increment: number;
  };
}

// ─── Document Upload ─────────────────────────────────────────────────────────

/** Employee object embedded in DocumentUploadResponse. */
export interface DocumentUploadEmployee {
  name: string;
  id: string;
  user_code: string;
  department: string | null;
  rank: number | null;
  destination: string | null;
  departure_date: string | null;
  arrival_date: string | null;
  location: string | null;
  overseas: boolean | null;
  purpose: string | null;
}

/** One OCR-processed receipt inside DocumentUploadResponse. */
export interface OcrReceiptResult {
  document_id: string;
  date: string;
  description: string;
  category: string;
  currency: string;
  amount: number;
  transportation: number;
  accommodation: number;
  meals: number;
  others: number;
  warnings: string[];
  extracted_data: Record<string, unknown>;
}

/** Category-level totals inside DocumentUploadResponse. */
export interface DocumentUploadTotals {
  transportation: number;
  accommodation: number;
  meals: number;
  others: number;
  grand_total: number;
  currency: string;
}

/** Matches POST /api/v1/documents/upload response. */
export interface DocumentUploadResponse {
  settlement_id: string;
  document_ids: string[];
  employee: DocumentUploadEmployee;
  receipts: OcrReceiptResult[];
  skipped_receipts: OcrReceiptResult[];
  totals: DocumentUploadTotals;
  all_warnings: string[];
  all_category: string[];
  main_category: string | null;
  task_id?: string;
}

// ─── Document Edits ───────────────────────────────────────────────────────────

/** Request body for POST /api/v1/documents/{document_id}/edits. */
export interface EditDocumentRequest {
  merchant_name?: string;
  date?: string;
  time?: string;
  currency?: string;
  total_amount?: number;
  destination?: string;
  departure_date?: string;
  arrival_date?: string;
  location?: string;
  overseas?: boolean;
}

/** Response for POST /api/v1/documents/{document_id}/edits. */
export interface EditDocumentResponse {
  document_id: string;
  human_edited: boolean;
  change_count: number;
}

// ─── Document Change Logs ────────────────────────────────────────────────────

export interface DocumentChangeLogEntry {
  log_id: string;
  document_id: string;
  changed_by: string;
  field_name: string;
  old_value?: string | null;
  new_value?: string | null;
  changed_at: string;
}

// ─── Compliance Analysis ──────────────────────────────────────────────────────

/** Request body for POST /api/v1/reimbursements/analyze. */
export interface AnalyzeRequest {
  settlement_id: string;
  document_ids?: string[];
}

/** Response for POST /api/v1/reimbursements/analyze. */
export interface AnalyzeResponse {
  reim_id: string;
  settlement_id: string | null;
  judgment: "APPROVED" | "REJECTED" | "PARTIAL" | "NEEDS_INFO";
  status: string;
  summary: string;
  line_items: LineItem[];
  total_claimed_amount: number;
  total_approved_amount: number | null;
  total_rejected_amount: number | null;
  confidence: number | null;
  currency: string;
  main_category: string;
  sub_categories: string[];
  created_at: string | null;
  message: string;
  task_id?: string;
  /** Reclaim Pay: present once the autonomy engine runs (spec, "Timeline over SSE"). */
  tier?: AutonomyTier | null;
  risk_score?: number | null;
  autonomy?: AutonomyDecision | Record<string, never> | null;
}

/** SSE complete payload for multi-policy autonomous analysis. */
export interface AnalyzeResponseMulti {
  reimbursements: AnalyzeResponse[];
  failed_groups?: { policy_alias: string; error: string }[];
}

// ─── Claim Drafts ─────────────────────────────────────────────────────────────

/** Lightweight draft summary (for list views / sidebar). */
export interface DraftSummary {
  draft_id: string;
  user_id: string;
  title: string | null;
  main_category: string | null;
  receipt_count: number;
  failed_receipt_count: number;
  created_at: string | null;
  updated_at: string | null;
}

/** Full draft data (for loading/resuming a claim). */
export interface DraftFull extends DraftSummary {
  settlement_id: string | null;
  draft_data: Record<string, unknown>;
}

/** Request body for POST /api/v1/drafts/ */
export interface DraftSaveRequest {
  title?: string | null;
  main_category?: string | null;
  settlement_id?: string | null;
  draft_data: Record<string, unknown>;
  receipt_count: number;
  failed_receipt_count: number;
}

/** Response for GET /api/v1/drafts/count */
export interface DraftCountResponse {
  count: number;
}
