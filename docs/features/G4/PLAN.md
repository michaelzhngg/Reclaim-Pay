# G4: Daily ledger reconciliation (PP-7)

Status: implemented on `feat/g4-ledger-reconciliation`, based on `main` at `ce1469f`. `DECISIONS.md`, `GAPS.md` and `RUNBOOK.md` carry the implementation and operational notes.

Reclaim Pay compares its payout ledger with the company's PayPal account so finance can tell whether a payout marked paid actually left PayPal. PP-7 already shipped the on-demand comparison behind the HR Payouts header. G4 adds the daily run, a durable record of what differed, and a way for HR to hear about differences without opening the page.

## 1. What exists today

- The comparison lives in `backend/engine/services/reconcile_service.py`. `reconcile(db, days)` loads PayPal payouts that are settled (`SUCCEEDED`, `REVERSED`) or still in flight (`ACCEPTED`, `REQUESTED`), searches PayPal Transaction Search for the period plus a 2-hour match window, and returns a `ReconcileSummary`.
- The summary has three states. `ok` is a real comparison with counts (`reconciled`, `total`, `pending`), a list of payouts missing from PayPal (`MISSING_IN_PAYPAL`) and a list of unmatched PayPal mass payments (`UNKNOWN_IN_PAYPAL`). `no_data` means there was nothing to compare or PayPal returned an empty search. `unavailable` means PayPal could not be reached or the app lacks the reporting scope.
- Matching is greedy and one-to-one: same currency, exact amount, closest unused transaction within 120 minutes. PayPal can take up to 3 hours to list a transaction, so a recent payout is `pending`, not a difference. In a real comparison, payouts with seeded or mock batch IDs (`DEMOSEED-`, `MOCKB-`) are not compared; mock mode fabricates a matching feed for everything.
- Transaction Search goes through the PayPal Server SDK's `transaction_search` controller, paginated, 15-second timeout, 20 pages maximum, all pages or nothing. Payouts stay on the project's own `PayPalClient`, because the SDK has no Payouts. This split is deliberate and must stay.
- Mock mode fabricates a PayPal feed that agrees with our ledger and sets `mock=true`, so the UI can say the numbers are mock.
- The HR endpoint is `GET /api/v1/payouts/reconcile?days=1..30`, HR-only, synchronous. `frontend/lib/actions/reconcile.ts` calls it from `ReconcileBadge`, which renders "Reconciled N of M" and a differences disclosure on the Payouts page.
- `backend/tests/test_reconcile.py` covers matching, the 2-hour boundary, the 3-hour lag, pagination, SDK and OAuth failures, empty searches, mock mode, the seeded/mock exclusions, endpoint auth and route ordering. These tests must keep passing untouched.
- In-app notifications are rows in `notifications`, written by `notify()` in `payout_service`; it also attempts a web push. G2's `funding_service.alert_hr` is the established pattern for HR alerts: one title per condition, suppressed for 24 hours.
- There is no scheduler in the repo. No APScheduler, no worker process, no cron entry, no `type: cron` in `render.yaml`. The API lifespan only initialises the database, checks the LLM and loads VAPID keys.
- Alembic head is `2a7c9e1d4b80`. The worktree test database `reclaim_g4` is migrated to that head. Any new table needs both a SQLModel model and a migration.
- The action log (`agent_actions`) is a hash-chained log of agent and HR actions. It is not a job ledger and is not used here.

## 2. What is missing

- **No record.** A comparison disappears when the response is rendered. Reload the page and it is recomputed from scratch.
- **No history.** HR cannot see that yesterday was clean, that the same payout has been missing for three days, or when the comparison last succeeded.
- **No push.** Differences are only visible to an HR user who opens Payouts and reads the badge. Nobody is told.
- **No schedule.** The check runs only when someone loads the page.
- **No lifecycle.** The comparison is a rolling window. A payout that is missing from PayPal falls out of the window after a few days and silently stops being reported, even though it was never resolved.
- **No trust signal for the job itself.** If the daily run stops, nothing says so.

## 3. Design

### 3.1 Invariants

1. **The comparison is not rewritten.** The job calls `reconcile()` and stores its result. Match logic, the 2-hour window, the 3-hour lag and the SDK client stay exactly where they are.
2. **Report only.** The job writes reconciliation runs, differences and notifications. It never changes a `Payout`, `Reimbursement` or `Recovery`, never retries or reverses a payout, and never calls a money-moving PayPal API.
3. **Out of process.** The scheduled run is a separate process, so a slow or hung PayPal search cannot sit in a web request or delay a payout.
4. **Every run is recorded**, including `no_data` and `unavailable`, so gaps and outages are visible.
5. **One open difference per subject.** Seeing the same missing payout again updates `last_seen`; it does not clone the row.
6. **No repeat noise.** An unchanged open difference is not notified again. An outage is notified once per outage, not once per retry.
7. **HR decides.** A difference never gates, holds or reverses a payout. HR reviews it and can close it.

