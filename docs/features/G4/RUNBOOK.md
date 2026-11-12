# G4 runbook

## Daily check

- Render cron `reclaim-pay-reconcile` runs `python -m jobs.daily_reconcile` at 02:00 UTC.
- Local: `docker compose exec backend python -m jobs.daily_reconcile`.
- HR can run the same check from Payouts > Reconciliation > Check now.

The job exits 0 for `ok`, `no_data` and `unavailable`. A non-zero exit means the job itself
failed, which is what the platform should alert on.

## After a deploy

1. Confirm the cron service exists and the Blueprint tracks the branch it was added to.
2. Run Check now and confirm the Reconciliation tab shows a new run.
3. If every run is `unavailable`, enable Transaction search on the PayPal app, regenerate the
   sandbox credentials and restart the API.
4. Confirm an active HR user receives the notification for a new difference.

## Demo

After `python -m seeds.seed_reclaim_pay`:

```bash
(cd backend && python -m seeds.seed_reconciliation_demo)
```

This records one `demo` run with one missing-in-PayPal difference for the newest seeded payout
and sends the same HR notification a real difference would send. It changes no payout, claim or
recovery.

Open Payouts > Reconciliation to see the difference and the notification in the bell. To reset:

```bash
(cd backend && python -m seeds.seed_reconciliation_demo --clear)
```

`--clear` removes only the runs with the `demo` trigger and the differences they opened. Notifications
stay in the bell until read. Run the seed twice and the second run updates the same open difference
without sending a second notification.
