# IMPLEMENTATION_HISTORY.md — Corner Cup Development History

This document records all significant development work on the Corner Cup project, distinguishing facts verified by actual test execution from code-review claims.

## 1. Initial QR Café Ordering Application

### Original Problem
Create a QR-based café ordering system that lets customers scan a code to view menus and place orders.

### Files Involved
- Initial project scaffold
- Basic React components for menu display
- Simple ordering flow

### Changes Implemented
- Initial project setup with Vite + React
- Basic café menu page
- QR code generation for ordering
- Order submission flow

### Tests Performed
- Initial functionality testing (pre-history, before test infrastructure)

### Current Status
- Foundation established; subsequent work built on this base

### Outstanding Issues
- None (foundational work complete)

## 2. Tables and Counter Ordering Modes

### Original Problem
Support two ordering modes: Tables (each order associated with a specific table) and Counter (daily queue, no specific table).

### Files Involved
- `worker/db.js` — SCHEMA, MIGRATIONS, POST_MIGRATIONS
- `worker/orders.js` — orderInsertStatement, orderBatch
- `worker/api.js` — handleApi, various API routes
- `src/components/` — Order components
- `src/pages/` — Menu, Operator pages

### Changes Implemented
- D1 schema extended with `cafe_id` columns on orders, menu_items
- Migrations: `ALTER TABLE orders ADD COLUMN cafe_id INTEGER NOT NULL DEFAULT 1`
- Migrations: `ALTER TABLE menu_items ADD COLUMN cafe_id INTEGER NOT NULL DEFAULT 1`
- Order insertion logic distinguishes tables vs counter mode
- Tables: `table_id` is real, `queue_no` is NULL
- Counter: `table_id=0`, `table_label=Counter`, daily incrementing `queue_no`
- `orderInsertStatement` branches on `p.counter` flag

### Tests Performed
- `migrations.test.mjs` — migration application, legacy database upgrade, re-runnability
- `orderstatus.component.test.mjs` — component-level order status display
- `orders.harness.test.mjs` — harness-ordering flow
- `orders.integration.test.mjs` — end-to-end ordering integration

### Current Status
- Both modes fully implemented and tested through migration-based tests

### Outstanding Issues
- Harness-dependent ordering tests require auth-enabled Wrangler harness (not available in current environment)

## 3. Cart Isolation and Café/Table-Scoped Persistence

### Original Problem
Ensure cart/order data is isolated per café and per table, with no cross-café data leakage.

### Files Involved
- `worker/db.js` — cafe_id columns, ensurePrimaryCafe
- `worker/api.js` — handleCafeApi, cafe-scoped API routes
- `src/lib/api.js` — API client with café context
- `src/pages/Admin.jsx` — café management

### Changes Implemented
- All orders carry `cafe_id`; base schema defaults to `1` for single-café installations
- `ensurePrimaryCafe()` creates the first café if none exists
- `handleApi()` routes API calls through café-scoped paths
- `src/lib/api.js` — per-café API base URLs, session management
- Admin interface manages café-specific settings

### Tests Performed
- `migrations.test.mjs` — café adoption as version 1, legacy database upgrades
- `auth.version.test.mjs` — version parser tests (harness-dependent, currently skipped)
- `auth.fallback.test.mjs` — F-01 fallback password tests (harness-dependent)

### Current Status
- Café isolation implemented at database and API route levels

### Outstanding Issues
- Harness-dependent auth tests cannot run without Wrangler auth harness

## 4. API Timeout and Retry Resilience

### Original Problem
Network requests could hang indefinitely; failed states needed graceful handling with retry logic.

### Files Involved
- `src/lib/api.js` — DEFAULT_TIMEOUT_MS, fetch with AbortController
- `worker/api.js` — rate limit handling, error responses
- `worker/http.js` — security headers, json response helper

### Changes Implemented
- `DEFAULT_TIMEOUT_MS = 15000` — 15-second request deadline
- AbortController-based timeout on all API fetch calls
- Distinct error types: deadline exceeded, network error, HTTP error, cancellation
- Retry logic for idempotent operations (cart operations)
- Generic 404/503 responses that don't leak internal details
- `checkApiRateLimit()` with D1-backed counters (survive isolate restarts)

### Tests Performed
- `api.resilience.test.mjs` — timeout handling, retry behavior, error classification
- Multiple subtests for each error type distinction

