# STAGE 13.1 — Remediation Plan

**Date:** 2026-11-20
**Status:** proposal only. Nothing in this document has been executed. No deploy, unpublish, secret change,
migration, source edit or Git commit was performed.
**Inputs:** `STAGE13_PRODUCTION_READINESS_AUDIT.md`, `STAGE13_1_SOURCE_PRESERVATION_REPORT.md`,
`STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md`.
**Owner approval required before every section marked ⛔.**

---

## 0. Situation in one table

| # | Exposure | Severity | Evidence strength |
|---|---|---|---|
| E-1 | Public production deployment serving a 2026-11-10 build | Critical | **Proven** (deploy receipt + missing security headers + client markers) |
| E-2 | F-19 password change without current password on that build | High | Inferred (provenance + headers), server bytes not observable |
| E-3 | F-10 no server-side owner-session revocation on that build | Medium-High | Inferred (same) |
| E-4 | Razorpay keys bound on the public deployment | High | **Proven** (binding metadata, values unread) |
| E-5 | Running code cannot be rebuilt from Git (11 untracked modules) | Critical | **Proven** (`git ls-files`) |
| E-6 | Per-request rate-limit writes vs hosting quota | High | **Proven** (code + quota counters) |
| E-7 | Production Wrangler D1 id is a placeholder; deployment path undefined | Critical for launch | **Proven** (`wrangler.jsonc:19`) |

