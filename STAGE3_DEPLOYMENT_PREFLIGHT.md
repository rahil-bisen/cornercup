# Stage 3 — Staging Application Deployment Preflight (read-only)

Date: 2026-11-16 (local). Nothing was deployed, published, migrated, configured or staged in this stage.
Verdict: **NO-GO for deployment now** — see §11–12. The application itself is Workers-compatible; the
staging configuration and the undeclared deployment secrets are what block it.

---

## 1. Worker verification

| Item | Observed |
|---|---|
| URL | `https://corner-cup-staging.rahilbisen8.workers.dev` |
| Response | `HTTP/1.1 503 Service Unavailable`, `content-type: application/json`, `cache-control: no-store`, 71 bytes |
| Body | `{"status":"staging","message":"Staging environment not yet available."}` |
| Other paths | `/` → 503 (same body); `/api/health` → 503 — the maintenance Worker answers every route |
| Active version | `a584c608-14ec-42db-b8a9-fffcded4e19d`, created `2026-11-15T21:20:38Z`, 100% of traffic, single deployment in the list |
| Worker name | `corner-cup-staging` (`wrangler.staging.jsonc`) |
| `main` | `.staging-maint/index.js` (maintenance stub) |
| `compatibility_date` | `2025-11-01` (identical to production config) |
| `observability` | enabled |
| `vars` | `CAFE_NAME="Corner Cup Staging"`, `SERVICE_MODE="counter"`, `CAFE_TZ_OFFSET_MIN="330"` |
| `assets` | **absent** |
| `rules` | **absent** |

## 2. Database binding verification

```
binding       DB
database_name corner-cup-staging
database_id   39a7899c-0130-4536-9570-f07b6c29b2d4      ← matches the Stage 2 target exactly
```

- It is the only D1 database in the account; it cannot resolve to production. Production `wrangler.jsonc`
  still carries the placeholder `00000000-0000-0000-0000-000000000000`, so no production database is reachable.
