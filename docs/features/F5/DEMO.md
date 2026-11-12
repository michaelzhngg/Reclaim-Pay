# F5 contractor currency demo

The walkthrough for ticket 08. It exercises one batch approval that pays two currencies
and refuses a third claim before PayPal. Mock PayPal only.

## Setup

```bash
cd backend
DATABASE_URL=postgresql://admin:password@localhost:5432/smart_reimburse \
  uv run python -m seeds.seed_reclaim_pay --reset-demo
```

Start the stack with the per-currency mock balances on the **API** process, not just the
seed shell:

```bash
PAYPAL_MOCK_BALANCES='{"MYR": "25000", "USD": "4000"}' docker compose up --build -d
```

The seed sets payout settings to account country MY and held currencies `MYR`, `USD`. It
also creates the two contractor contracts and prints the five row refs. All seeded rows
carry `ai_reasoning.demo_seed = reclaim-pay-contractor-demo-v1`, so `--reset-demo`
removes and recreates them without touching contracts or settings.

## Accounts

| Login | Role | Contract |
|---|---|---|
| `c01@seed.reclaim.my` | Contractor | IDR, country ID |
| `c02@seed.reclaim.my` | Contractor | MYR, country ID (refusal) |
| `contractor-demo@seed.reclaim.my` | Employee | none (MYR group) |
| `hr@example.com` | HR | approver |

Every demo account uses the password `password`.

## Seeded rows

All five start in `REVIEW` at `HR_QUICK`:

| Row | Claim | Payout |
|---|---|---|
| C01 clean | USD 120 | IDR 1,920,000 |
| C03 clean | MYR 120 | MYR 120 |
| C02 refusal | MYR 80 | refused, `MYR_PAYEE_NOT_MALAYSIAN` |
| C01 contract check | USD 60, category Software | skipped by batch approval |
| C01 invoice | IDR 750,000, 1 day at the contract rate | IDR 750,000 |

## Walkthrough

1. Sign in as HR and open the triage queue, Quick approve tab.
2. Tick the two clean claims and the refusal claim. The contract-check row is listed as
   excluded with "contract check needs review".
3. Approve and pay. The approvals commit first, then one payout call splits the set by
   payout currency. The invoice stays in the queue unless you tick it too.
4. Open the payouts ledger. Each claim has its own row and batch ID:
   - the IDR row is one batch,
   - the MYR row is a second batch,
   - the refusal has a failed row with no batch ID and the claim stays approved.
5. Open the refusal claim. It is approved and unpaid, with the HR-only refusal reason.
6. Retry the refused claim after fixing the contract or funding setup. The retry uses the
   existing single-claim payout action; a failed group is not retried as a batch.

## Notes

- Mock PayPal accepts every batch and ignores the 30-character sender key cap. A live
  sandbox run must re-check keys before paying.
- If `PAYPAL_MOCK_BALANCES` is unset, mock mode falls back to one balance and the IDR
  group is funded from that single balance. Set the JSON above to show per-currency
  funding.
- The contract-check row is a hand-placed demo row. Real intake routes a blocked category
  to `DUAL_REVIEW`; this row keeps `HR_QUICK` so the batch exclusion is visible in the
  Quick tab.
