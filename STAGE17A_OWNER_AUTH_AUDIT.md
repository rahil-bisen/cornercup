# Stage 17A — Owner Authentication & MFA Audit

**Project:** Corner Cup (`corner-cup-qr-ordering`)
**Date:** 2026-11-21
**Mode:** read-only audit of the working tree (no source, test, config, dependency, secret or deployment change)
**Scope:** owner login/logout, Argon2id verification and Workers CPU fit, sessions and revocation, membership/roles, CSRF, MFA (TOTP) status, password reset/change, tests, and the Stage 10 reports
**Deliverable:** this report only

---

## 1. Current authentication architecture

### 1.1 Two owner identity modes, chosen per café

`cafes.owner_auth` (`'local'` default, `'workos'`) selects the only way into a café's board. The two modes never mix: a managed café answers `410 auth_mode_managed` to the password route before any hashing (`worker/api.js:2066`), and a mode switch is an atomic nine-statement transaction that also kills every live session and in-flight sign-in (`worker/authmode.js`).

**Local mode (the default).**

| Step | Implementation |
|---|---|
| Credential storage | `cafes.pass_hash` — one Argon2id PHC string per café, seeded at bootstrap from `OWNER_PASSWORD` or set by the owner/operator |
| Verify | `POST /api/cafes/:slug/admin/login` → `login()` (`worker/api.js:2064`) → `verifyPassword()` (`worker/passwords.js:184`) |
| Pre-checks | mode gate (410), `ADMIN_SECRET` present (503), `pass_hash` present (503), per-café+IP lockout (8 failures / 10 min, `api.js:1851`), empty-body rejection, `passwordNeedsReset()` for uncomputable legacy PBKDF2 |
| Session mint | live row in `owner_sessions` **then** signed cookie; a failed insert returns 503 rather than a cookie that authenticates nothing |
| Legacy upgrade | after a successful PBKDF2 verify, opportunistic re-hash to Argon2id with a compare-and-swap on the exact verified string (`api.js:2174`) — parameters unchanged, no version bump |

**Managed mode (WorkOS AuthKit).** `ownerStart` → PKCE S256 + AES-GCM-encrypted verifier + single-use state row (`owner_login_states`) → provider → `ownerCallback` → RS256-only JWT verification (`worker/jwt.js`: pinned `iss`, strict `aud`, `sub` shape, 60 s skew, JWKS `kid` with one forced refetch) → `email_verified` required → optional invite claim (email-bound, single-use) → membership lookup in `cafe_owners` → session insert guarded by `WHERE EXISTS (SELECT 1 FROM cafe_owners …)`, so authentication alone can never mint a session (`worker/owner.js:378`).

### 1.2 Session model

| Element | Value / behaviour |
|---|---|
| Token format | `<expires>.<subject>.<HMAC-SHA256>` over the secret `ADMIN_SECRET`; subject `cafe:<id>:<auth_version>:<32-hex session id>` (`worker/session.js`) |
| Server-side gate | a live `owner_sessions` row (`session_id`, `cafe_id`, `created`, `expires`, optional `workos_user_id`/`workos_session_id`) must match by id, café, idle window **and** absolute cap |
| Idle / absolute | 12 h sliding renewal, 24 h absolute from `created`; both enforced in the same `WHERE` clause as the lookup and re-checked in the conditional renewal `UPDATE` |
| Cookie | `staff_session_<slug>`; `HttpOnly`, `Path=/`, `SameSite=Strict`, `Secure` only when the request is https, `Max-Age` = lesser of idle window and remaining absolute lifetime; no `Domain` |
| Status heartbeat | `GET /api/admin/session` renews the row, reissues the cookie and mints a CSRF token |
| Operator session | separate cookie `staff_operator`, subject `operator:<32-hex>`, backed by `operator_sessions`, 12 h, no sliding renewal |

### 1.3 CSRF

