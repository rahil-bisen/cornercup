# ZERO-BUDGET AUTHENTICATION FEASIBILITY — Firebase Authentication with Identity Platform

**Date:** 2026-11-16 · **Scope:** Corner Cup owner authentication only · **Budget constraint:** ₹0, no credit card, no billing instrument, no paid subscription, no unexpected charges. Guest ordering remains unauthenticated; operator authentication stays separate.
**Mode:** read-only research and source inspection. No Firebase project, billing change, source/test modification, secret change, D1 write, deployment, or Git operation was performed.

Labels: **[documented]** stated by official Firebase/Google Cloud documentation (cited inline) · **[verified]** read directly in this repository's source/tests · **[assumption]** reasoned, unmeasured · **[fixture]** deterministic local fixture only.

---

## 1. Executive summary / go-no-go

**Recommendation: GO — conditionally.** Firebase Authentication with Identity Platform on the no-cost Spark plan is the only candidate evaluated that (a) costs ₹0 with no billing instrument, (b) provides a server-verifiable MFA signal in the ID token, and (c) delivers password-reset/verification email without us running an email service. It fits the existing Cloudflare Workers Free + D1 architecture if Firebase is used strictly as an identity provider and D1 remains the source of truth for café membership and authorization.

Conditions that must hold before implementation:
1. A free Firebase project is created (no card required) and a real Firebase ID token is captured and used as the fixture before any verifier is finalized (mirror of the C-01 gating rule).
2. TOTP MFA is the only second factor used (SMS MFA is not available on Spark and is billed per message).
3. The 3,000 tier-1 DAU/day and 150 password-reset-emails/day Spark caps are accepted as hard availability limits.
4. The existing D1 session/membership machinery is reused; Firebase is not trusted for authorization, only for identity + email verification + MFA proof.

Compared with the two alternatives already in the codebase:
- **WorkOS (current managed path):** no MFA signal in tokens, provider contract unverified, and its free tier (1M users) is generous but MFA is the gap; managed rollout is blocked on sandbox.
- **Local Argon2id (current local path):** zero external dependency and zero cost, but no MFA at all and unverified CPU cost on the 10 ms Free plan (likely unusable there).

Firebase is the only option that closes the MFA gap at ₹0, at the cost of a Google account, a Firebase client SDK in the bundle, and hard daily caps.

---

## 2. Firebase Spark plan and Identity Platform instrumentless eligibility

**[documented]** https://firebase.google.com/docs/projects/billing/firebase-pricing-plans ; https://docs.cloud.google.com/identity-platform/docs/product-comparison

- The **Spark (no-cost) plan needs no payment information** to get started or to use no-cost Firebase products. It can be used in production for no-cost products.
- **Firebase Authentication with Identity Platform is an optional upgrade** that adds MFA, blocking functions, SAML/OIDC providers, multi-tenancy, etc. It does not require migration of existing client/admin SDK code.
- **"Firebase Authentication with Identity Platform and Identity Platform are paid services."** but **"Firebase Authentication with Identity Platform is available without a billing instrument up to daily limits."** (Google Cloud docs, product comparison).
- Upgrading to Identity Platform on Spark changes limits: **3,000 daily active users (DAU) for most sign-in providers** (tier 1), **2 DAU/day for SAML/OIDC** (tier 2). On Blaze, 50,000 MAUs free then per-MAU pricing.
- The upgrade does **not** require a credit card; instrumentless usage is supported up to the daily limits. Exceeding a limit shuts the feature off for the rest of the day rather than billing (hard cap, no silent overage on Spark).

**Implication for Corner Cup:** owner count is tiny (a handful of café owners), so 3,000 DAU/day is not a constraint. The hard-cap behavior is an availability risk only if abused; acceptable for ₹0.

---

## 3. TOTP MFA without a billing instrument

**[documented]** https://firebase.google.com/docs/auth/web/totp-mfa ; https://docs.cloud.google.com/identity-platform/docs/admin/enabling-totp-mfa ; https://firebase.google.com/docs/auth/?... (MFA feature table)

