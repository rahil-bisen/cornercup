# Corner Cup — Security Findings Matrix

Status vocabulary: **Verified fixed** (code inspected + meaningful tests), **Partially verified**
(fix exists, an important condition is unverified), **Unverified** (no sufficient evidence), **Open**,
**Accepted risk** (documented, justified — never used to hide a critical).

| ID | Finding | Original severity | Current severity | Status | Evidence | Tests |
|---|---|---|---|---|---|---|
| F-01 | Deployment-wide fallback password | Critical | — | Verified fixed | `login()` reads only `cafe.pass_hash`; `OWNER_PASSWORD` seeds the primary café only, guarded by `pass_hash IS NULL` and the 12–100 policy; no shared fallback | `auth.fallback`, `auth.empty-login`, `migrations` |
| F-02 | Guest order tracking credentials | High | — | Verified fixed | HMAC-SHA256 token (256-bit) from a 192-bit nonce; only `sha256(token)` stored; header-only transport; café+order inside the MAC; constant-time compare | `order.tracking`, `orders.integration`, `orderids` |
| F-03 | Unauthenticated payment/status mutation | High | — | Verified fixed | Guest may set only `counter`, via one guarded UPDATE; staff transitions gated by `canTransitionStatus` + `guardPaid`; `confirmed` cannot be downgraded; webhook re-checks amount/currency | `status.transitions`, `razorpay.payment`, `orders.deep` |
| F-04 | Security headers | Medium | — | Verified fixed | CSP (no `unsafe-*`), HSTS, nosniff, DENY, referrer-policy, permissions-policy, `no-store` on both JSON and asset paths | `security.headers` |
| F-05 | Operator create-café CSRF | High | — | Verified fixed | `verifyCsrf` before body read; Origin equality + session-bound token hash; rejection precedes any write | `password.reset`, `operator.revocation` |
| F-06 | D1-backed rate limiting | Medium | — | Verified fixed | Atomic upsert with `RETURNING`, capped count, in-statement window reset; per-café/order/address keys; fail-closed on auth paths | `rate.limit`, `rate.limits.migration` |
| F-07 | Password hashing and managed identity | Critical | Medium | Partially verified | RS256-only JWT, strict `iss`/`aud`, JWKS cache + rotation refetch, PKCE S256, AES-256-GCM state under HKDF, single-use state, email+membership gate in SQL, claim atomicity, atomic logout-all with provider queue, 410 on managed password login. Provider contract unverified without a sandbox | `workos.jwt`, `owner.signin`, `owner.revocation`, `auth-mode.*`, `settings.reauth`, `session.revocation` |
| F-08 | Unbounded request bodies | High | — | Verified fixed | Streaming byte counter, one-byte-over refusal with reader cancel, `Content-Length` only a hint; 16 call sites all bounded; no `request.json()` in `worker/` | `body.limit` |
| F-09 | Razorpay validation / production readiness | High | Low (disabled) | Partially verified | Server-side order creation, amount from the stored row, gateway amount/currency re-check, signature over `order|payment`, `payment_ref` binding, idempotent verify. No live test, no refunds, no reconciliation | `razorpay.payment` (32) |
| F-10 | Owner/operator session revocation | High | — | Verified fixed | Live-row lookup, version match, idle window and 24h cap in SQL, fail-closed on store error; logout deletes the row; logout-all bumps version atomically. CSRF cleanup defect repaired (both keys) | `session.revocation`, `operator.revocation`, `owner.revocation` |
| F-11 | Cookie-name collision | Medium | — | Verified fixed | Full slug, no truncation; slug cap keeps the name ≤ 54 chars | `cookie.name` |
| F-12 | Malformed cookie parsing | Medium | — | Verified fixed | Bad escapes skipped, no throw, deterministic first match, fail closed | `cookie.malformed` |
| F-13 | PhonePe removal | Medium | — | Verified fixed | Zero `phonepe` references in `worker/`, `src/`, `tests/` | repository grep |
| F-14 | Order-ID collision retry | Medium | — | Verified fixed | Uniform alphabet, bounded 6+3 attempts, narrow collision matcher, fresh id/nonce/token per retry, 503 on exhaustion | `orderid.concurrency`, `orderids` |
| F-15 | Health endpoint disclosure | Low | — | Verified fixed | `{status, database, time}` only; 503 on failure; no provider/env/stack data | `health` |
| F-16 | Dependency vulnerabilities | Medium | — | Verified fixed | `npm audit` = 0 across all severities; no dependency changed | `npm audit` |
| F-17 | Google Fonts privacy | Low | — | Verified fixed | No `googleapis`/`gstatic`; self-hosted WOFF2 + OFL licence; CSP `'self'`/`data:` only | repository grep, CSP |
| F-18 | Public menu/table data exposure | Medium | — | Verified fixed | Allow-listed serializers; no identity, payment or operator fields publicly; slug scoping on every tenant query | `public.exposure` |
| F-19 | Owner password change without current password | High | — | Verified fixed | Current password required, rate-limited, checked before hashing/write; version CAS; replacement session; managed mode refuses with 409 | `settings.reauth`, `auth.fallback`, `auth.race` |
| F-20 | Browser-observable security | Medium | — | Verified fixed (static) | No credential in web storage; `admin_token` removed and never read; HttpOnly/Strict cookie; fragment-only guest token; no `dangerouslySetInnerHTML`/`innerHTML`/`eval` | `browser.credentials` |

## Additional findings

| ID | Finding | Severity | Status |
|---|---|---|---|
| N-01 | Owner sign-out relies on Origin + `SameSite=Strict`, not a CSRF token | Low | Accepted risk (no reachable attack) |
| N-02 | Provider revocation is at-least-once, best effort; jobs may expire unrevoked | Low | Accepted risk (documented) |
| N-03 | `/api/config` exposes the `ownerAuth` mode label | Informational | Accepted |
| N-04 | Bootstrap logs the primary café id (never a value) | Informational | Accepted |
| N-05 | No CORS headers (same-origin only) | Informational | Accepted |
| N-06 | A raced counter-payment write can answer "confirmed" while writing nothing | Low | Open (behaviour, not exploit) |
| N-07 | Managed sign-out redirects locally so no provider sid reaches a URL | Informational | Accepted |

## Summary

- Verified fixed: 18 of 20 findings (F-01…F-06, F-08, F-10…F-20).
- Partially verified: F-07 (sandbox required), F-09 (disabled by design).
- Critical open: 0. High open: 0. Medium open: 1 (F-07 provider contract).