`verifyCsrf()` (`worker/session.js:332`) requires (a) an `Origin` header equal to this deployment's origin, (b) a non-empty `x-csrf-token`, (c) a `csrf_tokens` row whose `token_hash` matches and whose `operator_key_hash` matches the hash of the session binding — the session id for owner routes, the cookie value for the operator console — with constant-time comparison and an expiry check. Raw tokens and raw bindings are never stored.

### 1.4 Membership and roles

`cafe_owners(cafe_id, workos_user_id, role DEFAULT 'owner')` is the only membership table; the composite primary key is the uniqueness rule. Membership is consulted at managed sign-in, inside session-creating SQL, and by the operator grant/revoke routes. `role` is written as `'owner'` and the API rejects any other value (`api.js:3369`).

### 1.5 Operator console

A single shared `OPERATOR_PASSWORD` environment value compared in constant time (`api.js:579`), per-IP lockout (8 / 10 min), a live `operator_sessions` row, and CSRF on every mutation. There is no per-operator identity, no password hash and no second factor.

### 1.6 Supporting controls

`ensureDb()` bootstraps/migrates on every API request; rate limiting is D1-backed (`rate_limits`, plus per-isolate window limiters for read paths); responses carry CSP, HSTS, `X-Frame-Options: DENY`, `nosniff` and a referrer policy (`worker/http.js`); provider revocation jobs are queued durably in `provider_revocations` and drained opportunistically.

---

## 2. Implemented security controls

| # | Control | Where | Evidence |
|---|---|---|---|
| 1 | Argon2id with an exact parameter allowlist checked **before** memory is allocated (`m=19456, t=2, p=1`, 16-byte salt, 32-byte tag, PHC) | `worker/passwords.js:12, 133` | `tests/argon2.passwords.test.mjs` (9) |
| 2 | Parameters can never be downgraded: a stored hash with other parameters is rejected, not recomputed | `worker/passwords.js:136` | `tests/argon2.passwords.test.mjs`, `f07-regression` |
| 3 | Hashing queue (1 running, 3 waiting) converts memory pressure into a controlled 429 | `worker/passwords.js:38`, `api.js:2159` | `argon2.passwords` queue tests |
| 4 | Legacy PBKDF2 fails closed above 100 000 iterations (no cheaper verification) | `worker/passwords.js:179` | `argon2.passwords`, `auth.fallback` |
| 5 | Empty/blank login rejected **before** the hasher and still counted by the lockout | `worker/api.js:2093` | `auth.empty-login` (4) |
| 6 | Per-café+IP lockout, 8 failures / 10 min, cleared on success; settings re-auth has its own 5 / 10 min counter | `api.js:2070, 2626` | `auth.fallback` (12), `settings.reauth` (8) |
| 7 | Session only after the row exists; token bound to café **and** auth version **and** session id | `api.js:2205`, `session.js:255` | `owner.signin` (14), `session.revocation` (33) |
| 8 | Two independent lifetime limits (12 h idle, 24 h absolute), both in SQL, both re-checked on renewal | `session.js:255, 300` | `session.revocation`, `auth.version` |
| 9 | Sign-out deletes the row (copied cookie dies next request); sign-out-everywhere bumps `auth_version` in a CAS + CHECK-witness batch and re-issues only the caller | `api.js:2341` | `owner.revocation` (5), `session.revocation` |
| 10 | Password change requires the **current** password (F-19) and a version CAS; a stale change cannot overwrite a newer credential | `api.js:2775, 2821` | `settings.reauth` |
| 11 | Operator password reset is one batch (version bump + audit row that only exists if the update landed), never returns a hash | `api.js:3193`, `passwordResetBatch` | `password.reset` (3) |
| 12 | Mode switch is atomic and invalidates sessions, in-flight states, and records an immutable transition | `worker/authmode.js` | `auth-mode.d1` (10), `auth-mode.atomicity` (13) |
| 13 | Managed flow: PKCE S256, AES-256-GCM state under HKDF, single-use state, `email_verified`, RS256-only, pinned issuer/audience, `sub` binding, JWKS rotation | `worker/owner.js`, `worker/pkce.js`, `worker/jwt.js` | `owner.routes.http` (12), `f07-regression` (11) |
| 14 | Membership decided in SQL (`WHERE EXISTS`), never in a JS branch that could be skipped | `owner.js:378-404` | `owner.routes.http`, `migrations.owner-auth` (8) |
| 15 | Invite claims: digest-only storage, email-bound, single-use inside the redemption batch | `owner.js:330-420` | `operator.owner-routes` (9) |
| 16 | Cookies `HttpOnly` + `SameSite=Strict` + `Secure` on https; no token in JS-accessible storage | `session.js:52` | `browser.credentials` (5), `cookie.*` (13) |
| 17 | CSRF: origin equality + hashed token + hashed session binding, constant-time, expiring | `session.js:332` | `owner.revocation`, `operator.revocation` (20) |
| 18 | Provider revocation queued in the same batch as the local delete, leased, bounded retries, 24 h TTL | `worker/revocations.js` | `owner.revocation`, `operator.revocation` |
| 19 | Security headers incl. CSP and `X-Frame-Options: DENY` on every response | `worker/http.js:35` | `security.headers` |
| 20 | Unknown café slug = 404, never a fallback tenant | `api.js:355` | `cafe-scope`, `public.exposure` |

