# Corner Cup — Operational Readiness & Staging Preparation

Documentation only. No infrastructure created, no secrets set, no deployment performed, no production D1
accessed. This document prepares Corner Cup for one controlled isolated staging validation cycle.

## 1. Database backup and restoration

### Architecture
- Storage: Cloudflare D1 (SQLite) bound as `DB`.
- Schema: `worker/db.js` `SCHEMA` + `MIGRATIONS` + `POST_MIGRATIONS` (all additive, idempotent).
- Tables: cafes, tables, menu_items, orders, order_items, checkout_claims, password_resets,
  csrf_tokens, rate_limits, operator_sessions, owner_sessions, owner_identities, cafe_owners,
  owner_login_states, auth_mode_transitions, operator_audit, tx_guard, owner_claims,
  provider_revocations.
- Auto-migration on first request via `ensureDb()`; duplicate ALTER COLUMN tolerated.

### Backup procedure (isolated test DB only)
1. `npx wrangler d1 export <DB_NAME> --local --output backup-<timestamp>.sql` (local) or
   `--remote` for a deployed DB.
2. Store the file outside the repository (never commit); record timestamp + row counts.
3. Verify file non-empty and contains `CREATE TABLE` + data rows.

### Backup verification
- Re-import into a fresh isolated DB and compare row counts per table (cafes, orders, menu_items,
  owner_sessions, provider_revocations).
- Spot-check a known order row and a café row.

### Restoration procedure
1. Create a fresh D1 (or use a restore-target DB).
2. `npx wrangler d1 execute <DB_NAME> --local --file backup-<timestamp>.sql`.
3. Run `ensureDb` (or the app) to apply any newer migrations; they are additive/idempotent.
4. Verify row counts and a sample query.

### Recovery-point / recovery-time considerations
- Recovery point: last successful export. Exports should be taken before any migration or
  deployment. D1 has point-in-time recovery on paid plans; Free plan relies on manual exports.
- Recovery time: export+import is seconds for this data size (~40 KB for 2 cafés/27 orders); full
  re-deploy + verify ~minutes.

### Migration compatibility
- All migrations are additive (ADD COLUMN / CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS).
- A restore from an older backup followed by app boot applies newer migrations automatically.
- No backfill of pass_hash; owner_auth defaults to 'local' (password flow preserved).

### Rollback procedure
- Restore from pre-change backup into the target DB; redeploy previous Worker version.
- Leave new tables in place (additive, unused by older code paths).
- `cafes.owner_auth` can be flipped back to `local` via operator mode route (atomic).

### Drill result (performed this session)
- Exported local `corner-cup` D1 → `tmp-backup.sql` (41,152 bytes).
- Imported into isolated `corner-cup-restore-drill` database.
- Verified: 2 cafés, 27 orders, 51 menu items restored and queryable.
- **PASS** — restored data usable. Drill artifacts removed after verification.

## 2. Argon2id runtime validation

### Implementation (worker/passwords.js)
- Algorithm: Argon2id, m=19456, t=2, p=1, 16-byte salt, 32-byte tag, PHC string.
- Library: argon2id@1.0.1 with statically imported simd.wasm / no-simd.wasm (workerd refuses
  WebAssembly.compile from bytes).
- Queue: one derivation per isolate + MAX_QUEUE=3 waiters; overflow → PasswordQueueFullError →
  429 "Too many sign-in attempts right now".
- Legacy PBKDF2 verified only up to 100,000 iterations; higher work factors fail closed
  (passwordNeedsReset → 409 "ask the operator to reset it").
- Sub-8-byte passwords fail closed (401 + lockout increment).

### Verification plan for staging
- Measure hash p50/p90 and verify p50/p90 in workerd on the actual Cloudflare runtime.
- Measure billed CPU milliseconds and per-isolate memory (Workers dashboard Memory Usage chart,
  Error 1102 counts).
- Test Free plan: may exceed the 10 ms CPU budget → Error 1102 (unknown until measured). Paid plan (default 30 s CPU,
  128 MB isolate memory) should be comfortable on CPU, tight on memory.
- Test concurrent login burst (3 concurrent → 3 ok; 6 concurrent → 4 ok / 2 refused / 0 errors)
  on staging.
- Test queue overflow returns 429, not 500.
- Test legacy PBKDF2 100k verifies and 600k fails closed.
- Test D1 failure paths (harness fault injection already covers; staging smoke-test).

### Probe timings (2026-11-22, real Workers runtime) — correctly labelled

A temporary probe Worker (`corner-cup-cpu-probe`) was deployed to the real Cloudflare runtime,
exercised, and deleted (post-delete URL returns 404). Account usage model is `standard` (paid).
What the probe recorded was **elapsed response time**, which includes scheduling, request handling
and response writing — not platform-reported CPU time.

