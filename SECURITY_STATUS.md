# Corner Cup — Security Status: F-01 through F-20

**Date:** 2026-11-15
**Scope:** local repository only. Nothing in this document was verified on staging or in production.
**Supersedes for F-07:** `corner-cup-transfer/context/SECURITY_STATUS.md` (which still describes the
abandoned PBKDF2 600k design and the older F-01–F-06 numbering) and `F07_VALIDATION_REPORT.md`
(protected, unmodified, now historical).

## 1. Verification ledger

| Check | Command | Result |
| --- | --- | --- |
| Full suite, both harnesses | `npm test` (8789 + 8790) | **328 tests, 328 pass, 0 fail, 0 skipped** |
| Owner sessions (§10.2) | `tests/session.revocation.test.mjs` | 33/33: per-session sign-out, logout-all, password change, legacy/cross-tenant/expired refusals, injected read/insert/update/delete faults, two CAS races, concurrent actions, pruning, sliding renewal (success, failed write, expiry boundary, concurrency, CSRF continuity) and the 24-hour cap (just-before, exactly-at, past, concurrent renewals, cookie sync) |
| Owner-session migration | `tests/migrations.test.mjs` | fresh + legacy schema both get `owner_sessions` and its two indexes; a second boot is a no-op |
| Payment-state integrity | `status.transitions` (T14–T18) | 5/5: `confirmed`→`unpaid` 409, `confirmed`→`failed` 409, `unpaid`→`counter` 200, order-status flow unaffected by a confirmed payment, guard holds with no prior SELECT |
| Guard actually bites | guard removed, suite re-run | T14, T15 and T18 fail; T16 and T17 still pass — the tests target the rule, not the plumbing |
| F-02/F-03/F-08/F-10 re-review | adversarial probes against both harnesses | 40 checks; one defect fixed (`submitPayment` atomicity), two tests added, no auth or tenant-boundary bypass found |
| F-19 re-authentication | `tests/settings.reauth.test.mjs` | 8/8: missing/wrong/correct, lockout, counter reset, legacy + unsupported hashes, injected store failures |
| F-19 browser flow | Chromium, synthetic café in the local dev D1 | 9/9: field appears on typing, native `required` blocks an empty submit, 400 and 401 messages shown in place, 200 change, this tab stays signed in, the second session is refused, no-password save needs no re-authentication, no password in storage/URL/DOM |
| Production build | `npm run build` | pass — 275.51 kB JS / 89.28 kB gzip, 28.81 kB CSS / 6.39 kB gzip |
| Dependency audit | `npm audit` | **0 vulnerabilities** (info/low/moderate/high/critical all 0) |
| Local browser smoke | `wrangler dev` :3000, menu + owner routes | render; no CSP violations; CSS, JS, both WOFF2 fonts and both APIs 200 |
| Browser auth boundary | harness origin in Chromium | login 200; `document.cookie` empty (HttpOnly); cookie still authenticates; anonymous mutation 401 |
| Cookie flags over HTTP | `POST …/admin/login` | `HttpOnly; Path=/; SameSite=Strict; Max-Age=43200` (`Secure` only over https, by design) |
| Redirect / tenant fallback | browser + API | unknown route re-enters the SPA on-origin; `?next=` ignored; unknown slug 404 with no other tenant's data |
| Argon2id cost (local) | 20 hashes + 20 verifies via harness | hash p50 48.8 ms / p90 56.6 ms; verify p50 47.3 ms / p90 49.5 ms (HTTP wall clock, not Workers CPU) |
| Harness availability | `tests/harness/wrangler.jsonc` :8789, `wrangler.auth.jsonc` :8790 | both up; the 126 previously skipped tests now run |

Harnesses were started with separate persistence directories so they cannot contend for one SQLite
file:

```
cd tests/harness
npx wrangler dev --config wrangler.jsonc      --port 8789 --ip 127.0.0.1 --persist-to .state-plain
npx wrangler dev --config wrangler.auth.jsonc --port 8790 --ip 127.0.0.1 --persist-to .state-a2
```

The earlier "235 tests / 100 skipped" run was a partial run with no harnesses; it is superseded.

## 2. Status matrix

Status meanings: **COMPLETE** = locally implemented and verified; **PARTIALLY VERIFIED** = implemented
and locally tested but a production-relevant property is unmeasured; **ACCEPTED RISK** = reviewed,
judged tolerable now, documented rather than changed; **PENDING EXTERNAL DEPENDENCY** = needs an
account/credential/approval; **OPEN** = not fixed.

| # | Subject | Status | Verified by |
| --- | --- | --- | --- |
| F-01 | Deployment-wide fallback password | COMPLETE | `auth.fallback`, `auth.empty-login`, `migrations` |
| F-02 | Guest order tracking credentials | COMPLETE | `order.tracking`, `orders.integration`, `orderids`; re-reviewed 2026-11-15 |
| F-03 | Unauthenticated payment/status mutation | COMPLETE | `order.tracking`, `razorpay.payment`, `status.transitions`; counter choice made atomic 2026-11-15; staff downgrade from `confirmed` refused atomically |
| F-04 | Security headers | COMPLETE | `security.headers` (new), live `/api/health` |
| F-05 | Operator create-café CSRF | COMPLETE | `password.reset`, `operator.revocation` |
| F-06 | D1-backed rate limiting | COMPLETE | `rate.limit`, `rate.limits.migration` |
| F-07 | Password hashing and managed identity | PARTIALLY VERIFIED | `argon2.passwords` (new), `f07-regression`, `auth.race` |
| F-08 | Unbounded request bodies | COMPLETE | `body.limit`; re-probed 2026-11-15 (chunked, understated, absurd and absent lengths) |
| F-09 | Razorpay validation / production readiness | PARTIALLY VERIFIED | `razorpay.payment` (32 tests), payments disabled |
| F-10 | Owner/operator session revocation | COMPLETE | `session.revocation`, `operator.revocation`; CSRF cross-café binding pinned 2026-11-15 |
| F-11 | Cookie-name collision | COMPLETE | `cookie.name` |
| F-12 | Malformed cookie parsing | COMPLETE | `cookie.malformed` |
| F-13 | PhonePe removal | COMPLETE | no route/worker/client code; dead CSS only (§4.13) |
| F-14 | Order-ID concurrency race | COMPLETE | `orderid.concurrency`, `orderids`, `orders.integration` |
| F-15 | Health endpoint disclosure | COMPLETE | `health` |
| F-16 | Dependency vulnerabilities | COMPLETE | `npm audit` = 0 |
| F-17 | Google Fonts privacy / self-hosting | COMPLETE | no `googleapis`/`gstatic` reference; `public/fonts/*.woff2` |
| F-18 | Public menu/table data exposure | COMPLETE | `public.exposure` (new) |
| F-19 | Owner password change without current password | COMPLETE | `settings.reauth` (8), `auth.fallback`, `password.reset` |
| F-20 | Browser-observable security finding | COMPLETE | `browser.credentials` (new) |

## 3. Deployment status of every finding

`LOCAL ONLY` for all twenty. No deployment, preview deployment, staging deployment, production
migration or secret change was performed in this session. Local verification is code + local runtime
behaviour only; it is not evidence about a deployed Worker.

## 4. Finding detail

