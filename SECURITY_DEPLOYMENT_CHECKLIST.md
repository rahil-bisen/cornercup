# Corner Cup — Security Deployment Checklist

Documentation only. Nothing in this file was executed.

## 1. Required secrets and variables

| Name | Required for | Notes |
|---|---|---|
| `ADMIN_SECRET` | every session and tracking token | absent ⇒ owner/operator sign-in answers 503 by design |
| `OPERATOR_PASSWORD` | operator console | ≥ 12 characters; independent of any café password |
| `OWNER_PASSWORD` | first-boot seed only | seeds the **primary** café once, only while `pass_hash IS NULL`; never a fallback |
| `ORDER_TRACK_SECRET` | guest tracking | optional; derives a separate subkey from `ADMIN_SECRET` when absent |
| `WORKOS_CLIENT_ID` | managed sign-in | public value |
| `WORKOS_API_KEY` | managed sign-in and revocation | server-only; never reaches the bundle |
| `WORKOS_REDIRECT_URI` | OAuth callback | must exactly match `/api/owner/callback` on the deployed origin |
| `WORKOS_ISSUER` | JWT `iss` | pin the exact string observed in the sandbox |
| `WORKOS_AUDIENCE` | JWT `aud` | defaults to `WORKOS_CLIENT_ID`; override only with a verified value |
| `WORKOS_STATE_ENCRYPTION_KEY` | PKCE state encryption | ≥ 32 chars; absent ⇒ managed sign-in 503, no plaintext fallback |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | payments | leave unset; the UI falls back to counter payment |

Do not put any of these in the repository, the bundle, test fixtures or logs. No secret was created,
rotated or read during this audit.

## 2. Migrations

Apply in order; every statement is additive and idempotent (`CREATE ... IF NOT EXISTS`, and
`ALTER TABLE ... ADD COLUMN` tolerated when already present).

- Phase 1: `cafes.owner_auth`, `owner_identities`, `cafe_owners`, `owner_login_states`,
  `owner_sessions.workos_user_id`, `owner_sessions.workos_session_id`.
- Phase 2A: `cafes.auth_mode_generation`, `cafes.auth_mode_cas_token`, `auth_mode_transitions`,
  `operator_audit`, `tx_guard`, the generation-step trigger and its indexes.
- Phase 2B: `owner_login_states.{code_verifier_enc,claim_hash,return_to}`, `owner_claims`,
  `provider_revocations`, `cafes.auth_version_cas_token`, and the three phase-2B indexes.

Verify after applying: a fresh database, an existing database and a legacy database all converge on the
same shape, and a second run is a no-op. No backfill is performed and no `pass_hash` is rewritten.

## 3. Cloudflare configuration

- Workers **Free** plan; do not upgrade to work around limits.
- D1 binding `DB` for the environment; no public read/write access.
- Static assets served by the Worker; `/api/*` never cached (`cache-control: no-store`).
- No custom CORS configuration is needed or wanted (same-origin only).
- Do not add a route that bypasses the Worker for `/api/*`.

## 4. WorkOS configuration (sandbox first)

- Enable AuthKit with **MFA required**, **email verification on**, and social/SSO/magic-link **off**.
- Register the exact redirect URI, including scheme and host.
- No Organizations mirroring in v1. D1 remains the membership authority.
- Create identities and claims only through the operator routes; never pre-seed `cafe_owners` by hand.

## 5. Payments

Keep Razorpay disabled. Enabling it requires a separate authorisation, live-gateway verification,
refund handling and a reconciliation job — none of which exist today.

## 6. Backup and rollback

- Back up D1 before applying migrations.
- Rolling back code is safe: every phase-2B object is additive and unused by the password path. Leave
  the tables in place rather than dropping them.
- `cafes.owner_auth` can be returned to `local` through the operator mode route; that transition is
  atomic, invalidates sessions and queues provider revocations.
- `pass_hash` is preserved in managed mode so a rollback to local sign-in remains possible.

## 7. Monitoring

- Watch 5xx on `/api/owner/callback` and `/api/cafes/*/owner/*`.
- Watch `provider_revocations` for rows nearing `expires` (24 h) — those are provider sessions that may
  survive.
- Watch `owner_login_states` growth; expired rows are pruned opportunistically.
- Watch operator audit rows for `switch_auth_mode`, `grant_owner`, `revoke_owner`, `claim_redeemed`.

## 8. Post-deployment verification (after a real sandbox is configured)

1. Sign in with a member identity; confirm the cookie, the dashboard and a session row.
2. Sign in with a non-member identity; confirm 403 and no identity/membership/session rows.
3. Cancel at the provider; confirm the state is burned and no session exists.
4. Replay the callback URL; confirm 400.
5. Sign out; confirm the local row is gone and the provider session is revoked.
6. Logout-all with two devices; confirm the retained device keeps working and the other is refused.
7. Switch a café `local → workos` and back; confirm sessions are invalidated and the audit trail has
   both transitions.
8. Confirm `/api/admin/login` answers 410 for a managed café.
9. Confirm no provider session id, access token or client secret appears in any response or log.
