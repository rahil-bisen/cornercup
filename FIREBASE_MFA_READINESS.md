# Stage 10C — Firebase MFA Readiness Check (READ-ONLY)

**Date:** 2026-11-16 · **Project (user-provided):** `corner-cup-auth` (Spark plan, no billing instrument) · **Mode:** read-only investigation. No source, test, config, or documentation files were modified; no packages installed; no migrations run; no secrets, tokens, passwords, phone numbers, or API keys were read or printed; no Firebase settings or user accounts were changed; no D1 writes, sessions, test orders, deployments, or Git mutations were performed.

Labels: **[verified]** read directly in this repository's source/tests · **[documented]** stated by official Firebase/Google Cloud documentation (cited inline) · **[assumption]** reasoned, unmeasured · **[user-provided]** stated by the user in the task prompt.

---

## 1. Current authentication architecture (repository)

### 1.1 Owner authentication modes

Per-café selection via `cafes.owner_auth` (`'local'` default, `'workos'` for managed). Two modes share sessions/cookies/CSRF; only the identity step differs (`STAGE10A_AUTH_AUDIT.md` §1.1, [verified]).

- **Local:** Argon2id password in `cafes.pass_hash`; `POST /api/cafes/:slug/admin/login` → `login()` (`worker/api.js:1804`). Managed cafés answer `410 auth_mode_managed` before hashing.
- **Managed (WorkOS):** `GET /api/cafes/:slug/owner/start` → `ownerStart()` (`worker/owner.js:99`); `POST /api/cafes/:slug/owner/claim/start` → `ownerClaimStart()` (`worker/owner.js:160`); `GET /api/owner/callback` → `ownerCallback()` (`worker/owner.js:249`); `POST /api/cafes/:slug/owner/logout` → `ownerLogout()` (`worker/owner.js:454`). Routes registered in `worker/api.js:185-219`.

### 1.2 Identity and session handling

- `worker/owner.js` enforces the rule "D1 decides who may open a café": membership (`cafe_owners`) is re-checked inside `INSERT … SELECT … WHERE EXISTS (...)` statements, so no JS branch can mint a session without a membership row (`owner.js:366-376`, [verified]).
- Exchange body provides `user.id`, `user.email`, `user.email_verified` (`workos.js:exchangeCode`); JWT verification is separate (`jwt.js:validateClaims`, `verifyToken`). Email verification is enforced from the exchange body (`owner.js:302`), not the JWT — audit finding M3.
- `email_verified === true` is required; unverified ⇒ generic 403 (`owner.js:302-305`).
- Claim (invite) path compares `owner_claims.email` with the exchange body email, case-folded, before consuming (`owner.js:336-344`).
- Membership check: `SELECT role FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?` (`owner.js:348`); no membership and no claim ⇒ 403 (`owner.js:353`).
- Session minted only via `INSERT … SELECT … WHERE EXISTS (cafe_owners)` (`owner.js:366-376`); `meta.changes !== 1` ⇒ 403 (`owner.js:414-415`).
- WorkOS `sid` is optional: `providerSessionId()` (`jwt.js`) returns `null` when absent/malformed; never fabricated. Stored as `owner_sessions.workos_session_id` (NULL for local).

### 1.3 D1 tables involved

`cafes` (`pass_hash`, `owner_auth`, `auth_version`, `auth_mode_generation`, `auth_mode_cas_token`, `auth_version_cas_token`), `owner_sessions`, `owner_identities`, `cafe_owners`, `owner_claims`, `owner_login_states`, `provider_revocations`, `auth_mode_transitions`, `operator_audit`, `operator_sessions`, `csrf_tokens`, `rate_limits`, `tx_guard` (`worker/db.js` SCHEMA/MIGRATIONS/POST_MIGRATIONS, [verified]).