| Endpoint | Elapsed time (ms), wall-clock |
| --- | --- |
| `/login` (correct password) | 65 / 67 / 68 |
| `/wrong` (wrong password) | 53 / 62 / 67 |
| `/ping` | 0 |

**Workers Free compatibility is unresolved.** The 65–68 ms figures are wall-clock elapsed time and do
not independently establish CPU consumption, so they cannot prove that the 10 ms per-request ceiling
is exceeded. The question is settled only by platform-reported CPU time for a real login in the
deployed Worker (per-request CPU in `wrangler tail`, or the Workers CPU histogram). Argon2id remains at
`m=19456, t=2, p=1`.

### Constraints
- Do not weaken Argon2id parameters.
- Do not change Cloudflare plans without explicit approval, and not on the strength of wall-clock time.
- Do not claim local workerd measurements represent billed Cloudflare CPU — and do not treat the
  probe's elapsed time above as billed Cloudflare CPU either.

## 3. WorkOS sandbox requirements

### Exact environment variables
- WORKOS_CLIENT_ID (public)
- WORKOS_API_KEY (server-only)
- WORKOS_REDIRECT_URI (must exactly match `/api/owner/callback` on staging origin)
- WORKOS_ISSUER (pin exact string from sandbox)
- WORKOS_AUDIENCE (defaults to CLIENT_ID; override only with verified value)
- WORKOS_STATE_ENCRYPTION_KEY (≥32 chars; absent → 503, no plaintext fallback)
- WORKOS_API_BASE (optional override)

### Redirect URI requirements
- Register exact URI including scheme and host: `https://<staging>.workers.dev/api/cafes/<slug>/owner/callback`
  (confirm against deployed route before registering).
- One callback per slug or a single origin-level callback depending on implementation.

### Issuer and audience expectations
- JWT `iss` must exactly match WORKOS_ISSUER (single string, not array).
- `aud` strict: absent/wrong/array forms rejected.
- Algorithm pinned to RS256; JWKS fetched and cached with bounded refetch.
- `exp`, `iat`, `nbf` enforced with bounded skew.
- Subject must match expected identity.

### MFA requirements
- AuthKit MFA required, email verification on, social/SSO/magic-link off.
- No Organizations mirroring in v1; D1 remains membership authority.

### Email verification behavior
- Require `email_verified` claim; unverified identities refused.

### PKCE behavior
- State encrypted with WORKOS_STATE_ENCRYPTION_KEY; PKCE verifier stored AES-GCM encrypted in
  owner_login_states.code_verifier_enc; single-use via conditional UPDATE on used_at.

### JWT verification
- `worker/workos.js` + `worker/jwt.js`: RS256, kid selection, refetch on unknown key once,
  claims validation (iss, aud, exp, iat, nbf, sub, sid shape).

### Provider SID handling
- workos_session_id stored on owner_sessions; revoked via provider revoke_session.
- NULL SIDs (password-flow sessions) never enqueued for revocation.
- Durable provider_revocations queue: dedup, 5 attempts, 24h expiry, backoff, lease serialization.

### Logout and revocation behavior
- Ordinary sign-out deletes the local session row + CSRF rows.
- Logout-all bumps auth_version (CAS), kills all other sessions, retains acting session, enqueues
  provider SIDs for revocation, never revokes retained session's SID.
- Mode transition local→workos and reverse: atomic, invalidates sessions, queues revocations, audit row.

### Sandbox verification checklist (to run once credentials exist)
1. Sign in with member identity → cookie + dashboard + session row.
2. Sign in with non-member → 403, no identity/membership/session rows.
3. Cancel at provider → state burned, no session.
4. Replay callback URL → 400.
5. Sign out → local row gone, provider session revoked.
6. Logout-all with two devices → retained keeps working, other refused.
7. Switch café local→workos and back → sessions invalidated, audit trail both transitions.
8. `/api/cafes/:slug/admin/login` → 410 for managed café.
9. No provider session id, access token or client secret in any response or log.
10. Record observed iss, aud, sid shape, code lifetime, rate limits, error-callback shape, logout redirect.

## 4. Razorpay sandbox requirements

### Implementation (worker/orders.js, worker/api.js)
- Order creation: server-calculated total from D1; client amount/currency ignored.
- Amount and currency validation: exact equality to total_cents, INR only.
- Signature verification: HMAC-SHA256(order_id|payment_id, KEY_SECRET) constant-time.
- Payment re-fetched from gateway: must be captured, same order_id, exact amount, INR.
- Webhook: raw body, X-Razorpay-Signature HMAC-SHA256 with WEBHOOK_SECRET, constant-time.
- Settlement: single conditional UPDATE (payment_status != 'confirmed'); idempotent.
- Claim with TTL prevents duplicate gateway orders; stalled gateway fails safely.
- payment.failed only moves unpaid → failed.