Why these choices, in one line each:

- **Persist differences, not only run summaries.** A summary in JSONB would be enough for history, but it cannot give one subject a stable open/resolved lifecycle, and the rolling window would silently drop an unresolved payout. A keyed difference row is the smallest thing that keeps it visible.
- **Keep the live badge.** Replacing it with stored data would make the header stale between runs and remove the "check again" recovery path. The badge stays a live check; the tab is the record.
- **No action-log entry per run.** The hash-chained log is for agent and HR actions. A daily system row would add noise and a write lock to every run, and the run table is already the audit record.

### 3.2 Data model

Two tables, added to `core/models.py` with an Alembic migration on top of `2a7c9e1d4b80`.

**`reconciliation_runs`** is one row per comparison attempt.

| Column | Notes |
|---|---|
| `run_id` | UUID primary key |
| `trigger` | `schedule` or `manual` |
| `started_at`, `finished_at` | UTC, timezone-aware |
| `days`, `window_start`, `window_end` | What the comparison covered |
| `state` | `ok`, `no_data`, `unavailable`, `failed` |
| `reconciled`, `total`, `pending` | The summary's counts, unchanged |
| `differences_new`, `differences_open` | How many open differences this run added and how many remain |
| `data_through`, `mock`, `message` | PayPal's refresh time, mock flag, human-readable reason |
| `error` | Exception class name for `failed`; never a traceback or secret |
| `triggered_by` | HR user for a manual run, null for the schedule |

Index on `started_at`.

**`reconciliation_differences`** is one row per subject that differs.

| Column | Notes |
|---|---|
| `difference_id` | UUID primary key |
| `kind` | `MISSING_IN_PAYPAL` or `UNKNOWN_IN_PAYPAL` |
| `payout_id`, `reim_id` | Set for a missing payout, null for an unknown transaction |
| `transaction_id` | Set for an unknown transaction, null for a missing payout |
| `amount`, `currency` | Snapshot from the run |
| `employee_name` | Snapshot for readability; HR-only data |
| `occurred_at` | Payout creation time, or transaction time |
| `first_seen_at`, `last_seen_at` | Across runs |
| `first_run_id`, `last_run_id` | Which runs opened and last saw it |
| `resolved_at`, `resolution`, `resolved_by` | `MATCHED` (a later run found it) or `DISMISSED` (HR) |

Partial unique indexes enforce one open row per payout and one open row per transaction (`resolved_at IS NULL`).

### 3.3 The daily run

1. Open a session and call `reconcile(db, days=3)`. Three days is deliberate: it covers PayPal's 3-hour lag and gives a payout two daily runs before it leaves the window, so one missed run does not skip a payout forever. No writes happen while the PayPal call is in flight.
2. Persist the run row with the summary's state, counts, period, `data_through`, mock flag and message.
3. Only when the state is `ok`, reconcile the difference set:
   - Upsert a `MISSING_IN_PAYPAL` row keyed by `payout_id` and an `UNKNOWN_IN_PAYPAL` row keyed by `transaction_id`.
   - Refresh `last_seen_at`, `last_run_id`, `amount`, `currency` and `employee_name`.
   - Close open differences that this run no longer reports **and whose subject is still inside the compared window**, with resolution `MATCHED`. An older open difference is left open on purpose: it must not vanish just because the rolling window moved past it.
4. Count new and still-open differences, then save the counts on the run.
5. Commit the run and its differences.
6. Notify HR (section 3.7), best effort.
7. The CLI prints one line: state, reconciled/total, pending, new/open differences. The API returns the run.

Committing the record before notifying is deliberate: a notification failure must not undo the run.

A `no_data` or `unavailable` run changes no difference rows. It can never manufacture a difference or close one.

### 3.4 Difference lifecycle

```
new run reports it        -> open   (first_seen_at set, notified if new)
later ok run finds a match -> resolved MATCHED   (leaves the open list)
HR marks it reviewed       -> resolved DISMISSED (leaves the open list)
same subject differs again -> a new open row, notified again
```

A resolved row is never deleted. Run counts and the row's timestamps remain as the audit trail.

### 3.5 API

All three routes are HR-only. They live with the existing `/payouts` routes and must stay declared before `GET /payouts/{reim_id}`, which would otherwise capture the path segment.

