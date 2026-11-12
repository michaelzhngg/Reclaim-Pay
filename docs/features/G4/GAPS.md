# G4 known gaps

## The cron depends on the Blueprint branch

`render.yaml` now defines `reclaim-pay-reconcile`, a cron service at 02:00 UTC that runs
`python -m jobs.daily_reconcile`. Verify that the Blueprint's tracked branch includes this file:
it may still track `deploy/render` rather than `main`. If the cron does not deploy, the
Reconciliation tab's 36-hour stale warning is the only signal. Record the deployed cron state here
after checking the dashboard.

## Sandbox Transaction Search needs the reporting scope

The production sandbox app must have "Transaction search" enabled and its credentials regenerated,
or every run records `unavailable`. This is the existing PP-7 sandbox limitation. It is safe: the
run is recorded, differences are untouched, and HR gets one outage warning per outage.

## Push from the cron may be a no-op

The web service owns the VAPID key file. The cron container has no disk and may not have
`VAPID_PRIVATE_KEY`; in that case `notify()` still writes the in-app notification but web push
fails softly. In-app notifications are the authoritative channel.

## Verification environment notes

- Set both `DATABASE_URL` and `TEST_DATABASE_URL` to the scratch database for the full backend
  suite. `push_service` uses the global engine, not the test session, so notification-heavy tests
  otherwise fail against the empty default database. This is pre-existing test isolation, not G4.
- `tests/test_paypal_signin.py::test_unknown_payer_gets_a_plain_failure` fails on `ce1469f` too.
  The action payload carries extra PayPal flags the test does not expect. It is pre-existing and
  untouched by G4.
