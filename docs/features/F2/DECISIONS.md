# F2 decisions

Non-obvious choices, with the alternative rejected. Newest ticket last.

## 1. A booking is a `Reimbursement` row with `kind = VENDOR_BOOKING`

**Chosen:** reuse the claim record as the booking's financial and decision record, with a `kind` discriminator and a one-to-one `VendorBooking` detail row.

**Rejected:** a standalone booking table with its own approval queue and payout flow. That duplicates the riskiest code in the product (approval counts, two-person review, idempotent payouts, action log, notifications) and gives `AUTO_PAY` a second possible source.

**Consequence:** every list and total that reads `Reimbursement` must decide whether bookings belong there. Booking rows are labelled, and employee money totals exclude them.

## 2. One implicit line item per booking

**Chosen:** create one `LineItem` for the service, with no document, so the existing approval math, amount overrides, net approved and payout netting work unchanged.

**Rejected:** special-casing bookings in `_has_amount_to_pay` and `_apply_status`. That would put booking branches inside the claim approval path and make the two paths drift.

## 3. New-vendor guardrail reuses `PAYEE_NOT_VERIFIED`

**Chosen:** a vendor created by a booking starts with `paypal_verified = false`; `decide()` sees an unverified payee and reports the existing hard stop. A vendor account change uses the existing `PAYEE_COOLDOWN` stop.

**Rejected:** a new `NEW_VENDOR` hard stop or a booking-specific field in `ClaimFacts`. The engine stays unchanged, the rule is still deterministic, and "unverified payee" already means exactly what the guardrail needs.

## 4. Policy check is deterministic and sets `confidence = 1.0`

**Chosen:** resolve the active policy listing the category, compare the amount with the category's auto-approval budget, and pass `APPROVED` or `NEEDS_INFO` to `decide()`. There is no receipt and no LLM call at booking time.

**Rejected:** running the compliance agent on the booking purpose. It would invent an AI judgment without a document, and the roadmap says the decision engine is what checks the booking.

`confidence = 1.0` records that there is nothing probabilistic to discount. It does not claim an AI read the booking.

## 5. Vendor payouts are refused until the payee rail lands

**Chosen:** ticket 01 records decisions but the payout service refuses `VENDOR_BOOKING` rows. Ticket 02 removes that refusal and resolves the vendor as payee.

**Rejected:** letting the existing claim payout path run in ticket 01. It would pay the requesting employee's PayPal account because `Payout` was claim-shaped. Refusing is safer than a wrong payee.

## 6. Batch approval never includes a booking

**Chosen:** the batch eligibility rule skips `VENDOR_BOOKING` rows so each booking gets an individual look at the vendor, dates and purpose.

**Rejected:** allowing quick-lane bookings into batch approval. A new vendor can land in the quick lane because an unverified payee is a hard stop, so batching would let a vendor payment through without anyone reading the vendor details.