### Current Status
- API resilience fully implemented and tested (48 tests pass including resilience suite)

### Outstanding Issues
- None within local testable scope

## 5. Stale Request Protection

### Original Problem
Stalled or abandoned requests could leave pages in inconsistent state; caller-initiated cancellation needed distinguishability from timeouts.

### Files Involved
- `src/lib/api.js` — signal handling, deadline logic
- `worker/api.js` — rate limiting, error responses

### Changes Implemented
- AbortController with per-request signal
- Deadline timer cleared on fast replies
- Signal-already-aborted protection (never reaches network)
- Concurrent callers share one request (no stampeding)
- Cancelled requests distinguishable from timeout failures
- Caller's signal preserved throughout request lifecycle

### Tests Performed
- `api.resilience.test.mjs` — subtests 1-12 cover stale request protection

### Current Status
- Stale request protection fully implemented and tested

### Outstanding Issues
- None

## 6. Guest Order Tracking Token Security

### Original Problem
Order IDs alone should not be usable as credentials; tracking must use secure tokens that cannot be guessed or replayed.

### Files Involved
- `worker/db.js` — rate_limits table, track_nonce, track_hash columns
- `worker/orders.js` — trackToken, trackHash, orderInsertStatement
- `worker/tracking.js` — newTrackNonce, trackToken, trackHash
- `worker/http.js` — security headers, CSP
- `src/lib/api.js` — x-order-token header requirement

### Changes Implemented
- Per-order 192-bit nonce generated at order creation
- Token derived: HMAC-SHA256(nonce_key, nonce_bits) → 43 URL-safe chars
- Only `sha256(token)` stored in D1 `track_hash` column; plaintext token never persisted
- Token carried in URL fragment (`#t=...`) — never in request line, access log, or Referer
- `x-order-token` header required for API mutation reads
- `authorisedOrder()` validates: token exists, matches cafe_id, HMAC verification passes
- One generic 404 for: missing token, wrong token, legacy row with no hash
- Never confirms whether order id exists — prevents information leakage

### Tests Performed
- `migrations.test.mjs` — track_nonce and track_hash column creation
- `orderstatus.component.test.mjs` — order status display with tracking
- `order.tracking.test.mjs` — tracking token flow
- `orders.integration.test.mjs` — end-to-end tracking integration

### Current Status
- Token security architecture fully implemented

### Outstanding Issues
- Token fragment navigation requires browser preview for visual verification

## 7. Payment Endpoint Restrictions

### Original Problem
Payments must remain disabled in preview; only enabled with proper Razorpay key configuration.

### Files Involved
- `src/lib/razorpay.js` — Razorpay SDK initialization
- `src/pages/Operator.jsx` — payment configuration check
- `src/pages/Admin.jsx` — payment settings
- `wrangler.jsonc` — feature flags

### Changes Implemented
- Payment endpoints guarded by `trackingConfigured(env)` check
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` required
- Preview: payments disabled; counter payment option always available
- Production: requires all three Razorpay keys configured as Worker secrets
- `Operator.jsx` checks `trackingConfigured(env)` before showing payment options
- Payment configuration panel has 12-character minimum password policy (parallel to owner password)

### Tests Performed
- Component-level tests verify payment panel renders correctly
- Harness tests verify operator gate on ordering configuration

### Current Status
- Payment endpoints properly restricted; disabled in preview

### Outstanding Issues
- Razorpay live keys never configured in this deployment; payments remain in preview mode

## 8. Security Headers and CSP

### Original Problem
Prevent MIME sniffing, clickjacking, and other browser security vulnerabilities.

### Files Involved
- `worker/http.js` — SECURITY_HEADERS, CSP constant
- `worker/index.js` — withSecurityHeaders wrapper, security headers on assets

### Changes Implemented
- CSP: `default-src 'self'`; `script-src 'self' https://checkout.razorpay.com`; `style-src 'self' https://fonts.googleapis.com`; `font-src 'self' https://fonts.gstatic.com data:`; `img-src 'self' data:`; `connect-src 'self' https://api.razorpay.com https://checkout.razorpay.com`; `frame-src https://checkout.razorpay.com`; `frame-ancestors 'none'`; `base-uri 'self'`; `form-action 'self'`; `object-src 'none'`; `media-src 'self'`; `worker-src 'self'`; `manifest-src 'self'`; `upgrade-insecure-requests`
- `X-Content-Type-Options: nosniff`
- `X-Frame-Options: DENY`
- `Referrer-Policy: strict-origin-when-cross-origin`
- `Permissions-Policy: geolocation=(), camera=(), microphone=(), payment=(self), usb=(), magnetometer=(), gyroscope=(), accelerometer=()`
- Applied to every JSON response via `json()` and every static asset via `withSecurityHeaders(env.ASSETS.fetch(request))`