---

## 3. Missing or incomplete controls

| # | Gap | Severity | Detail |
|---|---|---|---|
| **G1** | **No MFA anywhere** | **High** | `grep -ri "totp\|otpauth\|mfa\|authenticator"` over `worker/`, `src/`, `tests/` returns **zero** hits. No column, route, UI, test or dependency. Owner sign-in is single-factor (password or provider session); the operator console — which can reset any café's password and switch auth modes — is protected by one shared static string. |
| **G2** | **Operator console is a shared static password with no identity** | **High** | `OPERATOR_PASSWORD` (env) → constant-time compare → session. No per-person account, no hash, no audit subject (`'operator'`), no MFA. Carried from Stage 10A.1 as P3-05 and still open. |
| **G3** | **Membership revocation does not end live sessions** | **Medium-High** | `operatorRevokeOwner` deletes the `cafe_owners` row and writes an audit row (`api.js:3373`); `ownerSession()` never re-reads membership, so the revoked owner's board keeps working until the 24 h cap. Stage 10A.1 H-03 remains open. |
| **G4** | **CSRF is enforced on only some owner mutations** | **Medium** | `verifyCsrf` is called for owner `logout-all` and the two image routes; **not** for `PATCH /admin/settings`, menu item create/update/delete/reseed, table create, or order status. Those rely on `SameSite=Strict` + JSON bodies (which force a preflight cross-origin). The UI already sends `x-csrf-token` on menu writes (`src/pages/Admin.jsx:1020`), so the header is present but unverified — a latent gap if the cookie policy is ever relaxed or a same-site attacker exists. |
| **G5** | **Operator password rotation leaves live sessions** | **Medium** | Rotating `OPERATOR_PASSWORD` changes the login check only; existing `operator_sessions` rows stay valid up to 12 h. There is no version/binding between the secret and the sessions. |
| **G6** | **No session inventory or per-device revoke** | **Medium** | Owners get "sign out everywhere" (all-or-nothing) and nothing else; there is no list of devices, no "end that one". Operator gets ordinary logout and logout-all only. |
| **G7** | **No self-service password reset** | **Medium** | There is no email transport, so reset is operator-only (`operatorResetPassword`), and the new password is displayed once in the console. A café whose owner forgets the password depends on the operator being reachable. |
| **G8** | **Password reset leaves stale session rows** | **Low** | The reset bumps `auth_version`, which makes old tokens fail closed, but does not delete `owner_sessions` rows; they are pruned only by the sign-in prune (≤100 rows per sign-in). The `logout-all` and password-change paths *do* delete them. |
| **G9** | **No durable authentication audit log** | **Low-Medium** | Failed and successful owner sign-ins leave only `rate_limits` counters; there is no `auth_events` table. `password_resets` and `operator_audit` cover operator actions only. Post-incident questions ("when did that session start, from where?") cannot be answered. |
| **G10** | **Roles are stored but never read** | **Low** | `cafe_owners.role` is always `'owner'`; no least-privilege (viewer/manager) exists, so every owner can change the password and every setting. |
| **G11** | **Argon2id CPU budget unproven on the deployed runtime** | **Medium (availability)** | See §4. |
| **G12** | **CSRF token write amplification** | **Low** | Every `GET /api/admin/session` heartbeat inserts a new `csrf_tokens` row (expired rows deleted in the same call). At 12 h and a 30 s poll that is ~1 440 rows per open tab per shift, and the same table is shared with the operator console. |
| **G13** | **Cookie hardening nits** | **Low** | No `__Host-` prefix; `Secure` is conditional on the request scheme (deliberate for local http dev); cookie name embeds the slug (predictable, not a weakness, but it does advertise the tenant). |
| **G14** | **Distributed guessing is not limited** | **Low-Medium** | Lockout is keyed by café **and** IP hash; an attacker with many addresses faces only the per-IP ceiling. D1-backed global counters would bound it, and TOTP would make a guessed password insufficient. |
| **G15** | **`pin` is still accepted as a password field alias** | **Informational** | `body.password || body.pin` (`api.js:2096`). Harmless, but it invites a legacy PIN-shaped secret; nothing enforces the 12-character floor at sign-in (only at set time). |

