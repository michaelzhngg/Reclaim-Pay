# Decision needed: are the default auto-pay limits right?

**Answers:** PLAN.md open question 4, "Are the default limits right (RM50 / 100 / 200, two people above RM1,000)?"
**Owner:** Filbert. **Decided by:** the team, before the pilot starts.

## Short answer

Keep every default limit for the pilot. Change the demo policy's wording so it no longer promises
more than the engine pays (option A below). Decide whether to raise the Trusted limit (option B) after
the pilot, with the three measurements listed at the end.

## Why we can't tune the limits now

Until the pilot runs, the claims the replay sees come from the demo seed: 120 claims over 90 days
(`backend/seeds/seed_reclaim_pay.py`). The seed sets every tier by calling `decide()` with the default
config. Tuning on those claims would only show that the defaults agree with themselves. The Autonomy page
now says so above its figures when the replay includes demo claims, and the replay's `demo_claims` field
gives the count.

## What the limits do today

Defaults from `AutonomyConfig` in `backend/engine/risk/types.py`:

| Setting | Default | What it does |
|---|---|---|
| Auto-pay limit, New / Standard / Trusted | RM 50 / 100 / 200 | Largest claim paid without HR, by trust level |
| Two-person review above | RM 1,000 | Matches the demo policy, section 4 rule 3 |
| Auto-pay per employee, daily / monthly | RM 300 / 1,000 | Total auto-paid to one employee per UTC day / month |
| Auto-pay for the whole company, daily | RM 2,000 | Total auto-paid to everyone per UTC day |
| Cost of one HR review | RM 15 | A claim whose expected loss reaches this goes to HR |

A claim is auto-paid only when no hard stop applies. Being over the category's auto-approval amount
and being over the employee's auto-pay limit are both hard stops (`backend/engine/risk/autonomy.py:114-115`),
so either one sends the claim to HR.

Trust levels (`backend/engine/risk/autonomy.py`):

- **Standard** after 3 paid claims.
- **Trusted** after 10 paid claims, with no confirmed issue in the last 180 days.
- **Back to New** for 90 days after a confirmed issue. A confirmed issue is a recovery that was offset,
  invoiced or recovered, or an HR rejection of a claim that carried a high-severity signal.

## The mismatch to decide on

The demo policy (RP-DEMO-2026, section 3) gives each category an auto-approval amount: Transportation
RM 100 per trip, Meals RM 100 per meal, Accommodations RM 250 per night, Equipment RM 300 per item.
It says a claim at or below that amount "may be approved and paid automatically".

The engine adds a second line per employee: the auto-pay limit for their trust level. A claim is
auto-paid only when it is within both. So the policy's amount is reachable only for some levels:

| Trust level | Limit | Categories where the policy amount can't be reached |
|---|---|---|
| New | RM 50 | All four |
| Standard | RM 100 | Accommodations, Equipment |
| Trusted | RM 200 | Accommodations (RM 200 to 250), Equipment (RM 200 to 300) |

"May" means the policy doesn't promise payment, so nothing is broken. But an employee reading it will
expect a RM 240 hotel night to be paid instantly, and it never is, even for a Trusted employee.

### Options

- **A. Keep the limits and change the policy wording** (recommended). For example: "A claim at or below
  its category's auto-approval amount may be approved and paid automatically, up to your instant payout
  limit. Your limit is shown on your dashboard." The dashboard's trust card already shows each employee
  their limit and how to raise it. No code change, no new risk, and it covers all three trust levels.
- **B. Raise the Trusted limit to RM 300.** It helps only Trusted employees, and only for one-night stays
  between RM 200 and 250 and single equipment items between RM 200 and 300. A multi-night stay that
  totals more than RM 250 still goes to HR, because of the defect below.
- **C. Make the trust limit a share of the category amount** (for example New 50%, Standard 100%,
  Trusted 120%). The most consistent option, but it changes `decide()` and the trust card. Not before
  the pilot.

### What option B changes in exposure

- **Per employee: nothing.** The daily cap already stops any auto-pay that would take an employee past
  RM 300 in a day, so no single auto-paid claim can exceed RM 300 at any limit. A Trusted employee can
  already be auto-paid RM 300 in a day today (a RM 200 claim and a RM 100 claim). The RM 1,000 monthly
  cap and the RM 2,000 company daily budget don't change either.
- **Per claim: up by RM 100.** The largest single auto-paid claim goes from RM 200 to RM 300. One bad
  claim then costs up to RM 300 before recovery.
- **Less than it looks.** At RM 300 the Trusted limit equals the daily cap. A RM 240 hotel night is
  auto-paid only if the employee had no more than RM 60 auto-paid earlier that day.
- **Two-person review above RM 1,000 doesn't interact.** Auto-pay never reaches RM 1,000.

B is low risk, but it is still a limit change made without data, which is the thing this note argues
against. Decide it after the pilot: count Trusted claims between RM 200 and 300 in Accommodations and
Equipment, and check how many of them were later found to be bad.

## Known defect: the category check adds up nights, meals and items

**Impact.** The policy sets its amounts per night, per meal, per trip and per item. The engine compares
the claim's total for each category instead. A claim with several nights, meals or rides goes to HR when
the total is above the amount, even when every unit is within policy. HR then sees the line-item note
"Claim is over the budget for Accommodations category", which isn't true per night.

- A two-night stay at RM 200 a night (RM 400) is flagged, although each night is within RM 250.
  Today the RM 200 Trusted limit also stops it, so the defect changes the note, not the outcome.
- A claim for two RM 60 meals on different days (RM 120) is flagged. For a Trusted employee (limit
  RM 200) this changes the outcome today: an otherwise clean claim goes to HR instead of being auto-paid.

**Root cause.** `aggregate_totals` sums each category's line items
(`backend/engine/agents/compliance_agent.py:489`), and `_check_category_budgets` compares that sum with
the category amount (`backend/engine/agents/compliance_agent.py:941`).

**Why D1a doesn't fix it.** A per-unit check needs the number of nights, meals or items in each claim.
The pipeline doesn't keep it: line items are saved without `quantity` (`compliance_agent.py:861-871`), and
trip details such as nights are dropped after OCR. It also needs the per-unit limits that E1 extracts
from the policy. Changing the check would also change decisions, which this clean-up must not do.

**Fix path.** E2 ("claims use the confirmed limits"): after E1, claims are checked against the confirmed
per-unit limits, with the quantity stored on each line item.

## What to measure in the pilot

1. **HR minutes per review.** Nothing records this today, so time a sample of reviews by hand. It
   replaces the RM 15 review cost with HR's hourly cost times the measured minutes.
2. **Signal accuracy**, from the "Real problem" and "False alarm" answers HR gives on each Receipt Shield
   signal (R1a). Needed before the risk points can be tuned.
3. **Losses on auto-paid claims**, from the audit sample (5% of auto-paid claims) and recoveries. This
   decides whether the limits can go up, and settles option B.

Revisit after 4 weeks of pilot or about 300 real claims, whichever comes later. With fewer claims, a few
bad ones move the loss figure too much to act on.