### Sandbox verification checklist (test mode only)
1. Create Razorpay test account; generate test keys.
2. Set RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET as staging secrets.
3. Register webhook URLs for both spellings:
   - /api/cafes/:slug/razorpay/webhook
   - /api/cafes/:slug/webhooks/razorpay
   Events: payment.captured, order.paid, payment.failed.
4. End-to-end: create order → pay via Checkout (test card/UPI) → verify settles ticket.
5. Webhook replay → idempotent (no double settle, no double alert).
6. Failed payment → order stays unpaid, retry possible.
7. Amount mismatch → acknowledged, never settled.
8. Bad signature → 400, nothing changes.
9. Verify CSP allows Razorpay script/style/frame/connect on https origin.
10. Confirm no keys in bundle/logs.

### Refund requirements (future)
- No refund handling currently; document that refunds require manual processing + a future
  reconciliation job. Out of scope for this staging cycle.

### Reconciliation requirements (future)
- Daily reconciliation of gateway captures vs settled orders; not implemented. Manual review
  for staging.

## 5. Staging architecture

### Resources (create only with explicit approval)
- Worker: `corner-cup-staging` (or similar), Workers Free plan (do not upgrade).
- D1: `corner-cup-staging` (isolated, disposable), bound as `DB`.
- Static assets via existing `assets` binding; `/api/*` runs first (run_worker_first: true).
- No KV/R2/Queue/Durable Object required for Phase 2B.

### Staging-only secrets
- All secrets staging-scoped; never reuse production or local-dev values.
- Set independently; do not copy .dev.vars.
- No secret echoed in chat/logs/fixtures/bundle.

### Routes
- Use `*.workers.dev` origin; record exact origin for WorkOS redirect URI.
- No custom domain required for first pass.

