# G3: Harden PayPal webhooks

**Task:** ClickUp G3, from the go-live roadmap in `docs/hackathon/FUTURE-DEVELOPMENT-PLAN.md` §4.1.
**Branch:** `feat/g3-webhook-hardening`, based on `main` at `ce1469f`.
**Status:** plan only. No implementation in this phase.

## 1. Problem

PayPal is the only source of truth for whether a payout succeeded. Three gaps stop the webhook path
from being safe to run against a live account:

1. **No replay ledger.** Every delivery is processed again, including repeated PayPal retries and
   deliberate replays. The domain handlers happen to be idempotent, so this has not double-paid
   anyone, but it is not replay protection: there is no record of which event IDs were handled, no
   way to tell a first delivery from a retry, and every replay repeats signature verification and
   database work.
2. **No dead-letter queue.** A handler exception becomes a 500 and is lost from our side. PayPal
   retries for a while, but if it gives up, or if the failure is permanent, nobody can see what
   failed or retry it after a fix.
3. **No sweep for stale payouts.** `refresh_payout` exists, but it only runs when someone opens a
   claim (`GET /payouts/{reim_id}`) or, in mock mode, from a one-shot timer after payout creation.
   A payout that nobody opens can sit in `ACCEPTED` or `REQUESTED` indefinitely.

## 2. Current state

- `POST /api/v1/paypal/webhook` parses the event, verifies the signature through
  `get_paypal_client().verify_webhook` unless `PAYPAL_MOCK_MODE` is on, dispatches
  `PAYMENT.PAYOUTS-ITEM.*` to `apply_item_update` and `INVOICING.INVOICE.PAID` to
  `mark_recovered`, then returns `{"status": "ok"}`.
- `apply_item_update` locks the payout with `FOR UPDATE`, maps PayPal's item status, refuses to move
  a final status backwards, commits, and only records a `PAYOUT_STATUS` action / notifications when
  the status actually changes. `mark_recovered` similarly no-ops unless the recovery is `INVOICED`.
- That means duplicate deliveries are **effect-idempotent today**. The README's claim that
  "duplicate webhooks change nothing" is accurate at the money level. What is missing is an event
  ledger, failure capture, and an operator path.
- No table stores `event["id"]`. No attempt count, error, or payload is kept. Exceptions propagate as
  500s, so PayPal retries are the only retry mechanism.
- `payout_status.refresh_payout` already knows how to pull an item status from PayPal and feed it
  through `apply_item_update`. `GET /payouts/{reim_id}` calls it when the stored payout is more than
  10 seconds old; mock payouts schedule one refresh roughly 9 seconds after creation.
- `main.py` has an async lifespan that runs `init_db`, the LLM health check, and VAPID key setup.
  There is no background loop, no cron entry in `render.yaml`, and no job runner.
- The action log is hash-chained and uses advisory lock `724242`. It commits pending changes when
  `record_action` is called, so lock ordering matters.
- Mock mode's PayPal client keeps batches in memory. A mock or seeded batch ID (`MOCKB-`,
  `DEMOSEED-`) will not be found by PayPal or by a fresh mock client, so the sweep must skip these.
- Parallel work already on `main`: G2 funding alerts, G5 payout failure tests, O2 rate limits, R2
  image forensics. None of them changes the webhook endpoint or the payout state machine. The main
  collision risk is the shared HR Payouts page and the Alembic head.

## 3. Goals and non-goals

**Goals**

- Store every signature-verified PayPal event ID exactly once, with enough context to audit and
  replay it.
- Make duplicate and concurrent deliveries safe before any domain work runs.
- Capture handler failures in a dead-letter queue that HR can inspect and retry.
- Refresh payouts that have been non-final and unchecked for more than 24 hours, without adding a
  scheduler dependency.
- Keep all payment decisions in the existing deterministic path. No AI code is involved.

**Non-goals**

- No change to `decide()`, the autonomy limits, or who gets paid.
- No automatic re-send, refund, or cancellation of a payout. The job only refreshes status.
- No replacement for G4 reconciliation, and no daily reconciliation job here.
- No event retention or PII purge policy.
- No external queue or scheduler (Celery, Redis, APScheduler, Render cron).
- No change to the PayPal webhook configuration or signature algorithm.

## 4. Design

### 4.1 One event ledger, with the DLQ as a state

Add `paypal_webhook_events`:

