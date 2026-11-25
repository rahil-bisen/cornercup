# Corner Cup — Complete Security Audit (F-01 … F-20)

Audit date: 2026-11-16. Repository root: the worktree containing `worker/`, `src/`, `tests/` and
`wrangler.jsonc`. `audit-package/` is a stale export and was **not** used as a source.

## 1. Executive summary

All twenty tracked findings were re-examined against the code, not against documentation. Seventeen are
verified fixed with tests that fail if the control is removed. Two remain **partially verified** for a
reason that is not a code defect: F-07 depends on a real WorkOS sandbox, and F-09 is intentionally
disabled and cannot be assessed end to end without live gateway credentials or production payments.

One genuine defect was found and fixed during this audit: owner sign-out cleaned CSRF rows using the
cookie digest while owner rows are keyed by the session id, so every owner sign-out left a stale row
behind. The fix deletes both keys, and a test pins it.

Five additional observations are recorded (§6). None is critical or high; one (`N-06`, a misleading
success message on a raced counter-payment write) was left open deliberately because changing it would
alter guest-visible behaviour for a non-exploitable race.

Security documentation was written to the repository root. No protected artifact was modified, no
deployment or production action was taken, and no dependency was added or upgraded.

## 2. Scope and method

| Layer | What was done |
|---|---|
| Static | Every route in `worker/api.js` read; every `readJson`/`readText` call checked against `BODY_LIMITS`; greps for `phonepe`, `googleapis`, `dangerouslySetInnerHTML`, `innerHTML`, `eval`, `request.json()`, `access-control-allow`, fallback-password patterns and secret-bearing log lines |
| Unit | Token, cookie, CSRF, tracking, order-id, JWT, PKCE-state and password paths exercised directly |
| Integration | The production Worker and D1 harness (8789) and the auth harness (8790), plus real SQLite through a D1-shaped shim |
| Adversarial | Replayed state, replayed CSRF, cross-tenant ids, forged payment status, oversized and chunked bodies, spoofed client addresses, concurrent revocation |
| Build | `npm test`, `npm run build`, `npm audit` |
| Browser | **Not performed.** No page was opened, clicked or screenshotted in this audit |

## 3. Architecture as found

- **Worker**: single `fetch` entry; `/api/*` goes through `handleApi`, everything else is a static asset.
  Security headers wrap both paths.
- **Tenancy**: the slug resolves the café before any handler runs; an unknown slug is a 404, never a
  fallback to the primary café.
- **Owner session**: signed cookie + live `owner_sessions` row + café `auth_version` + idle window +
  absolute cap. CSRF for credential actions is a hashed token bound to the session id.
- **Operator**: separate cookie and session table, break-glass password from `OPERATOR_PASSWORD`.
- **Payments**: Razorpay code paths exist and are inert without keys; the UI falls back to counter.
- **F-07**: managed identity runs alongside the password flow; D1 remains the authority for membership.

## 4. F-01 … F-20 results

### F-01 — Deployment-wide fallback password — **Verified fixed**
`login()` reads only `cafe.pass_hash`; there is no deployment-wide secret in the owner path. The legacy
`OWNER_PASSWORD` can do exactly one thing: seed the *primary* café's hash through
`primaryPasswordBootstrapStatement`, guarded by `pass_hash IS NULL`, validated against the same 12–100
character policy, and only while the hash is absent. A restart cannot overwrite a set password, and no
other café can be seeded. Missing hash ⇒ 503 with an explanation, never a default credential.
Evidence: `tests/auth.fallback.test.mjs`, `tests/auth.empty-login.test.mjs`, `tests/migrations.test.mjs`.

### F-02 — Guest tracking credentials — **Verified fixed**
`token = base64url(HMAC-SHA256(key, "v1:<cafe>:<order>:<nonce>"))` (256-bit), 192-bit nonce, only
`sha256(token)` stored. The token travels in the `x-order-token` header, never a query string. The café
and order id are inside the MAC, so a token cannot be replayed against another tenant or order;
comparison is constant-time. A database dump contains nothing replayable.
Evidence: `tests/order.tracking.test.mjs`, `tests/orders.integration.test.mjs`, `tests/orderids.test.mjs`.

### F-03 — Unauthenticated payment/status mutation — **Verified fixed**
A guest may send exactly one payment value, `status: "counter"`, and only for an order it can already
track. That write is a single conditional UPDATE (`counterPaymentStatement`) whose guard is evaluated in
SQL, so a confirmed payment can never be replaced by a guest choice — a race returns "already paid"
rather than downgrading. Staff transitions use `canTransitionStatus` plus a `guardPaid` clause, and
`confirmed → unpaid` is refused atomically. The Razorpay webhook re-checks currency and amount against
the stored total before settling.
Evidence: `tests/status.transitions.test.mjs`, `tests/razorpay.payment.test.mjs`, `tests/orders.deep.test.mjs`.

