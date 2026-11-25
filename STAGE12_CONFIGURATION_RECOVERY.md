# Stage 12 — Worker Configuration Inventory & Recovery Checklist

**Date:** 2026-11-20
**Scope:** read-only inspection of the repository's Wrangler configuration. No deployment, no binding change,
no secret value read, no production access.
**Companions:** `STAGE12_BACKUP_POLICY.md`, `STAGE12_DATABASE_RECONNECTION.md`,
`DISASTER_RECOVERY_RUNBOOK.md`, `STAGE12_OPERATIONAL_RECOVERY_REPORT.md`.

---

## 1. Why this document exists

A Worker is three things that must be recovered together: **code**, **configuration** (bindings, vars,
compatibility date, asset rules) and **secrets**. The code lives in Git; the configuration lives in three
tracked files; the secrets live only in Cloudflare and are readable by nobody. This inventory records the
first two precisely enough to rebuild a deployment from the repository alone, and names the third without
ever touching its values.

## 2. Configuration files

| File | Purpose | SHA-256 (recorded 2026-11-20) |
|---|---|---|
| `wrangler.jsonc` | Production Worker `corner-cup` | `3df6a29ed38315b29608c7e2831cef9eef35c0a9362384ac4429db1a01bc96a0` |
| `wrangler.staging.jsonc` | Staging Worker `corner-cup-staging` (real application) | `7f59ffc197d3e4a98fecb67721fbafdae8d905cd838e11e3e9aec57266045718` |
| `wrangler.staging-maint.jsonc` | Staging rollback: 503 maintenance stub | `58c011dc099f22d615bf6ae6c8dbd52df7d5aa41f03be8c8aa328f88fcb22084` |

The staging hash `7f59ffc1…5718` is byte-identical to the value recorded before the Stage 6 deployment, so the
configuration that is serving staging has not drifted since it was deployed.

Supporting build inputs: `package.json` `1ba45ab8…62bd`, `package-lock.json` `392fd1f7…1c56`,
`.staging-maint/index.js` `f1517b40…7713`.

Toolchain observed: Node `v26.13.1`, Wrangler `4.158.0`.

## 3. Workers and environments

| Worker | Config | Entry point | State |
|---|---|---|---|
| `corner-cup` | `wrangler.jsonc` | `worker/index.js` | Not deployed. Its D1 binding is still the placeholder id. |
| `corner-cup-staging` | `wrangler.staging.jsonc` | `worker/index.js` | Deployed, serving 100% of traffic (version `c1204e32-0fa6-48a4-9be1-01b1f050ead7`, Stage 6). |
| `corner-cup-staging` (rollback) | `wrangler.staging-maint.jsonc` | `.staging-maint/index.js` | Not deployed. Answers 503 on every route. Previous version `a584c608-14ec-42db-b8a9-fffcded4e19d`. |

There are **no `env` blocks** in any configuration file. Each file is a complete environment, and Wrangler's
`--env` flag has nothing to select. "Environments" here means *separate Workers*, not `env.production` style
sections — a distinction that matters during recovery, because two configs can legitimately target one Worker
name (staging and its maintenance stub do exactly that).

## 4. D1 bindings

| Config | Binding | Database name | Database id | Meaning |
|---|---|---|---|---|
| `wrangler.jsonc` | `DB` | `corner-cup` | `00000000-0000-0000-0000-000000000000` | **Placeholder — not a real database.** Never deploy or restore against this value. |
| `wrangler.staging.jsonc` | `DB` | `corner-cup-staging` | `39a7899c-0130-4536-9570-f07b6c29b2d4` | Live staging database. |
| `wrangler.staging-maint.jsonc` | `DB` | `corner-cup-staging` | `39a7899c-0130-4536-9570-f07b6c29b2d4` | Same database; the stub binding must be kept so a rollback does not orphan `env.DB`. |

The binding name is `DB` everywhere. Application code reads `env.DB` and nothing else, so the binding name is
part of the application contract and must not be renamed during a recovery.

Isolated drill database from Stage 11 (not referenced by any configuration):
`corner-cup-stage11-restore-20261119T155325Z` / `2399a1f7-2e26-49bc-89a7-21256439a014`.

## 5. Compatibility date and flags

| Setting | Value | Notes |
|---|---|---|
| `compatibility_date` | `2025-11-01` | Identical in all three configs. Changing it changes runtime behaviour; restore the recorded value. |
| `compatibility_flags` | *absent* | No flags are enabled anywhere. A recovery must not invent one. |
| `rules` | `[{ "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": true }]` | Application configs only. Required because `worker/passwords.js` statically imports Argon2id's two pre-compiled modules and workerd never compiles wasm from bytes. The maintenance stub has no `rules`. |

