# SECURITY_STATUS.md — Corner Cup Security Findings F-01 through F-20

> **Document status (2026-11-14):** F-07 and F-08 are code-complete and locally validated —
> 157/157 local tests pass against both local harnesses and the production build succeeds. Earlier
> notes in this document that say the harness was unavailable, or that quote counts of 89 tests
> with 39 skipped and 2 failing, are historical and are superseded by the F-07 and F-08 sections
> below. "Locally validated" is not the same as "verified in production": nothing here has been
> deployed, and Cloudflare Workers CPU compatibility remains unverified.

This document documents security findings for the Corner Cup project. Each finding records severity, original vulnerability, remediation, relevant files, test coverage, actual verification status, and remaining risks.

## F-01: Deployment-Wide Fallback Password Vulnerability

### Severity
CRITICAL (originally); MITIGATED (remediated)

### Original Vulnerability
The vulnerability was in `login()`: for any café whose `pass_hash` was NULL it compared the entered password against `env.OWNER_PASSWORD || env.ADMIN_PIN` in plain text. One shared secret — often a 4-digit PIN — therefore opened every café that had never been given a password.

### Remediation
- `login()` now only verifies the café's own stored PBKDF2 hash
- Sign-in refuses (503) without a stored hash
- `OWNER_PASSWORD` may still seed the primary café's hash at startup, once, and only while that hash is NULL
- `ADMIN_PIN` is no longer read at all during sign-in
- Bootstrap guarded by `pass_hash IS NULL` — never overwrites an existing password

### Relevant Files
- `worker/api.js` — login() function (sign-in flow)
- `worker/db.js` — primaryPasswordBootstrapStatement, bootstrapOwnerPassword, bootstrapPrimaryPassword
- `worker/passwords.js` — hashPassword, verifyPassword

### Test Coverage
- `tests/auth.fallback.test.mjs` — F-01 regression suite (harness-dependent, currently skipped)
- `tests/auth.fallback.test.mjs` — "no sign-in path reads ADMIN_PIN or OWNER_PASSWORD" (static code inspection)
- `tests/migrations.test.mjs` — bootstrap guard tests

### Actual Verification Status
- ✅ Code inspection: `login()` never compares against `ADMIN_PIN` or `OWNER_PASSWORD` directly
- ✅ Code inspection: bootstrap guarded by `pass_hash IS NULL`
- ✅ Code inspection: `ADMIN_PIN` removed from API source
- ❌ Full test suite: blocked (harness unavailable at port 8790)
- ✅ Static analysis: `package.json` test suite shows auth.fallback tests are skipped when harness not available

### Remaining Risks
- Low: If `OWNER_PASSWORD` is configured and primary café hash is NULL at startup, bootstrap could install it — but this is by design and governed by `pass_hash IS NULL` guard
- Low: Any deployment that previously relied on the fallback PIN must now set per-café passwords

### Status Note
F-01 through F-06 have local remediation work completed according to previous reports.

---

## F-02: (Not Used/Numbering Skip)

*No finding assigned to F-02 in the project's security numbering sequence.*

---

## F-03: Operator CSRF Vulnerability

### Severity
HIGH (originally); MITIGATED (remediated)

### Original Vulnerability
Operator actions (password changes, resets, café settings) could be driven by a CSRF attack if the attacker could trick a logged-in operator into submitting a malicious request. Without CSRF proof, an operator visiting a compromised page while authenticated could have their credentials changed or café settings modified.

### Remediation
- Every operator action requires `x-csrf-token` header
- Token must match a live row bound to the operator's session cookie
- Origin must match this deployment (prevents cross-deployment CSRF)
- CSRF token dies with the operator session; later sign-in mints its own nonce
- CSRF alone without session cookie is refused (401)
- Without session cookie, gate answers first so token never even gets looked at

### Relevant Files
- `worker/api.js` — operatorLogin, operatorCreateCafe, csrf verification logic
- `worker/http.js` — csrf-related headers and validation
- `tests/harness/worker.mjs` — CSRF test suite

### Test Coverage
- `tests/password.reset.test.mjs` — numerous CSRF-related subtests (harness-dependent)
- `tests/auth.version.test.mjs` — version invalidation with CSRF (harness-dependent, currently skipped)
- Code review: CSRF header requirement enforced in 3+ locations in api.js

