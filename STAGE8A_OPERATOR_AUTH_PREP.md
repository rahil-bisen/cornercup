# Stage 8A — Operator authentication staging preparation

Read-only. No secrets set, no login attempted, no café or order created, no deploy, no migrations,
no production access, no Git operations.

## 1. Files inspected

`worker/api.js` (router + operator routes 316–599, rate limiter 1723–1760, cookie/session call sites),
`worker/session.js` (cookie builder, `issueToken`, `tokenClaims`, `checkOperator`, `ownerSession`,
CSRF 304–370), `worker/http.js` (json + security headers), `wrangler.staging.jsonc`,
`STAGE7_AUTH_FUNCTIONAL_READINESS.md`.

## 2. Operator authentication flow (as implemented)

| Layer | Detail |
|---|---|
| Gate | `authConfigured(env)` → without `ADMIN_SECRET` every operator route answers **503** before any work |
| Password | `String(env.OPERATOR_PASSWORD \|\| "").trim()`, compared with `constantTimeEqual(attempt, expected)`; no hashing, so no CPU risk; empty attempt or empty config ≠ match |
| Token | `expires.subject.signature`, subject `operator:<32 hex session id>`, HMAC-SHA256 over `expires.subject` keyed by `ADMIN_SECRET`; verified by recomputing and comparing in constant time; expired or malformed → null |
| Persistence | `operator_sessions (session_id, created, expires)`; `checkOperator` requires a live row (`expires > now`) — logout or logout-all deletes it, so a copied cookie dies immediately |
| Cookie | `staff_operator=<token>; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200; Secure` (Secure added only over https) — no `Domain`, so host-only. Not `__Host-`-prefixed |
| Lifetime | 12 h fixed from login (43 200 s), no sliding renewal and no separate absolute cap — a session simply expires; contrast owner sessions (12 h sliding, 24 h absolute) |
| CSRF | 32 random bytes returned to the console and stored only as `sha256` in `csrf_tokens`, bound to `sha256(session cookie)`; every mutation calls `verifyCsrf`, which requires (a) `Origin` present, not `null`, exactly equal to the deployment origin, and (b) an `x-csrf-token` whose hash matches a live row bound to the presenting cookie (constant-time binding compare) |
| Rate limit | `login:operator:<ipHash>` in `rate_limits`: 8 failures / 10 min → **429**; the counter is cleared on a successful login. Separately, every `/api/*` request counts against 600 req/min per IP hash (429 above) |
| Logout | `POST /logout` deletes the session row and its CSRF rows, then clears the cookie (`Max-Age=0`); if the DB delete fails it still clears the cookie and reports 500 |
| Logout-all | CSRF-protected; deletes every operator session and inserts a replacement in one atomic batch, clears all CSRF rows, returns a fresh cookie |
| Routes | `GET /session`, `POST /login`, `POST /logout`, `POST /logout-all`, `GET|POST /cafes`, `POST /cafes/:slug/reset-password`, `POST /cafes/:slug/auth-mode`, `GET|POST /cafes/:slug/owners`, `GET|POST /cafes/:slug/claims`, `DELETE …/owners/:id`, `DELETE …/claims/:id` |

## 3. Secret requirements and staging-only provisioning (values never generated here)

Two secrets, both set on the staging Worker only:

```bash
npx wrangler secret put ADMIN_SECRET     --config wrangler.staging.jsonc   # prompt: paste value
npx wrangler secret put OPERATOR_PASSWORD --config wrangler.staging.jsonc  # prompt: paste value
npx wrangler secret list --config wrangler.staging.jsonc                   # verify names only, never values
```

Guidance: `ADMIN_SECRET` should be ≥32 CSPRNG bytes (hex/base64); `OPERATOR_PASSWORD` ≥16 characters and
unrelated to any other credential. Provide them through the prompt or a local file path — never in a
committed file, never in chat.

Isolation: secrets are scoped per Worker on Cloudflare. `corner-cup-staging` is a different Worker from
production `corner-cup`, which has never been deployed and whose config still carries the placeholder
database id, so a staging secret cannot reach production, and no production secret exists to leak back.
`.dev.vars` stays local (gitignored) and is not uploaded.

## 4. Prepared HTTP tests (to run only in Stage 8B)

`B=https://corner-cup-staging.rahilbisen8.workers.dev`, `O=https://corner-cup-staging.rahilbisen8.workers.dev`

