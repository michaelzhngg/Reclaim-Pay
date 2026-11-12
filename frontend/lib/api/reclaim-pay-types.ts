// ─── Reclaim Pay Types ───────────────────────────────────────────────────────
// Mirrors the backend contracts in docs/superpowers/specs/2026-11-02-reclaim-pay-hackathon-design.md.
// Settings and back-test types join this file when their endpoints land.
// ──────────────────────────────────────────────────────────────────────────────

export type AutonomyTier = "AUTO_PAY" | "HR_QUICK" | "HR_REVIEW" | "DUAL_REVIEW";

export type TrustTier = "NEW" | "STANDARD" | "TRUSTED";

export type Severity = "LOW" | "MEDIUM" | "HIGH";

export type SignalCode =
  | "PROMPT_INJECTION"
  | "DUPLICATE_RECEIPT"
  | "AI_PROVENANCE"
  | "HUMAN_EDIT_HIGH"
  | "ARITHMETIC_MISMATCH"
  | "EDITING_SOFTWARE"
  | "SPLIT_CLAIM"
  | "VISUAL_ANOMALY"
  | "HUMAN_EDIT_MEDIUM"
  | "PRICE_ABOVE_MARKET"
  | "NEAR_THRESHOLD"
  | "NO_CAMERA_METADATA";

export type HardStop =
  | "AUTONOMY_PAUSED"
  | "CIRCUIT_BREAKER"
  | "AI_NOT_APPROVED"
  | "PAYEE_NOT_VERIFIED"
  | "PAYEE_COOLDOWN"
  | "HR_SELF_CLAIM"
  | "OVER_CATEGORY_BUDGET"
  | "OVER_AUTO_LIMIT"
  | "EMPLOYEE_DAILY_CAP"
  | "EMPLOYEE_MONTHLY_CAP"
  | "AGENT_DAILY_BUDGET"
  | "HIGH_RISK_SIGNAL"
  | "EXPECTED_LOSS";

export interface RiskSignal {
  code: SignalCode;
  severity: Severity;
  points: number;
  /** HR-facing wording. Never shown to the employee. */
  message: string;
  evidence: Record<string, unknown>;
  document_id: string | null;
}

/** Carried as `autonomy` on each reimbursement in the analysis `complete` event. */
export interface AutonomyDecision {
  tier: AutonomyTier;
  risk_score: number;
  confidence_points: number;
  trust_tier: TrustTier;
  auto_limit: number;
  hard_stops: HardStop[];
  signals: RiskSignal[];
  expected_loss: number;
  explanation: string;
  audit_selected: boolean;
  config_version: number;
}

/** Step ids in the order the backend runs them. */
export const TIMELINE_STEP_IDS = [
  "policy.load",
  "receipt.analyze",
  "shield.injection",
  "shield.duplicate",
  "shield.provenance",
  "shield.arithmetic",
  "shield.split",
  "shield.price",
  "totals.aggregate",
  "judgment.final",
  "autonomy.decide",
  "payout.create",
] as const;

export type TimelineStepId = (typeof TIMELINE_STEP_IDS)[number];

export type TimelineStatus = "running" | "done" | "warn" | "fail";

/** A `progress` event with `stage: "timeline"` on the analysis SSE stream. */
export interface TimelineEvent {
  stage: "timeline";
  step: TimelineStepId;
  label: string;
  status: TimelineStatus;
  detail: string | null;
  ts: string;
}

/** One row of the timeline as rendered, after the audience filter. */
export interface TimelineStepState {
  step: TimelineStepId;
  label: string;
  status: TimelineStatus;
  detail: string | null;
}

export type PayoutStatus =
  | "ACCEPTED"
  | "REQUESTED"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "REVERSED";

export const TERMINAL_PAYOUT_STATUSES: readonly PayoutStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "REVERSED",
];

/** GET /paypal/status */
export interface PayeeStatus {
  linked: boolean;
  email_masked: string | null;
  verified: boolean;
  linked_at: string | null;
  cooldown_until: string | null;
  /** Set only in a session started with Sign in with PayPal. */
  link_changes_paused_until?: string | null;
}