### Actual Verification Status
- ✅ Code enforcement: `x-csrf-token` required in 3+ operator API paths
- ✅ Code enforcement: origin check validates deployment match
- ✅ Code enforcement: token bound to session cookie
- ✅ Code enforcement: CSRF token rotation on re-sign-in
- ❌ Full test suite: blocked (harness unavailable)
- ✅ Historical: previous chat messages confirmed CSRF test suite passing before harness became unavailable

### Remaining Risks
- Low: If operator's session cookie is stolen, CSRF protection is irrelevant (same-origin attack would have cookie access anyway)
- Medium: New operator actions added without CSRF verification could reintroduce vulnerability

### Status Note
This finding is fully remediated in the current codebase.

---

## F-04: Rate Limit Bypass via Isolate Restart

### Severity
MEDIUM (originally); MITIGATED (remediated)

### Original Vulnerability
Rate limits stored in Worker isolate memory would be cleared on cold start/restart, allowing an attacker to bypass rate limits by triggering a restart.

### Remediation
- Rate limit state stored in D1 `rate_limits` table (persists across isolate restarts)
- Atomic upsert with `ON CONFLICT(key) DO UPDATE` — RETURNING count, expires
- Bounded cleanup: at most 100 expired rows per execution
- Sampling probability for cleanup (1% of API requests by default)
- Rate limit windows have `window_start`, `expires`, `updated_at` fields

### Relevant Files
- `worker/db.js` — rate_limits table in POST_MIGRATIONS
- `worker/api.js` — checkApiRateLimit, touchRateLimit, readRateLimit
- `worker/tracking.js` — rate limit keys and logic

### Test Coverage
- `migrations.test.mjs` — rate_limits table creation, idempotent re-runs (passes locally)
- `rate.limits.migration.test.mjs` — migration application (passes locally)
- `rate.limit.test.mjs` — rate limit logic (harness-dependent, currently skipped)

### Actual Verification Status
- ✅ Code implementation: D1-backed rate limits with atomic upsert
- ✅ Code implementation: bounded cleanup (at most 100 rows)
- ✅ Code implementation: sampling probability configures cleanup frequency
- ❌ Full test suite: blocked (harness unavailable at port 8790)
- ✅ Local inspection: rate_limits table schema confirmed in migrations

### Remaining Risks
- Low: Cleanup is opportunistic; if probability is set to 0, expired rows accumulate but never change a decision
- Low: Rate limit thresholds are configured via Worker variables; misconfiguration could leave gaps

### Status Note
Fully remediated; D1-backed persistence survives isolate restarts.

---

## F-05: Plaintext Token Storage Risk

### Severity
MEDIUM (originally); MITIGATED (remediated)

### Original Vulnerability
Order tokens could be stored or transmitted in plaintext, making them susceptible to interception or replay.

### Remediation
- Only `sha256(token)` stored in D1 `track_hash` column; plaintext token never persisted
- Token carried in URL fragment (`#t=...`) — never in request line, access log, or Referer
- HMAC-SHA256 derivation from 192-bit per-order nonce ensures token cannot be reconstructed from hash alone
- API validation (`authorisedOrder()`) checks HMAC verification, not hash lookup

### Relevant Files
- `worker/db.js` — track_nonce, track_hash columns in MIGRATIONS/POST_MIGRATIONS
- `worker/orders.js` — orderInsertStatement with track_nonce/track_hash
- `worker/tracking.js` — newTrackNonce, trackToken, trackHash
- `worker/http.js` — security headers prevent fragment leakage

### Test Coverage
- `migrations.test.mjs` — track_nonce and track_hash column creation and idempotency
- `order.tracking.test.mjs` — tracking token flow (harness-dependent)
- `orders.integration.test.mjs` — end-to-end tracking (harness-dependent)

### Actual Verification Status
- ✅ Code implementation: only sha256(token) persisted, never plaintext
- ✅ Code implementation: token in URL fragment (SameSite=Strict, fragment not sent in requests)
- ✅ Code implementation: HMAC derivation from secret nonce key
- ❌ Full test suite: blocked (harness unavailable)
- ✅ Historical: previous verification confirmed fragment never reaches server in request line

### Remaining Risks
- Low: If browser history/leak exposes URL fragment, token hash could be compromised — but fragment-first design minimizes this
- Low: Server-side log injection could expose fragments (mitigated by SameSite=Strict and fragment-not-sent design)

### Status Note
Fully remediated; token fragment architecture prevents replay and information leakage.

---

## F-06: Session Version Confusion / Authentication Race