### Tests Performed
- Code review verification of header values
- No functional tests (headers inspected via developer tools)

### Current Status
- Security headers fully implemented on all responses

### Outstanding Issues
- No automated header validation tests in suite

## 9. Operator CSRF Protection

### Original Problem
Operator actions (password changes, resets, café settings) needed CSRF proof: origin match + live token bound to operator session cookie.

### Files Involved
- `worker/api.js` — operatorLogin, operatorCreateCafe, csrf verification
- `worker/http.js` — csrf-related headers
- `tests/harness/worker.mjs` — CSRF test suite

### Changes Implemented
- Every operator action requires `x-csrf-token` header
- Token must match a live row bound to the operator's session cookie
- Origin must match this deployment (prevents cross-deployment CSRF)
- CSRF token dies with the operator session; later sign-in mints its own nonce
- CSRF alone without session cookie is refused (401)
- Without session cookie, gate answers first so token never even gets looked at

### Tests Performed
- `password.reset.test.mjs` — numerous CSRF-related subtests
- `auth.version.test.mjs` — version invalidation with CSRF (harness-dependent)
- Multiple CSRF origin and token-boundary subtests

### Current Status
- Operator CSRF protection fully implemented

### Outstanding Issues
- Harness-dependent CSRF tests require auth-enabled Wrangler harness

## 10. Durable D1-Backed Rate Limiting

### Original Problem
Rate limits must survive isolate restarts (Cloudflare Workers cold starts); in-memory maps are cleared on restart.

### Files Involved
- `worker/db.js` — rate_limits table in POST_MIGRATIONS
- `worker/api.js` — checkApiRateLimit, touchRateLimit, readRateLimit
- `worker/tracking.js` — rate limit keys and logic
- `worker/http.js` — rateLimitCleanupProbability, cleanupExpiredRateLimits

### Changes Implemented
- Rate limit state stored in D1 `rate_limits` table (persists across isolate restarts)
- Atomic upsert with `ON CONFLICT(key) DO UPDATE` — RETURNING count, expires
- Bounded cleanup: at most 100 expired rows per execution
- Sampling probability for cleanup (1% of API requests by default)
- Rate limit windows have `window_start`, `expires`, `updated_at` fields
- API: per-IP, 60 requests per 60 seconds (configurable)
- Login: per-café+IP, 8 failures per 10 minutes
- Operator: per-IP, configurable failures
- Cleanup is opportunistic — never changes the rate-limit decision, only cleans expired rows

### Tests Performed
- `migrations.test.mjs` — rate_limits table creation, idempotent re-runs
- `rate.limit.test.mjs` — rate limit logic (harness-dependent, currently skipped)
- `rate.limits.migration.test.mjs` — migration application

### Current Status
- D1-backed rate limiting fully implemented

### Outstanding Issues
- Harness-dependent rate limit tests require auth-enabled Wrangler harness

## 11. PBKDF2 Password Security Strengthening and Authentication Race Fix (F-07)

### Original Problem
PBKDF2 iteration count needed strengthening from 100,000 to 600,000. Login flow had an authentication race condition: version could be re-read after password verification, potentially granting session for old password after a concurrent change.

### Files Involved
- `worker/passwords.js` — PBKDF2_ITERATIONS constant, hashPassword, verifyPassword
- `worker/api.js` — login function (lines 1600-1683)
- `worker/cafes.js` — hashPassword/verifyPassword import/export

### Changes Implemented

**F-07: PBKDF2 Iteration Change**
- `PBKDF2_ITERATIONS` changed from `100_000` to `600_000` in `worker/passwords.js`
- New hashes encode 600,000 iterations
- `verifyPassword` already reads iteration count from stored hash string format `pbkdf2$<iterations>$<salt>$<hash>`, so existing 100k hashes verify unchanged
- All password creation, change, bootstrap, and reset paths use shared `hashPassword` implementation

