import { describe, expect, it } from "vitest";
import type { MaintenanceReport, WebhookEvent } from "@/lib/api/reclaim-pay-types";
import {
  ageHours,
  eventLabel,
  eventStatusLabel,
  formatAge,
  maintenanceSummary,
  sortEvents,
  stuckReason,
} from "./webhookHealth";

function event(over: Partial<WebhookEvent>): WebhookEvent {
  return {
    event_id: "WH-1",
    event_type: "PAYMENT.PAYOUTS-ITEM.SUCCEEDED",
    resource_id: "I1",
    status: "FAILED",
    attempts: 2,
    error: "boom",
    created_at: "2026-11-12T08:00:00Z",
    updated_at: "2026-11-12T10:00:00Z",
    processed_at: null,
    ...over,
  };
}

describe("eventLabel", () => {
  it("reads the family and outcome", () => {
    expect(eventLabel("PAYMENT.PAYOUTS-ITEM.SUCCEEDED")).toBe("Payment payouts item succeeded");
    expect(eventLabel("INVOICING.INVOICE.PAID")).toBe("Invoice paid");
  });
  it("falls back readably for unknown or empty types", () => {
    expect(eventLabel("CHECKOUT.ORDER.APPROVED")).toBe("Checkout order approved");
    expect(eventLabel("")).toBe("Not set");
  });
});

describe("eventStatusLabel", () => {
  it("names the queue states in plain words", () => {
    expect(eventStatusLabel("DEAD_LETTER")).toBe("Dead letter");
    expect(eventStatusLabel("FAILED")).toBe("Failed");
    expect(eventStatusLabel("RECEIVED")).toBe("In flight");
    expect(eventStatusLabel("SOMETHING_NEW")).toBe("Something new");
  });
});

describe("formatAge", () => {
  it("uses hours under a day and days above", () => {
    expect(formatAge(0.4)).toBe("Under 1h");
    expect(formatAge(5.9)).toBe("5h");
    expect(formatAge(30)).toBe("1d 6h");
    expect(formatAge(48)).toBe("2d");
  });
  it("does not invent a value", () => {
    expect(formatAge(null)).toBe("Not set");
    expect(formatAge(Number.NaN)).toBe("Not set");
    expect(formatAge(-1)).toBe("Not set");
  });
});

describe("ageHours", () => {
  it("compares an ISO timestamp to a fixed now", () => {
    expect(ageHours("2026-11-12T10:00:00Z", Date.parse("2026-11-12T12:00:00Z"))).toBe(2);
  });
  it("returns NaN for an unreadable date", () => {
    expect(Number.isNaN(ageHours("not-a-date"))).toBe(true);
  });
});

describe("sortEvents", () => {
  it("puts the newest update first without mutating the input", () => {
    const older = event({ event_id: "older", updated_at: "2026-11-12T09:00:00Z" });
    const newer = event({ event_id: "newer", updated_at: "2026-11-12T11:00:00Z" });
    const rows = [older, newer];
    expect(sortEvents(rows).map((row) => row.event_id)).toEqual(["newer", "older"]);
    expect(rows.map((row) => row.event_id)).toEqual(["older", "newer"]);
  });
});

describe("stuckReason", () => {
  it("explains a missing or demo batch", () => {
    expect(stuckReason(true, "B1")).toBeNull();
    expect(stuckReason(false, null)).toContain("No PayPal batch ID");
    expect(stuckReason(false, "DEMOSEED-1")).toContain("Demo or mock");
  });
});

describe("maintenanceSummary", () => {
  it("counts what the run checked and changed", () => {
    const report: MaintenanceReport = {
      started_at: "2026-11-12T10:00:00Z",
      finished_at: "2026-11-12T10:00:01Z",
      locked: false,
      payouts: { checked: 2, refreshed: 2, changed: 1, still_open: 1, unrefreshable: 0, errors: 0, mock: false, truncated: false },
      webhooks: { checked: 1, processed: 1, dead_lettered: 0, errors: 0, truncated: false },
    };
    expect(maintenanceSummary(report)).toBe("Checked 2 payouts and 1 event. 1 changed.");
  });
});