## 6. Assets and request routing

| Setting | Value |
|---|---|
| `assets.directory` | `./dist` (Vite `outDir`) |
| `assets.binding` | `ASSETS` |
| `assets.not_found_handling` | `single-page-application` |
| `assets.run_worker_first` | `true` |

`/api/*` is answered by the Worker; everything else is handed to the built SPA through `env.ASSETS.fetch`.
`run_worker_first` keeps the API reachable, and the SPA fallback makes deep links such as
`/c/<slug>/order/<id>` resolve to `index.html`. The maintenance config has no `assets` block at all, so
restoring it deliberately removes static serving.

`dist/` is gitignored and produced by `npm run build` (Vite). A recovery must rebuild it; it cannot be restored
from Git.

## 7. Routes and custom domains

**None configured.** No `routes`, no `custom_domains`, no `workers_dev: false` in any file. Every deployment is
reachable only at its `workers.dev` hostname, derived from the Worker name:

```
https://corner-cup-staging.rahilbisen8.workers.dev
```

Consequences for recovery:

- There is no DNS record under the project's control to repair. Worker recovery is complete when the Worker
  serves its `workers.dev` origin.
- Renaming the Worker changes its public URL. Recreate it with the **same name**.
- `WORKOS_REDIRECT_URI` must match the deployed origin exactly. If the hostname ever changes, that secret must
  be updated in the WorkOS dashboard and in the Worker together.
- Adding a custom domain later means the recovery plan must grow a DNS/TLS step; it does not have one today.

## 8. Non-secret variables (in config)

| Name | Production value | Staging value | Effect |
|---|---|---|---|
| `CAFE_NAME` | `Corner Cup Café` | `Corner Cup Staging` | Name for the first café only, and only while the database has no café row. |
| `SERVICE_MODE` | `counter` | `counter` | `tables` or `counter`; first-boot value only. |
| `CAFE_TZ_OFFSET_MIN` | `330` | `330` | Café clock offset, first-boot value only. |

Optional non-secret runtime knobs read by code but absent from every config: `CAFE_SLUG` (`worker/db.js`, first
boot only) and `RATE_LIMIT_CLEANUP_PROBABILITY` (`worker/api.js`, opportunistic rate-limit pruning).

Once the café row exists in D1, these variables are ignored — **the database is authoritative for café settings**.
Restoring a Worker with the wrong `CAFE_NAME` therefore cannot rename an existing café, but restoring an *empty*
database with the wrong values can create one with the wrong name, slug and service mode.

## 9. Required secret names (names only)

Values were not read, printed, copied or modified. This list comes from the code (`env.<NAME>` references) and
from `.dev.vars.example`, not from Cloudflare.

### Required for core operation

| Name | Required | If missing |
|---|---|---|
| `ADMIN_SECRET` | **Yes** | Staff sign-in and `/operator` return 503; order creation returns 503 ("Ordering isn't configured") because guest tracking derives from it when `ORDER_TRACK_SECRET` is absent. |

### Required for specific features

| Name | Feature | If missing |
|---|---|---|
| `OPERATOR_PASSWORD` | `/operator` console | Console closed (503) even when `ADMIN_SECRET` exists. |
| `OWNER_PASSWORD` | First-boot seed of the first café's password hash | No hash installed; that café's owner sign-in fails closed. Never compared at sign-in. |
| `ORDER_TRACK_SECRET` | Guest order-tracking tokens | Falls back to `ADMIN_SECRET`. |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_ISSUER` | Managed owner authentication (AuthKit) | `/owner/start` → 409 for `owner_auth='local'` cafés; callback/claim → 503. Local password auth keeps working. |
| `WORKOS_AUDIENCE` | JWT audience pin | Defaults to `WORKOS_CLIENT_ID`. |
| `WORKOS_STATE_ENCRYPTION_KEY` | Encrypts OAuth state / PKCE verifier (≥32 chars) | Managed sign-in refuses with 503; there is no plaintext fallback. |
| `WORKOS_API_BASE` | Non-default WorkOS API host | Defaults to the public API base. |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET` | Online payments | Provider advertised as `none`; guests are offered counter payment instead. |
| `RAZORPAY_WEBHOOK_SECRET` | Webhook signature verification | Webhook returns 503; browser-callback settlement still works. |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | Optional new-order alerts | Alerts silently skipped; payments unaffected. |