| # | Test | Request | Expected |
|---|---|---|---|
| 1 | Missing credentials | `curl -s -o /dev/null -w '%{http_code}' -X POST $B/api/operator/login -H 'content-type: application/json' -H "origin: $O" -d '{}'` | **401** |
| 2 | Incorrect password | same with `-d '{"password":"definitely-not-the-password"}'` | **401** `{"error":"That password doesn't match."}` |
| 3 | Correct password | same with the real value, `-c jar.txt` | **200** `{"ok":true,"expiresIn":43200,"csrfToken":"…"}` + `Set-Cookie: staff_operator=…; HttpOnly; Path=/; SameSite=Strict; Max-Age=43200; Secure` |
| 4a | Session with cookie | `curl -s -b jar.txt $B/api/operator/session` | **200** `{"ok":true,"expiresIn":…,"csrfToken":…}` |
| 4b | Session without cookie | `curl -s -o /dev/null -w '%{http_code}' $B/api/operator/session` | **401** `{"error":"Not signed in."}` |
| 5a | CSRF missing token | `curl -s -o /dev/null -w '%{http_code}' -X POST -b jar.txt -H "origin: $O" $B/api/operator/logout-all` | **403** |
| 5b | CSRF wrong origin | same with `-H 'origin: https://example.com'` and a valid `x-csrf-token` | **403** |
| 6 | Valid CSRF mutation (non-destructive) | `curl -s -o /dev/null -w '%{http_code}' -X POST -b jar.txt -H "origin: $O" -H "x-csrf-token: <token>" $B/api/operator/logout-all` | **200** `{"ok":true,"expiresIn":43200}` + rotated cookie |
| 7 | Logout | `curl -s -i -X POST -b jar.txt $B/api/operator/logout` | **200** `{"ok":true}` + `Set-Cookie: staff_operator=; … Max-Age=0` |
| 8 | Reuse after logout | `curl -s -o /dev/null -w '%{http_code}' -b jar.txt $B/api/operator/session` | **401** |
| 9 | Lockout | 8 × wrong password, then a 9th, then a correct one | first 8 → **401**, 9th and the correct one → **429** `{"error":"Too many attempts. Please try again in a few minutes."}`; correct login works again after the 10-minute window (a success also clears the counter) |

Order matters: run 1–8 first, then 9 **last**, because the lockout blocks the correct-password path for
10 minutes. Do **not** call `POST /api/operator/cafes` — it would create a café and hash a password
(Argon2 on a Free-plan Worker). `logout-all` is used as the “valid CSRF mutation” precisely because it
touches only `operator_sessions`/`csrf_tokens`.

## 5. Restrictions confirmed (live probes, read-only)

| Probe | Result |
|---|---|
| `GET /api/operator/session` | 503 “operator console isn't configured” (no secret) |
| `GET /api/cafes/corner-cup-staging/admin/session` | 503 (owner auth disabled) |
| `GET /api/cafes/corner-cup-staging/owner/start` | 409 `auth_mode_local` (WorkOS unconfigured, café in local mode) |
| `GET …/config` | `ownerAuth: local`, `payments {provider none, gateway false, keyId null}` |
| `POST …/orders` | 503 “Ordering isn't configured” (no tracking secret) |
| `POST …/razorpay/webhook` | 503 “Webhook is not configured” |
| DB rows | `cafes 1`, `menu_items 27`, `tables 8`, `orders 0`, `checkout_claims 0`, `operator_sessions 0`, `owner_sessions 0`, `csrf_tokens 0`, `rate_limits 1` |

The single `rate_limits` row is the transient per-IP counter created by the probes themselves (60-second
window). No café, session, order or customer record was created.

## 6. Remaining risks

1. `OPERATOR_PASSWORD` is a shared static credential: no per-person identity, no MFA, no audit of which
   human acted (audit rows carry the action, not a subject identity).
2. Lockout is per IP hash (8/10 min) — tests from behind one NAT can lock the tester out, and a distributed
   attacker is only slowed.
3. The global 600 req/min limiter is consumed by every API call, including failed logins.
4. Every `/api/*` request performs a `rate_limits` upsert, i.e. a D1 write per request — fine at staging
   volume, worth watching on Free tier.
5. Cookie is not `__Host-`-prefixed (host-only + `SameSite=Strict` + Origin check compensate).
6. Any operator action that hashes a password (create café, reset café password) is still subject to the
   Free-plan 10 ms CPU ceiling (Error 1102) — Stage 8B should avoid those routes.
7. After secrets are set, browse routes are unchanged but `/api/operator/*` becomes reachable by anyone who
   knows the password; staging stays publicly reachable, so use a long password and rotate after testing.

## 7. Recommendation

**GO** for Stage 8B operator authentication testing with `ADMIN_SECRET` + `OPERATOR_PASSWORD` provisioned
under separate approval, restricted to tests 1–9 above. **NO-GO** for café creation, password reset, owner
login or ordering in that stage — those need the paid-plan decision and further authorization.
