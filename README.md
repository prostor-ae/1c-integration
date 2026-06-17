# 1c-integration

Next.js service that syncs the Prostor 1C catalog into Shopify. Two surfaces drive the same shared `runSync({ modes })` core:

- **Daily cron** at `/api/cron/daily-sync` — runs `stock + prices` only.
- **Manual trigger** at `/api/sync/trigger` — accepts any combination of `stock`, `prices`, `costs`.

`costs` is intentionally manual-only and excluded from the cron.

## Getting started

```bash
npm install
npm run dev
```

## Secrets

All secrets live in **Vercel project environment variables** (per environment: production, preview, development). `.env.local` is git-ignored (`.gitignore` line for `.env*.local`) and verified on 2026-05-05 not to appear in any historical commit (`git log --all --full-history -- .env.local` returns nothing). Secrets must never be committed.

Rotation is **manual**: rotate the value in the Vercel UI for the affected environment, then trigger a redeploy so the new value reaches the running functions.

| Env var                             | Where it lives                   | Rotation procedure                                                 |
| ----------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `SHOPIFY_STORE_DOMAIN`              | Vercel project envs (per env)    | Rotate in Vercel UI, redeploy                                      |
| `SHOPIFY_ADMIN_TOKEN`               | Vercel project envs (per env)    | Rotate in Shopify admin, update in Vercel UI, redeploy             |
| `SHOPIFY_TARGET`                    | Vercel project envs (per env)    | Set to `test` or `production`; redeploy after changing             |
| `SHOPIFY_FORCE_TEST`                | Legacy Vercel project env        | Optional legacy boolean. Prefer `SHOPIFY_TARGET`                   |
| `SHOPIFY_WEBHOOK_SECRET`            | Vercel project envs (per env)    | Legacy/default Shopify app API secret key for webhook HMAC         |
| `SHOPIFY_WEBHOOK_SECRET_TEST`       | Vercel project envs (per env)    | Test Shopify app API secret key for webhook HMAC                   |
| `SHOPIFY_WEBHOOK_SECRET_PRODUCTION` | Vercel project envs (per env)    | Production Shopify app API secret key for webhook HMAC             |
| `SHOPIFY_STORE_DOMAIN_TEST`         | Vercel project envs (per env)    | Rotate in Vercel UI, redeploy                                      |
| `SHOPIFY_ADMIN_TOKEN_TEST`          | Vercel project envs (per env)    | Rotate in Shopify admin (test shop), update in Vercel UI, redeploy |
| `INTERNAL_API_KEY`                  | Vercel project envs (per env)    | Rotate in Vercel UI, redeploy, update any caller                   |
| `ONE_C_USERNAME`                    | Vercel project envs (per env)    | Rotate in 1C, update in Vercel UI, redeploy                        |
| `ONE_C_PASSWORD`                    | Vercel project envs (per env)    | Rotate in 1C, update in Vercel UI, redeploy                        |
| `ONE_C_PRICES_URL`                  | Vercel project envs (per env)    | Update in Vercel UI, redeploy                                      |
| `ONE_C_DISCOUNTS_URL`               | Vercel project envs (per env)    | Update in Vercel UI, redeploy                                      |
| `ONE_C_STOCK_URL`                   | Vercel project envs (per env)    | Update in Vercel UI, redeploy                                      |
| `ONE_C_URL_1`                       | Vercel project envs (per env)    | Update in Vercel UI, redeploy                                      |
| `ONE_C_URL_2`                       | Vercel project envs (per env)    | Update in Vercel UI, redeploy                                      |
| `RESEND_API_KEY`                    | Vercel project envs (per env)    | Rotate in Resend dashboard, update in Vercel UI, redeploy          |
| `CRON_SECRET`                       | Vercel project envs (production) | Rotate in Vercel UI, redeploy                                      |
| `API_VERSION` (optional)            | Vercel project envs (per env)    | Update in Vercel UI, redeploy. Defaults to `2024-07` if unset.     |

Alert emails are hardcoded in `src/app/lib/alerts.ts` to send from `notification@morlavi92.uk` to `chepiga.lev@gmail.com`; no `ALERT_FROM` or `ALERT_RECIPIENTS` environment variables are required.

The `/api/webhooks/1c` product-status webhook also sends a best-effort alert when a valid 1C payload contains barcodes that are not found in Shopify. The webhook still succeeds for matched products, skips unknown barcodes as before, and sends one aggregated email per request rather than one email per barcode. If Resend is unavailable, the alert failure is logged and the webhook response is not failed by email delivery.

## Pre-flight

Before the **first prod sync**, audit the Shopify catalog for blank or duplicate barcodes. Barcode is the join key between 1C and Shopify, so duplicates cause silent mis-updates.

```bash
npm install
npx tsx scripts/audit-barcodes.ts
```

The script prints two sections to stdout:

```
Variants with blank barcode: <count>
  <productHandle> | <variantId>
  ...

Duplicate barcodes: <count>
  <barcode> -> [<variantId1>, <variantId2>, ...]
  ...
```

It always exits 0 and never mutates anything. Resolve all duplicates and blanks **before** triggering any sync.

`tsx` is bundled in `devDependencies`, so `npx tsx ...` resolves from the local lockfile after `npm install`.

## Local Shopify test-store ↔ 1C diff

To inspect current differences without mutating either system, run:

```bash
npm run diff:shopify-1c
```

The script reads `.env.local` automatically when present, fetches the Shopify
**test store** via `SHOPIFY_STORE_DOMAIN_TEST` / `SHOPIFY_ADMIN_TOKEN_TEST`, and
compares it with the configured 1C price, discount, stock, and cost endpoints.
Console output is overview-only: just the mismatch/data-gap counts and the
generated report directory. Detailed rows are written to JSON files under
`reports/shopify-1c-diff/<timestamp>/json/` and CSV files under
`reports/shopify-1c-diff/<timestamp>/csv/` by default. The same tabular detail
is also exported as one workbook at
`reports/shopify-1c-diff/<timestamp>/excel/shopify-1c-diff.xlsx`, with one sheet
per category. Outputs include separate details for price differences,
stock/status differences, cost differences, missing barcodes, blank/duplicate
Shopify barcodes, truncated Shopify products, and invalid 1C values. Cost
detail rows contain one expected 1C cost field (`expectedCost`) instead of
duplicating the same value as `oneCCost`. It is read-only and exits `0` by
default even when differences are found.

Useful variants:

```bash
# Machine-readable overview in the console; details still go to files
npm run diff:shopify-1c -- --json

# Pick the report directory
npm run diff:shopify-1c -- --output-dir=/tmp/shopify-1c-diff

# Only compare daily-sync fields
npm run diff:shopify-1c -- --modes=prices,stock

# CI-style failure when drift/data gaps exist
npm run diff:shopify-1c -- --fail-on-diff

# Show fetch progress while still keeping stdout overview-only
npm run diff:shopify-1c -- --verbose
```

## Operations

The manual trigger endpoint accepts any combination of modes:

```bash
# Costs only (manual-only — not part of the cron)
curl -H "x-api-key: $INTERNAL_API_KEY" -X POST \
  -d '{"modes":["costs"]}' \
  "$BASE/api/sync/trigger"

# Stock + prices (same as the daily cron)
curl -H "x-api-key: $INTERNAL_API_KEY" -X POST \
  -d '{"modes":["stock","prices"]}' \
  "$BASE/api/sync/trigger"

# All three
curl -H "x-api-key: $INTERNAL_API_KEY" -X POST \
  -d '{"modes":["stock","prices","costs"]}' \
  "$BASE/api/sync/trigger"
```

When multiple modes are combined, they execute sequentially in canonical order `costs → prices → stock` regardless of the input order.

The daily cron runs at `0 22 * * *` UTC (= 02:00 UAE) and is restricted to `stock + prices`. Costs is intentionally manual-only — see the deprecation note below for the migration from the legacy endpoint.

Prices, discounts, and costs from 1C are treated as per-kilogram values. If a
Shopify product has a positive decimal product metafield `custom.weight`, the
sync multiplies the 1C value by that weight before comparing or updating the
variant price / compare-at price / inventory item cost (for example, `30 × 0.5kg
= 15.00`). Missing or invalid weights use multiplier `1`.

Price sync skips non-positive 1C base prices (`0` or lower) instead of updating
Shopify variants to `0.00`. The read-only `diff:shopify-1c` report still
highlights those barcodes separately in `one-c-non-positive-prices.*` so they
can be fixed in 1C without being mixed into normal price-update differences.

The 20% safety floor only applies to `stock` mode: if more than 20% of currently-ACTIVE products would flip to DRAFT, the bulk op is skipped, an alert email is sent from `notification@morlavi92.uk` to `chepiga.lev@gmail.com`, and the run returns `results.stock.skipped` with the percentage. Other modes have no percentage floor — only an empty-payload check per 1C endpoint.

If a previous bulk op is still RUNNING/CREATED when a mode starts, that mode is skipped (Shopify allows only one bulk op per app at a time) and a conflict alert is emailed.

## Deprecation: `/api/update-costs`

The legacy `POST /api/update-costs` endpoint has been **removed** in this hardening pass. Its logic now lives in `runCostsMode` inside `src/app/lib/sync.ts` and is reachable through the unified manual trigger.

**Migration:** any caller (CI job, ad-hoc script, internal tool) that previously called `POST /api/update-costs` must now call:

```bash
curl -H "x-api-key: $INTERNAL_API_KEY" -X POST \
  -d '{"modes":["costs"]}' \
  "$BASE/api/sync/trigger"
```