### Logging and monitoring
- Wrangler observability enabled.
- Watch 5xx on /api/owner/callback and /api/cafes/*/owner/*.
- Watch provider_revocations for rows nearing 24h expiry.
- Watch owner_login_states growth (opportunistic pruning).
- Watch operator_audit rows for switch_auth_mode, grant_owner, revoke_owner, claim_redeemed.
- Watch Error 1102 (CPU) and memory usage for Argon2id.

### Backup and rollback
- See §1. Back up D1 before migrations; restore from backup on failure; unpublish
  (published=false) to take offline without deleting data.

## 6. Exact environment variable names

Required:
- ADMIN_SECRET
- OPERATOR_PASSWORD (≥12 chars)
- OWNER_PASSWORD (first-boot seed only, 12–100 chars)
- ORDER_TRACK_SECRET (optional; derives from ADMIN_SECRET if absent)
- WORKOS_CLIENT_ID
- WORKOS_API_KEY
- WORKOS_REDIRECT_URI
- WORKOS_ISSUER
- WORKOS_AUDIENCE (default CLIENT_ID)
- WORKOS_STATE_ENCRYPTION_KEY (≥32 chars)
- WORKOS_API_BASE (optional)
- CAFE_NAME, SERVICE_MODE, CAFE_TZ_OFFSET_MIN (non-secret vars)

Leave unset on staging (payments disabled):
- RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET
- TELEGRAM_BOT_TOKEN, TELEGRAM_OWNER_CHAT_ID

Set only when testing payments:
- RAZORPAY_KEY_ID, RAZORPAY_KEY_SECRET, RAZORPAY_WEBHOOK_SECRET

## 7. Outstanding risks
1. Argon2id CPU on Workers Free is **unresolved**: the only figures on record (~65–68 ms) are elapsed wall-clock timings, not platform CPU time. If a real measurement exceeds the 10 ms per-request ceiling, the choice is Workers Paid or an approved design change. Memory usage on the paid isolate is still unmeasured (B-2).
2. WorkOS sandbox behaviour unverified (issuer, sid, revoke, code lifetime, PKCE, email_verified, JWKS, rate limits, error-callback, logout redirect).
3. Razorpay disabled; end-to-end unproven; no refund/reconciliation.
4. Tracking tokens never expire (accepted risk).
5. No audit table for staff payment-state writes (attribution gap).
6. Provider revocation queued, not guaranteed (24h expiry).
7. No historical analytics/export.
8. No operator membership UI (API tested only).

## 8. Staging readiness decision

**CONDITIONALLY READY for one controlled isolated staging validation cycle.**

All local verification is complete: 424/424 tests pass, production build succeeds, npm audit 0
vulnerabilities, backup/restore drill passed. Remaining blockers are environment-side and require
explicit operator approval: create isolated D1, set staging secrets, configure WorkOS/Razorpay
sandboxes, deploy staging Worker, run verification checklist. No infrastructure created or
deployed by this document.

---

## Addendum — 2026-11-22 (Stage 17B)

Suite total is now **492/492** (was 424 at the time of the section above); build green at
293.33 kB JS / 94.22 kB gzip; `npm audit` 0.

New in this stage, all verified locally:

- Owner MFA: RFC 6238 TOTP, verified enrollment, two-step login, encrypted seeds, single-use hashed
  recovery codes, replay protection on codes, challenges and recovery codes.
- Session control: inventory, per-session revoke, revoke-all, per-request membership gate, and
  invalidation on any MFA change.
- CSRF on all ten mutating owner routes, enforced before body parsing.
- `auth_events` audit log for every authentication outcome.

Additional outstanding risks (beyond 1–8 above):

9. Security tab implemented but not visually inspected (F-36).
10. `ADMIN_SECRET` doubles as the MFA key when `MFA_ENC_KEY` is unset (F-33) — set the dedicated key
    before enrolling production owners.
11. Operators can clear an owner's MFA to restore access; that action is authenticated but relies on
    operator discipline and is only visible after the fact in `auth_events`.

Readiness decision is unchanged in kind: **CONDITIONALLY READY** for controlled staging validation,
now with a second factor on the owner surface. Nothing was deployed in this stage.

---

## Addendum — 2026-11-22 (one-pass final completion)

**Image storage is now wired.** `wrangler.jsonc` declares `r2_buckets` → `IMAGES` /
`corner-cup-images`. Previously the repository's own configuration produced a Worker with no
`env.IMAGES`, so photo uploads would have answered 503 on any deployment (F-38, now fixed). Creating
the bucket remains an account action; the deploy fails loudly until it exists rather than shipping a
half-configured upload path.

**Verified this pass:** 492/492 tests, build 293.59 kB JS (94.32 kB gzip), audit 0 on both trees,
`node --check` clean, image self-test 7/7, and a real HTTP image round trip through local R2
simulation — 18/18 checks including upload, `image/png` + `nosniff` serving, cross-café refusal, CSRF
refusal, non-image refusal, 413 on oversize, removal and default restoration.

**Free tier, measured from the Sites quota endpoint:** 1 GB R2 storage, 25,000 R2 writes and 250,000
R2 reads per month; 100 MB D1 storage, 50M D1 rows read, 100k D1 rows written per month; 100,000 site
requests and 5,000,000 ms CPU per month. For one café this is comfortable; the D1 storage figure is
the one to watch, and it is well below Cloudflare's standalone 5 GB D1 allowance.

**Still open:** Workers-Free per-invocation CPU for Argon2id — a probe on the real runtime recorded
roughly 65–68 ms of *elapsed* time per login, which is not a CPU measurement and therefore does not
settle the 10 ms Free ceiling. Production backup, Razorpay live verification, WorkOS (keep dormant), and a human click-through of
the board remain open. `ADMIN_SECRET` still doubles as the MFA key when `MFA_ENC_KEY` is unset.
R2 is disabled on the account (error 10042); bucket creation is blocked until the owner enables it.

Readiness decision is unchanged in kind: **CONDITIONALLY READY** for a controlled first-café pilot
once a bucket, secrets, one deployment and about ten minutes of human clicking exist.

---

## Addendum — 2026-11-23 (all-in-one launch-readiness pass)

**Re-verified today:** 492/492 tests (twice, before and after the only edit), build exit 0
(293.70 kB JS / 94.32 kB gzip), `npm audit` 0 on both trees, `node --check` clean, image self-test
7/7, disposable DB drill 13/13, encrypted-backup round trip byte-identical with a clean integrity and
foreign-key check.

**Browser acceptance:** guest menu and checkout at 360/390/430/1280 with no horizontal overflow and no
control under 24 px; pickup #1 at ₹400 with the kitchen note preserved and the tracking token only in
the URL fragment; invalid tracking link shows a friendly error; owner sign-in rejects a wrong password
without setting a cookie.

**Fixed:** error messages on the sign-in, operator and payment screens were not announced to
assistive technology; `role="alert"` was added and verified live (F-39).

**Unchanged blockers:** R2 is disabled on the account (`code 10042`); the free Sites R2 allowance is
1 GB with 0 used, but a Sites bucket can only be attached by deploying Project A, which is prohibited.
Argon2id login timings on record (~65–68 ms) are elapsed wall-clock, not Workers CPU; Free-plan
compatibility stays unresolved until platform CPU time is measured. Production D1 existence and
status also remain unresolved: Stage 16A identified `site-6e1c6f7a9a9f4e098f778f9754221b0a` /
`17d9568d-52fd-48c2-8761-b74d97688589` under a different Freebuff account, and this account's
`wrangler d1 list` simply does not show it. No production export or backup exists; the procedure is
proved on a disposable database.

Readiness decision is unchanged: **CONDITIONALLY READY** for a controlled first-café pilot once R2 is
enabled, a Workers plan is chosen, secrets are set and a human completes the acceptance checklist.