Key shapes:
- `cafe_owners (cafe_id, workos_user_id)` composite PK; `owner_identities (workos_user_id, email, created, last_seen)`; `owner_sessions (session_id, cafe_id, created, expires, workos_user_id, workos_session_id)` with partial index `idx_owner_sessions_identity` on `workos_user_id IS NOT NULL` (`worker/db.js:139-222`, [verified]).
- `operator_revoke_owner` deletes `cafe_owners` only; does not touch `owner_sessions` or `auth_version` (audit M1, [verified]).

### 1.4 Session/CSRF primitives

`worker/session.js`: owner cookie `staff_session_<slug>`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` only over https; token `expires.subject.HMAC-SHA256(ADMIN_SECRET, "expires.subject")`; subject `cafe:<cafeId>:<authVersion>:<sessionId>`; 12 h idle / 24 h absolute caps enforced in the `WHERE` clause; CSRF = 32-byte token, only SHA-256 stored, bound to `sha256(sessionId)` (owners) or `sha256(cookie)` (operator), plus strict `Origin` equality. Three-state verification `ok`/`none`/`store_down` (`session.js:260-320`, [verified]).

### 1.5 Firebase-related code or configuration

**None in source.** A repository-wide search for `firebase`/`Firebase`/`FIREBASE` returned matches only in the two research reports `ZERO_BUDGET_AUTH_FEASIBILITY.md` and `STAGE10B_WORKOS_SANDBOX_REPORT.md` (and this task's planning); no worker, src, or config file references Firebase. `package.json` has no Firebase dependency. No `FIREBASE_*` vars exist in `.dev.vars` (which contains only `ADMIN_PIN`, `ADMIN_SECRET`, `CAFE_NAME`, `CAFE_TZ_OFFSET_MIN`, `OPERATOR_PASSWORD`, `OWNER_PASSWORD`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `SERVICE_MODE`). No Firebase project id, API key, or config in wrangler files. Conclusion: Firebase is not integrated; any integration is greenfield.

---

## 2. Firebase integration readiness (Cloudflare Worker)

### 2.1 Minimum ID-token verification requirements

Firebase ID tokens are standard RS256 JWTs. Per official docs, a third-party verifier must check (`https://firebase.google.com/docs/auth/admin/verify-id-tokens`):

1. Header `alg === "RS256"`; `kid` must match one of the published public keys.
2. Signature valid against the matching key.
3. `exp` in the future (seconds since epoch).
4. `iat` in the past.
5. `aud` equals the Firebase project ID.
6. `iss` equals `securetoken.google.com/<projectId>`.
7. `sub` non-empty and ≤ 128 chars, equal to the user's `uid`.
8. `auth_time` in the past (when the user authenticated).

Keys are fetched from:
- X.509 (PEM) endpoint used by Admin SDK: `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com`
- JWK endpoint usable with `jose`/Web Crypto: `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`

The repository already implements exactly this primitive for WorkOS in `worker/jwt.js` (`decodeJwt`, `selectKey`, `verifySignature`, `validateClaims` with exp/iat/nbf/sub/issuer/audience) and the JWKS fetch/cache/refetch-on-unknown-kid pattern in `worker/workos.js:fetchJwks`. A Firebase verifier would reuse that module almost verbatim, substituting `iss = securetoken.google.com/<projectId>` and `aud = projectId`, and adding the Firebase-specific claim checks in §2.2.

### 2.2 Inspecting MFA claims

Firebase ID-token payload includes a reserved `firebase` object (`https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.decodedidtoken`; `https://firebase.google.com/docs/reference/js/auth.idtokenresult`):

- `firebase.sign_in_provider` — e.g. `password`, `google.com`.
- `firebase.sign_in_second_factor` — `totp` / `phone` / **absent**. Present only when the session was actually multi-factor authenticated.
- `firebase.second_factor_identifier` — enrollment id of the factor used (audit).
- `firebase.identities` — map of providers to UIDs.
- `firebase.tenant` — optional.

The ID token also carries top-level `email`, `email_verified`, `auth_time`, `sub` (= uid), `user_id` (legacy duplicate; prefer `sub`).