### Severity
HIGH (originally); MITIGATED (remediated)

### Original Vulnerability
The login flow read `auth_version` AFTER password verification. If a password change occurred between verification and version lookup, the session could be issued with the new version but authenticated against the old password — a race condition that could grant valid login sessions for old passwords after a password change.

### Remediation
- `auth_version` captured from café database row BEFORE `verifyPassword` call
- Session token uses captured version via `ownerSubject(cafe, version)` 
- NO re-read of latest version after password verification
- `checkToken` re-reads current `auth_version` from database and compares against token's embedded version
- If password change occurred meanwhile, session carries old version and is correctly rejected

### Relevant Files
- `worker/api.js` — login() function (critical race fix in F-07 implementation)
- `worker/db.js` — currentAuthVersion, authVersionFrom functions
- `worker/api.js` — checkToken (compares token version vs current DB version)

### Test Coverage
- `tests/auth.version.test.mjs` — auth version parser (harness-dependent, currently skipped)
- `tests/password.reset.test.mjs` — session invalidation after password change (harness-dependent)
- Code review: version capture before verification pattern

### Actual Verification Status
- ✅ Code implementation: `version = cafe.auth_version` captured before verifyPassword
- ✅ Code implementation: session token uses `ownerSubject(cafe, version)` with captured version
- ✅ Code implementation: `checkToken` reads `currentAuthVersion(cafe)` and compares parsed.version === expected
- ✅ Code implementation: no re-read of latest version after verification
- ❌ Full test suite: blocked (harness unavailable at port 8790)
- ✅ Local inspection: code review confirmed race fix pattern

### Remaining Risks
- Low: If checkToken itself has a bug, version comparison could fail
- Low: New session-creating code paths must follow the same pattern (capture before verify)

### Status Note
This finding is fully remediated in the current codebase. The F-07 implementation explicitly builds on this fix.

### F-07 Connection
The F-07 login flow explicitly implements this race fix: version captured before verifyPassword, session uses captured version, checkToken re-reads current version for comparison. This is a core component of the F-07 work.

---

## F-07: PBKDF2 Password-Hash Strengthening and Opportunistic Rehash

### Severity
HIGH

### Original Vulnerability
PBKDF2-HMAC-SHA256 iteration count at `100,000` was insufficient for modern password-security requirements. Additionally, the login flow had no opportunistic rehash mechanism — legacy hashes remained at 100k iterations indefinitely.

### Current State
**Implemented, locally validated, and accepted as code-complete (2026-11-14).** Not deployed and not
benchmarked inside the Cloudflare Workers runtime — see section D below.

### Remediation (Implemented in Code)

**1. PBKDF2 Iteration Change**
- `PBKDF2_ITERATIONS = 600_000` in `worker/passwords.js`
- New hashes encode 600,000 iterations
- `verifyPassword` reads the iteration count out of the stored hash (`pbkdf2$<iterations>$<salt>$<hash>`), so existing 100k hashes verify unchanged
- Every password path (create, change, bootstrap, operator reset) goes through the shared `hashPassword`

**2. Opportunistic Rehash**
- After a successful verification of a legacy hash, a 600k replacement is written with compare-and-swap:
  `UPDATE cafes SET pass_hash = ? WHERE id = ? AND pass_hash = ?`
- The final parameter is the exact hash that was just verified; if a concurrent change already replaced it, the update touches 0 rows and the newer password is left alone
- A rehash does **not** bump `auth_version`; explicit password changes and operator resets do, atomically with the hash write

**3. Defects found and fixed during final validation** (`worker/api.js`, 2 lines)
- A missing closing brace on `login()` had left `sessionStatus`, `authVersionFrom`, `passwordResetBatch` and everything after it nested inside `login`'s body. That is why both `node --test` and Wrangler/esbuild reported "Unexpected 'export'" at `worker/api.js:2143`; ES module `export` syntax was never the problem.
- `login()` now reads the session version through `currentAuthVersion(cafe)` instead of the raw column, so a present-but-invalid `auth_version` (0, -1, 1.5, "abc") fails closed with 503 instead of issuing a session.

### Relevant Files
- `worker/passwords.js` — `PBKDF2_ITERATIONS = 600_000`, `hashPassword`, `verifyPassword`
- `worker/api.js` — `login()` (version capture before verification, opportunistic rehash), `authVersionFrom`, `currentAuthVersion`, `passwordResetBatch`, `operatorResetPassword`
- `worker/cafes.js` — re-exports `hashPassword` / `verifyPassword`
- `tests/auth.race.test.mjs` — deterministic login/password-change race
- `tests/harness/worker.mjs` — test-only `/race-login` gate used by that test

