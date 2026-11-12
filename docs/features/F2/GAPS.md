# F2 gaps

What this slice deliberately does not build. Each item says what a user would notice.

## F3 receipt matching and auto-claim

A booking is paid on the employee's declaration. The receipt arrives later, and F3 must attach it to the paid booking, match vendor, amount and dates, and raise a mismatch for HR. Until then a booking stays a booking forever, even after the stay or trip happens. The record is shaped for F3: the booking is already the reimbursement row, and the line item has an empty document reference.

## Real PayPal merchant onboarding

PayPal side is mock mode only. Sandbox and production need a merchant onboarding flow (seller permissions or partner referral), an eligibility decision, and an owner for the vendor account link. This slice has HR attest the vendor account, which is weaker than the employee's PayPal OAuth proof. The verification endpoint fails closed outside mock mode.

## Vendor self-service

Vendors do not log in. They cannot see a booking, confirm it, link their own account or download a remittance. Every vendor-side operation is HR-mediated.

## Vendor documents

No invoice, receipt, tax document or remittance advice is generated or stored for a vendor payment. The payouts ledger reconciles the PayPal transaction, not a vendor invoice.

## Refunds, cancellations and vendor recovery

No booking cancellation, partial refund or vendor overpayment recovery. `Recovery` is employee-centric and expects a claim paid to an employee.

## Manager and department-head routing

"Route to the right approver" means the existing HR lanes, with two-person review for high amounts. There is no department manager approval and no named approver assignment.

## Contracts and rates

The policy check validates category and category budget only. It does not know a vendor's negotiated nightly rate, contract terms or service catalogue.

## Multi-currency

Bookings use the company payout currency. An employee cannot book in another currency.

## Employee caps for vendor spend

Employee daily and monthly caps still gate each booking's amount, but vendor spend does not accumulate in the employee's caps because the employee receives no money. Company-level vendor spend is covered by the daily budget ticket instead. A dedicated vendor auto-pay threshold is future work.
