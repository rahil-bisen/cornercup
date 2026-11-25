# STAGE 13 — Comprehensive Production Readiness Audit

**Date:** 2026-11-20
**Mode:** strictly read-only. No source edit, no config edit, no migration, no deploy, no secret read, no
authentication, no payment, no order, no deletion, no Git mutation.
**Subject:** Corner Cup multi-tenant café ordering (React/Vite + Cloudflare Workers + D1).
**Verdict in one line:** the *code* is strong and its test suite is genuinely green; the *deployment posture*
is not ready — a public production site is serving a pre-remediation build, the recoverable source of truth is
incomplete, sign-in cost is unmeasured on the runtime, and backups are a single plaintext file on one laptop.

---

## 1. Executive summary

Corner Cup is a well-built single-café ordering application with unusually disciplined security engineering for
its size: per-café Argon2id credentials, HMAC-derived guest tracking tokens that are never stored in plaintext,
server-authoritative pricing, one-statement idempotent checkout, D1-backed rate limiting, server-side session
allowlists, CSRF bound to session identity, streaming body limits, and a security-header set with no
`unsafe-inline`. All twenty tracked findings (F-01…F-20) are addressed in the current working tree, and the full
local suite passes **435/435 with zero skips** in 83.7 s against two real `workerd` harnesses.

That is the good news. The audit found four things that make "ready to onboard its first real café" a **no**:

1. **A public production deployment is live, and it predates the fixes.** The Sites project
   `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63` ("Corner Cup Café — Razorpay") reports
   `published: true` for **production** (deployed 2026-11-10) and for **preview** (deployed 2026-11-12), with
   12,320 requests and 207,464 D1 rows read this month. The repository's own Sites build artifact
   (`sites-build/index.js`, 2026-11-12) contains **none** of the F-19 re-authentication gate, **no**
   `owner_sessions` table usage, and **no** WorkOS identity columns. This contradicts the recorded decision
   "no production deployment has been approved" and means the public site likely runs code with the exact
   F-19 credential-takeover gap that was closed in source on 2026-11-15.
2. **The repository cannot rebuild the application.** Eleven security-critical modules are untracked:
   `worker/passwords.js` (all Argon2id), `worker/session.js` (sessions + CSRF), `worker/orderids.js`,
   `worker/tracking.js`, `worker/owner.js`, `worker/workos.js`, `worker/jwt.js`, `worker/pkce.js`,
   `worker/revocations.js`, `worker/authmode.js`, plus `src/lib/payments.js` and `src/lib/menuScope.js`.
   `worker/api.js` imports them, so a fresh clone fails to build. A `git clean -fdx` destroys the running system.
3. **Sign-in cost is still unmeasured on the deployed runtime.** Argon2id at m=19 MiB, t=2 takes ~47–50 ms of
   local CPU against a Workers **Free** budget of 10 ms. An owner who cannot sign in cannot operate a café.
4. **The per-request rate limiter writes to D1 on every API call**, and both the staff board and the guest
   order page poll every 4 s. One open board is ~900 writes/hour, ~21,600/day. The current Sites database
   allowance is **100,000 writes per month** (1,580 used), so a single café board exhausts it in days.

Everything else is ordinary product/workflow debt (no analytics history, no modifiers, no membership UI, no
refund path) that matters for a launch but does not by itself risk a café's data or money.

## 2. Overall readiness rating

| Dimension | Rating | Basis |
|---|---|---|
| Application security (code) | **Strong** | 20/20 findings addressed in source; 435 tests; 0 audit vulnerabilities |
| Application security (deployed) | **FAIL** | Published build predates F-19/F-10/F-07-2B fixes |
| Production infrastructure | **FAIL** | Two conflicting deployment paths; production Wrangler DB id still a placeholder; public Site unapproved |
| Authentication readiness | **PARTIAL** | Local mode verified locally; WorkOS unverified; no TOTP; runtime CPU unmeasured; deployed build behind |
| Payments / order lifecycle | **PARTIAL** | Order lifecycle and idempotency strong; Razorpay correctly disabled but unproven end to end; no refunds/reconciliation |
| Product onboarding | **PARTIAL** | End-to-end journey exists; several steps require manual operator work; no membership UI |
| Operational recovery | **PARTIAL** | Stage 11 restore proven; Stage 12 policy documented but nothing automated, encrypted or off-device |
| Testing & quality | **Strong (local)** | 435/435, build green, audit clean; no E2E browser/load coverage, harness-dependent |

**Overall: NOT READY — NO-GO for first-café onboarding.**

Technical readiness and business/operational readiness are both insufficient, for different reasons:

- **Technical:** deployed-code drift, unrebuildable repository, unmeasured auth CPU, rate-limit write
  amplification, placeholder production D1.
- **Business/operational:** a live production site exists without approval and without any recorded owner,
  support process, monitoring/alerting, or recoverable backup; the single operator is also the only person who
  can restore anything.

## 3. Production infrastructure findings

### 3.1 Wrangler configuration as it stands

| Config | Worker | Entry | D1 binding | Notes |
|---|---|---|---|---|
| `wrangler.jsonc` | `corner-cup` | `worker/index.js` | `DB` → `corner-cup` / `00000000-0000-0000-0000-000000000000` | **Placeholder id — still true today.** SHA-256 `3df6a29e…96a0` |
| `wrangler.staging.jsonc` | `corner-cup-staging` | `worker/index.js` | `DB` → `corner-cup-staging` / `39a7899c-0130-4536-9570-f07b6c29b2d4` | SHA-256 `7f59ffc1…5718` (unchanged since Stage 6) |
| `wrangler.staging-maint.jsonc` | `corner-cup-staging` | `.staging-maint/index.js` | staging DB | 503 stub; SHA-256 `58c011dc…2084` |

- **Production D1 placeholder: CONFIRMED STILL PRESENT.** `wrangler.jsonc:19` is
  `00000000-0000-0000-0000-000000000000`. Deploying production as configured cannot bind a real database.
- **No `env` blocks** anywhere: each file is a whole environment; "production" and "staging" are separate
  Workers, not Wrangler environments.
