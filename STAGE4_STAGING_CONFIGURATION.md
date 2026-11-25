# Stage 4 — Staging application configuration (no deployment)

Date: 2026-11-16. Local configuration and validation only: nothing was deployed, published, migrated,
seeded or configured with secrets.

## 1. Files changed

| File | Change |
|---|---|
| `wrangler.staging.jsonc` | Rewritten to run the real application Worker (was the maintenance stub) |
| `wrangler.staging-maint.jsonc` | **New** — the preserved maintenance rollback configuration |

No other file in the repository was touched. `worker/`, `src/`, `tests/`, `package.json`, `wrangler.jsonc`
(production) and `.staging-maint/index.js` are byte-identical to before this stage.

## 2. Configuration changes and reasons

`wrangler.staging.jsonc`:

```jsonc
"name": "corner-cup-staging",
"main": "worker/index.js",                       // was ".staging-maint/index.js"
"compatibility_date": "2025-11-01",              // preserved
"rules": [{ "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": true }],
"assets": {
  "directory": "./dist",
  "binding": "ASSETS",
  "not_found_handling": "single-page-application",
  "run_worker_first": true
},
"d1_databases": [{ "binding": "DB", "database_name": "corner-cup-staging",
                   "database_id": "39a7899c-0130-4536-9570-f07b6c29b2d4" }],
"vars": { "CAFE_NAME": "Corner Cup Staging", "SERVICE_MODE": "counter",
          "CAFE_TZ_OFFSET_MIN": "330" },
"observability": { "enabled": true }
```

- `main` → `worker/index.js`: the application entry (`/api/*` → `handleApi` after `ensureDb`, everything
  else → `env.ASSETS.fetch`). The stub entry would have kept staging on 503 forever.
- `rules[CompiledWasm]`: `worker/passwords.js` imports `argon2id`'s two pre-compiled modules statically;
  workerd never compiles wasm from bytes, so without this rule bundling fails. Same rule already used by
  the production configuration and by Wrangler 4.158.0's `CompiledWasm` type.
- `assets`: `env.ASSETS` is dereferenced for every non-`/api` request, so the binding is required.
  `directory: ./dist` is the Vite `outDir`; `not_found_handling: single-page-application` makes deep links
  (`/c/<slug>/menu`, `/c/<slug>/order/<id>`, `/c/<slug>/admin`) return `index.html`;
  `run_worker_first: true` keeps `/api/*` reaching the Worker instead of asset resolution.
- D1, compatibility date, observability and all three `vars` preserved verbatim. `CAFE_SLUG` was **not**
  added: `slugify("Corner Cup Staging")` already yields `corner-cup-staging`, so no correction is needed.

## 3. Maintenance rollback configuration

`wrangler.staging-maint.jsonc` is the exact pre-Stage-4 shape: `name: corner-cup-staging`,
`main: .staging-maint/index.js`, same compatibility date, same staging D1 binding
(`DB` → `corner-cup-staging` / `39a7899c-0130-4536-9570-f07b6c29b2d4`), same vars, observability enabled,
no assets and no wasm rules.

Rollback deployment command (**not executed**):

```bash
npx wrangler deploy --config wrangler.staging-maint.jsonc
```

Equivalent version-pinned alternative: `npx wrangler rollback a584c608-14ec-42db-b8a9-fffcded4e19d
--config wrangler.staging-maint.jsonc`. Neither references production.

## 4. Build result

`npm run build` → `vite v6.4.5`, 103 modules transformed, exit 0, 854 ms:
`dist/index.html` 0.81 kB, `dist/assets/index-lF6Ef0QK.css` 28.81 kB, `dist/assets/index-galoeRp-.js`
277.23 kB. `dist/` contains 6 files in 2 directories (`assets/`, `fonts/`), which Wrangler reports as
"Read 8 files".

## 5. Dry-run result

`npx wrangler deploy --dry-run --config wrangler.staging.jsonc --outdir <outside repo>` — exit 0, no
publication:

```
Read 8 files from the assets directory …/dist
Total Upload: 222.52 KiB / gzip: 51.44 KiB
env.DB (corner-cup-staging)   D1 Database
env.ASSETS                    Assets
env.CAFE_NAME ("Corner Cup Staging"), env.SERVICE_MODE ("counter"), env.CAFE_TZ_OFFSET_MIN ("330")
--dry-run: exiting now.
```

`npx wrangler deploy --dry-run --config wrangler.staging-maint.jsonc` — exit 0, `Total Upload: 0.36 KiB`,
bindings `env.DB (corner-cup-staging)` + the same three vars, and the emitted bundle is the 503 stub
verbatim.

## 6. WASM and static asset verification (staging bundle)

- `057e151145f9c48ade7bac280fda2a764edf61e9-simd.wasm` (4,416 B) — present
- `eab56e4d16d21f572ad51d3a8d290762c836a260-no-simd.wasm` (3,667 B) — present
- `index.js` 219,777 B with `env.ASSETS.fetch` (1) and `ensureDb` (3) markers; the stub string
  "Staging environment not yet available" appears 0 times → the entry point really is `worker/index.js`
- Assets bundled from `dist`: `index.html`, `assets/index-galoeRp-.js`, `assets/index-lF6Ef0QK.css`,
  `fonts/inter-latin.woff2`, `fonts/fraunces-latin.woff2`, `fonts/OFL.txt`