### F-01 — Deployment-wide fallback password (COMPLETE)
**Original risk:** any café with a NULL hash was opened by one deployment-wide `OWNER_PASSWORD`/`ADMIN_PIN`.
**Fix:** `login()` verifies only the café's own hash; no hash → 503 with an operator-reset instruction;
`ADMIN_PIN` is never read; `OWNER_PASSWORD` can only seed the primary café's hash once, guarded by
`pass_hash IS NULL`, and only if it satisfies the 12-character policy (`bootstrapOwnerPassword`).
**Files:** `worker/api.js` (`login`), `worker/db.js` (`bootstrapOwnerPassword`, `bootstrapPrimaryPassword`).
**Tests:** `auth.fallback.test.mjs`, `auth.empty-login.test.mjs`, `migrations.test.mjs` — all pass.
**Limitation:** an operator who leaves a strong `OWNER_PASSWORD` set keeps a working bootstrap path by design.

### F-02 — Guest tracking credentials (COMPLETE)
**Fix:** per-order 192-bit nonce; token = HMAC-SHA256 over `v1:<cafe>:<order>:<nonce>` with a dedicated
subkey; D1 stores only `sha256(token)`; token is returned once to the buyer and derivable on replay.
**Files:** `worker/tracking.js`, `worker/orders.js`, `worker/api.js` (`authorisedOrder`, `orderPayload`).
**Tests:** `order.tracking`, `orders.integration`, `orderids` — all pass.
**Limitation:** the token is a bearer capability — whoever holds the URL can track that one order.

### F-03 — Unauthenticated payment/status mutation (COMPLETE)
**Fix:** every guest read/mutation of an order requires the tracking token in `x-order-token`; a token in
the query string is refused. Guests may only choose counter payment (`status: "counter"`); confirmed
payment is written only by the Razorpay signature check or staff. Status transitions are one step at a
time via `canTransitionStatus`.
**Tests:** `order.tracking` (query-string refusal, cross-order and cross-café tokens), `status.transitions`, `razorpay.payment`.

### F-04 — Security headers (COMPLETE)
**Fix:** CSP (`default-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'`,
`form-action 'self'`, no `unsafe-inline`/`unsafe-eval`, no wildcard), `nosniff`, `X-Frame-Options: DENY`,
`Referrer-Policy`, `Permissions-Policy`, and — added this session — `Strict-Transport-Security:
max-age=31536000; includeSubDomains`. `json()` sets `no-store`; wrapped static responses keep their own
caching. API responses carry no `Access-Control-Allow-Origin`.
**Files:** `worker/http.js`, `worker/index.js`.
**Tests:** `security.headers.test.mjs` (new, 4 tests) — unit + live `/api/health`.
**Limitation:** HSTS is ignored over plain http (the local dev server), so its effect is only observable
on an https deployment. Razorpay's script/style origins remain allowlisted while payments are off (§4.9).

### F-05 — Operator create-café CSRF (COMPLETE)
**Fix:** `operatorCreateCafe` and `operatorResetPassword` require an `Origin` equal to the request origin
plus an `x-csrf-token` that hashes to a live row bound to the operator session cookie; token rows are
deleted when expired and on logout.
**Files:** `worker/api.js` (`verifyCsrf`, `issueCsrfToken`, `operatorCreateCafe`, `operatorResetPassword`).
**Tests:** `password.reset` (CSRF cases), `operator.revocation`.

### F-06 — D1-backed rate limiting (COMPLETE)
**Fix:** single-statement atomic upsert with `RETURNING`; windows reset in the same statement; count is
capped; bounded opportunistic cleanup (≤100 rows, sampled, never changes a decision); failures fail
closed with 503. Login lockouts are keyed by café + hashed IP (8 failures / 10 min); the API limiter is
600 requests / minute / hashed IP. Raw IPs are never stored.
**Files:** `worker/api.js` (`touchRateLimit`, `checkApiRateLimit`, `clientIp`), `worker/db.js`.
**Tests:** `rate.limit`, `rate.limits.migration`.

### F-07 — Password hashing and managed identity (PARTIALLY VERIFIED)
**Actual implementation in the repository:** Argon2id, `m=19456`, `t=2`, `p=1`, 16-byte salt, 32-byte
tag, PHC string `$argon2id$v=19$m=19456,t=2,p=1$…`, via `argon2id@1.0.1` with **statically imported**
`simd.wasm`/`no-simd.wasm` (workerd refuses `WebAssembly.compile` from bytes, which is why hash-wasm
cannot run here).
**Legacy support:** PBKDF2 is verified only up to 100,000 iterations — the platform's WebCrypto ceiling.
A higher work factor (e.g. the historical 600k) is never recomputed weaker: `passwordNeedsReset()`
returns true and sign-in answers 409 "ask the operator to reset it". A successful legacy verification is
opportunistically rehashed to Argon2id with compare-and-swap on the exact verified string, and the
rehash deliberately does **not** bump `auth_version`.
**Queue behaviour:** one derivation at a time per isolate plus `MAX_QUEUE = 3` waiters. Overflow raises
`PasswordQueueFullError`, which `login()` turns into 429 "Too many sign-in attempts right now". Measured
locally in workerd: 3 concurrent → 3 ok; 6 concurrent → 4 ok / 2 refused / 0 errors.
**Runtime evidence:** real hashing, verification, legacy verification and queue saturation all execute in
workerd through `tests/harness` `/passwords/*`, and every auth suite signs in through the real route.
**Defect found and fixed this session:** the library rejects passwords shorter than 8 bytes, so a sign-in
guess like `"1234"` used to throw out of `verifyPassword` and answer **500** without counting a failed
attempt. `verifyPassword` now fails closed for sub-minimum input (401 + lockout increment). No hash this
code writes can be shorter than 8 bytes (every caller enforces 12+ characters), so nothing legitimate was
weakened.
**Platform limits that apply (Cloudflare Workers, verified 2026-11-15 against the official Limits page):**

| Constraint | Free | Paid (Standard) |
| --- | --- | --- |
| CPU time per HTTP request | **10 ms** | default **30 s**, configurable up to **5 min** |
| Memory per isolate (JS heap + WebAssembly) | **128 MB** | **128 MB** |
| Exceeding either | Error 1102 | Error 1102 |

CPU time excludes network waits. Memory is per **isolate**, shared by every concurrent request that
isolate serves — not per invocation.

**Local measurements (this workstation, `wrangler dev`/workerd, 20 samples each):** hash p50 **48.8 ms**,
p90 56.6 ms, min 46 ms, max 75.3 ms; verify p50 **47.3 ms**, p90 49.5 ms. workerd process RSS was
159.6 MB before, 160.7 MB after 10 sequential hashes and 161.1 MB after two 6-way bursts — flat, so the
wasm heap is reused rather than growing per derivation.

**Interpretation — what this does and does not establish:**
- **CPU is the binding problem on Free.** The derivation is CPU-bound work of roughly 38 MiB of
  memory-hard passes; ~47–49 ms of wall clock here is far above a **10 ms CPU budget**. A sign-in on a
  Free-plan Worker is therefore expected to hit Error 1102 (which the queue cannot prevent — only a
  Paid plan or a different identity design can).
