# Stage 10C.1 — Firebase MFA Evidence Collection (READ-ONLY)

**Date:** 2026-11-16 · **Project (user-provided):** `corner-cup-auth` (Spark plan) · **Mode:** read-only. No source, test, config, or documentation files were modified; no packages installed; no Firebase settings or accounts changed; no secrets, tokens, passwords, phone numbers, or API keys were read or printed; no D1 writes, sessions, deployments, or Git mutations were performed. Existing modified/untracked work is preserved.

Labels: **[verified]** read directly in this repository's source/tests · **[documented]** stated by official Firebase/Google Cloud documentation (cited inline) · **[assumption]** reasoned, unmeasured · **[user-provided]** stated by the user.

---

## 1. Repository client flow

### 1.1 Confirmed: no Firebase sign-in implementation exists

- A repository-wide search for `firebase`, `Firebase`, `FIREBASE`, `signInWithEmailAndPassword`, `getMultiFactorResolver`, and `multi-factor-auth-required` returned **no matches in `src/`, `worker/`, `tests/`, `index.html`, or `package.json`**. The only occurrences of "firebase" are in the research reports `ZERO_BUDGET_AUTH_FEASIBILITY.md` and `STAGE10A_AUTH_AUDIT`-adjacent planning material. `package.json` lists no Firebase dependency.
- The existing owner client flow is `src/pages/Admin.jsx`: local mode renders a password form posting to `/api/admin/login`; managed (`ownerAuth === "workos"`) mode renders a "Continue to sign in" button that navigates to `/api/cafes/:slug/owner/start` (WorkOS redirect) plus an invite-claim form posting to `/api/cafes/:slug/owner/claim/start` (`Admin.jsx:147-180`, [verified]).
- There is no Firebase client SDK, no Firebase config object, no sign-in form, and no MFA resolution code anywhere in the frontend.

### 1.2 What would be required to implement email/password sign-in + MFA (Firebase Web SDK)

**[documented]** https://firebase.google.com/docs/auth/web/password-auth ; https://firebase.google.com/docs/auth/web/multi-factor ; https://firebase.google.com/docs/auth/web/totp-mfa

1. Add the Firebase JS SDK (modular, v9.19.1+ for TOTP MFA) as a dependency and initialize an app with the project's public config (`apiKey`, `authDomain`, `projectId`, `appId`). These values are public, not secrets.
2. Email/password sign-in entry point:
   ```js
   import { getAuth, signInWithEmailAndPassword } from "firebase/auth";
   const auth = getAuth();
   const cred = await signInWithEmailAndPassword(auth, email, password);
   const idToken = await cred.user.getIdToken();
   ```
3. MFA handling: `signInWithEmailAndPassword` does not throw a normal error when a second factor is required; it rejects with `auth/multi-factor-auth-required` and an error object carrying `resolver` (a `MultiFactorResolver`). The client must then:
   ```js
   import { getMultiFactorResolver, TotpMultiFactorGenerator } from "firebase/auth";
   const resolver = getMultiFactorResolver(auth, error);
   // resolver.hints lists enrolled factors (factorId, displayName, enrollmentId, ...).
   // For TOTP, generate a code in the authenticator app, then:
   const assertion = TotpMultiFactorGenerator.assertionForSignIn(
     resolver.hints[0].uid, totpCode
   );
   const cred = await resolver.resolveSignIn(assertion);
   const idToken = await cred.user.getIdToken();
   ```
   (`getMultiFactorResolver` is exported from `firebase/auth`.) The resolver's `hints` array identifies which factors are enrolled for this user; the client selects the TOTP hint (factorId `totp`) and completes `resolveSignIn`. Only after resolution does the user get an ID token with `firebase.sign_in_second_factor === "totp"`.
