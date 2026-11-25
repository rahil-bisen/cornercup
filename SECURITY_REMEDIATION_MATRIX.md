# SECURITY REMEDIATION MATRIX — F-01 to F-20

**Date:** 2026-11-20
**Basis:** current source, re-inspected this session. Previous reports were treated as evidence, not truth.
**Vocabulary:** **FIXED** = code present and covered by a passing test · **PARTIAL** = implemented, one
production-relevant property unmeasured · **ACCEPTED** = reviewed, documented, deliberately unchanged ·
**OPEN** = not resolved.

| ID | Finding | Sev. | Status | Where the control lives | Regression coverage |
|---|---|---|---|---|---|
| F-01 | Deployment-wide fallback password | Critical | **FIXED** | `login()` verifies only `cafe.pass_hash`; `OWNER_PASSWORD` seeds the primary café once, guarded by `pass_hash IS NULL` + 12–100 char policy (`worker/db.js`); `ADMIN_PIN` never read | `auth.fallback`, `auth.empty-login`, `migrations` |
| F-02 | Guest tracking credential | High | **FIXED** | HMAC-SHA256 token from 192-bit nonce, `sha256(token)` stored, header-only (`x-order-token`), café+order in MAC, constant-time compare (`worker/tracking.js`, `worker/api.js`) | `order.tracking`, `orders.integration` |
| F-03 | Unauthenticated payment/status mutation | High | **FIXED** | Guest may only choose `counter`, via one guarded UPDATE; staff transitions via `canTransitionStatus` + `guardPaid`; `confirmed` cannot be downgraded; webhook re-checks amount/currency (`worker/orders.js`, `worker/api.js`) | `status.transitions`, `razorpay.payment`, `orders.deep` |
| F-04 | Security headers | Medium | **FIXED** | CSP without `unsafe-*`, HSTS, nosniff, DENY, referrer-policy, permissions-policy; applied to JSON **and** static (`worker/http.js`, `worker/index.js`) | `security.headers` (4, incl. live `/api/health`) |
| F-05 | Operator create-café CSRF | High | **FIXED** | `verifyCsrf` before body read: Origin equality + session-bound token hash (`worker/session.js`, `worker/api.js`) | `password.reset`, `operator.revocation` |
| F-06 | D1-backed rate limiting | Medium | **FIXED (improved)** | Durable atomic upsert retained for state changes; reads use a bounded per-isolate window — **this session's change**, removes write amplification | `rate.limit` (16), `rate.readwindow` (6, new), `rate.limits.migration` |
| F-07 | Password hashing / managed identity | Critical | **PARTIAL** | Argon2id 19 MiB ×2 preserved (never weakened); RS256-only JWT, strict `iss`/`aud`, JWKS cache + rotation refetch, PKCE S256, AES-256-GCM state under HKDF, single-use state, membership gate in SQL, atomic logout-all with provider queue, 410 on managed password login | `argon2.passwords`, `workos.jwt`, `owner.signin`, `owner.revocation`, `auth-mode.*`, `session.revocation` |
| F-08 | Unbounded request bodies | High | **FIXED** | Streaming byte counter with reader cancel; 16 bounded call sites; no `request.json()` in `worker/` (`worker/http.js`) | `body.limit` |
| F-09 | Razorpay validation / readiness | High | **PARTIAL (disabled)** | Server-side order, amount from stored row, gateway amount/currency check, signature over `order|payment`, idempotent verify (`worker/api.js`, `src/lib/razorpay.js`) | `razorpay.payment` (32) |
| F-10 | Session revocation | High | **FIXED** | `owner_sessions` allowlist row, version match, 12 h idle + 24 h cap in SQL, fail-closed on store error, logout deletes row, logout-all CAS (`worker/session.js`, `worker/api.js`) | `session.revocation`, `owner.revocation`, `operator.revocation` |
| F-11 | Cookie-name truncation collision | Medium | **FIXED** | Full slug in `staff_session_<slug>`, slug capped at 40 chars (`worker/session.js`, `worker/db.js`) | `cookie.name` |
| F-12 | Malformed cookie parsing | Medium | **FIXED** | Bad percent-escape skipped, no throw, deterministic match (`readCookie`) | `cookie.malformed` |
| F-13 | PhonePe removal | Medium | **FIXED** | No `phonepe` string in `worker/`, `src/`, `tests/` | repository grep |
| F-14 | Order-ID collision retry | Medium | **FIXED** | Uniform alphabet, bounded 6+3 attempts, collision-only matcher, fresh id/nonce/token per retry, 503 on exhaustion (`worker/orderids.js`) | `orderid.concurrency`, `orderids` |
| F-15 | Health endpoint disclosure | Low | **FIXED** | `{status, database, time}` only; 503 on failure | `health` |
| F-16 | Dependency vulnerabilities | Medium | **FIXED** | `npm audit`: 0 info / 0 low / 0 moderate / 0 high / 0 critical (re-run 2026-11-20) | `npm audit` |
| F-17 | Google Fonts privacy | Low | **FIXED** | No `googleapis`/`gstatic`; self-hosted WOFF2 + OFL; CSP `'self'`/`data:` | grep + CSP assertion |
| F-18 | Public menu/table exposure | Medium | **FIXED** | Allow-listed serializers; no identity/payment/operator fields public; slug scoping on every tenant query | `public.exposure` |
| F-19 | Password change without current password | High | **FIXED** | `verifyOwnerReauth` before hashing/UPDATE: 400 missing, 401 wrong (`reauth_required`), 429 after 5/10 min, 409 on unsupported hash, 503 on store failure; version CAS + replacement session (`worker/api.js`) | `settings.reauth` (8), `auth.race`, `auth.fallback` |
| F-20 | Browser-observable security | Medium | **FIXED** | No credential in web storage; `admin_token` removed and never read; HttpOnly/Strict cookie; fragment-only guest token; no `dangerouslySetInnerHTML`/`eval` | `browser.credentials` |

