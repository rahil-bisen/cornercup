# STAGE10A — Owner Authentication Read-Only Audit

**Date:** 2026-11-16 · **Scope:** Corner Cup (`worker/` + `src/`) owner authentication · **Mode:** read-only
**Target audited:** source at branch `freebuff/qr-code-cafe-ordering-website` @ `023befe`, deployed staging Worker `corner-cup-staging` version `80f92ceb-b443-4824-a147-1856310e9a52`

## Method and boundaries

Everything in this report comes from reading the repository (seven auth modules, the routes they serve, the D1 schema they use, and the tests that cover them). Facts already established by earlier stages are labelled as such.

| Boundary | Status |
|---|---|
| Source-code modifications | none (this file is the only new artifact) |
| Deployments / Worker updates | none |
| D1 writes or migrations | none |
| Secret or credential inspection | none (secret *names* only, as reported in Stage 9B) |
| WorkOS account configuration or API calls | none |
| Owner password changes / session creation | none |
| Git operations | none (no add/commit/push/reset/cleanup) |
| Staging/production auth modes | unchanged |

Labels used below: **[verified]** = read directly in source/tests · **[prior stage]** = established by an earlier stage of this engagement · **[assumption]** = reasoned, not measured · **[untested provider]** = depends on WorkOS behaviour this audit did not exercise.

---

## 1. Current architecture

Two sign-in modes live side by side, chosen per café by `cafes.owner_auth` (`'local'` default, `'workos'` for managed). Sessions, cookies and CSRF are shared machinery; only the identity step differs.

### 1.1 Local (password) mode

- Per-café owner password stored as Argon2id PHC string in `cafes.pass_hash` (`m=19456, t=2, p=1`, 16-byte salt, 32-byte tag) — `worker/passwords.js`.
- `POST /api/cafes/:slug/admin/login` → `login()` (`worker/api.js:1804`): IP+café lockout window, `verifyPassword`, opportunistic PBKDF2→Argon2id rehash, then a DB-backed session.
- A managed café answers `410 auth_mode_managed` here *before* the hash is consulted, so an operator reset on a managed café leaves the hash inert rather than usable — **[verified]** (`worker/api.js:1806-1812`, tested in `tests/operator.owner-routes.test.mjs:180`).

### 1.2 Managed (WorkOS) mode

```
GET  /api/cafes/:slug/owner/start          worker/owner.js:118  → 302 to WorkOS authorize (PKCE S256, state)
POST /api/cafes/:slug/owner/claim/start    worker/owner.js:167  → 200 { authorizeUrl } for invite holders
GET  /api/cafes/:slug/owner/callback       worker/owner.js:253  → burn state, exchange code, verify JWT,
                                                                  check email_verified, check claim email,
                                                                  check membership, create session
POST /api/cafes/:slug/owner/logout         worker/owner.js:451  → local delete + queue provider revocation
```

The design rule stated and enforced in `worker/owner.js`: *D1 decides who may open a café*. Membership (`cafe_owners`) is re-checked inside the `INSERT ... SELECT ... WHERE EXISTS (...)` statements themselves, so no JavaScript branch can mint a session without a membership row — **[verified]** (`owner.js:392-404`).

### 1.3 Session, cookie and CSRF primitives (`worker/session.js`)

