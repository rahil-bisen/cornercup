# Corner Cup — Security Test Report

Run date: 2026-11-16. Commands executed from the live repository root (not `audit-package/`).

## 1. Exact commands

```
npm test
node --import ./tests/setup/register.mjs --test --test-concurrency=1 tests/*.test.mjs
node --import ./tests/setup/register.mjs --test --test-concurrency=1 tests/workos.jwt.test.mjs
node --import ./tests/setup/register.mjs --test --test-concurrency=1 tests/owner.signin.test.mjs
node --import ./tests/setup/register.mjs --test --test-concurrency=1 tests/owner.revocation.test.mjs
npm run build
npm audit --json
```

Local Worker harnesses: `http://127.0.0.1:8789` (D1 integration, started from
`tests/harness/wrangler.jsonc`) and `http://127.0.0.1:8790` (auth harness, already running). Both
answered `/api/health` with 200 before the suite was executed.

## 2. Results

| Measure | Result |
|---|---|
| Tests | **393** |
| Passed | **393** |
| Failed | **0** |
| Skipped | **0** |
| Cancelled | 0 |
| Duration | ~65 s |
| Production build | **success** (`vite build`, 277.23 kB JS / 89.63 kB gzip) |
| `npm audit` | **0** vulnerabilities (info 0, low 0, moderate 0, high 0, critical 0) |

The 393 total is 359 pre-existing tests plus 34 added for F-07 phase 2B. No test was deleted, skipped
or weakened; two expectations were updated for an intentionally changed schema shape and a moved
function, both recorded in `SECURITY_REMEDIATION_LOG.md` §R-04.

## 3. Coverage by area

| Area | Tests |
|---|---|
| F-01 fallback password / bootstrap | `auth.fallback`, `auth.empty-login`, `auth.secrets`, `auth.version`, `migrations` |
| F-02 tracking | `order.tracking`, `orders.integration` |
| F-03 payment/status | `status.transitions`, `razorpay.payment`, `orders.deep` |
| F-04 headers | `security.headers` |
| F-05 CSRF | `password.reset`, `operator.revocation` |
| F-06 rate limits | `rate.limit`, `rate.limits.migration` |
| F-07 managed identity | `workos.jwt` (15), `owner.signin` (14), `owner.revocation` (5), `auth-mode.atomicity` (13), `auth-mode.d1` (10), `f07-regression`, `settings.reauth`, `session.revocation` |
| F-08 body limits | `body.limit` |
| F-09 Razorpay | `razorpay.payment` (32) |
| F-10 sessions | `session.revocation`, `operator.revocation`, `auth.race`, `cookie.*` |
| F-11/F-12 cookies | `cookie.name`, `cookie.malformed` |
| F-14 order ids | `orderid.concurrency`, `orderids` |
| F-15 health | `health` |
| F-18 exposure | `public.exposure` |
| F-19 re-auth | `settings.reauth` (8) |
| F-20 browser static | `browser.credentials` |

## 4. Concurrency and adversarial cases exercised

Replayed login state (second callback ⇒ 400, still one session); cancelled state burned with no
exchange; unknown state with no write; replayed claim code (404); email mismatch leaving the claim
usable; concurrent logout-all and mode-switch collisions (exactly one winner, loser leaves no job and
no replacement row); stale generation rollback (mode unchanged, zero queue rows, session intact);
provider revoke failure retaining the job; duplicate order-id collisions; forced and exhausted
idempotency keys; oversized, understated, chunked and absent `Content-Length`; malformed and duplicate
cookies; cross-tenant ids and forged payment status.

## 5. Browser verification

**Not performed.** No browser was opened, no page was clicked, no screenshot was taken. The managed
login screen, the invite field and the signed-out notice are covered by a successful production build
and by HTTP-level handler tests only. Anything visual is unverified.

## 6. Limitations

- No real WorkOS call was made; issuer, audience, `sid` presence and revocation semantics remain
  unverified against the provider (see the sandbox checklist).
- Revocation **retry/backoff/attempt-cap** paths are not individually tested; the queue's dedupe, NULL
  handling, shared-SID exclusion, drain-to-zero and rollback are.
- The operator owner-management routes (grant, revoke, list, claims) and the operator auth-mode route
  are exercised at the SQL/composition level and by manual review, not through HTTP.
- `ownerAuth` in `/api/config` and the 410 managed-login branch are not asserted through the harness.
- `logout-all`'s shared-SID exclusion is proven at the queue-statement level, not through the route.
- Razorpay was never enabled; no live-gateway test exists.
- No penetration test against a deployed environment was performed, by design.

## 7. Verdict

Locally verified. Not production-verified. Not browser-verified.
