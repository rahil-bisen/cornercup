# Stage 5 — Final staging deployment safety review (read-only)

Date: 2026-11-16. Nothing was deployed, migrated, seeded, configured with secrets, or changed in Git.
Configuration fingerprints reviewed: `wrangler.staging.jsonc`
`7f59ffc197d3e4a98fecb67721fbafdae8d905cd838e11e3e9aec57266045718`, `wrangler.staging-maint.jsonc`
`58c011dc099f22d615bf6ae6c8dbd52df7d5aa41f03be8c8aa328f88fcb22084`.
Live staging deployment is still the single maintenance version `a584c608-14ec-42db-b8a9-fffcded4e19d`
(100%), i.e. no deploy happened in Stages 3–5.

---

## 1. Argon2id runtime options

Current hashing is fixed at `m = 19456 KiB`, `t = 2`, `p = 1` (OWASP baseline), bounded queue
`MAX_QUEUE = 3`, memory ≈19 MiB per hash; measured locally at ~48 ms (hash p50 48.8 ms, verify p50 47.3 ms,
workerd HTTP wall clock).

Platform facts (Cloudflare Workers limits, docs updated Oct 2026):

| | Workers Free | Workers Paid |
|---|---|---|
| CPU per HTTP request | **10 ms** | 30 s default, configurable up to 5 min (`limits.cpu_ms`, max 300000) |
| Memory per isolate | 128 MB | 128 MB |
| Requests | 100k/day | unmetered (billed) |
| Included CPU | — | 30 M CPU-ms/month, then $0.02 per additional million |
| Base price | $0 | $5/month |

### Option A — keep Argon2id, move the Worker to the paid plan (recommended)

Security: unchanged — same parameters, same 19 MiB, same OWASP baseline, credentials stay in D1, no third
party sees them.
Cost: $5/month floor; at ~50 ms of CPU per hash/verify the included 30 M CPU-ms covers roughly 600,000
hashing operations per month, far above a café's owner-login volume.
Complexity: **zero code and zero config change** beyond what Stage 4 already validated. A `limits.cpu_ms`
of, say, 5000 can be added later as a denial-of-wallet guard (it is a ceiling, not a spend).
Risk: the CPU ceiling becomes a paid-tier dependency; per-request CPU should be confirmed from
observability (`wallTime`/CPU metrics) rather than assumed.

### Option B — WorkOS AuthKit for owner sign-in

The repository **already implements the full managed flow** (`worker/owner.js`, `workos.js`, `pkce.js`,
`jwt.js`, `revocations.js`, `authmode.js`): authorization-code + PKCE S256, single-use hashed state rows,
code exchange, JWKS fetch/cache with bounded bodies, `iss`/`aud`/`sub` verification, invite-claim binding
by hashed code, provider session revocation with an exponential retry queue (`provider_revocations`),
session caps, and an audited, atomic local↔workos mode transition per café.

Security: password storage, MFA, passkeys and reset email move to WorkOS; the Worker only verifies a JWT
(a few ms of CPU) and therefore fits even the Free plan. Trade-off: a new external trust and availability
dependency, per-café tenant configuration, and OAuth callback URLs that must be registered per environment.
Cost: AuthKit is free to 1 M MAU and **staging environments are never billed**; enterprise SSO/SAML
connections are $125/mo each (1–15), Directory Sync the same; custom domain $99/mo.
Complexity: code exists, but it needs a WorkOS application, redirect URIs, six `WORKOS_*` secrets and a
per-café mode switch — a much larger change surface than Option A.

### Option C — operator authentication

WorkOS is **not** wired to the operator console and does not cover it: `/api/operator/*` is protected by
`ADMIN_SECRET`-signed session cookies plus per-session CSRF tokens, with `OPERATOR_PASSWORD` compared in
constant time (no hashing at all). So operator auth is cheap and unaffected by the CPU question; it needs a
separate decision, not a separate technology. For staging the safest state is to leave it closed (`503`)
until the console is needed.

### Recommendation

1. **Near term:** Option A. PaaS cost $5/month, no code change, credentials never leave the deployment, and
   it is the only option that keeps the already-verified F-07 ownership model intact.
2. **Long term (production):** hybrid — keep local Argon2id as the default mode and let a café opt into
   WorkOS via the existing atomic mode switch (Option B) once a tenant exists. That gives the enterprise,
   MFA-bearing path without making it mandatory for a single-café outlet.
3. Rejected: lowering Argon2id parameters or falling back to PBKDF2 (weakens security, prohibited);
   moving hashing to a Durable Object/Queue consumer (same plan CPU budget, adds architecture for nothing).
4. No plan change, parameter change or code change is made here; this is a decision for the owner.

## 2. Secret provisioning plan (staging only, values never generated or shown here)