| Property | Value |
|---|---|
| Owner cookie | `staff_session_<slug>`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` only over https |
| Operator cookie | `staff_operator` |
| Token | `expires.subject.HMAC-SHA256(ADMIN_SECRET, "expires.subject")` |
| Owner subject | `cafe:<cafeId>:<authVersion>:<sessionId>` (32 hex session id) |
| Operator subject | `operator:<32 hex session id>` |
| Idle window | 12 h, renewed by `/admin/session` (sliding) |
| Absolute cap | 24 h from row `created`, capped again on every renewal |
| Revocation | row deletion (`owner_sessions`) + `auth_version` epoch bump for "sign out everywhere" |
| CSRF | 32-byte token, only its SHA-256 stored, bound to `sha256(sessionId)` (owners) or `sha256(cookie)` (operator), plus strict `Origin` equality |

### 1.4 D1 tables involved

`cafes` (`pass_hash`, `owner_auth`, `auth_version`, `auth_mode_generation`, `auth_mode_cas_token`, `auth_version_cas_token`), `owner_sessions`, `owner_identities`, `cafe_owners`, `owner_claims`, `owner_login_states`, `provider_revocations`, `auth_mode_transitions`, `operator_audit`, `operator_sessions`, `csrf_tokens`, `rate_limits`, `tx_guard` — **[verified]** in `worker/db.js` SCHEMA/MIGRATIONS/POST_MIGRATIONS.

### 1.5 Mode switching (`worker/authmode.js`)

Nine statements in one `env.DB.batch`, with atomicity carried by SQL rather than by result inspection: a compare-and-swap on `(owner_auth, auth_mode_generation)` writes a fresh random `auth_mode_cas_token`, and a `tx_guard` CHECK-guarded insert aborts the batch unless that exact token landed. The batch also records `auth_mode_transitions`, an `operator_audit` row, deletes every owner session, and deletes pending login states for that café. A `BEFORE UPDATE` trigger forces the generation to step by exactly one — **[verified]** (`authmode.js`, `db.js:180-190`).

`local → workos` refuses to commit unless the café already has at least one `cafe_owners` row (S2), so enabling managed sign-in cannot lock everyone out — **[verified]**.

---

## 2. Verified implementation details

### 2.1 Local authentication and Argon2id runtime

- **[verified]** Argon2id is the only hash newly written; parameters are pinned and *also* checked on every parse (`parseArgon2` rejects any hash whose `m/t/p` differ from the constants before allocating memory).
- **[verified]** Hashes are single-concurrency per isolate with a bounded queue (`MAX_QUEUE = 3`) and a controlled `429` when full (`PasswordQueueFullError`).
- **[verified]** Legacy PBKDF2 above 100 000 iterations is treated as *needs reset* (`409`), never verified at a lower cost. PBKDF2 verification is a fail-closed path for hashes ≤ 100 000.
- **[verified]** Login lockout: failed attempts counted per `cafeId + sha256(client IP)` in `rate_limits`; an empty body is refused *before* hashing so the counter is still updated (`api.js:1863-1873`). Stage 8B measured 8 failures → `429` with the body never read.
- **[verified]** Session version is captured **before** password verification (`api.js:1846-1851`), so a concurrent password change makes the just-minted token stale rather than accidentally current.
- **[verified]** Passwords are hashed and verified without ever being logged; `hashPassword`/`verifyPassword` emit no values.

### 2.2 WorkOS login, callback, JWT verification, logout

- **[verified]** Authorize URL: `GET {base}/user_management/authorize?response_type=code&client_id&redirect_uri&state&code_challenge=…&code_challenge_method=S256&scope=openid profile email` (`workos.js:96-110`).
- **[verified]** Code exchange: single attempt, no retry, 5 s timeout, JSON body `{client_id, client_secret, grant_type:"authorization_code", code, code_verifier}`, response read through a 64 KiB bound, fields validated (`workos.js:114-160`).
- **[verified]** JWT verification (`jwt.js`): `alg` pinned to the literal `RS256` before any key import; `kid` required and must match exactly one RSA key (`kty`, `n`, `e` only); JWKS refetched once on unknown `kid`; `iss` compared as one exact string; `aud` must be present and contain the configured value; `exp`, `iat`, `nbf` enforced with 60 s skew; `sub` must match `^user_[A-Za-z0-9_-]{1,128}$` and equal the identity the exchange returned.
- **[verified]** `sid` is optional: missing or malformed ⇒ `sessionId: null`, never fabricated. Stored as `owner_sessions.workos_session_id` (NULL for local sessions).
- **[verified]** Callback failure paths are uniform (403 generic for no membership / unverified email / claim email mismatch; 400/401/502 for state, token and exchange failures) and perform at most one write — burning the state (`burnState`, `burnAnyState`).
- **[verified]** Logout: `POST /owner/logout` requires same-origin, deletes the session row and CSRF rows, queues the provider revocation in the *same* batch, then drains opportunistically. A provider failure never blocks the cookie being cleared.

### 2.3 MFA and email verification

- **[verified] No MFA anywhere in this codebase.** A repository-wide search for `mfa`, `second factor`, `amr`, `acr` finds nothing in `worker/` or `src/`. The authorize request sets no `max_age`, no `prompt`, no ACR values; the verifier inspects no authentication-assurance claim.
- **[verified]** Email verification is enforced from the *exchange response* (`user.email_verified === true`, `workos.js:124` → `owner.js:302`), not from the JWT. The JWT's `email`/`email_verified` claims are not compared with the exchange body.
- **[verified]** Claims (invites) compare `owner_claims.email` with the exchange body's `user.email`, trimmed and case-folded, before consuming anything; a mismatch leaves the claim usable.

### 2.4 PKCE and encrypted login state

- **[verified]** PKCE verifier: 32 random bytes, base64url; challenge = base64url(SHA-256(verifier)); method `S256`.
- **[verified]** State: 32 random bytes, only `sha256(state)` stored (`owner_login_states.nonce_hash`), 10-minute TTL, consumed exactly once by `UPDATE … SET used_at = … WHERE nonce_hash = ? AND used_at IS NULL AND expires > ? RETURNING …`.
- **[verified]** Verifier at rest: AES-256-GCM with a fresh 12-byte IV per call, key derived from `WORKOS_STATE_ENCRYPTION_KEY` (≥ 32 chars required) via HKDF-SHA256 (`salt "corner-cup"`, `info "owner-signin-state:v1"`). No digest-only fallback: a missing/short key throws and the route answers `503`.
- **[verified]** A cancelled sign-in (`error` param, or no `code`) burns the matching state and creates nothing; provider error text is never echoed.

### 2.5 Sessions, expiry, revocation

- **[verified]** A token is only a claim; a live `owner_sessions` row is what authenticates. Verification distinguishes `none` from `store_down` so a D1 hiccup reports `503`, not "signed out" (`session.js:260-320`, `api.js:251-258`).
- **[verified]** Renewal is a conditional `UPDATE … WHERE expires > ? AND created > ?`; the new expiry is `min(now + 12 h, created + 24 h)`. The cookie is only reissued after the row actually changed.
- **[verified]** "Sign out everywhere" bumps `cafes.auth_version` with a CAS witness, replaces the acting browser's session, deletes the café's other sessions, and queues provider revocations while excluding both the acting local session and the *shared* provider session id.
- **[verified]** Password change and operator reset bump `auth_version`, so every previously minted token stops matching at once (tested in `tests/session.revocation.test.mjs`, 33 tests).

### 2.6 Multi-café identity and membership isolation

- **[verified]** `cafe_owners (cafe_id, workos_user_id)` composite primary key; one identity can own several cafés, one café can have several owners; no email-based authorization anywhere.
- **[verified]** Cookie names are per café (`staff_session_<slug>`), so two boards in one browser coexist.
- **[verified]** A token minted for café A is refused at café B: subject café id, `auth_version`, session row and cookie name all have to agree (`session.js:parseOwnerSubject`/`ownerSession`; test "a session value issued for one café cannot authenticate at another").

### 2.7 Account claiming and unauthorized membership prevention

- **[verified]** Claim codes are 24 random bytes, only `sha256("claim:" + code)` stored, TTL 5 min–7 days (default 24 h), single-use.
- **[verified]** Redemption is one batch: consume claim (conditional on `used_at IS NULL` and `expires > now`), insert membership `SELECT … FROM owner_claims WHERE claim_hash = ? AND redeem_token = ?`, audit, upsert identity, insert session `WHERE EXISTS` on membership. A failed step rolls the batch back, and the final `meta.changes === 1` check on the session insert converts any lost race into the generic 403.
- **[verified]** Grants/revocations/claims are operator-only, CSRF-protected, and audited in `operator_audit`.
- **[verified]** Claim revocation is by the 12-hex prefix shown in the console and requires exactly one row to change.

### 2.8 Operator authentication separation

- **[verified]** Separate cookie (`staff_operator`), separate table (`operator_sessions`), separate login route and lockout scope, separate CSRF binding (cookie value rather than session id).
- **[verified]** `OPERATOR_PASSWORD` is compared with `constantTimeEqual` against the trimmed env value; empty config answers `503`; no hash is stored.
- **[verified]** Operator state changes (café create, password reset, auth-mode switch, owner grant/revoke, claim create/revoke) all require `Origin` equality plus a live CSRF token bound to the operator cookie.
- **[verified]** Operator session revocation is real: `checkOperator` requires a live `operator_sessions` row; logout-all replaces sessions in one batch.
- **[verified]** Operator actions are audited: `password_resets`, `operator_audit` (`switch_auth_mode`, `grant_owner`, `revoke_owner`, `claim_redeemed`).

### 2.9 Rollback from managed to local

- **[verified]** The transition `workos → local` is the same nine statements: CAS on mode + generation, no owner precondition, transition record, audit, delete all owner sessions, delete pending login states, queue provider revocations, clear witness.
- **[verified]** It does **not** set, clear or require `pass_hash`. On a café whose hash is NULL (exactly staging's current state — **[prior stage]**: `owner_auth='local'`, `pass_hash IS NULL`), a rollback into `local` leaves password sign-in answering `503` until an operator reset.
- **[verified]** `cafe_owners` and `owner_identities` rows are left in place and become inert under local mode (membership is only consulted by the managed callback).

---

## 3. Security findings (ranked)

### HIGH

**H1 — Board sign-out on a managed café never ends the provider session.**
`src/pages/Admin.jsx:62` calls `POST /api/admin/logout` → `logout()` (`worker/api.js:2030`), which deletes the local session row and CSRF rows only. `queueProviderRevocationsStatement` is called from exactly three places: `logoutEverywhere` (`api.js:2122`), the auth-mode transition (`api.js:2907`) and `ownerLogout` (`worker/owner.js:451-487`). **No client code calls `/owner/logout`** — a repository-wide search of `src/` finds only `/api/admin/logout` and `/api/admin/logout-all`. Impact: the WorkOS session survives an owner's visible "sign out"; on a shared device the next `/owner/start` can complete without re-authentication and mint a fresh local session (membership still required). Local security is intact (the local row is gone); the IdP session and the "signed out at the provider" promise are not.
*Suggested fix (10B):* make the board's sign-out route managed-aware, or route managed cafés to `ownerLogout`; add a test asserting a `provider_revocations` row is queued by `/admin/logout` when the session carries a provider sid.

**H2 — No MFA requirement and no assurance inspection.**
Nothing in the codebase requires, requests or inspects a second factor; managed sign-in accepts whatever session the provider hands back. Whether MFA is enforced therefore depends entirely on WorkOS environment configuration that this code neither verifies nor documents per sign-in. A per-café security control that exists only in a vendor dashboard is not an auditable control in the app.
*Suggested fix:* either require an assurance claim (`amr`/`acr`, or a WorkOS policy attribute) in `validateClaims` or document explicitly that MFA is an environment-level control with a sandbox-verified setting.

### MEDIUM

**M1 — Revoking membership does not end live sessions.**
`operatorRevokeOwner` (`api.js:2983`) deletes the `cafe_owners` row and writes an audit row; it does not delete `owner_sessions` for that identity and does not bump `auth_version`. An already-signed-in owner keeps full board access until the session's idle/absolute expiry (up to 24 h) or an operator password reset. **[verified]**

**M2 — Provider revocation is best-effort with no scheduler.**
Jobs live in `provider_revocations` with 5 attempts, exponential backoff capped at 60 s, a 24 h TTL, and a lease — but they are only drained on later sign-in/sign-out/logout-all/mode-switch traffic (`revocations.js`). A job that exhausts attempts is deleted, so the provider session can simply remain until the provider expires it. **[verified]** No test exercises the retry, lease or drop paths.

**M3 — Identity attributes are taken from the exchange body, not the verified token.**
`email_verified` and `email` come from the `/authenticate` JSON (`workos.js:124`, `owner.js:302`, `owner.js:340`), while the JWT is verified separately; the two are never cross-checked. If a provider response shape changed, or a token's verified email differed from the body's, the claim-email gate and the verified-email gate would still pass on the body value. **[verified]**

**M4 — `state` is not bound to the initiating browser (login CSRF).**
`state` is single-use, hashed at rest and 10 minutes long, but no cookie ties it to the browser that started the flow. An attacker holding one of their own valid `state`+`code` pairs can get a victim's browser to complete the callback and receive a session for the *attacker's* identity. Membership checks limit the blast radius (the victim lands in the attacker's own café), and no privilege escalation into the victim's cafés is possible. **[verified]** No state cookie is set anywhere.

**M5 — Rollback to local can leave a café with no way in.**
The mode switch never touches `pass_hash`. Staging's café currently has `pass_hash IS NULL` **[prior stage]**, so `workos → local` there yields `503` on password sign-in until an operator reset. This is an availability/runbook gap for the rollback path, not a confidentiality issue. **[verified]** (code) + **[prior stage]** (staging data).

**M6 — Operator authentication is still one shared plaintext secret.**
`OPERATOR_PASSWORD` (compared in constant time) plus `ADMIN_SECRET` (session signing key, and the fallback key for guest order-tracking tokens via `tracking.js`). There is no per-operator identity, no MFA, no rotation procedure, and no separation of keys between signing, revocation and tracking. Both operator and owner cookies additionally require a live D1 session row, which blunts pure key-forgery — but the blast radius of the two secrets is deployment-wide. **[verified]**

### LOW

- **L1** Cookies are `HttpOnly` + `SameSite=Strict` but carry no `__Host-` prefix and drop `Secure` on http dev; harden for production-only.
- **L2** `/owner/callback` has no rate limiting (`allow()` guards only `start`/`claim`); 256-bit state makes guessing impractical — informational.
- **L3** `owner_claims` revocation uses a 12-hex `LIKE` prefix; the `changes === 1` check prevents mass deletion, and collision probability is negligible.
- **L4** Dead code/schema: `logoutUrl()` is exported and unused; `owner_login_states.return_to` is written as NULL in both inserts and never read. Both widen the review surface.
- **L5** `/admin/session` issues a fresh CSRF token and performs a renewal `UPDATE` on every heartbeat — one D1 write per poll per board tab (cost, not security).
- **L6** `operatorLogoutEverywhere` deletes all CSRF rows but does not return a new `csrfToken` in its response (login and reset do), so the console must re-read `/api/operator/session` before its next mutation.

### Verified strengths (worth preserving)

RS256 with `alg` pinned before import, `kid` required and unique, issuer/audience strict with no prefix matching, bounded skew; membership enforced inside SQL (`WHERE EXISTS`) rather than in JS; single-use state via conditional `UPDATE … RETURNING`; PKCE verifier encrypted (no digest fallback) with fail-closed key handling; claims hashed, email-bound, single-use and atomic with the membership grant; `auth_version` epoch plus CAS witness for "sign out everywhere" and password change; 12 h idle / 24 h absolute caps enforced in the `WHERE` clause; three-state session verification (`ok`/`none`/`store_down`); CSRF = strict `Origin` + token hash bound to the session; per-café cookie names and subjects; uniform denial messages for token/state/membership failures; secrets, codes, verifiers and provider session ids never logged.

---

## 4. Runtime limitations

1. **Argon2id cost vs. Workers CPU budget — untested on this deployment.** 19 MiB memory, `t=2`, `p=1`, precompiled wasm (workerd cannot compile wasm from bytes). The library reserves roughly 65 MB of wasm memory and 19 MiB per derivation. **[assumption]** Stage 7's expectation stands: on the Free plan's 10 ms CPU budget this will almost certainly exceed the limit and fail (`1102`), so local owner sign-in is effectively unavailable there; the paid plan's larger budget makes it plausible but unmeasured. No Argon2id derivation has ever run in the deployed staging Worker — the café has `pass_hash IS NULL`, so login returns `503` before hashing.
2. **D1 has no `BEGIN`/`COMMIT`.** Atomicity is reconstructed from `batch()` plus CHECK-guarded witnesses (`tx_guard`), primary keys and a generation trigger. Verified and tested, but it constrains every future migration of these flows.
3. **No scheduler.** The Worker has no cron trigger, so provider-revocation jobs are drained opportunistically only (see M2).
4. **Per-isolate caches.** JWKS is cached for 10 minutes per isolate (`workos.js:166`); a cold isolate pays one extra round trip, and rotation is picked up on an unknown `kid` or TTL expiry.
5. **WebCrypto limits.** PBKDF2 verification above 100 000 iterations is unsupported on this runtime, which is why such legacy hashes are reported as needing an operator reset instead of being verified cheaper.
6. **Provider I/O budget.** Every WorkOS call uses a 5 s `AbortSignal.timeout` and a 64 KiB response bound; a slow provider surfaces as `502`/`503`, never a partial session.
7. **Free-plan D1/Worker limits** apply to the session heartbeat (renewal + CSRF insert per `/admin/session` call).

---

## 5. Missing tests

Each item was confirmed absent by searching `tests/` (73 test files total; ~15 auth-focused, roughly 150 auth assertions across `workos.jwt` 15, `owner.signin` 14, `session.revocation` 33, `auth-mode.*` 23, `operator.*` 29, `owner.revocation` 5, `migrations.owner-auth` 8, `argon2.passwords` 9, `settings.reauth` 8).

1. **Managed sign-out through the board** (`/api/admin/logout` with a provider sid) — would have caught **H1**.
2. **Membership revocation ending live sessions** — would have caught **M1** (and no such behaviour exists yet).
3. **Revocation drain mechanics**: retry, backoff, lease exclusivity, the 5-attempt drop, the 24 h TTL, and 404-as-success.
4. **`pkce.js` failure modes**: tampered ciphertext, wrong key, key shorter than 32 chars, truncated IV, and the resulting `400`/`503` routes. Only the happy path is exercised (end-to-end via `owner.signin`).
5. **State TTL boundary**: an expired-but-unused state (10 min) is refused; current tests cover unknown and already-burned states only.
6. **Login CSRF / state-to-browser binding** — not implemented, therefore not tested (**M4**).
7. **JWT vs exchange-body consistency** for `email` and `email_verified` (**M3**).
8. **Concurrent redemption of one claim** by two simultaneous callbacks (the batch is transactional; concurrency is untested).
9. **End-to-end rollback `workos → local`** followed by a password sign-in, especially with a NULL hash and the operator reset that repairs it (**M5**).
10. **MFA/assurance enforcement** — nothing to test because nothing is implemented (**H2**).
11. **Argon2id CPU/memory budget under workerd** on the target plan (no performance test; staging never hashes).
12. **Provider logout redirect** (`logoutUrl`) — unused code, untested behaviour.

Well covered already: JWT claim matrix (15 tests), the full managed sign-in/callback/claim matrix (14), session expiry/renewal/caps/CSRF/race behaviour (33), mode-transition atomicity in both SQLite and workerd (23), operator route authorization/CSRF/auditing (9) and operator revocation (20), additive migration safety (8), password-hash parsing and queue behaviour (9), settings re-authentication (8).

---

## 6. WorkOS sandbox questions (all **[untested provider]**)

The fixture provider in `tests/fixtures/workos.mjs` is a deterministic local server with its own RSA keypair; it proves the app's logic, not the vendor's contract. Before any managed café goes live, these need confirming in a WorkOS sandbox:

| # | Question | Why it matters here |
|---|---|---|
| 1 | Exact `iss` value of a User Management **access token** (the code pins `WORKOS_ISSUER`; the fixture assumes `https://api.workos.com/user_management/<client_id>`) | Wrong pin ⇒ every sign-in fails `401` at `issuer` |
| 2 | Exact `aud` of that token (client id vs. project id) — `WORKOS_AUDIENCE` exists as an escape hatch | Wrong ⇒ `audience` rejection |
| 3 | Is the access token a JWT at all, and is it RS256 with a `kid`? | An opaque token cannot be verified by `jwt.js` |
| 4 | Correct JWKS endpoint for User Management tokens (`/sso/jwks/<client_id>` is what the code calls) and its rotation behaviour | Wrong path ⇒ `jwks-failed`; no rotation ⇒ outages |
| 5 | Does the access token carry `sid`, and in the `session_<id>` shape the code requires? | Absent/other shape ⇒ `workos_session_id` NULL ⇒ no provider revocation (H1, M2 unreachable) |
| 6 | Does `/user_management/authorize` accept `code_challenge`/`code_challenge_method=S256` and the `scope` argument? Is PKCE mandatory or optional? | PKCE is a load-bearing control here |
| 7 | Exact `/user_management/authenticate` request body (`client_secret` vs `api_key` field naming) and response shape (`user.email_verified`, `access_token`) | A field rename breaks every callback |
| 8 | Session revoke contract: `POST /user_management/sessions/revoke` with `{session_id}` + `Authorization: Bearer <API key>`; is 404 really "already gone"? | Revocation correctness (M2) |
| 9 | Provider logout URL (`/user_management/sessions/logout?session_id=&return_to=`) — the code builds it but never uses it | Needed if H1 is fixed by redirecting to provider logout |
| 10 | MFA policy: what settings exist, and do `amr`/`acr` (or a policy claim) appear in access tokens? | Only path to enforcing **H2** in-app |
| 11 | Where email verification actually appears (user object and/or `email_verified` claim in the JWT) and whether the JWT `email` is the verified address | Decides whether **M3** is a real risk or a non-issue |
| 12 | Provider session lifetime/idle policy and API rate limits/timeouts | Bounds the residual window in M1/M2 |

