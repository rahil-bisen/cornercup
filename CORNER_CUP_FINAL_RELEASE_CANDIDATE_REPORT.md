# Corner Cup — Final Release Candidate Report

Date: 2026-11-22
Branch: `freebuff/qr-code-cafe-ordering-website` (baseline `023befe`, worktree dirty by design)
Verdict: **B. CODE COMPLETE — EXTERNAL SETUP REMAINS**

---

## 1. Final architecture

```
Browser (React 18 + Vite, no server-side rendering)
  ├─ /c/:slug, /c/:slug/menu, /c/:slug/order/:id   guest menu, cart, tracking
  ├─ /c/:slug/admin                                 owner board (cookie + CSRF + MFA)
  └─ /operator                                      operator console (cookie + CSRF)
                     │  same-origin JSON
Cloudflare Worker (workerd)  worker/index.js
  ├─ worker/api.js     routing + handlers (public, owner, operator, webhook)
  ├─ worker/session.js signed cookies, owner sessions, CSRF, revoke
  ├─ worker/totp.js    RFC 6238 TOTP, AES-256-GCM seed, recovery codes
  ├─ worker/http.js    security headers, streaming body limits
  ├─ worker/db.js      schema + idempotent migrations + seed
  └─ worker/orders.js  order numbers, pricing, status machine
                     │
        D1 (SQLite)  ── orders, menu, cafés, sessions, rate limits, auth_events
        R2 (optional, unbound in this repo) ── owner-uploaded menu photos
        Razorpay (optional, test keys only locally)
```

Static assets are served by the Worker (`env.ASSETS`, SPA fallback) with the same CSP/HSTS
headers as the JSON API. There is no Node server, no container, no second runtime.

---

## 2. Completed functionality

**Guest** — café landing, live menu with categories, default/emoji image fallback, add/remove,
cart sheet with kitchen note, checkout, pickup number, order tracking over a token that lives only in
the URL fragment, pay-online (when keys exist) or pay-at-counter, sold-out suppression.

**Owner** — password + optional TOTP sign-in, order board with paid/unpaid filters and live refresh,
status transitions (new → preparing → ready → completed), cash-received marking, menu CRUD,
availability toggle, photo upload/remove, tables and QR, café settings, password change with reauth,
Security tab (MFA enroll/disable, recovery-code count, session inventory, revoke, sign-out-everywhere).

**Operator** — password sign-in, café list, café creation with service mode and starting tables,
per-café password reset, sign-out-everywhere.

**Security** — Argon2id passwords, PBKDF2 legacy verification with opportunistic rehash, signed
HttpOnly/SameSite=Strict session cookies bound to a live DB row and an `auth_version`,
per-request membership check for managed sessions, CSRF on every mutating owner/operator route
enforced before body parsing, streaming body limits, D1-backed rate limiting keyed per café/order/IP,
allow-listed public serializers, `auth_events` audit trail.

---

## 3. Security findings — evidence

Source was re-read for every finding; no PASS was accepted from a report alone.

| ID | Property | Evidence in source | Test |
| --- | --- | --- | --- |
| F-21 | No session without a second factor | `login()` reads `owner_totp.confirmed_at`; confirmed ⇒ returns `{mfaRequired, challenge}` and no `set-cookie` | `mfa.flows` |
| F-22 | TOTP replay rejected | `verifyTotp(..., {lastStep})` skips `step <= lastStep`; `UPDATE … WHERE last_used_step IS NULL OR last_used_step < ?` | `totp.vectors`, `mfa.flows` |
| F-23 | Seed encrypted at rest | `encryptSecret` = AES-256-GCM, 12-byte random IV, HKDF-SHA256 key, AAD; `mfaConfigured()` gates enrollment with 503 | `totp.vectors` (round-trip, tamper) |
| F-24 | Recovery codes single-use, hashed | `UPDATE owner_totp_recovery SET used_at=? WHERE code_hash=? AND used_at IS NULL`, zero rows ⇒ refusal | `mfa.flows` |
| F-25 | Session inventory/revoke | `ownerSessionList` returns truncated ids; `ownerRevokeSession` validates 8-hex, rejects ambiguous and self | `mfa.flows` |
| F-26 | Membership revocation is immediate | `ownerSession()` selects the membership row in the same query; `workos_user_id` present and `member != 1` ⇒ `SESSION_NONE` | `owner.revocation`, `mfa.flows` |
| F-27 | MFA change kills sessions | confirm/disable batch: `auth_version+1`, `DELETE owner_sessions`, `DELETE owner_totp_challenges`, cookie cleared | `mfa.flows` |
| F-28 | CSRF on every owner mutation | 16 `verifyCsrf` call sites; every `readJson` mutation handler verifies first | 10-route matrix in `mfa.flows` |
| F-29 | Operator rotation invalidates | `credential_hash` compared against `sha256(trim(OPERATOR_PASSWORD))`; missing row/digest ⇒ false | `operator.revocation` |
| F-30 | Audit trail | `recordAuthEvent` writes `auth_events` for every outcome; never throws | `mfa.flows` |
| F-31 | TOTP brute-force bounded | `totp:<cafeId>:<ipHash>`, 5 per 10 min, plus per-challenge 5-attempt cap | `mfa.flows` |
| F-32 | Challenge replay rejected | 32-byte token stored hashed, 5-minute expiry, `DELETE` on success | `mfa.flows` |