---

## 4. Argon2id CPU compatibility risks

### 4.1 What is pinned

`m = 19456 KiB (19 MiB)`, `t = 2`, `p = 1`, 16-byte salt, 32-byte tag, `argon2id@1.0.1` with **statically imported** `simd.wasm` / `no-simd.wasm` (workerd refuses to compile wasm from bytes, hence the `CompiledWasm` rule in both Wrangler configs). Bundle: 222.52 KiB raw / 51.44 KiB gzip including both modules. The library reserves roughly 65 MB of wasm memory and 19 MiB per derivation; the module serialises derivations (1 running, 3 queued) rather than growing.

### 4.2 The risk

| Fact | Consequence |
|---|---|
| Measured in the local harness: hash p50 48.8 ms, verify p50 47.3 ms (HTTP wall clock, not Workers CPU accounting) | the true CPU charge is unknown but of the same order |
| Workers **Free** allows **10 ms CPU per request** | a local sign-in, a password set/change, an operator reset and a settings re-auth would each exceed it → `Error 1102`. Password flows are effectively unavailable on Free. |
| Workers Paid allows far more (30 s CPU ceiling) | paid plan is the straightforward fix but conflicts with the zero-budget constraint |
| No measurement has ever run on the deployed runtime | the café's staging row has `pass_hash IS NULL`, so login returns 503 **before** hashing; Stage 7/10/13 all carry this as an unproven assumption |
| `tests/gate2-measure.mjs` exists but runs in Node with the wasm loader hook | it measures the algorithm, not workerd's CPU accounting — it cannot settle the question |
| Queue depth 3 per isolate | under burst load, correct passwords get 429 before CPU is even spent; on a single-isolate deployment this caps sign-in throughput at roughly 20/s theoretical and far less in practice |

### 4.3 What must not be done

Lowering `m`, `t` or `p`, falling back to PBKDF2 for new hashes, or verifying a stored hash at a reduced cost are all excluded — by the F-07 decision and by this stage's constraints. Any "fix" that touches the constants is a security regression, not a performance fix.

### 4.4 Options that keep the parameters intact

1. **Measure first** on a non-public Worker (needs deployment approval) — `EMAIL`-free, disposable D1, one hash + one verify, read `cpuTime`/`outcome` from the tail. This settles whether Free is viable at all.
2. **Reduce the number of derivations**, never their cost: sign-in is the only hot path; the opportunistic rehash already runs once per legacy hash; no endpoint should hash for a non-credential purpose (none does).
3. **Make the password verify unnecessary at request time** by delegating identity (Cloudflare Access in front, or the already-written WorkOS path) — a JWT/RSA verification costs ~1–3 ms, well inside Free.
4. **Keep Argon2id only on cold credential paths** (password set, change, operator reset — a handful of requests per year per café) and move routine sign-in to the delegated identity.

