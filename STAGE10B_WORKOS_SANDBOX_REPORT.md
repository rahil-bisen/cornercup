# STAGE10B — WorkOS Sandbox Contract Verification Report

**Date:** 2026-11-16 · **Source audit:** `STAGE10A_AUTH_AUDIT.md` · **Plan:** `STAGE10A1_AUTH_REMEDIATION_PLAN.md` · **Mode:** sandbox verification only — no staging activation, no production changes, no source/test modifications, no deployments, no secrets handled.

**Repository state at verification time:** branch `freebuff/qr-code-cafe-ordering-website` @ `023befe`, deployed staging Worker `corner-cup-staging` @ `80f92ceb-b443-4824-a147-1856310e9a52`. Staging café remains `local` with `pass_hash IS NULL` (unchanged).

Labels used: **[verified]** read in source/tests · **[documented]** stated by WorkOS documentation (cited inline) · **[observed]** measured against a real sandbox in this stage (none this stage) · **[fixture]** deterministic local fixture only · **[assumption]** reasoned, unmeasured.

---

## 1. Sandbox environment identity (non-secret)

**Result: no WorkOS sandbox environment is configured for this project.**

Evidence:
- `.dev.vars` exists but contains only local keys: `ADMIN_PIN`, `ADMIN_SECRET`, `CAFE_NAME`, `CAFE_TZ_OFFSET_MIN`, `OPERATOR_PASSWORD`, `OWNER_PASSWORD`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `SERVICE_MODE`. **No `WORKOS_*` variable is present.**
- No `.dev.vars` template beyond `.dev.vars.example`, which contains no WorkOS entries.
- `wrangler.jsonc`, `wrangler.staging.jsonc`, and `wrangler.staging-maint.jsonc` contain no `WORKOS_*` `vars` and no WorkOS secret bindings.
- No WorkOS client id, redirect URI, issuer, API key, state-encryption key, or sandbox application was found anywhere in the workspace (searched source, tests, harness, docs, and config).
- `OPERATIONAL_READINESS.md` §3 lists the six required `WORKOS_*` values as not yet configured; `STAGING_READINESS_CHECKLIST.md` §6 lists WorkOS sandbox requirements as outstanding.

**Consequence:** Every live verification item in §2–§5 below is **blocked**. No authentication flow was started, no token was captured, no D1 write occurred, and no provider call was made. Per the Stage 10B authorization, when sandbox credentials or dashboard access are missing the correct action is to stop and report precisely what must be provided — which this report does in §13. No production or staging credentials were substituted and no sandbox configuration was invented.

---

## 2. Actual token contract

**Observed (live):** none — no sandbox token was captured.

**Documented (AuthKit/User Management session access token):** https://workos.com/docs/reference/authkit/session-tokens/access-token

| Claim | Documented presence | Notes |
|---|---|---|
| `iss` | present | `api.workos.com` (bare origin, no trailing slash) in the documented example; custom auth domain moves it. Other environments have been observed minting `api.workos.com/user_management/<client_id>`. **Exact value must be pinned from a real token.** |
| `sub` | present | `user_…` format. |
| `client_id` | present | issuing application client id. |
| `org_id` | present (when an org is selected) | |
| `role` / `roles` | present | |
| `permissions` / `entitlements` / `feature_flags` | present | |
| `sid` | present | `session_…` format in the documented example. |
| `jti` | present | |
| `exp`, `iat` | present | |
| `act` | optional | impersonation only. |
| `auth_time` | present (newer) | Unix timestamp, seconds, of last active authentication. Freshness only. |
| `aud` | **absent by default** | AuthKit session tokens do not carry `aud` unless a JWT template adds it. |
| `email` / `email_verified` | **absent by default** | Not in the documented claim list; email lives in the exchange response. |
| `amr` / `acr` / MFA indicator | **absent** | Not in the documented claim list. |

