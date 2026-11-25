# PRODUCTION CONFIGURATION INVENTORY

**Date:** 2026-11-24 · **Nature:** documentation only. No secret was read, printed, set, rotated or deleted; no
binding was created, changed or removed.

**How values were established:** names and presence from `.dev.vars.example` (the committed template),
`wrangler.jsonc`, `worker/` source, `wrangler secret list --name corner-cup-staging` (names only — the command
returns no values), and `sites_inspect` on the old production environment (binding names and kinds only —
secret values are never returned by that tool). Local `.dev.vars` exists on this machine but was **not read**.

Legend: **Required** = the app cannot serve that function without it · **Verified** = how this review knows it
exists (source read, binding listed, or not at all).

---

## 1. Three configurations, never to be confused

| | Local development | Staging | Future production |
|---|---|---|---|
| Worker | `wrangler dev` (workerd on this machine) | `corner-cup-staging`, version `80f92ceb…`, live at `https://corner-cup-staging.rahilbisen8.workers.dev` | not deployed; `corner-cup` does not exist on the account (`10007`) |
| Database | local D1 | `corner-cup-staging` / `39a7899c-0130-4536-9570-f07b6c29b2d4` | to be provisioned; the old prod DB is `17d9568d-…` under Freebuff's account (see `EXTERNAL_BLOCKER_ESCALATION_PACKET.md` §2) |
| Object storage | simulated R2 (`wrangler dev` banner) | none bound | `IMAGES` → `corner-cup-images`, blocked on R2 enablement |
| Secrets source | `.dev.vars` (present, not read) | `wrangler secret` | `wrangler secret` / Sites → Secrets |
| Auth model | same code | password + TOTP | password + TOTP, per-café |

---

## 2. Secrets and variables

### 2.1 Required for any authenticated surface

| Name | Purpose | Required | Where configured | Verified | Current state |
|---|---|---|---|---|---|
| `ADMIN_SECRET` | Signs owner/operator session tokens and CSRF bindings. **No longer used for MFA encryption** | **Yes** — without it every auth route answers 503 (`authConfigured`) | `.dev.vars`; `wrangler secret put ADMIN_SECRET` | Read in `worker/session.js` (`sign`, `authConfigured`) | Local: present. Staging: **set**. Old prod env: **set** (name only). Future prod: **missing** |
| `OPERATOR_PASSWORD` | Unlocks `/operator`, the console that creates cafés and resets owner passwords | **Yes** for onboarding (empty closes the console with 503) | `.dev.vars`; secret | Read in `worker/api.js` (`/api/operator/login`) | Local: present. Staging: **set**. Old prod env: **set**. Future prod: **missing** |
| `MFA_ENC_KEY` | HKDF material for the AES-256-GCM key that encrypts each café's TOTP secret at rest (`v2.` envelope) | **Yes for two-factor sign-in** — the code has no fallback: missing or malformed means `mfaConfigured=false`, enrollment answers 503, and an existing seed fails closed (503) rather than decrypting under another secret | `wrangler secret put MFA_ENC_KEY` | `worker/totp.js` (`decodeMfaKey`, `encryptionKey`) | **Missing on staging, old prod and any future prod.** Local pilot: **set**, generated independently of `ADMIN_SECRET` |
| `MFA_ENC_KEY_PREVIOUS` | Retired MFA key, **decrypt-only**, used only while rotating | No | secret | `worker/totp.js` (`previousEncryptionKey`) | Not set. Never used to encrypt; a missing current key is fatal even when this is set |
| `OWNER_PASSWORD` | **Bootstrap only**: seeds the first café's password once, guarded by `pass_hash IS NULL`, 12–100 chars | No — and it must stay unset in production (cafés are created from `/operator` with their own hashed password) | `.dev.vars` only | Read in `worker/db.js` (`bootstrapOwnerPassword`) | Local: dev-only convention. Staging: **not set**. Old prod env: **set** — that contradicts the "never set `OWNER_PASSWORD` in production" rule and should be removed at the next deploy, not before |
| `ADMIN_PIN` | Legacy staff PIN from the single-café era | **No** | `.dev.vars.example` still lists it | **No read path in `worker/`** — a repository-wide search finds no `env.ADMIN_PIN` in the current code | Dead config: harmless if set, misleading if left in a template. Old prod env still carries it |