- **Compatibility:** `2025-11-01` everywhere, **no `compatibility_flags`**.
- **Rules:** `CompiledWasm` on `**/*.wasm` with `fallthrough: true` (Argon2id's two pre-compiled modules).
- **Assets:** `./dist`, binding `ASSETS`, SPA fallback, `run_worker_first: true`; the maintenance stub has none.
- **Routes / custom domains:** none. No `routes`, no `custom_domains`, no `workers_dev: false`. Public origin is
  the `workers.dev` hostname derived from the Worker name.
- **Vars:** `CAFE_NAME`, `SERVICE_MODE` (`counter`), `CAFE_TZ_OFFSET_MIN` (`330`) — first-boot values only; the
  database wins once a café row exists.
- **Observability:** `enabled: true` in all three configs (that is logging/tail only — no alerting).

### 3.2 A second, live deployment path exists — and it is the one in production

This is the most consequential infrastructure finding.

| Evidence | Value |
|---|---|
| `sites.manifest.json` | `entrypoint: index.js`, `assetsDirectory: ./dist`, `spa: true`, module `./sites-build/index.js` |
| `sites-build/index.js` | 99,986 bytes, generated **2026-11-12T16:04**, README says "built output assets for the worker `corner-cup`" |
| `site.json` | site `6f1c2a48-…`, production `https://site-fa58771d25fb4936bbad5cffd6ff3973.freebuff.page`, preview `https://site-f4adb11790b449ea9193aefa06b95d50.freebuff.page` |
| Sites metadata (read-only) | production: `published: true`, `deployed_at 2026-11-10T07:48Z`; preview: `published: true`, `deployed_at 2026-11-12T10:35Z` |
| Sites DB allowance used | `d1Bytes 266,240`; `d1Reads 207,464`; `d1Writes 1,580`; `cpuMs 36,171.71`; site `requests 12,320` this month |
| Earlier site `4a2196dc-…` | production and preview both `published: false` since 2026-11-09T16:30Z (unpublished, not deleted) |

Consequences:

1. **A public production URL is live** and serving traffic, while the project decision on record is "no
   production deployment has been approved". Whether an owner has been told, whether the data in it is real,
   and who is accountable are all **UNVERIFIED**.
2. **The deployed artifact is older than the security fixes.** Marker comparison between the repository's Sites
   build and the current `worker/` sources:

   | Marker | `sites-build/index.js` | current `worker/` |
   |---|---|---|
   | `currentPassword` (F-19 gate) | **0** | 1 |
   | `verifyOwnerReauth` | **0** | 2 |
   | `reauth_required` | **0** | 1 |
   | `owner_sessions` (F-10 revocation) | **0** | 26 |
   | `counterPaymentStatement` (F-03 atomicity) | **0** | 3 |
   | `workos_user_id` (F-07 phase 2) | **0** | 20 |
   | `payment_status != 'confirmed'` | 2 | 7 |

   Both published environments were deployed **before** 2026-11-15/16, when F-19, the F-03 counter-payment
   atomicity fix and the owner-session allowlist landed. On this evidence the public build still allows a
   password change from a session alone — the F-19 vulnerability — and lacks server-side session revocation.
   The exact bytes serving today are **UNVERIFIED** (that would require reading production).
3. **Two deployment procedures, no single source of truth.** `npm run deploy` runs
   `vite build && wrangler deploy` against `wrangler.jsonc` (production, placeholder DB → would fail or bind
   nothing), while the live site was produced through the Sites manifest from a **checked-in, stale build
   directory**. Neither path documents "how to ship the current code", and the live one ships a snapshot.
4. **The Sites database is a separate D1** (`d1Bytes 266,240`, similar in size to staging's 241,664) with no
   recorded id, no backup, and no migration history in the repository. Its schema state is **UNVERIFIED**.

### 3.3 Build and scripts

- `npm run build` → Vite 6: **104 modules, exit 0**, `index.html` 0.81 kB, CSS 28.81 kB (6.39 kB gzip),
  JS 277.53 kB (89.75 kB gzip). Verified in this audit into an isolated outDir so `dist/` was not rewritten.
- `npm run dev` → build + `wrangler dev` on `:3000`; `npm start` → dev without rebuild.
- `npm run deploy` → build + `wrangler deploy` **without `--config`** → production file, placeholder DB.
- `npm test` → Node test runner with the Argon2id wasm loader hook.
- No CI configuration, no deploy lock, no environment promotion, no release tagging.

### 3.4 Infrastructure findings table

| # | Finding | Severity | Evidence |
|---|---|---|---|
| I-1 | Production Sites deployment is publicly published, contrary to the recorded no-production decision | **BLOCKER** | Sites metadata `published: true`; `site.json` |
| I-2 | The published build predates F-19/F-10/F-03-atomic/F-07-2B fixes | **BLOCKER** | marker counts above |
| I-3 | Eleven critical modules are untracked; a clone cannot build | **BLOCKER** | `git ls-files` on `worker/passwords.js` etc. |
| I-4 | Production Wrangler D1 id is still the placeholder | **BLOCKER** (for a production launch on Workers) | `wrangler.jsonc:19` |
| I-5 | Two deployment paths; a checked-in stale build is the live one | HIGH | `sites.manifest.json`, `sites-build/`, `package.json` |
| I-6 | No recorded D1 id/schema for the live Sites database; no backup of it | HIGH | Site metadata only |
| I-7 | No CI, no release process, no environment promotion | MEDIUM | repository |
| I-8 | `npm run deploy` targets production with no guard | MEDIUM | `package.json:11` |
| I-9 | Staging Worker version may have drifted since Stage 6 (`c1204e32…`) | MEDIUM (UNVERIFIED) | Stage 6 record; not re-checked (no account reads) |

## 4. F-01 … F-20 security status

Status vocabulary: **FIXED** = verified in current source with tests that fail if the control is removed;
**PARTIALLY FIXED** = control present, a production-relevant property unverified; **OPEN**; **NOT REPRODUCIBLE**.

| ID | Finding | Orig. sev. | Status | Blocks onboarding? |
|---|---|---|---|---|
| F-01 | Deployment-wide fallback password | Critical | **FIXED** | No |
| F-02 | Guest order-tracking credential | High | **FIXED** | No |
| F-03 | Unauthenticated payment status/method mutation | High | **FIXED (source)** | No — but see I-2 (deployed build lacks the atomic counter fix) |
| F-04 | Security headers | Medium | **FIXED** | No |
| F-05 | Operator create-café CSRF | High | **FIXED** | No |
| F-06 | D1-backed rate limiting | Medium | **FIXED** (correctness) / **HIGH operational cost** | Yes — capacity, see C-4 |
| F-07 | Password hashing + managed identity | Critical → Medium | **PARTIALLY FIXED** | Yes — runtime CPU, see C-3 |
| F-08 | Unbounded request bodies | High | **FIXED** | No |
| F-09 | Razorpay validation / production readiness | High → Low (disabled) | **PARTIALLY FIXED** | No, while disabled |
| F-10 | Owner/operator session revocation | High | **FIXED (source)** | No — but deployed build lacks it (I-2) |
| F-11 | Cookie-name truncation collision | Medium | **FIXED** | No |
| F-12 | Malformed cookie parsing | Medium | **FIXED** | No |
| F-13 | PhonePe removal | Medium | **FIXED** (one dead CSS rule) | No |
| F-14 | Order-ID collision retry | Medium | **FIXED** | No |
| F-15 | Health endpoint disclosure | Low | **FIXED** | No |
| F-16 | Dependency vulnerabilities | Medium | **FIXED** (re-verified today) | No |
| F-17 | Google Fonts privacy | Low | **FIXED** | No |
| F-18 | Public menu/table data exposure | Medium | **FIXED** | No |
| F-19 | Owner password change without current password | High | **FIXED (source)** / **present in deployed build** | Yes — via I-2 |
| F-20 | Browser observation finding | Medium | **FIXED (static)** | No |

Summary: **18 FIXED, 2 PARTIALLY FIXED, 0 OPEN in source.** The drift risk is not the source — it is what is
serving (I-2).

### F-01 — Deployment-wide fallback password (Critical) — FIXED

`login()` (`worker/api.js:1804`) consults **only** `cafe.pass_hash`. A café with no hash gets
503 "ask the operator to reset it", never a shared secret. `ADMIN_PIN` is not read anywhere.
The only bootstrap is `bootstrapPrimaryPassword` (`worker/db.js:341-388`), which is guarded by
`pass_hash IS NULL`, applies the 12–100 character policy, and can only touch the primary café.
Tests: `auth.fallback`, `auth.empty-login`, `migrations`. Exploitability: none found. No action needed.

### F-02 — Guest tracking credential (High) — FIXED

`worker/tracking.js`: token = `base64url(HMAC-SHA256(key, "v1:<cafe>:<order>:<nonce>"))`, 192-bit nonce,
key = SHA-256 of a versioned domain string plus `ORDER_TRACK_SECRET || ADMIN_SECRET`; D1 stores only
`sha256(token)`. `worker/api.js` reads it from the `x-order-token` header only, compares constant-time, and
answers one generic 404 for missing/wrong/cross-order/cross-café. Impact if broken: read + pay-at-counter on one
order. Residual (accepted, unchanged): tokens never expire. Not a blocker.

### F-03 — Unauthenticated payment/status mutation (High) — FIXED in source

`submitPayment` (`worker/api.js:1247`) accepts exactly `{status:"counter"}` for an order the caller can already
track, and writes through `counterPaymentStatement` (`worker/orders.js:259`), whose
`AND payment_status != 'confirmed'` guard is evaluated inside the UPDATE. Staff downgrades are guarded by
`staffOrderUpdateStatement` + `paymentStatusSets` (`worker/orders.js:236-264`) and answered 409
`payment_already_confirmed`. `canTransitionStatus` (`worker/api.js:85`) enforces single-step status moves.
**Note:** the deployed Sites build contains no `counterPaymentStatement`, so the read-then-write race this fixed
may still exist publicly (I-2). Source: no action. Deployment: covered by C-1.

### F-04 — Security headers (Medium) — FIXED

`worker/http.js:20-62`: CSP `default-src 'self'` with `frame-ancestors 'none'`, `object-src 'none'`,
`base-uri 'self'`, `form-action 'self'`, no `unsafe-inline`/`unsafe-eval`; HSTS 1 year + includeSubDomains;
`nosniff`; `X-Frame-Options: DENY`; `strict-origin-when-cross-origin`; a permissions policy; `cache-control:
no-store` on JSON. `withSecurityHeaders` wraps static assets in `worker/index.js:19`.
Residual: `script-src`/`frame-src`/`connect-src` allowlist `checkout.razorpay.com` even while payments are off —
small, deliberate, documented. Not a blocker.

### F-05 — Operator create-café CSRF (High) — FIXED

`operatorCreateCafe` (`worker/api.js:573-580`) calls `verifyCsrf` **before** `readJson`. `verifyCsrf`
(`worker/session.js`) requires `Origin` to equal the request origin (rejecting `null`), a non-empty
`x-csrf-token`, and a live `csrf_tokens` row whose `operator_key_hash` matches the session binding, compared
constant-time. Reset-password uses the same gate. Not a blocker.

### F-06 — D1-backed rate limiting (Medium correctness, HIGH cost) — FIXED / cost open

Correctness is solid: one atomic upsert with `RETURNING` (`worker/api.js:1723`), capped count, window reset in
the same statement, fail-closed 503 on store error (`checkApiRateLimit`, `:1755`), IPs hashed before storage
(`clientIpHash`), and bounded 1 %-sampled cleanup of ≤100 expired rows (`:1782`).

**The operational defect is the write amplification**: `routeApi` calls `checkApiRateLimit` on **every** API
request before routing (`worker/api.js:172-179`), and each call performs an `INSERT … ON CONFLICT DO UPDATE` on
`rate_limits`. Both the staff board (`src/pages/Admin.jsx:411`, `setInterval(load, 4000)`) and the guest order
page (`src/pages/OrderStatus.jsx:78`, `setInterval(run, 4000)`) poll every 4 s.

| Scenario | Requests/hour | D1 row writes/day |
|---|---:|---:|
| One staff board open | 900 | 21,600 |
| Board + one guest tracking page | 1,800 | 43,200 |
| Board (8 h shift, 30 days) | — | ~216,000/month |

The live Sites database allowance is **100,000 writes/month** (1,580 used); Workers Free D1 allows 100,000
writes/day. On the current hosting, one café's board exhausts the monthly write budget well inside a week. This
is a **capacity blocker** for onboarding on that platform (C-4), not a security defect. Fix direction: cache the
limiter decision per isolate for a few seconds, skip the limiter for cheap GETs on cache-able routes, or move
polling to a cheaper signal (ETag/`If-None-Match`, longer interval, or `wrangler`-side counter with KV).

### F-07 — Password hashing and managed identity (Critical → Medium) — PARTIALLY FIXED

Implemented and locally verified:

- **Argon2id** `m=19456 KiB, t=2, p=1`, 16-byte salt, 32-byte tag, PHC string; parameters allow-listed per hash
  (`worker/passwords.js:12-14, 124-137`), so a weaker stored hash is never honoured.
- Bounded hashing: one derivation per isolate + `MAX_QUEUE = 3`, overflow → `PasswordQueueFullError` → 429
  (`worker/passwords.js:100-121`; `worker/api.js` login/reauth map it).
- Legacy PBKDF2 verified only ≤100,000 iterations; higher fails closed with a 409 operator-reset message
  (`passwordNeedsReset`, `worker/passwords.js:179`), and a successful legacy verify is opportunistically
  rehashed with a compare-and-swap that deliberately leaves `auth_version` alone.
- Managed identity: RS256 only with `alg` compared before key import (`worker/jwt.js:12`), single-string
  `iss`/`aud`, `kid` required, one refetch on unknown key, bounded skew; PKCE S256 with the verifier sealed
  under AES-256-GCM + HKDF (`worker/pkce.js:54-113`); single-use state; `email_verified` enforced
  (`worker/owner.js:302`); membership decided by SQL against `cafe_owners`
  (`worker/owner.js:348-353, 366-375`); durable revocation queue with 5 attempts / 24 h / lease
  (`worker/revocations.js`).

Unverified (and therefore not claimed):

- **Cloudflare CPU and memory on a deployed Worker.** Local measurement is ~47–50 ms per derivation against a
  Free-plan 10 ms request CPU budget; the wasm instance is ~65 MB plus ~19 MiB per derivation against a 128 MB
  isolate. A Free-plan sign-in is expected to raise Error 1102. **This is a launch blocker** (C-3) because it
  governs whether an owner can sign in at all.
- **The provider contract** (real issuer/audience/`sid`, code lifetime, revoke semantics, JWKS rotation,
  rate limits). No sandbox run is on record as passed, and the deployed build has no managed-auth code.
- **TOTP does not exist.** A repository-wide search for `totp|otpauth|hotp|authenticator|mfa` across
  `worker/`, `src/` and `package.json` returns nothing. The long-term MFA intent is unimplemented.
- **Firebase does not exist in code.** `firebase` appears only in planning documents; no dependency, no config,
  no `FIREBASE_*` variable. Any Firebase work is greenfield and would duplicate the WorkOS path.

### F-08 — Unbounded request bodies (High) — FIXED

`worker/http.js:88-185`: a single streaming reader with per-route budgets (`BODY_LIMITS`, 512 B … 64 KiB),
`Content-Length` treated only as an early hint, one byte over refused with reader cancellation, one generic 413
that names no limit (`handleApi`), and every handler passing an explicit budget. No `request.json()` /
`request.text()` in `worker/`. Not a blocker.

### F-09 — Razorpay validation / production readiness (High → Low while disabled) — PARTIALLY FIXED

Correctly **disabled**: `razorpayConfigured()` requires both key id and secret (`worker/api.js:654`);
`paymentProvider()` returns `"none"` otherwise; `/payment/razorpay`, `/verify` and both webhook spellings answer
503 while unconfigured.

Controls verified in source: gateway order created server-side from the stored total (client body not read for
amount/currency); tracking token required; `payment_ref` binding (`order.payment_ref !== razorpayOrderId` → 409);
HMAC-SHA256 over `order|payment` compared constant-time; payment re-fetched from Razorpay and required to be
`captured`, same `order_id`, `INR`, and **exactly** `total_cents`; single conditional settle
(`markRazorpayPaid`, `WHERE payment_status != 'confirmed'`); webhook verifies the raw body against
`x-razorpay-signature` with `RAZORPAY_WEBHOOK_SECRET` and acknowledges amount mismatches; `payment.failed` only
moves a non-confirmed ticket.

Not implemented (would become High the moment keys are set): refunds, partial payments, chargeback handling,
reconciliation of gateway captures against settled orders, receipt email, per-café gateway credentials, and any
live end-to-end proof. Also, the server accepts `paymentMethod: "razorpay"` on order creation even when no
gateway is configured (`worker/orders.js:12-31` defaults any non-`counter` value to `razorpay`), producing a
ticket that cannot be paid online; staff can still settle it manually. The guest UI picks the rail from
`config.payments` (`src/pages/Menu.jsx:203-210`), so only a hand-crafted request hits that state.

### F-10 — Owner/operator session revocation (High) — FIXED in source

`worker/session.js`: owner subjects are `cafe:<id>:<version>:<sessionId>` with a 32-hex id, and every owner
request must resolve a live `owner_sessions` row (`SELECT … WHERE session_id = ? AND cafe_id = ? AND expires > ?
AND created > ?`). Two limits in SQL: a 12-hour idle window and a 24-hour absolute cap. A store error returns 503
`SESSION_STORE_DOWN`, never a silent 401. Ordinary sign-out deletes that one row plus both CSRF bindings;
logout-all bumps `auth_version` through a CAS and reissues the caller's session. Operator sessions are a separate
D1 allowlist. **The deployed Sites build has no `owner_sessions` usage at all** (I-2).

### F-11 — Cookie-name truncation collision (Medium) — FIXED

`cookieName` uses the full slug (`worker/session.js:50`); `slugify` caps slugs at 40 characters
(`worker/db.js:289`), so `staff_session_<slug>` is ≤54 characters and needs no truncation. Not a blocker.

### F-12 — Malformed cookie parsing (Medium) — FIXED

`readCookie` (`worker/session.js:19-36`) skips a value whose `decodeURIComponent` throws and keeps scanning;
missing `=` and duplicate names are handled deterministically. A malformed cookie cannot 500 or authenticate.
Not a blocker.

### F-13 — PhonePe removal (Medium) — FIXED

`grep -rn phonepe worker src tests index.html` → one match: `src/styles.css:1610` (`.upi-app.phonepe`), dead CSS
with no runtime effect. No route, handler, client path, config, or credential. Low-priority cleanup.

### F-14 — Order-ID collision retry (Medium) — FIXED

`worker/orderids.js`: 32-character unambiguous alphabet (uniform `byte % 32`), 6 then 8 characters, bounded
attempts (6 + 3), pre-check plus PK-collision recovery, `isOrderIdCollision` deliberately narrow. `createOrder`
(`worker/api.js:1000-1046`) retries at most 4 times with a **fresh** id, nonce, token and hash each attempt,
releases the idempotency claim on exhaustion and answers 503. Order + items + commit marker are one D1 batch.
Not a blocker.

### F-15 — Health endpoint disclosure (Low) — FIXED

`health()` (`worker/api.js:692-710`) returns only `{status, database, time}` and 503 when the DB probe fails; the
error is logged server-side, never returned. Not a blocker.

### F-16 — Dependency vulnerabilities (Medium) — FIXED (re-verified)

`npm audit --json` today: `{info:0, low:0, moderate:0, high:0, critical:0, total:0}` over 265 dependencies
(40 prod, 226 dev). Direct deps: `argon2id@1.0.1`, `qrcode`, `react`, `react-dom`, `react-router-dom@7.18.5`.
An audit is a snapshot; rerun after any dependency change. Not a blocker.

### F-17 — Google Fonts privacy / self-hosting (Low) — FIXED

No `googleapis`/`gstatic` reference in `src/`, `index.html` or `worker/`; fonts are self-hosted under
`public/fonts/` (two WOFF2 + OFL licence); CSP `font-src 'self' data:`. Not a blocker.

### F-18 — Public menu/table data exposure (Medium) — FIXED

Public payloads are explicit allow-lists: `getMenu` returns
`{id, name, description, priceCents, emoji, available}` grouped into categories plus a table
`{id:number, label, seats}` (`worker/api.js:603-651`); `getTables` returns `{number, label, seats}`;
`publicCafe` returns `{slug, name, serviceMode}`; `/api/config` returns name, contacts, service mode,
`ownerAuth` label and the **public** `RAZORPAY_KEY_ID` only when configured. Unknown slug → 404, never another
tenant. Not a blocker.

### F-19 — Owner password change without current password (High) — FIXED in source, PRESENT in deployed build

`verifyOwnerReauth` (`worker/api.js:2367-2438`) runs in `adminSaveSettings` **before** hashing or any UPDATE
(`:2513-2517`): missing → 400, wrong → 401 with `code: "reauth_required"` and nothing written, no/unsupported
hash → 409 operator reset, 5 failures / 10 min per café+IP → 429, store failure → 503. The credential UPDATE is
guarded by `auth_version`. The UI shows a "Current owner password" field only while a new password is typed
(`src/pages/Admin.jsx`), and the shell treats `reauth_required` as a message, not a session end.

**But `sites-build/index.js` contains zero occurrences of `currentPassword`, `verifyOwnerReauth` or
`reauth_required`.** The publicly published build therefore appears to allow a password change from a session
alone — the exact takeover path F-19 closed. This is a **BLOCKER** (C-1), by deployment, not by code.

### F-20 — Browser-observable security (Medium) — FIXED (static)

No credential in `localStorage`/`sessionStorage`: `admin_token` is only ever removed (`src/pages/Admin.jsx:25`);
`sessionStorage` holds only the checkout idempotency key + body (`src/lib/checkout.js`) — no credential. The
session is `HttpOnly; SameSite=Strict; Path=/` (`Secure` over https). The guest token is read from the URL
fragment only. No `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function` or `document.write` in
`src/` or `worker/`. Residual: a fragment token is visible to whoever holds the device. Not a blocker.

## 5. Authentication readiness

| Capability | State | Evidence |
|---|---|---|
| Local owner password (per café, Argon2id) | **Implemented and verified locally** | `worker/passwords.js`, `worker/api.js:1804`; `auth.*`, `settings.reauth`, `argon2.passwords` |
| Operator console password | **Implemented and verified locally** | `OPERATOR_PASSWORD` compared in `operatorLogin`; separate D1 session allowlist |
| Guest accounts | **Intentionally absent** | ordering needs no account |
| WorkOS managed owner auth (OIDC + PKCE) | **Implemented, UNVERIFIED against a provider** | `worker/workos.js`, `jwt.js`, `pkce.js`, `owner.js`, `revocations.js`; `cafe_owners` membership SQL |
| Firebase | **Planned only — no code** | grep: docs only; no dependency, no config |
| TOTP / MFA | **Not implemented** | grep `totp|otpauth|hotp|mfa` → none |
| Email verification | **Implemented (managed mode only)** | `worker/owner.js:302` |
| Password hashing cost on the deployed runtime | **UNVERIFIED — likely fails on Free** | ~47–50 ms local vs 10 ms Free CPU |
| Session expiry | **Implemented** | 12 h idle + 24 h absolute, both in SQL (`worker/session.js`) |
| Session revocation | **Implemented (source)** | per-session row delete; logout-all CAS; operator allowlist |
| CSRF | **Implemented** for credential mutations | `verifyCsrf`: Origin + hashed token bound to session; logout relies on Origin + SameSite (N-01, accepted) |
| Membership / roles | **Implemented in SQL, no UI** | `cafe_owners(cafe_id, workos_user_id, role)`; operator grant/revoke routes exist; `Operator.jsx` has none |
| Multi-café identity | **Implemented and tested** | one identity may own several cafés; sessions carry café + identity; cross-tenant cookies 401 |
| Account recovery | **Operator reset only** | `/api/operator/cafes/:slug/reset-password` reveals a generated password once |
| Rollback between auth modes | **Implemented, tested locally** | `worker/authmode.js` atomic transition + audit row; managed password login → 410 |

**Separation of states, as requested:**

- *Implemented and verified:* local password auth, operator auth, sessions/revocation, CSRF, membership SQL,
  body limits, rate limits, tracking tokens, idempotent checkout.
- *Implemented but unverified:* WorkOS end to end (no sandbox evidence of issuer, `sid`, revoke, code lifetime,
  JWKS rotation); Argon2id on the real runtime; the deployed build of any of the above.
- *Planned only:* TOTP, Firebase, historical analytics, refunds.
- *Blocked:* runtime CPU/memory measurement (requires an approved deployment); WorkOS sandbox validation
  (requires an approved account and secrets); production auth verification (no approved production).

## 6. Payments and order lifecycle

| Area | State | Evidence |
|---|---|---|
| Counter ordering | **Implemented** | `normalizeCheckoutBody({counter})`; table id rejected in counter mode (`api.js:864`) |
| Dine-in ordering | **Implemented** | café-facing table number resolved to internal row, snapshot label stored |
| Queue numbering | **Implemented, atomic** | `queue_no = (SELECT COALESCE(MAX(queue_no),0)+1 … created_at >= dayStart)` inside the INSERT (`orders.js:99-130`) |
| Table association | **Implemented** | `table_id` + `table_label` snapshot; globally unique ids, per-café numbers |
| Status transitions | **Implemented** | `new→preparing→ready→served`, cancel anytime, same-status no-op (`api.js:85`) |
| Guest tracking | **Implemented** | header-only HMAC token; generic 404 otherwise |
| Idempotency | **Implemented, strong** | claim lease, fingerprint, takeover, tombstone, single-batch write (`orders.js`) |
| Duplicate-order protection | **Implemented** | unique partial index `idx_orders_idempotency_key`; ordering paused if it cannot be verified (`ensureIdempotencyIndex`) |
| Payment method selection | **Implemented** | guest may choose counter only, guarded in SQL; UI picks rail from `config.payments` |
| Razorpay checkout/webhook | **Implemented, disabled, unproven live** | see F-09 |
| Payment status mutation security | **Implemented** | confirmed cannot be downgraded; settle is one conditional UPDATE |
| Refunds / chargebacks | **Not implemented** | no `refund`/`reconcil` code in `worker/`; only policy copy in `src/pages/Legal.jsx` |
| Failure handling | **Partial** | `payment.failed` → `failed`, retry allowed; stalled gateway fails safely; no reconciliation job |

Razorpay **remains disabled** and no key is present in any config file; the audit initiated no payment.

Operational consequence of the disabled state: a guest can always pay at the counter, and the staff board shows
"Razorpay keys missing — counter payments only". That is correct behaviour, but it means **online payment is not
part of a first-café launch** unless the full F-09 checklist is completed (keys, webhook, CSP verification,
live capture + replay test, refund policy).

## 7. Product and café onboarding readiness

The eleven-step journey, checked against code (not aspirations):

| # | Step | State | Notes / gaps |
|---|---|---|---|
| 1 | Operator creates a café | **Works** | `/operator` → name, slug, owner password, service mode, table count; CSRF-gated; 201 with `url` |
| 2 | Owner is assigned | **Works, manual** | Password cafés get the generated/entered password; managed cafés need an operator **API** call to grant membership — **no UI** (Operator.jsx has no grant/revoke) |
| 3 | Owner authenticates | **Works locally** | `/c/<slug>/owner` password form; managed mode uses `/owner/start` (unverified). **Runtime CPU risk remains** |
| 4 | Café settings configured | **Works** | name, service mode, clock offset, phone/email/address, password (with current-password gate) |
| 5 | Menu categories/items created | **Works, limited** | add/toggle/delete; category is free text with a datalist; **no reorder, no images, no modifiers, no bulk import/export** |
| 6 | Ordering mode configured | **Works** | tables ⇄ counter from settings; applies to the next order; open orders keep their mode |
| 7 | QR / counter links generated | **Works** | Tables tab renders per-table QR data URLs and a print sheet (`src/pages/Admin.jsx:1136-1200`); counter cafés share `/c/<slug>/menu` |
| 8 | Customers place orders | **Works** | cart, note, retry-safe checkout, server-side pricing, sold-out and cross-tenant rejection |
| 9 | Staff receive/process orders | **Works** | board polls every 4 s, columns New/Preparing/Ready, payment tabs, sound alert, search, **LIMIT 100 / 24 h window** |
| 10 | Customers track orders | **Works** | fragment token, 4 s polling, timeline, receipt, payment panel |
| 11 | Owner manages the operation | **Works, thin** | today-only stats, menu, tables, settings; **no history, export, refunds, staff accounts, or KDS** |

**Manual workarounds an onboarding operator must accept today**

1. Granting a managed owner requires an API call — the console has no membership screen.
2. Contact details must be typed in or the policy pages keep `[Business Name]`-style placeholders.
3. A café's first menu is the seed list; there is no import, so items are re-entered by hand.
4. No table reorder/sort UI although `menu_items.sort` exists.
5. Historical orders older than 24 h (and non-active) are invisible in the board — no date filter, no export.
6. Refunds and reconciliation are manual and undocumented in-product.

**UX risks that matter for a real café**

- A stale table QR after switching to counter mode returns a 400 error rather than a friendly redirect.
- The QR print sheet is unbranded; no per-table label printing options.
- No "now serving #N" display for counter service — staff call numbers themselves.
- No onboarding checklist; a new owner must discover the tabs.

## 8. Operational recovery readiness

| Item | State | Evidence |
|---|---|---|
| Backup/restore drill | **PASS once** | Stage 11: 19 tables, schema hash, 19 row hashes, aggregates, byte-identical re-export |
| Restore isolation | **Correct** | drill DB `2399a1f7-…` created, never bound |
| Recovery documentation | **Complete** | `DISASTER_RECOVERY_RUNBOOK.md`, Stage 12 config/reconnection/policy docs |
| Scheduled backup | **Absent** | manual export only; Free plan has no PITR |
| Retention / rotation | **Absent** | one artifact; no manifest, no pruning rule enforced |
| Encryption / off-device copy | **Absent** | plaintext SQL on one laptop (`C:\Users\rahil\corner-cup-backups\…`) |
| Checksum re-verification | **Absent** | hash recorded once at creation |
| RPO | **Unbounded in practice** | last successful manual export (2026-11-19T15:53Z) |
| RTO | **30 min DB-only measured; 60 min full estimated** | export 17 s, import 8.4 ms; no redeploy drill |
| Worker recovery | **Documented, unexercised** | config from Git + rebuild + deploy; no rehearsal |
| Secret restoration | **Documented, unexercised; inventory unverified** | names documented; `wrangler secret list` deliberately not run in Stage 12 or 13 |
| Monitoring / alerting | **Minimal** | `observability.enabled` (tail/metrics), `/api/health`, no alert routing, no error budget, no uptime check recorded |
| Incident response | **Documented** | runbook §1–§8 with declaration, scope, rollback, comms, record template |
| Dependency maintenance | **Manual** | `npm audit` clean today; no Dependabot/Renovate |
| Support procedure | **Absent** | no ticket path, no escalation, no owner-facing status page |

**The Stage 12 `rate_limits` observation, re-verified and extended.** The Worker mutates `rate_limits` on
otherwise read-only requests: `checkApiRateLimit` runs before routing on every `/api/*` call
(`worker/api.js:172-179`) and upserts a counter row; a 1 % sample additionally deletes up to 100 expired rows
(`:1782-1800`). Consequences for operations, now quantified:

1. **A "read-only" probe is a write.** Any health check, uptime monitor, or verification pass costs D1 writes and
   can prune rows. Backups taken around a probe can differ from the state a caller "only read".
2. **Quota burn.** One open staff board ≈ 900 writes/hour; the live Sites database allowance is 100,000
   writes/month (C-4).
3. **Noise in drills.** Restore comparisons must expect `rate_limits` to differ by expired rows — exactly what
   Stage 12's compatibility run observed (2 → 1).
4. **No security impact:** the cleanup runs after the decision is made, is bounded, and cannot change an allow
   or deny outcome.

## 9. Testing and quality results

### What was run in this audit (all local, no shared state mutated)

| Check | Command | Result |
|---|---|---|
| Frontend build | `npx vite build --outDir .wrangler/stage13-build --emptyOutDir` | **pass** — 104 modules, 1.79 s, 277.53 kB JS / 89.75 kB gzip, 28.81 kB CSS. `dist/` deliberately not rewritten |
| Focused pure tests | `node --import ./tests/setup/register.mjs --test tests/{orderids,checkout.logic,browser.credentials,menu.component,orderstatus.component,workos.jwt}.test.mjs` | **46/46 pass**, 6.8 s |
| Full suite | `npm test` with both harnesses on 127.0.0.1:8789/8790, isolated `--persist-to .wrangler/stage13-harness` | **435/435 pass, 0 fail, 0 skipped**, 83.7 s |
| Dependency audit | `npm audit --json` | **0 vulnerabilities** at every severity |
| Static greps | phonepe, googleapis/gstatic, firebase, totp/mfa, injection sinks, `admin_token` | as reported per finding |

Harnesses were started for the suite and stopped afterwards; ports 8789/8790/8799 all refuse connections now.

### Coverage assessment

**Strong:** auth (fallback, empty login, races, version CAS, revocation, re-auth), sessions/CSRF, guest tracking
and cross-tenant refusal, checkout idempotency and concurrency, pickup numbering under concurrency, status
transitions and paid-ticket guards, body limits (declared/understated/absent/chunked), rate limiting and its
migration, security headers, public exposure allow-lists, cookie parsing/naming, JWT/JWKS validation, auth-mode
atomicity, revocation queue, operator owner routes, payment flows against a stub.

**Gaps:**

- **No end-to-end browser test** in the suite: no Playwright/Cypress, no click-through of sign-in, menu, checkout
  or board. Prior browser passes were manual and are not regression-protected.
- **No visual/mobile regression**; 360–430 px behaviour is asserted only by CSS review.
- **No load/performance test**; the 4 s polling and rate-limit write amplification are untested at realistic
  concurrency.
- **No menu CRUD or analytics tests.**
- **No test asserts the deployed artifact matches source** — the drift in I-2 would have been caught by a
  build-provenance check.
- **Harness dependency:** the suite needs two live `workerd` servers; without them, harness-backed files fail or
  skip, so "green" depends on a developer remembering to start them. There is no script that does it.
- **Test state isolation:** several suites depend on `/seed` + `/clean` helpers; a stale local persistence dir
  can leak counters between runs (Stage 10 already had to fix one such carry-over).

### Reliability verdict

The suite is a genuine asset: 435 assertions exercising real Worker code in `workerd`, not mocks of the runtime.
It is, however, a *local* safety net. Nothing in it runs against a deployment, and nothing verifies what is
actually published.

## 10. Critical blockers

| ID | Blocker | Why it blocks | Evidence |
|---|---|---|---|
| **C-1** | A public **production** site is published, running a build that predates F-19 / F-10 / F-03-atomic / F-07-2B | Known credential-takeover gap and no server-side session revocation are on the public internet, contrary to the no-production decision | Sites metadata `published: true` (production 2026-11-10, preview 2026-11-12); `sites-build/index.js` missing `currentPassword`, `verifyOwnerReauth`, `reauth_required`, `owner_sessions`, `counterPaymentStatement`, `workos_user_id` |
| **C-2** | The repository cannot rebuild the running application | 11 untracked modules incl. `worker/passwords.js`, `worker/session.js`, `worker/tracking.js`, `worker/orderids.js`, `worker/owner.js`, `worker/workos.js`, `worker/jwt.js`, `worker/pkce.js`, `worker/revocations.js`, `worker/authmode.js`, `src/lib/payments.js`, `src/lib/menuScope.js`; a clone cannot satisfy `worker/api.js`'s imports | `git ls-files` per file |
| **C-3** | Argon2id cost on the deployed runtime is unmeasured and likely exceeds the Free-plan CPU budget | An owner who cannot complete sign-in cannot operate; measured ~47–50 ms vs 10 ms | `worker/passwords.js:12-14`; Stage 10 measurements; no runtime evidence |
| **C-4** | Per-request rate limiting writes to D1; polling every 4 s exhausts the available write quota | One café board ≈ 21,600 writes/day vs a 100,000 writes/**month** allowance on the current host | `worker/api.js:172-179, 1723-1745`; `Admin.jsx:411`; `OrderStatus.jsx:78`; Sites quota `d1Writes 1,580 / 100,000` |
| **C-5** | Backups are not operational | Single plaintext copy on one laptop, no schedule, no encryption, no off-device copy, no retention; RPO is "whenever someone last remembered" | Stage 11 artifact path; Stage 12 `PARTIAL PASS` |
| **C-6** | Production has no usable configuration | `wrangler.jsonc` still carries `00000000-0000-0000-0000-000000000000`; no approved production D1, domain, or deploy procedure exists | `wrangler.jsonc:19` |

**Note on C-1/C-6 interplay:** there are two mutually inconsistent "production" stories — a real, public Sites
deployment with an unknown database, and a Wrangler production config that cannot bind anything. Neither is an
approved production environment. Resolving which one is "production" is a decision, not a code change.

## 11. High-priority remediation list

| # | Action | Resolves | Notes |
|---|---|---|---|
| H-1 | **Unpublish** the Sites production and preview environments until a launch is approved (retains code/data) | C-1 | One action, reversible; do not delete the project or its data |
| H-2 | **Track the eleven modules** (and the two `src/lib` files) in Git, then verify a clean clone builds and `npm test` passes | C-2 | Highest-leverage single change; also add a CI job that builds from a fresh clone |
| H-3 | Rebuild and re-deploy from current source **only** after approval, with a recorded build hash → deployed version mapping | C-1, I-5 | Provenance check in CI: assert the deployed bundle contains `verifyOwnerReauth` etc. |
| H-4 | Measure Argon2id CPU and memory on the intended runtime (staging Worker, or a plan that allows it); decide plan vs identity design before onboarding | C-3 | If Free remains the target, sign-in design must change (provider-managed identity or lower-cost verify) |
| H-5 | Cut rate-limit write amplification: coalesce the limiter per isolate/window, or skip it for cache-able GETs, or lengthen the poll interval and add `ETag`/`If-None-Match` | C-4, F-06 | Must be validated against the chosen host's quota |
| H-6 | Encrypt and copy the Stage 11 artifact off-device; adopt a retention floor of three; take a backup before every change | C-5 | Zero-cost; policy already written in `STAGE12_BACKUP_POLICY.md` |
| H-7 | Decide and record the production target: Worker name, real D1 id, domain (or workers.dev), who may deploy | C-6 | Update `wrangler.jsonc` only as part of that approved change |
| H-8 | Establish secret inventory and restore rehearsal against a non-production Worker | Secret loss | `wrangler secret put` from the password manager; verify by behaviour only |
| H-9 | Add alerting: uptime check on `/api/health`, 5xx and Error 1102 alerts, `provider_revocations` backlog and `owner_login_states` growth checks | Monitoring | `observability` is on but unwatched |
| H-10 | Guard `npm run deploy`: refuse to deploy if the production D1 id is the placeholder or if `git status` is dirty | I-8 | Prevents the most likely self-inflicted incident |

## 12. Medium- and low-priority improvements

**Medium**

1. Operator UI for granting/revoking managed owner membership (API exists and is tested; no screen).
2. Order board pagination/date filter and CSV export — the current LIMIT 100 + 24 h window hides history.
3. Server-side rejection of `paymentMethod: "razorpay"` while the gateway is unconfigured (currently creates an
   unpayable ticket).
4. Contact-detail validation and a first-run owner checklist; policy placeholders look unfinished to customers.
5. Menu ordering UI (`sort` column exists), plus optional images/modifiers — the largest product gap for real
   cafés with variants.
6. Analytics beyond "today": date range, top items, hourly breakdown.
7. Friendly handling of a stale table QR after a mode switch (redirect instead of 400).
8. CI pipeline: install → build → test → `npm audit` → provenance assertion, on every push.
9. Secret rotation runbook exercise (documented consequences are good; unexercised).
10. Remove the dead F-07/F-09 assumptions from older docs, or mark them historical in one place (three documents
    currently disagree about hashing parameters).

**Low**

1. Dead `.upi-app.phonepe` CSS (`src/styles.css:1610`).
2. CSP allowlists Razorpay origins while payments are disabled; narrow it when the feature is off.
3. `ADMIN_PIN` still appears in `.dev.vars.example` although nothing reads it.
4. `deployments list` eventual-consistency gotcha (Stage 6) — document in the runbook.
5. N-06: a raced counter-payment write reports "confirmed" while writing nothing.
6. N-02: revocation jobs are best-effort and may expire unrevoked without traffic.
7. Tracking tokens never expire (accepted risk; consider expiry if cafés share devices).
8. No staff-level identity or audit attribution for payment-state writes.
9. Duplicate documentation of the F-01…F-20 matrix across four files invites drift.

## 13. Recommended implementation sequence

**Stage A — stop the exposure (hours, no product change)**

1. Unpublish the Sites production and preview environments (H-1). Record what was serving and when.
2. Decide whether the Sites database holds any real data; if yes, export it before any further action.
3. Freeze deployments; announce the freeze in the incident record format from the runbook.

**Stage B — restore a trustworthy source of truth (1–2 days)**

4. Track the eleven modules and the two `src/lib` files (H-2); commit with review.
5. Add CI: clean clone → `npm ci` → `npm run build` → `npm test` → `npm audit` → provenance assertion.
6. Prove recovery: destroy a scratch clone, rebuild, run the suite.

**Stage C — make the runtime viable (2–5 days, needs approval)**

7. Stand up an approved non-production Worker with its own D1 and measure Argon2id CPU/memory (H-4).
8. Fix rate-limit write amplification and re-measure quota headroom under simulated polling (H-5).
9. Decide the production target and record the real D1 id + domain (H-7), then rehearse a deploy and a rollback.

**Stage D — make failure survivable (1–2 days)**

10. Encrypt + copy backups off-device, adopt retention, take a pre-change backup (H-6).
11. Rehearse secret restoration and a database restore against the non-production Worker (H-8).
12. Wire uptime/5xx/1102 alerts (H-9).

**Stage E — prove the product with one café, without money at risk**

13. Onboard a single pilot café in counter mode with **payments disabled** and a staff password that meets policy.
14. Run the onboarding journey in §7 end to end with the owner present; log every manual step.
15. Only after a clean pilot: decide on Razorpay (full F-09 checklist) and on WorkOS/TOTP for owner auth.

## 14. Go / no-go decision

### **NO-GO** for onboarding the first real café.

This is not a verdict on the engineering, which is better than most projects at this stage. It is a verdict on
three specific, fixable facts:

1. **What is public is not what was audited.** A production site is live on a build that lacks the F-19
   re-authentication gate and server-side session revocation, published without approval. Fix: unpublish, then
   ship verified current code.
2. **The source of truth is incomplete.** The running system cannot be rebuilt from the repository. Fix: track
   the modules, add CI, prove a clean-clone build.
3. **The two things a café depends on are unproven in production:** that its owner can sign in (Argon2id CPU) and
   that its database can be written to at expected volume (rate-limit writes vs quota). Fix: measure both on the
   intended runtime before any café data is entered.

**What would flip this to GO for a controlled pilot:** C-1 resolved (nothing stale or unapproved is public),
C-2 resolved (clean clone builds and tests green in CI), C-3 measured and acceptable (or a plan/design change
approved), C-4 resolved or explicitly capped with a documented poll interval and quota headroom, C-5 met
(encrypted off-device backup + one completed restore rehearsal), and C-6 recorded (one approved production
environment with a real D1 id).

**Technical vs business readiness, stated separately:**

- *Technical:* security controls are in good shape in source; the deficits are deployment hygiene (drift,
  provenance, placeholder DB), runtime measurement, and one capacity design issue.
- *Business/operational:* there is no approved launch decision, no owner of production, no support path, no
  monitoring with alerts, no recoverable backup, and no pilot café agreement. Even with every technical blocker
  fixed, onboarding a paying café would still require those decisions to be made and written down.

---

## Appendix A — What this audit executed

| Command | Purpose | Effect |
|---|---|---|
| `npm audit --json` | dependency posture | read-only |
| `npx vite build --outDir .wrangler/stage13-build --emptyOutDir` | build health | wrote only inside gitignored `.wrangler/`; `dist/` untouched |
| `node --import ./tests/setup/register.mjs --test …` (6 files) | pure unit tests | read-only |
| `npx wrangler dev` × 2 on 8789/8790 with `--persist-to .wrangler/stage13-harness` | local harnesses for the suite | local only; no `--remote`; both stopped |
| `npm test` | full suite | 435/435; local harness D1 only |
| `git status`, `git ls-files`, `git diff --cached --name-only` | worktree and tracking state | read-only |
| `grep`/`rg` scans | finding evidence | read-only |
| `sites_list` | publication status of the Sites project | metadata read only |

## Appendix B — External resources accessed

- **Cloudflare Sites account metadata** (`sites_list`): project names, environment publication flags, deploy
  timestamps, public URLs, and usage counters. Read-only. **No site page, Worker, or database in production was
  contacted, queried, or modified.**
- No Cloudflare API call for Wrangler resources, no `wrangler whoami`, no `wrangler secret list`, no
  `wrangler d1` command against a remote database, no request to any `workers.dev` or `freebuff.page` URL.
- No WorkOS, Razorpay, or Telegram call. No npm registry install (build used existing `node_modules`).

## Appendix C — Confirmation of untouched resources

| Resource | State |
|---|---|
| Production Worker / production D1 | Not accessed, not changed. `wrangler.jsonc` hash unchanged at `3df6a29e…96a0` |
| Live Sites production & preview deployments | **Not accessed** (metadata only). Not unpublished, not deployed, not deleted. Their publication status is exactly as found |
| Staging Worker `corner-cup-staging` | Not contacted, not deployed |
| Staging D1 `corner-cup-staging` (`39a7899c…`) | Not contacted — no export, no query, no write |
| Stage 11 restore DB `2399a1f7…a014` | Not contacted, not bound, not deleted; still unbound |
| All backups under `C:\Users\rahil\corner-cup-backups\` | Not read for modification, not moved, not deleted |
| Secrets | No value read, printed, copied, set or rotated; `wrangler secret list` not run |
| Authentication / payments / orders | No sign-in, no session created, no payment, no order created anywhere |
| Source, configs, tests, `package.json`, lockfile | Unmodified |
| Git | No add, commit, reset, clean, checkout or discard; **0 staged**; 125 worktree entries (27 modified, 98 untracked) preserved exactly as found |
| Test harnesses / dev servers | Started locally, then stopped; ports 8789, 8790, 8799 all refuse connections |
| Build output | Written only to `.wrangler/stage13-build` and `.wrangler/stage13-harness` (gitignored audit scratch); `dist/` retains its 2026-11-17 timestamp |
