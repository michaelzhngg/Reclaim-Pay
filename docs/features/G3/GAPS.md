# G3 Gaps

Known limitations after the G3 implementation. None of these blocks the webhook hardening, but they
should be visible before this runs against a live account.

## 1. Payload retention and PII

`paypal_webhook_events.payload` keeps every verified event indefinitely. PayPal payout item payloads
are relatively small and low-PII, but they are still business records. There is no retention window,
archive, redaction, or purge job. Add one before the table grows for a year.

## 2. Startup loop contention

The maintenance loop runs inside the API web process. A large sweep briefly shares the event loop and
the database pool with requests. The advisory lock stops duplicate runs across workers, and the batch
limit bounds each run, but a separate worker or Render cron is the cleaner long-term home. If the
process never stays up for 60 seconds, the job never runs; an external scheduler would be needed for
that deployment shape.

## 3. Mock mode is not authentication

`PAYPAL_MOCK_MODE=true` accepts every webhook without a signature. That is deliberate for demos and
tests, not a production mode. Mock PayPal batches also live in memory, so old `MOCKB-` payouts cannot
be refreshed after a restart. The sweep skips them instead of reporting a false PayPal failure.

## 4. Migration rebase

The branch is based on `2a7c9e1d4b80` and adds `b3f7a1c9d2e4` and `c4d8e2f1a6b9`. The branch will be
rebased later. If another branch adds a migration at the same head, re-chain the down revisions
rather than editing the other branch's migration. The test database must be migrated to
`c4d8e2f1a6b9` before the Postgres-backed tests run.

## 5. CI skips the database tests

CI runs pytest without `TEST_DATABASE_URL`, so the duplicate, concurrency, lock, and migration tests
skip there. Locally, the full suite also needs `DATABASE_URL` pointed at the same scratch database
because background push and notification paths use the global engine, not the test session. The
commands in the plan show both variables.

## 6. Unknown invoice events are not dead-lettered

`mark_recovered` cannot distinguish an unknown invoice from an already-recovered one, so an
`INVOICING.INVOICE.PAID` event with no matching recovery is stored as processed. Payout item events
that match no payout are retryable and can dead-letter. Fixing the invoice case needs a small return
contract change in the recovery service.

## 7. A no-op status refresh postpones the sweep

`apply_item_update` sets `updated_at` even when the status does not change. A claim view therefore
counts as a fresh check, and the daily sweep waits another 24 hours. That is correct for "the status
was checked recently", but it is not a measure of how long the payout has been pending. A dedicated
`last_checked_at` column would separate the two if that distinction matters.

## 8. No alerting for dead letters or stuck payouts

HR sees the new tab and the action log. There is no email or push alert when an event dead-letters or
when a payout stays non-final for days. The funding alert has a dedupe pattern that could be reused,
but it was not added here.

## 9. No webhook rate limit or IP allowlist

The webhook endpoint is unauthenticated by design. Live mode relies on PayPal signature verification;
mock mode accepts anything. Rate limiting webhooks is awkward because a 429 causes PayPal retries,
so it was left out. A proxy-level allowlist is the better place if abuse becomes a concern.

## 10. Event ledger growth

There is no partition or cleanup for `paypal_webhook_events`. Webhook volume is low, but at scale the
status and updated_at indexes will grow with the table. Pair a retention job with the PII decision.

## 11. Batch limits

A run checks at most 200 payouts and 100 webhook events; the manual endpoint uses 50 payouts. More
stale work is picked up on the next tick. This is deliberate backpressure, not a loss of work.
