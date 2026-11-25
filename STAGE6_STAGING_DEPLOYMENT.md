# Stage 6 — Staging deployment record

Date: 2026-11-16. Application deployed to the staging Worker and first-boot initialization triggered.

## Target (verified before deploy)

- Worker `corner-cup-staging`, URL `https://corner-cup-staging.rahilbisen8.workers.dev`
- D1 `corner-cup-staging` / `39a7899c-0130-4536-9570-f07b6c29b2d4` (only database in the account)
- `wrangler.staging.jsonc` sha256 `7f59ffc1…5718` (app entry `worker/index.js`, CompiledWasm rule, `./dist`
  assets with SPA fallback + `run_worker_first`, staging D1 binding, three vars, observability)
- `wrangler.staging-maint.jsonc` sha256 `58c011dc…2084` (rollback: `.staging-maint/index.js`, same D1)
- Production `wrangler.jsonc` untouched (still `corner-cup` + placeholder id `00000000-0000-…`)
- Pre-deploy active deployment was the maintenance version `a584c608-14ec-42db-b8a9-fffcded4e19d`

## Deployment

- `npm run build` → 103 modules, `dist` 805 B html / 28.8 kB css / 277.2 kB js, exit 0
- `wrangler deploy --dry-run` → 222.52 KiB, 51.44 KiB gzip, both Argon2id wasm binaries, `env.ASSETS`,
  `env.DB (corner-cup-staging)`
- `npx wrangler deploy --config wrangler.staging.jsonc` →
  **version `c1204e32-0fa6-48a4-9be1-01b1f050ead7`**, version created 2026-11-16T19:12:40.521Z,
  deployment created 2026-11-16T19:12:42.306Z, 100% of traffic
- 6 static assets uploaded (`/index.html`, 2 assets, 3 fonts)

## First boot (triggered by `GET /api/health`)

`{"status":"ok","database":"ok","time":"2026-11-16T19:12:58.570Z"}` — HTTP 200, 6.57 s wall (one-time init).

Resulting rows: **1 café** (id 1, slug `corner-cup-staging`, `counter`, tz 330, `owner_auth local`,
`auth_version 1`, `auth_mode_generation 0`, `pass_hash NULL`), **27 menu_items**, **8 tables**, 0 orders,
0 sessions. Schema: 20 tables, **21 indexes** (the new partial unique
`idx_orders_idempotency_key ON orders (cafe_id, idempotency_key) WHERE idempotency_key IS NOT NULL`),
1 trigger.

## Smoke tests (browse-only; all 200)

`/` html · `/api/health` json · `/api/cafe` json · `/api/cafes/corner-cup-staging/menu` json (5 categories,
27 items) · `…/tables` json (8 tables) · `…/config` json (`payments.provider none`, `gateway false`,
`ownerAuth local`, currency INR) · `/c/corner-cup-staging/menu` html · `/c/corner-cup-staging/owner` html ·
`/assets/index-galoeRp-.js`, `/assets/index-lF6Ef0QK.css`, `/fonts/inter-latin.woff2` all served with correct
content types.

Browser: menu page renders "CORNER CUP STAGING", all 27 items with ₹ prices; network all 200; **0 console
messages/errors**.

Worker tail (8 events, all `scriptVersion c1204e32`): `outcome ok`, 0 exceptions, 0 log lines,
CPU 1–3 ms, wall 144–283 ms.

## Boundaries kept

No secrets (`wrangler secret list` → `[]` before and after), no WorkOS/Razorpay configuration, no auth or
ordering tests, no additional migrations or data, no production deployment or database access, no Git
operations (26 modified / 80 untracked, 0 staged).

## Rollback

```bash
npx wrangler deploy --config wrangler.staging-maint.jsonc
# or
npx wrangler rollback a584c608-14ec-42db-b8a9-fffcded4e19d --config wrangler.staging-maint.jsonc
```

Not needed: the deployment booted cleanly and served correct content.

## Operational note

`wrangler deployments list` kept showing the old maintenance deployment after the upload; `wrangler
deployments status` and `wrangler tail` (`scriptVersion c1204e32…`) both confirm the new version is
serving 100%. Treat `deployments list` as eventually consistent for this Worker.