- **Paid is comfortable on CPU, tight on memory.** 30 s default CPU dwarfs ~50 ms; the open question is
  the 128 MB isolate budget, of which the module's own comment accounts ~65 MB for the loaded wasm
  instance plus 19 MiB for the active derivation (~84 MB), leaving ~44 MB for the JS heap and every
  concurrent guest request in that isolate. The queue bounds *derivations* to one at a time (waiters
  allocate nothing), which is what keeps that from scaling with traffic.
- **Not measurable locally, at all:** Cloudflare's billed CPU milliseconds; per-isolate memory
  accounting (the local number is a whole dev process, not an isolate); cold-start wasm instantiation
  on a fresh deployment; behaviour across multiple isolates under real traffic.
- The Workers dashboard now exposes a Memory Usage chart (P50–P999) and Error 1102 counts; those are the
  instruments for closing this, and they require a deployment the current constraints forbid.
**WorkOS:** not implemented and not approved. It remains the documented future direction *if* deployed CPU
limits make local hashing unviable; it needs an account, secrets and explicit approval, none of which exist
here. No authentication was replaced or weakened in this session.

### F-08 — Unbounded request bodies (COMPLETE)
**Fix:** one streaming reader with per-endpoint byte budgets, enforced while the stream arrives; a
declared `Content-Length` above the budget is an early refusal only; one generic 413 for the whole API
that names no limit; guarded second reads.
**Files:** `worker/http.js` (`BODY_LIMITS`, `readText`, `readJson`), `worker/api.js` (`handleApi`).
**Tests:** `body.limit` — all pass.
**Limitation:** workerd buffers bodies, so the memory benefit of mid-stream cancellation is not measured

- only the correctness of the refusal.

### F-09 — Razorpay validation and production readiness (PARTIALLY VERIFIED)
**State:** disabled. With no key pair the provider is `none`, `keyId` is null, and guests are offered
counter payment. Every payment route answers 503 while unconfigured.
**Validated locally (stubbed gateway, no network calls):** the order-bound tracking token is required;
client-supplied amount/currency are ignored (server uses stored total + INR); the browser signature is
verified as HMAC(`order|payment`); the payment is re-fetched and must be `captured`, belong to the
gateway order, match amount exactly and be INR; settlement is a single conditional UPDATE so it happens
once; a claim with TTL prevents duplicate gateway orders; a stalled gateway fails safely without retrying.
**Tests:** `razorpay.payment.test.mjs` — all pass.
**Verified controls (read from code, exercised in tests):**
- creating a gateway order requires the order's tracking token; the amount and currency come from the
  stored row and the request body is never read for them;
- browser verification requires `razorpay_order_id` to equal the stored `payment_ref`, checks
  HMAC-SHA256(`order|payment`) against `RAZORPAY_KEY_SECRET` in constant time, then re-fetches the
  payment from the gateway and requires `status = captured`, same `order_id`, `currency = INR` and an
  amount **exactly** equal to `total_cents`;
- the webhook requires `RAZORPAY_WEBHOOK_SECRET`, verifies the raw body's `x-razorpay-signature` in
  constant time, resolves the café's own order only, applies the same amount/currency equality, and
  acknowledges mismatches so the gateway stops retrying;
- settlement is one conditional UPDATE (`payment_status != 'confirmed'`), so the browser and webhook can
  race without double-paying or double-alerting; `payment.failed` only moves an unpaid order to failed.

**Exact remaining work before production use (none of it done here):**
1. A live/test-mode account, KYC, and keys installed with `wrangler secret put` — never in the repo.
2. `RAZORPAY_WEBHOOK_SECRET` set and the webhook URL registered in the dashboard for both supported
   spellings (`/api/cafes/:slug/razorpay/webhook`, `/api/cafes/:slug/webhooks/razorpay`).
3. CSP verified against the real Checkout script on an https origin: `script-src`, `frame-src` and
   `connect-src` allowlists are plausible but unproven, and Checkout's injected styles may require a
   `style-src` decision that is deliberately not `unsafe-inline` today.
4. One end-to-end capture and one failure on a **staging** Worker, plus a replayed webhook to confirm
   idempotency there (proven locally with a stub only).
5. A decision on tenancy: `RAZORPAY_KEY_ID`/`SECRET` are deployment-wide Worker variables, so every café
   would settle into one account. Multi-tenant payouts are a product/business decision, not a code fix.
6. Refund, partial-payment, expired-order and chargeback handling (out of scope today; nothing in the
   current code processes `refund.*` events).
7. If paying per-request CPU becomes relevant: the sign-in cost analysis above applies to this Worker as
   a whole, not just auth.

### F-10 — Owner/operator session revocation (COMPLETE)
**Fix:** owner "sign out everywhere" is a compare-and-swap bump of `cafes.auth_version` that reissues the
caller's cookie; failure returns 500 and changes nothing, and an invalid stored version fails closed.
Operator "sign out everywhere" deletes all sessions and inserts a replacement in one atomic batch; a
failed batch reports 500 and issues no cookie. Operator sessions live in D1 (`operator_sessions`) and are
checked on every operator request; legacy bare `operator` subjects and expired rows are rejected.
Owner sessions are now a server-side allowlist too (`owner_sessions`, §10.2): ordinary sign-out deletes
that one row, and every authenticated owner request checks its row before the version comparison decides.
**Files:** `worker/api.js` (`logout`, `logoutEverywhere`, `operatorLogoutEverywhere`, `checkOperator`,
`ownerSession`), `worker/db.js` (`owner_sessions`).
**Tests:** `session.revocation`, `operator.revocation` (including injected D1 failures) — all pass.

### F-11 — Cookie-name collision (COMPLETE)
**Fix:** the full slug is used in `staff_session_<slug>`; slugs are capped at 40 characters by `slugify`,
so the name never exceeds 54 characters and never needs truncation.
**Files:** `worker/api.js` (`cookieName`), `worker/db.js` (`slugify`). **Tests:** `cookie.name`.

### F-12 — Malformed cookie parsing (COMPLETE)
**Fix:** `readCookie` skips a value that fails `decodeURIComponent` and keeps looking, so one malformed
cookie cannot turn a request into a 500. **Tests:** `cookie.malformed`.

### F-13 — PhonePe removal (COMPLETE)
**Fix:** no PhonePe route, handler, client or configuration remains in `worker/`, `src/` or `wrangler.jsonc`;
a repository search finds only an unused `.upi-app.phonepe` CSS rule.
**Limitation:** that dead CSS rule (and the unused `.upi-app.*` family) is cosmetic leftover; it has no
runtime or security effect and was left alone to avoid churn.

### F-14 — Order-ID concurrency race (COMPLETE)
**Fix:** bounded retry loop — 4 attempts, each with a fresh id, nonce, tracking token and hash; only a
`orders.id` PRIMARY KEY collision is retried (`isOrderIdCollision` is deliberately narrow); capacity
exhaustion releases the claim and answers 503; the order + items + commit marker are one D1 batch, so no
partial order and no cross-attached item can be written.
**Files:** `worker/orderids.js`, `worker/api.js` (`createOrder`), `worker/orders.js`.
**Tests:** `orderid.concurrency`, `orderids`, `orders.integration` (PK-once, PK-always, non-PK errors,
exhausted-id 503 + claim release).
**Limitation:** a genuinely simultaneous same-ID reproduction is still not exercised (single isolate);
the retry path is proven by deterministic fault injection instead. `worker/orderids.js`'s comment, which
claimed the race was left open and answered 500, was stale and has been corrected.