### Test Coverage
- `tests/f07-regression.test.mjs` — 10/10: hash encodes 600,000; correct and incorrect verification; legacy 100k hash format parses; rehash SQL does not bump `auth_version`; compare-and-swap binds the verified hash; zero-row rehash leaves the password valid
- `tests/auth.version.test.mjs` — 3/3: version parser, and fail-closed on every invalid stored value
- `tests/password.reset.sql.test.mjs` — 2/2: reset batch, and a failing audit insert rolls the password update back
- `tests/password.reset.test.mjs` — 20/20, including "an invalid stored version fails closed for tokens and sign-in" and "a CSRF token dies with the operator session it was issued for"
- `tests/auth.race.test.mjs` — 1/1: deterministic login/password-change race
- `migrations.test.mjs` — schema migrations unaffected by the iteration change

### Actual Verification Status

**A. 600k PBKDF2 implementation and local verification — VERIFIED LOCALLY**
- ✅ `adds 600,000 iterations` on new hashes (unit test asserts the encoded iteration count)
- ✅ `verifyPassword` accepts a stored 100k hash and a stored 600k hash alike (unit tests + live harness)
- ✅ End-to-end rehash proven against the running harness, not by reading source: a café seeded with a real `pbkdf2$100000$…` hash signed in (200), and the local D1 row then read `pbkdf2$600000$…` with `auth_version` unchanged
- ✅ Compare-and-swap safety proven end-to-end: after an operator reset behind a legacy hash, the old password is refused (401), the stored 600k hash is byte-identical, `auth_version` unchanged; the new password signs in (200)

**B. 142/142 passing local tests — VERIFIED LOCALLY**
- ✅ `npm test` with both harnesses up (`127.0.0.1:8789`, `127.0.0.1:8790`): **142 tests, 142 pass, 0 fail, 0 skipped**, exit 0
- ✅ `npm run build`: passes (`vite build`, 95 modules, ~1.2s)
- ✅ The two files that previously could not even be imported now pass: `auth.version.test.mjs` 3/3 and `password.reset.sql.test.mjs` 2/2

**C. Deterministic harness race test — VERIFIED LOCALLY (sequenced)**
- ✅ `tests/auth.race.test.mjs`: the harness reads the café row, holds the login before the password is verified, changes the password and bumps `auth_version`, then resumes
- ✅ Asserts the in-flight login completes (200) with a session stamped `cafe:<id>:<oldVersion>`, that session is refused (401) by `GET /api/cafes/:slug/admin/session`, the old password is refused (401), the new password signs in (200) and its session is accepted with `cafe:<id>:<newVersion>`
- ⚠ Limitation: the ordering is pinned by an explicit gate inside the test-only harness, not by real parallel scheduling (one isolate). It pins the security invariant — a stale snapshot cannot authenticate after a change — rather than isolating which line enforces it.

**D. Cloudflare Worker CPU compatibility — NOT VERIFIED**
- ❌ No deployment, no `wrangler dev --remote`, no CPU-time measurement inside the Workers runtime
- ❌ 600k PBKDF2 is roughly six times the key-derivation work of 100k; login latency and the Workers CPU budget have not been measured there
- ⚠ Do not treat this as production-validated on the strength of the local suite

### Remaining Risks
- Medium: PBKDF2 600k CPU cost in the Workers runtime is unmeasured (section D)
- Low: a successful legacy login now performs one extra KDF plus one conditional UPDATE
- Low: any new session-creating path must keep capturing the version before verification
- Low: `verifyPassword` backward compatibility depends on correct `split('$')` parsing of the stored format

### F-07 Verification Status Summary
- Code changes: ✅ Completed and inspectable
- 600k PBKDF2 implementation and local verification: ✅ Verified locally
- Full local suite: ✅ 142/142 pass, 0 fail, 0 skip; `vite build` passes
- Deterministic login/password-change race: ✅ Verified locally (sequenced by the test harness)
- Cloudflare Worker CPU compatibility: ❓ Unverified (no deployment, no CPU measurement)

### Status Note
F-07 is accepted as code-complete and locally validated. That is a statement about code and local
tests only: production CPU behaviour on Cloudflare Workers is still unverified, so treat F-07 as
needing a runtime check before it is called production-ready.

