# Corner Cup — Isolated Staging Execution Checklist

Documentation only. Nothing here has been executed. No resources created, no secrets set, no
deployment performed. This checklist is the staging-readiness artifact for the F-01–F-20 security
program and the F-07 Phase 2B managed-authentication work.

## 1. Staging readiness decision

**CONDITIONALLY READY for an isolated staging Worker**, subject to the items below and the
outstanding WorkOS sandbox requirements in §6. Local verification is complete: 424/424 tests
pass, production build succeeds, npm audit reports 0 vulnerabilities. What remains is
environment-side: a disposable D1, WorkOS sandbox credentials, and a Worker deployment the
operator explicitly authorises. No staging deployment, migration or secret change has been
performed.

## 2. Required Cloudflare resources (create only with explicit approval)

- One Worker (staging name, e.g. `corner-cup-staging`), Workers **Free** plan (do not upgrade).
- One D1 database, bound as `DB`, isolated from production and from local dev state.
- Static assets served by the Worker via the existing `assets` binding (`./dist`); `/api/*` runs
  first (`run_worker_first: true`).
- No KV, R2, Queue, Durable Object or additional binding is required for Phase 2B.
- No custom domain is required for the first pass; use the `*.workers.dev` origin and record it
  exactly for the WorkOS redirect URI.

## 3. Required D1 database and migrations

- Binding name: `DB`. Database must be empty/disposable; never point staging at production data.
- Apply migrations in order; every statement is additive and idempotent
  (`CREATE ... IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN` tolerated when already present):
  1. Phase 1: `cafes.owner_auth`, `owner_identities`, `cafe_owners`, `owner_login_states`,
     `owner_sessions.workos_user_id`, `owner_sessions.workos_session_id`.
  2. Phase 2A: `cafes.auth_mode_generation`, `cafes.auth_mode_cas_token`,
     `auth_mode_transitions`, `operator_audit`, `tx_guard`, the generation-step trigger and its
     indexes.
  3. Phase 2B: `owner_login_states.{code_verifier_enc, claim_hash, return_to}`, `owner_claims`,
     `provider_revocations`, `cafes.auth_version_cas_token`, and the three phase-2B indexes.
- Verify after applying: fresh, existing and legacy databases converge to one shape; a second run
  is a no-op. No backfill, no `pass_hash` rewrite.
- Back up D1 (export) before applying migrations, even on staging.

## 4. Exact required environment variable names

Set via `wrangler secret put` / environment configuration, never in the repository or bundle:

- `ADMIN_SECRET` — required; absent ⇒ owner/operator sign-in answers 503 by design.
- `OPERATOR_PASSWORD` — ≥ 12 characters; unlocks `/operator`.
- `OWNER_PASSWORD` — first-boot seed only; seeds the primary café once while `pass_hash IS NULL`.
- `ORDER_TRACK_SECRET` — optional; derives a subkey from `ADMIN_SECRET` when absent.
- `WORKOS_CLIENT_ID` — public value.
- `WORKOS_API_KEY` — server-only; never reaches the bundle.
- `WORKOS_REDIRECT_URI` — must exactly match `/api/owner/callback` on the deployed staging origin.
- `WORKOS_ISSUER` — pin the exact string observed in the sandbox.
- `WORKOS_AUDIENCE` — defaults to `WORKOS_CLIENT_ID`; override only with a verified value.
- `WORKOS_STATE_ENCRYPTION_KEY` — ≥ 32 chars; absent ⇒ managed sign-in 503.
- `WORKOS_API_BASE` — optional override; default to the provider's documented base.
- `CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN` — non-secret vars (may be set in config).
- Leave unset on staging: `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`,
  `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` (payments disabled by design).

## 5. WorkOS redirect configuration (sandbox first)

- Enable AuthKit with **MFA required**, **email verification on**, social/SSO/magic-link **off**.
- Register the exact redirect URI, including scheme and host:
  `https://<staging-worker>.workers.dev/api/cafes/<slug>/owner/callback` (or the equivalent
  single-origin callback path the Worker exposes — confirm against the deployed route before
  registering).
- No Organizations mirroring in v1; D1 remains the membership authority.
- Create identities and claims only through the operator routes; never pre-seed `cafe_owners`.
- Record the observed `iss`, `aud`, `sid` shape and code lifetime from the sandbox; these are not
  yet verified (see §6).

## 6. Remaining WorkOS sandbox requirements (not yet verified)

The following cannot be established without a real sandbox and must be treated as unverified:

- Exact issuer string and audience handling.
- `sid` presence/shape and revoke semantics (`revoke_session`).
- Authorization-code lifetime and PKCE + client-secret flow.
- `email_verified` claim behaviour.
- JWKS rotation and caching.
- Rate limits and error-callback shape.
- Logout redirect behaviour.
- Whether `WORKOS_AUDIENCE` must be overridden from the default.

Until these are recorded from a sandbox, managed sign-in is "mocked locally only".

## 7. Staging-only secrets and handling

- All secrets are staging-scoped; never reuse production or local-dev values.
- Create staging values independently; do not copy `.dev.vars`.
- No secret value may be echoed in chat, logs, test fixtures or the bundle.
- `WORKOS_API_KEY` and `WORKOS_STATE_ENCRYPTION_KEY` are server-only and must not appear in
  client assets.

## 8. Rollback plan

- Rolling back code is safe: every phase-2B object is additive and unused by the password path.
  Leave the tables in place; do not drop them.
- `cafes.owner_auth` can be returned to `local` through the operator mode route; the transition is
  atomic, invalidates sessions and queues provider revocations.
- `pass_hash` is preserved in managed mode, so rollback to local sign-in remains possible.
- If a migration fails midway, restore D1 from the pre-migration backup and redeploy the previous
  Worker version; do not attempt partial repair.
- Unpublish the staging Worker (`published=false`) to take it offline without deleting data.

## 9. Verification steps (run against staging after deployment)

1. `/api/health` returns 200 with `database: ok`; no provider/config detail.
2. Security headers present (CSP, nosniff, X-Frame-Options, Referrer-Policy, Permissions-Policy,
   HSTS over https); no `Access-Control-Allow-Origin`.
3. Local-mode café: owner password sign-in succeeds; wrong password 401 + lockout.
4. Managed-mode café: login screen renders "managed identity" text; sign-in redirects to provider.
5. Callback success creates a session row + cookie; dashboard accessible.
6. Callback cancellation burns the state; no session created.
7. Callback replay returns 400.
8. Invalid JWT / non-member identity refused; no rows written.
9. Claim redemption works; mismatched email refused.
10. Logout removes the local session row; logout-all keeps the retained session's provider SID
    unrevoked.
11. `/api/cafes/:slug/admin/login` returns 410 for a managed café.
12. Guest ordering still works end to end (counter payment).
13. No provider token/session id/access token in browser storage, URLs or responses.
14. `provider_revocations` monitored; no row reaches 24 h expiry without review.

## 10. Outstanding risks

- Argon2id CPU/memory cost on the deployed runtime is unmeasured (local only).
- WorkOS sandbox behaviour unverified (§6).
- Payments disabled; Razorpay end-to-end unproven.
- Browser walkthrough of managed mode limited to mocked local provider (no real redirect tested).
- Tracking tokens never expire (accepted risk).
- No audit table for staff payment-state writes (attribution gap).