### 2.3 Enrolled factor vs. proof of MFA in this sign-in

**Critical distinction (do not conflate):**

- **Enrollment** is a property of the user account: a TOTP (or phone) factor has been registered in Firebase. It is visible in the Firebase Console and in the user record. It says "this user *can* do MFA", not "this sign-in *did* MFA."
- **Proof of MFA in this sign-in** is the claim `firebase.sign_in_second_factor` inside the *signed* ID token for the current session. It is `totp`/`phone` only if the user actually completed the second factor during this authentication. A token without it means the session was established with only the first factor, even if a factor is enrolled.

Therefore: project-level MFA state `ENABLED`, TOTP provider `ENABLED`, and a phone factor marked enrolled in the console do **not** prove that any given sign-in completed MFA. Only the signed ID token's `firebase.sign_in_second_factor` value proves it. The Admin SDK decodes the same claim; nothing in the console enrollment status substitutes for it.

This mirrors the WorkOS lesson captured in `STAGE10A1_AUTH_REMEDIATION_PLAN.md` §3: `auth_time` is freshness, not MFA proof; only a verified, signed claim counts, and it must be allowlisted/pinned, never trusted from the request body.

---

## 3. MFA enforcement (recommended Worker behavior)

### 3.1 Fail-closed rule

After signature/issuer/audience/expiry/subject verification succeeds, the Worker must additionally require, when MFA mode is `required`:

- `firebase.sign_in_second_factor === "totp"` (for the long-term owner MFA method), and
- `email_verified === true` (Firebase requires verified email before MFA enrolment; the Worker must not accept an unverified address).

If either is missing or not exactly the expected value ⇒ reject the authentication (generic denial, distinct server-side reason code, no session, no membership grant, no partial state), exactly as `ownerCallback()` does today for unverified email and missing membership (`worker/owner.js:302-305`, `353`, `414-415`).

Under a `provider-only` mode (documented residual risk), the absence of the claim is logged but allowed; this must never be the default for production managed cafés and must be recorded in readiness docs (mirroring `STAGE10A1_AUTH_REMEDIATION_PLAN.md` §3.2 item 5).

### 3.2 Project-level MFA enabled ≠ per-user MFA completion

The user reported: Firebase project MFA state `ENABLED`, TOTP provider `ENABLED`, `adjacentIntervals = 5`, a disposable test account has a phone factor marked enrolled, yet a fresh sign-in did not visibly request an OTP.

**This is consistent with Firebase's documented model and does not by itself indicate a bug:**

- Project-level "MFA enabled" makes MFA *available* and, for TOTP, requires enrolment before sign-in for accounts that have a factor; but Firebase only challenges a second factor when the account has an enrolled factor of a type the sign-in flow requests, and the client SDK is configured to perform the MFA step. If the account's only enrolled factor is **phone** and the sign-in is attempted with the email/password flow without triggering the second-factor step, or the client code does not call the MFA resolver, no OTP is requested.
- A phone factor enrolled does **not** mean TOTP is enrolled. The two are separate factor types; TOTP being `ENABLED` at project level does not enrol TOTP on that account.
- Email/password sign-in with no enrolled factor of a type the flow exercises completes with the first factor only, producing an ID token with `firebase.sign_in_second_factor` absent — which is exactly the case the Worker must reject under `required` mode.
- `adjacentIntervals = 5` is a TOTP verification tolerance setting; it is irrelevant unless a TOTP factor is actually enrolled and challenged.

**No conclusion can be drawn** that the account is broken or working. Evidence required: a decoded, signature-verified ID token from the attempted sign-in, showing whether `firebase.sign_in_second_factor` is present and its value, plus the client-side sign-in code path used. Neither was provided and neither was inspected here (no tokens printed, no settings changed).

### 3.3 Long-term vs. temporary MFA method