| Column | Type | Purpose |
| --- | --- | --- |
| `event_id` | string, primary key | PayPal's `event.id`, the replay key |
| `event_type` | string, indexed | e.g. `PAYMENT.PAYOUTS-ITEM.SUCCEEDED` |
| `resource_id` | string, nullable, indexed | payout item ID or invoice ID, for support lookup |
| `status` | string, indexed | `RECEIVED`, `PROCESSED`, `IGNORED`, `FAILED`, `DEAD_LETTER` |
| `attempts` | integer, default 0 | incremented on every claimed retry |
| `error` | text, nullable | last handler error, truncated |
| `payload` | JSONB | the verified event, used for retry; never returned by the list API |
| `created_at` | timestamptz | first delivery |
| `updated_at` | timestamptz | last claim/outcome, also the in-flight lease |
| `processed_at` | timestamptz, nullable | set on `PROCESSED` or `IGNORED` |

Composite index on `(status, updated_at)` for the sweep, plus indexes on `event_type` and
`resource_id`.

There is deliberately **no second dead-letter table**. A dead letter is an event row with
`status = DEAD_LETTER`; the payload is stored once, the lifecycle is one row, and HR filtering is a
status query. This is smaller and avoids copying payloads between tables.

### 4.2 Intake order: verify, then claim, then handle

1. Parse JSON. Reject a non-object, invalid JSON, or a missing/blank `event.id` with 400. Nothing is
   written.
2. Verify the signature unless in mock mode. A failed verification returns 400 and writes nothing.
   Replay protection must never run before authenticity, or forged IDs could poison the ledger.
3. Claim the event:
   - Try to insert `RECEIVED` with `attempts = 1` and commit. The primary key is the first fence.
   - On a unique conflict, roll back and load the existing row with `FOR UPDATE`.
   - If it is `PROCESSED` or `IGNORED`, return 200 duplicate and do no work.
   - If it is `RECEIVED` and `updated_at` is inside the lease (default 15 minutes), another delivery
     is handling it; return 200 duplicate.
   - If it is `RECEIVED` outside the lease, `FAILED`, or `DEAD_LETTER` under an explicit HR retry,
     claim it by advancing `attempts`, clearing `error`, setting `updated_at`, and committing.
4. Handle the stored payload through one dispatch function. Payout item events whose item cannot be
   matched become a retryable failure, not a silent no-op. Unknown event types become `IGNORED`.
5. Persist the outcome and commit before writing the action log. This avoids taking the action log's
   advisory lock while still holding the event row lock.

The conditional claim plus the primary key is safe if the same event arrives twice concurrently:
one transaction wins the insert or the row lock, the other sees a fresh `RECEIVED` row or a terminal
row and stops. The existing `FOR UPDATE` locks in `apply_item_update` and `mark_recovered` remain the
second line of defence, so even a lease-expired double processing cannot move a final status
backwards or notify twice.

### 4.3 Replay and failure semantics

| Existing row | Freshness | Behaviour | HTTP |
| --- | --- | --- | --- |
| none | - | insert, handle | 200 handled, 500 failed |
| `PROCESSED` / `IGNORED` | any | duplicate, no work | 200 |
| `RECEIVED` | inside lease | duplicate, assume in flight | 200 |
| `RECEIVED` | lease expired | reclaim and handle | 200 / 500 |
| `FAILED` | any | reclaim and handle | 200 / 500 |
| `DEAD_LETTER` | automatic delivery | duplicate, no work | 200 |
| `DEAD_LETTER` | HR retry | claim with a fresh attempt budget | 200 with outcome |

- A handler error sets `FAILED`, stores the error, and returns 500 so PayPal retries. The sweep also
  retries it.
- After `WEBHOOK_MAX_ATTEMPTS` (default 5) failures, the row becomes `DEAD_LETTER` and the endpoint
  returns 200. This tells PayPal to stop retrying; the event is now HR's responsibility.
- A manual HR retry resets the attempt budget. If it fails, the row goes back to `DEAD_LETTER` rather
  than `FAILED`, so the automatic sweep does not hammer it.
- Only dead-lettering and manual retries write to the action log (`WEBHOOK_DEAD_LETTER`,
  `WEBHOOK_RETRY`). Intermediate failures are application logs, not hash-chain entries, or the chain
  would fill with retry noise.
- `mark_recovered` currently cannot distinguish "unknown invoice" from "already recovered". Invoice
  events are therefore treated as handled no-ops; only unmatched payout items are retryable. This is
  an accepted limitation, not a hidden guarantee.

### 4.4 Maintenance job

One module owns the job and exposes pure entry points for tests:

- `refresh_stuck_payouts(db, now, refresh=refresh_payout, limit=200)`: selects `PAYPAL` payouts in
  `ACCEPTED` or `REQUESTED` whose `updated_at` is null or older than `PAYOUT_STUCK_HOURS` (default
  24), oldest first. It skips final statuses, rows with no batch ID, and `DEMOSEED-` / `MOCKB-`
  batches. In mock mode it refreshes nothing and returns `mock = true`. Each row is refreshed
  independently; a PayPal error is counted and does not abort the run.
