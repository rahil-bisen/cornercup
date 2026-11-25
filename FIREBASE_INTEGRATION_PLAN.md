# Stage 10C.2 — Firebase Integration Architecture Plan (READ-ONLY)

**Date:** 2026-11-16 · **Project (user-provided):** `corner-cup-auth` (Spark plan) · **Mode:** read-only. No source, test, config, or documentation files were modified; no packages installed; no Firebase settings or accounts changed; no secrets, tokens, passwords, phone numbers, or API keys were read or printed; no D1 writes, migrations, deployments, or Git mutations were performed. Existing modified/untracked work is preserved.

**Inputs:** `FIREBASE_MFA_READINESS.md`, `FIREBASE_MFA_EVIDENCE.md`, current repository source (see §13).

**Recommendation (bottom line):** **CONDITIONAL GO** — the architecture is feasible and reuses most existing primitives, but implementation is blocked on capturing a real Firebase ID-token fixture and proving TOTP enrollment on the disposable test account. See §17.

---

## 1. Architecture summary

- Firebase Authentication becomes a third owner-identity provider alongside `local` (Argon2id password) and `workos` (WorkOS OAuth). A café's `owner_auth` column selects among `local`, `workos`, `firebase`.
- Firebase owns: owner email/password identity, email verification, TOTP enrolment, and the MFA challenge. Firebase does **not** own café membership, roles, or authorization — D1 does, exactly as today.
- The Cloudflare Worker is the only component that mints a Corner Cup owner session. It verifies the Firebase ID token with Web Crypto, enforces `firebase.sign_in_second_factor === "totp"` under the required MFA policy, maps the verified UID to D1 membership, and issues the existing signed session cookie.
- Guest ordering stays unauthenticated. Operator authentication stays separate (password + operator sessions). Local password auth remains available as a rollback path (`owner_auth = 'local'`) until Firebase is proven stable.
- SMS/phone MFA is never accepted for the long-term owner policy, even if a Firebase account has a phone factor enrolled.

## 2. Authentication modes and rollout

- Extend `AUTH_MODES` in `worker/authmode.js:13` from `["local", "workos"]` to `["local", "workos", "firebase"]`.
- Replace the binary `managedOnly(cafe)` check (`worker/owner.js:93`) with a provider-aware helper, e.g. `ownerProvider(cafe)` returning `"local" | "workos" | "firebase" | null`, and `isManaged(cafe) = provider !== "local"`. All existing call sites (`owner.js:100,161,281`) and route guards (`api.js:215-219`) are updated to use the helper; no behaviour change for `local`/`workos`.
- Rollout is per-café via the existing atomic `authModeTransition()` batch (`worker/authmode.js`): an operator moves one café at a time. The precondition "a managed café must have at least one owner" (`authmode.js` S2) is reused for `firebase`.
- `local` remains the default for every existing café; nothing is migrated automatically.

## 3. Client-side Firebase Web SDK setup

**New files (proposed, not created):**
- `src/lib/firebase.js` — initialize the Firebase app from public config, export `auth`, `firebaseConfig`.
- `src/pages/OwnerFirebaseSignIn.jsx` (or extend `src/pages/Admin.jsx`) — email/password sign-in, verification gate, TOTP enrolment, MFA resolution.

**Changes:**
- Add the Firebase JS SDK (modular, v9.19.1+ for TOTP MFA) to `package.json` dependencies. **Dependency addition is a later, authorized step; not performed here.**
- Public config (`apiKey`, `authDomain`, `projectId`, `appId`) is not secret. Expose it either via Vite env (`VITE_FIREBASE_*`) or via the existing `/api/config` endpoint (`worker/api.js` config route). Prefer `/api/config` so the Worker controls which cafés are Firebase-managed and config cannot drift; the Worker returns `firebaseConfig` only when `owner_auth === "firebase"`.
- `src/pages/Admin.jsx`: when `ownerAuth === "firebase"`, render the Firebase sign-in component instead of the WorkOS redirect button. Keep the local password form and WorkOS button paths untouched for other modes.

**Why:** Firebase owns identity and MFA; the client must perform email/password sign-in, email verification, TOTP enrolment, and the MFA resolver flow before handing a verified ID token to the Worker.

**Dependencies:** Firebase JS SDK; Vite build; existing `api()` helper in `src/`.

