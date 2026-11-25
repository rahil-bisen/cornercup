# Stage 7 — Authentication and functional staging readiness (investigation only)

Date: 2026-11-16. Read-only: nothing deployed, no secrets set, no login/order/payment attempted, no
database writes, no production access, no Git operations.

## 1. Deployed-state verification

| Check | Result |
|---|---|
| Worker version | `c1204e32-0fa6-48a4-9be1-01b1f050ead7`, 100% of traffic (deployment `2026-11-16T19:12:42.306Z`) |
| D1 | `corner-cup-staging` / `39a7899c-0130-4536-9570-f07b6c29b2d4` — the only database in the account |
| `/api/health` | 200 `{"status":"ok","database":"ok"}` |
| `/api/cafe` | 200 `{"slug":"corner-cup-staging","name":"Corner Cup Staging","serviceMode":"counter"}` |
| `/api/cafes/corner-cup-staging/menu` | 200, 5 categories / 27 items |
| `/api/cafes/corner-cup-staging/config` | 200, `ownerAuth local`, `payments {provider none, gateway false, keyId null}` |
| Assets | `/assets/index-galoeRp-.js` 200 `text/javascript`, `/fonts/inter-latin.woff2` 200 `font/woff2` |
| Secrets | `[]` |
| Auth gating | `/api/operator/session` 503, `/api/cafes/:slug/admin/session` 503, `/api/cafes/:slug/owner/start` **409** `auth_mode_local` |
| Production | untouched; production config still `corner-cup` + placeholder id `00000000-…` |

## 2. Authentication options

| Dimension | A. Paid Workers + existing Argon2id | B. WorkOS AuthKit for owners (local kept) |
|---|---|---|
| Security | Password hash in D1 at OWASP baseline (m=19456, t=2, p=1), per-café `pass_hash`, no vendor exposure of credentials. No MFA, no email verification, no per-person identity. | Credentials held by WorkOS; JWT verified locally (JWKS, `iss`/`aud`/`sub`, bounded body); MFA, passkeys, magic auth, email verification available. New trust and availability dependency. |
| Monthly cost | $5/mo floor; 30 M CPU-ms included (~600 k hash/verify ops at ~50 ms), then $0.02/M ms; requests included in plan. | AuthKit free to 1 M MAU; **staging environments not billed**; enterprise SSO $125/connection (1–15), $100 (16–30), $80 (31–50), $65 (51–100); Directory Sync the same; custom domain $99/mo. |
| Implementation change | None — Stage 6 already runs the code; only a plan decision. | No code: `owner.js`, `workos.js`, `pkce.js`, `jwt.js`, `revocations.js`, `authmode.js` and the `owner_*`/`cafe_owners`/`provider_revocations` schema all exist and are migrated. Needs a WorkOS application, redirect URI `/api/owner/callback`, six `WORKOS_*` secrets, and a per-café mode switch from the operator console. |
| Operational complexity | One platform, one secret family (`ADMIN_SECRET` etc.), password resets are operator-driven. | Two platforms; tenant/redirect management per environment; login depends on WorkOS uptime; local harness can no longer reproduce logins without tenant credentials. |
| Multi-café identity | One shared password per café (`cafes.pass_hash`); no per-person identity, so staff turnover means rotating a shared password. | `cafe_owners (cafe_id, workos_user_id, role)` — one identity, many cafés, per-person roles and revocation; invite claims (`owner_claims`) bind a person to a café. |
| MFA / email verification | None. No email is collected for owners at all. | Built in (MFA, passkeys, magic auth, verified email), plus self-service reset instead of operator-mediated reset. |
| Session revocation | `owner_sessions` rows; `auth_version`/`auth_mode_generation` bumps log every device out; per-device delete on sign-out. | Same local session table **plus** provider session revocation queued in `provider_revocations` with attempts/backoff/lease, so a revoked WorkOS session is retried until confirmed. |
| Rollback | Revert the deployment; no data change. | Per-café atomic mode switch (CAS on `auth_mode_generation` + `auth_mode_cas_token` + `tx_guard` + immutable `auth_mode_transitions` row); a café can be returned to `local` without touching its password hash. Mixed modes are supported by design. |

**Recommendation.** Treat these as complements, not alternatives: keep Argon2id local mode as the default
and the only path that works on a single-café staging deployment, and adopt WorkOS per café when a real
multi-owner outlet needs per-person identity, MFA or self-service reset. For staging itself, the paid plan
(Option A) unblocks password flows with zero code change; Option B is the production-grade direction but
needs a tenant and six secrets, which is a separate authorization.