- `retry_webhook_events(db, now, limit=100)`: claims `FAILED` rows and `RECEIVED` rows past their
  lease, handles them through the same dispatch function, and dead-letters at the attempt cap.
- `run_maintenance(db=None, now=None, limit=...)`: acquires `pg_try_advisory_lock(724243)`, runs the
  webhook sweep then the payout sweep, releases the lock, and returns a report. If the lock is held,
  it returns `locked = true` without doing work. The scheduled run uses a batch of 200; the manual
  endpoint uses a smaller batch so an HR request stays bounded.
- `maintenance_loop()`: sleeps `MAINTENANCE_INITIAL_DELAY_SECONDS` (60) so test lifespans that use
  `TestClient` never run it, then calls `run_maintenance` every
  `MAINTENANCE_INTERVAL_SECONDS` (3600), catching and logging all exceptions. The lifespan creates
  the task and cancels it on shutdown.

**Why an hourly tick instead of a literal 24-hour timer:** the payout query only selects payouts
that have not been touched for 24 hours, and every successful `apply_item_update` sets
`updated_at`, so each stale payout is refreshed at most once per 24 hours. The hourly tick exists so
crashed webhook rows and failed handlers are retried within an hour rather than a day. This meets
the daily requirement while bounding DLQ latency. If an operator wants a strict daily tick, set
`MAINTENANCE_INTERVAL_SECONDS=86400`.

**Why no scheduler dependency:** `render.yaml` has no cron service, the app already does startup work
in `lifespan`, and this is one idempotent sweep. A Postgres advisory lock makes overlapping workers
and restarts safe. The HR manual trigger covers demos and can be pressed after a fix without waiting
for the next tick. If the job grows beyond a single sweep, move it to a Render cron/worker then.

### 4.5 API surface