Additional environment questions for 10B: redirect URI must be registered exactly as `WORKOS_REDIRECT_URI`; `WORKOS_STATE_ENCRYPTION_KEY` (≥ 32 chars) must exist per environment **before** a café is switched to managed; `WORKOS_API_BASE` must stay unset in production.

---

## 7. Recommended next steps

**Before any managed café (`10B` sandbox verification)**
1. Answer sandbox questions 1–12 above in a real WorkOS environment, starting with issuer/audience/JWKS/`sid`, since those four decide whether the flow works at all.
2. Run one complete managed sign-in against the sandbox and record the observed token claims (values redacted) as the fixture's contract.
3. Confirm MFA policy and whether it is enforceable in-app or must be documented as environment-level.

**Fixes to schedule (`10C` and after, each with the missing test listed in §5)**
4. **H1**: make board sign-out provider-aware (or route managed cafés to `ownerLogout`), and decide whether to redirect to provider logout as well.
5. **M1**: delete affected `owner_sessions` (and optionally bump `auth_version`) when an operator revokes membership.
6. **M4**: bind `state` to an `HttpOnly` cookie set at `/owner/start`/`/owner/claim/start` and verified in the callback.
7. **M3**: validate `email`/`email_verified` from the verified JWT and require agreement with the exchange body.
8. **M2**: either add a scheduled drain (a cron trigger or an external pinger) or state the residual risk explicitly in the operator console/runbook.
9. **H2/M6**: decide whether MFA is an environment control or an app control; split the signing key from `ADMIN_SECRET` and plan operator key rotation.
10. **M5**: add "set a password" to the rollback runbook (and consider blocking `workos → local` while `pass_hash IS NULL`).
11. **L4**: remove `logoutUrl` and `return_to`, or wire them up deliberately; **L6**: return a CSRF token from operator logout-all.