**Documented (WorkOS Connect access token, different family):** https://workos.com/docs/authkit/connect/token-claims — `iss` = AuthKit domain, `aud` = resource/environment client id, `client_id` = requesting app, `sub` = user, `sid` = consent id, `scope`, `jti`, `exp`, `iat`. These **do** carry `aud`. The board flow uses the session family, not Connect.

**Fixture (local only, not provider evidence):** `tests/fixtures/workos.mjs` mints `iss = https://api.workos.com/user_management/<client_id>`, `aud = client_id`, `sub`, `sid`, `iat`, `exp`, `email`, with `alg RS256`, `kid test-kid-1`. This is the app's own assumption, not the vendor's contract.

---

## 3. Issuer and JWKS evidence

**Observed (live):** none.

**Documented:**
- Issuer is pinned per environment; WorkOS has used both the bare origin (`api.workos.com`) and `api.workos.com/user_management/<client_id>`. The configured string must equal the minted value byte-for-byte. (https://workos.com/docs/reference/authkit/session-tokens/access-token; WorkOS node SDK notes issuer validation is opt-in because the shape varies by environment.)
- JWKS URL: `https://<auth-domain>/sso/jwks/<client_id>` (per-client; cannot be derived from issuer alone). `workos.userManagement.getJwksUrl(clientId)`. (https://workos.com/docs/reference/authkit/session-tokens; https://workos.com/blog/verify-workos-access-tokens-in-your-own-api)
- Signing algorithm: RS256. JWKS keys are RSA (`kty: RSA`, `n`, `e`).
- Key rotation: an unknown `kid` forces one JWKS refetch (app code); TTL cache 10 minutes per isolate (app code). Provider-side rotation cadence unverified.

**Current code (`worker/workos.js`):** fetches `${base}/sso/jwks/${encodeURIComponent(clientId)}`; `workosConfig` defaults `audience` to `clientId` when `WORKOS_AUDIENCE` is unset. `missingConfig` requires `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_ISSUER`, and `WORKOS_STATE_ENCRYPTION_KEY` (≥ 32 chars).

---

## 4. JWT claim inventory

**Observed (live):** none. All entries below are documented or fixture-only.

**Documented claims for session tokens:** `iss`, `sub`, `client_id`, `org_id`, `role`, `roles`, `permissions`, `entitlements`, `feature_flags`, `sid`, `jti`, `exp`, `iat`, `act` (optional), `auth_time` (newer). No `aud`, no `email`, no `email_verified`, no `amr`/`acr` by default.

**Fixture-only claims (`tests/fixtures/workos.mjs`):** `iss` (fixture issuer), `aud` (= client id), `sub`, `sid`, `iat`, `exp`, `email`. The fixture includes `aud` and `email`, which the documented session-token contract does **not** include by default. This is the core of C-01 and remains unresolved without a sandbox fixture.

---

## 5. Actual login and callback results

**Observed (live):** none. No sandbox login was started.

**What the code would do against a real provider (from source, [verified]):**
- `GET /api/cafes/:slug/owner/start` → 302 to `authorizeUrl()` with `response_type=code`, `client_id`, `redirect_uri`, `state`, `code_challenge` (S256), `code_challenge_method=S256`, `scope=openid profile email`.
- State: 32 random bytes, only `sha256(state)` stored, 10-minute TTL, single-use via conditional `UPDATE … RETURNING`.
- PKCE verifier: 32 random bytes, AES-256-GCM encrypted with HKDF-derived key from `WORKOS_STATE_ENCRYPTION_KEY` (≥ 32 chars); no plaintext fallback.
- Callback: burns state, exchanges code once (5 s timeout, 64 KiB bound), verifies JWT (RS256, `kid` required, issuer exact, audience containment, exp/iat/nbf with 60 s skew, sub regex + expected subject), checks `user.email_verified === true`, checks claim email when present, checks `cafe_owners` membership, creates session only via `INSERT … SELECT … WHERE EXISTS`.
- Provider session id (`sid`) is optional: missing/malformed ⇒ `null`, never fabricated.

**Provider-side behaviors unverified:** whether `/authorize` accepts PKCE + scope as sent, whether the redirect URI must be registered exactly, code lifetime, error-callback shape, whether `email_verified` appears in the exchange response as the code expects, and whether the access token is a JWT at all.

---

## 6. Provider logout and revocation behavior

**Observed (live):** none.

**Documented:** WorkOS documented sign-out sequence is delete the app session then redirect the browser to the provider logout endpoint (https://workos.com/docs/authkit/sessions#signing-out). `POST /user_management/sessions/revoke` with `{session_id}` and `Authorization: Bearer <API key>`; 404 treated as "already gone" (app code assumes this; unverified).

**Code behavior (verified):**
- `revokeSession()` treats 200 and 404 as success; anything else fails and is retried.
- `logoutUrl()` builds `/user_management/sessions/logout?session_id=&return_to=` but is currently unused by the board (H1).
- Provider revocation jobs: 5 attempts, exponential backoff capped at 60 s, 24 h TTL, lease; drained opportunistically only (no cron trigger configured).

**Unverified:** revoke endpoint acceptance of `sid`, 404 semantics, logout redirect with `return_to` and custom domain, whether provider logout invalidates the session, behavior with missing/malformed `sid`.

---

## 7. MFA/TOTP evidence

**Observed (live):** none.

**Documented (https://workos.com/docs/authkit/mfa):**
- MFA is an environment setting: Dashboard → Authentication → Features → Multi-factor auth → **Required**; TOTP via authenticator app; hosted AuthKit performs enrolment and challenge automatically.
- **The MFA requirement does not apply to SSO users.**
- Per-organization MFA policies exist for non-SSO members (https://workos.com/docs/authkit/organization-policies).

**Documented (https://workos.com/docs/authkit/reauthentication):**
- `auth_time` is a Unix timestamp of the user's most recent active authentication; advances only on real interactive sign-in, not refresh. Freshness signal only.
- `max_age` on `/user_management/authorize` forces re-authentication if last auth is older than the threshold; `max_age=0` always forces it.

**Code reality (verified):** no MFA, `amr`, or `acr` handling anywhere; authorize request sets no `max_age`/`prompt`/ACR; verifier inspects no assurance claim. Email verification comes from the exchange body, not the JWT.

**Unverified:** whether Required MFA gates the hosted flow before a code is issued; TOTP enrolment/challenge UX; which (if any) token claims change after MFA; whether any independently verifiable MFA assurance signal exists for SSO users (none documented).

---

## 8. SSO MFA limitations

**Documented:** WorkOS does not enforce or represent MFA for SSO users; their second factor, if any, is the IdP's responsibility and is not represented in AuthKit tokens. Environment-level Required MFA covers password/social users only.

**Policy decision left open (per Stage 10B scope):** Option A (disable owner SSO so environment MFA applies) vs. Option B (separately verifiable MFA assurance for SSO users, only if a pinned, JWKS-verifiable claim or app-level second factor is available). Option C (assume IdP enforces MFA with no verifiable signal) is not acceptable as a final state. This stage reports evidence only and does not change the decision.

---

## 9. Tests passed and failed

All tests below are **fixture-only** (deterministic local provider + RSA keypair + SQLite shim). They prove the app's logic against its own assumptions, not the vendor's contract.

Run in this stage:
- `tests/workos.jwt.test.mjs` + `tests/owner.signin.test.mjs` + `tests/owner.revocation.test.mjs`: **34 tests, 0 failures** (provider-contract matrix, callback/claim/membership, sign-out/revocation). Fixture issuer `https://api.workos.com/user_management/<client_id>`, fixture `aud = client_id`.

From the audit (not re-run here, cited): `session.revocation` 33, `auth-mode.*` 23, `operator.*` 29, `owner.revocation` 5, `migrations.owner-auth` 8, `argon2.passwords` 9, `settings.reauth` 8. Non-harness suite previously reported 375 tests, 0 failures (21 failures were live-harness `ECONNREFUSED` only).

**No live provider tests were run.** Required live tests (real issuer/JWKS, real signing alg + key rotation, missing/malformed `sid`, `client_id` mismatch, missing/unexpected `aud`, expired token, invalid signature, wrong issuer, stale/missing `auth_time`, MFA enrolment/challenge, SSO MFA limitation, active and already-revoked sessions) cannot be executed without sandbox credentials.

---

## 10. Remaining assumptions and unresolved questions

1. Exact `iss` of a real AuthKit session token (bare origin vs. `user_management/<client_id>` vs. custom domain).
2. Whether `aud` is present at all in session tokens in this environment (documented as absent by default).
3. Whether `email`/`email_verified` appear in the JWT or only in the exchange response.
4. JWKS endpoint and rotation behavior for this client/environment.
5. `sid` presence, format, and revocation endpoint semantics.
6. Whether `/authorize` accepts the PKCE + scope parameters as sent; PKCE mandatory vs. optional.
7. Exchange request/response field names (`client_secret` vs. `api_key`) and `email_verified` location.
8. MFA enrolment/challenge behavior and any token claim that changes after MFA.
9. Whether any independently verifiable MFA assurance signal exists for SSO users (none documented).
10. Whether the issuer changes with a custom auth domain.
11. Provider session lifetime/idle policy and rate limits.

---

## 11. Whether the existing verifier is compatible

**Cannot be determined from this stage.** The verifier (`worker/jwt.js`) requires a present `aud` containing the configured value and pins `iss` to `WORKOS_ISSUER` exactly. The documented session-token contract carries no `aud` by default, so if the real token matches the documented contract, the verifier would reject every managed sign-in with `audience-missing`. This is the C-01 release blocker and remains open pending a real sandbox token fixture. No verifier change was made.

---

## 12. Whether the remediation plan needs revision

**No revision required from this stage's evidence** — the plan already assumes all of the above is unverified and gates C-01/H-02 on a sandbox fixture. The plan's "sandbox fixture first" gating step is confirmed as the correct next action. If the observed token turns out to differ from both documented shapes (e.g., an unexpected issuer or an `aud` present), the plan's audience-rule branch (§1.2 item 4) will need a small update, but that cannot be known until a fixture exists.

---

## 13. Exact prerequisites for Stage 10C

The user must provide/configure before any further WorkOS verification or implementation:

1. **A WorkOS sandbox application** (development environment, not production) with its:
   - `WORKOS_CLIENT_ID`
   - `WORKOS_API_KEY`
   - registered redirect URI exactly matching the callback path on the chosen origin (e.g. `http://127.0.0.1:<port>/api/owner/callback` for local, or the staging callback for staging)
2. **`WORKOS_STATE_ENCRYPTION_KEY`** (≥ 32 characters) — new, sandbox-only, never reused in production.
3. **`WORKOS_ISSUER`** placeholder to be pinned from the first real token (do not guess).
4. **`WORKOS_AUDIENCE`** decision: leave unset to default to `WORKOS_CLIENT_ID`, or set only after observing the real token.
5. **`WORKOS_API_BASE`** must remain unset unless a custom auth domain or sandbox base URL is deliberately used.
6. **A sandbox D1 database** (isolated; not the staging `corner-cup-staging` DB) if D1 identity/membership behavior is to be verified.
7. **A disposable sandbox test user** (password-authenticated) for the complete login/callback flow, and ideally a second user for membership-isolation checks.
8. **Dashboard access** to the sandbox WorkOS environment to configure MFA=Required and observe enrolment/challenge behavior, and optionally to configure SSO for the SSO-MFA limitation test (test only; do not enable SSO for owner auth as part of this stage).
9. **A secure ephemeral location** for capturing a real token during verification (memory or a protected scratch location), with the commitment that token strings and refresh tokens never reach reports, logs, source, Git, or ordinary temp files.

Until items 1–4 exist, managed sign-in remains "mocked locally only" and Stage 10C (implementation) must not begin. No staging authentication activation, staging/production D1 changes, Worker deployment, source/test modifications, secret changes, or Git operations were performed in this stage.