### 2.2 First-café defaults (plain vars, not secrets)

| Name | Purpose | Required | Where | Current state |
|---|---|---|---|---|
| `CAFE_NAME` | Name for the first café only; D1 wins once the owner saves "Café setup" | No | `wrangler.jsonc` vars | `Corner Cup Café` |
| `SERVICE_MODE` | `tables` or `counter` for the first café | No | `wrangler.jsonc` vars | `counter` (staging: `counter`) |
| `CAFE_TZ_OFFSET_MIN` | Minutes ahead of UTC, so takings and pickup numbers roll over at local midnight | **Yes in practice** — defaults to 330 if unparseable | `wrangler.jsonc` vars | `330` |
| `CAFE_SLUG` | Optional slug override for the first café | No | env only | unset |

### 2.3 Optional integrations

| Name | Purpose | Required | Where | Current state |
|---|---|---|---|---|
| `ORDER_TRACK_SECRET` | Independent key for guest tracking tokens | No — falls back to `ADMIN_SECRET` (`tracking.js`) | secret | Not set anywhere |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Online payment; both must be present or the guest is offered counter payment instead | No — **must remain unset/disabled for the pilot** | secret | Staging: **not set** (provider `none`). Old prod env: **both set**. Future prod: **keep unset** until payments are separately approved |
| `RAZORPAY_WEBHOOK_SECRET` | Verifies the payment webhook signature | Only with payments | secret | **Missing** even on the old prod env — payments there were never fully configured |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_OWNER_CHAT_ID` | Optional alert per newly paid order | No | secret | Not set anywhere |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_ISSUER`, `WORKOS_AUDIENCE`, `WORKOS_API_BASE`, `WORKOS_STATE_ENCRYPTION_KEY` | Managed-identity sign-in path | No — the password+TOTP flow does not use it | secret | Not set anywhere; `WORKOS_STATE_ENCRYPTION_KEY` must be ≥32 chars if used |

### 2.4 Bindings

| Binding | Kind | Purpose | Required | Where | Current state |
|---|---|---|---|---|---|
| `DB` | D1 | Every café, menu, order, session, audit row | **Yes** | `wrangler.jsonc` (+ `wrangler.staging.jsonc`) | Local: simulated. Staging: `corner-cup-staging`. `wrangler.jsonc` still carries the placeholder id `00000000-…` — correct for this repo, wrong for any deploy |
| `IMAGES` | R2 | Menu photo upload/serve/delete | Yes for uploads; the app degrades to bundled defaults and answers 503 on upload without it | `wrangler.jsonc` (`corner-cup-images`) | Local: simulated. **Not attached to the old prod env** (its binding list has no R2 entry). Account R2 disabled (`10042`) |
| `ASSETS` | Static assets | SPA bundle from `./dist` | **Yes** | `wrangler.jsonc` | Present by configuration; served on staging |

---

## 3. Owner session configuration (code-level, no env var)

| Property | Value | Enforced in |
|---|---|---|
| Cookie name | `staff_session_<slug>` — one per café, so two clients in one browser do not evict each other | `worker/session.js` (`cookieName`) |
| Flags | `HttpOnly; Path=/; SameSite=Strict`, `Secure` only over https | `sessionCookie` |
| Idle lifetime | 12 hours, renewed on activity | `SESSION_MAX_AGE` |
| Absolute lifetime | 24 hours from row creation, never extended | `SESSION_ABSOLUTE_MAX_MS` |
| Server-side session | A token is only valid with a live `owner_sessions` row; the subject carries café id, `auth_version` and a 32-hex session id | `ownerSession` |
| Invalidation | Password change, operator reset, "sign out everywhere" and auth-mode changes bump `auth_version` (or delete rows), killing every existing token instantly | `auth_version` compare in `ownerSession` |
| Store failure | Reported as "store down" (503), never as "signed out" | `SESSION_STORE_DOWN` |
| CSRF | Origin must equal the request origin **and** a token hash must match a live row bound to this session | `verifyCsrf` |

## 4. TOTP and recovery codes