**Tests required:** component-level tests for sign-in success, unverified email, MFA-required rejection handling, TOTP enrolment, and cancellation. (No test harness exists today; see §12.)

**Security risks:** Public API key is fine but must be domain-restricted in the Firebase console; config must not be served for non-Firebase cafés; client code must never store or forward refresh tokens to the Worker.

## 4. Email/password sign-in

- Client calls `signInWithEmailAndPassword(auth, email, password)`.
- On success, call `user.getIdToken()` and POST `{ idToken }` (plus optional `claimCode`) to a new Worker endpoint `POST /api/cafes/:slug/owner/firebase/exchange` (or reuse a generalized `owner/exchange`). The Worker verifies the token and mints the session; the client never uses the Firebase token as the session.
- On failure, surface Firebase's error code generically to the user (no account enumeration); log the code server-side only if the request reached the Worker.

**Tests:** invalid credentials, disabled account, network failure, missing token.

**Risks:** Client-side error messages can leak account existence; keep messages generic. Rate-limit the exchange endpoint.

## 5. Email verification handling

- Firebase sends the verification email; the client gates sign-in on `user.emailVerified` (show "verify your email" and a resend button).
- The Worker **also** requires `email_verified === true` in the verified ID token (`worker/owner.js` equivalent of line 302). Fail closed with the generic denial message and a server-side reason code `email-unverified`. No session, no membership grant.
- This is defense in depth: a client bug cannot bypass verification because the token claim is authoritative.

**Tests:** unverified token rejected; verified token accepted; claim email must match token email.

## 6. TOTP enrolment and MFA sign-in resolution

**Enrolment (client, one-time):** requires verified email; then `multiFactor(user).getSession()` → `TotpMultiFactorGenerator.generateSecret()` → display QR/secret → user enters code → `TotpMultiFactorGenerator.assertionForEnrollment(secret, code)` → `multiFactor(user).enroll(assertion, displayName)`. The Worker is not involved; enrolment state lives in Firebase.

**Sign-in resolution (client):** `signInWithEmailAndPassword` rejects with `auth/multi-factor-auth-required`; obtain the resolver via `getMultiFactorResolver(auth, error)`; find the TOTP hint in `resolver.hints` (`factorId === "totp"`); collect the code; build `TotpMultiFactorGenerator.assertionForSignIn(hint.uid, code)`; call `resolver.resolveSignIn(assertion)`; then `getIdToken()`.

**Policy enforcement (Worker):** only `firebase.sign_in_second_factor === "totp"` satisfies required MFA. `phone` is rejected (`mfa-method-not-allowed`). Absent is rejected (`mfa-assurance-unavailable`).

**Tests:** enrolment success/failure; resolver flow; phone-only account rejected at Worker; TOTP account accepted.

**Risks:** If the client selects a phone hint and completes it, the resulting token carries `phone`; the Worker rejects it, so SMS cannot satisfy policy. If the client skips the resolver, sign-in either fails or completes first-factor-only; the Worker rejects the latter.

## 7. Worker ID-token verification and JWKS caching

**New file (proposed):** `worker/firebase.js` (or `worker/auth/firebase.js`) exporting `verifyFirebaseIdToken(idToken, env)`.

- Reuse `worker/jwt.js` (`decodeJwt`, `selectKey`, `verifySignature`, `validateClaims`) and the fetch/cache/refetch-on-unknown-kid pattern from `worker/workos.js:fetchJwks`.
- JWKS URL: `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`.
- Claim validation:
  - `alg === "RS256"`, `kid` present.
  - Signature valid against the matching key.
  - `iss === "securetoken.google.com/" + env.FIREBASE_PROJECT_ID`.
  - `aud === env.FIREBASE_PROJECT_ID`.
  - `exp` future, `iat` past, `auth_time` past (bounded skew, e.g. 60 s).
  - `sub` non-empty, ≤ 128 chars, Firebase UID charset (not the WorkOS `user_` regex).
  - `email_verified === true`.