## 7. Staging D1 binding verification

Dry-run resolves `env.DB` to `corner-cup-staging` (not `corner-cup`). Both staging configs contain the
staging id `39a7899c-0130-4536-9570-f07b6c29b2d4`; grepping both for `00000000-0000-0000-0000-000000000000`
or the production Worker name `corner-cup` returns nothing. `wrangler.jsonc` (production) was not modified.

## 8. Secrets still outstanding

`wrangler secret list --config wrangler.staging.jsonc` is still empty. No secret was added.

| Secret | Missing effect |
|---|---|
| `ADMIN_SECRET` | `POST /api/cafes/:slug/admin/login` → 503; `/operator` sign-in → 503; `POST /api/cafes/:slug/orders` → 503 "Ordering isn't configured" (tracking key falls back to it); owner session signing unavailable |
| `OPERATOR_PASSWORD` | `/operator` console closed (503) even with a secret present |
| `ORDER_TRACK_SECRET` | optional; same effect as above only if `ADMIN_SECRET` is also absent |
| `WORKOS_*` | intentionally absent — cafés run `owner_auth='local'`; `/owner/start` → 409, callback/claim → 503 |
| `RAZORPAY_*` | intentionally absent — `/orders/:id/payment/razorpay` and `/verify` → 503, webhook → 503, provider advertised as `none` |

Routes that **do** work without any secret after deployment: `GET /api/health`, `GET /api/cafe`,
`GET /api/cafes/:slug/menu`, `/tables`, `/config`, `GET /api/cafes/:slug/orders/:id` (needs its tracking
token, which needs a secret), and all static SPA routes.

## 9. First-boot side effects (documented, not triggered)

`ensureDb()` runs once per isolate on the first `/api/*` request and writes:

1. `SCHEMA` + `MIGRATIONS` + `POST_MIGRATIONS` batches — all no-ops on the already-migrated staging DB
   (every `CREATE` is `IF NOT EXISTS`, duplicate `ADD COLUMN`s are verified against `pragma_table_info`).
2. `ensurePrimaryCafe()` — inserts one `cafes` row: slug `corner-cup-staging`, name `Corner Cup Staging`,
   `service_mode 'counter'`, `tz_offset_min 330`, `owner_auth 'local'`. `adoptLegacySettings` reads the
   absent legacy `settings` table and returns.
3. `bootstrapPrimaryPassword()` — **no-op** because `OWNER_PASSWORD` is unset; `pass_hash` stays `NULL`,
   so owner sign-in fails closed.
4. `seedMenu()` — inserts the default `SEED_MENU` rows for that café (only when the café has none).
5. `seedTables()` — inserts 8 `tables` rows (numbers 1–8, ids continuing from `MAX(id)`). This runs even
   though `SERVICE_MODE=counter`; counter mode simply never surfaces them in the UI.
6. `ensureIdempotencyIndex()` — creates the partial unique index
   `idx_orders_idempotency_key ON orders (cafe_id, idempotency_key) WHERE idempotency_key IS NOT NULL`
   (currently absent) and then audits it plus `idx_checkout_claims_key`; on either failure it logs and
   disables ordering instead of crashing.

Nothing above was executed: no request was made against the deployed Worker and no D1 statement was run.

## 10. Argon2id risk (unchanged parameters)

`m = 19456 KiB`, `t = 2`, `p = 1`, queue `MAX_QUEUE = 3` — untouched. Measured locally: hash p50 48.8 ms,
verify p50 47.3 ms (HTTP wall clock in workerd). On the Workers Free plan (10 ms CPU per invocation) the
hashing paths are expected to raise Error 1102: owner sign-in, password set/change, operator reset.

Safe test separation:

- **Non-hashing routes** (no CPU-heavy work): `GET /api/health`, `GET /api/cafe`,
  `GET /api/cafes/:slug/menu|tables|config`, static SPA routes — safe to exercise on Free.
- **Hashing routes**: `POST /api/cafes/:slug/admin/login` once, expecting either a clean 401/503 or Error
  1102 recorded in observability (§8 of the Stage 3 report). Not to be retried in a loop.
- `GET /api/cafes/:slug/orders/:id` requires a tracking token, which needs `ADMIN_SECRET`/`ORDER_TRACK_SECRET`;
  verify it only after a secret exists, otherwise expect 503 and no hashing.

## 11. Remaining blockers for deployment

1. `ADMIN_SECRET` (+ `OPERATOR_PASSWORD`) must be set by an approved secrets step — otherwise staff sign-in
   and ordering answer 503.
2. Workers Free plan vs ~50 ms Argon2id: password flows will likely fail with 1102. No parameter or plan
   change is proposed here.
3. The first deployment will write the seed data listed in §9 and create the idempotency index — needs an
   explicit "staging data may be written" acknowledgement.
4. `dist/` must be rebuilt in the same step as the deploy (`npm run build`), because the assets upload reads
   `./dist` at deploy time.

## 12. State

Nothing deployed, published, migrated, seeded, or configured with secrets. Git untouched: no staging, no
commit, no reset, no clean. Working tree still shows the same 26 modified files and 78 untracked entries;
the two new/changed files here are untracked additions (`wrangler.staging.jsonc` was already untracked,
`wrangler.staging-maint.jsonc` is new), so no previously existing work was altered.