- `GET /api/v1/payouts/reconcile/history?runs=14` returns the latest run, the most recent successful run's time, the recent run history and the open differences. One read for the tab.
- `POST /api/v1/payouts/reconcile/run` runs a manual comparison through the same service and returns the new run. It uses the same 3-day default as the schedule, with an optional `days` override for a deliberate backfill. This is the tab's "Check now" and the demo trigger. Manual runs follow the same notification rules as scheduled runs.
- `POST /api/v1/payouts/reconcile/differences/{difference_id}/dismiss` closes a difference as `DISMISSED`, recording the HR user's id. It is idempotent: dismissing an already dismissed row returns the row unchanged.

The existing `GET /payouts/reconcile` stays as it is for the badge. It does not write history: a page load is a live check, not a bookkeeping event.

### 3.6 HR surface

A new **Reconciliation** tab on `/hr/payouts`, after the Ledger tab. The badge remains the at-a-glance live check; the tab is the record.

- Latest run card: state, "Reconciled N of M", the period ("last 3 days"), counts awaiting PayPal, mock label, and `data_through`.
- Warning when the latest successful run is older than 36 hours: "The daily check has not run since <time>." This catches a broken schedule, which is otherwise silent.
- Open differences: claim reference linked to the claim page, employee, amount, when the payment happened, first seen, and the reason in words ("not found in PayPal" or "in PayPal with no matching claim"). "Mark reviewed" per row.
- History: the last 14 runs with date, state, reconciled of total, pending, new differences, mock flag.
- Empty state: "No reconciliation yet" with a "Check now" button.
- Copy never implies the difference blocked, reversed or will reverse a payout. "Mark reviewed" says to check PayPal first.
- A pure helper module and a node Vitest test cover the tone, the stale threshold and the row labels, following the funding card and ledger helpers.

### 3.7 Alerting

- **New differences.** One notification per active HR user, linking to `/hr/payouts?tab=reconciliation`. Type `error` when a payout is missing from PayPal, `warning` when only an unmatched PayPal payment is reported. Message gives the counts and says nothing about reversing a payment. Reuses `notify()`, so web push rides along.
- **Repeat differences.** No notification. `differences_new == 0` means silence.
- **Reopened difference.** A new open row is new again, so it notifies.
- **Outage or failure.** One `warning` per outage: notified when the previous run was not already `unavailable` or `failed`. A successful or `no_data` run re-arms the alert. This is per HR user, same as G2.
- **Notification failure must not fail the run.** The run and differences stay recorded; the notification error is logged.

### 3.8 Schedule and deployment

The job entry point is a CLI module run from `backend/`:

```
python -m jobs.daily_reconcile [--days 3]
```

It exits 0 when the run was recorded as `ok`, `no_data` or `unavailable`, and non-zero only for an unexpected failure, which is what a cron should alert on. It logs a one-line result and no secrets, tokens or full emails.

The schedule is a Render cron service in `render.yaml`, using the same backend image as the API:

- daily at `02:00 UTC` (10:00 MYT);
- `dockerCommand: python -m jobs.daily_reconcile`;
- `DATABASE_URL` from the Render database, `PAYPAL_*` and `PAYPAL_MOCK_MODE`, `SECRET_KEY` reused from the API service, and the existing `reclaim-pay-secrets` group.

No in-process scheduler. Render restarts the web service on every deploy, can run more than one instance, and a PayPal call inside the API process would couple a background job to request latency. A cron service is stateless and observable.

Two operational notes:

- The Blueprint's tracked branch may still be `deploy/render` rather than `main`. Verify it in the Render dashboard before assuming the cron service deploys; otherwise create the cron job in the dashboard.
- Web push from the cron depends on VAPID state that the web service usually owns. In-app notifications are the authoritative channel; a failed push is best effort, as it already is today.

Local demonstration:

```
docker compose exec backend python -m jobs.daily_reconcile
```

With `PAYPAL_MOCK_MODE=true` this records a mock run that reconciles cleanly. A visible difference for demos comes from the demo seed ticket, not from making mock mode lie.

### 3.9 Failure behaviour

| Situation | Recorded | Differences | HR |
|---|---|---|---|
| PayPal unreachable or missing scope | `unavailable` | untouched | one warning per outage |
| Empty search, nothing paid | `no_data` | untouched | silence |
| Unexpected exception | `failed` when the run row can still be written, then non-zero exit | untouched | one warning per outage |
| Database down | no row | untouched | cron failure alert |
| PayPal data older than a payout | `pending` count, not a difference | untouched | "waiting on PayPal" |