/** GET /payouts/{reim_id} */
export interface PayoutInfoV2 {
  payout_id: string;
  reim_id: string;
  user_id: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  provider: string;
  provider_batch_id: string | null;
  provider_item_id: string | null;
  attempt: number;
  reference_id: string;
  channel_code: string;
  failure_code: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /payouts/ (HR ledger) */
export interface PayoutLedgerRow {
  payout_id: string;
  reim_id: string;
  claim_ref: string;
  employee_name: string;
  amount: number;
  currency: string;
  status: PayoutStatus;
  tier: AutonomyTier | null;
  provider_batch_id: string | null;
  provider_item_id: string | null;
  attempt: number;
  audit_selected: boolean;
  created_at: string;
  updated_at: string;
}

export interface LedgerFilters {
  status?: PayoutStatus;
  from?: string;
  to?: string;
}

// ─── Triage and batch approval ───────────────────────────────────────────────

/** One HR approval recorded on a claim. DUAL_REVIEW claims need two. */
export interface Approval {
  hr_id: string;
  at: string;
}

/** Fields GET /reimbursements/ adds to each item once the autonomy engine runs. Older rows leave them empty. */
export interface ReimbursementAutonomyFields {
  tier?: AutonomyTier | null;
  risk_score?: number | null;
  autonomy?: Partial<AutonomyDecision> | null;
  audit_selected?: boolean | null;
  approvals?: Approval[] | null;
}

export type BatchSkipReason = "NOT_HR_QUICK" | "NOT_IN_REVIEW" | "SELF_APPROVAL" | "NOTHING_TO_PAY";

/** POST /reimbursements/batch-approve */
export interface BatchApproveResult {
  approved: string[];
  skipped: { reim_id: string; reason: BatchSkipReason }[];
}

// ─── Employee trust and recoveries ───────────────────────────────────────────

/** GET /autonomy/me (employee; HR gets 403). Holds no risk scores or signals. */
export interface TrustInfo {
  trust_tier: TrustTier;
  auto_limit: number;
  paid_claims: number;
  /** null at the top tier. */
  next_tier: TrustTier | null;
  claims_to_next_tier: number;
  /** Employee-facing sentences, e.g. why instant payouts are limited. Empty when nothing is wrong. */
  reasons: string[];
  currency: string;
  /** null at the top tier. */
  next_limit: number | null;
  /** Set while a recent correction keeps the employee at NEW. */
  limited_until: string | null;
  /** Up to 3 most recent level changes, newest first. Missing from older backends. */
  changes?: TrustChange[];
  /** Every level with its current limit, lowest first. */
  levels?: TrustLevel[];
  /** Days one correction holds the employee at NEW. */
  hold_days?: number | null;
  /** Days without a correction that TRUSTED needs. */
  trusted_clean_days?: number | null;
}

/** Why a level changed. Never names the check behind a correction. */
export type TrustChangeCause = "approved_claims" | "time_passed" | "correction" | "recovery";

export interface TrustChange {
  at: string;
  from_tier: TrustTier;
  to_tier: TrustTier;
  from_limit: number;
  to_limit: number;
  cause: TrustChangeCause;
  /** The claim a correction or recovery was on; null for the other causes. */
  reim_id: string | null;
}

export interface TrustLevel {
  tier: TrustTier;
  auto_limit: number;
  min_paid_claims: number;
}

export type RecoveryStatus = "NOTICE_SENT" | "DISPUTED" | "OFFSET" | "INVOICED" | "RECOVERED" | "WAIVED";

/** Why POST /recoveries/{id}/dispute failed: the 409 codes DISPUTE_WINDOW_CLOSED and NOT_DISPUTABLE, or anything else. */
export type DisputeError = "WINDOW_CLOSED" | "NOT_DISPUTABLE" | "FAILED";

/** GET /recoveries, POST /recoveries/{id}/dispute */
export interface Recovery {
  recovery_id: string;
  reim_id: string;
  user_id: string;
  amount: number;
  currency: string;
  reason: string;
  status: RecoveryStatus;
  dispute_until: string;
  dispute_note: string | null;
  offset_reim_id: string | null;
  paypal_invoice_id: string | null;
  created_at: string;
  updated_at: string;
}

/** What POST /recoveries/{id}/execute would do right now. */
export type RecoveryPath = "WAIT" | "OFFSET" | "INVOICE";

/** GET /recoveries/{id}/invoice-preview */
export interface RecoveryInvoicePreview {
  note: string;
  amount: number;
  currency: string;
  recipient_email_masked: string;
  path: RecoveryPath;
}

/** The autonomy engine's tunable limits (DETAIL-PLAN §7.1). `enabled` and `version` are server-owned on save. */
export interface AutonomyConfig {
  enabled: boolean;
  currency: string;
  auto_limit_new: number;
  auto_limit_standard: number;
  auto_limit_trusted: number;
  dual_approval_above: number;
  employee_daily_cap: number;
  employee_monthly_cap: number;
  agent_daily_budget: number;
  quick_min_score: number;
  review_min_score: number;
  dual_min_score: number;
  review_cost: number;
  review_minutes: number;
  recovery_rate: number;
  audit_sample_rate: number;
  payee_cooldown_hours: number;
  breaker_window: number;
  breaker_high_ratio: number;
  breaker_pause_minutes: number;
  dispute_window_hours: number;
  version: number;
}

/** GET/PUT /autonomy/settings and POST /autonomy/kill-switch */
export interface AutonomySettings {
  config: AutonomyConfig;
  enabled: boolean;
  version: number;
  /** ISO time the circuit breaker lifts, or null when it isn't tripped. */
  breaker_until: string | null;
}

/** GET /autonomy/status */
export interface AutonomyStatus {
  enabled: boolean;
  breaker_until: string | null;
  auto_paid_today: number;
  agent_daily_budget: number;
  decisions_today_by_tier: Partial<Record<AutonomyTier, number>>;
}

/** One point of the back-test sweep over the standard limit. */
export interface BacktestPoint {
  auto_limit_standard: number;
  automation_rate: number;
  projected_leakage: number;
}

/** POST /autonomy/backtest: the last 90 days replayed under a candidate config. */
export interface BacktestResult {
  total_claims: number;
  auto_paid_count: number;
  automation_rate: number;
  auto_paid_amount: number;
  bad_auto_paid_count: number;
  projected_leakage: number;
  caught_bad_count: number;
  hr_reviews_avoided: number;
  hr_hours_saved: number;
  by_tier: Partial<Record<AutonomyTier, number>>;
  curve: BacktestPoint[];
  assumptions: string[];
}

export type AgentActionType =
  | "CONFIG_CHANGED"
  | "KILL_SWITCH"
  | "BREAKER_TRIPPED"
  | "PAYOUT_CREATED"
  | (string & {});

/** One entry of the hash-chained agent log. */
export interface AgentAction {
  action_id: number;
  action_type: AgentActionType;
  actor: string;
  reim_id: string | null;
  payload: Record<string, unknown>;
  prev_hash?: string;
  hash: string;
  created_at: string;
}

/** GET /autonomy/actions */
export interface AgentActionsResult {
  chain_valid: boolean;
  actions: AgentAction[];
}

/** Formats an amount the way the backend writes it in notifications, e.g. "MYR 48.00". */
export function formatMoney(currency: string, amount: number): string {
  return `${currency} ${amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ─── Policy limits (E1) ──────────────────────────────────────────────────────

export type LimitKind = "CAP" | "PRE_APPROVAL";
export type LimitUnit = "PER_DAY" | "PER_NIGHT" | "PER_MEAL" | "PER_ITEM" | "ACTUAL";
export type TravelScope = "ANY" | "DOMESTIC" | "OVERSEAS";
export type LimitStatus = "PROPOSED" | "CONFIRMED";

export interface LimitRule {
  category: string;
  kind: LimitKind;
  unit: LimitUnit;
  /** null when the unit is ACTUAL. */
  amount: number | null;
  currency: string;
  grade_min: number | null;
  grade_max: number | null;
  scope: TravelScope;
  zone: string | null;
  source_section: string | null;
  source_quote: string | null;
}

export interface ZonePlace {
  zone: string;
  /** "*" means every place not listed. */
  place: string;
}

/** GET /policies/{id}/limits (HR only). Employees never receive PROPOSED rows. */
export interface PolicyLimits {
  policy_id: string;
  categories: string[];
  limits: (LimitRule & { limit_id: string; status: LimitStatus })[];
  zones: (ZonePlace & { status: LimitStatus })[];
  has_suggestions: boolean;
  policy_active: boolean;
  /** Categories whose confirmed limits employees see: the policy is ACTIVE and claims use it for them. */
  employee_visible_categories: string[];
}