The replacement is strictly equivalent: same auth header (`x-api-key: $INTERNAL_API_KEY`), same effect (Alqithara + Local cost merge, then bulk inventoryItem cost update), and the response now exposes a per-mode shape:

```json
{
  "ok": true,
  "results": {
    "costs": { "proposed": 42, "applied": 42 }
  }
}
```

Skip outcomes (prior bulk op active, empty 1C payload) appear as `results.costs.skipped: "<reason>"` instead of throwing.

## Vercel-safe async sync architecture

The sync endpoints are quick-ack: they accept work, persist a short-lived run record, and return `202` with `runId`/status metadata instead of waiting for Shopify bulk operations to finish.

Required production infrastructure:

- **Upstash Redis via Vercel Marketplace**. This project expects `REDIS_URL` for durable orchestration state. If `REDIS_URL` is missing in production, sync acceptance fails closed with `503 { ok: false, error: "redis_required" }` and never falls back to long synchronous execution.
- `SHOPIFY_API_VERSION=2026-04`.
- `CRON_SECRET` for Vercel Cron authentication. Vercel sends it as
  `Authorization: Bearer <CRON_SECRET>` when invoking cron routes.
- Shopify webhook HMAC verification uses target-specific app API secret keys when configured:
  `SHOPIFY_WEBHOOK_SECRET_TEST` for the test shop and
  `SHOPIFY_WEBHOOK_SECRET_PRODUCTION` for the production shop. The legacy
  `SHOPIFY_WEBHOOK_SECRET` (or `SHOPIFY_API_SECRET_KEY` / `SHOPIFY_CLIENT_SECRET`) remains a fallback.
- Register Shopify `bulk_operations/finish` webhook to `/api/webhooks/shopify/bulk-operations` on the **effective** Shopify target. The app defaults to the test target for backward-compatible safety unless `SHOPIFY_TARGET=production` or `SHOPIFY_FORCE_TEST=false` is configured. Use `node scripts/register-shopify-webhook.mjs --target=test` for test, `--target=production` for production, or `--target=both` when both shops are intentionally active.

Operational model:

- `/api/cron/daily-sync` schedules the daily `prices -> stock` run and returns quickly.
- `/api/sync/trigger` schedules manual modes in canonical order `costs -> prices -> stock` and returns quickly.
- `/api/webhooks/shopify/bulk-operations` accepts Shopify bulk completion webhooks from the effective Shopify shop and enqueues a QStash `bulk-finish` continuation; the continuation advances the next mode idempotently.
- `/api/cron/reconcile-sync` repairs missed webhook transitions and alerts for stale operations.
- There is no dashboard/run history requirement. Success and failure emails/logs are the operator signals for completed sync runs.

Useful Vercel log events:

- `cron_sync_accepted` — Vercel daily cron accepted a sync run.
- `sync_mode_diff_computed` — 1C vs Shopify comparison finished for one mode; includes counts such as `proposedUpdates`, `shopifyProductCount`, `oneCPriceCount`, or `proposedDraftFlips`.
- `shopify_bulk_mutation_jsonl_uploaded` — staged JSONL upload to Shopify succeeded.
- `shopify_bulk_mutation_started` / `sync_mode_waiting_bulk` — Shopify accepted the bulk mutation and the run is waiting for Shopify completion.
- `shopify_bulk_webhook_enqueued` — Shopify sent a bulk-operation finish webhook and the app enqueued QStash processing. If this marker is missing for a completed bulk operation, the webhook was not accepted/enqueued for that shop.
- `shopify_bulk_webhook_rejected` with `reason: "invalid_hmac"` now includes secret-safe diagnostics such as `shopDomainHeader`, `webhookSecretTarget`, `webhookSecretCandidateSources`, `webhookSecretConfiguredSources`, `hmacHeaderLength`, and `rawBodyBytes`. It never logs secret values.
- `sync_bulk_operation_completed` — the app processed a completed Shopify bulk operation, marked the mode applied, and either scheduled the next mode or completed the run.
- `sync_run_completed` — all requested modes finished.
- `sync_reconcile_*` — reconcile cron inspected/continued a stuck or missed run.

Every structured sync log also includes secret-safe runtime context such as `vercelEnv`, `shopifyTarget`, `shopifyTargetSource`, `shopifyForcedTest`, `shopifyDomain`, and `shopifyApiVersion`, so production Vercel logs show whether the deployment is currently targeting the test or production Shopify store without exposing tokens.

Cron recovery SLA:

- Hobby cron recovery is daily plus scheduler jitter.
- If operations require sub-hour recovery on Hobby, or if two consecutive webhook/reconciler recoveries are delayed by more than 24h, the next architecture step is mandatory queue/workflow orchestration.

The legacy synchronous `runSync()` remains for local/manual debugging only. API route handlers must not call it or wait on `pollBulkOperation()`.
