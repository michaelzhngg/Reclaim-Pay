// Summary figures for the employee history header. Both numbers describe the
// employee's own money, so company-paid vendor bookings never count toward them.
// Bookings still appear as rows in the list and have their own screen.

import { formatMoney } from "@/lib/format";
import type { HistoryClaim } from "../_components/historyData";

export interface HistorySummary {
  /** "Total reimbursed": approved and paid claims. */
  total: string;
  /** "Pending": claims still waiting on a decision. */
  pending: string;
  /** The company currency the figures are converted into. */
  companyCurrency: string;
}

const SETTLED_STATUSES: HistoryClaim["status"][] = ["Approved", "Paid"];

export function employeeHistorySummary(claims: HistoryClaim[]): HistorySummary {
  let reimbursed = 0;
  let pending = 0;
  for (const c of claims) {
    if (c.isVendorBooking) continue;
    if (SETTLED_STATUSES.includes(c.status)) {
      reimbursed += c.approvedCompanyAmount ?? c.approvedAmount;
    } else if (c.status === "Pending") {
      pending += c.amountCompany ?? c.amountNumeric;
    }
  }
  const companyCurrency = claims.find((c) => c.companyCurrency)?.companyCurrency ?? "MYR";
  return {
    total: formatMoney(companyCurrency, reimbursed),
    pending: formatMoney(companyCurrency, pending),
    companyCurrency,
  };
}
