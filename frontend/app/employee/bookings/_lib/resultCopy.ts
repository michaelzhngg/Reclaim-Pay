export interface BookingResultCopy {
  title: string;
  body: string;
  tone: string;
}

const COPY: Record<string, BookingResultCopy> = {
  APPROVED: {
    title: "Approved",
    body: "The vendor will be paid from the company PayPal account. You do not need to pay anything.",
    tone: "bg-success-soft text-success",
  },
  DISBURSING: {
    title: "Payment sending",
    body: "PayPal is sending the payment to the vendor from the company account. You do not need to pay anything.",
    tone: "bg-success-soft text-success",
  },
  PAID: {
    title: "Paid",
    body: "The vendor has been paid from the company PayPal account.",
    tone: "bg-success-soft text-success",
  },
  DISBURSEMENT_FAILED: {
    title: "Payment did not go through",
    body: "The vendor payment failed. HR has been told and can resend it. You do not need to pay anything.",
    tone: "bg-danger-soft text-danger",
  },
  REVIEW: {
    title: "With HR",
    body: "HR will check the vendor and the booking. You do not need to pay anything.",
    tone: "bg-warning-soft text-warning",
  },
  REJECTED: {
    title: "Not approved",
    body: "HR did not approve this booking. No vendor payment was made.",
    tone: "bg-danger-soft text-danger",
  },
};

export function bookingResultCopy(status: string | null | undefined): BookingResultCopy {
  return COPY[status ?? ""] ?? COPY.REVIEW;
}

/** A booking that is already paid or in flight should not show the clock icon. */
export function isBookingPending(status: string | null | undefined): boolean {
  return (status ?? "") === "REVIEW" || (status ?? "") === "APPROVED";
}