All new endpoints are HR-only (`get_current_hr_user`) unless stated otherwise.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/v1/paypal/events?status=DEAD_LETTER&limit=50` | List events, default dead letters; no payload in the response |
| `POST` | `/api/v1/paypal/events/{event_id}/retry` | Retry one failed/dead-lettered event from its stored payload |
| `GET` | `/api/v1/payouts/stuck` | Read-only list of non-final payouts idle for more than 24h |
| `POST` | `/api/v1/payouts/maintenance/run` | Run both sweeps now and return the report; 409 if another run holds the lock |

Retry endpoint rules: 404 for an unknown event, 409 for `PROCESSED`, `IGNORED`, or a fresh
`RECEIVED`, and 200 with the resulting row for a handled or failed retry. The stored payload was
verified at intake; it is not re-verified on retry because the original transmission headers are not
kept. Only HR can trigger it, and mock mode is demo-only.

The stuck list and maintenance routes must be declared before `GET /payouts/{reim_id}` so the path
parameter does not capture them, as the existing `reconcile` and `funding` routes already do.

### 4.6 Configuration and enums

New settings with safe defaults, so no env change is required to deploy:

- `PAYOUT_STUCK_HOURS = 24`
- `WEBHOOK_MAX_ATTEMPTS = 5`
- `WEBHOOK_LEASE_MINUTES = 15`
- `MAINTENANCE_INTERVAL_SECONDS = 3600`
- `MAINTENANCE_JOB_ENABLED = true`

New `WebhookEventStatus` enum: `RECEIVED`, `PROCESSED`, `IGNORED`, `FAILED`, `DEAD_LETTER`.
New `AgentActionType` values: `WEBHOOK_DEAD_LETTER`, `WEBHOOK_RETRY`. The action log column is a
string, so no enum migration is needed.

## 5. Schema and migration

- One model addition in `core/models.py` and one migration for the event table. `down_revision` is
  the current head `2a7c9e1d4b80`. A second migration in the DLQ ticket adds `attempts`.
- Fresh databases still bootstrap from models and stamp head. Existing databases apply the migration
  through `init_db()` on startup or `alembic upgrade head` manually.
- No changes to `Payout`, `Reimbursement`, `Recovery`, or `AgentAction` columns.
- Downgrade drops the event table; there is no data backfill because no historical event IDs exist.

## 6. Acceptance criteria

1. A signature-verified event with an ID is stored exactly once with its type, resource ID, and
   payload.
2. A duplicate delivery of a terminal event returns 2xx, writes no new row, and runs no domain
   handler.
3. Two concurrent deliveries of the same ID produce one row and one handler run.
4. Invalid JSON, a non-object body, a missing ID, and a failed signature all return 4xx and write no
   event row.
5. A handler exception writes `FAILED` with the error and returns 500; a later delivery retries it.
6. After the attempt cap the event becomes `DEAD_LETTER`, returns 200 to PayPal, and is visible to
   HR; HR can retry it, and a successful retry becomes `PROCESSED`.
7. Unknown event types are stored as `IGNORED` and return 200.
8. The maintenance sweep selects only `PAYPAL` payouts in `ACCEPTED` or `REQUESTED` that are older
   than 24h, refreshes each once, continues after per-row PayPal errors, and never re-sends money.
9. Mock and seeded batch IDs are skipped; mock mode reports `mock = true` and refreshes nothing.
10. The startup loop runs the sweeps after the initial delay, an advisory lock prevents overlapping
    runs across workers, and shutdown cancels the task.
11. `GET /payouts/stuck` and `POST /payouts/maintenance/run` are HR-only and are not captured by the
    `/{reim_id}` route.
12. All existing backend tests pass; new Postgres-backed tests cover duplicate, concurrent, failure,
    dead-letter, retry, sweep, and lock behaviour. Frontend `tsc` and Vitest still pass.
13. `decide()`, AI code, employee API response stripping, and the payout state machine are untouched.

## 7. Risks

- **Retry storms.** PayPal redelivery plus the hourly sweep can exhaust the attempt cap quickly
  during an outage. The cap is configurable, and dead-lettered rows stay retryable by HR.
- **`updated_at` doubles as "last status write".** The sweep treats a recent no-op refresh as fresh,
  which is correct for staleness but means a claim view can postpone the next sweep. No new column is
  worth it for this volume.
- **Payload retention.** The ledger stores verified PayPal payloads. They are low-PII but retained
  indefinitely in this plan. A retention job is out of scope.
- **Startup loop in the web process.** A large sweep can briefly compete with request handling. The
  batch limit and advisory lock bound it; a separate worker is the next step if volume grows.
- **Mock mode is not authentication.** Mock mode accepts unverified events by design; it must never
  be enabled in production.
- **Migration race with G4.** Another branch may add a migration at the same head. Rebase and chain
  the down_revision before merging.
- **CI skips Postgres tests.** The duplicate, lock, and migration tests only run locally or in a
  job with `TEST_DATABASE_URL`. Run them before merging.
- **Ignored events are not replayed after a code change.** An event type stored as `IGNORED` stays
  ignored even if a later release starts handling it. Only verified, failed events are retryable.
- **HR page collision.** G2 already touched the Payouts page. The UI ticket adds one tab and keeps
  changes local to a new component and its server action.

## 8. Out of scope

- Automatic payout re-send, refund, cancellation, or recovery for stuck payouts.
- Changing `decide()`, autonomy limits, risk scoring, or any AI prompt.
- Live PayPal account approval, credentials, or webhook reconfiguration.
- G4 reconciliation, its daily schedule, and its mismatch alerts.
- A generic job scheduler, Celery/Redis, or an external queue.
- Event ledger retention, archival, redaction, or PII purge.
- Email or push alerts for dead letters and stuck payouts beyond the HR tab and application logs.
- A webhook rate limit or IP allowlist. Signature verification remains the gate.
- Backfilling old webhook events; none were stored.
- Multi-company isolation.

## 9. Ticket breakdown

| # | Ticket | Blocked by |
| --- | --- | --- |
| 01 | Replay-safe webhook intake | None |
| 02 | Dead-letter queue and HR retry | 01 |
| 03 | Maintenance job and stuck payouts | 02 |
| 04 | HR webhook health tab | 02, 03 |

Ticket 01 is the foundation: the unique ledger and the claim protocol. Ticket 02 adds the attempt cap,
the dead-letter state, and the operator API. Ticket 03 schedules the existing and new sweeps. Ticket
04 is the operator surface that makes the queue usable without `curl`.

## 10. Verification

```bash
# Backend, including the Postgres-backed tests that CI skips.
(cd backend && TEST_DATABASE_URL=postgresql://admin:password@localhost:5432/reclaim_g3 \
  SECRET_KEY=test-secret-not-default uv run pytest -q)

# Migration on the scratch database.
(cd backend && DATABASE_URL=postgresql://admin:password@localhost:5432/reclaim_g3 \
  SECRET_KEY=test-secret-not-default uv run alembic upgrade head)

# Frontend.
(cd frontend && npx tsc --noEmit && npm test)
```

Manual demo, with `PAYPAL_MOCK_MODE=true`:

1. POST the same webhook body twice; both return 2xx and the second is a duplicate. The ledger has
   one row and the payout notification appears once.
2. POST an item event for an unknown payout five times; the row walks `FAILED` to `DEAD_LETTER`.
3. `GET /api/v1/paypal/events?status=DEAD_LETTER` shows it; `POST .../retry` with a now-known payout
   moves it to `PROCESSED`.
4. `GET /api/v1/payouts/stuck` lists an old non-final payout; `POST /api/v1/payouts/maintenance/run`
   returns a report and the payout's status reflects PayPal's answer.
5. Restart the API; the loop starts after 60 seconds, the advisory lock prevents a second worker from
   running at the same time, and shutdown cancels the task.