---

## 5. TOTP implementation requirements

No TOTP code exists. The following is a complete, implementation-ready specification consistent with the current architecture (it adds a factor; it changes nothing about Argon2id).

### 5.1 Algorithm and parameters

RFC 6238, SHA-1, 30-second step, 6 digits, secret = 20 random bytes (`crypto.getRandomValues`), Base32 (RFC 4648, no padding) for the `otpauth://totp/Corner%20Cup:<slug>?secret=…&issuer=Corner%20Cup&algorithm=SHA1&digits=6&period=30` URI. Verification accepts the current step and ±1 step (clock skew) and compares in constant time. HMAC-SHA1 over WebCrypto costs well under 1 ms CPU — it fits the Free plan.

### 5.2 Schema (additive migrations, same idempotent style as `worker/db.js`)

```
owner_totp(cafe_id INTEGER PRIMARY KEY, secret_enc TEXT NOT NULL, digits INTEGER NOT NULL DEFAULT 6,
           period INTEGER NOT NULL DEFAULT 30, confirmed_at INTEGER, last_used_step INTEGER,
           created INTEGER NOT NULL, updated INTEGER NOT NULL)
owner_totp_recovery(code_hash TEXT PRIMARY KEY, cafe_id INTEGER NOT NULL, created INTEGER NOT NULL,
                    used_at INTEGER)
owner_totp_challenges(challenge_hash TEXT PRIMARY KEY, cafe_id INTEGER NOT NULL, session_nonce TEXT,
                      created INTEGER NOT NULL, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)
```

- `secret_enc` is AES-256-GCM ciphertext with a fresh 12-byte IV, key derived by HKDF-SHA256 from a **new** Worker secret (e.g. `MFA_ENC_KEY`) — the exact pattern already in `worker/pkce.js`. A database dump alone must not yield usable TOTP secrets.
- Recovery codes: 10 codes, 10 Base32 characters each, stored only as SHA-256 digests, single-use via a conditional `UPDATE … WHERE used_at IS NULL`.
- `last_used_step` gives replay protection: accept a code only if its step is strictly greater than the stored one, updated in the same statement (`UPDATE … SET last_used_step = ? WHERE cafe_id = ? AND last_used_step < ?`).

### 5.3 Flows