- **Long-term owner MFA: TOTP** (authenticator app). No per-message cost, works on Spark, and yields `sign_in_second_factor: "totp"` in the ID token.
- **SMS: temporary testing only.** SMS MFA requires the Blaze plan and is billed per message; it is not available on Spark. The phone factor enrolled on the disposable test account is useful for probing MFA flow behavior but must not be the production owner MFA method under a ₹0 budget.

---

## 4. Unresolved questions

1. Whether the disposable test account has a **TOTP** factor enrolled (vs. only phone). Evidence needed: Firebase Console user record / Admin SDK `UserRecord.multiFactor.enrolledFactors` for that account. Not inspected (no credentials, no account changes).
2. Whether the attempted sign-in used a client code path that initiates the MFA challenge (Firebase Web SDK `signInWithEmailAndPassword` returns `FirebaseError` with `auth/multi-factor-auth-required` and a `MultiFactorResolver`; the second factor is completed via `resolver.resolveSignIn(...)`). If the code only calls the first step and ignores the resolver, no OTP is requested.
3. Whether the resulting ID token carried `firebase.sign_in_second_factor` and, if so, its value. Evidence needed: a redacted, signature-verified decode of that token's payload (claim names/types only, no token string retained).
4. Whether email verification completed for that account before MFA (MFA requires a verified email).
5. Whether the TOTP provider enablement at project level was applied to the specific tenant/user (multi-tenancy not in use here, but worth confirming).
6. Exact Firebase ID-token fixture (issuer, JWKS URL, `kid`, `auth_time` format) for the `corner-cup-auth` project — must be captured in a protected ephemeral location before any verifier is finalized, per the C-01/10B gating rule. Not done in this stage.
7. Whether to add `'firebase'` as a third `owner_auth` value or replace WorkOS entirely — product decision, out of scope for this check.

---

## 5. Relevant file paths and line references (current auth)

- `worker/api.js:61` — imports `ownerStart`, `ownerClaimStart`, `ownerCallback`, `ownerLogout` from `./owner.js`.
- `worker/api.js:185-187` — `GET /api/owner/callback` → `ownerCallback(request, env, url)`.
- `worker/api.js:215-219` — `GET owner/start`, `POST owner/claim/start`, `POST owner/logout` (per café).
- `worker/owner.js:93` — `managedOnly(cafe)` (owner_auth === "workos").
- `worker/owner.js:99` — `ownerStart`.
- `worker/owner.js:160` — `ownerClaimStart`.
- `worker/owner.js:249` — `ownerCallback`: burns state, exchanges code, verifies JWT, checks `user.emailVerified`, checks claim email, checks membership, mints session via `INSERT … SELECT … WHERE EXISTS`.
- `worker/owner.js:302-305` — unverified email ⇒ generic 403.
- `worker/owner.js:336-344` — claim email match.
- `worker/owner.js:348-353` — membership check.
- `worker/owner.js:366-376` — session insert gated on `EXISTS (cafe_owners)`.
- `worker/owner.js:414-415` — `meta.changes !== 1` ⇒ 403.
- `worker/owner.js:444` — `queueOne` (provider revocation statement).
- `worker/owner.js:454` — `ownerLogout`.
- `worker/workos.js:96-110` — `authorizeUrl`.
- `worker/workos.js:114-160` — `exchangeCode` (single attempt, 5 s timeout, 64 KiB bound).
- `worker/workos.js:162-190` — `fetchJwks` (per-client URL, 10 min TTL, refetch on unknown kid).
- `worker/jwt.js` — `decodeJwt`, `selectKey`, `verifySignature`, `validateClaims` (RS256, kid required, issuer exact, audience containment, exp/iat/nbf, sub regex), `providerSessionId`, `verifyToken`.
- `worker/db.js:133-222` — owner-auth schema (cafes.owner_auth, owner_identities, cafe_owners, owner_sessions + partial index, owner_login_states, provider_revocations, etc.).
- `worker/session.js:260-320` — three-state session verification and renewal caps.
- `worker/pkce.js` — PKCE S256, AES-256-GCM state encryption, claim digest.
- `worker/authmode.js` — 9-statement atomic mode transition with CAS witness.
- `worker/revocations.js` — drain/queue/lease/backoff for provider revocations.
- `worker/api.js:1804` — local `login()`.
- `worker/api.js:2983` — `operatorRevokeOwner`.
- `tests/fixtures/workos.mjs` — deterministic local provider fixture (issuer `https://api.workos.com/user_management/<client_id>`, `aud = client_id`, RS256, `kid test-kid-1`); fixture only, not provider evidence.
- `tests/workos.jwt.test.mjs`, `tests/owner.signin.test.mjs`, `tests/owner.revocation.test.mjs` — fixture-only contract tests.
- No Firebase imports, vars, or dependencies anywhere in `worker/`, `src/`, `tests/` (beyond research reports).