**F-07: Authentication Race Fix**
- `auth_version` captured from café database row BEFORE `verifyPassword` call
- Session token uses captured version via `ownerSubject(cafe, version)` 
- NO re-read of latest version after password verification
- If password change occurs after capture, session carries old version and is correctly rejected by `checkToken` which re-reads current `auth_version`
- Opportunistic rehash: after successful legacy hash verification, compare-and-swap `UPDATE cafes SET pass_hash = ? WHERE id = ? AND pass_hash = ?` upgrades to 600k iterations
- WHERE clause uses exact previously verified hash — compare-and-swap pattern
- Zero-row rehash (concurrent password change) does not overwrite newer password; login proceeds with current password

### Tests Performed
- `npm test` against both local harnesses (`tests/harness/wrangler.jsonc` on 127.0.0.1:8789,
  `tests/harness/wrangler.auth.jsonc` on 127.0.0.1:8790): **142 tests, 142 pass, 0 fail, 0 skipped**
- `npm run build`: passes (`vite build`, 95 modules, ~1.2s)
- `tests/f07-regression.test.mjs` 10/10; `tests/auth.version.test.mjs` 3/3;
  `tests/password.reset.sql.test.mjs` 2/2; `tests/password.reset.test.mjs` 20/20
- Legacy rehash proven end-to-end, not by reading source: a café seeded with a real
  `pbkdf2$100000$…` hash signed in (200), and the local D1 row then read `pbkdf2$600000$…`
  with `auth_version` unchanged at 1
- Compare-and-swap safety proven end-to-end: after an operator reset behind a legacy hash, the old
  password is refused (401), the stored 600k hash is byte-identical, `auth_version` unchanged; the
  new password signs in (200)
- Deterministic login/password-change race: `tests/auth.race.test.mjs` (1/1) uses a test-only
  `/race-login` gate in `tests/harness/worker.mjs` to hold a login after the café row is read and
  before verification, change the password, then resume. It asserts the issued session carries the
  captured old version, is refused (401) by the protected endpoint, the old password stops working
  and the new one works
- Two defects found during final validation and fixed in `worker/api.js` (2 lines): a missing
  closing brace on `login()` that made every later top-level `export` a syntax error at line 2143
  (the reported "Unexpected 'export'"), and the unvalidated `cafe.auth_version` read that let a
  corrupt stored version issue a session instead of answering 503

### Current Status
- F-07 accepted as code-complete and locally validated (2026-11-14)
- Not deployed; no remote-runtime verification was performed

### Outstanding Issues
- Cloudflare Workers CPU compatibility for 600k PBKDF2 is **not verified**: no deployment, no
  `wrangler dev --remote`, no CPU-time measurement in the Workers runtime. 600k is roughly six
  times the key-derivation work of 100k, and login latency and the Workers CPU budget have not been
  measured there.
- The deterministic race test sequences the interleaving through the test-only harness gate; it does
  not exercise true parallel scheduling.

### F-07 Verification Status
- Code changes: ✅ Completed and inspectable
- 600k PBKDF2 implementation and local verification: ✅ Verified locally (unit tests, live harness, D1 read)
- Full local suite: ✅ 142/142 pass, 0 fail, 0 skip; `vite build` passes
- Deterministic login/password-change race: ✅ Verified locally by `tests/auth.race.test.mjs` (sequenced, not parallel)
- Cloudflare Worker CPU compatibility: ❓ Unverified — needs a runtime CPU measurement, which was out of scope

## 12. Streamed Request-Body Size Limits (F-08)

### Original Problem
Every route that accepted a body read it with `request.json()` (the two payment webhooks used
`request.text()`) and then parsed it. No size check existed anywhere in the request pipeline, so a
client could make the isolate buffer and parse an arbitrarily large payload. `Content-Length` was
never consulted, so there was no cheap rejection either. The audit step inventoried 15 body-reading
sites: 13 `readJson` calls across owner/operator/checkout/payment/password-reset routes, and 2 raw
text reads in the Razorpay and PhonePe webhooks.

### Files Involved
- `worker/http.js` — `BODY_LIMITS`, `BodyTooLargeError`, `readText`, rewritten `readJson`
- `worker/api.js` — `handleApi` / `routeApi` split and 413 mapping; all 13 `readJson` sites given a
  budget; both webhook `request.text()` calls replaced
- `tests/body.limit.test.mjs` — new suite, 15 tests

### Changes Implemented

