# G4 decisions

One entry per non-obvious choice. Each names the alternative that was rejected and why.

## D1: Store differences as keyed rows, not JSONB on the run

**Chosen:** a `reconciliation_differences` row per missing payout or unknown PayPal payment, with first/last seen, resolution and resolver.

**Rejected:** a JSONB snapshot of the summary on each run.

**Why:** the comparison is a rolling window. A JSONB snapshot would make an unresolved payout vanish from view as soon as it left the window, and there would be no stable subject to reopen, close or dismiss. The row is the smallest thing that gives a difference a lifecycle.

## D2: Snapshot the employee name and amount on the difference

**Chosen:** copy `employee_name`, `amount` and `currency` when the difference opens or is seen again.

**Rejected:** join the payout and employee at read time.

**Why:** the row is an audit record of what the run reported. A renamed employee or a later payout edit should not rewrite the history. It also keeps the HR history read to two tables.

## D3: The live badge does not write run history

**Chosen:** only the manual run endpoint and the scheduled CLI record `reconciliation_runs`.

**Rejected:** persist every `GET /payouts/reconcile` call.

**Why:** every Payouts page load would write a run and pollute the history with duplicates. A page load is a live check; a recorded run is a bookkeeping event with a trigger and, for manual runs, an actor.

## D4: A daily job looks back three days, not one

**Chosen:** `days=3`.

**Rejected:** `days=1`, matching the badge's default.

**Why:** PayPal may take three hours to list a transaction, and a single failed or delayed daily run with a one-day window would skip a payout permanently. Three days gives each payout at least two daily looks. The cost is overlapping runs and a wider search, not extra match logic.

## D5: Failed runs are records too

**Chosen:** write a `failed` run row when an unexpected exception stops the comparison, then re-raise it.

**Rejected:** log the exception and leave no row.

**Why:** the history must show a gap. A missing run and a clean run would otherwise look the same to HR. The error column stores the exception class name only, never a traceback or PayPal payload.

## D6: No action-log entry for every run

**Chosen:** the reconciliation run table is the audit record.

**Rejected:** append `RECONCILE_RUN` rows to the hash-chained agent action log.

**Why:** the action log is for agent and HR actions. A daily system row would add noise and a write lock to every run without answering a question the run table cannot.

## D7: One open row per subject, enforced in the database

**Chosen:** partial unique indexes on open `payout_id` and open `transaction_id`, plus an advisory lock around the write transaction.

**Rejected:** check-then-insert in application code only.

**Why:** the cron and a manual "Check now" can overlap. The index and lock make the invariant true even if both runs reach the same subject.