Additionally re-verified by inspection this pass: payment status guard (`guardPaid`, no downgrade
from `confirmed`), guest tracking token (HMAC over café+order, header-only, hash stored), tenant
scoping (`cafe_id` in every owner query), body limits (16 call sites), image validation (magic bytes,
dimensions, 1 MB cap, server-generated key, server-set content type).

**F-36 closed.** The Security tab was rendered and exercised in a real browser: enrollment shows the
base32 secret and `otpauth` link, confirmation signs the board out, re-login asks for the code, the
enabled state shows "10 recovery codes left", the session list shows the current device, and the
disable form requires password + code. No layout break at 360/390/430/1280.

**F-37 partially verified.** Argon2id login measured end to end against the local workerd:
129 ms, 161 ms, 158 ms for a correct password, 152 ms for a wrong one (includes HTTP + D1 + one
Argon2id verify). That proves the code path is a single hash and not a queue stall, but it is **not**
a Cloudflare CPU measurement: local workerd has no 10 ms CPU ceiling and runs on a desktop CPU.

**F-33 remains open (configuration).** Without `MFA_ENC_KEY`, seeds are encrypted under
`ADMIN_SECRET`. Nothing in code can fix that; set a dedicated key before enrolling production owners.

---

## 4. Authentication and MFA acceptance

Run against a real Worker on `127.0.0.1:3000` with a scratch D1 and a real browser session.

| Check | Result |
| --- | --- |
| Password only, MFA required | Password accepted → sign-in screen switched to "Authenticator code"; no session cookie; `/admin/session` still 401 |
| Enrollment cannot activate unverified | `ownerMfaConfirm` returns 401 on a bad code and leaves `confirmed_at` NULL (`mfa.flows`) |
| Invalid codes | 401, challenge attempt incremented |
| Expired codes | Challenge TTL 300 s enforced in SQL (`expires <= now` ⇒ null) |
| Replayed codes | Same-step code refused by the conditional UPDATE (`mfa.flows`) |
| Recovery code single use | Second attempt with the same code refused (`mfa.flows`) |
| Seed never public | No public route returns `secret_enc`; `/admin/mfa/status` returns only booleans/counts |
| Membership revocation | Managed session with removed membership ⇒ `SESSION_NONE` on the next request (`owner.revocation`) |
| Sign out everywhere | `auth_version` bump + session sweep; acting device re-issued a session (`session.revocation`) |
| CSRF failure on protected mutations | 10 of 10 routes reject missing/wrong token, before body read (`mfa.flows`) |
| Operator rotation | Session refused after `OPERATOR_PASSWORD` changes (`operator.revocation`) |
| Insecure fallback | Login refuses when `ADMIN_SECRET` or `pass_hash` is missing (503), never a default password |

Live two-factor round trip performed in the browser: enroll → confirm → automatic sign-out →
password → code → board. All four steps behaved as specified.

---

## 5. Customer and owner acceptance (local, real browser)