- TOTP MFA requires the **Identity Platform upgrade** (MFA is an Identity Platform feature; base Firebase Auth has no MFA). It is available on Spark with the instrumentless daily limits.
- TOTP uses an authenticator app (Google Authenticator, etc.) — **no SMS, no per-message cost**. This is the only MFA factor usable at ₹0. SMS MFA requires Blaze and is billed per SMS.
- Prerequisites: at least one MFA-capable provider (email/password qualifies; phone, anonymous, custom tokens, Apple Game Center do not), and **email verification must be enabled** (MFA requires a verified email to prevent lockout by an attacker who registered with someone else's address).
- Enabling TOTP is done via the Admin SDK or the project configuration REST endpoint (`totpOptions`); on Spark this is allowed without billing.
- Client SDK support: Web SDK v9.19.1+, Android 22.1.0+, iOS 10.12.0+.

**Conclusion:** TOTP MFA is available at ₹0 on Spark with the Identity Platform upgrade, subject to the 3,000 DAU/day cap. No card needed.

---

## 4. Exact free-tier limits (instrumentless / Spark)

**[documented]** https://firebase.google.com/docs/auth/limits ; https://docs.cloud.google.com/identity-platform/quotas ; https://firebase.google.com/pricing

| Limit | Instrumentless (Spark) | With billing instrument (Blaze) |
|---|---|---|
| Tier 1 DAUs (email/social/anonymous/custom) | 3,000 / day | 50,000 MAUs free, then per-MAU |
| Tier 2 DAUs (SAML/OIDC) | 2 / day | 50 free, then $0.015/MAU |
| Phone/SMS sign-in | not available | billed per SMS |
| SMS MFA | not available | billed per SMS |
| Address verification emails | 1,000 / day | 100,000 / day |
| Address change emails | 1,000 / day | 10,000 / day |
| Password reset emails | **150 / day** | 10,000 / day |
| Email link (passwordless) sign-in emails | **5 / day** | 25,000 / day |
| Account creation | 100 accounts / hour / IP | same |
| Account deletion | 10 / second | same |
| Tenants per project | **2** | unlimited |
| Identity providers per project/tenant | unlimited | unlimited |
| Registered user accounts | unlimited | unlimited |
| Anonymous user accounts | 100 million | 100 million |
| Address verification links | 10,000 / day | 1,000,000 / day |
| Password reset links | 1,500 / day | 100,000 / day |

**Corner Cup relevance:** owner count is tiny, so 150 password-reset emails/day and 1,000 verification emails/day are not a constraint. 3,000 DAU/day is irrelevant for owners but is a hard cap if the project is ever reused for guest accounts (it must not be — guest ordering stays unauthenticated). Tenants (2) is enough for a single café-group deployment; if multi-tenant per café is desired later, that requires billing.

---

## 5. Firebase ID-token contract

**[documented]** https://firebase.google.com/docs/auth/admin/verify-id-tokens ; https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.decodedidtoken ; https://jwtdev.com/use-cases/firebase-jwt-verification

| Field | Value / rule |
|---|---|
| `alg` (header) | `RS256` |
| `kid` (header) | must match one of Google's published keys |
| `iss` | `securetoken.google.com/<projectId>` |
| `aud` | Firebase project ID (same as in `iss`) |
| `sub` | Firebase UID (non-empty, ≤ 128 chars) |
| `exp` | future (seconds since epoch); token lifetime ~1 hour (`iat + 3600`) |
| `iat` | past |
| `auth_time` | past; when the user actually authenticated (not refresh) |
| `email` | optional; user's primary email |
| `email_verified` | optional boolean |
| `firebase.sign_in_provider` | e.g. `password`, `google.com` |
| `firebase.sign_in_second_factor` | `totp` / `phone` / absent (absent ⇒ no MFA proven) |
| `firebase.second_factor_identifier` | enrollment id of the factor used (audit) |
| `firebase.identities` | map of providers to UIDs |
| `firebase.tenant` | optional, if multi-tenancy used |

**JWKS / keys:**
- Official X.509 endpoint: `https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com` (PEM certs; used by Admin SDK).
- JWK endpoint (usable with `jose` / Web Crypto): `https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com`.
- Keys rotate; cache with TTL and refetch on unknown `kid` (same pattern as the existing `worker/jwt.js`).

**Verification in Cloudflare Workers (Web Crypto):** RS256 signature verification against the JWK set, plus the claim checks above, is the same primitive the repo already performs for WorkOS (`worker/jwt.js`: `alg` pinned to RS256, `kid` required, RSA key import, `verifySignature`, exp/iat/auth_time skew). A Firebase verifier would reuse that module almost verbatim, substituting issuer/audience/project-id constants and adding the `firebase.sign_in_second_factor === "totp"` check. No Node Admin SDK is available or needed in Workers.

**MFA representation:** `firebase.sign_in_second_factor === "totp"` is present only when the session was actually multi-factor authenticated, and it is inside the signed JWT, so it is tamper-evident. This is a stronger, server-verifiable signal than WorkOS provides (WorkOS tokens carry no MFA indicator). **[documented]** https://firebase.google.com/docs/reference/admin/node/firebase-admin.auth.decodedidtoken (firebase.sign_in_second_factor).

---

## 6. Token expiry, refresh, revocation, account disable

**[documented]** https://firebase.google.com/docs/auth/admin/manage-sessions ; https://firebase.google.com/docs/reference/rest/auth

- ID tokens are short-lived: **~1 hour** (`exp = iat + 3600`). Refresh tokens are long-lived and exchanged at `securetoken.googleapis.com/v1/token` for a new ID token.
- Refresh tokens expire only on: user deletion, user disable, or a major account change (password/email update).
- `revokeRefreshTokens(uid)` updates `tokensValidAfterTime`; new ID tokens can no longer be minted, but **existing ID tokens remain valid until their natural expiry (up to 1 hour)**. Revocation detection requires `checkRevoked=true` on verify (an extra backend read).
- Disabling a user prevents new ID tokens but does not invalidate an already-issued ID token before its expiry.
- No way to invalidate an ID token before expiry except keeping a revocation list and checking it per request.

**Implication for Corner Cup:** if we verify Firebase ID tokens statelessly per request, membership revocation leaves up to ~1 hour of access. To keep the existing strong revocation semantics (immediate refusal), we should **not** rely on Firebase tokens as the session; instead, exchange a verified Firebase ID token once for a D1-backed Corner Cup session (reuse `owner_sessions`, `auth_version`, CSRF), exactly as the WorkOS flow does. Firebase then becomes just the identity/MFA/email step; D1 remains authoritative for session lifetime and revocation. This preserves the 12 h idle / 24 h absolute caps and immediate revoke behavior.

---

## 7. Multi-café membership integration with D1

**[verified]** `worker/db.js` SCHEMA/MIGRATIONS; `worker/owner.js`; `STAGE10A_AUTH_AUDIT.md` §1.4, §2.6.

- Existing tables: `cafe_owners (cafe_id, workos_user_id)` PK, `owner_identities (workos_user_id, email, created, last_seen)`, `owner_sessions`, `owner_claims`, `owner_login_states`, `provider_revocations`.
- Membership is enforced inside SQL (`INSERT … SELECT … WHERE EXISTS (cafe_owners)`), not in JS — this must be preserved.
- Firebase provides a stable `uid` and a verified email. The cleanest integration is to generalize the identity column from `workos_user_id` to a provider-neutral `external_user_id` (or add `auth_provider`), keyed by `firebase:<uid>`. Because no managed café exists yet in staging/production, this migration has no live data to convert; migration risk is low. (No migration is performed in this stage.)
- `owner_claims` (invite codes) can be reused: redeem a claim by matching the Firebase user's verified email, granting membership to `firebase:<uid>`, exactly as the current claim flow does for WorkOS users.
- Guest ordering is unaffected: it never touches auth tables.

---

## 8. Account claiming and protection against unauthorized membership

**[verified]** `worker/owner.js` claim redemption batch; `STAGE10A_AUTH_AUDIT.md` §2.7.

- Claim codes are 24 random bytes, only `sha256("claim:" + code)` stored, 5 min–7 day TTL, single-use.
- Redemption is one atomic batch: consume claim (conditional on `used_at IS NULL` and `expires > now`), insert membership `SELECT … FROM owner_claims WHERE claim_hash = ? AND redeem_token = ?`, audit, upsert identity, insert session with `WHERE EXISTS` on membership. A failed step rolls back.
- For Firebase, the same flow applies with two added checks: Firebase ID token verified (signature/issuer/audience/exp/iat/auth_time/sub), and `email_verified === true`; claim email must match the token's email (case-folded). These are the same gates as today, with email sourced from the verified token instead of the exchange body (which also addresses audit finding M3).
- Rate limiting on claim/start (existing 10 attempts / 10 min) is retained.

---

## 9. Reusing the existing WorkOS session and membership architecture

**Recommendation:** reuse it. Firebase replaces only the identity step; everything else stays.

Reusable as-is:
- D1 session rows (`owner_sessions`), 12 h idle / 24 h absolute caps enforced in the `WHERE` clause.
- `auth_version` epoch for "sign out everywhere" and password reset.
- CSRF (strict Origin + token hash bound to session).
- Per-café cookie names (`staff_session_<slug>`).
- Claim/invite flow, membership SQL enforcement, operator audit.
- Rate limiting, lockout, generic denial messages.

Replaced / removed:
- `worker/workos.js` (authorize URL, code exchange, JWKS fetch for WorkOS) → replaced by Firebase JWKS fetch + ID-token verification.
- `worker/pkce.js` state encryption → no longer needed for a redirect flow if the frontend signs in directly with the Firebase SDK and POSTs the ID token; but a state/CSRF binding is still needed for the POST exchange. The existing PKCE/state machinery can be simplified to a CSRF token, or kept if a redirect-based flow is preferred.
- `worker/owner.js` callback → becomes an ID-token exchange endpoint (`POST /owner/exchange` or reuse callback path) that verifies the Firebase ID token, checks email_verified + claim/membership, and mints the D1 session.
- Provider revocation jobs (`provider_revocations`) → Firebase has no per-session revoke endpoint usable without the Admin SDK; D1 session deletion is the revocation. `revokeRefreshTokens` via Admin SDK is optional and would require a service account (secret) — skip for ₹0; D1 authority is sufficient.

---

## 10. Compatibility with the 10 ms Cloudflare Workers Free CPU limit

**[verified]** `worker/jwt.js` already performs RS256 verification in workerd (used by the existing test harness). **[assumption]** Firebase ID-token verification is the same primitive (RS256 + JWKS fetch + claim checks), so it is expected to fit the same budget. The JWKS fetch is cached per isolate (10 min TTL, refetch on unknown `kid`), so the steady-state cost is one RSA verify per request plus a cheap D1 session lookup — the same shape as today. No WASM or heavy crypto beyond Web Crypto is needed. Argon2id (local auth) is the one path with an unverified/unlikely CPU budget; Firebase avoids it entirely for managed cafés.

---

## 11. Security risks specific to Firebase

1. **Bearer ID token leakage:** ID tokens are valid ~1 hour. Mitigation: only transmit over HTTPS (Cloudflare provides), never log, never store in localStorage (use in-memory / httpOnly cookie flow), and rely on D1 sessions (not raw Firebase tokens) for ongoing authorization.
2. **No per-request revocation of ID tokens:** mitigated by exchanging for a D1 session and enforcing D1 revocation immediately.
3. **Email enumeration / account probing:** Firebase has optional email-enumeration protection; enable it. Account creation is rate-limited (100/hour/IP).
4. **MFA bypass via token without `sign_in_second_factor`:** fail-closed — require `firebase.sign_in_second_factor === "totp"` when `WORKOS_MFA_MODE`-equivalent is `required`; treat absent as denial.
5. **Unverified email:** require `email_verified === true` before any membership action (same as today).
6. **Project ID is public:** issuer/audience are derived from the public project ID; this is by design and not a secret. No client secret is required for ID-token verification, which reduces secret sprawl.
7. **Hard caps / availability:** exceeding Spark limits shuts the feature off for the day (no charge). For an owner-only flow this is a low-probability, low-impact risk, but it is real if the project is misused (e.g., guest accounts accidentally created in Firebase).
8. **Dependency on Google:** Firebase is a third-party IdP; a Google account and project are required, and policy/limit changes are outside our control. Acceptable for ₹0.
9. **Firebase client SDK in the bundle:** adds bundle size and a new dependency; must be pinned and reviewed.

---

## 12. Recommended architecture

1. **Identity provider:** Firebase Auth + Identity Platform (Spark, no billing). Email/password provider with TOTP MFA enabled; email verification required.
2. **Frontend:** Firebase Web SDK (modular, v9.19.1+) for sign-in and TOTP enrollment/challenge. After sign-in, obtain ID token and POST it to the Worker.
3. **Worker (Cloudflare):** new `worker/firebase.js` verifying the ID token against Google's JWKS (reuse `worker/jwt.js` primitives), extracting `uid`, `email`, `email_verified`, `firebase.sign_in_second_factor`. A new exchange endpoint replaces `ownerCallback`'s WorkOS exchange: verify token → check email_verified → check/claim membership → mint D1 session → set cookie. Missing config ⇒ 503 (fail-closed), same as today.
4. **Authorization:** unchanged — D1 `cafe_owners` enforced inside SQL; `auth_version` epoch; 12 h/24 h session caps; CSRF.
5. **Logout:** delete D1 session + CSRF rows; clear cookie; call Firebase client `signOut()` on the board. No provider revocation call needed.
6. **MFA policy:** `FIREBASE_MFA_MODE = required | provider-only` (mirroring the planned `WORKOS_MFA_MODE`), requiring `firebase.sign_in_second_factor === "totp"` under `required`. Unestablishable assurance ⇒ deny, reason-coded log, no session.
7. **Operator auth:** unchanged (shared password + `ADMIN_SECRET`), per existing plan (P3-05). Firebase is not used for operator auth.
8. **Guest ordering:** unchanged, unauthenticated.
9. **Feature flag:** keep local Argon2id and (optionally) WorkOS paths behind `owner_auth` per café, so Firebase is rolled out per café without a flag day. Add `'firebase'` as a third `owner_auth` value, or replace WorkOS entirely once Firebase is verified.

---

## 13. Estimated implementation work

Roughly comparable to the planned 10C WorkOS implementation, but simpler on the identity side (no PKCE/state redirect, no code exchange, public JWKS):

- `worker/firebase.js` (config, JWKS fetch, missingConfig): small.
- `worker/jwt.js`: reuse; add Firebase-specific claim checks (issuer/audience/project id, auth_time, sub length, `firebase.sign_in_second_factor`).
- `worker/owner.js`: replace exchange + callback with ID-token exchange; keep membership/claim/session SQL.
- `worker/db.js`: generalize identity column (`workos_user_id` → provider-neutral) via an additive migration; keep backward compat.
- Frontend: Firebase SDK integration, sign-in + TOTP enrollment/challenge UI; bundle size review.
- Tests: Firebase-shaped token fixtures (RS256, Google JWKS) and the full callback/claim/MFA matrix; label fixture-only vs. real-provider.
- Docs: update `OPERATIONAL_READINESS.md`, `SECURITY_DEPLOYMENT_CHECKLIST.md`, `STAGING_READINESS_CHECKLIST.md` with Firebase variables (`FIREBASE_PROJECT_ID`, and the public config) and the new MFA mode.

Estimated: medium complexity, comparable to or slightly less than the WorkOS 10C plan, with lower secret-management burden (no API key or state-encryption key needed for ID-token verification).

---

## 14. Unresolved questions

1. Whether TOTP MFA on Spark is subject to any undocumented daily cap beyond the 3,000 DAU limit (must be confirmed against a real project; no billing, so worst case is a hard stop, not a charge).
2. Exact Firebase ID-token `kid` rotation cadence and JWKS cache behavior in practice.
3. Whether Firebase email verification and password-reset emails are deliverable to the owner's mail provider without spam issues (domain reputation, custom SMTP not available on Spark).
4. Whether the Firebase Web SDK's bundle size impact is acceptable for the Vite build.
5. Whether `checkRevoked` (revocation detection) is needed given D1 sessions are authoritative; if used, it adds a backend read per request.
6. Whether a Firebase project can be created and used with no Google Cloud billing account at all in this region (documented as yes, but must be verified by creating one — not done in this stage).
7. Whether to keep WorkOS as a fallback or remove it; decision affects migration risk.

---

## 15. Explicit go/no-go recommendation

**GO — conditional.** Firebase Authentication with Identity Platform on Spark satisfies the ₹0 constraint (no card, no billing instrument), provides server-verifiable TOTP MFA via `firebase.sign_in_second_factor`, delivers verification and password-reset email within adequate free quotas for a small owner base, and verifies with the same Web Crypto primitives already in the repo. It is a better fit than WorkOS for the MFA requirement and cheaper/less CPU-risky than local Argon2id for managed cafés.

Conditions (all must be met before implementation begins):
- A free Firebase project is created and a real Firebase ID token is captured as the fixture (no verifier finalized without it).
- TOTP MFA only; SMS MFA explicitly out of scope (requires Blaze + billing).
- Spark hard caps accepted and documented; guest accounts never created in Firebase.
- D1 remains the source of truth for membership, sessions, and revocation; Firebase is identity + email verification + MFA proof only.
- No billing instrument is added at any point; if a future feature requires Blaze, that is a separate, explicitly authorized decision.

No implementation, Firebase project creation, billing change, source/test modification, secret change, D1 write, deployment, or Git operation was performed in this stage.