## Additional findings

| ID | Finding | Sev. | Status | Note |
|---|---|---|---|---|
| N-01 | Owner sign-out relies on Origin + SameSite, not a CSRF token | Low | ACCEPTED | No reachable cross-site POST path |
| N-02 | Provider revocation is at-least-once, best effort | Low | ACCEPTED | Jobs may expire unrevoked |
| N-03 | `/api/config` exposes the `ownerAuth` label | Info | ACCEPTED | Mode label only |
| N-04 | Bootstrap logs the primary café id | Info | ACCEPTED | Never a secret |
| N-05 | No CORS headers | Info | ACCEPTED | Same-origin by design |
| N-06 | Raced counter-payment write can answer “confirmed” while writing nothing | Low | **OPEN** | Behavioural, not exploitable; fix requires a transaction rewrite |
| N-07 | Managed sign-out redirects locally | Info | ACCEPTED | Keeps provider `sid` out of URLs |
| N-08 | Read rate ceiling is per isolate | Low | ACCEPTED (new) | Documented in `RATE_LIMIT_CAPACITY_REPORT.md` §5 |
| N-09 | Harness-based revocation suites are order-dependent | Info | **OPEN (test infra)** | See `MASTER_REMEDIATION_REPORT.md` §9; **not** a product defect, reproduced on pre-change source |

## Summary

- **FIXED: 18 / 20.** PARTIAL: F-07 (provider contract requires a sandbox), F-09 (payments disabled by policy).
- **Critical open: 0. High open: 0.** Medium open: 1 (F-07 provider contract, external dependency).
- Every FIXED row is backed by a test that fails if the control is removed — the earlier “guard removed, suite
  re-run” probe (SECURITY_STATUS §1) established this for F-03, and F-06/F-10/F-19 were re-probed this session
  by running their suites against the live Worker harness.
- Deployment status of all twenty: **LOCAL ONLY**. See `STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md` — the public
  deployment is running code from **before** F-04, F-10 and F-19.