| Property | Value |
|---|---|
| Algorithm | RFC 6238, HMAC-SHA1, 6 digits, 30 s step, ±1 step window |
| Secret | 20 random bytes from the platform CSPRNG; stored only as AES-256-GCM ciphertext (`owner_totp.secret_enc`) under HKDF-SHA256(`MFA_ENC_KEY`), versioned `v2.iv.ciphertext`. Strict key shape: 32 random bytes as unpadded base64url (43 chars). No `ADMIN_SECRET` fallback; `MFA_ENC_KEY_PREVIOUS` is decrypt-only during rotation |
| Replay | `owner_totp.last_used_step` must increase; a code at or below it is refused |
| Enrollment | Requires re-proving the password (F-19); a row with `confirmed_at IS NULL` gates nothing, so an abandoned enrollment cannot lock the owner out |
| Enforcement | A confirmed TOTP row means a password alone yields only a 5-minute, single-use challenge (max 5 attempts) — never a session |
| Recovery codes | 10 codes, `XXXX-XXXX`, stored as SHA-256 digests, **single-use** (`used_at`), shown once at enrollment |
| Audit | `auth_events` records the fact and a hashed IP; never a password, code or token |

## 5. Payment provider

Provider is `razorpay` only when both `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are present; otherwise the
guest is offered counter payment and `/api/…/config` reports `provider: none`. There is no direct-UPI fallback
and no card data ever touches this Worker. **For the pilot, payments stay disabled** until separately approved
and verified end-to-end, including a webhook signature test with `RAZORPAY_WEBHOOK_SECRET`.

## 6. What is missing, unknown or contradictory — the short list

1. **`MFA_ENC_KEY` is missing on every deployment** — the code now *requires* it (no `ADMIN_SECRET` fallback,
   as of 2026-11-25) and refuses two-factor without it. Set exactly 32 random bytes as unpadded base64url on
   the deployment before enrolling. The local pilot already has an independent key.
2. **`OWNER_PASSWORD` is set on the old production environment**, contradicting the "create cafés from
   `/operator`" rule. Remove it at the next deploy; do not set it on a new one.
3. **`ADMIN_PIN` is dead config** still advertised in `.dev.vars.example` and present on the old prod env.
4. **`RAZORPAY_WEBHOOK_SECRET` is absent** where Razorpay keys exist, so payments were never fully configured.
5. **`RAZORPAY_KEY_ID`/`_SECRET` are present on the old production environment.** They must not carry over to
   the pilot; if they do, payments activate without approval.
6. **The `IMAGES` binding has never been attached to a real deployment**; R2 is disabled on the account.
7. **`wrangler.jsonc` still has the placeholder D1 id** — intentional for this repository, but a deploy must use
   the real database.
8. **No plan/entitlement is recorded anywhere.** Not a config bug, but see
   `ARGON2ID_CPU_COMPATIBILITY.md` §4.1 — the CPU ceiling actually in force is unconfirmed.

## 7. Checklist to run at deploy time (do not run before approval)

- [ ] `wrangler secret put ADMIN_SECRET` with a fresh 32+ character random value.
- [ ] `wrangler secret put OPERATOR_PASSWORD` with a value distinct from `ADMIN_SECRET`.
- [ ] `wrangler secret put MFA_ENC_KEY` with exactly 32 random bytes, unpadded base64url (43 chars), independent of `ADMIN_SECRET`.
- [ ] **Only if this deployment already has TOTP enrollments written by an older build under `ADMIN_SECRET`:**
      do not deploy this build without a cutover plan. Those rows cannot be decrypted without the old key, and
      there is no automatic migration. Either disable MFA on the old build first, or (after verifying the owner's
      identity) clear `owner_totp`, `owner_totp_recovery` and `owner_totp_challenges` for that café, bump
      `auth_version`, then re-enroll under the new key. That is destructive and was **not** performed here.
- [ ] Confirm `OWNER_PASSWORD` is **absent**, and `ADMIN_PIN` absent.
- [ ] Confirm `RAZORPAY_*` absent unless payments are approved.
- [ ] Point `DB` at the intended database id; confirm with `wrangler deploy --dry-run`.
- [ ] Create/enable `IMAGES` only after R2 is enabled on the account.
- [ ] After deploy: `/api/health`, then sign in, enroll TOTP, save a recovery code, sign out and back in.