**Operational notes for this engagement**
- Staging's café is `local` with `pass_hash IS NULL` **[prior stage]**, so no managed or local sign-in can currently be exercised there without an auth mutation, which remains outside the granted authorization (this is also why Stage 9B's Step 5 stayed unverified).
- No staging or production auth mode, secret, password or session was touched in this audit.

---

## Appendix — verified vs assumed

| Claim | Basis |
|---|---|
| Two modes, per-café, membership enforced in SQL | **[verified]** `worker/owner.js`, `cafes.owner_auth`, `cafe_owners` |
| 12 h idle / 24 h absolute session caps, DB-backed revocation | **[verified]** `worker/session.js` + 33 session tests |
| Argon2id pinned and enforced on parse; PBKDF2 > 100k needs reset | **[verified]** `worker/passwords.js` + `tests/argon2.passwords.test.mjs` |
| Argon2id exceeds Free-plan CPU budget | **[assumption]** (unmeasured; never executed on staging) |
| Board sign-out skips provider revocation | **[verified]** `src/pages/Admin.jsx:62`, `worker/api.js:2030`, absence of `src/`→`/owner/logout` calls |
| Membership revocation leaves sessions live | **[verified]** `operatorRevokeOwner` |
| No MFA/assurance enforcement | **[verified]** repo-wide absence of MFA/`amr`/`acr` |
| State not bound to a browser cookie | **[verified]** no state cookie is ever set |
| WorkOS token/JWKS/`sid`/PKCE contracts | **[untested provider]** — fixture-only evidence |
| Staging café is `local`, `pass_hash IS NULL` | **[prior stage]** Stage 6/9B read-only D1 checks |