4. TOTP enrolment (one-time, before sign-in can be challenged): requires a verified email, then `multiFactor(user).getSession()` → `TotpMultiFactorGenerator.generateSecret()` → show QR/secret to the user → `TotpMultiFactorGenerator.assertionForEnrollment(secret, code)` → `multiFactor(user).enroll(assertion, displayName)`. Enrolment is a client-side flow using the Firebase SDK; the Worker is not involved.
5. After obtaining the ID token, POST it to a Worker exchange endpoint (new or replacing `ownerCallback`), which verifies it and mints the D1 session. The client must not use the Firebase token directly as the session; the Worker issues the Corner Cup session cookie.

**Note:** This is a description of the required implementation, not code added in this stage. No Firebase SDK is installed and no client code was changed.

### 1.3 How `auth/multi-factor-auth-required` and `getMultiFactorResolver()` fit

- `signInWithEmailAndPassword` resolves normally when no second factor is required (or none enrolled of a type the flow challenges). When a second factor *is* required, it rejects with `error.code === "auth/multi-factor-auth-required"`.
- The rejected error object contains `error.resolver` (a `MultiFactorResolver`) with:
  - `session` — the MFA session.
  - `hints` — array of `MultiFactorInfo` for enrolled factors (factorId, displayName, enrollmentId, phoneNumber for phone factors, etc.).
  - `resolveSignIn(assertion)` — completes sign-in given a factor assertion.
- `getMultiFactorResolver(auth, error)` is the documented way to obtain the resolver from the error if it is not already attached; it returns the same resolver. Either form is acceptable; using `getMultiFactorResolver` is the documented, stable entry point.
- The client then collects the TOTP code, builds `TotpMultiFactorGenerator.assertionForSignIn(...)`, calls `resolver.resolveSignIn(...)`, and only then obtains a credential whose ID token carries `firebase.sign_in_second_factor: "totp"`.
- If the client skips the resolver (e.g., treats the rejection as a generic failure, or only calls the first step), sign-in either fails or, if no factor is enrolled, completes with the first factor only — producing a token with no `sign_in_second_factor` claim. This is the most likely explanation for "enrolled but no OTP requested" (see §4).

---

## 2. Firebase token contract

### 2.1 Expected claims

**[documented]** https://firebase.google.com/docs/auth/admin/verify-id-tokens ; https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.decodedidtoken ; https://firebase.google.com/docs/reference/js/auth.idtokenresult

Top-level:
- `iss` = `securetoken.google.com/<projectId>`
- `aud` = Firebase project ID (same as in `iss`)
- `sub` = Firebase UID (non-empty, ≤ 128 chars); `user_id` is a legacy duplicate (prefer `sub`)
- `exp` = future (seconds since epoch); lifetime ~1 hour (`iat + 3600`)
- `iat` = past
- `auth_time` = past; when the user actually authenticated (not refresh)
- `email` (optional), `email_verified` (optional boolean)
- `phone_number` (optional), `name`/`picture` (optional)

Reserved `firebase` object:
- `firebase.sign_in_provider` — `password`, `google.com`, etc.
- `firebase.sign_in_second_factor` — `totp` / `phone` / **absent** (absent ⇒ no MFA proven in this session)
- `firebase.second_factor_identifier` — enrollment id of the factor used (audit)
- `firebase.identities` — map of providers to UIDs
- `firebase.tenant` — optional

### 2.2 Verification procedure (Cloudflare Worker, Web Crypto)

Reuse the existing primitive in `worker/jwt.js` (RS256, `kid` required, JWKS fetch/cache/refetch on unknown `kid` as in `worker/workos.js:fetchJwks`), with these substitutions and additions:

1. Pin `alg === "RS256"` before key import (already done in `jwt.js:verifySignature` path via `jwt.header.alg !== ALG`).
2. Require `kid` in header; select exactly one matching RSA key from the JWKS (`selectKey`).
3. Fetch JWKS from `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com` (JWK format; the Admin SDK's X.509 endpoint `.../robot/v1/metadata/x509/securetoken@system.gserviceaccount.com` is equivalent but PEM, not directly usable with `crypto.subtle.importKey("jwk", ...)`). Cache with TTL; refetch once on unknown `kid`.
4. Verify the RSA signature with RSASSA-PKCS1-v1_5 / SHA-256 (`verifySignature`).
5. Validate claims:
   - `iss === "securetoken.google.com/" + projectId`
   - `aud === projectId`
   - `exp` future (with bounded skew, e.g. 60 s, matching existing policy)
   - `iat` past (with skew)
   - `auth_time` present and past (with skew) — freshness only, not MFA proof
   - `sub` non-empty, ≤ 128 chars (regex `^[A-Za-z0-9...]{1,128}$` or Firebase's UID charset; the existing `^user_[A-Za-z0-9_-]{1,128}$` is WorkOS-specific and must be replaced with Firebase's UID rule)
   - `email_verified === true` before any membership action
6. Inspect MFA safely: read `payload.firebase?.sign_in_second_factor` from the *verified* payload only. Treat `totp` as the only acceptable value for owner MFA in production; `phone` is acceptable only as temporary testing; absent ⇒ no MFA proof ⇒ deny under `required` mode.
7. Never trust `sign_in_second_factor`, `email`, `email_verified`, `sub`, or `auth_time` from the request body or any unverified source — only from the verified JWT payload. This mirrors the M3 correction (email from token, not body) and the H2 assurance rule.

### 2.3 `phone` vs. `totp`

- `firebase.sign_in_second_factor === "phone"` means the session was completed with SMS/phone as the second factor. On Spark, SMS MFA is not available (requires Blaze + per-message billing), so this value should not appear for a Spark project's owners in production. It is useful only as temporary test evidence.
- `firebase.sign_in_second_factor === "totp"` means the session was completed with a time-based one-time password from an authenticator app. This is the intended long-term owner MFA method: no per-message cost, works on Spark, and is server-verifiable.
- Absent ⇒ first-factor-only session. Under `required` mode this is a denial (`mfa-assurance-unavailable`), not a session.

---

## 3. Test evidence

### 3.1 Safe procedure (no raw token retained)

1. **Do not** create or modify any project config, user, or D1 row. Use the existing disposable test account only for observation; do not change its password or factors.
2. In a local, throwaway client (a temporary HTML/JS file outside the repo, or a browser console snippet) initialized with the project's public Firebase config, call:
   - `signInWithEmailAndPassword(auth, email, password)`.
   - If it rejects with `auth/multi-factor-auth-required`, call `getMultiFactorResolver(auth, error)`, collect the TOTP code from the authenticator app, build `TotpMultiFactorGenerator.assertionForSignIn(...)`, and call `resolver.resolveSignIn(assertion)`.
   - On success, call `user.getIdToken()` to obtain the ID token **in memory only**.
3. Pass the token to a local verification script (run in Node or the Worker dev environment) that performs the §2.2 checks and prints **only** a redacted claim summary: `iss`, `aud`, `sub` (length only or a hash), `email`, `email_verified`, `auth_time`, `exp`, `iat`, and the value of `firebase.sign_in_second_factor` (or "absent"). **Never print, log, save, or transmit the raw token string, the refresh token, the API key, or the user's phone number.** Discard the token from memory after verification; do not write it to a file, Git, or any log.
4. Record the outcome in a report as claim names/types and presence only (e.g., "`firebase.sign_in_second_factor` = `totp`" or "absent"), never the token.
5. If the account has only a phone factor enrolled, the resolver's `hints` will contain a `phone` factor; completing it requires `PhoneMultiFactorGenerator` and an SMS code. This is acceptable for temporary evidence only; production must use TOTP.

### 3.2 Current status: test cannot yet be performed

- **There is no Firebase client app, test harness, or verification script in this repository.** Confirmed by the §1.1 search: no Firebase SDK, no sign-in code, no `getIdToken` call, no test utility for Firebase tokens. `tests/fixtures/workos.mjs` is the only token fixture and it mints WorkOS-shaped tokens.
- Therefore the evidence collection procedure in §3.1 cannot be executed from this repository as it stands. The test is **not yet performable** without first adding (in a later, authorized implementation stage) a temporary client and a redacting verifier. No such addition was made in this stage.
- What *is* established from documentation and repo inspection (see `FIREBASE_MFA_READINESS.md` and `ZERO_BUDGET_AUTH_FEASIBILITY.md`): the contract, the verification steps, the claim semantics, and the fail-closed enforcement rule. Only the live, account-specific evidence is missing.

---

## 4. Findings summary

1. **No Firebase implementation exists** in code, config, tests, or dependencies. Any Firebase integration is greenfield.
2. The existing auth architecture (mode-gated per café, D1 membership enforced in SQL, 12 h/24 h sessions, CSRF, invite claims, operator audit) can be reused; Firebase would replace only the identity step, mirroring the WorkOS flow but with a simpler ID-token exchange instead of an OAuth code exchange.
3. Firebase ID tokens are RS256 JWTs verifiable in Workers via Web Crypto using the Google JWKS endpoint, with issuer `securetoken.google.com/<projectId>` and audience = project ID. The existing `worker/jwt.js` primitive covers this.
4. MFA proof is `firebase.sign_in_second_factor === "totp"` inside the verified token. Enrolled factors and project-level MFA state do not constitute proof. `phone` is temporary-testing only; TOTP is the long-term owner method.
5. The "enrolled but no OTP" observation is consistent with (a) only a phone factor being enrolled while the flow expects TOTP, or (b) the client not invoking `getMultiFactorResolver`/`resolveSignIn`. It cannot be diagnosed without the evidence in §3.1; no claim that the account is broken or working is warranted.
6. The live test cannot be run today because no client flow or verifier exists in the repository.

---

## 5. Unresolved questions

1. Does the disposable test account have a TOTP factor enrolled, or only phone?
2. Does the attempted sign-in use a client path that handles `auth/multi-factor-auth-required` and calls `resolver.resolveSignIn`?
3. What is the value (or absence) of `firebase.sign_in_second_factor` in a verified ID token from that account?
4. Is the account's email verified?
5. What is the exact Firebase project ID, JWKS `kid` set, and `auth_time` format for `corner-cup-auth`?
6. Should `'firebase'` be added as a third `owner_auth` value or replace WorkOS entirely?

---

## 6. Recommended implementation sequence (for a later authorized stage)

1. Add Firebase Web SDK (modular) and a minimal sign-in component implementing §1.2, including TOTP enrolment and the `getMultiFactorResolver`/`resolveSignIn` flow.
2. Add a Worker exchange endpoint (reusing `worker/jwt.js`) that verifies the Firebase ID token, enforces `email_verified` and `sign_in_second_factor === "totp"` under required mode, checks/claims membership in D1, and mints the Corner Cup session. Generalize the identity column from `workos_user_id` to a provider-neutral key (additive migration).
3. Capture a real Firebase ID token into a protected ephemeral location and use it as the fixture contract before finalizing the verifier (C-01/10B gating rule).
4. Add fixture-only tests mirroring `tests/workos.jwt.test.mjs` / `tests/owner.signin.test.mjs` for Firebase-shaped tokens, clearly labelled fixture-only until a real fixture is captured.
5. Update docs (`OPERATIONAL_READINESS.md`, `SECURITY_DEPLOYMENT_CHECKLIST.md`, `STAGING_READINESS_CHECKLIST.md`) with Firebase variables and the new MFA mode; keep local Argon2id and WorkOS paths behind `owner_auth`.
6. Do not enable SMS MFA in production (requires Blaze/billing); treat phone factor only as temporary test evidence.

This stage was strictly read-only. No source, test, config, or documentation files were modified; no packages installed; no Firebase settings or accounts changed; no secrets or tokens printed; no D1 writes, sessions, deployments, or Git mutations performed. Existing modified and untracked work is preserved. The live test described in §3.1 is not yet performable because no client flow or verifier exists in the repository.
