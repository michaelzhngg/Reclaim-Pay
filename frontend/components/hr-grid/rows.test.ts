import { describe, it, expect } from "vitest";
import {
  approveButtonLabel,
  batchResultMessage,
  claimHref,
  exclusionReason,
  exclusionSummary,
  formatSubmitted,
  formatTotal,
  riskBand,
  rowsForTab,
  statusLabel,
  tierTabs,
  toTriageRow,
  triageRows,
  type TriageSource,
} from "./rows";

const raw = (over: Partial<TriageSource> = {}): TriageSource =>
  ({
    reim_id: "1a2b3c4d-0000-0000-0000-000000000000",
    user_id: "emp-1",
    employee_name: "Aisyah",
    main_category: "Travel",
    total_claimed_amount: 48,
    currency: "MYR",
    judgment: "APPROVED",
    confidence: 0.95,
    status: "REVIEW",
    created_at: "2026-11-03T10:00:00Z",
    tier: "HR_QUICK",
    risk_score: 20,
    audit_selected: false,
    approvals: [],
    autonomy: { signals: [{ code: "SPLIT_CLAIM", severity: "MEDIUM", points: 20, message: "split", evidence: {}, document_id: null }] },
    ...over,
  }) as TriageSource;

describe("toTriageRow", () => {
  it("maps the tier fields and the short ref", () => {
    const r = toTriageRow(raw());
    expect(r.ref).toBe("RC-1A2B3C4D");
    expect(r.tier).toBe("HR_QUICK");
    expect(r.riskScore).toBe(20);
    expect(r.signals).toEqual([{ code: "SPLIT_CLAIM", severity: "MEDIUM" }]);
  });

  it("treats old claims without a tier as HR_REVIEW", () => {
    expect(toTriageRow(raw({ tier: null, autonomy: {} })).tier).toBe("HR_REVIEW");
    expect(toTriageRow(raw({ tier: undefined, risk_score: undefined, autonomy: null })).riskScore).toBe(0);
  });

  it("falls back to the stored decision when the top-level fields are missing", () => {
    const r = toTriageRow(raw({ tier: null, risk_score: null, autonomy: { tier: "DUAL_REVIEW", risk_score: 80 } }));
    expect(r.tier).toBe("DUAL_REVIEW");
    expect(r.riskScore).toBe(80);
  });

  it("puts the most severe signals first", () => {
    const r = toTriageRow(
      raw({
        autonomy: {
          signals: [
            { code: "NO_CAMERA_METADATA", severity: "LOW", points: 5, message: "", evidence: {}, document_id: null },
            { code: "ARITHMETIC_MISMATCH", severity: "MEDIUM", points: 20, message: "", evidence: {}, document_id: null },
            { code: "AI_PROVENANCE", severity: "HIGH", points: 50, message: "", evidence: {}, document_id: null },
          ],
        },
      }),
    );
    expect(r.signals.map((s) => s.code)).toEqual(["AI_PROVENANCE", "ARITHMETIC_MISMATCH", "NO_CAMERA_METADATA"]);
  });

  it("counts approvals", () => {
    expect(toTriageRow(raw({ approvals: [{ hr_id: "hr-1", at: "2026-11-03T10:05:00Z" }] })).approvals).toBe(1);
  });
});

describe("tierTabs", () => {
  it("counts by tier", () => {
    const rows = [toTriageRow(raw()), toTriageRow(raw({ tier: "DUAL_REVIEW" })), toTriageRow(raw({ tier: "HR_QUICK" }))];
    expect(tierTabs(rows)).toMatchObject({ all: 3, HR_QUICK: 2, DUAL_REVIEW: 1, HR_REVIEW: 0, AUTO_PAY: 0 });
  });

  it("filters rows for a tab", () => {
    const rows = [toTriageRow(raw()), toTriageRow(raw({ tier: "DUAL_REVIEW" }))];
    expect(rowsForTab(rows, "all")).toHaveLength(2);
    expect(rowsForTab(rows, "DUAL_REVIEW").map((r) => r.tier)).toEqual(["DUAL_REVIEW"]);
  });
});

describe("triageRows", () => {
  const now = Date.parse("2026-11-03T12:00:00Z");

  it("keeps claims waiting on HR and auto-pays from the last 24 hours, newest first", () => {
    const rows = triageRows(
      [
        raw({ reim_id: "aaaaaaaa-1", created_at: "2026-11-03T09:00:00Z" }),
        raw({ reim_id: "bbbbbbbb-1", status: "PAID", tier: "AUTO_PAY", created_at: "2026-11-03T11:00:00Z" }),
        raw({ reim_id: "cccccccc-1", status: "PAID", tier: "AUTO_PAY", created_at: "2026-11-01T11:00:00Z" }),
        raw({ reim_id: "dddddddd-1", status: "APPROVED", tier: null, created_at: "2026-11-03T11:30:00Z" }),
      ],
      now,
    );
    expect(rows.map((r) => r.ref)).toEqual(["RC-BBBBBBBB", "RC-AAAAAAAA"]);
  });
});