### F-15 — Health endpoint disclosure (COMPLETE)
**Fix:** `/api/health` returns only `status`, `database`, `time`; 503 when the DB probe fails; no provider
or configuration detail. **Tests:** `health` — all pass.

### F-16 — Dependency vulnerabilities (COMPLETE)
**State:** `npm audit` reports zero vulnerabilities. React Router is on 7.18.5. Direct deps: `argon2id`,
`qrcode`, `react`, `react-dom`, `react-router-dom`; dev: `@vitejs/plugin-react`, `jsdom`, `vite`,
`wrangler`.
**Limitation:** an audit is a snapshot; rerun after any dependency change. Two minor updates are
available (jsdom 31.0.1, vite 6.4.6) and were deliberately not taken to avoid churn without a CVE.

### F-17 — Google Fonts privacy / self-hosting (COMPLETE)
**State:** no `fonts.googleapis.com`/`fonts.gstatic.com` reference anywhere in `src`, `index.html` or
`worker/`; `public/fonts/` holds `fraunces-latin.woff2`, `inter-latin.woff2` and `OFL.txt`; CSP allows
`font-src 'self' data:` only. The live smoke test loaded both fonts with no console error.
**Limitation:** the files are Latin subsets, so non-Latin scripts fall back to system fonts. This is a
typography limitation, not a privacy or security one.

### F-18 — Public menu/table data exposure (COMPLETE)
**State:** menu, tables and config are intentionally public so guests can order without an account. The
security property is that nothing private rides along: `/api/config` exposes name/phone/email/address +
service mode + public payment key only; `/api/menu` item shape is `{id,name,description,priceCents,emoji,available}`
and table data is the café-facing `{id,label,seats}`; the bare-domain summary is `{slug,name,serviceMode}`;
an unknown slug is 404, never another tenant; the staff settings view is 401 without a session.
**Tests:** `public.exposure.test.mjs` (new, 6) including a scan for `pass_hash`, `auth_version`,
`track_hash`, `track_nonce`, `csrfToken`, `session_id`, `$argon2id` and `pbkdf2$`.
**Limitation:** contact details on `/api/config` are public by design (they belong on the menu page).

### F-19 — Owner password change without current password (COMPLETE)
**Original risk:** `PATCH /api/cafes/:slug/admin/settings` with `{ password }` replaced the owner credential
for anyone holding a valid session. A shared tablet left signed in, or a copied cookie, was therefore enough
to take the café over and lock the owner out: the session boundary was the only barrier to a permanent
credential change.
**Fix (implemented 2026-11-15, approved by the owner):** a password change is now gated on the current
password. `verifyOwnerReauth()` runs after field validation but **before the new hash is computed and
before any UPDATE**, so a refusal writes nothing at all — not the password, not the café name, not a
contact field sent in the same request. A plain settings save with no `password` still needs only the
session, so nothing else in the panel became harder to use.
**Implemented as follows:**
1. `worker/api.js` `adminSaveSettings`: when `body.password !== undefined`, require
   `body.currentPassword` and check it with the existing `verifyPassword(currentPassword, cafe.pass_hash)`
   **before** any UPDATE, so a wrong or missing current password changes neither the hash nor the rest of
   the patch (the name/contact fields in the same request are abandoned too — all-or-nothing).
   - missing/blank → **400** "Enter your current password to change it";
   - wrong → **401**, no write, and count the attempt against a `settings:<cafe>:<ip>` rate-limit key
     (reusing `touchRateLimit`) so this cannot become a fresh password-guessing oracle;
   - café has no hash, or a legacy hash above the supported ceiling → **409** "ask the operator to
     reset it", matching sign-in's fail-closed behaviour.
2. `src/pages/Admin.jsx`: one `currentPassword` field in the existing password block, sent only when a
   new password is typed; keep the typed value on failure; show the server's message inline.
3. Tests (`tests/settings.reauth.test.mjs`, 8): a save without a password needs no re-authentication;
   missing → 400 with the café name in the same request not applied; wrong → 401 with every field left
   alone and `auth_version` unchanged; correct → 200, version bumped once, the pre-change cookie refused,
   the replacement cookie accepted, old password refused and new password accepted; five failures → 429
   even for the right password, then success after the counter is cleared; a success clears the counter;
   a legacy 100k PBKDF2 password re-authenticates and is upgraded; a 600k hash and a NULL hash → 409
   (operator reset), never a weaker check; injected read/write failures of the counter → 503 with no
   change installed.

**Behaviour and status codes:** missing or blank current password → **400**; wrong → **401**; no stored
hash or an unsupported work factor → **409** with the operator-reset instruction (identical policy to
sign-in, which answers 409/503 for those states); counter unreadable/unwritable → **503** (fail closed,
nothing written); lockout active → **429**. A successful change clears the counter, bumps `auth_version`
(so every other device is signed out), stamps `password_changed_at`, and reissues this browser's cookie.

**Concurrency:** the credential UPDATE is guarded by the `auth_version` this request verified
(`WHERE id = ? AND auth_version = ?`). If another change landed in between, zero rows change and the
request answers **409** rather than letting a stale-but-correct old password overwrite the credential
that already superseded it. Preference-only saves remain last-write-wins, as before. The guarded write is
a single statement (verified by the success path); the interleaving itself has no deterministic repro.

**Cost/risk of the change:** one extra field and one Argon2id verify per password change; the request
shape changed for the admin UI only (no public API consumer). No migration, no new dependency, no change
to hashing or session lifetime. The operator reset flow is unaffected, and a full settings save without a
password behaves exactly as before.

**Browser verification (2026-11-15, Chromium, synthetic café `f19-verify` created in the local dev D1 and
deleted afterwards; nothing from `.dev.vars` was read):**
1. Café setup renders with name, service style, clock, phone, email, address and the password block.
2. Typing a new password reveals the "Current owner password" field (absent before, absent again after a
   successful save), marked `required`.
