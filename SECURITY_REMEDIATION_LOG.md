# Corner Cup — Security Remediation Log

This log covers the changes made in the 2026-11-16 audit. It does not re-claim work from earlier
sessions; where a control predates this audit it is recorded in `SECURITY_FINDINGS_MATRIX.md` with the
test that proves it, not here.

---

## R-01 — Owner sign-out left stale CSRF rows (F-10)

**Vulnerability.** Not an authentication bypass, but a broken cleanup invariant: every owner sign-out
left one CSRF row behind, so the table accumulated rows bound to dead sessions for up to 12 hours.

**Root cause.** `issueCsrfToken(env, session.sessionId)` stores `operator_key_hash = sha256(sessionId)`,
and `verifyCsrf` checks against `sha256(ownerSessionIdOf(cookie))` — the session id. The logout handler
deleted `sha256(cookieValue)`, a third value that never matches either. The operator path already used
both keys deliberately; the owner path had been left with the old one.

**Files changed.** `worker/session.js` was created by extraction, so the session helpers now live there;
`worker/api.js` (owner `logout`), `worker/owner.js` (`ownerLogout`).

**Fix.** The delete is now `DELETE FROM csrf_tokens WHERE operator_key_hash IN (?, ?)` bound to
`sha256Hex(sessionId)` and `sha256Hex(cookieValue)`. Both bindings are cleared; verification is
unchanged and was not weakened.

**Regression test.** `tests/owner.revocation.test.mjs` — "sign-out deletes both CSRF bindings and
leaves other sessions' rows alone": seeds a session-id row, a legacy cookie row and another session's
row, signs out, and asserts the first two are gone, the third survives, and a second sign-out is still
a success. Verified: passes.

---

## R-02 — Expired revocation jobs were never pruned (F-07 / N-02)

**Vulnerability.** Hygiene, not exploitability: `pruneProviderRevocations` existed but no caller used
it, so a job that exhausted its five attempts or outlived 24 hours stayed in the table until some other
path removed it.

**Root cause.** The prune function was written with the module and never wired into the drain.

**File changed.** `worker/revocations.js`.

**Fix.** `drainProviderRevocations` prunes first (`expires <= now OR attempts >= 5`), bounded by the
same index, before leasing a job. No claim, no retry policy and no settle semantics changed.

**Regression test.** Covered indirectly by `tests/owner.revocation.test.mjs` and
`tests/owner.signin.test.mjs` (queue drains to zero, including after a failed revoke). A dedicated
attempt-cap test remains outstanding (see the test report's limitations).

---

## R-03 — F-07 phase 2B completed (F-07)

Phase 2B was implemented in the preceding session and is recorded here for completeness. No frozen
phase-2A SQL was modified.

| Area | File | What it does |
|---|---|---|
| Session extraction | `worker/session.js` | token, cookie, session-store and CSRF layer moved verbatim; `api.js` imports it back and re-exports the public names |
| JWT | `worker/jwt.js` | RS256 only, `kid` required, strict `iss`/`aud`, 60 s skew, `sub`/`sid` validation |
| PKCE + state | `worker/pkce.js` | S256 challenge; verifier stored as AES-256-GCM under an HKDF-SHA256 key; no plaintext path |
| Provider | `worker/workos.js` | authorize/exchange/JWKS (10 min cache, one refetch on unknown `kid`)/revoke; 5 s timeouts; bounded reads; fail closed |
| Queue | `worker/revocations.js` | durable jobs, 5 attempts, 24 h expiry, lease + backoff |
| Sign-in | `worker/owner.js` | start, claim start, callback (membership-gated insert), logout (batch-queued revoke) |
| Wiring | `worker/api.js` | routes, `ownerAuth` in config, 410 on managed password login, F-19 managed guard, atomic logout-all, operator owner/mode routes |
| Schema | `worker/db.js` | three nullable columns, two tables, three indexes, `auth_version_cas_token` |
| Board | `src/pages/Admin.jsx` | managed sign-in entry, invite field, signed-out notice |

**Regression tests.** `tests/workos.jwt.test.mjs` (15), `tests/owner.signin.test.mjs` (14),
`tests/owner.revocation.test.mjs` (5), plus the unchanged phase-1/2A suites.

---

## R-04 — Test expectations updated (no assertions weakened)

**`tests/migrations.owner-auth.test.mjs`.** The exact column list for `owner_login_states` now includes
the three phase-2B columns, each additionally asserted nullable; phase-2B statements are excluded from
the "deployed today" fixture because they target tables that fixture deliberately has not created. The
phase-1 guarantees (default `local`, no foreign keys, composite membership key, hash untouched) are
unchanged and still asserted.

**`tests/browser.credentials.test.mjs`.** Reads `worker/session.js` instead of `worker/api.js`, because
that is where `sessionCookie` now lives. All four assertions (HttpOnly, `SameSite=Strict`, `Path=/`,
Secure over https) are identical.

---

## Not changed, deliberately

- `worker/authmode.js` — frozen; the mode route composes around `plan.steps` by splice.
- Argon2id parameters — untouched.
- Razorpay enablement — untouched; still disabled.
- `submitPayment`'s raced "confirmed" message (N-06) — a behaviour change for a non-exploitable race,
  out of scope for a security fix.
- No dependency was added, removed or upgraded.