| Area | Result |
| --- | --- |
| Table ordering | Verified by suite (`orders.integration`, `status.transitions`); this café runs counter mode |
| Counter ordering | Order placed from the menu → pickup number **1**, `tableId 0`, `tableLabel "Counter"` |
| Cart and checkout | Sheet opens with focus on Close, quantity controls, kitchen note, total, single POST `/orders` → 201 |
| Guest tracking | `/order/CJV4HZ#t=…` renders "Order confirmed", then "Being made" after the owner transitioned it; token only in the fragment |
| Idempotent checkout | Covered by suite (same idempotency key ⇒ one order) |
| Queue numbering | #1 for the first order of the day, matching `queueNo` in the admin payload |
| Table IDs | Counter mode: no table id; table mode covered by suite |
| Status changes | Owner "Preparing" → PATCH 200 → guest view updated within the poll interval |
| Sold-out products | Toggled Masala Chai off in the board → guest card shows `SOLD OUT`, no add button |
| Image fallbacks | Items without a photo show the category default (`/defaults/*.jpg`) and the board labels them "Default photo" |
| Mobile layout | 360 / 390 / 430 / 1280 px: `document.scrollWidth` 343 / 343 / 414 / — all ≤ viewport, no page-level horizontal scroll; zero tap targets under 24 px |
| Owner auth/MFA | See §4 |
| Menu/category management | Board lists 27 items grouped by category with per-item availability and photo actions |
| Table management | Tables tab present; counter mode shows no tables (by design) |
| Order board | Paid/unpaid tabs, statistics (collected, online, counter, unpaid, average), search, sound toggle |
| Settings | Read via UI; PATCH covered by suite |
| Session expiry/logout | `expiresIn` reported by `/admin/session`; sign-out deletes the row (suite) |
| Operator | Console sign-in, café list "1 cafés on this deployment", create/reset forms rendered |
| Keyboard/focus | Cart focus moves to Close; all controls are native buttons/inputs; no `tabindex` traps; no `aria-hidden` on focusable content |

**Limitations of this visual pass:** the browser automation's coordinate clicks did not reliably
trigger React handlers on two controls (the login submit and the Security tab); those were driven
with DOM `click()`/`requestSubmit()`, which exercises the same handlers but is not a real pointer
event. A five-minute manual click-through by a human is still worth doing before the pilot.

---

## 6. Test, build and audit results

| Check | Command | Result |
| --- | --- | --- |
| Suite | `npm test` | **492 tests, 492 pass, 0 fail, 0 skipped** (102.9 s) |
| Build | `npm run build` | success — 293.59 kB JS / 94.32 kB gzip, 33.10 kB CSS / 7.22 kB gzip |
| Audit (all) | `npm audit --audit-level=low` | 0 vulnerabilities |
| Audit (prod) | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |
| Syntax | `node --check` on every `worker/*.js` | clean |
| Image pipeline | `node image-pipeline/self-test.mjs` | 7/7 |

Both harnesses were live for the run (`127.0.0.1:8790` auth, `127.0.0.1:8789` batch).

---

## 7. Database and recovery results

Measured on a disposable D1 created by this pass (`/tmp/rc-preview-db`), never staging or production.

| Item | Result |
| --- | --- |
| Fresh install | `init()` creates 23 application tables; 24 named indexes plus 14 SQLite autoindexes = 38 index entries |
| Migrations | Stage 17B objects present: `owner_totp`, `owner_totp_recovery`, `owner_totp_challenges`, `auth_events`, `operator_sessions.credential_hash` |
| Upgrade path | Legacy PBKDF2 hashes verify and are rehashed to Argon2id in place; two- and three-part owner subjects are rejected (sign-in required once) |
| Referential integrity | After restore: `PRAGMA integrity_check` = ok, `foreign_key_check` = no rows |
| Export | Row-by-row SQL dump of all 23 tables: 68 rows |
| Restore | Import into an empty database: 23 tables, 68 rows, 1 order, 1 confirmed MFA seed, 6 auth events preserved |
| Post-restore boot | Worker started on the restored file: `/api/health` 200, menu 200, password accepted and answered `mfaRequired` — which also proves the encrypted seed decrypts under the same `MFA_ENC_KEY` |
| Tenant isolation | Covered by suite (`public.exposure`, `owner.revocation`, operator tests); not re-created visually |
| Recovery docs | `DATABASE_MIGRATION_AND_RECOVERY.md` matches the measured figures after this pass |

**Staging vs production:** the drill above is a *local disposable* restore. No staging backup was
taken or restored in this pass, and **no production backup exists** — that remains blocker B-4.

---

## 8. CI and build review

`.github/workflows/ci.yml` as reviewed:

