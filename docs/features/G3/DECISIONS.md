# G3 Decisions

Non-obvious choices made while implementing G3, with the alternative that was rejected.

## 1. The dead-letter queue is a status, not a second table

**Chosen:** a verified event is stored once in `paypal_webhook_events`. `DEAD_LETTER` is a status on
that row.

**Rejected:** a separate `dead_letter` table. It would copy the payload, split the lifecycle across
two writes, and make the duplicate fence harder to reason about. One row with one status is smaller
and keeps replay and retry on the same record.

## 2. Verify before claim

**Chosen:** parse, require an event ID, verify the signature, then write the ledger row.

**Rejected:** deduplicating before verification to save a PayPal call. An unauthenticated caller
could then fill the ledger with IDs and suppress later real deliveries. Replay protection is applied
only to authentic events.

## 3. Unique insert first, row lock on conflict

**Chosen:** insert the first delivery with the event ID as primary key. On a unique conflict, load
the existing row with `FOR UPDATE` and decide duplicate, in-flight, or retryable.

**Rejected:** an application-level "check then insert" or an in-memory cache. Both race under two
workers. The primary key is the fence; the row lock serialises retries of the same row.

## 4. Fail with 500 until the cap, then acknowledge

**Chosen:** handler failures below the cap persist `FAILED` and return 500 so PayPal retries.
At the cap the event becomes `DEAD_LETTER` and returns 200 so PayPal stops.

**Rejected:** always returning 200 and relying only on our sweep. That hides failures from PayPal
and slows recovery during a transient outage. Always returning 500 leaves PayPal retrying a
permanent failure and risks the webhook being disabled.

## 5. Manual retry resets the attempt budget and failure returns to dead letter

**Chosen:** an HR retry sets `attempts = 1`; a failed manual retry stays `DEAD_LETTER` and does not
re-enter the automatic sweep.

**Rejected:** incrementing the old attempt count on manual retry, or letting a failed manual retry
become `FAILED`. HR is acting after a fix; the operator should get a fresh try, and a failed manual
attempt should not cause an hourly loop the operator did not ask for.

## 6. Hourly tick with a 24-hour per-payout threshold

**Chosen:** the startup loop runs hourly. The payout query only selects rows untouched for
`PAYOUT_STUCK_HOURS` (24), so each payout is refreshed at most daily, while failed webhooks recover
within an hour.

**Rejected:** a literal 24-hour sleep. It would make a crashed webhook wait up to a day. An external
scheduler was also rejected: `render.yaml` has no cron, and this is one idempotent sweep.

## 7. `updated_at` is the staleness signal

**Chosen:** the sweep uses `Payout.updated_at`, which every successful status write refreshes.

**Rejected:** adding a separate `last_status_check_at` column. The current field already means "last
time the status was written", which is the staleness this job cares about. A no-op refresh counts as
fresh, so a claim view can postpone the next sweep by a day; that is acceptable at this volume.

## 8. Skip demo and mock batches

**Chosen:** the sweep leaves `DEMOSEED-` and `MOCKB-` batches alone and refreshes nothing in mock
mode.

**Rejected:** calling PayPal for them. Mock batches live in an in-memory client and disappear on
restart, so a refresh would only produce a false 404. Seeded batches were never at PayPal.

## 9. Advisory lock instead of a queue worker

**Chosen:** `pg_try_advisory_lock(724243)` around the run. A second process returns a locked report;
the HR endpoint maps that to 409.

**Rejected:** a new Celery/Redis worker or a database job table. The lock is one line, works across
restarts, and releases when the connection closes.

## 10. Sixty-second initial delay in the lifespan

**Chosen:** the background task sleeps 60 seconds before its first tick.

**Rejected:** running immediately on startup. Short-lived test lifespans and deploy health checks do
not need the job running before the app is serving; the delay also keeps the test suite quiet.

## 11. HR retry trusts the stored payload

**Chosen:** retry uses the payload that was verified at intake. The original transmission headers are
not stored, so the signature is not checked again.

**Rejected:** re-verifying on retry, which is impossible without those headers, or storing them just
for this path. The retry is HR-only, rate-limited, and the payload cannot be edited by employees.

## 12. The HR tab never shows the payload

**Chosen:** the list API and the tab expose event type, resource, status, attempts, error, and age.
The payload stays on the server.

**Rejected:** an expandable raw JSON view. It adds PII exposure and support surface without helping
the retry decision.

## 13. Unknown invoice events are treated as handled

**Chosen:** `INVOICING.INVOICE.PAID` remains a processed no-op when `mark_recovered` cannot find a
matching recovery. Only unmatched payout item events are retryable.

**Rejected:** changing `mark_recovered` to report "unknown" versus "already recovered" in this
ticket. That is a separate recovery-service change; the current behaviour is documented as a gap.