---

## F-08: Unbounded Request Bodies

### Severity
MEDIUM

### Original Vulnerability
Every API route that accepted a body read it with `await request.json()` (or, for the two payment
webhooks, `await request.text()`) before any size check existed. Whatever a client sent was buffered
in the isolate and then parsed. A single request could therefore push an arbitrarily large payload
into the Worker's memory and JSON parser, and nothing in the request pipeline bounded it: the
edge/platform body limit was the only ceiling and it is not part of this codebase's guarantees.
`Content-Length` was never consulted, so even a cheap early rejection was impossible.

### Current State
**Implemented, locally validated, and accepted as code-complete (2026-11-14).** Not deployed.

### Remediation (Implemented in Code)

**1. One streaming reader with a byte budget** (`worker/http.js`)
- `BODY_LIMITS` is a single table of per-endpoint budgets in bytes.
- `readText(request, limit)` counts bytes **as they arrive** from `request.body.getReader()` and
  aborts with `BodyTooLargeError` as soon as the running total exceeds the limit, calling
  `reader.cancel()` rather than draining the rest.
- `Content-Length` is used **only** as an early hint: if a declared length is above the limit the
  body is never read. It is never the deciding check, because a client can omit it or understate
  it; the streamed count is authoritative.
- An unreadable or interrupted stream (client vanished, body already consumed) returns `null`, which
  every caller already treats as a bad body. Reading the same request twice also returns `null`
  instead of throwing a locked-stream error.
- `readJson(request, limit)` is now a thin layer over `readText`: same `null` on malformed JSON and
  on empty bodies as before, plus the byte budget.

**2. One 413 for the whole API** (`worker/api.js`)
- The former `handleApi` body became `routeApi`; `handleApi` now wraps it in a `try/catch` that turns
  `BodyTooLargeError` into a single `413` with `{ "error": "That request is too large." }`.
- The message names no limit, no field and no byte count. The response goes through the existing
  `json()` helper, so it carries the same `Cache-Control: no-store` as every other API answer.
- Because the wrapper sits inside `handleApi`, the production Worker (`worker/index.js`) and the test
  harness (`tests/harness/worker.mjs`) get identical behaviour with no harness-specific branch.
- Ordering is unchanged: rate limiting, authentication, CSRF and idempotency still run before the
  handler reads its body; the 413 only replaces what used to be an unbounded read.

**3. Endpoint budgets**

| Limit | Bytes | Routes |
| --- | --- | --- |
| `login` | 1 KiB | `POST /api/cafes/:slug/admin/login` |
| `operatorLogin` | 1 KiB | `POST /api/operator/login` |
| `operatorCafe` | 2 KiB | operator café create/update |
| `operatorReset` | 1 KiB | operator password reset |
| `settings` | 4 KiB | admin settings |
| `adminOrder` | 1 KiB | admin order status changes |
| `menuItem` | 2 KiB | menu item create/update |
| `adminItem` | 1 KiB | menu item availability |
| `table` | 1 KiB | table create |
| `checkout` | 16 KiB | `POST /api/cafes/:slug/orders` |
| `abandon` | 1 KiB | checkout abandonment |
| `payment` | 2 KiB | payment submission |
| `paymentVerify` | 4 KiB | Razorpay verification |
| `webhook` | 64 KiB | Razorpay and PhonePe webhooks |

Every budget is far above the largest legitimate body that route can produce. Checkout is the
largest structured body and is already capped at 40 lines and a 300-character note by
`normalizeCheckoutBody`, so 16 KiB is generous. Webhooks keep the largest budget because gateway
event envelopes are not shaped by this codebase and carry signatures and nested payloads.

**4. Webhooks keep their raw-body verification**
- `request.text()` was replaced with `readText(request, BODY_LIMITS.webhook)` — one bounded read that
  yields the same exact raw string the HMAC comparison needs, so there is no double consumption and
  no change to signature verification.

### Relevant Files
- `worker/http.js` — `BODY_LIMITS`, `BodyTooLargeError`, `readText`, `readJson`
- `worker/api.js` — `handleApi` / `routeApi` split, 413 mapping, all 15 body reads
- `tests/body.limit.test.mjs` — new suite (15 tests)