## 3. Operator readiness

Implementation (`worker/api.js` operator routes, `worker/session.js`):

- **Secrets:** `ADMIN_SECRET` (required; HMAC-SHA256 signing of the session cookie and CSRF derivation) and
  `OPERATOR_PASSWORD` (required; compared in constant time with `constantTimeEqual` after trimming). No
  hashing anywhere on this path.
- **Session:** random session id persisted in `operator_sessions (session_id, created, expires)`; cookie is
  HttpOnly, SameSite-scoped; idle 12 h, absolute 24 h; sign-out deletes the row so a copied cookie dies.
- **CSRF:** 32 random bytes issued per session, only `sha256(token)` stored in `csrf_tokens` bound to the
  session; every mutation requires a matching `origin` header *and* a live `x-csrf-token` row bound to the
  presenting cookie (constant-time compare of bindings).
- **Rate limiting:** per-IP-hash lockout `login:operator:<ipHash>`, 8 failures per 10 min → 429, cleared on
  success; plus the global `/api/*` limiter of 600 requests/min per IP hash.
- **CPU profile:** constant-time compare + one INSERT + one DELETE — single-digit milliseconds, i.e. safe on
  Workers Free. The only Argon2 usage reachable from the console is when it must hash a café's password
  (create café, owner password reset), which is the same 1102 risk as owner login.

Verdict: the operator implementation is sound and **Free-plan safe for its own login**, but it is a shared
static credential with no per-person identity or audit of *which* operator acted. Acceptable for staging;
production should rotate it and consider per-operator accounts later.

## 4. Ordering readiness

`POST /api/cafes/:slug/orders` (`createOrder`) and the guest read path (`GET …/orders/:id`):

- **Required secret:** `ORDER_TRACK_SECRET` or `ADMIN_SECRET` — with neither, the route answers 503 before
  touching the database (this is why ordering is currently closed on staging).
- **Writes per order:** `checkout_claims` row (state `claimed` → `committed`, with lease + fingerprint),
  one `orders` row, N `order_items` rows, all in one guarded `batch` (`INSERT … SELECT … WHERE EXISTS`
  against the claim). Counter orders allocate `queue_no = MAX+1` per café per local day; `track_nonce` (24
  random bytes) and `track_hash` are stored, the token itself is never persisted.
- **Idempotency:** `Idempotency-Key` header; `INSERT OR IGNORE` claim reservation, lease takeover for dead
  claims, `replayed` / `in_progress` / `key_reused` responses, fingerprint over café+table+note+payment
  method+normalized items (prices deliberately excluded). Requires `isIdempotencyIndexReady()`, which is
  true on staging since first boot.
- **Guest tracking security:** token = `HMAC(key, "v1:cafe:order:nonce")` presented as the `x-order-token`
  header; only its SHA-256 is compared (constant-time); a DB dump yields nothing replayable.
- **Rate limiting:** only the global 600 req/min per-IP-hash limiter — there is no per-order or per-café
  throttle, which is acceptable at staging volume but worth noting for production.
- **Counter vs payments — the important finding:** `normalizeCheckoutBody` maps a checkout to
  `paymentMethod: body.paymentMethod === "counter" ? "counter" : "razorpay"`. **The current frontend
  hardcodes `paymentMethod: "razorpay"` (`src/pages/Menu.jsx:205`) with no branch on `payments.gateway`.**
  So on staging, an order placed through the UI is created with `payment_method='razorpay'`,
  `payment_status='unpaid'`, and the guest is then routed to the Razorpay panel, which answers 503. Counter
  ordering is therefore testable **only** by sending `paymentMethod: "counter"` explicitly (an API-level
  test), or after a small frontend change — which is outside this stage's scope.

## 5. Argon2id runtime assessment

Parameters unchanged: `m=19456 KiB`, `t=2`, `p=1`, bounded queue 3. Observed staging CPU for browse routes:
1–3 ms (`wrangler tail`), so nothing hashing has run.

Safe observation plan (one shot, no hammering): authorise a single owner-login POST with a deliberately
wrong password, and read the *first* tail event for that request:

- `outcome: "ok"` + 401/503 → the request completed inside the Free 10 ms budget (unlikely at ~50 ms).
- `outcome: "exceededCpu"` → Error 1102 confirmed; stop, do not retry, record it as the plan limitation.
- `cpuTime` in the tail event gives the measured figure either way.

