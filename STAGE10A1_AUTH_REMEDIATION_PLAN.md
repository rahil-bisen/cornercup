# STAGE10A.1 — Owner Authentication Remediation Plan

**Date:** 2026-11-16 · **Source audit:** `STAGE10A_AUTH_AUDIT.md` · **Status:** planning only — no code, tests, schema, secrets, provider settings or deployments were changed
**Repository state at planning time:** branch `freebuff/qr-code-cafe-ordering-website` @ `023befe`, deployed staging Worker `corner-cup-staging` @ `80f92ceb-b443-4824-a147-1856310e9a52`

Labels: **[verified]** read in source/tests · **[documented]** stated by WorkOS documentation (cited inline) · **[assumption]** reasoned, unmeasured · **[sandbox]** must be confirmed against a real WorkOS environment · **[prior stage]** established earlier in this engagement.

---

## 0. Executive summary

| ID | Finding | Severity | Complexity | Blocked by |
|---|---|---|---|---|
| C-01 | Provider token contract (`iss`, `aud`, email, `auth_time`) does not match the verifier's assumptions | **High (release blocker)** | Low to fix / high consequence | Sandbox |
| H-01 | Board sign-out never ends the WorkOS session | High | Low | — |
| H-02 | MFA is unenforced and unverifiable by app code | High | Medium | C-01, sandbox, dashboard config, SSO policy decision |
| H-03 | Membership revocation leaves live sessions | Medium (audit ranked Medium; plan treats as P2) | Low–Medium | — |
| P3-01 | Identity email/verification taken from exchange body, not the token | Medium | Low–Medium | Sandbox (token email claims) |
| P3-02 | Login `state` not bound to the initiating browser | Medium | Low–Medium | — |
| P3-03 | Provider revocation is best-effort with no scheduler | Medium | Medium | Plan/infra decision |
| P3-04 | `workos → local` rollback with `pass_hash IS NULL` locks everyone out | Medium | Low | — |
| P3-05 | One shared operator password + one shared signing secret | Medium | High (phased: Low for phase 1) | Product decision |
| P3-06 | Argon2id runtime cost never measured on the target plan | Medium (availability) | Low | Plan choice |

**Recommended order:** P3-06 (measure) → C-01 (contract) → H-01 → P3-04 → P3-01 → P3-02 → H-03 → P3-03 → H-02 → P3-05.

Rationale: measurement and contract questions decide whether local and managed sign-in work at all; H-01/P3-04/P3-02 are small, self-contained, and each closes a real gap; H-02 is the largest correctness change and depends on both the sandbox contract and dashboard configuration; P3-05 is a multi-phase programme, not a patch.

---

## 1. C-01 — Provider token contract does not match the verifier *(new, found while planning H-02)*

**Severity:** High — release blocker for any managed café. **Complexity:** Low (code/config), but must be settled before H-02.

**1.1 Root cause [documented + verified]**
The audit's provider questions were not hypothetical. Two different WorkOS token families exist and the verifier must not conflate them:

- **AuthKit/User Management session access tokens** (the family this app actually receives at the board callback — a first-party session in our own app): signed by the AuthKit JWKS; documented claims `iss` = `api.workos.com` (bare origin, no trailing slash — or the custom auth domain), `sub`, `client_id`, `org_id`, `role`/`roles`, `permissions`, `entitlements`, `feature_flags`, `sid`, `jti`, `exp`, `iat`, and (newer) `auth_time`. **No `aud` and no `email` by default** (https://workos.com/docs/reference/authkit/session-tokens/access-token). JWKS: `https://<auth-domain>/sso/jwks/<client_id>` (or `workos.userManagement.getJwksUrl(clientId)`).
- **WorkOS Connect access tokens** (OAuth 2.0 tokens minted for third-party/OAuth applications and MCP clients): `iss` = AuthKit domain, `aud` = resource or environment client ID, `client_id` = requesting application, `sub` = user, `sid` = consent id, `scope`, `jti`, `exp`, `iat` (https://workos.com/docs/authkit/connect/token-claims). These *do* carry `aud`.

The board sign-in flow uses the first family, so the verifier's audience assumption is wrong for it: AuthKit session tokens carry no `aud` by design. `client_id` identifies the issuing application but is **not** an audience and must not be treated as one. The repository's verifier instead requires:

- `iss` to equal `WORKOS_ISSUER` **exactly**, where the test fixture mints `https://api.workos.com/user_management/<client_id>` (`tests/fixtures/workos.mjs:13`), and
- `aud` to be present and to contain `clientId` (or `WORKOS_AUDIENCE`), else it returns `audience-missing` (`worker/jwt.js`, `validateClaims`).

Consequence **[assumption, high confidence]**: against a real environment both checks fail, so *every* managed sign-in would be rejected with "Sign-in failed. Please start again." The green test suite proves the app's logic against its own fixture, not the vendor's token.

**Exact contract for the selected flow (AuthKit session tokens) — pin in config, never guess:**
- Issuer: the exact `iss` byte-for-byte as minted by the environment (observed values include `api.workos.com` and `api.workos.com/user_management/<client_id>` depending on environment; custom auth domains move both issuer and JWKS). A comma-separated list is acceptable only if the sandbox shows more than one issuer shape.
- JWKS: `https://<auth-domain>/sso/jwks/<WORKOS_CLIENT_ID>` (per-client; cannot be derived from issuer alone).
- Audience: absent by default. Enforce audience only if a JWT template adds `aud`; otherwise document that no audience is enforced for session tokens (signature + pinned issuer + `client_id` equality is the trust basis) — this is a documented absence, not a silent relaxation.
- `client_id` must equal `WORKOS_CLIENT_ID` (verified, never trusted from the body).
- `sid` must be a valid `session_…` id for revocation linkage.
- `auth_time` present as a Unix timestamp in seconds (see H-02); freshness only, not MFA proof.

**Do not** make `aud` optional across the board, and **do not** blindly substitute `client_id` for `aud`. The two families have different contracts; applying the Connect rule (`aud` required) to session tokens breaks every sign-in, and applying the session-token rule (no `aud`) to Connect tokens weakens audience enforcement. The verifier must know which token family it is verifying and apply the matching rule, with the family recorded in config.

**1.2 Proposed implementation**
1. **Sandbox fixture first (gating):** before finalizing any verifier change, capture one real AuthKit session access token from the sandbox and record (redacted) `iss`, `aud` (present/absent), `kid`, `sid`, `client_id`, `email`, `email_verified`, `auth_time`, `org_id`, plus the JWKS URL and the exact `typ`/algorithm. No verifier-compatibility decision is final until this fixture exists and a test asserts field-for-field equality with it. If the fixture cannot be obtained, C-01 stays a release blocker and managed rollout is blocked.
2. Pin `WORKOS_ISSUER` to the observed value per environment (staging/production/custom auth domain) — config only; support a comma-separated list only if the sandbox shows more than one issuer shape.
3. Pin `WORKOS_JWKS_URL` (or derive via `getJwksUrl(clientId)`) to the observed per-client URL; never derive JWKS from issuer alone.
4. Audience rule — **not** "make `aud` optional":
   - Identify the token family first (session vs Connect) from config/flow, not from the token alone.
   - For **session tokens** (this app's flow): `aud` is absent by design. Do **not** substitute `client_id` for `aud` and do **not** silently skip audience. Instead, document that session-token verification rests on signature + pinned issuer + `client_id === WORKOS_CLIENT_ID` + `sid` validity, with no audience enforcement; record this as an explicit, reviewed decision. If audience enforcement is later required, add `aud` via a JWT template and switch to the strict branch.
   - For **Connect tokens** (only if/when this app ever verifies them): keep the strict containment check (`aud` present and contains the resource/environment client id).
   - In both families: missing/invalid issuer, wrong `client_id`, or a token whose family does not match the configured flow ⇒ reject.
5. Add the observed claim set as a fixture contract so tests mirror reality (`tests/fixtures/workos.mjs`), including a "family mismatch" case, and a startup self-check log naming missing configuration (`WORKOS_ISSUER`, `WORKOS_CLIENT_ID`, JWKS URL).

**1.3 Files / functions**
`worker/workos.js` — `workosConfig`, `missingConfig` · `worker/jwt.js` — `validateClaims` (issuer/audience block) · `worker/owner.js` — `ownerCallback` (passes issuer/audience) · `tests/fixtures/workos.mjs` — `claimsFor` · docs (`OPERATIONAL_READINESS.md`, `SECURITY_DEPLOYMENT_CHECKLIST.md`) — required variables per environment.

**1.4 Security implications**
No `aud` is enforced for session tokens, so replay protection rests on (a) JWKS signature verification, (b) pinned issuer, (c) `client_id === WORKOS_CLIENT_ID`, and (d) `sid`/session-row binding plus single-use `state`/PKCE. A token minted for another WorkOS client is rejected by the `client_id` check; a token from another issuer is rejected by the pinned issuer. Connect tokens, if ever verified here, keep strict audience enforcement. Pinning `iss` + JWKS per environment keeps custom-auth-domain deployments working. Any future relaxation must be a documented decision reviewed against a real fixture, never a default.

**1.5 Required tests**
Real-shaped token accepted; issuer mismatch rejected; `aud` present+wrong rejected; `aud` absent+`client_id` match accepted; `aud` absent+`client_id` mismatch rejected; `aud` absent+`client_id` absent rejected; custom auth domain pinned.

**1.6 Dependencies / provider questions**
Q1 (exact `iss`), Q2 (`aud` presence), Q11 (JWT template availability), custom-domain behaviour.

**1.7 Rollback**
Configuration-only: restore the previous `WORKOS_ISSUER`/`WORKOS_AUDIENCE` values; the strict-audience branch can be re-enabled by env flag if the substitute was ever abused.

**1.8 Acceptance criteria**
A managed sign-in against the sandbox succeeds end-to-end with a token taken from the provider, and the fixture claims equal the observed claims (field-for-field, values redacted).

---

## 2. H-01 — Managed owner sign-out does not revoke the provider session

**Severity:** High. **Complexity:** Low.

**2.1 Root cause [verified]**
The board's sign-out calls `POST /api/admin/logout` (`src/pages/Admin.jsx:56-64`) → `logout()` (`worker/api.js:2030`), which deletes `owner_sessions` and CSRF rows only. Provider revocation is queued only by `logoutEverywhere` (`api.js:2122`), the auth-mode transition (`api.js:2907`) and `ownerLogout` (`worker/owner.js:454`), and **no client code calls `/owner/logout`** (repo-wide search of `src/`). The local session dies; the WorkOS session survives, so a shared device can re-enter through `/owner/start` without a fresh interactive authentication.

**2.2 Proposed implementation (backend-first, minimal frontend change)**

*Backend — make the existing route provider-aware (recommended over rerouting the UI):*
1. Extract the identical queue statement currently in `worker/owner.js:444` (`queueOne`) into `worker/revocations.js` as `queueOneProviderRevocationStatement(env, { cafeId, sessionId, now })`, and have `owner.js` import it (behaviour-preserving; one copy of the SQL).
2. In `logout()` (`api.js:2030`), after resolving the session id from the cookie, read `workos_session_id` for that `(session_id, cafe_id)` row. Treat a missing row as "nothing to revoke".
3. Replace the two separate writes with one atomic batch:
   `[ queueProviderRevocation(… only when sid is a valid session_ id …), DELETE owner_sessions …, DELETE csrf_tokens WHERE operator_key_hash IN (sha256(sessionId), sha256(cookie)) ]`.
4. If the sid is present and valid, return `{ ok: true, providerLogoutUrl: logoutUrl(env, { sessionId: sid, returnTo: boardUrl }) }` — this finally uses the already-written-but-unused `logoutUrl()` (`worker/workos.js`), matching WorkOS's documented sign-out sequence (delete app session → redirect the browser to the logout endpoint, https://workos.com/docs/authkit/sessions#signing-out). **No sid, or a malformed one**, returns `{ ok: true, providerLogout: "unavailable" }` and logs a bounded warning (no sid value) — local sign-out still fully succeeds.
5. Drain revocation jobs opportunistically as `ownerLogout` does today (`drainProviderRevocations(env, { limit: 1 })`, fire-and-forget).
6. Leave `/owner/logout` in place for link-based sign-out, but make it delegate to the same helper so there is exactly one implementation. Mark it deprecated in the doc comment once the SPA path is live.

*Frontend (`src/pages/Admin.jsx`):*
7. `signOut()` keeps calling `/api/admin/logout`, then: if the response carries `providerLogoutUrl` **and** `config.ownerAuth === "workos"`, `window.location.assign(providerLogoutUrl)` (top-level navigation is what WorkOS documents; `api()` follows redirects and parses JSON, which is why routing the fetch through the 303 `/owner/logout` was rejected). Otherwise behave exactly as today (clear session state in place).
8. Keep local-café behaviour byte-identical: no `providerLogoutUrl`, no navigation.

**2.3 Failure handling**
- Lookup failure while deciding whether to revoke → answer `503` with the cookie cleared and the row intact? No: mirror existing semantics — if the batch fails, return `500` with the cookie cleared and the row still present (current `logout` contract), never `{ok:true}`.
- Queue insert fails → whole batch rolls back, so the session is *not* deleted while its provider job is lost; the client gets `500` and can retry (session still valid, cookie already cleared by the response; retry from a fresh page re-authenticates).
- Sid absent/malformed → success with `providerLogout: "unavailable"` (local invalidation is the security-critical half) and a log line for the operator runbook.
- Provider logout navigation failing at the browser level leaves the local session already deleted; the provider session persists as documented residual risk (bounded by WorkOS session/inactivity settings).

**2.4 Sharing a device before the fix vs after**
Before: local row gone, provider session alive → next `/owner/start` can silently re-enter.
After: local row gone **and** browser redirected to the provider logout endpoint → provider session ended; re-entry requires interactive authentication (and, with H-02, MFA).

**2.5 Files / functions**
`worker/api.js` — `logout` (2030) [primary], `logoutEverywhere` (2081) [use shared helper] · `worker/owner.js` — `queueOne` (444) removed/imported, `ownerLogout` (454), `redirect` · `worker/revocations.js` — new `queueOneProviderRevocationStatement` · `worker/workos.js` — `logoutUrl` (now used) · `src/pages/Admin.jsx` — `signOut` (56), `AdminShell` sign-out button (294) · `src/lib/api.js` — no change (documented constraint).

**2.6 Security implications**
Closes the audit's H1. Reduces residual provider-session lifetime to the logout round trip. Does not weaken CSRF/origin checks: `/admin/logout` remains a same-origin POST with `SameSite=Strict` cookie; the redirect target is built server-side from env config, never from request input (no open redirect).

**2.7 Required tests**
1. Managed session (sid present) → `provider_revocations` row queued in the same batch, `owner_sessions` row gone, response carries `providerLogoutUrl` containing the sid's session id.
2. Local session (sid NULL) → no queue row, `200 {ok:true}`, existing local tests unchanged (regression).
3. Malformed sid (`abc`, `session_` + 200 chars, non-string) → local delete succeeds, `providerLogout: "unavailable"`, no queue row.
4. Session row missing → `200`, nothing queued.
5. Batch failure (forced) → `500`, session row intact, no half state.
6. Cross-origin POST still `403`; sign-out twice is harmless.
7. Frontend component test: managed board with `providerLogoutUrl` performs a top-level navigation; local board does not.
8. No sid value appears in logs.

**2.8 Dependencies / provider questions**
Q7 (revoke semantics), Q8 (logout endpoint + `return_to` + custom domain). Independent of C-01/H-02, so it can ship first.

**2.9 Rollback**
Feature flag `OWNER_LOGOUT_PROVIDER_REVOKE` (default on): `off` restores today's local-only delete. The `providerLogoutUrl` field is additive, so an old frontend simply ignores it.

**2.10 Acceptance criteria**
Signing out a managed board queues exactly one revocation job, deletes exactly that session, and lands the browser on the WorkOS logout endpoint; a copied cookie is refused afterwards; local-café sign-out is unchanged in behaviour and response shape (plus the new optional field).

---

## 3. H-02 — MFA is not enforced or verifiable by application code

**Severity:** High. **Complexity:** Medium (highest uncertainty in this plan).

**3.1 Root cause [verified + documented]**
No `mfa`/`amr`/`acr` handling exists anywhere; the authorize request sets no assurance parameter; JWT validation inspects none. WorkOS's documented model is different from a generic OIDC `acr` request:

- MFA is an **environment setting**: Dashboard → Authentication → Features → Multi-factor auth → **Required**; TOTP via authenticator app; hosted AuthKit performs enrolment and the challenge automatically. **The requirement does not apply to SSO users** (https://workos.com/docs/authkit/mfa). Per-organization MFA policies exist for non-SSO members (https://workos.com/docs/authkit/organization-policies).
- No `acr_values` parameter is documented for `/user_management/authorize`. The documented step-up controls are **`max_age`** on `/authorize` (supported for AuthKit flows; `0` forces re-authentication) and the **`auth_time`** claim on access/ID tokens (WorkOS step-up release notes, 2026-07-02) — and AuthKit also supports `provider=authkit`, `prompt`, `screen_hint`.
- The documented access-token claim list contains **no `amr`/`acr` and no MFA indicator** (https://workos.com/docs/authkit/sessions). JWT templates can add custom claims from user/organization attributes and metadata (https://workos.com/docs/authkit/jwt-templates), but those are application-defined and unverified unless pinned.

**Critical clarification of what `auth_time` does and does not prove:**
- `auth_time` is a Unix timestamp of the user's most recent **active authentication**. It advances only on a real interactive sign-in, not on a token refresh. It is a **freshness** signal, not an MFA-completion signal. A user who signed in with only a password (no second factor) still produces a fresh `auth_time`; a user who signed in via SSO (whose MFA, if any, lives at the IdP) also produces a fresh `auth_time`.
- Therefore `auth_time` alone can never prove that MFA occurred. It can only prove that authentication happened recently, which is a precondition for step-up but not for MFA assurance.
- WorkOS environment-level Required MFA is enforced by hosted AuthKit **only for non-SSO users** (password/social). SSO users are explicitly exempt; their second factor, if any, is the IdP's responsibility and is not represented in AuthKit tokens.

**Unverified claims are not proof:** an `amr`, `acr`, or custom JWT claim is **not** proof of MFA unless it is (a) present in a JWKS-verified token, (b) issued by WorkOS or a pinned IdP claim source, (c) covered by the sandbox fixture, and (d) validated with an allowlist. A claim copied from the callback body, the `/authenticate` response, or a client-supplied header is never proof. Absent a pinned, verified claim, treat MFA assurance as unestablishable.

**3.2 Chosen mechanism (documented, not assumed)**

1. **Environment control (non-SSO users only):** MFA set to **Required** in the WorkOS environment(s) used by managed cafés. This is the only documented way hosted AuthKit enforces TOTP; the app cannot turn it on per request, and it covers password/social users only.
2. **Requesting freshness:** add `provider=authkit` and `max_age=<WORKOS_MAX_AUTH_AGE_SECONDS>` (default `0` for the board entry point) to `authorizeUrl()`. With MFA required, a forced interactive re-authentication is the step at which TOTP is demanded for non-SSO users; a cached provider session is not accepted. `max_age`/`auth_time` enforce **freshness**, not MFA completion.
3. **Verifying freshness:** after signature/issuer/audience/subject checks, require `auth_time` from the **verified** JWT: numeric, not in the future beyond the existing 60 s skew, and no older than `max_age + tolerance` (tolerance ≈ 120 s for clock/round-trip drift). Missing, non-numeric, future-dated or stale `auth_time` ⇒ refuse with the generic denial and a distinct server-side reason code.
4. **MFA assurance for SSO users — explicit evaluation (blocking decision, not yet resolved):** WorkOS does not enforce or represent MFA for SSO users, and `auth_time` does not prove MFA. Two options must be evaluated before managed rollout; pick one and record it:
   - **Option A — Disable owner SSO:** managed-café owners authenticate only through AuthKit password/social flows, so the environment-level Required MFA actually applies. Simplest and most auditable; costs SSO convenience for owners and must be a documented policy.
   - **Option B — Separately verifiable MFA assurance for SSO users:** keep SSO but require a second factor the app can independently verify — either IdP-enforced MFA surfaced through a pinned, JWKS-verifiable claim (JWT template / IdP `amr`/`acr` only if the sandbox proves the claim is issued and tamper-evident), or an application-level second factor (e.g. TOTP/WebAuthn managed by the app) gated on owner enrolment. Higher complexity; only viable if a verifiable signal exists.
   - **Option C (not acceptable as a final state):** assume SSO users' IdPs enforce MFA without any verifiable signal. This is an unverifiable assertion and leaves the assurance gap open; it may only be used under `provider-only` mode with the residual risk written into the readiness docs.
   The chosen option must be named in config/docs and reviewed.
5. **Policy gate:** `WORKOS_MFA_MODE`:
   - `required` — freshness check mandatory **and** MFA assurance established per the chosen SSO option (target state; default for managed cafés once sandbox confirms `auth_time` and the SSO option is decided);
   - `provider-only` — explicitly documented residual risk: MFA is assumed from the dashboard and not verifiable in-app (current behaviour). Permitted only with a written risk acceptance; not the default for production managed cafés.
   The mode is logged at start-up by name (never by value) so the deployment's posture is auditable.
6. **No trust in unverified material:** assurance is taken only from the JWKS-verified access token. Callback query parameters, the `/authenticate` body and the user object are never used as proof of MFA or freshness. (This is also the reason P3-01 matters: the same rule must apply to email.)
7. **Optional hardening [sandbox]:** if a JWT template or IdP can render MFA/factor state (e.g. `mfa: true` or an `amr` array), validate it with an allowlist *in addition* to `auth_time`, behind `WORKOS_MFA_CLAIM`. Do not invent a claim format: sample it in the sandbox and pin it in the fixture. An unverified or unpinned `amr`/`acr`/custom claim is **not** proof of MFA and must not be treated as one.
8. **Fail-closed policy for unestablishable assurance:** when `WORKOS_MFA_MODE=required` and MFA assurance cannot be established for a user (SSO user with no verifiable second factor, missing/unverifiable claim, missing `auth_time`, or an SSO option not yet decided), the callback **refuses to create a session** and returns the generic denial with a distinct server-side reason code (`mfa-assurance-unavailable` or `freshness-missing`). No partial session, no membership change, no fallback to `provider-only` inside the request. The user is redirected to re-authenticate; if assurance still cannot be established, sign-in is denied and the event is logged (reason code only, no token material). In `provider-only` mode the same condition is allowed but must be recorded in the readiness docs as accepted residual risk.

**3.3 Files / functions**
`worker/workos.js` — `authorizeUrl` (add `provider`, `max_age`), `workosConfig`/`missingConfig` (new vars) · `worker/jwt.js` — `validateClaims` (assurance block) + a new `assuranceFrom(claims)` helper, `verifyToken` return shape · `worker/owner.js` — `ownerStart`, `ownerClaimStart`, `ownerCallback` (enforce, log reason, generic denial) · `tests/fixtures/workos.mjs` — mint `auth_time` variants · `tests/workos.jwt.test.mjs`, `tests/owner.signin.test.mjs` — new cases · docs: operator runbook (MFA must be Required before enabling `WORKOS_MFA_MODE=required`).

**3.4 Security implications**
MFA becomes an app-enforced precondition for a managed session rather than a dashboard hope. Failure is closed: no assurance ⇒ no session. Residual risk while `provider-only` is set must be stated in the readiness docs. Forcing `max_age=0` costs one extra provider round trip per sign-in — acceptable for a staff board.

**3.5 Required tests**
1. Fresh `auth_time` (within `max_age`) ⇒ session created (non-SSO path).
2. Stale `auth_time` (e.g. now − 3600 s, `max_age=0`) ⇒ refused, no session, no membership change.
3. `auth_time` absent ⇒ refused under `required`; accepted under `provider-only` (explicit, separate test).
4. Malformed `auth_time` (`"abc"`, float, huge, negative, array) ⇒ refused.
5. `auth_time` in the future beyond skew ⇒ refused.
6. Authorize URL contains `provider=authkit` and the configured `max_age`; absent when the variable is empty.
7. Assurance comes from the token, not the body: a body claiming MFA with a token lacking `auth_time` is refused.
8. Unverified email still refused independently (existing test kept).
9. Mode gate: `provider-only` cannot be silently defaulted in production config (assert the resolved mode in the start-up log/config test).
10. Fresh `auth_time` alone with `required` mode and no verifiable MFA assurance (SSO user, Option A/B not satisfied) ⇒ refused with `mfa-assurance-unavailable`; no session.
11. Unverified `amr`/`acr`/custom claim supplied via body or header ⇒ ignored; session still refused if assurance unestablishable.
12. Pinned verified MFA claim (if sandbox provides one) ⇒ session created only when the claim is on the allowlist; unpinned claim format ⇒ refused.

**3.6 Dependencies / provider questions (blocking)**
Q3 (`auth_time` presence/format in this environment), Q4 (MFA Required behaviour for hosted AuthKit incl. enrolment), Q5 (is `provider=authkit` required for `max_age`/MFA; does it change the flow), Q11 (custom MFA claim), Q13 (SSO: whether owner SSO must be disabled or a separately verifiable MFA assurance mechanism is required; IdP claim availability).
Also depends on C-01: assurance checks are pointless until real tokens verify at all.

**3.7 Rollback**
Env-only: set `WORKOS_MFA_MODE=provider-only` and/or clear `WORKOS_MAX_AUTH_AGE_SECONDS`; no code revert, no data migration. Existing sessions are unaffected (they were minted before the check; document that a deployed change only affects new sign-ins — pair with "sign out everywhere" if immediate effect is needed).

**3.8 Acceptance criteria**
With `required` + `max_age=0`: a sandbox sign-in with MFA enabled produces a session only after a TOTP challenge; a session minted without a fresh `auth_time` is refused; the mode is visible in logs and docs; all ten tests above pass in both SQLite and workerd harnesses.

---

## 4. H-03 — Membership revocation leaves live sessions

**Severity:** Medium (audit) — treated as P2 here. **Complexity:** Low–Medium.

**4.1 Root cause [verified]**
`operatorRevokeOwner` (`worker/api.js:2983`) deletes the `cafe_owners` row and writes `operator_audit`, but does not touch `owner_sessions` or `auth_version`. An already-signed-in owner keeps board access until idle/absolute expiry (≤ 24 h) or a password reset.

**4.2 Proposed implementation**
1. Resolve affected sessions first: `SELECT session_id FROM owner_sessions WHERE cafe_id = ? AND workos_user_id = ?` (index `idx_owner_sessions_identity` exists, partial on `workos_user_id IS NOT NULL`).
2. One atomic batch, in this order:
   - `INSERT INTO provider_revocations … SELECT DISTINCT workos_session_id … WHERE cafe_id = ? AND workos_user_id = ? AND workos_session_id IS NOT NULL ON CONFLICT DO NOTHING` (queue **before** deleting the rows it reads),
   - `DELETE FROM owner_sessions WHERE cafe_id = ? AND workos_user_id = ?`,
   - `DELETE FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?` (with the existing `changes === 1` 404 contract preserved),
   - `INSERT INTO operator_audit (… 'revoke_owner', detail = 'sessions=<n>')`.
3. Best-effort CSRF cleanup: `csrf_tokens` rows are keyed by `sha256(sessionId)`; delete by the collected ids (bounded; cap at 50 and rely on the 12 h expiry beyond that).
4. Keep `auth_version` **unchanged**: bumping it would sign out *every* owner of that café (including ones whose membership is intact) and would also invalidate sessions in other cafés only if the subject is shared — but the goal is precise, per-identity, per-café revocation.
5. Other cafés: rows are keyed by `(cafe_id, workos_user_id)`, so an identity's sessions in other cafés are untouched by construction. Add an explicit test.
6. Drain revocations fire-and-forget (`limit: 2`), as the other credential paths do.

**4.3 Concurrency and race analysis**
- In-flight callback racing the revocation: the session `INSERT … SELECT … WHERE EXISTS (cafe_owners)` is atomic with the membership read. If the callback's batch commits **before** the revocation batch, the revocation batch's `DELETE … WHERE cafe_id/workos_user_id` removes the just-created session (queue statement runs first and sees it). If it commits **after**, `EXISTS` finds no membership and no session is created. Either interleaving ends with zero sessions and no membership. This relies on D1 executing `batch()` statements sequentially inside one transaction — **[assumption]** (documented D1 behaviour; assert with a concurrency test in the harness).
- Two operators revoking simultaneously: the second sees `changes === 0` on the membership delete and returns 404, having queued nothing (batch rollback), which is acceptable and testable.
- Operator revoking while the owner is mid-request: that request may complete (it authenticated before revocation); the next one is refused. Acceptable; document.

**4.4 Files / functions**
`worker/api.js` — `operatorRevokeOwner`, `operatorAudit` insert, imports from `revocations.js` · `worker/revocations.js` — a new `queueIdentityRevocationsStatement(env, { cafeId, workosUserId, now })` (the single-café variant already exists as `queueProviderRevocationsStatement`) · `src/pages/Operator.jsx` (owner list/revoke UI — confirm the confirm dialog wording mentions signing the owner out) · `tests/operator.owner-routes.test.mjs`, `tests/owner.revocation.test.mjs`.

**4.5 Security implications**
Closes the ≤ 24 h residual-access window on offboarding; provider sessions are ended too, so re-entry needs fresh authentication. No effect on the revoked identity's other cafés, and no effect on other owners of this café.

**4.6 Required tests**
1. Revoke → sessions gone, revocation jobs queued, audit row written, response `200`.
2. Identity owning two cafés: only the target café's session dies; the other still authenticates.
3. Callback that commits before revocation ends session-less; callback after revocation cannot create a session.
4. Revoking a non-member → `404`, nothing queued, no sessions deleted.
5. Duplicate/concurrent revoke → exactly one succeeds, no orphan jobs.
6. CSRF/Origin still enforced (existing tests).

**4.7 Dependencies / provider questions**
Q7 (revoke semantics). Independent of C-01/H-02.

**4.8 Rollback**
Additive statements; reverting restores membership-only deletion (audit rows remain). No migration needed (no schema change).

**4.9 Acceptance criteria**
After revoke, the identity's cookie is refused on the very next request at that café, a revocation job exists for each of its provider sessions, other cafés are unaffected, and the operator audit records the revocation.

---

## 5. Priority 3 findings

### P3-01 — Email and verification must come from the verified token

**Severity:** Medium. **1 Root cause [verified]:** `email` and `email_verified` are read from the `/authenticate` body (`worker/workos.js:124`, used at `worker/owner.js:302` and the claim comparison at `owner.js:340`), never cross-checked with the verified JWT.
**2 Implementation:** add `email`/`email_verified` extraction to the verified-claims path; introduce `WORKOS_EMAIL_SOURCE` = `prefer-token` (default now) | `require-token` (after sandbox confirms the claims) | `body` (legacy, explicit). In `prefer-token`: use token claims when present and require agreement with the body; mismatch ⇒ generic 403 plus a reason-coded log. Never trust the body alone when a token claim exists.
**3 Files:** `worker/workos.js` (`exchangeCode` return shape), `worker/jwt.js` (`validateClaims` optional email block), `worker/owner.js` (`ownerCallback`, claim comparison), `tests/fixtures/workos.mjs` (mint email claims), `tests/owner.signin.test.mjs`.
**4 Security:** removes the trust split; a body/token divergence can no longer mark an unverified address as verified. **[sandbox]** depends on whether these claims exist at all (they are absent from the documented list) — hence the mode gate.
**5 Tests:** token+body agree ⇒ accepted; disagree ⇒ refused; token has `email_verified:false` ⇒ refused; claim has only body (mode `prefer-token`) ⇒ accepted with a warning log; `require-token` + absent claim ⇒ refused.
**6 Dependencies:** C-01, Q6. **7 Rollback:** env mode. **8 Acceptance:** in `require-token`, no code path reads email/verification from the exchange body.

### P3-02 — Bind login state to the initiating browser

**Severity:** Medium. **1 Root cause [verified]:** `state` is single-use and hashed, but no cookie ties it to the browser that started the flow; an attacker's own `state`+`code` can sign a victim into the attacker's identity (login CSRF; membership bounds the impact to the attacker's café).
**2 Implementation:** on `ownerStart`/`ownerClaimStart`, set `owner_state_<slug>` = base64url(32 random bytes) alongside the stored digest (extend `owner_login_states` with `browser_hash` = sha256(binding), additive migration), `HttpOnly; SameSite=Lax; Path=/api/cafes/<slug>/owner; Max-Age=600; Secure` on https. In `ownerCallback`, require the cookie, compare `sha256(binding)` in constant time to the stored value, refuse `400` on mismatch/absence, and clear the cookie on every exit path. `SameSite=Lax` is required because the callback is a top-level cross-site navigation; `Strict` would drop the cookie.
**3 Files:** `worker/owner.js` (`ownerStart`, `ownerClaimStart`, `burnState`, `ownerCallback`), `worker/session.js` (cookie helpers reused), `worker/db.js` (one additive ALTER), `tests/owner.signin.test.mjs`, `src/pages/Admin.jsx` (no change — the claim `fetch` receives the cookie, then the top-level navigation sends it back).
**4 Security:** closes login CSRF; mismatched binding returns generic 400 and consumes the state (prevents probing); no effect on third-party-cookie behaviour because the callback is first-party to the Worker origin.
**5 Tests:** no cookie ⇒ 400 and state burned; wrong cookie ⇒ 400; correct ⇒ success and cookie cleared; claim flow sets the cookie on the JSON response; cookie cannot be replayed after success; expiry (10 min) enforced.
**6 Dependencies:** none. **7 Rollback:** flag `WORKOS_STATE_BINDING` (on → current behaviour when off). **8 Acceptance:** a callback without the binding cookie can never create a session.

### P3-03 — Provider revocation retry and expiry

**Severity:** Medium. **1 Root cause [verified]:** jobs are drained only on later sign-in/sign-out/logout-all/mode-switch; 5 attempts, 24 h TTL, then deleted; no cron trigger exists in any wrangler config (`[verified]` grep). A provider session can therefore outlive its local revocation indefinitely.
**2 Implementation (choose one):**
- **(a) recommended** add a Cloudflare Cron Trigger (`triggers.crons` in `wrangler.staging.jsonc` and production config, every 5 minutes) plus a `scheduled()` handler in `worker/index.js` that calls `drainProviderRevocations(env, { limit: 10 })` and logs `{revoked, failed, pruned}`; keep the opportunistic drains.
- **(b)** external scheduler hitting a signed internal endpoint — more moving parts, not preferred.
Also: raise `REVOCATION_MAX_ATTEMPTS` to 8, cap backoff at 15 min, keep the 24 h TTL, and expose the queue depth in the operator console (read-only) so an operator can see stuck jobs.
**3 Files:** `worker/index.js` (add `scheduled`), `worker/revocations.js` (backoff/attempt constants, a `revocationQueueDepth(env)` helper), `wrangler.staging.jsonc` + production config (`triggers`), `src/pages/Operator.jsx` (depth display, optional), tests (`tests/owner.revocation.test.mjs`, new drain tests).
**4 Security:** shrinks the window in which a signed-out session remains valid at the provider; makes provider failures observable instead of silent.
**5 Tests:** retry with backoff schedules `next_attempt`; lease prevents double-revoke; 404 counts as success; job dropped after max attempts; prune removes expired jobs; `scheduled()` drains and logs; deployment config contains the cron.
**6 Dependencies:** Q9 (plan cron limits), Q7. **7 Rollback:** remove the `triggers` block; opportunistic drains continue unchanged. **8 Acceptance:** with the cron enabled, a queued job is attempted within 5 minutes without any user traffic.

### P3-04 — `workos → local` rollback with `pass_hash IS NULL`

**Severity:** Medium (availability). **1 Root cause [verified]:** the mode transition never inspects `pass_hash`; staging currently has `pass_hash IS NULL` **[prior stage]**, so switching back to `local` leaves sign-in answering `503` until an operator reset.
**2 Implementation (minimal, chosen):** in `operatorAuthMode`, when `newMode === 'local'` and `cafe.pass_hash` is NULL, refuse with `409 {code:"password_required"}` and a message telling the operator to set a password first, *before* preparing the transition (no batch, no partial state). Then extend `operatorResetPassword` acceptance in the console flow: reset password → switch mode → verify sign-in. Optionally (follow-up) accept `newPassword` in the same request and compose the hash + `auth_version` bump into the transition batch, keeping the nine-statement order intact.
**3 Files:** `worker/api.js` (`operatorAuthMode` guard; optionally `operatorResetPassword` composition), `src/pages/Operator.jsx` (error surface + ordering hint), docs: rollback runbook (`OPERATIONAL_READINESS.md`, `STAGE6_STAGING_DEPLOYMENT.md`-style runbook), `tests/auth-mode.*`, `tests/operator.owner-routes.test.mjs`.
**4 Security:** prevents a rollback that silently locks the café out; makes the credential requirement explicit instead of emergent.
**5 Tests:** managed café with NULL hash → `409 password_required`, mode unchanged, no transition row; after reset → transition succeeds, generation +1, sessions cleared; managed café with a hash → transition succeeds unchanged; local → workos unaffected.
**6 Dependencies:** none. **7 Rollback:** guard is additive; remove it to restore permissive behaviour (documented as unsafe). **8 Acceptance:** no path can produce a `local` café that no one can sign into, and the runbook order is written down.

### P3-05 — Shared operator credential and shared signing secret

**Severity:** Medium. **1 Root cause [verified]:** `OPERATOR_PASSWORD` is a deployment-wide plaintext secret compared in constant time, and `ADMIN_SECRET` signs owner sessions, operator sessions and (as fallback) guest tracking tokens (`worker/session.js:sign`, `worker/tracking.js:trackingKey`). No per-operator identity, no MFA, no rotation procedure, no separation of keys.
**2 Implementation — phased:**
- **Phase 1 (low):** derive per-surface keys with HKDF from `ADMIN_SECRET` (`corner-cup/owner-session/v1`, `/operator-session/v1`, `/order-track/v1`) so one leaked token class cannot be re-signed as another; accept a dedicated `OPERATOR_SESSION_SECRET`/`ORDER_TRACK_SECRET` override when present; document rotation (set new secret → old tokens expire within the 12 h window). Add an operator-login audit row (IP hash + timestamp, no secret material).
- **Phase 2 (high):** operator identities table (`operator_accounts`: id, label, Argon2id hash, `auth_version`, created), per-account sessions, per-account audit, optional TOTP/WebAuthn, and removal of `OPERATOR_PASSWORD` after a migration window. Consider putting the console behind Cloudflare Access as defence in depth.
**3 Files:** `worker/session.js` (`sign`, `issueToken`, `operatorSessionId*`), `worker/tracking.js` (`trackingKey`), `worker/api.js` (`operatorLogin`, `operatorCafes`, audit writes), `worker/db.js` (Phase 2 migration), `src/pages/Operator.jsx` (login form + account management), `wrangler` secret list docs.
**4 Security:** blast radius of a single secret shrinks; operator actions become attributable; token-class confusion is removed. **[assumption]** rotation cadence must be agreed with the owner.
**5 Tests:** a token signed with the owner key is refused on the operator surface and vice versa; tracking tokens cannot be turned into sessions; legacy cookie accepted during the grace window then refused (Phase 1); Phase 2: per-account lockout, audit per account, revocation of one account leaves others working.
**6 Dependencies:** Q12 (product decision on operator accounts), plan-level secret rotation policy. **7 Rollback:** dual-accept window (old + new derivation) for one session lifetime, then remove; Phase 2 keeps `OPERATOR_PASSWORD` as a break-glass path until explicitly retired. **8 Acceptance:** no single secret can mint two token classes; every operator action is attributable to an account (Phase 2).

### P3-06 — Argon2id runtime measurement on the intended plan

**Severity:** Medium (availability). **1 Root cause [verified]:** parameters are fixed at `m=19456, t=2, p=1` with ~65 MB wasm reservation, and no derivation has ever run in the deployed Worker (staging café has `pass_hash IS NULL`, so login returns 503 before hashing). Whether it fits the CPU budget is unmeasured **[assumption]**.
**2 Implementation:** (a) run the existing `tests/gate2-measure.mjs` (hash + verify timings, already present) as a baseline under Node; (b) measure in workerd: `wrangler dev --config wrangler.staging.jsonc --remote` (or a dedicated measurement Worker with the same compatibility date) and capture CPU time per derivation from `wrangler tail`/dev logs, p50/p95 over ≥ 30 iterations; (c) record the plan's CPU limit (Free 10 ms vs Paid configurable) next to the numbers; (d) decide: keep OWASP baseline on Paid, or lower to `m=8192, t=2` on Free with a documented, reviewed deviation — never a silent downgrade (the code already refuses non-canonical parameters on verify).
**3 Files:** `tests/gate2-measure.mjs` (extend to p50/p95 + JSON output), a measurement note in `STAGE7_AUTH_FUNCTIONAL_READINESS.md`, deployment docs (`STAGE3_DEPLOYMENT_PREFLIGHT.md`), no runtime code change unless parameters change in `worker/passwords.js`.
**4 Security:** prevents either (i) an unusable password flow discovered in production, or (ii) an unplanned weakening of the hash to fit a plan.
**5 Tests:** measurement script asserts numeric output and fails loudly on timeout; a workerd test that a single hash+verify completes within the plan budget (skip if budget unknown).
**6 Dependencies:** Q10 (plan choice). **7 Rollback:** n/a (measurement only). **8 Acceptance:** published p50/p95 CPU and wall-clock numbers for hash and verify on the chosen plan, with an explicit go/no-go decision recorded.

---

## 6. Implementation order and dependencies

| Order | Item | Depends on | Why here |
|---|---|---|---|
| 1 | P3-06 measurement | Plan decision (Q10) | Decides whether local sign-in is viable before anyone relies on it |
| 2 | C-01 contract | Sandbox (Q1, Q2) | Blocks all managed sign-in and H-02 |
| 3 | H-01 sign-out | — (Q7/Q8 optional) | Small, high value, independent |
| 4 | P3-04 rollback guard | — | One guard + runbook note |
| 5 | P3-02 state binding | — | Self-contained, closes login CSRF |
| 6 | P3-01 email source | C-01, Q6 | Needs token email claims confirmed |
| 7 | H-03 membership revocation | Q7 | Operator-path change, independent of provider flow |
| 8 | P3-03 revocation scheduler | Q9 | Infra change; complements H-01/H-03 |
| 9 | H-02 MFA | C-01, Q3–Q5, dashboard config | Largest uncertainty; needs a real environment |
| 10 | P3-05 operator auth | Q12 | Programme, not a patch; phase 1 may run in parallel |

Cross-cutting: every item needs the existing workerd + SQLite test harnesses (some suites currently require `127.0.0.1:8789/8790` services that are not running **[verified]** in this environment), and every item that changes behaviour should land behind its env flag so the flag itself is tested.

---

## 7. Questions that must be answered before implementation

**Blocking (sandbox / configuration)**
1. Exact `iss` of a real access token, per environment and with/without custom auth domain.
2. Is `aud` present in the token? If not, is `client_id` present and usable as the substitute, or can a JWT template add `aud`?
3. Is `auth_time` present today, and in what type/format? Which WorkOS environment setting controls it?
4. Does MFA=Required definitely gate the hosted AuthKit flow (enrolment + TOTP) *before* an authorization code is issued?
5. Is `provider=authkit` required for `max_age`/MFA in this environment, and does adding it alter the sign-in screen or organization behaviour?
6. Do tokens carry `email`/`email_verified`, and is `email` the verified address?
7. Revoke endpoint: does `POST /user_management/sessions/revoke` accept `sid` as documented, and is `404` reliably "already gone"?
8. Logout endpoint: does `GET /user_management/sessions/logout?session_id=&return_to=` work with our configured Sign-out URI and custom domain?
9. Cron Triggers: available on the target plan, minimum interval, and acceptable for this project?
10. Which Cloudflare plan will production run (Free 10 ms vs Paid CPU budget)? This decides P3-06's outcome.
11. Can a JWT template expose MFA/factor state, and what does the claim look like?
12. Operator accounts: build per-account identities and MFA (Phase 2) now, or only split signing keys (Phase 1)?

**Policy (owner decisions, not vendor)**
13. Owner SSO policy: disable owner SSO so environment-level MFA applies (Option A), or require a separately verifiable MFA assurance mechanism for SSO users (Option B — only if a pinned, JWKS-verifiable claim or app-level second factor is available)? Unverified IdP-side MFA is not acceptable as a final state.
16. Token family: confirm the board flow receives AuthKit session tokens (not Connect tokens) in this environment, and record the exact `iss` + JWKS URL + `typ` + algorithm from a real sandbox token before finalizing verifier compatibility.
17. MFA claim availability: can any JWT template or IdP surface a verifiable MFA/factor claim, and what does it look like? If none, Option A (disable SSO) is the only assurance-capable path.
14. Should operator console access additionally require Cloudflare Access?
15. What is the session-length/inactivity policy in the WorkOS application settings (it bounds the residual windows in M1/M2)?

---

## 8. Verified facts vs assumptions

| Statement | Basis |
|---|---|
| Board sign-out skips provider revocation; `/owner/logout` unreachable from `src/` | **[verified]** `Admin.jsx:56-64`, `api.js:2030`, repo-wide search |
| Local row deletion + provider revocation can be one batch | **[verified]** existing `owner.js:444` + `logoutEverywhere` precedent |
| WorkOS recommends delete-session → redirect to logout endpoint | **[documented]** https://workos.com/docs/authkit/sessions#signing-out |
| MFA is an environment "Required" setting (TOTP; not SSO users) | **[documented]** https://workos.com/docs/authkit/mfa, organization-policies |
| Documented token claims: `sub, sid, iss, org_id, role, permissions, exp, iat` — no `aud`, no `email` | **[documented]** https://workos.com/docs/authkit/sessions |
| Our verifier requires `iss` = fixture issuer and a present `aud` | **[verified]** `worker/jwt.js` `validateClaims`, `tests/fixtures/workos.mjs:13` |
| Real tokens would therefore fail verification today | **[assumption, high confidence]** — must be proven in sandbox |
| `max_age` forces re-authentication (AuthKit) and `auth_time` exists | **[documented]** WorkOS step-up release notes; **[sandbox]** for this environment |
| JWT templates can add custom claims | **[documented]** https://workos.com/docs/authkit/jwt-templates; claim details **[sandbox]** |
| Membership revocation leaves sessions live | **[verified]** `operatorRevokeOwner` |
| D1 `batch()` runs statements sequentially in one transaction | **[assumption]** (platform behaviour) — assert with a concurrency test |
| No cron trigger configured anywhere | **[verified]** grep over `wrangler*.jsonc/json` |
| Argon2id cost exceeds Free-plan CPU budget | **[assumption]** — P3-06 measures it |
| AuthKit session tokens carry no `aud` and no `email`; issuer `api.workos.com` (or custom domain); JWKS `…/sso/jwks/<clientId>` | **[documented]** https://workos.com/docs/reference/authkit/session-tokens/access-token |
| WorkOS Connect access tokens carry `aud` (resource/environment client id) and use a different contract | **[documented]** https://workos.com/docs/authkit/connect/token-claims |
| `auth_time` is a freshness timestamp, not MFA proof; `max_age` forces re-auth | **[documented]** https://workos.com/docs/authkit/reauthentication |
| Environment-level Required MFA (TOTP) does not apply to SSO users | **[documented]** https://workos.com/docs/authkit/mfa |
| No `amr`/`acr`/MFA indicator in the documented AuthKit access-token claim list | **[documented]** https://workos.com/docs/authkit/sessions |
| Staging café: `owner_auth=local`, `pass_hash IS NULL`, no sessions | **[prior stage]** read-only D1 checks in Stages 6/9B |

---

## 9. Scope statement

This document is a plan. No application code, tests, migrations, secrets, provider settings, authentication modes, D1 rows or deployments were changed; `STAGE10A1_AUTH_REMEDIATION_PLAN.md` is the only new file. Stage 10B (WorkOS sandbox contract verification) and Stage 10C (implementation) remain on hold pending explicit approval.