Preservation is already done: `C:\Users\rahil\corner-cup-backups\stage13-1-20261120T114817Z\` (228 files,
manifest `c23a7e07…00d5`, verified).

---

## 1. Source preservation and recovery

**R-1a — Keep the external snapshot immutable** (already created; no action needed beyond discipline)

- **Risk if skipped:** none new; it exists. Risk if mishandled: someone "tidies" the folder and the only complete
  copy disappears.
- **Affected files:** none in the repository. External: `stage13-1-20261120T114817Z/`.
- **Dependencies:** none.
- **Validation:** re-run `verify.mjs` against the live tree; expect `RESULT: VERIFIED` and manifest SHA-256
  `c23a7e076616580378bc738b74dca6fb402a01d8f81d53c906bff994a0de00d5`. Do this before and after any risky step.
- **Approval:** none (read-only verification).

**R-1b — Make the snapshot durable off-device** ⛔

- **Risk:** the snapshot currently lives on the same laptop as the worktree. Disk loss destroys both.
- **Affected files:** none in the repository; the backup archive only.
- **Dependencies:** `7z`/`age` availability (both standard; zero cost), a second device or encrypted cloud drive.
- **Validation:** restore the archive to a scratch directory on the second device, run `verify.mjs`, confirm 228
  files and matching hashes.
- **Approval:** owner (creates an external copy containing source; no secrets inside — `.dev.vars` excluded).

**R-1c — Promote the untracked modules into version control** ⛔ (shared with R-2c)

- **Risk if skipped:** `git clean -fdx`, a fresh clone, or a lost laptop still ends the project. This is the only
  structural risk in this plan that costs nothing to fix.
- **Affected files (12):** `worker/passwords.js`, `worker/session.js`, `worker/tracking.js`, `worker/orderids.js`,
  `worker/owner.js`, `worker/workos.js`, `worker/jwt.js`, `worker/pkce.js`, `worker/revocations.js`,
  `worker/authmode.js`, `src/lib/payments.js`, `src/lib/menuScope.js`. Also currently untracked and needed to
  build/test: `tests/harness/credentials.mjs`, `tests/fixtures/workos.mjs`, `tests/lib/db.mjs`,
  `tests/setup/argon2id-wasm-hooks.mjs`, `tests/setup/register.mjs`.
- **Dependencies:** a clean review of `git status` first (27 modified + ~177 untracked); a decision about which
  `corner-cup-transfer/` copies belong in the repository (recommendation: none — it is a duplicate snapshot).
- **Validation:** fresh clone into a scratch directory → `npm ci` → `npm run build` → `npm test` → 435/435.
- **Approval:** owner. This is the first Git write of the whole engagement and must be an explicit decision.

---

## 2. Production exposure confirmation

**R-2a — Complete the evidence, without touching the deployment** (no approval needed)

- **Risk:** acting on inference when direct proof is cheap to obtain another way.
- **What to obtain:** vendor-side deploy record for `fa58771d-…` showing the exact artifact bytes/hash of the
  2026-11-10 deploy, and the same for the 2026-11-12 preview deploy. Compare those hashes to
  `d51fc7f2…61e6` (production JS) and `e2bb2bcb…6b97` (preview JS).
- **Affected files:** none. Evidence lands in `stage13-1-…/evidence/`.
- **Dependencies:** access to the Sites deployment record (support/API), not to the running app.
- **Validation:** hash match, or documented absence of stored hashes.
- **Approval:** none (read-only).

**R-2b — Decide the fate of the published environments** ⛔ **P0, do first**

Two acceptable options; both stop the exposure:

| Option | Action | Consequence |
|---|---|---|
| **A (recommended)** | Unpublish production and preview (`sites_set_published(published=false)`), keep code, data, secrets and URLs | Serving stops in ~30 s; fully reversible; nothing deleted; the unapproved build is no longer public |
| **B** | Leave published and immediately deploy current code | Requires R-3 prerequisites first (tracked modules, reproducible build, measured auth); doing it before those risks shipping an equally unverified build |

- **Risk of A:** temporary downtime for anyone actually using the site — which is the desired outcome for an
  unapproved deployment.
- **Risk of doing nothing:** the F-19/F-10 pre-fix build stays publicly reachable with payments enabled.
- **Affected configuration:** Sites environments `fa58771d-…` (production) and `f4adb117-…` (preview).
- **Dependencies:** confirmation of who, if anyone, uses the site.
- **Validation:** `sites_list`/`sites_inspect` shows `published: false` and `unpublished_at` set; a `GET /`
  returns the platform's offline response; data and secrets remain listed.
- **Approval:** **owner**, explicitly, and recorded with a timestamp.

**R-2c — Preserve the production database before any change** ⛔

- **Risk:** `site-6e1c6f7a…` (266 KB, 1,580 writes) is outside the Stage 11/12 backup regime. Unpublishing does
  not delete it, but deleting the *site* later would.
- **Affected files:** external export only.
- **Dependencies:** an export path for that D1 (vendor-side export or `wrangler d1 export` if the id is
  reachable from the account).
- **Validation:** export non-empty; import into a disposable local SQLite; 19-table schema check as in Stage 11.
- **Approval:** owner (reads production data).

---

## 3. F-19 and F-10 remediation and deployment

**R-3a — Confirm what the current source actually enforces** (already true; re-assert before shipping)

- F-19: `worker/api.js:2367-2438` (`verifyOwnerReauth`), called at `:2513-2517` before hashing/UPDATE; tests in
  `tests/settings.reauth.test.mjs` (8).
- F-10: `worker/session.js` (`ownerSession` row lookup, 12 h idle + 24 h cap, `deleteOwnerSession`,
  `logoutEverywhere` CAS); tests in `tests/session.revocation.test.mjs`,
  `tests/owner.revocation.test.mjs`, `tests/operator.revocation.test.mjs`.
- **Risk:** none — verification only.
- **Validation:** `npm test` green (435/435 measured 2026-11-20).

**R-3b — Deploy the current build to a non-public environment first** ⛔

- **Risk:** a first-ever deploy of a 3-week-newer tree, including 11 previously untracked modules.
- **Affected files:** the whole `worker/` tree, `dist/` (rebuilt), `wrangler.jsonc`/environment config.
- **Dependencies:** R-1c (tracked modules), R-5a (CI build), R-3c (runtime CPU answer), R-6 (a real D1 id).
- **Validation:** F-19 401-without-write path, F-10 sign-out invalidation, F-04 headers present on every response,
  `/api/health` ok, menu/config correct, cold-start works.
- **Approval:** owner, plus a named deployment window.

**R-3c — Answer the Argon2id runtime question before promising a launch** ⛔

- **Risk:** if sign-in raises Error 1102, the café cannot operate at all. ~47–50 ms measured locally vs 10 ms
  Free-plan CPU.
- **Affected files:** none (measurement), possibly `worker/passwords.js` parameters or the identity design if the
  answer is bad.
- **Dependencies:** an approved deployment target; dashboard CPU/memory metrics; observability on.
- **Validation:** measure p50/p90 sign-in CPU and isolate memory over ≥20 sign-ins, a 6-way burst, and a cold
  start. Record Error 1102 counts.
- **Approval:** owner (deployment required; possibly a plan decision).

**R-3d — Deploy to production only after R-3b and R-3c pass** ⛔

- **Risk:** redeploying to the environment that is currently serving stale code without a proven build repeats
  the original mistake.
- **Validation:** post-deploy header check (all six headers present), F-19/F-10 behavioural checks, and a bundle
  hash recorded in the deployment log so the next audit can prove what is serving.
- **Approval:** owner, explicit go/no-go.

---

## 4. Rate-limit write reduction

### 4.1 The mechanism (unchanged, re-verified)

`routeApi` calls `checkApiRateLimit(request, env)` **before routing** (`worker/api.js:172-179`). That calls
`touchRateLimit` (`:1723-1745`), one `INSERT … ON CONFLICT DO UPDATE … RETURNING` per API request. A 1 % sample
additionally runs `cleanupExpiredRateLimits` (`:1782-1800`), deleting ≤100 expired rows. `Admin.jsx:411` polls
`load()` every 4 s (one `GET /api/cafes/:slug/admin/orders`), and `OrderStatus.jsx:78` polls every 4 s (one
`GET …/orders/:id`).

### 4.2 Projections (one API write per request)

| Open staff boards | Requests/hour | Writes per 8 h shift | Writes per 24 h | Writes/month (8 h × 30 days) | Writes/month (24/7) |
|---:|---:|---:|---:|---:|---:|
| 1 | 900 | 7,200 | 21,600 | 216,000 | 648,000 |
| 5 | 4,500 | 36,000 | 108,000 | 1,080,000 | 3,240,000 |
| 10 | 9,000 | 72,000 | 216,000 | 2,160,000 | 6,480,000 |

Each open **guest order page** adds the same 900 writes/hour as one board. Add up to ~1 % × requests × up to 100
row-deletes/hour for opportunistic cleanup (bounded, usually zero).

### 4.3 Against the limits actually in force

| Host allowance | One board | Five boards | Ten boards |
|---|---|---|---|
| **100,000 writes/month** (current Sites database) | exhausted in **4.6 days** at 24/7, **13.9 days** at 8 h/day | **2.8 days** (8 h/day) | **1.4 days** (8 h/day) |
| **100,000 rows written/day** (Workers Free D1) | 21.6 % of the daily budget (24/7) | **108 % — over** | **216 % — over** |
| 50 M rows read/month (Sites) | fine (≈648 k) | fine | fine |

So on the current hosting a single café exhausts the monthly **write** budget within two weeks; on Workers Free
the design survives one board per shift but not five. This is a capacity limit, not a correctness bug — and it
fires *before* the café does anything unusual, purely from polling.

### 4.4 Options (design only; nothing implemented)

| # | Option | Effect | Cost / risk |
|---|---|---|---|
| **A** | Rate-limit only state-changing methods (`POST`/`PATCH`/`DELETE`); apply a separate, cheaper guard to reads | board polling stops writing entirely — the dominant term disappears | Small, contained change in `routeApi` + `checkApiRateLimit`; must keep login/checkout/payment limits intact |
| **B** | In-isolate memo of the limiter decision (Map, 5–10 s TTL) | 900 → ~90–180 writes/h per isolate | Approximate across isolates; never stricter than intended, never weaker for mutations if scoped to GETs only |
| **C** | Poll every 15–30 s instead of 4 s, with `ETag`/`If-None-Match` returning 304 | 900 → 240/120 requests/h; with A, 0 writes | Slightly slower board updates; 304 still counts as a request and still runs the limiter unless A is applied first |
| **D** | Move counters to a Durable Object (one row per key per window, alarms for expiry) or KV with TTL | Writes become independent of request volume | Durable Objects need a paid plan; KV adds an eventually-consistent path — must not weaken login lockout |
| **E** | Push updates (DO + WebSocket/SSE) instead of polling | removes most requests entirely | Largest change; paid-plan DO; not needed for a pilot |

Recommended zero-cost sequence: **A, then C**, with **B** as an optional belt-and-braces step. Measure with the
same table in §4.2 afterwards.

- **Risk:** weakening brute-force protection if the limiter is skipped too broadly. Login, re-auth, checkout and
  payment limits must stay on writes and on any unauthenticated POST.
- **Affected files:** `worker/api.js` (`routeApi`, `checkApiRateLimit`, `touchRateLimit`), `src/pages/Admin.jsx`
  (poll interval), `src/pages/OrderStatus.jsx` (poll interval), `tests/rate.limit.test.mjs`,
  `tests/rate.limits.migration.test.mjs`.
- **Dependencies:** a chosen host (quota differs by host, see §4.3).
- **Validation:** re-run the rate-limit and auth suites; a soak test with 5 simulated boards for 1 hour showing
  zero limiter writes for GETs and unchanged 429 behaviour on login/checkout.
- **Approval:** owner (behaviour and protection trade-off).

---

## 5. Build reproducibility and Git source preservation

**R-5a — Track the modules and add a clean-clone build gate** ⛔ (same change as R-1c)

- **Risk:** without it, every future audit re-discovers that the repo cannot build.
- **Affected files:** the 12 modules + 5 test helpers listed in R-1c; `.gitignore` (so `sites-build/` and
  `dist/` stay out while no source file is ignored).
- **Validation:** fresh clone → `npm ci` → `npm run build` → `npm test`; assert 435/435 and that
  `worker/session.js` resolves.

**R-5b — Add CI: build, test, audit, provenance** ⛔

- **Risk:** the exact drift this stage found recurs silently.
- **Affected files:** new `.github/workflows/ci.yml` (or equivalent), no product code.
- **Validation:** CI green on a PR; deliberately break an import to confirm CI fails.
- **Note:** the Argon2id wasm import needs the same loader hook the test suite uses; CI must run on a platform
  where that works (documented in `tests/setup/register.mjs`).

**R-5c — Embed and enforce a build stamp** ⛔

- **Risk:** "what is deployed?" remains unanswerable.
- **Affected files:** `vite.config.js` (inject `__BUILD_COMMIT__`/`__BUILD_TIME__`), `src/main.jsx` (expose it in a
  comment/console line or an `/api/health`-adjacent field), `worker/index.js` (optional header).
- **Validation:** deployed HTML/JS contains the commit; a provenance check compares the deployed bundle hash with
  the CI artifact hash.

**R-5d — Guard `npm run deploy`** ⛔

- **Risk:** `package.json:11` runs `vite build && wrangler deploy` with no `--config`, targeting production and its
  placeholder D1.
- **Affected files:** `package.json` scripts; optionally a preflight script under `scripts/`.
- **Validation:** attempting to deploy with the placeholder id or a dirty tree fails with a clear message.

---

## 6. Production D1 placeholder resolution

**R-6 — Decide and record the production database** ⛔

- **Risk:** `wrangler.jsonc:19` is `00000000-0000-0000-0000-000000000000`. Any production deploy either fails or
  binds nothing. Meanwhile the *actual* production-like data lives in `site-6e1c6f7a9a9f4e098f778f9754221b0a`
  (Sites) — an unmanaged database with no backup.
- **Decide:** is production (a) the Sites deployment, (b) a new Worker `corner-cup` with its own D1, or (c) both
  with a documented migration between them?
- **Affected files:** `wrangler.jsonc` (`database_name`, `database_id`), possibly `wrangler.staging*.jsonc` for
  consistency, plus documentation of the chosen origin.
- **Dependencies:** R-2b (what happens to the Sites environments), R-2c (export before changing anything),
  a created D1 whose id is recorded.
- **Validation:** `wrangler deploy --dry-run` shows `env.DB → <real name>`; one `/api/health` returns
  `database: ok`; `PRAGMA integrity_check` on the target is `ok`; 19-table schema matches.
- **Approval:** owner — this is the production-target decision the project has deferred since Stage 4.

---

## 7. Execution order and gates

| Step | Item | Blocks | Gate |
|---|---|---|---|
| 1 | R-2b unpublish (or explicit accept-the-risk decision) | everything else | owner, same day |
| 2 | R-2c export the Sites database | any change to that environment | owner |
| 3 | R-1b off-device copy of the snapshot | data-loss exposure | none (cost only) |
| 4 | R-1c / R-5a track modules + clean-clone build | any credible deploy | owner (first Git write) |
| 5 | R-5b/R-5c/R-5d CI + build stamp + deploy guard | repeatability | owner |
| 6 | R-3c Argon2id measurement on a non-public Worker | launch viability | owner (deploy) |
| 7 | R-4 rate-limit fix + soak test | hosting quota | owner |
| 8 | R-6 production D1 decision | production launch | owner |
| 9 | R-3b then R-3d staged deploy and verification | first café | owner go/no-go |

**Nothing above is started.** The only completed work in Stage 13.1 is the preservation backup (R-1a) and the
read-only exposure investigation.