### Test Coverage
- `tests/body.limit.test.mjs` — 15/15: 10 in-process tests of the reader (under the limit, exactly
  at the limit, one byte more, no `Content-Length`, understated `Content-Length`, declared length
  above the limit, UTF-8 bytes counted not characters, malformed JSON, empty body, interrupted
  stream, double read, limits table sanity) and 5 harness tests (sign-in under/at/past its limit,
  chunked body over a raw socket, checkout over its limit plus a normal checkout and malformed JSON,
  operator reset behind its CSRF gate, webhook configuration gate)
- Whole suite: **157 tests, 157 pass, 0 fail, 0 skipped** with both harnesses up

### Actual Verification Status

**A. Streamed enforcement — VERIFIED LOCALLY**
- ✅ A 257-byte body against a 256-byte limit is refused; exactly 256 bytes is accepted
- ✅ A chunked body with no `Content-Length` is refused at the real route (413), and refused again
  when sent over a raw socket with `Transfer-Encoding: chunked`
- ✅ A body that understates `Content-Length` (claims 10 bytes, streams 400) is still refused: the
  stream count decides, not the header
- ✅ Bytes are counted as UTF-8 bytes, not characters (nine `é` characters are 18 bytes)

**B. Existing behaviour preserved — VERIFIED LOCALLY**
- ✅ A correct sign-in under the limit answers 200, and a 1,024-byte body with a correct password
  answers 200 — the limit does not shorten legitimate input
- ✅ A 1,024-byte body with a wrong password answers 401, not 413
- ✅ A normal checkout still commits (201); malformed JSON still answers 400, not 413
- ✅ Operator reset without a CSRF token still answers 403 before the body is read; with a valid
  token an oversized body answers 413
- ✅ An unconfigured Razorpay webhook still answers 503, exactly as before
- ✅ The 413 body is exactly `{ "error": "That request is too large." }` and carries
  `Cache-Control: no-store`

**C. Defects found by the new tests and fixed**
- `readJson` on an already-consumed request threw `Invalid state: ReadableStream is locked`; the
  `getReader()` call is now guarded and returns `null`, so a handler that reads twice gets a bad-body
  answer instead of a 500.

**D. Not verified**
- ❌ No deployment, no `wrangler dev --remote`, nothing exercised against production
- ⚠ The "declared length above the limit is refused without reading" path is proven only
  in-process: workerd waits for the declared body before invoking the Worker, so over HTTP that
  claim cannot be observed end to end. It remains a cheap local guard, not a load-bearing check.
- ⚠ The webhook 413 is proven in-process only: both webhook routes answer 503 when their secret is
  unconfigured, before reading a body, and no secret was configured for local tests
- ⚠ `wrangler dev` (workerd) buffered bodies in these tests; the memory benefit of cancelling mid-
  stream is therefore not measured, only the correctness of the refusal

### Remaining Risks
- Low: 16 KiB may reject a legitimate checkout far larger than the 40-line/300-character shape the
  server already accepts; the cap is deliberate, and the error is a clear 413
- Low: 64 KiB may reject an unusually large gateway event; a gateway retry would hit the same answer
- Low: a new body-reading route must be given a limit; `readJson` defaults to the 4 KiB `settings`
  budget, which is a conservative fallback but not a substitute for choosing one
- Low: the per-endpoint budgets are judgement calls, not measurements of real traffic

### F-08 Verification Status Summary
- Code changes: ✅ Completed and inspectable
- Streamed limit enforcement: ✅ Verified locally (unit and both harnesses)
- Full local suite: ✅ 157/157 pass, 0 fail, 0 skip; `vite build` passes
- Deployment / Workers-runtime behaviour: ❌ Not exercised

---

## F-09 through F-20

*No security findings assigned to F-09 through F-20 in the project history visible at the time of this document's creation. These may relate to future work or were resolved in earlier project phases not captured in this context.*

### General Security Note
- F-01 through F-06 have local remediation work completed according to previous reports.
- The local harnesses were brought up during final F-07 validation, so the suite-wide "harness
  unavailable" notes earlier in this document are historical. The current full local suite is
  157 tests: 157 pass, 0 fail, 0 skipped.
- F-07 is code-complete and locally validated; its Cloudflare Workers CPU compatibility is not
  verified (no deployment, no CPU measurement).
- F-08 is code-complete and locally validated; nothing has been deployed.
- F-09 onward must be treated according to their actual status, not assumed complete.
- All findings above are based on code inspection and the test runs recorded here; the receiving
  agent should independently verify the current environment before assuming any status.
