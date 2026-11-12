# Reclaim Pay — Handoff for the next Claude Code session

**Written:** Wed 4 Nov 2026, evening, by the Claude Code session on Michael's laptop. Its usage ran out.
**For:** whoever picks this up (a teammate's Claude Code). Read this file first, then [`PLAN.md`](PLAN.md) for the checklist.

**Deadlines:**
- **Code freeze:** Thu 5 Nov 12:00.
- **Recording:** Thursday afternoon.
- **Submit:** by Wed 11 Nov.
- **Devpost deadline:** 12 Nov.

---

## 0. Latest progress (Wed 4 Nov, evening)

- Merged since this file was written: `main` (homeserver deploy), and `feat/reconcile-channel3` (Server SDK reconciliation, Channel3 check, off without a key).
- **Staging is live at https://reclaimai.dev but runs older code.** It deploys from `main`. Open PR #9 (`hackathon/reclaim-pay` -> `main`) deploys this branch. Ask the user before merging it.
- **Not merged yet, may still be in progress on local branches or worktrees:** `feat/hr-payouts-tabs`, `feat/signin-paypal`, `feat/bryntum-calendar`, `feat/postman-polish`. Check each under `.claude/worktrees/`, run the tests, then merge with `--no-ff`.
- **After those:** write the Devpost write-up and the README as a business pitch for judges who won't read code. Don't claim anything works live until it has been tested. The video waits for the user's call.

## 1. Where things stand

- **Integration branch:** `hackathon/reclaim-pay`, pushed to `origin` (github.com/michaelzhngg/Reclaim-Pay). Every feature branch so far has been merged into it.
- **Tests:**
  - Backend: 308 pass, with `TEST_DATABASE_URL` (see §4).
  - Frontend: 127 pass.
  - Type check is clean.

**Built and merged:**
- PayPal Payouts client, mock mode, webhooks, Log in with PayPal (72-hour pause), payouts ledger.
- Risk engine `decide()`, trust tiers, circuit breaker, audit sampling.
- Receipt Shield: injection, arithmetic, split/near-threshold, edits, duplicate fingerprints, C2PA marker.
- The engine wired into the real claim pipeline, plus live timeline events (employee-safe) and auto-pay.
- Autonomy API: settings, kill switch, status, hash-chained action log, back-test, `/autonomy/me` trust.
- Approvals: two-person review, no self-approval, batch approve. Employee privacy: no risk score, no signal text, DUAL_REVIEW shown as HR_REVIEW.
- Overpayment recovery API: notice, 120 h dispute, offset or PayPal invoice after HR preview, waive.
- HR frontend: triage queue (AG Grid), evidence panel, Autonomy page (AG Charts back-test, kill switch), banner, payout reasons.
- Employee frontend: Connect PayPal, money flow, timeline, PayPal chip, fast-track (trust) card, overpayment notice with dispute.
- Landing page rebrand, UX QA fixes (see [`UX-QA-REPORT.md`](UX-QA-REPORT.md)).
- Demo kit in `demo/`: policy PDF, S1–S8 receipts, flood script, S8 script, and a 120-claim seed.

PLAN.md §4 is ticked up to date. Unticked rows are the remaining work.

---

## 2. Blockers (do these first)

1. **The LLM keys in the local `.env` are placeholders.** (Update: ILMU is no longer used. The code now defaults to Gemini 3.6 Flash like the live site, so `LLM_API_KEY` must be a Gemini key.) `LLM_API_KEY` (ILMU) returned 401, and `OPENROUTER_API_KEY` returns "User not found". Until they're fixed, no AI step runs locally: receipt OCR, policy upload, compliance judgment.
   - Get the real keys from **Filbert**. Put them in `.env` yourself and never commit them.
   - Then restart the backend: `docker compose restart backend`.
2. **`SECRET_KEY` is also the public example value.** Staging must use a real, private one, or logins can be forged. Tell Filbert.
3. **The staging URL** (Filbert is deploying). It's needed for:
   - the PayPal sandbox app's Log in with PayPal **Return URLs**: `<URL>/api/v1/paypal/callback` and `<URL>/login/paypal/callback`;
   - the webhook: `<URL>/api/v1/paypal/webhook`;
   - `BACKEND_PUBLIC_URL`.
4. **Fresh-database migrations: fixed.** `alembic upgrade head` on an empty database now builds the schema from the models and stamps head (`backend/alembic/env.py`), because the chain itself starts from an old `create_all` schema. Databases that already have tables run the chain as before.
5. **S3 needs a real AI image** carrying C2PA credentials (OpenAI image generation or Adobe Firefly). The steps are in [`demo/README.md`](../../demo/README.md).

PayPal sandbox keys **are** already in the local `.env` and verified (token OK, `payouts` scope). `PAYPAL_MOCK_MODE` is still `true`.

---

## 3. What to do next, in order

1. **Live run with real LLM keys:**
   - Upload `demo/policy/reclaim-pay-demo-policy.pdf` in Policy Studio. Check that it extracted 4 categories, then deprecate the old `BTP-2024` sample policy.
   - Submit S1–S6 per `demo/README.md` and check each expected tier.
   - The checks the engine-wiring agent flagged:
     - **S1:** `visible_text` is present, the line items are 45 + 3, it ends in AUTO_PAY, and `payout.create` runs.
     - **S4:** the OCR copies the faint "SYSTEM:" line, so it lands in DUAL_REVIEW. If not, use `s4_injection_visible.jpg`.
     - **S3:** the LLM must not count "Subtotal" as a line item, which would cause a false arithmetic mismatch.
     - **S5:** score 55, with evidence linking to S1.
     - **S6b:** split and near-threshold signals fire, and S6a is `audit_selected`.
     - **Temperature 0:** check that Gemini 3.6 Flash and the Gemini 3.1 Flash Lite fallback accept it.
     - **Employee stream:** it never contains `warn` or HR text.
2. **First real sandbox payout:**
   - Set `PAYPAL_MOCK_MODE=false`.
   - Set `DEMO_PAYER_ID_1..3` to the sandbox personal accounts' payer IDs, then re-run the seed (`--reset-demo`).
   - Pay S1. Decide MYR or USD (PLAN §12, question 5).
   - A Malaysian sender can only send MYR to Malaysian accounts.
3. **Still unbuilt (PLAN.md, unticked):**
   - **HR Payouts tabs: audit queue, recoveries (invoice preview → send), agent log** (HR-4). The recovery API exists, but HR has no screen for it yet.
   - `PUT /autonomy/settings` should accept and log the save **reason**. The frontend already sends it, and the backend drops it.
   - Publish the Postman collection (`postman/`, run with `./postman/run-local.sh`), APIMatic clip, QA runs, video, Devpost write-up.
   - Optional (Could): Sign in with PayPal on the login page, Channel3 price check, Bryntum calendar, reconciliation.
4. **QA:** run DETAIL-PLAN §18.3 on staging, with S7 (the flood) last.

### Known gaps, deliberately left for after the hackathon
- Daily caps can be passed by two claims processed at the exact same moment.
- Two `/hr/view` and `/hr/review` pages still use some legacy layout.

---

## 4. How to work in this repo

**Run it:**
```bash
docker compose up -d
docker compose exec backend python -m seeds.seed_reclaim_pay
```
- The app is at http://localhost:3000.
- The seed creates the demo accounts and history. All demo passwords are `password`: `employee@example.com`, `employee2@example.com`, `hr@example.com`, `hr2@example.com`.
- Add `--reset-demo` to re-create the seeded data, and `--clear-takes` between video takes.
- On this Mac the Docker CLI is at `/Applications/Docker.app/Contents/Resources/bin`.
- After a `package.json` change, run `docker compose exec frontend npm install`, then revert any `package-lock.json` change it makes.

**Tests:**
```bash
cd backend && TEST_DATABASE_URL=postgresql://admin:password@localhost:5432/reclaim_autonomy_test uv run pytest -q
cd frontend && npx tsc --noEmit && npx vitest run
```
- `reclaim_autonomy_test` is a scratch database inside the `reclaim_db` container. Without `TEST_DATABASE_URL`, the DB tests are skipped.
- Ignore type errors under `frontend/.next/`. They are stale dev types.

**Rules the team agreed on:**
- **Never add `Co-Authored-By` or any AI attribution** to commits or PRs.
- **Load the antislop skills** (`/antislop`, plus `-code`, `-ui`, `-copywriting`, `-human`, `-layoutmobile` as relevant) for all code and copy. Every subagent prompt must say so. No em dashes in UI copy.
- **Work on feature branches off `hackathon/reclaim-pay`,** merge with `git merge --no-ff`, and run all tests before merging.
- **Worktree agents start from the wrong base.** They begin on `origin/main` (47e0c60), which is old. Always tell them to run `git checkout -B <branch> hackathon/reclaim-pay` first.
- **Don't push without the user's OK.** Don't touch `main` or reclaimai.dev until submission.
- **Never put secrets in git, chat, screenshots or Postman exports.**
- **Product rules:**
  - The AI never starts a payment by itself, and never rejects a claim by itself.
  - Employees never see risk scores, signal names or which check fired.
  - Every automatic decision has an explanation, which is HR-only.

**Where things are:**

| Area | Path |
|---|---|
| Decision engine and shield | `backend/engine/risk/` (`autonomy.py`, `shield/`, `queries.py`, `timeline.py`) |
| Pipeline wiring | `backend/engine/agents/compliance_agent.py`, `backend/api/reimbursements.py` |
| PayPal | `backend/engine/services/{paypal_client,payout_service,payout_status,paypal_invoicing}.py`, `backend/api/{paypal,payouts}.py` |
| Autonomy, back-test, trust | `backend/api/autonomy.py`, `backend/engine/services/{autonomy_store,backtest_service,action_log,approvals}.py` |
| Recovery | `backend/api/recoveries.py`, `backend/engine/services/recovery_service.py` |
| Seed | `backend/seeds/seed_reclaim_pay.py` |
| HR UI | `frontend/app/hr/` (`dashboard`, `review/[id]`, `autonomy`, `payouts`), `frontend/components/hr-grid/` |
| Employee UI | `frontend/app/employee/` (`dashboard`, `claims`, `settings`), `frontend/components/timeline/` |
| Shared types and formats | `frontend/lib/api/reclaim-pay-types.ts`, `frontend/lib/format.ts` |
| Specs | `docs/hackathon/DETAIL-PLAN.md` (API contracts §9, timeline §10, screens §12, copy §13, QA §18) |