- Live schema (post-Stage 2): 19 application tables (+ Cloudflare's `_cf_KV`), 20 indexes including the
  partial `idx_owner_sessions_identity`, 1 trigger `cafes_auth_mode_generation_step`, `PRAGMA quick_check` = ok,
  `foreign_keys` = 1, `foreign_key_check` clean, all tables empty.
- Index `idx_orders_idempotency_key` does **not** exist yet: it is created at first application boot by
  `ensureIdempotencyIndex()` (`worker/db.js`). The table is empty, so creation cannot clash.
- Application-side requirement audit (`readCheckoutConstraints`) passes on live metadata: `orders` has
  `cafe_id`/`idempotency_key`/`fingerprint`, `checkout_claims` has all six required columns, and
  `idx_checkout_claims_key` is unique, non-partial, on `(cafe_id, idempotency_key)`.

## 3. Workspace change inventory

Git: branch `freebuff/qr-code-cafe-ordering-website` at `023befe`, **26 modified, 76 untracked, 0 added,
0 deleted, nothing staged**. All work preserved; nothing reverted, cleaned or overwritten.

**Not the original project root.** This chat runs in a linked worktree:
- `git rev-parse --git-common-dir` → `…/.config/freebuff-desktop/cloud-projects/e748…/.git`
- `.git` here is a pointer file (`gitdir: …/.git/worktrees/e748…`)
- `git worktree list` → primary `…/cloud-projects/e748…` at `0000000 [main]`, this tree at `023befe`
- The primary directory contains only `.freebuff` and `.git` (no working files), so this worktree is the
  only checked-out copy of the project.

Files named in the Stage 2 report:

| File | Git state | mtime | Assessment |
|---|---|---|---|
| `tests/argon2.passwords.test.mjs` | untracked | 2026-11-15 20:04:38 | F-07 behavioural suite (11 tests) that drives the production hasher through the workerd harness at `127.0.0.1:8790`; skips when the harness is down. Consistent with the approved Argon2id implementation. |
| `tests/migrations.test.mjs` | modified | 2026-11-15 22:54:36 | Appends one test: fresh + legacy DB both end with `owner_sessions`, column order `session_id, cafe_id, created, expires, workos_user_id, workos_session_id`, both indexes present, and a second boot is a no-op. Consistent with the approved owner-session work. |

Did anything appear **during** Stage 2? No. Stage 2 ran 2026-11-17 00:07–00:24 local; the newest tracked or
untracked workspace file is `scripts/` at 2026-11-16 02:54:41. Nothing has an mtime inside the Stage 2 window,
so the earlier "missing file" observation was a stale view of the worktree (it was re-synchronised), not a
Stage 2 write. The added migration test's expected `owner_sessions` shape matches the live staging table
column-for-column — an independent confirmation of Stage 2.

## 4. Application deployment compatibility

Positive evidence gathered locally (no upload):
- `vite build` → `103 modules transformed`, `dist/index.html` 0.81 kB, CSS 28.81 kB, JS 277.23 kB, 1.21 s.
- `wrangler deploy --dry-run --config wrangler.jsonc` → reads 8 asset files, **Total Upload 222.52 KiB /
  51.44 KiB gzip**, bundles both Argon2id binaries (`…-simd.wasm`, `…-no-simd.wasm`). Well inside Workers limits.
- Runtime surface: `worker/index.js` routes `/api/*` to `handleApi` after `ensureDb(env)`, everything else to
  `env.ASSETS.fetch`. `ensureDb` memoises per isolate: SCHEMA batch → tolerant `migrate()` → POST_MIGRATIONS
  batch → idempotency index + constraint audit → seed primary café → optional owner-password bootstrap →
  seed menu and tables.
- Health: `GET /api/health` returns `status`, `database`, `time`; needs no secret, no payment config
  (`tests/health.test.mjs`).
- SPA: production serves `dist` with `not_found_handling: single-page-application` and
  `run_worker_first: true`; client routes are `/c/:slug/...` (`/c/:slug/menu`, `/c/:slug/t/:tableId`,
  `/c/:slug/admin`).
- Startup writes on first request: with `CAFE_SLUG` unset the primary café's slug is derived from
  `CAFE_NAME` → **`corner-cup-staging`**, plus a menu and (for `SERVICE_MODE=tables`) table rows. Current
  `SERVICE_MODE` is `counter`, so no tables are seeded.

**Three hard config gaps** in `wrangler.staging.jsonc` versus what `worker/index.js` needs:

1. `main` still points at `.staging-maint/index.js` — deployment would keep serving the 503 stub.
2. No `assets` block → `env.ASSETS` is undefined → every non-`/api` request throws (500/1101). `env.ASSETS`
   is referenced 3×.
3. No `rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"], fallthrough: true }]` → the `argon2id` package's
   static wasm imports cannot be bundled; the deploy fails before upload.

No production dependency exists: distinct DB id, placeholder prod id, and the app boots with no WorkOS or
Razorpay configuration.

## 5. Environment variables

Non-secret (plain `vars`, already present): `CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN`.
Optional non-secret: `CAFE_SLUG` (recommended, to pin `corner-cup-staging` instead of deriving it),
`RATE_LIMIT_CLEANUP_PROBABILITY` (defaults to `0.01`).

Secrets — `wrangler secret list --config wrangler.staging.jsonc` returns `[]`:

| Name | Class | Needed for staging? | Behaviour when unset |
|---|---|---|---|
| `ADMIN_SECRET` | secret | **Yes** (session signing) | `/api/cafes/:slug/admin/login`, operator sign-in → 503 "isn't configured"; ordering → 503 "Ordering isn't configured" (tracking falls back to this secret) |
| `ORDER_TRACK_SECRET` | secret | Recommended | Falls back to `ADMIN_SECRET`; no order tracking tokens without one of them |
| `OPERATOR_PASSWORD` | secret | Yes, to open `/operator` | Operator console closes (503) |
| `OWNER_PASSWORD` | secret | **No** — leave unset on staging | When ≥12 chars it seeds the primary café's first password (a hashing call at boot); when absent the café keeps `pass_hash NULL` and owner sign-in fails closed |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_ISSUER`, `WORKOS_AUDIENCE`, `WORKOS_STATE_ENCRYPTION_KEY` | secret | **No** — keep unset | Managed sign-in routes answer 409/503; local password mode is unaffected |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | secret | **No** — keep unset | Payments disabled (§7) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | secret | No | Owner paid-order alerts are simply skipped |

`ADMIN_PIN` appears in `.dev.vars.example` but no code reads it any more (the F-07 plaintext fallback was
removed) — do not set it. `.dev.vars` exists locally (gitignored, local dev only) and is never used by an
uploaded Worker.

## 6. WorkOS readiness

- Every café row carries `owner_auth` with `NOT NULL DEFAULT 'local'`; live staging has no cafés yet, so the
  seeded café is **local** mode. `worker/owner.js` and `worker/api.js` normalise anything that is not
  `workos` to `local`.
- With mode `local`: `/api/cafes/:slug/owner/start` → 409 `auth_mode_local`; `/api/owner/callback` and the
  claim routes answer 503 while unset. Owner sign-in is password + `ADMIN_SECRET`-signed session.
- Required local auth configuration for a usable staging owner: `ADMIN_SECRET`, and either `OWNER_PASSWORD`
  (bootstrap hash) or an operator-issued password reset. No WorkOS tenant is touched; nothing about managed
  identity is enabled. The mode switch path (`authmode.js`) is untouched by this stage.

## 7. Razorpay readiness

- `paymentProvider(env)` → `"none"` while `RAZORPAY_KEY_ID`/`RAZORPAY_KEY_SECRET` are unset; the public
  config advertises `gateway: false`, `keyId: null`.
- `POST /orders/:id/payment/razorpay` and `/payment/razorpay/verify` → 503 "Online payments aren't switched
  on yet."
- `POST /razorpay/webhook` (and `/webhooks/razorpay`) → 503 "Webhook is not configured." before any signature
  or payload work.
- Conclusion: payments stay disabled; orders are counter/cash (`payment_method` default `counter`). No
  transaction was initiated in this stage.

## 8. Argon2id CPU / runtime risk

- Parameters (unchanged): `m = 19456 KiB (19 MiB)`, `t = 2`, `p = 1`, OWASP baseline; bounded queue
  `MAX_QUEUE = 3`; legacy PBKDF2 ceiling 100 000.
- Local workerd measurement already recorded (`SECURITY_STATUS.md`): hash p50 **48.8 ms** / p90 56.6 ms,
  verify p50 47.3 ms / p90 49.5 ms — HTTP wall clock, so workers CPU is a similar order.
- The staging Worker is on the Workers **Free** plan (10 ms CPU per invocation). Expected failure on every
  hashing path: **Error 1102** on owner sign-in, password set/change, operator reset and (if ever set)
  `OWNER_PASSWORD` bootstrap. Menu, ordering, health and static assets do no hashing and are unaffected.
  The queue bounds concurrency and memory (19 MiB is well inside 128 MiB) but cannot raise a CPU ceiling.
- Testing plan without changing parameters or plan: deploy, then (a) `GET /api/health` → 200; (b) post a
  wrong owner password once and read the observability trace for 1102 vs a clean 401; (c) if 1102 appears,
  record it as a platform limitation — password flows cannot be validated on staging until a paid plan or a
  different identity design is approved. No parameter tuning, no plan upgrade in this stage.

## 9. Rollback procedure

1. **Code**: `wrangler.staging.jsonc` currently points at the maintenance stub, so
   `npx wrangler deploy --config wrangler.staging.jsonc` restores the 503 state immediately. Version-pinned
   alternative: `npx wrangler rollback a584c608-14ec-42db-b8a9-fffcded4e19d --config wrangler.staging.jsonc`.
2. **Database**: application boot is idempotent (duplicate-column skips are verified against the catalogue),
   so schema rollback is normally unnecessary. Seeded rows can be removed with targeted `DELETE`s (data only).
3. **Full database restore** (last resort, schema-level damage only): replay
   `…/staging-d1-backups/corner-cup-staging_pre-migration_20261117T000814.sql`
   (`sha256 ebc18cc839e84d2df803d9859561b700cbd302f5c6d107943f81641d6bc94c3e`). Note it predates the Stage 2
   completion, so restoring it also reverts the indexes/columns added then.
4. Secrets rollback: `npx wrangler secret delete <NAME> --config wrangler.staging.jsonc`.

## 10. Proposed deployment command (NOT executed)

Prerequisites, each needing separate approval because they change files or secrets:

1. Edit `wrangler.staging.jsonc`: `main: "worker/index.js"`, add
   `rules: [{ "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": true }]`, add
   `assets: { "directory": "./dist", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_worker_first": true }`,
   and optionally pin `"CAFE_SLUG": "corner-cup-staging"`. Leave `d1_databases` as it is.
2. `npx wrangler secret put ADMIN_SECRET --config wrangler.staging.jsonc` (value supplied out-of-band)
3. `npx wrangler secret put OPERATOR_PASSWORD --config wrangler.staging.jsonc`
4. optionally `npx wrangler secret put ORDER_TRACK_SECRET --config wrangler.staging.jsonc`

Then:

```bash
npm run build
npx wrangler deploy --config wrangler.staging.jsonc
```

Post-deploy verification that would be required: `GET /api/health` → `{"status":"ok","database":"ok"}`, a
first-request seed of café `corner-cup-staging`, menu renders at `/c/corner-cup-staging/menu`, maintenance 503
gone, ordering enabled (or explicitly still 503 if `ADMIN_SECRET` absent), Razorpay endpoints 503, owner sign-in
result recorded with its CPU outcome.

## 11. Outstanding blockers

| # | Blocker | Severity |
|---|---|---|
| B1 | `wrangler.staging.jsonc` `main` is the maintenance stub | blocking |
| B2 | no `assets` binding → `env.ASSETS` undefined → all page routes fail | blocking |
| B3 | no `CompiledWasm` rule → `argon2id` wasm cannot bundle | blocking |
| B4 | `wrangler secret list` is empty: no `ADMIN_SECRET` (staff sign-in + ordering 503), no `OPERATOR_PASSWORD` | blocking for a usable app |
| B5 | Workers Free plan (10 ms CPU) vs ~50 ms Argon2id → Error 1102 on every hashing path | blocking for password flows; no mitigation approved |
| B6 | first API request writes seed data (café, menu) and creates `idx_orders_idempotency_key` | by design; needs an explicit "staging data may be written" nod |
| B7 | `dist/` must be rebuilt at deploy time (I rebuilt it locally during this preflight; it is gitignored) | procedural |

## 12. Recommendation

**NO-GO for the deployment itself; GO for the Stage 4 change set.** The application bundles for Workers,
needs no production dependency, and the staging database is schema-complete and empty. Deployment is blocked
until B1–B4 are changed with approval, and B5 must be an explicit decision (expected 1102 on owner password
paths under the Free plan) before anyone expects a working sign-in on staging.

Nothing was deployed, published, migrated, configured, seeded, staged or committed in this stage.