Do not loop, do not parallelise, do not lower the parameters and do not touch the plan without approval.

## 6. Stage 8–10 test plans

**Stage 8 — owner authentication (needs: `ADMIN_SECRET`, `OWNER_PASSWORD` or operator-issued reset;
paid plan or accepted 1102).** One controlled login: wrong password → 401 counted, then correct password →
session cookie set; `GET …/admin/session` 200 with CSRF; one CSRF-less mutation rejected (403); sign-out
kills the cookie; `logout-all` invalidates other devices. Authorisation needed: secrets, auth testing.

**Stage 8 — operator authentication (needs: `ADMIN_SECRET`, `OPERATOR_PASSWORD`).** Login, session,
CSRF-gated mutation, logout, lockout after 8 failures. Free-plan safe. Authorisation needed: secrets,
login testing.

**Stage 9 — counter ordering (needs: `ORDER_TRACK_SECRET` or `ADMIN_SECRET`).** Authorized only at the API
level until the frontend sends `"counter"`: POST with `paymentMethod:"counter"` → 200 with `trackToken`,
`queue_no` allocated; identical replay returns the same order; changed cart under the same key → 409
`key_reused`; concurrent same-key requests → one order. Writes: one claim, one order, N items. Authorisation
needed: secret + explicit order-creation approval.

**Stage 9 — guest order tracking (needs: a created order).** `GET …/orders/:id` with the token → 200;
without / with a wrong token → 404; after status change the same token still reads. Authorisation needed:
order creation.

**Stage 10 — WorkOS sandbox (needs: six `WORKOS_*` secrets, a sandbox application, redirect URI
`/api/owner/callback`, and a café switched to `workos`).** Start → authorize → callback → session; claim
(invite) flow; unknown/expired state rejected; revocation propagates through `provider_revocations`; mode
switch back to `local` audited atomically. Authorisation needed: secrets + identity provider setup; also a
mode switch (a data mutation).

**Stage 10 — Razorpay sandbox (needs: three `RAZORPAY_*` secrets, a sandbox account, webhook URL).**
Create payment → verify → webhook with a valid signature; replay/idempotent settlement; refunds out of
scope. Authorisation needed: payment provider activation and real (sandbox) transactions.

**Stage 10 — tenant isolation (needs: a second café; creating one needs operator auth).** Cross-café reads
with another café's slug or ids → 404; order/claim keys scoped per café; `checkout_claims` and
`idempotency_key` uniqueness proven per café; menu/tables scoping. Authorisation needed: operator login and
a data-creation step.

## 7. Required secrets (still outstanding, none set)

| Secret | Unblocks |
|---|---|
| `ADMIN_SECRET` | Owner + operator sessions, CSRF, order tracking fallback, ordering |
| `ORDER_TRACK_SECRET` | Ordering/tracking independent of session-key rotation |
| `OPERATOR_PASSWORD` | `/operator` console (multi-café, mode switch, café creation) |
| `OWNER_PASSWORD` | Optional first-boot password seed for the primary café only |
| `WORKOS_*` (6) | Managed owner identity (Stage 10) |
| `RAZORPAY_*` (3) | Payments (Stage 10) |

## 8. Remaining blockers

1. Workers Free plan (10 ms CPU) vs ~50 ms Argon2id — owner password paths will fail with 1102; nothing
   hashing has run on staging yet.
2. No secrets at all: owner login, operator console, ordering and tracking are all closed (503).
3. Frontend hardcodes `paymentMethod: "razorpay"`; with payments unconfigured every UI-placed order ends in
   the 503 Razorpay panel. Counter ordering needs the explicit `"counter"` value or a UI change.
4. No per-café order throttle (global limiter only).
5. Operator auth is a shared static credential with no per-person identity.
6. WorkOS path has no live-tenant coverage yet.

## 9. Recommendation

- **GO** for Stage 8 in the *operator-only* slice (Free-plan safe, no hashing): provision `ADMIN_SECRET` +
  `OPERATOR_PASSWORD` under separate approval and test the console.
- **NO-GO** for owner password login until the plan decision (paid Workers) is approved — otherwise the
  test is expected to end in Error 1102.
- **NO-GO** for UI-driven counter ordering until the `paymentMethod` mismatch is decided (API-level counter
  tests are fine with an ordering secret).
- Staging remains browse-only and correct as deployed.
