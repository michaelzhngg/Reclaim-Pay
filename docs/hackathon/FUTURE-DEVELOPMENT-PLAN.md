# Reclaim Pay — Future Development Plan

**What this is:** every feature we liked during brainstorming but left out of the hackathon build, plus the improvements we want to make to what we are building now. Nothing here is in scope before the 11 Nov submission. [`PLAN.md`](PLAN.md) and [`DETAIL-PLAN.md`](DETAIL-PLAN.md) stay the source of truth for the hackathon.

**Status:** Draft for team discussion, written 3 Nov 2026. Progress checked on 12 Nov 2026, see [Status as of 12 Nov 2026](#status-as-of-12-nov-2026).

**How the evidence works:** every claim about the market links to a source in [section 7](#7-sources). Most expense-industry numbers come from surveys paid for by software vendors. We use them because they are the best available, and we say so where it matters. Before we build any feature, its owner re-checks the numbers marked "verify".

---

## Contents

1. [Summary: the features in plain words](#1-summary-the-features-in-plain-words)
   - [Status as of 12 Nov 2026](#status-as-of-12-nov-2026)
2. [Background and problem statement](#2-background-and-problem-statement)
3. [Feature details](#3-feature-details)
4. [Improvements to what we are building now](#4-improvements-to-what-we-are-building-now)
5. [Roadmap](#5-roadmap)
6. [Ideas we rejected, and why](#6-ideas-we-rejected-and-why)
7. [Sources](#7-sources)

---

## 1. Summary: the features in plain words

| # | Feature | What it does | Example | Why the business needs it |
|---|---|---|---|---|
| F1 | **Ask before you spend** | The employee asks whether something will be reimbursed *before* paying, and the agent answers from the company policy. | "Can I claim a RM120 client dinner for 3 people?" → "Yes, up to RM50 a person. RM120 is fine. Keep the itemised receipt." | People don't read policies (two-thirds admit it), so they either overspend and get rejected, or don't spend at all when unsure (38%). Each rejected claim costs about $52 to fix. Answering first is cheaper than fixing after. |
| F2 | **Company-paid vendor bookings** | The company pays the hotel or vendor directly from its PayPal business account, so the employee never fronts the money. | Aisyah books a RM380 hotel for a KL trip. Reclaim checks the policy and pays the hotel. Aisyah pays nothing. | About 4 in 10 employees say waiting to be reimbursed causes financial stress, and half of US workers paid overdraft or interest fees while waiting. Removing the out-of-pocket step removes the problem. |
| F3 | **Receipt matches the real payment** | For anything the company paid through PayPal (F2), Reclaim checks the receipt against the real PayPal transaction. If they differ, the claim stops. | Receipt says RM300. Company PayPal shows RM30 to that hotel. Flagged as fake. | AI fake receipts went from 0% to 70.8% of flagged fake documents in 14 months. A transaction record can't be faked with an image generator. |
| F4 | **Travel cash advance** | Before a trip, the agent estimates a budget from policy and destination, pays an advance to PayPal, and settles the difference after the trip. | 3-day Penang trip → advance RM450 → spent RM410 → RM40 deducted from the next claim, or a PayPal invoice after HR approves. | Travelers act as a bank for their employer. 83% of travelers say they struggle with expenses, and a quarter lose receipts on the road. |
| F5 | **Pay contractors and overseas staff** | Reimburse and pay freelancers and staff abroad, in their own currency, to PayPal or Venmo. | A Jakarta-based designer claims IDR 1.2m for software. Paid in IDR to their PayPal the same day. | Bank transfers abroad cost about 15% on average (World Bank). 85% of freelancers get paid late at least sometimes. PayPal Payouts reaches 96 countries in 24 currencies. |
| F6 | **Claim by chat** | Send a receipt photo on WhatsApp or Telegram, and the agent builds the claim and asks only for what's missing. | Photo of a Grab receipt + "airport, client visit" → "Claim RC-2291 ready: RM45 Transportation. Submit?" | Around 80% of Malaysian internet users use WhatsApp every week. Meeting employees in the app they already use raises submission rates and cuts late claims. |
| F7 | **HR assistant (proposes, never pays)** | HR asks in plain language and the assistant prepares a batch. HR reviews it and clicks approve. The assistant never sends money itself. | "Show approved travel claims under RM100 from last week" → 14 claims, RM812 total → HR clicks "Approve batch". | Manager approval is the slowest step. Only 28.5% of managers approve within a day. Our safety rule stays: a person always presses the button. |
| F8 | **Policy simulator** | HR changes a rule and sees what it would have cost last quarter before saving. | "Raise the meal cap from RM50 to RM80" → "+RM3,140 last quarter, 41 fewer partial approvals." | Out-of-policy spending costs companies about $85k a year. HR currently guesses the effect of policy changes. |
| F9 | **Smart buying for equipment** | The employee says what they need, and the agent finds options within policy (Channel3) and the company pays (PayPal). | "I need a 27-inch monitor" → 3 options under the RM900 cap → manager approves → paid and shipped. | Moves Reclaim from paying back to controlling spend. It also fits the agentic-commerce trend that PayPal and Channel3 are both betting on. |
| F10 | ~~**Camera-first app and wallet**~~ **(dropped 12 Nov, see §6)** | Open the app and the camera is ready. One screen shows pending, approved and paid claims, and the total for the year. | Snap a receipt at the counter. The claim is drafted before you sit down. | A quarter of travelers lose receipts. Capturing at the moment of purchase fixes this. |
| F11 | **Team budgets with early warnings** | Each team has a live budget, and the agent warns before it's used up. | "Sales has used 85% of November's travel budget with 12 days left." | Finance finds overspending at month end, when it's too late to change anything. |
| F12 | **Month-end report for finance** | The agent writes the month's summary: spend by category, flags, policy breaches, payouts, recoveries. | "November: RM48,210 reimbursed, 71% auto-paid, 3 fakes caught, RM90 recovered." | Saves finance hours each month, and gives managers something to read instead of a spreadsheet. |
| F13 | **Malaysian e-invoice readiness** | Keep the data needed for LHDN MyInvois (supplier details, self-billed invoices where required) with each claim. | A claim against a supplier without an e-invoice is tagged "self-billed e-invoice may be needed". | E-invoicing became mandatory for businesses earning RM1m–5m from 1 Jan 2026. Finance teams need expense records that fit it. *Verify which expense types are affected.* |

**Already planned for the hackathon, so not repeated here:** "Sign in with PayPal" (PLAN.md §4.1), the Channel3 price check (AI-8), the Bryntum calendar (EM-7), and ledger reconciliation through the PayPal Server SDK (PP-7).

### 1.1 Can we build it in the PayPal sandbox?

Six of the 13 features don't need PayPal at all. The other seven use four PayPal APIs, all of which have a sandbox: Payouts, Invoicing, Transaction Search and Orders.

| # | Feature | PayPal APIs | Sandbox verdict | What limits it |
|---|---|---|---|---|
| F1 | Ask before you spend | none | **No PayPal needed** | Only the LLM and the policy data. |
| F2 | Company-paid vendor bookings | Payouts | **Yes, with a stand-in** | Create one more sandbox business account to act as the hotel or vendor, and pay it with Payouts (Payouts can pay any PayPal account). What the sandbox can't tell us: whether real Malaysian vendors accept PayPal. |
| F3 | Receipt matches the real payment | Transaction Search | **Yes, but unreliable** | The sandbox app must have "Transaction search" ticked, and the credentials regenerated, so the token carries the `reporting/search/read` scope. Transactions can take up to 3 h to appear. Community threads report empty sandbox results and an unofficial ~30-day query window. Plan for retries, and a manual "match now" button for demos. |
| F4 | Travel cash advance | Payouts, Invoicing | **Yes** | Both APIs work in sandbox. Invoices go to a sandbox personal email, and a sent invoice can only be cancelled, not deleted. |
| F5 | Contractors and overseas staff | Payouts (multi-currency, Venmo) | **Partly** | **A Malaysian sender can pay MYR only to Malaysian accounts, and can't send payouts that need conversion to or from MYR.** To pay a contractor in Indonesia, the company must hold a USD (or IDR) balance and pay from it. The sandbox can model this with a business account that has a USD balance. Venmo is US-only and USD-only. |
| F6 | Claim by chat | none (notifications only) | **No PayPal needed; needs a WhatsApp test setup** | Meta's Cloud API test number (or a provider sandbox such as 360dialog) only sends to a small list of verified numbers. Telegram bots are free and have no such limit, so build Telegram first for testing. |
| F7 | HR assistant | none | **No PayPal needed** | Read-only on our own data. |
| F8 | Policy simulator | none | **No PayPal needed** | Uses stored claims. |
| F9 | Smart buying (Channel3) | Orders or Payouts | **Only simulated** | Channel3 search is real (free tier: 1,000 searches a month). Real shops don't take sandbox money, so the "buy" step can only pay a sandbox merchant we control. The demo works, but the real purchase can't be tested before going live. |
| F10 | ~~Camera-first app and wallet~~ (dropped) | none | **No PayPal needed** | Reads our payout data. |
| F11 | Team budgets | none | **No PayPal needed** | Our own data. |
| F12 | Month-end report | none | **No PayPal needed** | Our own ledger. |
| F13 | E-invoice readiness | none | **No PayPal needed; LHDN has its own sandbox** | MyInvois has a pre-production environment (`preprod-api.myinvois.hasil.gov.my`) with separate credentials. The harder question is legal: which expense types are in scope. |

**Testing failures in the sandbox.** PayPal provides trigger values that make a sandbox payout fail on purpose. For example, `ERRPYO005` in the item note returns `INSUFFICIENT_FUNDS`, and `ERRPYO002` returns `SENDER_EMAIL_UNCONFIRMED`. We should use these in tests instead of only our mock client.

### 1.2 Priority tiers (return against risk)

**How we score it**
- **Return (1–5):** value to employees and companies, plus how strongly it supports the "safe automation" story.
- **Risk (1–5):** technical difficulty, sandbox limits, legal or market unknowns, and how much it depends on unfinished work.
- **Ratio** = return ÷ risk.

| Tier | Meaning | Feature | Return | Risk | Ratio | Effort | Main dependency |
|---|---|---|---|---|---|---|---|
| **P1: build first** | High return, low risk | **F1** Ask before you spend | 4 | 1 | **4.0** | S–M | Policy agent (exists) |
| | | **F7** HR assistant (proposes, never pays) | 4 | 2 | **2.0** | M | Triage grid and batch approve (hackathon) |
| | | **F4** Travel cash advance | 4 | 2 | **2.0** | L | Recovery service (hackathon RC-1/RC-2) |
| **P2: strategic bets** | High return, but real unknowns | **F2** Company-paid vendor bookings | 5 | 3 | 1.7 | L | Vendor survey: do our pilot's vendors accept PayPal? |
| | | **F3** Receipt matches the real payment | 5 | 3 | 1.7 | M | F2 or F4 (needs company-made payments) |
| | | **F6** Claim by chat | 4 | 3 | 1.3 | M per channel | Meta business verification, PDPA review |
| | | **F5** Contractors and overseas staff | 4 | 4 | 1.0 | L | Non-MYR balance; tax and legal per country |
| **P3: fillers** | Useful, low risk, lower return | **F11** Team budgets | 3 | 1 | 3.0 | M | Decision engine hard stops |
| | | ~~**F10** Camera-first app and wallet~~ (dropped) | 3 | 1 | 3.0 | M | None |
| | | **F12** Month-end report | 3 | 1 | 3.0 | S–M | Ledger and action log |
| | | **F8** Policy simulator | 3 | 2 | 1.5 | M | Back-test endpoint |
| **P4: park** | Return doesn't yet justify the risk | **F9** Smart buying | 3 | 4 | 0.75 | L | F2; can't test real buying in sandbox |
| | | **F13** E-invoice readiness | 3 | 4 | 0.75 | M | Legal scope unclear |

**Why the tiers aren't just sorted by ratio.** The fillers (P3) score well because they are cheap and safe, but they don't change the product much. The strategic bets (P2) are why Reclaim Pay is worth buying: no more out-of-pocket spending, and the strongest fraud check there is. So the order is:
1. P1 first.
2. P2 next, in the order F2 → F3 → F6 → F5. F3 needs F2, so they ship together.
3. P3 fill the gaps between bets.
4. P4 waits until a pilot customer asks for it.

---

## Status as of 12 Nov 2026

**As of 12 Nov 2026, evening.** Checked against the code on `main` at `3b57080` (PR #22) and the hackathon docs. **Done** means merged to `main`. It does not mean the item has run with live PayPal or a pilot company unless the row says so. **Built, on a branch, not merged** means the code exists on the named branch and is not on `main`.

**Summary.** The team reports that the hackathon build was submitted on 11 Nov; the repo holds no confirmation of it. Since then these merged to `main`: faster HR dashboard loading and D2 (PR #18), the employee badge panel (PR #19), G2, G5, O2 and R2 (PR #21), R3 (PR #22), and two small fixes (upload and draft-save errors now show on the capture screen; the HR tier tabs wrap instead of scrolling). Three more pieces of work are on branches and not merged: U2 notifications, A1 account invitations and a fix for the daily-cap race. Of the 36 items below, 4 are done, 9 are partly done, 21 are not started, 1 is built on a branch and not merged (A1), and 1 is dropped (F10). None of the new features F1 to F13 has started, though several have a base in today's code (noted in the table). Everything still runs on the PayPal sandbox.

**Out of date after this audit.** The table was checked against `main` at `3b57080`. Teammates merged more work afterwards: the spend check on the employee dashboard (F1), vendor bookings (F2), policy limits and signal reviews, a webhook dead-letter view and ledger tabs (G3 and G4), and an analysis of the default limits (D1, see `DECISION-D1-LIMITS.md`). Rows for F1, F2, G3, G4, R1 and D1 have not been re-checked against that work and may understate it. Re-audit them before relying on them.

**About the IDs.** The IDs match the team board (35 cards). F1 to F13 are this plan's features, with F6 split into F6a (Telegram) and F6b (WhatsApp) on the board. G (go-live), R (Receipt Shield), D (decision engine), U (polish), O (platform) and M1 (multi-company) come from section 4. V1 (vendor survey) and G5 (sandbox failure tests) are board cards that this plan does not describe. A1 (account invitations) is new work, not yet a board card, and not described elsewhere in this plan.

| ID | Item | Status | What exists / what is missing | Evidence |
|---|---|---|---|---|
| **Done** | | | | |
| D2 | Explain trust changes to employees | Done | `GET /autonomy/me` returns up to 3 recent level changes, the level rules, `hold_days` and `trusted_clean_days`. Since PR #19 the employee sees them in the badge dialog, under "Recent changes" and "How instant payouts work". Missing: a notification when the level changes (that is U2). | `backend/api/autonomy.py:98-114`; `frontend/app/employee/dashboard/_components/BadgesDialog.tsx`; `frontend/app/employee/dashboard/_lib/copy.ts:63-101`; commits `6ef4c31`, `b108229` |
| G5 | Sandbox failure tests | Done | Tests replay PayPal's documented error bodies for `INSUFFICIENT_FUNDS` and `SENDER_EMAIL_UNCONFIRMED` and check that the claim moves to `DISBURSEMENT_FAILED` and stays open for an HR retry. They run in CI with a mocked HTTP layer. One more test sends the `ERRPYO005` trigger to the real sandbox; it runs only with `PAYPAL_SANDBOX_LIVE_TESTS=1`, and the repo has no record of a run. | `backend/tests/test_paypal_failures.py:1-6,73-132,246-262`; commit `922b0c7` |
| R2 | Image forensics (error-level and noise checks) | Done | At upload, a noise-consistency check and a strict JPEG error-level check look for an area with much less camera noise than the rest of the photo, such as a retyped total. Observe-only by default (`IMAGE_FORENSICS_MODE=observe`, and `render.yaml` does not change it): HR sees the finding as "not scored", it adds no points and never reaches the employee. `score` makes it a MEDIUM signal. Not calibrated on real claims yet (that is R1). | `backend/engine/risk/shield/forensics.py`; `backend/engine/risk/shield/run.py:128-133`; `backend/core/config.py:68-70`; commit `afd971d` |
| R3 | Red-team receipt suite in CI | Done | 66 fake receipts in 7 attack families and 28 honest ones run through the shield and `decide()` on every PR. The build fails if one of the 42 must-catch fakes gets through, a family's catch rate drops below `baseline.json`, or more than 2 honest receipts are flagged. The 24 known gaps and 2 false positives are strict xfails. Limits: OCR and the LLM are stubbed, so prompt and model changes are not tested; Render deploys each commit to `main` without waiting for CI (`autoDeployTrigger: commit`); `s3_ai_hotel.png` still has no C2PA marker. | `backend/tests/redteam/README.md`; `backend/tests/redteam/baseline.json`; `.github/workflows/deploy.yml:34`; `render.yaml:20` |
| (none) | HR dashboard loading (not in this plan) | Done | The claim list takes 8 queries for any page size (204 before, for 50 rows). New indexes for claim order and latest payout (migration `2a7c9e1d4b80`). Dashboard claims load in the server render. AG Grid loads only when a grid is on screen. The banner reuses a status under 15 s old, and the Autonomy page loads in one action. Merged in PR #18. See Known limitations. | `backend/tests/test_list_reimbursements_queries.py`; `backend/alembic/versions/2a7c9e1d4b80_claim_list_indexes.py`; `frontend/app/hr/dashboard/page.tsx:7`; commits `4519972`, `9e473d2`, `2527370`, `8929ff2`, `ea938b5` |
| (none) | Employee badge panel (not in this plan) | Done | Bronze (MYR 50), Silver (MYR 100) and Gold (MYR 200) badges in a carousel replace the fast-track card. Totals sit in the same panel, and an open arc shows progress to the next badge. Merged in PR #19. Leftover on `main`: the backend reason text still says "Trusted"; the fix is on `feat/u2-notifications` (see Known limitations). | `frontend/app/employee/dashboard/_lib/badges.ts:11-13`; `frontend/app/employee/dashboard/_components/BadgeBlock.tsx`; commits `4b970f9`, `94abe5f` |
| **Partly done / needs improvement** | | | | |
| G2 | Low-balance funding alert | Partly done | Exists: a funding card on HR Payouts with the PayPal balance, the average daily payout over 14 days, approved claims not yet paid and the days of cover. Below `FUNDING_ALERT_DAYS` (default 3), or when the balance can't cover what is owed, HR gets an in-app alert, at most once a day. Alert only: no payout or decision changes. Missing: the check runs only when an HR user opens the Payouts page, so no alert goes out if nobody does; there is no scheduled job. Reading the balance needs "Transaction search" enabled on the PayPal app, which the live site lacked on 4 Nov (see G4), and the card has not been checked on the live site. | `backend/engine/services/funding_service.py`; `backend/api/payouts.py:144-156`; `frontend/app/hr/payouts/_components/FundingCard.tsx`; commit `922b0c7` |
| G3 | Harden PayPal webhooks | Partly done | Exists: signed webhook endpoint (signature check skipped only in mock mode); payout status only moves forward, which limits what a replayed event can do; the claim page refreshes a payout from PayPal when its status is over 10 s old. Missing: stored event IDs for replay protection, a dead-letter queue, a daily job for payouts stuck over 24 h. | `backend/api/paypal.py:353-388`; `backend/engine/services/payout_status.py:25`; `backend/api/payouts.py:218` |
| G4 | Daily ledger reconciliation (PP-7) | Partly done | Exists: on-demand reconcile through the PayPal Server SDK (Transaction Search), with a 3-hour lag allowance, behind `GET /payouts/reconcile` and a badge on the ledger tab. It has never returned a result from the live sandbox: on 4 Nov the live site showed "PayPal can't be reached", probably because Transaction Search is not enabled on the sandbox app. Missing: the daily job, and sending differences to HR. | `backend/engine/services/reconcile_service.py`; `backend/api/payouts.py:135`; `docs/hackathon/DEVPOST-FORM.md` ("Before submitting") |
| R4 | Cross-company duplicate detection | Partly done | Exists: SHA-256 and perceptual-hash matching against every document from the last 180 days in our one database; it caught S5 on the live site on 4 Nov. Missing: a vector index (today it is a linear scan) and privacy-safe hashes shared across companies. | `backend/engine/risk/queries.py:14`; `backend/engine/risk/shield/fingerprint.py:68`; `docs/hackathon/DEVPOST-FORM.md` ("Before submitting") |
| D3 | Settings change history | Partly done | Exists: every limits save writes old values, new values, the actor and HR's reason to the hash-chained action log, and the HR agent log shows it as "Limits changed". Missing: a history view that compares versions, and per-company history (there is one company today). | `backend/engine/services/autonomy_store.py:163-185`; `frontend/components/hr-grid/agentLog.ts:12,65` |
| U1 | Remove leftover sample-data screens | Partly done | Exists: the sample rows are gone (`MOCK_BUNDLES` and `MOCK_POLICIES` are empty), and `/hr/review` and `/hr/view` without an ID redirect to the dashboard. Missing: the review page still falls back to `MOCK_BUNDLES`, and Policy Studio imports its types and styles from `mockData.ts`. Move those and delete the file. | `frontend/app/hr/hr_components/mockData.ts:47-56`; `frontend/app/hr/review/[id]/page.tsx:8,351`; `frontend/app/hr/policy/page.tsx:5` |
| U2 | Notifications | Partly done | On `main`: in-app and web push notices for payment received, payout failed (to the employee and HR) and the overpayment notice, which states the dispute deadline; push opt-in in Settings for both roles. Built, on a branch, not merged (`feat/u2-notifications`, commit `7cf8276`): email through Resend for employees, a reminder about 24 h before the dispute window closes, and a notice when the instant-payout limit changes. The branch adds `RESEND_API_KEY` and `EMAIL_FROM`; they are not on `main`. | `backend/engine/services/payout_status.py:59-76`; `backend/engine/services/recovery_service.py:232`; `frontend/app/_components/PushSettingToggle.tsx`; branch `feat/u2-notifications` |
| U3 | Accessibility pass | Partly done | Exists from the 4 Nov UI revamp: 44 px tap targets, Escape and focus return on dialogs, `aria-live` on the timeline, a risk-bar contrast fix. Missing: a recorded keyboard pass through the HR grid, a contrast check across the app, and a screen-reader test of the timeline. | `frontend/components/timeline/AgentTimeline.tsx:31`; commits `b166ecd`, `e314725` |
| O2 | Security hardening | Partly done | Exists: rate limits per signed-in user (per IP when signed out) on login, registration, PayPal connect, policy upload and every claim endpoint: analysis 5 a minute and 200 a day, receipt upload 10 a minute and 300 a day, draft saves 30 a minute, receipt edits 60 a minute. A throttled request gets a 429 with `Retry-After` and a plain message. HR endpoints are not throttled. Render generates `SECRET_KEY` and holds secrets in an environment group. Missing: the limiter still counts per process (no shared store), no vault, no audit log export. | `backend/api/rate_limit.py:20-33,57-60`; `backend/tests/test_rate_limits.py`; `render.yaml:31,74`; commit `a0a8229` |
| **Built, on a branch, not merged** | | | | |
| A1 | Account invitations and forgot password | Built, on a branch, not merged | HR creates an account and the employee gets an email link to set their own password. Add Employee shows the one-time invite link with a Copy button, and the list shows Invited and Invite expired badges with a Resend action. Forgot password sends a 30-minute reset link. Tokens are single use and stored as SHA-256 hashes. Setting a password ends older sessions. Replaces the HR-only `/auth/register` route. The branch is built on `feat/u2-notifications`, so it needs U2 merged first. | branch `feat/account-invites`, commits `060ca12`, `e59e9a4` |
| **Not started** | | | | |
| G1 | Get live Payouts approved | Not started | No record in the repo. Production still points at the sandbox. | `render.yaml:54` |
| V1 | Vendor survey for company-paid bookings | Not started | Outreach to pilot companies, not code. It gates F2. | none |
| R1 | Calibrate Receipt Shield | Not started | Needs real claims; signal points are still the hackathon defaults. R2's observe-only findings will feed it. | none |
| D1 | Tune decision-engine limits | Not started | Needs pilot data. Limits are editable on the Autonomy page. | none |
| U4 | Dark mode and denser HR views | Not started | No dark theme in `globals.css` or `DESIGN.md`. | none |
| M1 | Multi-company platform | Not started | No company model or `company_id`. | none |
| O1 | Observability dashboard | Not started | Only LangSmith tracing of agent runs is configured. | `render.yaml` (`LANGCHAIN_TRACING`) |
| O3 | PDPA privacy controls (retention, access export, breach runbook) | Not started | | none |
| F1 | Ask before you spend | Not started | Base: policy sections with embeddings. | `backend/alembic/versions/a1b2c3d4e5f6_add_policy_section_embedding.py` |
| F2 | Company-paid vendor bookings | Not started | | none |
| F3 | Receipt matches the real payment | Not started | Base: the G4 Transaction Search code. | `backend/engine/services/reconcile_service.py` |
| F4 | Travel cash advance | Not started | Base: the recovery service (offsets and invoices). | `backend/engine/services/recovery_service.py` |
| F5 | Pay contractors and overseas staff | Not started | | none |
| F6a, F6b | Claim by chat: Telegram (F6a), WhatsApp (F6b) | Not started | | none |
| F7 | HR assistant | Not started | Base: triage grid and batch approve. | `frontend/components/hr-grid/` |
| F8 | Policy simulator | Not started | Base: the limits back-test. | `backend/engine/services/backtest_service.py` |
| F9 | Smart buying for equipment | Not started | Base: the Channel3 price check, off until a key is set. | `backend/engine/risk/shield/market_price.py` |
| F11 | Team budgets with early warnings | Not started | Base: the company daily budget hard stop. | `backend/engine/risk/autonomy.py:112` |
| F12 | Month-end report for finance | Not started | | none |
| F13 | Malaysian e-invoice readiness | Not started | | none |
| **Dropped / decided not to build** | | | | |
| F10 | Camera-first app and wallet | Dropped 12 Nov | See §6. | commit `f70ff6e` |
| (none) | Pagination and a server-side status filter for the HR triage queue | Decided not to build | The queue loads only the 50 newest claims of any status. Recorded under Known limitations. | `backend/api/reimbursements.py:308-309`; `frontend/app/hr/dashboard/page.tsx:7` |

### Known limitations

- **HR triage queue shows 50 claims.** It loads the 50 newest claims of every status, so an older claim waiting for review can be missing from the queue. We decided not to fix this for now (`backend/api/reimbursements.py:309`).
- **Two claims at the same moment can pass a daily cap.** Listed as a known gap in `HANDOFF.md` §3. We found no lock around the ledger read behind the daily-cap checks (`backend/engine/risk/autonomy.py:110-112`). A fix is in progress on branch `fix/daily-cap-race`, which had no commits beyond `main` at the time of writing.
- **Rate limits count per process.** The limiter keeps its counters in memory, so each worker or instance counts separately and the real limit is the set limit times the number of processes (`backend/api/rate_limit.py:57-60`).
- **The funding alert needs someone to open HR Payouts.** The balance check and the alert run only on `GET /payouts/funding` (`backend/api/payouts.py:144-156`).
- **The frontend reaches the API through the public domain.** `INTERNAL_API_URL` is `https://api.reclaimai.dev` instead of a private Render address (`render.yaml:92`).
- **The action log is re-verified on every read.** `GET /autonomy/actions` loads and re-hashes the whole chain each time, so it slows down as the log grows (`backend/api/autonomy.py:187`, `backend/engine/services/action_log.py:114`).
- **Reconcile calls PayPal live on each request.** `GET /payouts/reconcile` has no cache. Since PR #18 the ledger tab starts it after the ledger loads, so it no longer blocks the page (`backend/api/payouts.py:135`).
- **Badge wording in the backend.** On `main` the trust reason still says "Trusted needs 180 days without a correction"; with the badge panel it should say Gold (`backend/engine/services/backtest_service.py:322`). The fix (commit `8e1acc6`) is on `feat/u2-notifications`, not merged.
- **Bryntum calendar runs on the trial build** and shows its watermark (`frontend/package.json:13`).

---

## 2. Background and problem statement

### 2.1 The problem in one paragraph

Employees pay for work out of their own pockets, then wait days or weeks to get the money back. Finance teams spend about 20 minutes and $58 on each claim, and fix one in five because of errors. Meanwhile, generating a fake receipt now takes one prompt, and fake receipts made with AI went from almost none to most of the fakes caught in just over a year. Companies are stuck between paying fast (and getting cheated) and checking everything (and making staff wait). Reclaim Pay's answer, and the basis for every feature below, is to automate where it's safe and send the rest to a person.

### 2.2 The evidence

**Claims are slow and expensive to process**
- One expense report costs about **$58** and takes **20 minutes** to process. **19%** contain errors, and fixing each one takes **18 more minutes** and costs about **$52**. These figures come from the GBTA Foundation and HRS study from 2015. It is old, but still the most-quoted benchmark. [GBTA][gbta-cost], [GBTA pain points][gbta-pain]
- In one survey of approval times, only **28.5%** of managers approve a report within a day, and **15.5%** take five days or more. After approval, **29.5%** of companies take two weeks or more to pay. That is Business Travel News data from 2019. [Resourceful Finance Pro][turnaround]

**Waiting hurts employees**
- Singapore: **41%** say slow reimbursement caused them financial stress. **28%** dipped into savings while waiting. **56%** spend up to S$5,000 a year of their own money on work. [Airwallex][airwallex-sg]
- UK: **43%** have had financial difficulty while waiting, and only **30%** are usually repaid within a week. [Accountancy Age][accountancy-age]
- US (June 2026): **51%** paid overdraft fees, late fees or credit card interest while waiting. This comes from an Emburse and Atomik Research survey reported by PYMNTS. [PYMNTS][pymnts-ai-receipts]
- **29%** of employees personally paid for offsite expenses before claiming them. [Business Travel News via search][card-vs-reimb]

**Fraud is getting easier, and it's AI-driven now**
- On AppZen's platform, AI-generated receipts were **0%** of flagged fake documents in March 2025 and **70.8%** by mid-May 2026. That figure is based on 1,471 AI fakes from 745 employees at 174 companies, worth $148,143 in total. AI fakes average about **$100**, against $182 for older template fakes. The lower value makes them harder to spot. [PYMNTS][pymnts-ai-receipts], [TechRadar][techradar]
- **4 in 10** US employees say they have used AI to make a fake expense receipt, according to Emburse and Atomik Research (June 2026). Of those, **19%** invented a purchase and **15%** inflated a real one. [PYMNTS][pymnts-ai-receipts]
- Expense reimbursement schemes are about **13%** of occupational fraud cases, with a median loss around **$50,000** per scheme. These are secondary citations of the ACFE 2024 report, so *verify against the primary report*. [Mondaq][acfe-mondaq], [Emburse][acfe-emburse]
- Prompt injection is the **#1 risk** in the OWASP Top 10 for LLM applications. Hidden instructions inside documents, such as receipts, are the "indirect" form of it. [OWASP LLM01 summary][owasp]

**Policies aren't read, so people guess**
- **Two-thirds** of employees admit they haven't read the expense policy (Allstar UK). **78%** of finance leaders say many employees don't know the whole policy (Teampay/Kelton). [Search summary][policy-survey], [Teampay][teampay]
- **38%** don't spend at all when they're unsure they'll be reimbursed. That means lost client dinners and missed trips. [Employment Law Solicitors][els]
- Companies lose about **$85,000 a year** to spend that doesn't match their policies. [FinTech Futures][fintechfutures]

**The Malaysian market**
- Micro, small and medium businesses are **96.1%** of businesses (about 1.09 million firms), employ **48.7%** of workers, and produce **39.5%** of GDP (DOSM 2024). They mostly have no dedicated finance team, so automation matters more for them. [OECD/DOSM][oecd-msme], [DOSM][dosm-msme]
- **2.52 million** people are self-employed (15.4% of jobs, DOSM 2024). The Gig Workers Act 2025 (Act 872) came into force in 2026. Estimates of gig workers range from 1.2 to 3.45 million depending on the definition. That is a large group of people companies pay who aren't on payroll. [NST][nst-gig], [Malay Mail][malaymail-gig]
- E-invoicing (MyInvois) is being rolled out by revenue band, with businesses earning RM1m–5m included from 1 Jan 2026. [ClearTax][cleartax-einv], [Fiscal Requirements][fiscal-einv]
- WhatsApp is used weekly by about **80%** of Malaysian internet users (Reuters Institute and YouGov via WARC; *verify the survey year*). [WARC][warc-whatsapp]

**What PayPal makes possible, and what it doesn't**
- Payouts reach **96 countries** in **24 currencies**. One payout batch uses one currency, and some currencies, including MYR, have conversion limits. [PayPal Payouts overview][pp-payouts], [Currency conversion][pp-fx]
- Transaction Search shows only the company's **own** account. Reading other accounts needs PayPal partner status, and new transactions can take up to **3 hours** to appear. This is why we can't check employees' personal PayPal history, but *can* check payments the company made itself (F3). [Transaction Search][pp-txn]
- The official PayPal Python Server SDK (v2.4.0) covers Orders, Payments, Vault, Transaction Search and Subscriptions. It does **not** cover Payouts, which still uses the separate Payouts SDK or the REST API. [PayPal Python Server SDK][pp-sdk], [Payouts SDK][pp-payouts-sdk]

### 2.3 What this tells us

1. **Speed is a wellbeing issue, not just a convenience.** Money owed to staff for weeks costs them real fees. That justifies F2 (no out-of-pocket) and F4 (advances).
2. **Image checks alone won't keep up.** AI fakes are cheap, small and getting better. The strongest defence is a record the fraudster can't make: the real payment (F3). That only works when the company pays, which is another reason for F2.
3. **Most errors start before the claim.** People guess at the policy. Answering first (F1) is cheaper than rejecting later.
4. **HR is the bottleneck, but HR must stay in control.** The assistant may prepare work (F7) but never send money.
5. **The market is wider than salaried staff.** Contractors, gig workers and staff abroad are underserved by bank transfers (F5).

---

## 3. Feature details

Each feature lists: the problem, what we build, an example flow, how it builds on today's code, the PayPal and AI parts, the guardrails, how we measure success, rough effort, and open questions.

Effort uses the same units as the hackathon plan: **S** = 1–2 days for one person, **M** = 3–5 days, **L** = 1–2 weeks, **XL** = more than 2 weeks.

### F1. Ask before you spend

**Problem.** Employees don't read policies and guess. Wrong guesses become rejected claims ($52 to fix each) or skipped spending.

**What we build**
- A question box on the employee dashboard and in the chat (F6). Questions can be typed or spoken.
- The policy agent answers from the company's uploaded policy, quotes the clause, and shows the limit that applies to *this* employee (rank, trust level, remaining monthly cap).
- Answers are marked "guidance, not approval". The real decision still happens when the claim is submitted.
- HR sees the most-asked questions. These show where the policy is unclear.

**Example**
1. Farid: "Can I take a Grab to the airport at 5am instead of the train?"
2. Agent: "Yes. Policy §3.2 allows e-hailing when public transport isn't running. Your limit is RM80 a trip. Keep the receipt."
3. Two weeks later, Farid's RM62 claim is auto-paid, and the timeline says "Matches your pre-spend check from 12 Nov."

**Builds on.** The existing policy extraction and the compliance agent's policy lookup. The question is checked against the same rules as a claim, but without a receipt.

**PayPal and AI.** AI: retrieval over policy sections plus an LLM answer constrained to quoting a clause. PayPal: none directly, but it raises the auto-pay rate later.

**Guardrails**
- The answer must cite a clause, or say "the policy doesn't cover this, ask HR".
- It never promises approval.
- Questions are logged, so a later claim can reference the answer.
- The employee's question text is treated as data, never as instructions (the same prompt-injection rule as receipts).

**Success measures**
- Fewer partial or rejected claims among employees who asked first.
- Share of answers that cite a clause.
- HR edits made to the policy after reviewing the top questions.

**Effort.** S–M. **Open questions:** do we store the answer as a binding "pre-approval" for amounts under a limit? Probably not at first.

---

### F2. Company-paid vendor bookings

**Problem.** Reimbursement assumes the employee pays first. Around 4 in 10 employees find that stressful, and half of US respondents paid fees while waiting.

**What we build**
- A "Request a booking" flow: the employee enters the vendor, amount, dates and purpose.
- Reclaim checks it against the policy (the same engine as claims), sends it to the right approver tier, then pays the vendor from the company PayPal business account.
- Vendors who accept PayPal are paid directly. Others are paid through a PayPal invoice the vendor sends, or a virtual card later.
- The booking becomes a claim automatically once the receipt arrives, and F3 matches them.

**Example.** Aisyah requests a RM380 hotel. It's under her RM400 rank cap, the vendor is known, so it goes to quick HR approval. HR approves and the hotel is paid by PayPal. Aisyah uploads the folio after checkout and F3 matches it to the payment. Done.

**Builds on.** The decision engine (tiers, caps, budgets) and the payout code, with the payee changed from employee to vendor.

**PayPal and AI.** PayPal: paying merchants from the business account (invoices, or Orders/Payments for checkout-style vendors). AI: extracting vendor details from a booking link or quote.

**Guardrails**
- A new vendor always needs HR approval.
- Vendor payout accounts are verified the same way as employee accounts.
- Vendor bank or payee changes start the same 72-hour pause.
- The company daily budget includes vendor payments.

**Success measures**
- Share of travel spend paid directly.
- Average employee out-of-pocket balance.
- Time from request to booking.

**Effort.** L. **Open questions:** do enough Malaysian hotels and vendors accept PayPal? This needs a survey of our pilot companies' top 20 vendors before we build.

---

### F3. Receipt matches the real payment

**Problem.** AI fakes are now most of the fakes caught, and image forensics keeps getting harder. We need evidence a generator can't create.

**What we build**
- For every claim tied to a company-made PayPal payment (F2, F4), fetch the transaction with Transaction Search and compare amount, date, merchant and currency.
- A mismatch adds a high-risk signal (`TXN_MISMATCH`) and blocks auto-pay. A match adds confidence and can raise the auto-pay limit for that claim.
- Because Transaction Search can lag 3 hours, unmatched claims wait in a "matching" state, up to a time limit, instead of failing.

**Example.** The receipt says RM300 at Hotel Seri. The company PayPal shows a RM30 payment to Hotel Seri on that date. Result: two-person review, with both values shown in the evidence panel.

**Builds on.** The Receipt Shield signals and the evidence panel. This is the planned PP-7 reconciliation, used as a fraud signal instead of only an accounting check.

**PayPal and AI.** PayPal: the Transaction Search API, through the official Server SDK (which supports it). AI: fuzzy merchant-name matching ("HTL SERI SDN BHD" vs "Hotel Seri").

**Guardrails**
- It never reads an employee's personal account. Only the company's.
- A mismatch never rejects a claim on its own. It sends the claim to a person, as with every other signal.

**Success measures**
- Share of company-paid claims matched automatically.
- Fakes caught by this signal that the other checks missed.

**Effort.** M (once F2 exists). **Open questions:** can we match card or bank payments too, by importing statements? That's a later extension.

---

### F4. Travel cash advance

**Problem.** Trips mean the biggest out-of-pocket amounts, and lost receipts and late settlement are common.

**What we build**
- A "Plan a trip" form: destination, dates, purpose.
- The agent estimates a budget from the policy (per-diem, rank caps) and past trips to that city, and HR approves it.
- Approved advances are paid by PayPal Payout, using the same idempotent payout code.
- After the trip, claims are offset against the advance. Leftover money is deducted from the next claim, or invoiced through the existing recovery flow (notice → dispute window → HR approval → PayPal invoice).
- A reminder goes out if the trip isn't settled within the policy deadline.

**Example.** Penang, 3 days. The estimate is RM450, HR approves, and the advance is paid. Aisyah submits RM410 of receipts. The RM40 left over is offset on her next claim. No invoice is needed.

**Builds on.** The existing `travel_settlements` table, the payout service, and the recovery service (once Chingiz B finishes it).

**PayPal and AI.** PayPal: Payouts (out) and Invoicing (back). AI: budget estimate, with an explanation of each line.

**Guardrails**
- Advances are never auto-paid. HR always approves.
- An employee can have at most one unsettled advance.
- Advances count towards caps.
- Recovery follows the same fair process as overpayments.

**Success measures**
- Share of trips settled on time.
- Average gap between advance and actual spend.
- Number of advances needing an invoice.

**Effort.** L. **Open questions:** should a late settlement be treated as taxable income? This needs a check with a Malaysian tax adviser.

---

### F5. Pay contractors and overseas staff

**Problem.** Bank transfers abroad average about 15% in cost (World Bank, Q3 2025), and freelancers are routinely paid late. Malaysia has millions of self-employed and gig workers.

**What we build**
- A "contractor" user type with limited access: submit claims and invoices, see payouts. No HR or company data.
- Payouts in the payee's currency. Batches are split by currency, since one batch uses one currency.
- **The MYR rule:** a Malaysian PayPal account can pay MYR only to Malaysian accounts, and can't send payouts that need conversion to or from MYR. Overseas payees must therefore be paid from a USD (or local-currency) balance that the company tops up separately. The company setup screen must show this, and the payout service must refuse an MYR payout to a non-Malaysian payee before calling PayPal.
- FX shown before HR approves ("USD 120.00 ≈ MYR 5xx at today's rate").
- Policy rules per contractor contract (rate, billable expense categories).

**Example.** A Jakarta designer submits IDR 1,200,000 for a font licence. Policy allows software for this contract. HR approves and the payout goes in IDR to their PayPal.

**Builds on.** The payout service, the trust tiers (contractors start as "new"), and the decision engine.

**PayPal and AI.** PayPal: Payouts in 24 currencies, with Venmo for US payees. AI: reading foreign-language receipts and invoices, and currency detection.

**Guardrails**
- Contractors are never auto-paid until they reach the trusted level.
- FX limits and per-country rules (some currencies can't be converted).
- Sanctions and KYC are handled by PayPal. We don't store identity documents.

**Success measures**
- Time from invoice to payout.
- Payout failure rate by country.
- Payment cost compared with the company's previous method.

**Effort.** L. **Open questions:** the tax and legal treatment of contractor reimbursements per country. Under the Gig Workers Act, do any of our flows count as payments that need specific records?

---

### F6. Claim by chat (WhatsApp, Telegram, Slack)

**Problem.** Opening an app, logging in and filling a form is friction, so claims arrive late or not at all.

**What we build**
- A bot on WhatsApp Business (first, because of Malaysian usage), then Telegram and Slack.
- The employee sends a photo and a short note. The agent extracts fields, asks for anything missing, and shows a summary with "Submit".
- Status updates come back in the same chat: "Approved and paid: RM45 is in your PayPal."
- The account is linked once through a one-time code from the app.

**Example.** Photo of a Grab receipt + "airport, client visit". Bot: "Transportation, RM45.00, 12 Nov. Submit as claim RC-2291?" → Submit → the live timeline link → the payout notification.

**Builds on.** The same analysis pipeline and SSE progress events. The chat is just another front end.

**PayPal and AI.** AI: field extraction and a short follow-up conversation. PayPal: payout notifications sent to the chat.

**Guardrails**
- Linking needs a code from the logged-in app. A phone number alone never links an account.
- The bot never shows another person's data.
- Message text is data, never instructions.
- Sensitive actions (changing the PayPal account) are only possible in the app.

**Success measures**
- Share of claims submitted by chat.
- Days from purchase to claim.
- Drop-off rate in the chat flow.

**Effort.** M per channel. **Open questions:** WhatsApp Business API costs per conversation, and the data residency rules under Malaysia's PDPA.

---

### F7. HR assistant (proposes, never pays)

**Problem.** Approval is the slowest step, and HR spends time finding and filtering claims.

**What we build**
- An assistant panel on the HR dashboard. HR asks in plain language.
- It answers with a filtered list or a draft batch, never an action. Every money action needs HR to click a normal approve button, and goes through the same decision engine and two-person rules.
- Example questions: "What's waiting longest?", "Show approved travel under RM100 last week", "Why was claim RC-2210 sent to two-person review?"

**Example.** "Batch approve all quick-approval meals this week under RM60" → the assistant shows 9 claims, RM402, with 1 excluded ("employee is HR, can't approve own claim") → HR clicks "Approve 9".

**Builds on.** The ledger and triage grid, batch approve, and the stored decision explanations.

**PayPal and AI.** AI: turning a question into a safe filter, and summarising. PayPal: none directly. Payouts happen only after HR approves.

**Guardrails**
- **The assistant has no tool that moves money or changes status.** This keeps the hackathon's core rule: the AI never starts a payment.
- Queries run read-only.
- Every assistant answer is logged in the action log.

**Success measures**
- Median time from submission to HR decision.
- Share of HR sessions that use the assistant.
- Zero money actions without a human click (audited).

**Effort.** M.

---

### F8. Policy simulator

**Problem.** HR changes caps and rules by guessing. Out-of-policy spend costs about $85k a year.

**What we build**
- Extend the hackathon back-test (automation rate against expected loss) to policy rules.
- HR edits a draft policy, Reclaim re-runs the last 90 days of claims through it, and shows cost, partial approvals, and auto-pay rate before and after.
- The new policy is saved as a new version. Old claims keep the version they were judged under.

**Example.** "Meal cap RM50 → RM80" → "+RM3,140 last quarter, 41 fewer partial approvals, auto-pay rate 64% → 71%."

**Builds on.** The back-test endpoint and the Autonomy Dial UI (AG Charts).

**Effort.** M. **Open questions:** re-running the LLM over 90 days of claims is expensive. Can we re-score stored extracted fields instead, with no new LLM calls?

---

### F9. Smart buying for equipment (Channel3 + PayPal)

**Problem.** Equipment purchases are large, often over-priced, and each one is paid back later.

**What we build**
- The employee says what they need. The agent searches Channel3's product graph for options within the policy's price cap and preferred brands, and explains the choice.
- The manager approves, and the company pays through PayPal (F2). The order and receipt are linked automatically, and F3 matches them.

**Example.** "27-inch monitor for design work" → 3 options at RM720–RM880 with reasons → manager picks one → paid → the claim closes itself when the invoice arrives.

**Builds on.** The planned AI-8 Channel3 price check, plus F2.

**PayPal and AI.** Channel3: product search API (1,000 free searches a month at the time of writing). PayPal: checkout or merchant payment. AI: requirement matching and explanation.

**Guardrails**
- The agent proposes and a person approves. It never buys by itself.
- Only merchants on an allow-list.
- Price checked again at payment time.

**Effort.** L. **Why later:** it targets the Agentic Commerce prize, but needs F2 first. During the hackathon we only ship the price check.

---

### F10. Camera-first app and employee wallet (dropped)

**Dropped on 12 Nov 2026.** Kept here for the record; see §6.

**Problem.** A quarter of travelers lose receipts, and employees can't see where their money is.

**What we build**
- **Capture:**
  - The PWA opens to the camera when launched from the home screen.
  - Auto-crop and instant extraction.
  - Offline queue that uploads when the phone is back online.
- **Wallet:**
  - Pending, approved, paid and recovered claims on one screen.
  - Year-to-date total.
  - Next payout.

**Builds on.** The existing PWA, the mobile upload picker, and the money-flow component.

**Effort.** M.

---

### F11. Team budgets with early warnings

**Problem.** Overspending is discovered at month end.

**What we build**
- Budgets per team and category, set by HR.
- A live meter.
- Warnings to the team lead at 75% and 90%.
- The decision engine can treat "team budget exceeded" as a hard stop for auto-pay. The claim is still payable after HR approves.

**Builds on.** The company daily budget and the hard-stop list in the decision engine.

**Effort.** M.

---

### F12. Month-end report for finance

**What we build.** An AI-written monthly summary from the ledger and action log:
- spend by category and team
- auto-pay rate
- fakes caught
- recoveries
- top policy breaches

Every number in the report links to the underlying rows. The model writes the text, but the numbers come from SQL, never from the model.

**Effort.** S–M.

---

### F13. Malaysian e-invoice readiness

**Problem.** MyInvois is mandatory for more businesses each phase. Finance teams need expense records that match.

**What we build**
- Store supplier TIN and e-invoice ID when the receipt has them.
- Flag claims where a self-billed e-invoice may be needed (for example, payments to individuals or foreign suppliers).
- Export in the format finance can file.

**Effort.** M. **Open questions:** *verify with LHDN guidelines and a tax adviser* which reimbursement types are in scope. The sources we found disagree.

---

## 4. Improvements to what we are building now

These harden the hackathon features for real use. They come before most new features.

### 4.1 Going live with PayPal
- **Live account approval:**
  - Apply for live Payouts on the PayPal business account. PayPal reviews this separately from sandbox.
  - Complete business verification.
  - Plan for payout limits on new accounts.
- **Funding:** an alert when the business balance is below N days of expected payouts, so a payout never fails for lack of funds.
- **Webhooks:**
  - Replay protection (store event IDs).
  - Dead-letter queue for failed handling.
  - A daily job that refreshes any payout stuck in a non-final state for more than 24 h.
- **Reconciliation:**
  - Daily match of our ledger against PayPal Transaction Search (planned PP-7), with any differences sent to HR.
  - Use the official Server SDK for this, since it covers Transaction Search.
  - Keep our own Payouts client, because the SDK doesn't cover Payouts.

### 4.2 Receipt Shield
- **Image forensics:** error-level analysis and noise checks for pasted-in numbers.
- **Duplicate detection at scale:** perceptual hashes stored in a vector index across every company, so the same receipt used at two employers is caught (with privacy-safe hashes only).
- **Calibration:** measure false positives on real claims, and tune signal points from data instead of the hackathon defaults.
- **Red-team suite:** a growing set of fake receipts (AI-made, edited, injected), run on every model or prompt change. A drop in the catch rate blocks release.

### 4.3 Decision engine and trust
- Tune the default limits (RM50 / RM100 / RM200, RM15 review cost) using pilot data. Open question 4 in PLAN.md.
- Explain trust changes to employees in plain words ("2 more approved claims to reach RM200 instant payouts").
- Per-company settings history, with who changed what, using the existing action log.

### 4.4 Product polish
- **Notifications:** email and push for payout received, overpayment notice, and dispute deadline.
- **Accessibility:** keyboard paths through the HR grid, contrast checks, and screen-reader labels on the timeline.
- **Dark mode and denser HR views.**
- **Remove the leftover hard-coded sample-data screens:**
  - `hr/review`
  - `hr/view`
  - `hr/policy`
  - `employee/history` mock imports

### 4.5 Platform
- **Multi-company:** company accounts, isolated data, per-company PayPal credentials.
- **Observability:** payout success rate, time to pay, agent cost per claim, and LLM latency, on a dashboard with alerts.
- **Security:** rate limits on claim submission, secrets in a vault, audit log export.
- **Privacy:**
  - Retention rules for receipts.
  - A data-subject access export.
  - A breach-response runbook, under Malaysia's PDPA (*verify current obligations after the 2024 amendments*).

---

## 5. Roadmap

Dates assume the hackathon ends 11 Nov 2026 and the team keeps going part-time.

| Phase | When | Goal | Contents |
|---|---|---|---|
| ~~**0. Hackathon**~~ | ~~Now → 11 Nov 2026~~ | ~~Win: safe automation, shown end to end~~ | ~~PLAN.md as written~~ Ended 11 Nov. Submitted, as reported by the team. |
| **1. Make it real** | Nov–Dec 2026 | One pilot company using live PayPal | §4.1 go-live, §4.2 calibration, §4.4 cleanup, **F1** ask before you spend (P1), **F7** HR assistant (P1) |
| **2. Remove out-of-pocket** | Q1 2027 | Employees stop fronting money for travel | **F4** travel advance (P1), **F2** company-paid bookings (P2), **F3** payment matching (P2), **F12** month-end report (P3) |
| **3. Meet people where they are** | Q2 2027 | Faster submission, better control | **F6** chat claims, Telegram first then WhatsApp (P2), **F11** team budgets (P3), **F8** policy simulator (P3) |
| **4. Grow the market** | H2 2027 | Contractors and overseas staff | **F5** contractors and FX (P2), §4.5 multi-company; **F9** and **F13** (P4) only if a pilot customer asks |

**Status on 12 Nov, evening.** Phase 0 is over. Nothing in phases 1 to 4 is complete. In phase 1, §4.1 go-live is partly done (G5 done; G2, G3 and G4 partly done; G1 not started), §4.4 cleanup is partly done, and calibration (R1), F1 and F7 have not started. Work merged outside any phase: D2 (§4.3), R2 and R3 (§4.2), and the O2 rate limits (§4.5, partly done). F10 was dropped and was never in a phase. Details: [Status as of 12 Nov 2026](#status-as-of-12-nov-2026).

**Why this order**
- **Phase 1 first.** A product that hasn't paid a real employee can't sell anything else, and F1 is cheap and lowers rejections straight away.
- **Phase 2 next.** It removes the biggest source of employee stress (paying first), and unlocks F3, our strongest fraud signal.
- **Chat and the HR assistant come after.** They speed up a process that should already work well.
- **Contractors and smart buying come last.** They bring the most legal and FX complexity, and they depend on everything before them.

**Metrics we track across phases**
- Median time from submission to money received.
- Auto-pay rate.
- Fakes caught vs fakes missed (from audits).
- Partial or rejected claim rate.
- Employee out-of-pocket balance.
- HR minutes per claim.

---

## 6. Ideas we rejected, and why

| Idea | Why not |
|---|---|
| **Read employees' personal PayPal history to match receipts** ("no-upload expenses") | PayPal's Transaction Search only covers the company's own account. Third-party access needs PayPal partner status. It would also mean reading private spending. F3 gets the same benefit for company-made payments without either problem. |
| **An AI agent that pays by command** ("pay all travel claims under RM100") | Breaks the rule that the AI never starts a payment. F7 gives the same speed with a person pressing the button. |
| **Replace our database search with Elasticsearch** | No gain over Postgres with pgvector at our size. It was considered only for a judge's company, which had no prize. |
| **F10 Camera-first app and wallet** (dropped 12 Nov 2026) | Opening straight to the camera gets in the way of employees who open the app to check a claim, asks for camera permission before they've seen anything, and doesn't suit HR users. The wallet part was dropped with it. |
| **Use the PayPal Server SDK for payouts** | The SDK (v2.4.0) doesn't include Payouts. We use it for Transaction Search only (§4.1, F3). |

---

## 7. Sources

Most expense-industry figures below come from surveys commissioned by software vendors (Airwallex, Emburse, AppZen, Teampay, TravelPerk and others). They are useful for direction, but samples and methods vary. Figures marked *verify* in the text should be checked against the primary source before we quote them publicly.

**Processing cost and time**
- [gbta-cost]: https://gbta.org/how-much-do-expense-reports-really-cost-a-company/ — GBTA, "How Much Do Expense Reports Really Cost a Company?"
- [gbta-pain]: https://www.gbta.org/new-study-reveals-pain-points-in-expense-reporting/ — GBTA Foundation and HRS, "Expense Reporting: Global Practices and Pain Points" (2015)
- [turnaround]: https://www.resourcefulfinancepro.com/articles/how-efficient-are-your-companys-te-turnaround-times/ — approval and reimbursement times (Business Travel News 2019 survey)

**Employee impact**
- [airwallex-sg]: https://www.airwallex.com/en-sg/blog/reimbursement-frustrations — Airwallex, Singapore reimbursement survey
- [accountancy-age]: https://accountancyage.com/2025/04/17/why-expense-systems-are-failing-uk-staff-in-2025/ — UK, 2025
- [card-vs-reimb]: https://insightfulaccountant.com/in-the-news/people-and-business/how-do-business-spenders-really-feel-about-using-personal-ca/ — Center survey on personal cards for work
- [travelperk]: https://www.travolution.com/news/travelperk-reveals-83-of-employees-struggle-with-travel-expenses/ — TravelPerk, 83% struggle with travel expenses, 25% lose receipts
- [pymnts-traveler-bank]: https://www.pymnts.com/?p=533037 — "How Traveling Employees Turn Into Banks For Their Employers"

**Fraud**
- [pymnts-ai-receipts]: https://www.pymnts.com/?p=3892615 — PYMNTS, "AI-Generated Fake Receipts Now Make Up 71% of Expense Fraud" (26 Jun 2026; AppZen data via Accounting Today, Emburse/Atomik survey)
- [techradar]: https://www.techradar.com/pro/security/workers-are-scamming-their-employers-using-ai-generated-fake-expense-receipts — AppZen, 14% in Sept 2025
- [acfe-mondaq]: https://www.mondaq.com/canada/white-collar-crime-anticorruption-fraud/1486950/the-cost-of-occupational-fraud-from-the-2024-acfe-report — ACFE 2024 summary
- [acfe-emburse]: https://www.emburse.com/blog/finance-fraud-and-frustration-key-findings-from-the-acfe-2024-report — ACFE 2024 summary
- [owasp]: https://aembit.io/blog/owasp-top-10-llm-risks-explained/ — OWASP Top 10 for LLM applications, LLM01 prompt injection

**Policy awareness**
- [policy-survey]: https://www.businesstravelnewseurope.com/management/firms-fail-to-enforce-travel-expenses-policy — firms failing to enforce travel policy
- [teampay]: https://news.teampay.co/hubfs/Kelton%20report%2021-22/BeyondTheBalanceSheet_EmployeeExperience_20210806%20(1).pdf — Teampay/Kelton, "Beyond the Balance Sheet"
- [els]: https://www.theemploymentlawsolicitors.co.uk/news/blog/workplace-expenses/ — 38% don't spend when unsure
- [fintechfutures]: https://fintechfutures.com/?p=15233660 — $85,000 a year lost to misaligned spend policies

**Malaysia**
- [oecd-msme]: https://www.oecd.org/en/publications/financing-smes-and-entrepreneurs-2026_bb7fc5c4-en/malaysia_ebf7a4e9-en.html — OECD, Financing SMEs and Entrepreneurs 2026: Malaysia
- [dosm-msme]: https://www.dosm.gov.my/portal-main/release-content/micro-small--medium-enterprises-msmes-performance-2024 — DOSM, MSME Performance 2024
- [nst-gig]: https://www.nst.com.my/amp/business/corporate/2025/12/1338020/malaysias-gig-workers-bill-2025-protects-12mil-workers — Gig Workers Bill 2025
- [malaymail-gig]: https://www.malaymail.com/amp/news/malaysia/2026/02/10/ramanan-govt-to-enforce-gig-workers-act-in-2026-strengthening-protection-for-345-million-workers/208756 — Gig Workers Act enforcement, 2026
- [cleartax-einv]: https://www.cleartax.com/my/en/different-phases-implementation-timelines-einvoicing-malaysia — e-invoicing phases
- [fiscal-einv]: https://www.fiscal-requirements.com/news/4247-malaysias-e-invoicing-mandate-main-updates-for-2026-rollout — 2026 e-invoicing updates
- [warc-whatsapp]: https://www.warc.com/content/article/warc-datapoints/malaysians-spending-longer-on-social-media-but-penetration-stable/129412 — WhatsApp weekly use in Malaysia

**Cross-border payments**
- World Bank, Remittance Prices Worldwide (Q3 2025): average 6.36%, banks 14.99%, digital 4.59%. Figures quoted via https://www.getontop.com/blog/best-way-to-pay-international-contractors. *Verify on remittanceprices.worldbank.org.*
- Remote, Contractor Management Report 2025: 85% of freelancers paid late at least sometimes (via https://vaultleap.com/blog/freelancers-lose-3800-a-year-to-late-payments-heres-the-math)

**PayPal and partners**
- [pp-payouts]: https://docs.paypal.ai/growth/payouts/overview — Payouts overview (96 countries, 24 currencies)
- [pp-fx]: https://developer.paypal.com/payouts/currency-conversion — Payouts currency conversion and restrictions
- [pp-txn]: https://docs.paypal.ai/reference/api/rest/transactions/list-transactions.md — Transaction Search (own account, partner network for third parties, up to 3 h delay)
- [pp-sdk]: https://github.com/paypal/PayPal-Python-Server-SDK — PayPal Python Server SDK v2.4.0 (Orders, Payments, Vault, Transaction Search, Subscriptions)
- [pp-payouts-sdk]: https://developer.paypal.com/sdk/payouts — PayPal Payouts SDK
- Channel3: https://trychannel3.com/blog/channel3-raises-6m — product graph API for AI shopping agents

**Sandbox checks (section 1.1)**
- Payouts country support and the Malaysia/MYR restriction: https://developer.paypal.com/payouts/supported-features
- Payouts sandbox error triggers (`ERRPYO…`): https://developer.paypal.com/docs/payouts/standard/integrate-api/test-and-go-live/
- Payouts to Venmo (`recipient_wallet: VENMO`, US only): https://developer.paypal.com/api/payouts/standard.md
- Invoicing API sandbox quick start: https://developer.paypal.com/api/invoicing.md
- Transaction Search in sandbox (scope, delays, empty results; community reports, not official): https://www.paypal-community.com/t5/REST-APIs/Transaction-Search-setting-in-API-doesn-t-work/m-p/3057775, https://www.paypal-community.com/t5/REST-APIs/REST-API-Request-for-transaction-list-is-empty/m-p/2017590
- WhatsApp sandbox (third-party example): https://docs.360dialog.com/docs/waba-messaging/sandbox
- MyInvois pre-production environment (secondary source): https://docs.ecosire.com/odoo-modules/malaysia-myinvois

[gbta-cost]: https://gbta.org/how-much-do-expense-reports-really-cost-a-company/
[gbta-pain]: https://www.gbta.org/new-study-reveals-pain-points-in-expense-reporting/
[turnaround]: https://www.resourcefulfinancepro.com/articles/how-efficient-are-your-companys-te-turnaround-times/
[airwallex-sg]: https://www.airwallex.com/en-sg/blog/reimbursement-frustrations
[accountancy-age]: https://accountancyage.com/2025/04/17/why-expense-systems-are-failing-uk-staff-in-2025/
[card-vs-reimb]: https://insightfulaccountant.com/in-the-news/people-and-business/how-do-business-spenders-really-feel-about-using-personal-ca/
[pymnts-ai-receipts]: https://www.pymnts.com/?p=3892615
[techradar]: https://www.techradar.com/pro/security/workers-are-scamming-their-employers-using-ai-generated-fake-expense-receipts
[acfe-mondaq]: https://www.mondaq.com/canada/white-collar-crime-anticorruption-fraud/1486950/the-cost-of-occupational-fraud-from-the-2024-acfe-report
[acfe-emburse]: https://www.emburse.com/blog/finance-fraud-and-frustration-key-findings-from-the-acfe-2024-report
[owasp]: https://aembit.io/blog/owasp-top-10-llm-risks-explained/
[policy-survey]: https://www.businesstravelnewseurope.com/management/firms-fail-to-enforce-travel-expenses-policy
[teampay]: https://news.teampay.co/hubfs/Kelton%20report%2021-22/BeyondTheBalanceSheet_EmployeeExperience_20210806%20(1).pdf
[els]: https://www.theemploymentlawsolicitors.co.uk/news/blog/workplace-expenses/
[fintechfutures]: https://fintechfutures.com/?p=15233660
[oecd-msme]: https://www.oecd.org/en/publications/financing-smes-and-entrepreneurs-2026_bb7fc5c4-en/malaysia_ebf7a4e9-en.html
[dosm-msme]: https://www.dosm.gov.my/portal-main/release-content/micro-small--medium-enterprises-msmes-performance-2024
[nst-gig]: https://www.nst.com.my/amp/business/corporate/2025/12/1338020/malaysias-gig-workers-bill-2025-protects-12mil-workers
[malaymail-gig]: https://www.malaymail.com/amp/news/malaysia/2026/02/10/ramanan-govt-to-enforce-gig-workers-act-in-2026-strengthening-protection-for-345-million-workers/208756
[cleartax-einv]: https://www.cleartax.com/my/en/different-phases-implementation-timelines-einvoicing-malaysia
[fiscal-einv]: https://www.fiscal-requirements.com/news/4247-malaysias-e-invoicing-mandate-main-updates-for-2026-rollout
[warc-whatsapp]: https://www.warc.com/content/article/warc-datapoints/malaysians-spending-longer-on-social-media-but-penetration-stable/129412
[pp-payouts]: https://docs.paypal.ai/growth/payouts/overview
[pp-fx]: https://developer.paypal.com/payouts/currency-conversion
[pp-txn]: https://docs.paypal.ai/reference/api/rest/transactions/list-transactions.md
[pp-sdk]: https://github.com/paypal/PayPal-Python-Server-SDK
[pp-payouts-sdk]: https://developer.paypal.com/sdk/payouts