### F-04 — Security headers — **Verified fixed**
`json()` and `withSecurityHeaders()` both emit CSP, HSTS, `x-content-type-options`, `x-frame-options`,
`referrer-policy` (`strict-origin-when-cross-origin`), `permissions-policy` and `cache-control: no-store`.
CSP is `'self'` with Razorpay as the only exception; no `unsafe-inline` or `unsafe-eval`. Error paths go
through the same `json()` helper, and static assets are wrapped in `worker/index.js`.
Evidence: `tests/security.headers.test.mjs`.

### F-05 — Operator create-café CSRF — **Verified fixed**
`operatorCreateCafe` calls `verifyCsrf` before reading the body. The token row is bound to
`sha256(operator cookie)`, the Origin must equal the deployment origin, and a missing binding is a
refusal. Rejections happen before any insert.
Evidence: `tests/password.reset.test.mjs`, `tests/operator.revocation.test.mjs`.

### F-06 — D1-backed rate limiting — **Verified fixed**
One atomic upsert per check with `RETURNING count`; the count is capped so a blocked key cannot grow
unbounded and an expired window resets in the same statement. Login, re-authentication, claim start,
tracking and payment creation have separate keys scoped by café/order/address, and the sensitive paths
fail closed on a store error. Cleanup is sampled at 1% and bounded to 100 rows.
Evidence: `tests/rate.limit.test.mjs`, `tests/rate.limits.migration.test.mjs`.

### F-07 — Password hashing and managed identity — **Partially verified**
Locally complete for phase 2B and mock-tested; the provider contract is unverified without a sandbox.
Details in `SECURITY_FINDINGS_MATRIX.md` and §6 of this report.

### F-08 — Unbounded request bodies — **Verified fixed**
`readText` counts bytes while streaming, refuses one byte past the limit, and cancels the reader; a
declared `Content-Length` is only an early hint. Every handler was checked: sixteen call sites, each
passing a `BODY_LIMITS` value (largest 64 KiB for gateway envelopes). There is no `request.json()` or
`request.text()` anywhere in `worker/`.
Evidence: `tests/body.limit.test.mjs` (declared, understated, absent, chunked, absurd lengths).

### F-09 — Razorpay validation / production readiness — **Partially verified (disabled)**
Server-created orders only, amount taken from the stored row, currency and amount compared again against
the gateway, signature verified with a constant-time compare over `order|payment`, and `payment_ref`
bound to the order so a payment cannot be replayed onto another ticket. Duplicate verification returns
the existing state. **Not production-ready:** no live-gateway test, no refund path, no reconciliation
job, no webhook replay window in front of the handler (it is idempotent instead). Razorpay remains
disabled and was not enabled.

### F-10 — Owner/operator session revocation — **Verified fixed (defect repaired)**
Every owner request resolves a live D1 row, compares the token's version with `auth_version`, and
enforces both the idle window and the 24-hour cap in SQL. Logout deletes the row; logout-all bumps the
version and reissues a replacement session atomically. Copied cookies stop working the moment the row is
gone. **Defect found and fixed:** owner CSRF rows are keyed `sha256(sessionId)`, but logout deleted
`sha256(cookie)`, leaving a stale row per sign-out; the delete now targets both keys.
Evidence: `tests/session.revocation.test.mjs`, `tests/operator.revocation.test.mjs`,
`tests/owner.revocation.test.mjs`.

### F-11 — Cookie-name collision — **Verified fixed**
`cookieName` uses the complete slug (application slugs are capped at 40 characters, so the name is
≤ 54), with no truncation or normalisation that could make two cafés share a name.
Evidence: `tests/cookie.name.test.mjs`.

### F-12 — Malformed cookie parsing — **Verified fixed**
`readCookie` skips entries with a bad percent-escape instead of throwing, tolerates missing `=`, and
returns the first exact name match deterministically. No parse failure can authenticate anything.
Evidence: `tests/cookie.malformed.test.mjs`.

### F-13 — PhonePe removal — **Verified fixed**
No `phonepe` reference exists in `worker/`, `src/` or `tests/`. No route, no credential, no fallback
path. Protected transfer copies were not touched.
Evidence: repository-wide grep (zero matches).

### F-14 — Order-ID collision retry — **Verified fixed**
Uniform 32-character alphabet, 6 then 8 characters, bounded attempts (6 + 3), pre-check plus primary-key
failure recovery, and a deliberately narrow `isOrderIdCollision` so no other constraint error is
retried. A retry mints a fresh id, nonce and tracking token; exhaustion is a 503 with the idempotency
claim released.
Evidence: `tests/orderid.concurrency.test.mjs`, `tests/orderids.test.mjs`.

### F-15 — Health endpoint disclosure — **Verified fixed**
`/api/health` returns `{status, database, time}` only, with 503 on a database failure. No provider state,
no environment values, no stack traces.
Evidence: `tests/health.test.mjs`.