Mechanism: `wrangler secret put <NAME> --config wrangler.staging.jsonc`. Secrets are per-Worker, so a
staging secret can never reach the production Worker (`corner-cup`, still unconfigured). The operator types
or pastes the value at the prompt (or pipes an already-existing local file); it must never be written into
`wrangler.staging.jsonc`, committed, or pasted into a chat. `.dev.vars` is local-dev only and is not
uploaded.

| Secret | Purpose | Routes that need it | Failure mode if absent |
|---|---|---|---|
| `ADMIN_SECRET` | Signs owner and operator session cookies and CSRF tokens; fallback key for order-tracking tokens | `POST /api/cafes/:slug/admin/login`, `GET …/admin/session`, every authed `/admin/*` mutation, `POST …/owner/logout`, `POST /api/operator/login`, all `/api/operator/*`, `POST /api/cafes/:slug/orders`, `GET /api/cafes/:slug/orders/:id` (tracking token) | 503 "isn't configured on this deployment"; ordering 503 "Ordering isn't configured" |
| `ORDER_TRACK_SECRET` | Optional independent key for guest tracking tokens (`tracking.js` prefers it over `ADMIN_SECRET`) | `POST /api/cafes/:slug/orders`, `GET …/orders/:id` | Falls back to `ADMIN_SECRET`; absent → same 503 as above |
| `OPERATOR_PASSWORD` | Static password for `/operator` (constant-time compare) | `POST /api/operator/login` | 503 "operator password isn't configured" even with `ADMIN_SECRET` set |
| `OWNER_PASSWORD` | **Do not set.** Only seeds the primary café's first hash | first boot only | No effect; `pass_hash` stays `NULL`, owner sign-in fails closed |
| `WORKOS_*` (6) | Managed identity | `/api/cafes/:slug/owner/start`, `/owner/claim/start`, `/api/owner/callback` | 503/409; local mode unaffected |
| `RAZORPAY_*` (3) | Payments | `/orders/:id/payment/razorpay[/verify]`, `/razorpay/webhook` | 503; provider reported as `none` |

Recommended set for a functional staging deploy: `ADMIN_SECRET` + `ORDER_TRACK_SECRET` (independent so a
session-key rotation does not invalidate outstanding guest tracking links) + `OPERATOR_PASSWORD` only if the
console is needed. Provisioning order: set secrets **after** the first successful deploy (the first deploy
does not need them) and rotate by re-running `secret put`; `wrangler secret list` shows names only.

## 3. First-boot write inventory (`ensureDb` → `init`, once per isolate)

Triggered by the **first `/api/*` request of any kind** — including `/api/health` — because `worker/index.js`
calls `ensureDb(env)` before routing. Static assets (`env.ASSETS`) never touch the database.

| Step | Effect on the prepared staging DB | Guard |
|---|---|---|
| `SCHEMA` batch (10) | no-op, every statement `IF NOT EXISTS` | one batch, atomic |
| `migrate()` (41) | 26 `ALTER … ADD COLUMN` raise duplicate-column; each is skipped only after `pragma_table_info` confirms that exact column; other 15 statements are `UPDATE`/`CREATE INDEX IF NOT EXISTS` | per statement |
| `POST_MIGRATIONS` batch (16) | no-op (indexes/triggers already exist) | one batch, atomic |
| `ensurePrimaryCafe` | **inserts 1 `cafes` row**: slug `corner-cup-staging`, name `Corner Cup Staging`, `service_mode 'counter'`, `tz_offset_min 330`, `owner_auth 'local'` | only when `cafes` is empty |
| `adoptLegacySettings` | no-op — no legacy `settings` table (error swallowed by design) | try/catch |
| `bootstrapPrimaryPassword` | **no-op** — `OWNER_PASSWORD` unset, `pass_hash` stays `NULL` | guarded on `pass_hash IS NULL` and a 12–100 char policy |
| `seedMenu` | **inserts 27 `menu_items` rows** for that café | skipped when the café already has rows; one atomic batch |
| `seedTables` | **inserts 8 `tables` rows** (numbers 1–8, ids continuing from `MAX(id)`); runs even in `counter` mode, where the UI never shows them | skipped when the café already has rows |
| `ensureIdempotencyIndex` | **creates** `idx_orders_idempotency_key` (unique, partial `WHERE idempotency_key IS NOT NULL`, on `(cafe_id, idempotency_key)`), then audits it plus `idx_checkout_claims_key` | `IF NOT EXISTS`; on clash/failure it logs and disables ordering instead of failing the request |

Total one-time writes: 1 café + 27 menu items + 8 tables, plus one index. Roughly 36 rows.

**Repeat safety:** `ready` memoises the init promise per isolate, so repeated requests do not re-seed. Every
seed is guarded by its own emptiness check, `pass_hash IS NULL`, or `IF NOT EXISTS`, and the batches are
atomic, so a second cold isolate (or a redeploy) performs no duplicate writes. D1 (`batch`) commits
all-or-nothing per batch, so a failed menu/table seed leaves zero rows from that batch.

