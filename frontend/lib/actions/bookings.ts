"use server";

// ─── Vendor Booking Server Actions ───────────────────────────────────────────
// Reads the vendor directory and submits a company-paid booking.
// ──────────────────────────────────────────────────────────────────────────────

import { apiGet, apiPost, API_PREFIX } from "@/lib/api/client";
import type { ReimbursementRaw, VendorBookingRequest, VendorOption } from "@/lib/api/types";

export async function getVendors(): Promise<VendorOption[]> {
  const result = await apiGet<VendorOption[]>(`${API_PREFIX}/vendors`);
  return result.data ?? [];
}

export async function createVendorBooking(
  body: VendorBookingRequest,
): Promise<{ data: ReimbursementRaw | null; error: string | null }> {
  const result = await apiPost<ReimbursementRaw>(`${API_PREFIX}/vendor-bookings`, body);
  return { data: result.data, error: result.error };
}
