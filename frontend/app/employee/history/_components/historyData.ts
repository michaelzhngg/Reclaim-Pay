"use client";
// ─── historyData.ts ─────────────────────────────────────────────────────────
// Single source of truth for all claim history types, mock data, and helpers.
// Lives entirely within frontend/app/employee/history/, no external deps.
// ────────────────────────────────────────────────────────────────────────────

import {
  Plane,
  UtensilsCrossed,
  Laptop,
  Receipt,
  Car,
  BedDouble,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

// ─── Types ───────────────────────────────────────────────────────────────────

export type ClaimStatus =
  | "Pending"
  | "Approved"
  | "Partially Approved"
  | "Paid"
  | "Rejected";

/** A single deduction reason attached to a line item. */
export interface Adjustment {
  code: string;         // e.g. "EXCEEDS_CAP"
  description: string;  // human-readable text shown in the drawer
}

/** One receipt / expense row within a claim. */
export interface LineItem {
  receiptRef: string;                             // e.g. "REC-01"
  category: string;
  requested: number;
  approved: number;
  lineStatus: "Approved" | "Adjusted" | "Rejected" | "Pending";
  adjustments: Adjustment[];                      // empty when lineStatus === "Approved" or "Pending"
}

export interface HistoryClaim {
  id: string;
  date: string;
  category: string;
  subCategory: string;
  categoryIcon: LucideIcon;
  merchant: string;
  amount: string;           // pre-formatted, e.g. "MYR 1,200.00"
  amountNumeric: number;
  approvedAmount: number;
  status: ClaimStatus;
  hrNote?: string;
  lineItems: LineItem[];
  receiptCount: number;
  /** Backend URL used by the Download PDF button. */
  pdfDownloadUrl: string;
  /** Backend settlement ID, used for PDF/template download. */
  settlementId?: string | null;
  /** Settlement template endpoint URL. */
  settlementTemplateUrl?: string;
  employee: {
    name: string;
    id: string;
    department: string;
    position: string;
  };
  claimContext: {
    destination?: string;
    purpose: string;
    departurDate?: string;
    arrivalDate?: string;
    overseas: boolean;
  };
}

// ─── Category icons ───────────────────────────────────────────────────────────
// Matches on the category and sub-category words, so "Ground Transport" gets a car.

const CATEGORY_ICONS: Array<[RegExp, LucideIcon]> = [
  [/flight|air|plane/i, Plane],
  [/transport|taxi|grab|car|mileage|fuel|petrol|toll|parking|bus|train/i, Car],
  [/hotel|accom|lodg|stay/i, BedDouble],
  [/meal|food|dining|restaurant|lunch|dinner|breakfast|entertain/i, UtensilsCrossed],
  [/equip|laptop|computer|software|hardware|device/i, Laptop],
];

export function categoryIcon(...labels: Array<string | null | undefined>): LucideIcon {
  const text = labels.filter(Boolean).join(" ");
  return CATEGORY_ICONS.find(([re]) => re.test(text))?.[1] ?? Receipt;
}

// ─── Status helpers ───────────────────────────────────────────────────────────

export const STATUS_BADGE: Record<ClaimStatus, string> = {
  Pending:              "bg-surface-muted text-ink",
  Approved:             "bg-accent-soft text-accent-hover",
  "Partially Approved": "bg-warning-soft text-warning",
  Paid:                 "bg-success-soft text-success",
  Rejected:             "bg-danger-soft text-danger",
};

// ─── Shared employee ──────────────────────────────────────────────────────────

const ME = {
  name:       "Alex Tan Wei Ming",
  id:         "EMP-00421",
  department: "Product & Engineering",
  position:   "Senior Software Engineer",
};

// ─── Mock Claims (removed, now fetched from backend) ────────────────────────

export const HISTORY_CLAIMS: HistoryClaim[] = [];