describe("batch approval", () => {
  it("only quick claims in review, not your own, can be selected", () => {
    expect(exclusionReason(toTriageRow(raw()), "hr-1")).toBeNull();
    expect(exclusionReason(toTriageRow(raw({ tier: "HR_REVIEW" })), "hr-1")).toBe("NOT_HR_QUICK");
    expect(exclusionReason(toTriageRow(raw({ status: "APPROVED" })), "hr-1")).toBe("NOT_IN_REVIEW");
    expect(exclusionReason(toTriageRow(raw({ user_id: "hr-1" })), "hr-1")).toBe("SELF_APPROVAL");
  });

  it("keeps a vendor booking out of batch approval", () => {
    const row = toTriageRow(raw({ kind: "VENDOR_BOOKING", vendor_name: "Hotel Seri Kenanga" }));
    expect(row.kind).toBe("VENDOR_BOOKING");
    expect(row.vendorName).toBe("Hotel Seri Kenanga");
    expect(exclusionReason(row, "hr-1")).toBe("VENDOR_BOOKING");
  });

  it("carries the vendor verification, dates and purpose for HR", () => {
    const row = toTriageRow(raw({
      kind: "VENDOR_BOOKING",
      vendor_name: "Hotel Seri Kenanga",
      vendor_verified: true,
      service_start: "2026-11-17",
      service_end: "2026-11-19",
      purpose: "Regional sales meeting",
    }));
    expect(row.vendorVerified).toBe(true);
    expect(row.serviceStart).toBe("2026-11-17");
    expect(row.serviceEnd).toBe("2026-11-19");
    expect(row.purpose).toBe("Regional sales meeting");
  });

  it("treats a record without a kind as an ordinary claim", () => {
    const row = toTriageRow(raw({ kind: undefined }));
    expect(row.kind).toBe("CLAIM");
    expect(row.vendorName).toBeNull();
  });

  it("labels the button with the count and the total", () => {
    const rows = [toTriageRow(raw({ total_claimed_amount: 90 })), toTriageRow(raw({ total_claimed_amount: 312 }))];
    expect(approveButtonLabel(rows)).toBe("Approve 2 claims · MYR 402.00");
    expect(approveButtonLabel(rows.slice(0, 1))).toBe("Approve 1 claim · MYR 90.00");
    expect(approveButtonLabel([])).toBe("Select claims to approve");
  });

  it("keeps currencies apart in the total", () => {
    expect(formatTotal([{ amount: 10, currency: "MYR" }, { amount: 5, currency: "USD" }])).toBe("MYR 10.00 + USD 5.00");
  });

  it("summarizes exclusions for the confirmation sheet", () => {
    const rows = [toTriageRow(raw()), toTriageRow(raw({ user_id: "hr-1" }))];
    expect(exclusionSummary(rows, "hr-1")).toBe("1 excluded: your own claim");
    expect(exclusionSummary(rows.slice(0, 1), "hr-1")).toBeNull();
  });

  it("words the result like the copy deck", () => {
    expect(batchResultMessage({ approved: ["a", "b"], skipped: [{ reim_id: "c", reason: "NOT_HR_QUICK" }] })).toBe(
      "Approved 2. Skipped 1: not a quick-approval claim.",
    );
    expect(
      batchResultMessage({
        approved: [],
        skipped: [
          { reim_id: "c", reason: "NOT_IN_REVIEW" },
          { reim_id: "d", reason: "NOT_IN_REVIEW" },
          { reim_id: "e", reason: "SELF_APPROVAL" },
        ],
      }),
    ).toBe("Approved 0. Skipped 3: already decided, your own claim.");
    expect(batchResultMessage({ approved: ["a"], skipped: [] })).toBe("Approved 1.");
  });
});

describe("display helpers", () => {
  it("bands risk on the default score cut-offs", () => {
    expect([0, 19, 20, 49, 50, 79, 80, 100].map(riskBand)).toEqual(["low", "low", "quick", "quick", "review", "review", "dual", "dual"]);
  });

  it("shows two-person progress instead of a plain status", () => {
    expect(statusLabel({ status: "REVIEW", tier: "DUAL_REVIEW", approvals: 1 })).toBe("1 of 2 approvals");
    expect(statusLabel({ status: "REVIEW", tier: "DUAL_REVIEW", approvals: 0 })).toBe("Needs review");
    expect(statusLabel({ status: "PAID", tier: "AUTO_PAY", approvals: 0 })).toBe("Paid");
  });

  it("shows the time for today and the date for older claims", () => {
    const now = new Date("2026-11-03T12:00:00Z");
    expect(formatSubmitted("2026-11-03T09:04:00Z", now, "UTC")).toMatch(/09:04/);
    expect(formatSubmitted("2026-11-01T09:04:00Z", now, "UTC")).toMatch(/1 Nov/);
  });

  it("opens the review page only for claims waiting on HR", () => {
    expect(claimHref({ reimId: "x", status: "REVIEW" })).toBe("/hr/review/x");
    expect(claimHref({ reimId: "x", status: "PAID" })).toBe("/hr/view/x");
  });
});