### F-16 — Dependency vulnerabilities — **Verified fixed**
`npm audit` reports 0 vulnerabilities at every severity. No dependency was added or upgraded in this
audit; the lockfile was not regenerated.

### F-17 — Google Fonts privacy — **Verified fixed**
No `googleapis`/`gstatic` reference in `src/`, `index.html` or `worker/`. Fonts are self-hosted under
`public/fonts/` (`fraunces-latin.woff2`, `inter-latin.woff2`, `OFL.txt`) and CSP allows `'self'` and
`data:` only.

### F-18 — Public menu and table exposure — **Verified fixed**
`publicCafe` and `cafeSettings` are allow-lists; the menu route returns name, description, price, emoji
and availability; the table route returns number, label and seats. No owner, operator, payment or
identity field appears in a public payload. `/api/config` gained the `ownerAuth` mode label in phase 2B
and nothing else.
Evidence: `tests/public.exposure.test.mjs`.

### F-19 — Owner password change without re-authentication — **Verified fixed**
A password change requires the current password, is rate-limited (5 per 10 minutes), runs before any
hashing or write, and moves `auth_version` through a CAS so a concurrent change leaves nothing written.
The acting browser receives a replacement session; other sessions die. Legacy hashes are upgraded only
after a successful verify; an unsupported work factor is a controlled operator reset (409), never a
weaker check. In managed mode the write is refused with 409 and nothing is hashed.
Evidence: `tests/settings.reauth.test.mjs`, `tests/auth.fallback.test.mjs`, `tests/auth.race.test.mjs`.

### F-20 — Browser-observable security — **Verified fixed (static)**
No credential is written to `localStorage` or `sessionStorage`; the legacy `admin_token` is removed and
never read; the session is an HttpOnly, `SameSite=Strict`, `Path=/` cookie with `Secure` over https; the
guest token is read from the URL fragment only; there is no `dangerouslySetInnerHTML`, `innerHTML`,
`eval` or `new Function` in `src/` or `worker/`.
Evidence: `tests/browser.credentials.test.mjs`. **No browser walkthrough was performed.**

## 5. Severity distribution

| Severity | Count | Status |
|---|---|---|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 1 | F-07 provider contract unverified (blocked on sandbox, not code) |
| Low | 3 | F-09 production controls, N-01, N-06 |
| Informational | 4 | N-02 … N-05 |

## 6. Additional findings (outside F-01 … F-20)

**N-01 (Low) — Owner sign-out authenticates by Origin + SameSite, not a CSRF token.**
A cross-site POST cannot carry a matching Origin in a browser, and the cookie is `SameSite=Strict`, so
the practical exposure is nil. A token would be stricter, but it would also break the existing
`signOut` flow and require a client change for no reachable attack. Documented, not changed.

**N-02 (Low) — Provider revocation is at-least-once, best effort.**
Jobs are drained opportunistically; without scheduled traffic a job may be pruned at 24 hours without a
confirmed revoke. The UI and this report never claim otherwise. A scheduled drain is the fix if
guaranteed delivery is required.

**N-03 (Informational) — `/api/config` exposes `ownerAuth`.**
A mode label (`local`/`workos`) only; no identity, token or secret. Deliberate, so the board can choose
its sign-in entry point.

**N-04 (Informational) — `OWNER_PASSWORD` bootstrap logs one line.**
`console.log` records the café id only, never the value. Confirmed the sole `console.log` in `worker/`.

**N-05 (Informational) — No CORS headers are emitted.**
Requests are same-origin only; the absence of `Access-Control-Allow-*` is the intended posture.

**N-06 (Low, open) — A raced counter-payment write can report "confirmed".**
`submitPayment` treats a zero-row guarded UPDATE as "already paid" and answers
`{ok: true, paymentStatus: "confirmed"}`. If the order was cancelled in that same instant the message is
inaccurate, though nothing is written and no money is implied. Left open: changing it alters
guest-visible behaviour for a non-exploitable race and is not a security fix.

**N-07 (Informational) — Managed sign-out performs the provider revoke server-side.**
The browser is redirected locally rather than to a provider logout URL, so a provider session id never
appears in a URL, a history entry or a `Referer`.

## 7. Remaining risk

The only material residual risk in the identity domain is that no real WorkOS token has been verified:
issuer, audience, `sid` presence and revocation semantics are asserted against fixtures. Every one of
those is listed as an outstanding sandbox check. Payment risk is contained by the feature being
disabled. No critical or high-severity issue was found open.

## 8. Assessment

Locally remediated and locally verified for F-01 … F-06 and F-08 … F-20. F-07 is locally complete and
mock-tested but not provider-verified; F-09 is disabled and not production-ready by design. The
application is **ready for staging security validation**, not for production.