- Cache JWKS with a TTL (reuse 10-minute pattern or Google's `Cache-Control`); refetch once on unknown `kid`; never cache across isolates in a way that hides rotation beyond TTL.
- Add env var `FIREBASE_PROJECT_ID` (non-secret) and optionally `FIREBASE_AUTH_DOMAIN`. These are configuration, not secrets; document them. No service account or Admin SDK key is needed for ID-token verification.

**Dependencies:** `worker/jwt.js`, `worker/workos.js:fetchJwks` pattern, Web Crypto (already available in Workers).

**Tests:** valid token; bad signature; wrong issuer/audience; expired; bad `kid`; missing `sub`; unverified email; missing MFA claim; `phone` vs `totp`.

**Risks:** Clock skew; JWKS rotation; CPU budget on Workers Free (unmeasured — see blockers). A wrong `sub` regex could reject valid UIDs; use Firebase's documented UID charset.

## 8. Firebase-to-D1 identity mapping

**Problem:** existing tables key identities by `workos_user_id`. Supporting Firebase without breaking WorkOS requires a provider-neutral mapping.

**Proposed migration (additive, idempotent):**
- `ALTER TABLE owner_identities ADD COLUMN auth_provider TEXT NOT NULL DEFAULT 'workos'` (or introduce `provider`).
- `ALTER TABLE owner_identities ADD COLUMN firebase_uid TEXT` (nullable).
- `ALTER TABLE cafe_owners ADD COLUMN firebase_uid TEXT` (nullable) — or rely on a join through `owner_identities`.
- `ALTER TABLE owner_sessions ADD COLUMN firebase_uid TEXT` (nullable).
- Add partial indexes: `idx_owner_identities_firebase_uid`, `idx_cafe_owners_firebase_uid`, `idx_owner_sessions_firebase_uid`.

Alternative (cleaner but larger): rename `workos_user_id` to `provider_subject` and add `auth_provider`, backfilling `auth_provider = 'workos'` for existing rows. SQLite supports `ALTER TABLE ... RENAME COLUMN`, but this touches every query and test fixture. **Recommend the additive approach first** to minimize risk and preserve rollback; deprecate `workos_user_id` only after Firebase is proven stable.

**Identity key:** Firebase UID (`sub`) is immutable and unique per project. Store it as `firebase_uid`. Never authorize on email.

**Membership:** reuse `cafe_owners` composite PK `(cafe_id, firebase_uid)` for Firebase-mode cafés; for WorkOS-mode cafés keep `(cafe_id, workos_user_id)`. Because a café has exactly one `owner_auth` value at a time, only one column is populated per café. Mixed membership across providers for the same café is not supported by design (mode is per-café).

**Email cache:** `owner_identities.email` remains an operator-facing cache; update `last_seen` on each successful exchange, as today.

**Dependencies:** `worker/db.js` MIGRATIONS/POST_MIGRATIONS; existing identity upsert logic in `worker/owner.js:372`.

**Tests:** upsert idempotency; cross-provider isolation; missing membership denial.

**Risks:** Schema drift between providers; query complexity. Mitigation: a single helper `identityKey(cafe, token)` returns `{ column, value }` so SQL is generated consistently and tested.

## 9. Multi-café membership and role authorization

- Reuse `cafe_owners` and its composite PK. One Firebase identity can own several cafés; each row carries `role` (default `owner`).
- Membership check: `SELECT role FROM cafe_owners WHERE cafe_id = ? AND firebase_uid = ?` (mirroring `owner.js:348`).
- Session minting gated on `EXISTS (SELECT 1 FROM cafe_owners WHERE cafe_id = ? AND firebase_uid = ?)` (mirroring `owner.js:366-376`), so no JS branch can mint a session without a membership row.
- Role checks remain unchanged; no new role types introduced.

**Tests:** multi-café account can open each café; non-member denied; role preserved.

## 10. Owner session creation, expiry, logout, and revocation

- Reuse `worker/session.js` entirely: cookie name `staff_session_<slug>`, `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` over https, signed subject `cafe:<cafeId>:<authVersion>:<sessionId>`, 12 h idle / 24 h absolute caps, CSRF binding.
- Mint the session in the exchange endpoint using the same `INSERT … SELECT … WHERE EXISTS (cafe_owners)` pattern (`owner.js:366-376`), storing `firebase_uid` in `owner_sessions`.
- Logout (`ownerLogout`, `owner.js:454`) deletes the session row; unchanged.
- "Sign out everywhere" uses the existing `auth_version` bump (invalidates all sessions) — this is the Firebase equivalent of provider-session revocation, since Firebase has no per-session revoke primitive accessible from Workers without a service account. Do not attempt Firebase refresh-token revocation from the Worker.
- Provider revocation queue (`worker/revocations.js`, `provider_revocations` table) is WorkOS-specific and is **not** extended to Firebase. Document this as a deliberate scope limit.

**Tests:** session mint only with membership; expiry caps; logout invalidates; auth_version bump invalidates all.

## 11. Claim (invite) flow for Firebase cafés

- Reuse `owner_claims` table and `ownerClaimStart` shape, but the redemption path changes:
  - Operator issues a claim (digest stored, email pinned, single-use via `used_at` conditional UPDATE) — unchanged.
  - User receives the claim code in a link fragment (as today, `Admin.jsx:140`).
  - User signs in with Firebase (email/password + TOTP) on the client, obtains an ID token.
  - Client POSTs `{ idToken, claimCode }` to `POST /api/cafes/:slug/owner/claim/redeem` (new or generalized).
  - Worker verifies the token, checks `email_verified`, checks `firebase.sign_in_second_factor === "totp"`, compares the claim's pinned email with the token email (case-folded, as `owner.js:336-344`), consumes the claim atomically, grants membership, mints session.
- This removes the WorkOS redirect/OAuth dance for Firebase cafés while preserving the single-use, email-pinned, atomic claim semantics.

**Tests:** valid claim grants membership; wrong email denied; expired/used claim denied; concurrent redemption race.

## 12. Account recovery and rollback

- **Rollback:** an operator moves the café back to `owner_auth = 'local'` via the existing atomic transition. Precondition: the café must have a `pass_hash` set. If none exists, the operator must set a local password first (reuse existing password-set flow). All Firebase sessions are deleted by the transition (S6).
- **Password reset for local mode:** unchanged.
- **Firebase account recovery** (forgot password, MFA reset) is owned by Firebase's client flows and console; the Worker does not implement recovery. Document that operators handle Firebase-side recovery via the Firebase console; D1 membership is unaffected.
- **Lost MFA:** handled in Firebase console (remove factor / reset). The Worker's required-mode rejection (`mfa-assurance-unavailable`) is the enforcement point; recovery does not require a Worker change.
- **Roll-forward:** once Firebase is proven stable for a café, the operator may delete the local `pass_hash` (optional, later stage) to remove the rollback path. Not recommended until evidence is captured.

## 13. Error handling and rate limiting

- Reuse `worker` rate-limiting (`rate_limits` table, `checkApiRateLimit` in `api.js:175`).
- Add rate-limit keys for:
  - `owner:firebase:exchange:<ip-or-uid>` (token exchange)
  - `owner:firebase:claim:<ip>` (claim redemption)
  - `owner:firebase:verify-fail:<ip>` (failed verification attempts, to slow brute force)
- Generic denial messages for all auth failures (reuse `GENERIC_DENIED`, `owner.js:45`); never echo the Firebase error, token, or claim values to the client.
- Server-side logging records reason codes (`email-unverified`, `mfa-assurance-unavailable`, `mfa-method-not-allowed`, `membership-missing`, `claim-mismatch`, `token-invalid`) but never the token, the user's phone number, or PII beyond a hashed UID.
- Failed verification must not create sessions, membership rows, or audit rows beyond a rate-limit counter.

## 14. Security and privacy considerations

- **Only cryptographically verified tokens count.** Verification uses the JWKS signature, not the Admin SDK, not the request body, not a client-supplied claim.
- **MFA assurance:** `firebase.sign_in_second_factor === "totp"` is the only acceptable value for required mode. `phone` and absent are rejected. This is enforced server-side and cannot be bypassed by client code.
- **No SMS in production policy.** Even if a Firebase account has a phone factor and completes phone MFA (token carries `phone`), the Worker rejects it. SMS MFA additionally requires Blaze (billing) and is not available on Spark.
- **Identity is the UID, not the email.** Email is a cache and a matching key for claims; authorization uses `firebase_uid`.
- **Email verification is required** both client-side (UX) and server-side (token claim).
- **Secrets:** no Firebase service account or Admin SDK key is required or stored. Only `FIREBASE_PROJECT_ID` (public) and optionally `FIREBASE_AUTH_DOMAIN` (public) are added. The Firebase Web API key is public and domain-restricted in the console; it is not a secret and must not be treated as one, but it must not be logged.
- **Token hygiene:** the raw ID token is transmitted once over HTTPS in the exchange request body, verified, and discarded. It is never logged, stored in D1, placed in a cookie, or written to a file. Refresh tokens are never requested or stored by the Worker.
- **CSRF:** the exchange endpoint is a POST that mints a session; it must be CSRF-protected. Because the caller has no session yet, use a double-submit or Origin check consistent with `worker/session.js`'s strict `Origin` equality, plus the existing rate limits. Do not rely on the Firebase token alone as CSRF protection.
- **Multi-tenancy:** `firebase_uid` membership is per-café; a token valid for one café's owner is not automatically valid for another. The exchange endpoint is scoped to `:slug` and checks membership for that café.
- **Privacy:** do not store the user's phone number, TOTP secret, or authenticator details. Store only UID, email (cache), and timestamps.
- **Rollback safety:** switching a café to `local` deletes all sessions and sign-in states via the existing atomic batch; no Firebase data is deleted, so switching back is possible.

## 15. Proposed source changes (exact paths)

| File | Change | Why | Dependencies | Tests | Risks |
|---|---|---|---|---|---|
| `package.json` | Add `firebase` (modular, ≥9.19.1) | Client SDK for email/password, verification, TOTP, MFA resolver | npm/bun install (authorized later) | Build passes | Version drift; bundle size |
| `src/lib/firebase.js` (new) | Initialize app from public config; export `auth` | Single initialization point | `package.json` | Unit/smoke | Double init if imported twice |
| `src/pages/Admin.jsx` | Add `ownerAuth === "firebase"` branch rendering Firebase sign-in component | Route Firebase cafés to new flow | `src/lib/firebase.js` | Component tests | Must not regress local/WorkOS branches |
| `src/pages/OwnerFirebaseSignIn.jsx` (new) | Email/password, verification gate, enrolment, MFA resolution, token exchange | Implements §3–§6 | Firebase SDK, `api()` | Component tests | Client-side bypass possible; Worker enforces |
| `worker/api.js` | Add `POST .../owner/firebase/exchange` and claim redeem route; update `/api/config` to return `firebaseConfig` for Firebase cafés; update managed-mode guards | Expose new endpoints and config | `worker/firebase.js`, `worker/owner.js` | Route tests | Route enumeration; CSRF |
| `worker/firebase.js` (new) | `verifyFirebaseIdToken()`; JWKS fetch/cache | Core verification | `worker/jwt.js`, Web Crypto | Token fixture tests | CPU, cache staleness |
| `worker/owner.js` | Generalize `managedOnly` → `ownerProvider`/`isManaged`; add `ownerFirebaseExchange`, `ownerClaimRedeemFirebase`; reuse membership/session/claim patterns | Identity step for Firebase | `worker/firebase.js`, `worker/db.js` | owner.signin tests | Regress WorkOS/local paths |
| `worker/authmode.js` | Add `"firebase"` to `AUTH_MODES` | Allow mode selection | None | authmode tests | Transition precondition S2 |
| `worker/db.js` | Additive migrations for `auth_provider`, `firebase_uid` columns and indexes | Provider-neutral identity | D1 | Migration tests | Schema drift |
| `worker/session.js` | No change expected | Reuse sessions/CSRF | — | Existing tests | None |
| `worker/jwt.js` | Possibly generalize UID regex or add Firebase-specific validator | Firebase UID charset | None | JWT tests | Over-broad regex |
| `worker/config` (wherever `/api/config` is built) | Return `firebaseConfig` when `owner_auth === "firebase"` | Client needs public config | None | Config tests | Leak config to non-Firebase cafés |
| `tests/fixtures/firebase.mjs` (new) | Fixture-only Firebase-shaped token minter | Contract tests without real keys | crypto | Fixture tests | Must be labelled fixture-only |
| `tests/firebase.jwt.test.mjs` (new) | Verification unit tests | §7 | fixture | — | Fixture ≠ real token |
| `tests/owner.firebase.signin.test.mjs` (new) | Exchange/claim/membership/session tests | §8–§11 | fixture + D1 test harness | — | Harness availability |
| `docs/*` (`OPERATIONAL_READINESS.md`, `SECURITY_DEPLOYMENT_CHECKLIST.md`, `STAGING_READINESS_CHECKLIST.md`, `ZERO_BUDGET_AUTH_FEASIBILITY.md`) | Add Firebase vars, MFA mode, JWKS URL, TOTP policy | Operational readiness | None | Doc review | Drift |

## 16. Architectural conflicts with existing WorkOS/local code

1. **Mode enum:** `AUTH_MODES` is frozen to `["local", "workos"]` (`authmode.js:13`) and validated by `requireMode`. Adding `firebase` is a one-line change but every consumer that switches on the mode must be audited (search `=== "workos"`).
2. **`managedOnly()` is WorkOS-specific** (`owner.js:93`: `cafe.owner_auth === "workos"`). It is used as a guard in `ownerStart`, `ownerClaimStart`, `ownerCallback`. Generalize carefully; a café in `firebase` mode must not fall through to the WorkOS redirect.
3. **Identity column name `workos_user_id`** is used as the PK of `owner_identities` and FK-ish key in `cafe_owners`/`owner_sessions`. Firebase support requires either new columns (recommended) or a rename. Queries must not assume one column is populated for all managed cafés.
4. **WorkOS-specific tables** (`owner_login_states` with PKCE verifier, `provider_revocations`) are not needed for Firebase. Do not extend them; keep them WorkOS-only. `owner_claims` is reusable.
5. **WorkOS exchange is OAuth code exchange** (`workos.js:exchangeCode`); Firebase exchange is ID-token verification. Do not conflate the two endpoints or reuse `exchangeCode` for Firebase tokens.
6. **Email verification source:** WorkOS uses the exchange body's `user.emailVerified`; Firebase uses the verified JWT claim. Both must be enforced, but the Firebase path must not read email verification from the request body.
7. **`email` matching for claims** (`owner.js:336-344`) compares the provider email with the claim email. For Firebase, compare the verified token's `email` (not a body field).
8. **Provider revocation:** WorkOS has a durable queue; Firebase has none accessible from Workers. Rely on session deletion + `auth_version` bump. Document this asymmetry.
9. **Operator mode switch precondition** (managed café must have ≥1 owner) still applies; an operator cannot switch a café to `firebase` before at least one Firebase identity has been granted membership (e.g. via a claim).
10. **Local password rollback** requires `pass_hash`. A café migrated to Firebase without ever having a local password cannot roll back without first setting one.

## 17. Recommendation and remaining blockers

**CONDITIONAL GO.** The architecture is sound, reuses the existing session/CSRF/membership/mode-switch machinery, and keeps D1 as the authorization source of truth. Implementation should proceed only after all blockers below are cleared.

**Blockers (must be resolved before implementation):**
1. **No real Firebase ID-token fixture captured.** Per the C-01/10B gating rule, a real, signature-verified Firebase ID token must be captured into a protected ephemeral location and used as the contract fixture before the verifier is finalized. Only claim names/types may be recorded; the token string must not be retained. (Status: not done.)
2. **TOTP enrolment not proven on the disposable test account.** It is unknown whether the account has a TOTP factor enrolled or only phone. Without a TOTP-enrolled account there is no way to obtain a token with `sign_in_second_factor === "totp"`. (Status: not done.)
3. **The missing-OTP observation is undiagnosed.** Need evidence of the client sign-in path and the resulting token's `firebase.sign_in_second_factor` value (or absence). (Status: not done.)
4. **No client flow or verifier exists in the repo.** The test procedure in `FIREBASE_MFA_EVIDENCE.md` §3.1 cannot be executed until a temporary client and redacting verifier are added in an authorized implementation stage. (Status: not done.)
5. **Unmeasured Workers CPU cost** of Firebase verification (signature + JWKS fetch + claim validation) on the Free plan. Must be measured with a real token before committing to the Free tier.
6. **Product decision pending:** whether `firebase` is a third `owner_auth` value (recommended) or replaces WorkOS entirely. This affects migration and rollback scope.
7. **Email verification state of the test account** is unknown.

**Non-blocking but required before production:**
- Firebase project config values (`FIREBASE_PROJECT_ID`, `FIREBASE_AUTH_DOMAIN`) recorded and restricted by domain in the console.
- TOTP policy documented; SMS explicitly excluded from the long-term owner MFA policy.
- Operator runbook for Firebase-side account recovery (password reset, MFA reset) without Worker changes.
- Fixture-only tests clearly labelled as such until a real fixture is captured.

This document is a plan only. No implementation, package installation, Firebase configuration change, secret, D1 write, migration, deployment, or Git mutation was performed. Existing modified and untracked work is preserved.