| Flow | Contract |
|---|---|
| Enroll | `POST /api/cafes/:slug/admin/mfa/enroll` (session + CSRF + current password) → creates a **pending** secret (`confirmed_at IS NULL`), returns the `otpauth` URI; the QR is rendered client-side with the existing `qrcode` dependency. `POST …/mfa/confirm` with a valid code sets `confirmed_at`, bumps `auth_version` (killing every other session) and returns 10 recovery codes once. |
| Sign-in, step 1 | existing password verify succeeds → if `owner_totp.confirmed_at` is set, **no session is issued**; the server writes a challenge (hashed id, 5-minute TTL, 5 attempts) and answers `{ mfaRequired: true, challenge, expiresIn }`. |
| Sign-in, step 2 | `POST /api/cafes/:slug/admin/login/totp { challenge, code }` → challenge consumed once (conditional `UPDATE`), code verified, replay step recorded, **then** the normal `owner_sessions` insert + cookie. A recovery code is accepted here and burnt. |
| Disable | requires session + CSRF + current password **and** a valid TOTP code; deletes the row, bumps `auth_version`. Refused outright for managed cafés. |
| Failure behaviour | challenge or code failure = 401 with a generic message and the shared lockout counter incremented; a store error = 503 (never "wrong code"). |
| Rate limits | 5 TOTP attempts / 10 min per café+IP, 5 per challenge; reuse the `rate_limits` table. |
| Interactions | TOTP is orthogonal to `owner_auth`: it applies to `local` cafés only (managed cafés inherit the provider's MFA, which today is unenforced — see §6). Requiring TOTP must never weaken Argon2id; the password is still verified **before** the challenge is issued. |
| Operator console | equivalent TOTP would be bolted onto a shared secret with no identity; per §9 the cheaper correct answer is Cloudflare Access + per-operator accounts, not TOTP on a static string. |

### 5.4 Audit and messaging

Add `auth_events(cafe_id, kind, subject, ip_hash, detail, created)` for `login_success`, `login_fail`, `mfa_fail`, `mfa_enrolled`, `mfa_disabled`, `session_revoked`, `password_changed`. No secret, code or token is ever written — only the fact and a hashed IP.

---

## 6. Session revocation gaps

| # | Scenario | Current behaviour | Gap |
|---|---|---|---|
| R1 | Owner signs out on one device | `owner_sessions` row deleted, cookie cleared | correct |
| R2 | Owner clicks "sign out everywhere" | `auth_version` bumped atomically, other rows deleted, caller re-issued | correct |
| R3 | Owner changes the password | version bump + new session, other rows deleted, stale change refused by CAS | correct |
| R4 | Operator resets the password | version bump makes old tokens fail; rows **not** deleted | stale rows linger (≤24 h, pruned at next sign-in) |
| R5 | Operator revokes an owner's membership | `cafe_owners` row deleted | **live sessions survive** until expiry — the check is at sign-in only |
| R6 | Café switches auth mode | sessions + states deleted inside the transition batch | correct |
| R7 | Operator password rotates | nothing | existing operator sessions stay valid up to 12 h |
| R8 | Owner loses a laptop, keeps the password | only "sign out everywhere" | no per-device revoke, no session list |
| R9 | Provider session must end (managed) | durable queue, best-effort drain, 5 attempts / 24 h, then dropped | no scheduler; the provider session can outlive the record (documented, not hidden) |
| R10 | Membership changes while a session is live | no effect | would need a membership check on each owner request (one indexed read) or a version bump on grant/revoke |

**Design note:** `ownerSession()` already reads one D1 row per request; adding `AND EXISTS (SELECT 1 FROM cafe_owners …)` for managed sessions, or bumping `auth_version` inside the revoke batch for local ones, closes R5/R10 with no new table.

---

## 7. Relevant test coverage

50 test files; **475 tests passing** in the last full local run (Stage 3I-D). Authentication-focused files and their test counts:

| File | Tests | What it covers |
|---|---|---|
| `session.revocation.test.mjs` | 33 | session row lifecycle, both expiries, renewal races, CSRF binding |
| `operator.revocation.test.mjs` | 20 | operator session ownership, logout, logout-all, CSRF |
| `owner.signin.test.mjs` | 14 | local sign-in, wrong password, lockout, cookie shape, logout |
| `auth.fallback.test.mjs` | 12 | no-secret/no-hash deployments, 503 paths, no fallback secret |
| `f07-regression.test.mjs` | 11 | Argon2id regressions, no PBKDF2 for new hashes |
| `owner.routes.http.test.mjs` | 12 | managed sign-in, membership gate, generic denial, no leaks |
| `auth-mode.d1` / `auth-mode.atomicity` | 10 + 13 | mode switch atomicity, witnesses, generation trigger |
| `argon2.passwords.test.mjs` | 9 | parameters, PHC parse, malformed/short input, queue bounds |
| `cookie.name` / `cookie.malformed` | 4 + 9 | per-café cookie names, malformed percent-escapes |
| `settings.reauth.test.mjs` | 8 | current-password requirement, lockout, partial-failure | 
| `migrations.owner-auth.test.mjs` | 8 | schema/migration idempotency for new auth columns |
| `operator.owner-routes.test.mjs` | 9 | grant/revoke/claim/mode routes |
| `browser.credentials` | 5 | no token in JS-accessible storage |
| `auth.version` / `auth.race` / `auth.secrets` / `auth.empty-login` | 3 + 1 + 1 + 4 | version validation, races, secret handling, blank bodies |
| `password.reset` / `password.reset.sql` | 3 | reset batch SQL and audit coupling |

**Not covered (would need new tests):** any TOTP behaviour; CSRF enforcement on settings/menu/table/order mutations (the UI sends the header, no test asserts the server rejects its absence); operator password rotation; per-device revocation; membership revocation ending a session; authentication audit rows; Argon2id CPU/memory on the actual workerd runtime.

**Harness:** workerd via `wrangler dev` (`tests/harness/wrangler*.jsonc`, `tests/harness/worker.mjs`), plus SQLite-only tests for migration/batch SQL; `npm test` registers a wasm loader hook so Argon2id runs under Node for the pure‑JS tests.

---

## 8. Prioritized remediation plan

| Priority | Item | Why | Effort | Where |
|---|---|---|---|---|
| **P0-1** | **Close the membership-revocation hole** (R5/R10): check `cafe_owners` on every managed owner request, or bump `auth_version` inside the revoke batch | a removed owner keeps full control for up to 24 h | ~1 h + tests | `worker/session.js`, `worker/api.js:3373` |
| **P0-2** | **Enforce CSRF on every owner mutation** (settings PATCH, menu CRUD/reseed, tables, order status) | consistency; the header is already sent by the UI | ~2 h + tests | `worker/api.js` |
| **P0-3** | **Measure Argon2id CPU on the intended runtime** (non-public Worker, disposable D1, one hash + one verify) | decides whether local sign-in is viable at all; every launch plan depends on it | ~½ day + deployment approval | deployment + `wrangler tail` |
| **P1-1** | **TOTP for local owners** (§5) — enroll, confirm, login challenge, recovery codes, replay protection | the single largest control gap (G1) and cheap CPU-wise | 1.5–2 days | `worker/db.js`, new `worker/totp.js`, `worker/api.js`, `src/pages/Admin.jsx`, tests |
| **P1-2** | **Operator console behind an identity** (Cloudflare Access, or per-operator accounts with their own hash + TOTP) and **bind sessions to the secret** so a rotation revokes them | the console can reset any café's password; one shared static string is the weakest link in the product | 1–2 days (Access path shorter) | `worker/api.js`, docs |
| **P2-1** | **Authentication audit table** (`auth_events`) written on success/failure/revocation | currently no way to reconstruct an incident | ½ day | `worker/db.js`, `worker/api.js` |
| **P2-2** | **Session inventory + per-device revoke** in the board | "sign out everywhere" is the only lever today | 1 day | `worker/api.js`, `src/pages/Admin.jsx` |
| **P2-3** | **Delete session rows in the operator reset batch** (R4) | tidy, and removes invalid-but-present rows | ~1 h | `passwordResetBatch` |
| **P3-1** | **Roles with real meaning** (viewer/manager) — or drop the column | least privilege for staff | 1–2 days | `worker/db.js`, routes, UI |
| **P3-2** | **CSRF row hygiene** (reuse an unexpired token per binding instead of minting on every heartbeat) | write amplification in D1 | ~1 h | `worker/session.js` |
| **P3-3** | **Broader abuse limits** (global per-café failure counter, not only per-IP) | distributed guessing | ½ day | `worker/api.js` |
| **P3-4** | **Self-service reset** once any email transport is approved; otherwise document the operator dependency | G7 | depends on email decision | — |

---

## 9. Recommended zero-budget architecture

**Keep Argon2id exactly as it is. Add TOTP. Put a free identity gate in front of the two human doors.**

1. **Owner sign-in (local mode): password (Argon2id, unchanged) + TOTP.** TOTP is ~1 ms of CPU, so it costs nothing on the Free plan; the password verify keeps its OWASP parameters. This closes the single-factor gap without touching a security parameter and without a paid service.
2. **Owner sign-in (delegated mode): Cloudflare Access** in front of `/c/:slug/owner` and `/api/cafes/:slug/admin/*`. Zero Trust's free plan is **$0 for up to 50 users** and includes **one-time-PIN email** login ([Cloudflare Access pricing](https://cloudflare.com/zero-trust/products/access), [OTP docs](https://developers.cloudflare.com/cloudflare-one/identity/one-time-pin/)). The Worker validates the `Cf-Access-Jwt-Assertion` (RS256 against `https://<team>.cloudflareaccess.com/cdn-cgi/access/certs`, ~1–3 ms) and maps the verified email to a `cafe_owners`-style row. This moves both the password and the second factor off the CPU-limited path while remaining free; it is the only zero-cost option that keeps Argon2id out of the hot path without weakening anything.
3. **Operator console: same Access application**, restricted to the owner's email only, with the shared `OPERATOR_PASSWORD` kept as a second gate until per-operator accounts exist. Not free-tier-dependent for CPU, and it removes the "one static string protects every café" exposure from the public internet.
4. **Do not** use Firebase MFA (needs Blaze billing) or any add-on identity provider — both violate the zero-budget constraint. The WorkOS path stays as written but dormant until a free sandbox exists; its verifier contract issue (Stage 10A.1 C-01) is still unresolved and unrelated to this stage.
5. **Explicitly avoid:** lowering Argon2id parameters, PBKDF2 for new hashes, SMS OTP (cost), and storing TOTP secrets in plaintext.

**Decision point:** if the P0-3 measurement shows Argon2id exceeds the Free CPU budget, the plan does not change — path 2 (Access) becomes the primary owner door and path 1 becomes the fallback used only on a plan that can afford ~50 ms, with credentials set through the operator console rather than at sign-in.

---

## 10. Exact next implementation stage

### Stage 17B — Local TOTP enrollment and sign-in challenge

**Scope (one stage, no deployment):**

1. `worker/db.js`: add `owner_totp`, `owner_totp_recovery`, `owner_totp_challenges` (additive `MIGRATIONS` + indexes on `owner_totp_challenges.expires`).
2. New `worker/totp.js`: Base32 encode/decode, HMAC-SHA1 HOTP/TOTP, ±1 step window, constant-time compare, `otpauth` URI builder, recovery-code generation, secret encryption/decryption via HKDF + AES-256-GCM (reuse the `worker/pkce.js` pattern with a new `MFA_ENC_KEY` secret; empty key ⇒ feature unavailable, 503, never a weaker mode).
3. `worker/api.js` routes: `POST /admin/mfa/enroll`, `POST /admin/mfa/confirm`, `POST /admin/mfa/disable`, and the two-step sign-in (`login` returns `mfaRequired` + challenge instead of a cookie when TOTP is confirmed; `POST /admin/login/totp` completes it). All mutations require CSRF **and** the current password; all bump `auth_version`.
4. `src/pages/Admin.jsx`: enrollment panel (QR from the existing `qrcode` dependency, secret fallback, recovery codes shown once), second-step sign-in form, disable panel.
5. `worker/db.js`/audit: `auth_events` writes for `mfa_enrolled`, `mfa_disabled`, `mfa_fail`, `login_success`.
6. Tests: `totp.vectors.test.mjs` (RFC 6238 test vectors), `totp.enroll.test.mjs`, `totp.login.test.mjs` (challenge single-use, replay step, recovery code burnt once, lockout, 503 on store failure), `totp.migrations.test.mjs`, plus a component test for the UI states.

**Exit criteria:** RFC 6238 vectors pass; a password-only sign-in to a TOTP-enabled café never yields a session; a replayed code fails; recovery codes are single-use; disabling requires password + code; Argon2id constants unchanged; no new dependency; all existing 475 tests still pass.

**Then, in order:** 17C (Cloudflare Access for owner/operator doors + `Email`→membership mapping), 17D (Argon2id CPU measurement and the plan/delegation decision), 17E (session inventory + per-device revoke), 17F (operator accounts with their own hashes and TOTP).

---

## Audit constraints — confirmation

- No file in `worker/`, `src/`, `tests/`, `package.json`, `package-lock.json` or any Wrangler config was modified; the only file written in this stage is this report.
- No secret value was read or printed; `.dev.vars`, `.env` and Wrangler credential stores were never opened.
- No production or staging endpoint, database or deployment was contacted; no deploy, migration or provisioning was attempted.
- The dirty/untracked state of the worktree is preserved; nothing was cleaned, reset or removed.
- Argon2id parameters were neither changed nor proposed to be reduced; no paid service was introduced (the recommended gate is a genuinely free tier, with its 50-user ceiling stated).