- `permissions: contents: read` — nothing else.
- No `secrets.` reference; the harnesses create their own local D1 under `.wrangler/`.
- No deploy step, no `wrangler deploy`, no publishing.
- Uploads harness logs only on failure, 7-day retention.
- `npm ci` from the committed lockfile; `node --check` over `worker/*.js`; tests; build;
  `npm audit --omit=dev --audit-level=high`.
- No `.env`, `.dev.vars` or credentials in the workflow; nothing commits or uploads build output.

Local equivalent executed in this pass: syntax check, suite, build, audit — all green. The workflow
itself has still never run on a runner (no remote, no token), so runner-specific behaviour remains
unproven.

---

## 9. Infrastructure dependencies

| Dependency | Required resource | Free? | Binding / config | Account permission | Verification | Rollback |
| --- | --- | --- | --- | --- | --- | --- |
| Workers | 1 Worker, Free plan | Yes (100k req/day) | `wrangler.jsonc` `main` | Workers Scripts: Edit | `wrangler tail` shows requests; `/api/health` 200 | `wrangler rollback` to previous version |
| D1 | 1 database | Yes (5 GB, 5M rows read/day) | `d1_databases[0].database_id` | D1: Edit | `/api/health` `database: ok` | Re-import the last export |
| R2 | 1 bucket for menu photos | Yes (10 GB) | **not present** — add `r2_buckets: [{binding:"IMAGES", bucket_name:"corner-cup-images"}]` | R2: Edit | Upload a photo in the board; `GET /api/cafes/:slug/menu/:id/image` 200 | Delete the binding; images fall back to category defaults |
| Secrets | `ADMIN_SECRET`, `MFA_ENC_KEY`, `OPERATOR_PASSWORD`; optional `OWNER_PASSWORD` (bootstrap only), `RAZORPAY_*` | Yes | `wrangler secret put` | Workers Secrets: Edit | Sign in works; missing secret yields 503, not 500 | Re-put the previous value; sessions signed with the old secret are invalidated |
| Custom domain | optional | Yes | Workers route | Zone: Edit | DNS resolves, TLS valid | Remove the route |
| GitHub Actions | optional | Yes for public repos; private repos consume included minutes | `.github/workflows/ci.yml` | Repo admin | First green run | Disable the workflow |
| Razorpay | merchant account | No (per-transaction fee) | `RAZORPAY_KEY_ID` / `_SECRET` | merchant dashboard | Test-mode payment, then live small-amount | Remove the secrets — the UI reverts to counter payments |

---

## 10. Exact external blockers

| ID | Blocker | Needed from | Consequence today |
| --- | --- | --- | --- |
| B-1 | No GitHub remote, CLI or token in this environment | owner: `gh auth login` or PAT/SSH, plus permission to push | CI has never run; nothing is pushed; image workflow unwired |
| B-2 | No deployment performed, so Workers-Free CPU is unmeasured | owner: approve one non-public deploy | Cannot assert the login path fits 10 ms CPU |
| B-3 | R2 bucket not created or bound | owner: `wrangler r2 bucket create` + binding + redeploy | Photo upload answers 503 "Image storage is not configured" |
| B-4 | Production D1 export blocked by account ownership | account owner runs the export | A production data loss has no restore point |
| B-5 | Razorpay merchant verification | owner: KYC + live keys | Online payment untested end to end |
| B-6 | No pilot café | owner: a real café and one shift | Behaviour under real load unproven |
| B-7 | WorkOS production directory | owner: WorkOS project + directory | Managed owner login unexercised |
| B-8 | Manual click-through of the board | a human with 5 minutes | Two controls were driven programmatically, not by pointer |

Local-only leftover worth knowing: this machine has a `.dev.vars` with **test** Razorpay keys, which
is why the local board says "Razorpay checkout on". Never copy that file into a deployment.

---

## 11. Zero-budget feasibility

Everything in the required path is free: Workers Free, D1 Free, R2 Free (10 GB), GitHub Actions for
a public repo, and TOTP instead of a paid MFA provider. The only paid item is Razorpay's
per-transaction fee, which is a business cost, not a platform cost, and is disabled until the café
asks for it. No dependency was added in this pass; `npm audit` is clean on both trees.

---

## 12. Remaining risks

1. **`ADMIN_SECRET` doubles as the MFA key** when `MFA_ENC_KEY` is unset (F-33). Set the dedicated
   key before enrolling production owners; otherwise rotating the session secret also destroys every
   TOTP seed.