3. Submitting with it empty is stopped by native validation (`formValid:false`, "Please fill out this
   field.") and sends no request.
4. Wrong current password → **401** "That current password doesn't match." shown under the form, the
   owner stays on the board, and the typed new password is preserved. Missing current password (native
   gate bypassed) → **400** "Enter your current password to change it.", likewise in place.
5. Correct current password → **200**, "Saved — the guest site picks this up straight away.", fields reset.
6. This tab's session still answers 200 immediately after the change.
7. A second, separately signed-in session (incognito partition) went from 200 to **401**, and its
   `PATCH …/settings` was refused 401 — the café name it tried to write did not change.
8. A save with only the café name renamed (no password typed, no current-password field) → **200**.
9. No password string appeared in `localStorage`, `sessionStorage`, `document.cookie` (empty — the
   session is `HttpOnly`), the URL, the rendered page text, or any resource URL; error messages never
   echo a password. A later sign-in with the new password answered 200 and the old password 401.

**Bug found and fixed by this pass:** the wrong-password **401** was caught by the staff screen's global
"session ended" handler, which signed the owner out and hid the message. The response now carries
`code: "reauth_required"`, and only a 401 without that code triggers a sign-out — so a typo is just a
message, while a genuinely dead session still ends the screen.

**Remaining limitations:** the counter is keyed by café + client IP (5 failures / 10 min), so an owner who
has genuinely forgotten the password still needs the operator reset — that is the intended recovery path,
not a bypass. The browser pass covered one desktop viewport; keyboard-only traversal of the new field was
not separately scripted.

**Files:** `worker/api.js` (`verifyOwnerReauth`, `adminSaveSettings`), `src/pages/Admin.jsx`
(`SettingsTab`), `tests/settings.reauth.test.mjs` (new). **Tests:** `settings.reauth`, `auth.fallback`
(password-change path, updated to send `currentPassword`), `password.reset` (owner change path, updated), `f07-regression` (version bump).

### F-20 — Browser-observable security finding (COMPLETE)
**Definition used:** anything a page script, storage dump or URL can read that grants access.
**Findings and state:**
1. **Legacy staff token in `localStorage`** (the original browser-observable issue, from before the
   cookie migration): the board now clears `admin_token` on mount, and no code reads or writes it. The
   session itself is an `HttpOnly; SameSite=Strict; Path=/` cookie (`Secure` over https), so page
   JavaScript cannot read it at all.
2. **Guest tracking token:** read only from `location.hash` (fragment), never from the query string and
   never written to storage, so it is not sent to the server in a request line or leaked in `Referer`.
3. **Injection surface:** the client has no `dangerouslySetInnerHTML`, `eval`, `new Function`,
   `document.write` or `document.cookie` write.
**Tests:** `browser.credentials.test.mjs` (new, 5) — static contracts over every `src/**/*.{js,jsx}` plus
the cookie builder in `worker/api.js`.
**Residual:** the fragment token is visible to whoever holds the device and persists in browser history.
That is inherent to a capability URL; it is scoped to one order and cannot authorize a payment mutation
beyond that order.

## 5. Production-readiness assessment

**Not production ready.** The local suite is green and the local Worker behaves correctly, but none of the
following has been established:

1. **Argon2id cost on the deployed runtime.** 19 MiB and two passes per sign-in may exceed a Free-plan CPU
   budget. Until that is measured on a staging Worker, the queue/429 design is a mitigation, not a proof.
2. **No staging deployment.** Headers, HSTS, cookies, D1 migrations, static asset behaviour and the SPA
   fallback are verified only against `wrangler dev`.
3. **Migrations on a real database.** Schema creation and the add-column migrations are tested locally
   only; the production data path is unexercised.
4. **Payments are off.** Razorpay is validated against a stub, not a live account; webhook secrets and
   CSP assumptions are untested end to end.
5. **F-19 is fixed and verified end to end locally** — API tests plus a browser pass over a synthetic café
   in the local dev database (see §4.19). What still cannot be verified here is F-07's CPU time and memory
   on the deployed runtime.

## 6. Next three actions

1. Deploy to an isolated staging Worker with its own disposable D1 and measure Argon2id CPU/memory and
   sign-in latency there, including the 429 path under concurrency.
2. Walk the new current-password prompt through the real owner UI on a staging build (the API path is
   covered by tests; the rendered form has not been clicked).
3. Re-run this suite against staging (`AUTH_HARNESS_URL` / `HARNESS_URL` pointed at the staging origin)
   to confirm headers, cookie flags, migrations and rate limits on the real runtime.

## 7. Files changed in this session

| File | Change |
| --- | --- |
| `worker/http.js` | added `Strict-Transport-Security` to the shared header set (F-04) |
| `worker/passwords.js` | sub-8-byte passwords fail closed instead of throwing a 500 (F-07) |
| `worker/orderids.js` | corrected the stale comment describing F-14's retry behaviour |
| `tests/argon2.passwords.test.mjs` | **new** — 9 workerd runtime tests for Argon2id, legacy PBKDF2, malformed input, short input, queue bounds |
| `tests/security.headers.test.mjs` | **new** — 4 tests for API/static header sets incl. HSTS and no-CORS |
| `tests/public.exposure.test.mjs` | **new** — 6 tests for F-18 public payloads and slug scoping |
| `tests/browser.credentials.test.mjs` | **new** — 5 tests for F-20 browser-observable credentials |
| `tests/orders.deep.test.mjs` | **new** — 9 deep ordering tests: pickup numbering (incl. 5 concurrent), server-side pricing, quantity bounds, cross-tenant menu items, table/mode rules, key scoping, unauthorized staff mutation |
| `worker/api.js` | **F-19** — `verifyOwnerReauth` gate before any settings write; 400/401/409/429/503 paths; version-guarded credential UPDATE; `code: "reauth_required"` on the wrong-password 401 |
| `src/pages/Admin.jsx` | **F-19** — current-password field (rendered only while a new password is typed, `required`); the shell no longer treats that specific 401 as an ended session |
| `tests/settings.reauth.test.mjs` | **new** — 8 F-19 tests |
| `tests/harness/worker.mjs` | test-only `/set-hash`, `/rate-limit/keys`, settings-counter fault injection; `/clean` now drops that café's login/settings counters (fixes cross-test carry-over when `/seed` reuses an id) |
| `tests/auth.fallback.test.mjs`, `tests/password.reset.test.mjs` | updated to the new contract (send `currentPassword`) |
| `SECURITY_STATUS.md` | **new** — this document |

No other tracked file was edited. All pre-existing modified and untracked files were preserved.

## 8. Constraints honoured

No deployment of any kind (production, preview or staging); no `git add`, commit, push, reset, clean or
checkout; no production migration or production database access; no credential or secret change; Razorpay
not enabled; no real order or payment placed. `corner-cup-transfer/` and `F07_VALIDATION_REPORT.md` were
read only, never modified.

## 9. Reconciliation notes (2026-11-15, second pass)

Every substantive claim above was re-checked against the current source rather than carried over from an
existing report. What was compared and what was found:

| Claim | Checked against | Result |
| --- | --- | --- |
| New hashes are Argon2id m=19456,t=2,p=1 | `worker/passwords.js` + live `/passwords/hash` output | confirmed (`$argon2id$v=19$m=19456,t=2,p=1$…`, 100-char PHC) |
| Legacy PBKDF2 only up to 100k, higher fails closed | `PBKDF2_MAX_SUPPORTED`, live 100k and 600k hashes | confirmed (100k verifies; 600k → needsReset, never weakened) |
| Bounded hashing queue, 429 on overflow | `MAX_QUEUE = 3`, live burst of 6 | confirmed (4 ok / 2 refused / 0 errors; 3 → 3 ok) |
| HSTS on every response | `worker/http.js`, live `/api/health` and document | confirmed |
| No CORS opening | `json()`/header set, live response | confirmed (no `Access-Control-Allow-Origin`) |
| Session cookie flags | live `Set-Cookie` + Chromium `document.cookie` | confirmed (`HttpOnly`, `SameSite=Strict`, `Path=/`, `Max-Age=43200`; invisible to script) |
| Staff mutations need a session | page-context PATCH/GET on `/admin/*` | confirmed 401 for settings, orders, logout-all; operator console 401 |
| Unknown tenant never falls back | browser + API for a bogus slug | confirmed 404, default café's name absent from the page |
| No open redirect | `/definitely-not-a-page?next=https://evil.example` | confirmed: SPA returns to `/c/<primary slug>`, external target ignored |
| Pickup numbers unique under concurrency | 5 simultaneous checkouts | confirmed 1–5, no duplicates |
| Client money ignored | tampered `totalCents`/`priceCents` | confirmed: stored price and name win |
| Cross-tenant menu item rejected | café B's item in café A's cart | confirmed 400 + claim released, nothing written |
| Order id cannot mutate staff state | PATCH with no cookie, forged cookie, guest tracking token | confirmed 401 for all three |
| Password change requires re-authentication | `adminSaveSettings` + `settings.reauth` | implemented and verified — see §4.19 |
| Razorpay webhook controls | `razorpayWebhook` | confirmed raw-body HMAC, constant-time, amount/currency equality, tenant-scoped, idempotent settle |

**Stale artefacts that must not be trusted for this repository:**
- `F07_VALIDATION_REPORT.md` (protected) documents PBKDF2 at 600,000 iterations. That is **not** what the
  code does — the current implementation is Argon2id, and 600k PBKDF2 could not even be verified here
  (above the platform's 100k WebCrypto ceiling). It is retained for history only.
- `corner-cup-transfer/context/SECURITY_STATUS.md` uses an older, conflicting numbering (there F-03 is
  operator CSRF, F-04 is rate limiting, F-05 is token storage, F-06 is an auth race, F-07 is PBKDF2). The
  project's current definitions are the ones in this document; do not mix the two.

**Untracked files that carry critical logic.** `worker/passwords.js`, `worker/orderids.js` and
`worker/tracking.js` are not tracked by git. They were preserved byte-for-byte this pass; recorded hashes
at the checkpoint:

```
5de52a5a55ae76c0b92b366792883b99820ebecfac31663ea80d107b2153d469  worker/passwords.js
09187063a9dc4db214ad3f762470d9c2118c6a371971cf0678cba93485a7403d  worker/orderids.js
112237e08aa2e9481f5bbd81a76a8e7dc51c770d2a00a29a9f4f2e6d47249ed4  worker/tracking.js
```

Anyone who runs `git clean -fdx` before these are tracked will delete the Argon2id implementation, the
order-id retry logic and guest tracking. There are copies in `corner-cup-transfer/project/worker/` for
`passwords.js` and `tracking.js` — but that whole directory is untracked as well, and there is **no** copy
of `orderids.js` anywhere outside `worker/`.

## 10. F-02 / F-03 / F-08 / F-10 review (2026-11-15)

**Method:** read `worker/tracking.js`, `worker/orders.js`, `worker/http.js` and the `authorisedOrder`,
`getOrder`, `submitPayment`, `createRazorpayPayment`, `adminUpdateOrder`, `sessionStatus`,
`logoutEverywhere`, `operatorLogoutEverywhere`, `checkOperator`, `ownerSession` and `verifyCsrf` paths;
then 40 adversarial probes against both local harnesses, each with an authorised and an unauthorised
variant.

### What held
- **F-02.** The token is required and bound to café *and* order: a bare id, an empty header, a wrong
token, a token in the query string, a sibling order's token and a cross-café token all answer the same
generic 404. D1 holds `sha256(token)` plus a random nonce, never the token; staff responses expose
neither. The replay path only returns a token to a caller who presents the same `Idempotency-Key`
(the browser sends `crypto.randomUUID`) *and* a matching cart fingerprint.
- **F-03.** A guest may only choose counter: `{status:"confirmed"}` → 400 with nothing written,
cancelled → 409, and staff routes answer 401 with a guest token or no session.
- **F-08.** 2 KB on a 1024-byte route → 413 with a generic message; 200 KB → 413; a body exactly at the
budget is accepted (16,384-byte checkout → 201) while one byte over → 413; 40 KB chunked with no
`Content-Length` → 413; an understated `Content-Length` cannot bypass the streamed count; absurd or
non-numeric lengths are rejected by the runtime with 400 before our code; a body on a route that never
reads one is ignored, not buffered.
- **F-10.** Sign-out-everywhere is refused without a CSRF token (403), from a foreign Origin (403) and
with another café's token (403); the authorised call bumps the version, kills the old cookie and a second
device, and reissues a working cookie; repeating it works once the board refreshes its CSRF token; a
café A cookie presented to café B is 401.

### The one defect found and fixed
`submitPayment` read the order's `payment_status` and then wrote `counter` — two statements. A payment
confirmed by the gateway or by staff *between* them was overwritten: money captured, ticket showing
counter/unpaid. It is now one guarded write (`counterPaymentStatement` in `worker/orders.js`,
`… AND payment_status != 'confirmed'`), and zero changed rows means "already paid" rather than a retry,
so the decision happens inside the write. `payment_status` is `NOT NULL DEFAULT 'unpaid'`, so the guard
cannot fall through a NULL.

Regression tests added:

| Test | Suite | Proves |
| --- | --- | --- |
| a payment the café already confirmed cannot be downgraded by the guest | `order.tracking` | staff-confirmed ticket survives the guest's counter choice; the production statement reports `changes = 0` on it and `changes = 1` on an unpaid one |
| a CSRF token is bound to its own café and its own session | `session.revocation` | A's token cannot sign B out or vice versa (403 both ways), no version bumped, both sessions still 200 |

### Prioritized remaining genuine risks
**P1 — would block production:** none newly found in these four findings.

**P2 — real, bounded, needs a decision:**
1. ~~**Staff can walk payment state backwards with no audit.**~~ — **closed 2026-11-15.** A confirmed
   payment can no longer be moved to `unpaid`, `submitted` or `failed`; the rule is a `WHERE` clause in
   the statement itself (§10.1). What remains open is only *attribution*: these writes are not logged
   with who made them, which needs an audit table (a migration) and is out of scope here.
2. ~~**Ordinary sign-out is not revocation.**~~ — **closed 2026-11-15.** Owner sessions are rows in
   `owner_sessions`; ordinary sign-out deletes its own row, so a copied cookie is refused on the next
   request while the other devices keep working (§10.2).
3. ~~**Owner revocation is all-or-nothing.**~~ — **closed 2026-11-15.** Signing one device out removes
   only that row; sign-out-everywhere still bumps the version and clears the rest (§10.2).
4. **Carried over and still the largest production risks:** F-07's Argon2id CPU cost has never been
   measured on the deployed runtime, and F-09 (Razorpay) is unconfigured, so its end-to-end path is
   unproven.

**P3 — accepted for now:**
5. **Tracking tokens never expire.** A shared or stored order link is a permanent read capability for
   that one order (plus the pay-at-counter choice). Expiry would need a column and a policy.
6. **Slow-drip bodies** are bounded by the platform's request timeout, not by this code; that timeout is
   not measurable locally.
7. **A session now ends 24 hours after sign-in even if it is in constant use.** The cap (24 h from `created`,
enforced in the read and the renewal write) bounds a forgotten shared tablet to a day; the cost is a
re-login for a shift or a device that would otherwise run longer. Both limits and their trade-off are in
§10.2, and the cap is a single constant if the policy changes.

### 10.1 Paid tickets stay paid (closed 2026-11-15)

**The rule:** through the staff order-update endpoint, a ticket whose payment is `confirmed` cannot be
moved to `unpaid`, `submitted` or `failed`. Those three values assert the ticket is not paid; `counter`
and `confirmed` both mean money was taken, so they stay allowed (`confirmed` → `counter` is a rail
correction, not a reversal). No refund or reversal workflow was added, and no status transition changed.

**Where it lives:** `paymentStatusSets()` and `staffOrderUpdateStatement()` in `worker/orders.js`. The
guard is appended to the `WHERE` clause (`AND payment_status != 'confirmed'`), so it is evaluated by the
same write that changes the row — a confirmation landing between the request's read and its write cannot
be overwritten. Zero changed rows is then disambiguated with one read: a still-confirmed row answers
**409** `{ code: "payment_already_confirmed" }`, a missing order stays 404. A body that changes status *and*
attempts a downgrade is refused whole rather than half-applied.

**Bypass check:** every writer of `payment_status` now carries a guard — gateway verification (`api.js`
:1444, sets `confirmed`), the webhook failure path (:1568, sets `failed`), the guest counter choice
(`counterPaymentStatement`), and the staff endpoint. There is no remaining path that can move a confirmed
ticket to an un-paid state.

**Tests:** T14 (`confirmed`→`unpaid` 409, rail and `paid_at` intact), T15 (`confirmed`→`failed` 409),
T16 (`unpaid`→`counter` 200 with rail and timestamp), T17 (`new`→`preparing`→`ready`→`served` all 200 with
a confirmed payment untouched), T18 (the production statement run with **no prior SELECT** changes 0 rows
on a confirmed ticket and 1 on an unpaid one — the atomicity claim, tested directly). Removing the guard
fails T14, T15 and T18 and leaves T16/T17 green.

**Files changed by this review:** `worker/orders.js` (guarded counter statement, payment-set builder, guarded staff update),
`worker/api.js` (`submitPayment` and `adminUpdateOrder` use them), `tests/order.tracking.test.mjs`,
`tests/status.transitions.test.mjs` (T14–T18), `tests/session.revocation.test.mjs`,
`tests/harness/worker.mjs` (test-only `/counter-payment` and `/staff-order-update` routes, neither
reachable from `worker/index.js`), `SECURITY_STATUS.md`. No migration, no new dependency, no deployment,
no Git operation.

### 10.2 Owner sessions are server-side (closed 2026-11-15)

**The model is now an allowlist.** `owner_sessions(session_id PRIMARY KEY, cafe_id, created, expires)`
holds one row per signed-in device. A token is a session only if a matching, unexpired row exists, so the
three cases — signed out here, expired, or minted before this table existed — are all simply "not signed
in" (401). Nothing fails open: there is no "no row means trust the signature" path.

**Token format.** The subject is `cafe:<cafeId>:<authVersion>:<sessionId>`, signed exactly as before
(HMAC, `HttpOnly; Path=/; SameSite=Strict`, `Secure` over https, `Max-Age=43200`, same cookie name).
`sessionId` is 128 random bits, hex — written to the cookie and stored in the row. Parsing requires all
four parts and a well-formed id; legacy two- and three-part subjects are refused everywhere (decision A),
so every owner signs in once after this deploys.

**Every authenticated owner request** runs the same check (`ownerSession()` in `worker/api.js`): signature
and subject shape, the subject names this café, the café's stored `auth_version` is a valid integer equal
to the token's, then `SELECT expires FROM owner_sessions WHERE session_id = ? AND cafe_id = ? AND expires > ?`.
Both columns are in the `WHERE`, so a session id from another café resolves to no row (decision 6).

**Fail closed, and say which failure it is.** A D1 error during the row lookup returns **503**
(`SESSION_STORE_DOWN`), never 401 — an outage must not read as "signed out" and quietly end a shift. A
valid parsed token with no usable row is 401 (`SESSION_NONE`).

**Writes are ordered so a cookie never outlives its row.** Sign-in mints the id, prunes, inserts the row,
and only then signs the cookie; an insert failure is 503 with **no `Set-Cookie`** (requirement 4).
Sign-out-everywhere and password change create their replacement row *before* the version compare-and-swap,
and remove it on every failure path — CAS lost (409), DB error (500/503), and invalid stored version — so no
orphaned replacement session survives (requirement 5). Once the bump has landed they delete the café's
otherable rows (`WHERE cafe_id = ? AND session_id != ?`), keeping the table bounded.

**Ordinary sign-out is real revocation (decision C).** `POST /admin/logout` deletes that session's row and
then the CSRF rows bound to the cookie (`DELETE FROM csrf_tokens WHERE operator_key_hash = sha256(cookie)`),
and clears the cookie. If the delete fails it returns **500** with the cookie still cleared — the browser's
copy is gone but the server still accepts it, and the response never claims otherwise. A legacy, forged or
already-cleared cookie has nothing to revoke and is a 200 that just clears.

**Bounded cleanup.** `pruneOwnerSessions()` deletes at most 100 expired rows per sign-in
(`DELETE … WHERE session_id IN (SELECT … WHERE expires <= ? ORDER BY expires LIMIT 100)`), and a pruning
failure is logged and swallowed — it must never block a sign-in. No cron is configured (Workers Free), so a
café that never signs in again keeps its dead rows; every one of them is still refused by `expires > now`.

**Tenant and operator boundaries unchanged.** Guest ordering, operator login/sessions
(`operator_sessions`) and the operator `auth_version` path were not touched. `logged out everywhere` still
uses the same CAS, so a lost race is 409 and nothing moves.

**Reconciliation of decision B (2026-11-15).** Decision B was approved as "preserve the existing 12-hour
sliding session expiry". The committed pre-change implementation did not slide: `sessionStatus` returned the
constant `expiresIn: 43200` without reading the token at all, and `issueToken` stamped
`Date.now() + 12h` once at sign-in with no path that ever refreshed it. Two beliefs in the approved text
were therefore inaccurate — there was no sliding to preserve, and `/admin/session` did not reissue the
cookie. The working tree's countdown-and-CSRF version (added earlier in this review) still did not renew,
and an untracked test titled "session status reports the time actually left" pinned that. Read literally,
Decision B was describing behaviour that had never existed, so implementing it was a new requirement, not
preservation. The decision taken: implement the approved intent (sliding idle expiry) and record the
correction here rather than either quietly keeping absolute expiry or quietly claiming it had always slid.
The pre-renewal countdown test was rewritten to the sliding expectation it now belongs to.

**Two limits: a 12-hour idle window inside a 24-hour absolute lifetime.** `/admin/session` is the heartbeat.
It renews the *same* session id with one conditional `UPDATE owner_sessions SET expires = ? WHERE
session_id = ? AND cafe_id = ? AND expires > ? AND created > ?`, where the new expiry is
`min(now + 12h, created + 24h)`. Both limits are in the statement, not only in application code, and
`created` never changes — so concurrent renewals all compute the same capped value and none can push past
the cap. The cookie is reissued for the expiry that write returned with
`Max-Age = min(12h, remaining absolute lifetime)`: a renewed cookie can never outlive the row it names.

**Nothing may extend a session past the cap, and reaching it ends the session.** The same two predicates
gate every owner authentication (`ownerSession`), so a session exactly at the cap — `created == now − 24h` —
no longer matches, even though its idle `expires` may still be in the future. `/admin/session` answers that
with 401 and a `Max-Age=0` cookie, and every other owner route answers 401. `pruneOwnerSessions` collects
capped rows too (`expires <= now OR created <= now − 24h`), so the table cannot accumulate credentials that
can never authenticate.

The order is what makes a failed renewal safe: a failed or refused renewal never produces a `Set-Cookie`, so
the browser keeps exactly the cookie it had, which still matches the unextended row. A write that changes
zero rows means the session was signed out, expired or reached its cap in between: that is a 401 with the
cookie cleared, never a renewal. The board runs this heartbeat every ten minutes while it is open
(`src/pages/Admin.jsx`), so an active shift no longer ends mid-service — and, with the cap, it cannot run
past a day.

**CSRF is bound to the session id, not the cookie value.** Renewal reissues the cookie every heartbeat, so a
token keyed to the cookie value would break on every renewal. Owner tokens are now bound to the stable
session id (`ownerSessionIdOf`), which `verifyCsrf` derives through its optional fourth argument; the
operator console keeps its cookie-value binding untouched. Ordinary sign-out deletes the rows for both
bindings, so rows issued before the upgrade are cleared too.

**Tests** (`tests/session.revocation.test.mjs`, 33): ordinary sign-out revokes only its own session (the old
"copied cookie outlives sign-out" expectation is now inverted), second sign-out is harmless, concurrent
sign-outs of one session, expired row refused while the token is unexpired, correctly-signed legacy token
refused, a session value from café A refused at café B, insert failure at sign-in → 503 with no cookie,
read failure → 503 not 401, delete failure at sign-out → 500 with the cookie cleared and the session still
accepted, logout-all insert failure → 500 with the version unmoved and no orphan, and two deterministic CAS
races (`/owner/race` holds the café read, bumps `auth_version`, then lets the stale swap run) for logout-all
and password change — both 409 with exactly the original row left, and the password provably unchanged.
Pruning, and concurrent logout-all ending with exactly one live session, close that set.

Renewal has its own five: a wound-down session comes back to a full window on the same id with its row
moved forward; an injected renewal-write failure answers 200 with **no** `Set-Cookie`, an unchanged row and
the unextended time; two seconds left renews while exactly zero is refused with a cleared cookie and an
untouched row; three concurrent renewals all answer 200 and leave exactly one row with one session id; and
the CSRF token handed out with a renewed cookie still authorises sign-out-everywhere.

Five more cover the cap: a minute before it, the renewal lands exactly on `created + 24h` with a cookie
`Max-Age` of about 60 rather than 43200; exactly at it the session is refused with a cleared cookie and an
untouched row; past it the session is refused while its idle expiry is still in the future — on the status
endpoint *and* on the settings and order routes; three concurrent renewals with four seconds of cap left all
stop at the cap and the next call after it is 401; and a fresh renewal's `Max-Age` agrees with the reported
`expiresIn` within clock skew. The failure paths are reached through test-only headers
(`x-harness-fail-owner-session-{read,insert,delete,update}`) on the harness Worker, and
`/owner-sessions/expire` moves a row to a chosen idle expiry and can backdate `created`; the API itself has no
test hook.

**Cleanup wording, kept distinct.** Two different objects are cleaned up here and they should not be
conflated: (1) **replacement sessions** — the row created before the logout-all/password-change
compare-and-swap; it is deleted on every failure path (CAS lost, DB error, invalid stored version), which is
what "no orphaned replacement session" means and what the two `/owner/race` tests prove; (2) **inert
login-race rows** — a sign-in that lost the version race leaves its own row behind. Nothing removes it
early, by design: it is the row of a session that was never used and is already refused by the version
check, it is indistinguishable at write time from a legitimate sign-in that will be used a moment later, and
it expires within twelve hours. `pruneOwnerSessions` collects it then, 100 rows per subsequent sign-in.

**Migration.** `owner_sessions` is created by `MIGRATIONS` with `IF NOT EXISTS`, plus
`idx_owner_sessions_expires` and `idx_owner_sessions_cafe` in `POST_MIGRATIONS`. `migrations.test.mjs`
proves a fresh database and a legacy one both end up with the table and both indexes, existing rows survive,
and a second boot re-runs every statement as a no-op (only ADD COLUMN duplicates are forgiven).

**Disclosures and remaining limitations:**
- **The cap is measured from sign-in, not from activity.** A session dies 24 hours after it was created no
  matter how busy the board is, so a shift that runs longer than a day (or a device left signed in across
  two mornings) asks for a password again. That is the intended trade: it bounds a forgotten or shared
  device to one day. If a longer window is wanted, only `SESSION_ABSOLUTE_MAX_AGE` changes, and the cookie
  `Max-Age` follows automatically.
- **Clock skew at the boundary.** Both limits are evaluated against the worker's clock, and the cookie's
  `Max-Age` is rounded down from the remaining milliseconds, so a browser may drop the cookie up to a second
  before the server would refuse the token. The direction is safe (the cookie never outlives the row).
- **Renewal cost.** One `UPDATE` plus one CSRF insert per heartbeat — ten minutes while a board is open, not
  per request. Renewal happens on `/admin/session` only, so a client that never calls it gets the plain
  twelve hours from sign-in.
- **One forced re-login at deploy.** Every owner cookie minted before this change is a three-part subject
  and is now refused (decision A). That is the intended cost of removing an unverifiable token shape. Owner
  CSRF rows issued under the old cookie-value binding also stop verifying; the board fetches a fresh token
  from `/admin/session` on mount and after every action, so this costs one reload at most.
- **Dead rows.** Cleanup only runs at sign-in and only 100 at a time, collecting both kinds — past the
  idle window (`expires <= now`) and past the cap (`created <= now − 24h`). A login that lost the version
  race leaves a row that is already refused and is collected at one of those boundaries.
- **Café deletion** should delete that café's session rows. The harness `/clean` route now does; there is no
  production café-deletion path to fix, but any future one must.
- **Attribution** of payment/status writes is still unlogged (P2 item 1's open half).

**Files changed:** `worker/db.js` (table + indexes), `worker/api.js` (subject v2, `ownerSession` tri-state,
`create/delete/removeQuietly/pruneOwnerSessions/renewOwnerSession`, the 24-hour cap in `ownerSession` and
`renewOwnerSession`, the capped `Max-Age` in `sessionStatus`, `issueToken` expiry argument, `login`,
`sessionStatus` renewal, `logout`, `logoutEverywhere`, `verifyCsrf` binding argument, password-change path in
`adminSaveSettings`), `src/pages/Admin.jsx` (ten-minute session heartbeat, corrected sign-out comment),
`tests/harness/worker.mjs` (fault wrapper, `/owner-sessions`, `/owner-sessions/expire` with an idle offset
and a `created` backdate,
`/owner/legacy-token`, `/owner/race`, `/clean` row hygiene), and the tests
`tests/session.revocation.test.mjs`, `tests/migrations.test.mjs`, `tests/password.reset.test.mjs`,
`tests/auth.race.test.mjs` (both updated from legacy-token fixtures to real sessions and four-part
subjects).

**Verification:** full suite 328/328 on both harnesses, production build 275.51 kB JS / 89.28 kB gzip (28.81 kB CSS / 6.39 kB gzip),
`npm audit` 0, `worker/tracking.js`, `worker/passwords.js` and `worker/orderids.js` byte-identical,
`F07_VALIDATION_REPORT.md` and `corner-cup-transfer/` untouched. No deployment, no production migration, no
secret change, no Razorpay change, no Git operation.