## 4. Acceptance criteria

- [ ] A daily run records one run row and its differences, and a second run on the same day does not duplicate open differences.
- [ ] A difference that a later run finds matched inside the compared window closes as `MATCHED`; an older open difference is not closed by the window sliding past it.
- [ ] An open difference older than the window stays visible until HR dismisses it.
- [ ] New differences notify each active HR user once, link to the Reconciliation tab, and do not notify again while unchanged.
- [ ] An outage alerts once per outage and re-arms after a successful or no-data run.
- [ ] HR sees the latest run, open differences with claim links, and the last 14 runs in a Reconciliation tab.
- [ ] The tab warns when the last successful run is more than 36 hours old.
- [ ] A run never changes a payout or a claim; a test asserts both before and after.
- [ ] The job exits 0 for recorded outcomes and non-zero for unexpected failure; the cron command is documented and runs in the deployed image.
- [ ] The migration applies from `2a7c9e1d4b80` on the existing test database and a fresh database bootstraps to a working schema.
- [ ] `pytest`, `npx tsc --noEmit` and `vitest` pass; `test_reconcile.py` is unchanged.

## 5. Risks and open questions

- **The schedule is new infrastructure.** There is no cron in the repo today. A misconfigured Render cron, or a Blueprint tracking the wrong branch, means no daily runs. The 36-hour staleness warning is the in-app safety net.
- **Sandbox Transaction Search is unreliable.** Without the `reporting/search/read` scope, every production run records `unavailable` and HR gets an outage warning. This is the existing PP-7 sandbox limitation, not a regression.
- **Rolling window, not a calendar day.** "Daily" means one run per day over the last 3 days, so consecutive runs overlap and a payout can appear in several runs. Notifications are deduped; history is not. A calendar-day close would require changing the comparison.
- **Resolution is inferred.** Matching a previously missing payout is inferred from its presence in the current window and absence from this run's mismatches. A payout whose status becomes pending again after being flagged would be an edge case; the existing lag rules make it unlikely.
- **Unknown transactions older than the window** stay open until dismissed. This is deliberate, but HR needs the copy to say so.
- **Push from the cron** may be a no-op if VAPID keys live only in the web service. In-app notifications still work.
- **The manual trigger calls PayPal synchronously.** The existing badge already does this on page load. A per-user rate limit is optional hardening, not part of this scope.
- **`total` counts settled payouts only.** A payout stuck in `ACCEPTED` for days is reported as pending, not as a difference. Refreshing stuck payouts is a separate roadmap job.

## 6. Out of scope

- Rewriting, tuning or replacing the matching logic; fuzzy matching, merchant names or line-item matching.
- Matching card, bank or personal-account transactions.
- Automatic reversal, retry, hold or re-payment based on a difference. HR decides; the engine still decides payment.
- Email, Slack or other delivery channels. In-app notifications plus web push are the channel.
- Calendar-day accounting statements, CSV export and the month-end report.
- The other §4.1 daily job that refreshes payouts stuck in a non-final state.
- Backfilling runs from before this feature.
- Multiple companies, multiple PayPal accounts, multi-currency consolidation.
- Retention pruning. One run a day is a trivial number of rows.
- Making mock mode manufacture differences. Demo differences come from a demo seed.

## 7. Tickets

| # | Ticket | Blocked by |
|---|---|---|
| 01 | Record every ledger reconciliation run and its differences | none |
| 02 | HR sees reconciliation history and open differences in Payouts | 01 |
| 03 | New differences notify HR | 01 |
| 04 | The daily check runs on a schedule | 01 |
| 05 | HR closes a reviewed difference | 01, 02 |
| 06 | Demo a difference end to end | 02, 03 |

Ticket files are in `.scratch/G4/issues/`. They are working notes and are not committed.

## 8. Verification

```bash
(cd backend && uv sync --frozen && uv run pytest -q)
(cd backend && DATABASE_URL=postgresql://admin:password@localhost:5432/reclaim_g4 TEST_DATABASE_URL=postgresql://admin:password@localhost:5432/reclaim_g4 SECRET_KEY=test-secret-not-default PAYPAL_MOCK_MODE=true uv run pytest -q)
(cd frontend && npx tsc --noEmit && npm test)
(cd backend && DATABASE_URL=postgresql://admin:password@localhost:5432/reclaim_g4 uv run alembic upgrade head)
(cd backend && uv run python -m jobs.daily_reconcile)
```

The Postgres suite rolls back each test. The CLI is safe to run repeatedly in mock mode: it records runs, and the partial unique indexes keep open differences single.