2. **Argon2id CPU unmeasured on Workers Free** (F-37, B-2). Wall-clock locally is ~130–160 ms per
   login including HTTP and D1, which is a good sign but not a CPU measurement.
3. **No production backup** (B-4) — the highest-impact operational risk in this list.
4. **R2 unbound** (B-3): photos silently fall back to category defaults, which is graceful but means
   the feature is unshipped.
5. **Payment path only tested in test mode** (B-5), and webhook replay/idempotency is covered by unit
   tests rather than a live gateway.
6. **TOTP is phishable** (F-34) — accepted; no hardware key.
7. **Recovery codes depend on the owner storing them** (F-35); operator reset is the fallback.
8. **First-run experience**: a café with no password set answers 503 with an operator instruction.
   That is deliberate but means provisioning must happen before the QR code is printed.
9. **CI unproven on a runner** (B-1): the first green run may need small fixes.

None of these is a source-level defect; each is either a deployment step or an accepted trade-off.

---

## 13. Production launch procedure

Prerequisite: explicit owner approval. Nothing below was executed.

1. **Back up.** Export the production D1 (`wrangler d1 export <db> --remote --output …`), store it
   off-account, timestamped (B-4).
2. **Set secrets** (never in chat, never in a file in the repo):
   `wrangler secret put ADMIN_SECRET` (32+ random bytes), `wrangler secret put MFA_ENC_KEY`
   (independent value), `wrangler secret put OPERATOR_PASSWORD`. Do **not** set `OWNER_PASSWORD` in
   production; create the café from the operator console instead.
3. **Bind storage**: `wrangler r2 bucket create corner-cup-images`, add
   `r2_buckets: [{ "binding": "IMAGES", "bucket_name": "corner-cup-images" }]` to `wrangler.jsonc`,
   redeploy (B-3).
4. **Deploy** `wrangler deploy` (not from this pass).
5. **Smoke test**: `/api/health` 200; menu loads; place one real order and cancel it; owner signs in;
   enroll MFA; sign out; sign in with a code; upload one photo.
6. **Measure** the login CPU with `wrangler tail` (B-2). If it exceeds the Free-plan budget, move to
   Workers Paid or tune Argon2id cost — not to a weaker hash.
7. **Run one staffed shift**: confirm pickup numbers, status transitions, cash marking.
8. **Only then** enable Razorpay (B-5) with live keys, take one small real payment, and reconcile it.
9. **Enable CI** on the pushed branch and keep it green (B-1).
10. **Schedule exports** (daily) and record which `MFA_ENC_KEY` was in use for each backup.

---

## 14. Rollback plan

| Failure | Action | Data consequence |
| --- | --- | --- |
| New Worker version misbehaves | `wrangler rollback` to the previous deployment | None; D1 untouched |
| Migration caused a problem | Deploy the previous code; the Stage 17B tables are additive and harmless | None; no down-migration needed |
| D1 corrupted or bad write | Stop writes, restore the last export into a fresh database, repoint the binding, redeploy | Data since the last export is lost — this is why step 1 matters |
| MFA key lost or rotated by accident | Restore the old `MFA_ENC_KEY`, or clear `owner_totp.confirmed_at` for affected cafés and bump `auth_version` | Owners re-enroll; sessions are ended |
| Owner locked out entirely | Operator clears `owner_totp.confirmed_at` and bumps `auth_version` (`DATABASE_MIGRATION_AND_RECOVERY.md` §7) | Password-only until re-enrollment |
| Razorpay misbehaving | Remove `RAZORPAY_KEY_ID`/`_SECRET`; the board reverts to counter payments | Unpaid orders stay unpaid and are marked by staff |
| R2 misbehaving | Remove the binding; photos fall back to category defaults | Uploaded objects remain in the bucket |

Rollback of the *branch* is not needed: nothing was committed, pushed or deployed by this pass.

---

## 15. Verdict

**B. CODE COMPLETE — EXTERNAL SETUP REMAINS.**

The four criteria for a first-café pilot are not all met by evidence: CI has never run, no deployment
exists so CPU is unmeasured, R2 has no bucket, there is no production backup, and no human has
clicked through the board. The source, tests and documentation are complete and are now backed by
re-executed evidence rather than prior reports.

Do not treat this as production-ready. Do treat it as ready for the seven steps in §13 once someone
with account access is in the room.