---

## 6. Confirmed facts vs. assumptions

**Confirmed (verified in repo):**
- No Firebase code, dependency, or configuration exists anywhere in the project.
- Owner auth is mode-gated per café (`local`/`workos`) with D1 membership enforced inside SQL.
- `email_verified` is enforced from the exchange body, not the JWT (M3).
- WorkOS `sid` is optional and never fabricated.
- Session caps 12 h idle / 24 h absolute; CSRF strict Origin + token hash.
- Operator revocation deletes `cafe_owners` only, leaving sessions live (M1).
- Provider revocation is best-effort with no scheduler (M2).

**User-provided (taken as stated, not verified here):**
- Firebase project `corner-cup-auth` on Spark; Email/password enabled; Identity Platform API enabled; project-level MFA state `ENABLED`; TOTP provider `ENABLED`; `adjacentIntervals = 5`; a disposable test account has a phone factor enrolled; a fresh sign-in did not visibly request an OTP.

**Assumptions (reasoned, unmeasured):**
- Firebase TOTP MFA on Spark is available without a billing instrument (documented as available without billing up to daily limits; TOTP has no per-message cost).
- The missing OTP is explained by factor-type mismatch (phone enrolled, TOTP not) and/or client flow not invoking the MFA resolver — plausible but unproven.
- Firebase ID-token verification fits the 10 ms Workers Free CPU budget (same primitive as the existing WorkOS verifier; unmeasured for Firebase specifically).

**Documented (official):** Firebase ID-token contract, JWKS endpoints, `firebase.sign_in_second_factor` semantics, MFA-requires-verified-email, TOTP/SMS availability, Spark limits (see `ZERO_BUDGET_AUTH_FEASIBILITY.md` §§4–5 and citations).

---

## 7. Recommended next step

Do not implement. Before any Firebase integration work, obtain the missing evidence in read-only fashion:

1. Inspect (read-only) the disposable test account's enrolled factors (Firebase Console → Authentication → Users → that user → Multi-factor) to determine whether a **TOTP** factor is enrolled or only phone.
2. Inspect the client sign-in code path used for the attempt to confirm whether it handles `auth/multi-factor-auth-required` and calls `resolver.resolveSignIn(...)` with the TOTP (or phone) factor.
3. Capture one real Firebase ID token from a completed sign-in into a protected ephemeral location and decode (signature-verified) its payload, recording only claim names/types and whether `firebase.sign_in_second_factor` is present and its value. Do not retain the token string.
4. Confirm the account's `email_verified` status.
5. Only after (1)–(4) are recorded, decide whether to proceed with Firebase integration and, if so, capture the project's exact issuer/JWKS/`kid` as the fixture contract before writing any verifier.

This investigation was strictly read-only. The worktree remains unchanged: no source, test, config, or documentation files were modified, no packages installed, no migrations run, no secrets or tokens printed, no Firebase settings or accounts changed, no D1 writes, sessions, test orders, or deployments performed, and no Git mutations executed. Existing modified and untracked work is preserved.