**Partial-init recovery:** if `init` throws, `ensureDb` clears `ready` and rejects, so the next request
retries from the top; `idempotencyIndexReady` is reset to `false` first and only set true on a successful
audit, so ordering stays paused (503 via `pausedResponse`) rather than half-configured. Because seeds are
idempotent, a retry after a partial failure converges: an already-inserted café is found by
`SELECT … FROM cafes ORDER BY id LIMIT 1`, an already-seeded menu by its count. The only residue of a
mid-boot failure is an error response for that one request.

Nothing in this list was executed — no request was made against the Worker and no D1 statement was run.

## 4. Deployment and rollback review

Verified state:

- `wrangler.staging.jsonc`: `name corner-cup-staging`, `main worker/index.js`, `compatibility_date 2025-11-01`,
  `rules [{type: CompiledWasm, globs ["**/*.wasm"], fallthrough true}]`,
  `assets {directory ./dist, binding ASSETS, not_found_handling single-page-application, run_worker_first true}`,
  `d1_databases [{binding DB, database_name corner-cup-staging, database_id 39a7899c-0130-4536-9570-f07b6c29b2d4}]`,
  the three staging vars, `observability.enabled true`.
- `wrangler.staging-maint.jsonc`: same name, `main .staging-maint/index.js`, same compatibility date, same D1
  binding, no assets, no wasm rules → emits the 503 stub (verified by dry run in Stage 4: 0.36 KiB bundle).
- D1 id is the exact staging database; neither staging config mentions the production Worker or the
  placeholder production id. Production `wrangler.jsonc` untouched.
- Stage 4 dry run: 8 dist entries, 222.52 KiB / 51.44 KiB gzip, both Argon2id wasm binaries present,
  entry bundle contains `env.ASSETS.fetch` and `ensureDb`, stub string absent.

Deployment commands (not executed):

```bash
npm run build
npx wrangler deploy --dry-run --config wrangler.staging.jsonc   # optional pre-check
npx wrangler deploy --config wrangler.staging.jsonc
```

Rollback commands (not executed):

```bash
npx wrangler deploy --config wrangler.staging-maint.jsonc
# or version-pinned:
npx wrangler rollback a584c608-14ec-42db-b8a9-fffcded4e19d --config wrangler.staging-maint.jsonc
```

Database rollback is normally unnecessary (boot is idempotent). Seed rows can be removed with targeted
`DELETE`s; the last-resort schema restore is the preserved pre-migration export
`corner-cup-staging_pre-migration_20261117T000814.sql`
(`sha256 ebc18cc839e84d2df803d9859561b700cbd302f5c6d107943f81641d6bc94c3e`) — note it predates the Stage 2
completion, so it also reverts those indexes/columns.

## 5. Remaining risks

1. **CPU/plan:** on Free, every Argon2id path (owner login, password set/change, operator reset, café
   creation, and — if `OWNER_PASSWORD` were set — first boot) is expected to fail with Error 1102. Note that
   *without* `ADMIN_SECRET` those paths are unreachable (the 503 check runs before any hashing), so a
   secret-free deploy cannot trigger 1102; the risk materialises the moment secrets are added on Free.
2. **Ordering depends on a secret:** without `ADMIN_SECRET`/`ORDER_TRACK_SECRET`, order creation is 503 —
   staging is browse-only until that decision is made.
3. **First-boot burst:** ~36 rows in three batches plus an index on the first `/api/*` request. Small, but it
   is a real write burst on an otherwise empty DB and on Free it also risks a 1102 on that first request.
4. **Seeding is invisible to guests but real:** an 8-table set exists in `counter` mode; harmless, but it
   will appear in exports and in a later mode switch.
5. **Secret rotation invalidates sessions/CSRF and (if not independent) tracking links** — hence the
   recommendation for a separate `ORDER_TRACK_SECRET`.
6. **WorkOS path untested against a live tenant**; only unit/harness coverage exists today.
7. **No observability alert configured** for 1102 or D1 errors; verification currently relies on manual
   dashboard reads.

## 6. Recommendation

- **Conditional GO** for a *browse-only smoke deploy* on the current Free plan with **no secrets**: static
  SPA, `/api/health`, `/api/cafe`, `/api/cafes/corner-cup-staging/menu|tables|config` are CPU-light; admin,
  operator, owner sign-in and ordering all answer 503, and no hashing path is reachable. This exercises asset
  routing, the D1 binding and first-boot writes without touching Argon2id.
- **NO-GO** for a functional staging environment (owner sign-in, ordering) until both are settled:
  (a) the runtime decision — paid Workers plan (Option A) or WorkOS manager identity (Option B); and
  (b) the approved staging-only secret provisioning in §2.
- No deployment is performed in this stage.

## 7. State

Nothing deployed, published, migrated, seeded, or configured with secrets; no plan change; no code,
parameter or production-config change; no Git operations. Working tree unchanged: 26 modified, 79 untracked
(the Stage 3/4/5 documents and the two staging configs are the untracked additions).