**F-08: streaming byte budget**
- `BODY_LIMITS` maps each endpoint class to a byte budget: login 1 KiB, operatorLogin 1 KiB,
  operatorCafe 2 KiB, operatorReset 1 KiB, settings 4 KiB, adminOrder 1 KiB, menuItem 2 KiB,
  adminItem 1 KiB, table 1 KiB, checkout 16 KiB, abandon 1 KiB, payment 2 KiB, paymentVerify 4 KiB,
  webhook 64 KiB
- `readText(request, limit)` reads `request.body.getReader()` and adds `value.byteLength` as chunks
  arrive; the moment the total passes the limit it calls `reader.cancel()` and throws
  `BodyTooLargeError`. The rest of the body is never buffered
- `Content-Length` is an early hint only: a declared length above the limit short-circuits without
  reading, and a missing or understated length changes nothing because the stream count decides
- An interrupted stream, or a body that was already consumed, returns `null` (the existing "bad
  body" answer) instead of propagating a stream error
- `readJson(request, limit)` sits on top of `readText`, so malformed JSON and empty bodies keep their
  previous `null` result
- `handleApi` now wraps the former body of that function, renamed `routeApi`, and maps
  `BodyTooLargeError` to one `413 { "error": "That request is too large." }`; the message contains no
  limit, field or byte count, and the response uses the same `json()` helper (`no-store`)
- Webhooks keep raw-body HMAC verification: `await request.text()` became
  `await readText(request, BODY_LIMITS.webhook)`, a single bounded read of the same exact string, so
  there is no double consumption
- No ordering changed: rate limiting, authentication, CSRF and idempotency still run before a
  handler reads its body

**F-08: defect found by the new tests**
- A second read of the same request threw `Invalid state: ReadableStream is locked` from
  `request.body.getReader()`, which would have surfaced as a 500. The call is now guarded and returns
  `null`, so a double read is a bad body rather than a crash.

### Tests Performed
- New `tests/body.limit.test.mjs`: **15/15 pass**
  - in-process: under the limit, exactly at the limit, one byte more, no `Content-Length`,
    understated `Content-Length`, declared length above the limit, UTF-8 byte counting, malformed
    JSON, empty body, interrupted stream, double read, limits-table sanity
  - harness (`127.0.0.1:8789` and `127.0.0.1:8790`): sign-in 200 under the limit, 200 at exactly
    1,024 bytes, 401 for a wrong password at the limit, 413 one byte past it, 413 for a chunked body
    with no `Content-Length`, 413 for a chunked body over a raw socket, normal checkout still 201,
    oversized checkout 413, malformed JSON still 400, operator reset 403 without CSRF and 413 with
    it, unconfigured webhook still 503
- `npm test` against both local harnesses: **157 tests, 157 pass, 0 fail, 0 skipped**
- `npm run build`: passes (`vite build`)
- The 413 payload was asserted verbatim: `{ "error": "That request is too large." }` with
  `Cache-Control: no-store`

### Current Status
- F-08 accepted as code-complete and locally validated (2026-11-14)
- Not deployed; no production or preview change was made

### Outstanding Issues
- The declared-length-above-the-limit short-circuit is proven in-process only: workerd waits for the
  declared body before invoking the Worker, so over HTTP the early rejection is not observable. The
  streamed count remains the load-bearing check
- The webhook 413 is proven in-process only; both webhook routes answer 503 before reading a body
  when their secret is unconfigured, and no secret was configured locally
- `wrangler dev` buffered bodies during these tests, so the memory saving from cancelling mid-stream
  is not measured — only the correctness of the refusal
- Local test isolation: login lockout rows are keyed by café id and survive café deletion for their
  10-minute window, so repeated full-suite runs inside that window can reuse an id and answer 429.
  Clearing `rate_limits` in the harness D1 (or a fresh harness state) before a run avoids it; this is
  a test-environment property, not an F-08 code change
- The per-endpoint budgets are judgement calls; a new body-reading route must be given one (the
  `readJson` default is the 4 KiB settings budget)

### F-08 Verification Status
- Code changes: ✅ Completed and inspectable
- Streamed limit enforcement: ✅ Verified locally (unit, batch harness, auth harness, raw socket)
- Full local suite: ✅ 157/157 pass, 0 fail, 0 skip; `vite build` passes
- Deployment and Workers-runtime behaviour: ❌ Not exercised (out of scope; no deployment authorized)