`ADMIN_PIN` appears in `.dev.vars.example` but is **not read by the code at all**; do not restore it.

Current live secret inventory was **not** queried in Stage 12 (`wrangler secret list` deliberately not run), so
this document proves which names the code needs, not which values exist on the deployed Worker. Stage 6
recorded an empty secret list at deployment time.

## 10. External service dependencies

| Dependency | Required? | Used for | Recovery action |
|---|---|---|---|
| Cloudflare Workers + D1 | Yes | Runtime and database | Recreate Worker; restore/rebind D1. |
| npm registry | Yes (build time) | `npm ci` for React/Vite/Argon2id | Rebuild `dist/` and the Worker bundle. |
| WorkOS (AuthKit) | No — only for managed-auth cafés | OIDC sign-in, MFA, session revocation | Secrets + redirect URI must match the deployed origin. Sandbox behaviour still unverified. |
| Razorpay | No — payments currently disabled | Checkout, webhook settlement | Test keys must be regenerated in the dashboard; webhook URL must be re-registered. |
| Telegram Bot API | No | Optional paid-order alerts | Re-issue bot token if lost; no data is stored. |

No KV, R2, Queue, Durable Object or Cron Trigger is used. There is nothing else to recover.

## 11. Configuration recovery checklist

Run in order. Each row is verifiable; a step is done only when its check passes.

- [ ] **Source of truth** — restore the repository at the commit that was deployed (`git log`, `git status`).
- [ ] **Config hashes** — `sha256sum wrangler.jsonc wrangler.staging.jsonc wrangler.staging-maint.jsonc`
      matches §2. A mismatch means the file was edited after the incident was declared; stop and inspect.
- [ ] **Worker name** — `name` is `corner-cup-staging` (or `corner-cup` for production). Check before deploying:
      the public URL is derived from it.
- [ ] **Entry point** — `main` is `worker/index.js` for the application config, `.staging-maint/index.js` for the
      stub. `grep -c "worker/index.js" wrangler.staging.jsonc` → 1.
- [ ] **Compatibility date** — `2025-11-01`, and no `compatibility_flags` present.
- [ ] **WASM rule** — `CompiledWasm` rule present with `fallthrough: true`. Without it the bundle fails to build.
- [ ] **Assets** — `directory: ./dist`, `binding: ASSETS`, SPA fallback, `run_worker_first: true`.
- [ ] **D1 binding** — `binding: DB`; `database_id` equals the id verified in
      `STAGE12_DATABASE_RECONNECTION.md` §2. A `00000000-…` id anywhere means the placeholder was restored by
      mistake: do not deploy.
- [ ] **Variables** — `CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN` present with §8 values.
- [ ] **Build** — `npm ci` then `npm run build` succeeds and `dist/index.html` exists.
- [ ] **Dry run** — `npx wrangler deploy --dry-run --config <file>` reports `env.DB` resolving to the expected
      database name, `env.ASSETS`, the three vars, and both Argon2id `.wasm` files in the bundle.
- [ ] **Secrets** — every name in §9 that the deployment needs has been re-set from the password manager
      (procedure in `DISASTER_RECOVERY_RUNBOOK.md` §4). Verified by behaviour, not by reading values.
- [ ] **No secrets in files** — `git grep -nE "RAZORPAY_KEY_SECRET|WORKOS_API_KEY|ADMIN_SECRET" -- ':!*.md'`
      returns only code references, never literals.
- [ ] **Post-deploy smoke** — `GET /api/health` → `{"status":"ok","database":"ok"}` and one guest menu page
      renders. Full list in `DISASTER_RECOVERY_RUNBOOK.md` §6.

## 12. What is not recoverable from this repository

1. **Secret values.** They exist only in Cloudflare and the operator's password manager. Losing both is
   unrecoverable and requires re-issuing credentials at each provider (and invalidates staff sessions, guest
   tracking links, in-flight WorkOS logins and Razorpay webhook signatures).
2. **The built `dist/` bundle.** Rebuildable, not recoverable — byte-identical output depends on the same
   lockfile and toolchain.
3. **WorkOS and Razorpay tenant configuration** (redirect URIs, webhook endpoints, key pairs). These live in the
   providers' dashboards and must be recreated there; nothing in Git records them beyond the env-var names.
4. **The deployed version's exact bytes.** `wrangler versions`/`deployments` can roll back while the Worker
   still exists, but a deleted Worker cannot be recovered from Cloudflare — only rebuilt from Git.
