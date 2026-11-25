# Corner Cup — One-Pass Final Completion Report

Date: 2026-11-22
Branch: `freebuff/qr-code-cafe-ordering-website` (worktree dirty by design; nothing committed)
Scope: local engineering only — no GitHub, no deployment, no publishing, no payments, no production access
Verdict: **CODE COMPLETE — EXTERNAL SETUP REMAINS**

---

## 1. Final architecture

```
Browser (React 18 + Vite, SPA, no SSR)
  ├─ /c/:slug, /c/:slug/menu, /c/:slug/order/:id    guest menu, cart, checkout, tracking
  ├─ /c/:slug/admin                                  owner board (cookie + CSRF + TOTP)
  └─ /operator                                       operator console (cookie + CSRF)
                      │ same-origin JSON
Cloudflare Worker (workerd) — worker/index.js
  ├─ worker/api.js     routing, public/owner/operator/webhook handlers, image routes
  ├─ worker/session.js signed cookies, owner sessions, CSRF, revocation
  ├─ worker/totp.js    RFC 6238 TOTP, AES-256-GCM seed storage, recovery codes
  ├─ worker/http.js    security headers, streaming body limits, JSON helpers
  ├─ worker/db.js      schema, idempotent migrations, seed
  ├─ worker/orders.js  order numbers, pricing, status machine, payment statements
  └─ worker/menuImages.js (client side: src/lib/menuImages.js) photo ladder
                      │
        D1 (SQLite)  23 application tables — orders, menu, cafés, sessions, rate limits, auth
        R2 (IMAGES)  owner-uploaded menu photographs, server-generated keys
        Razorpay     optional, disabled unless both keys exist
```

Static assets are served by the same Worker through `env.ASSETS` with the same CSP/HSTS headers as
the JSON API. One runtime, no Node server, no container.

**Change made this pass:** `wrangler.jsonc` now declares the R2 binding
(`r2_buckets: [{ binding: "IMAGES", bucket_name: "corner-cup-images" }]`). Before this, the upload
code was production-ready but the binding did not exist, so every upload would have answered 503 on
any deployment that used the repository's own configuration. No other file was modified.

---

## 2. Implemented features

**Guest** — café landing, live menu grouped by category, add/remove with quantity, cart sheet with
kitchen note, checkout, pickup number, order tracking over a token carried only in the URL fragment,
pay-at-counter or pay-online when keys exist, sold-out suppression, category default photography with
emoji fallback.

**Owner** — password + optional TOTP sign-in, order board with paid/unpaid filters and live refresh,
status transitions (new → preparing → ready → served, cancel), cash-received marking, menu CRUD,
availability toggle, photo upload/replace/remove, tables and QR codes, café settings, password change
with re-authentication, Security tab (MFA enroll/disable, recovery-code count, session inventory,
per-session revoke, sign out everywhere).

**Operator** — password sign-in, café list, café creation with service mode and starting tables,
per-café password reset (generated strong password), sign out everywhere, owner/claim management.

**Security** — Argon2id passwords with PBKDF2 legacy verification and opportunistic rehash, signed
HttpOnly/SameSite=Strict cookies bound to a live session row and `auth_version`, per-request
membership check, CSRF on every mutating owner/operator route enforced before body parsing, streaming
body limits, D1-backed rate limiting, allow-listed public serializers, `auth_events` audit trail.

---

## 3. Security findings and verified evidence

All F-01…F-37 were checked against source during the preceding finalization pass; this pass re-ran
the suites that prove them and added **F-38**, the one new finding (R2 binding missing).

| Area | Evidence |
| --- | --- |
| TOTP gate | `login()` returns `{mfaRequired, challenge}` with no `set-cookie` when `owner_totp.confirmed_at` exists |
| Replay prevention | `last_used_step` guard plus `UPDATE … WHERE last_used_step IS NULL OR last_used_step < ?` |
| Seed encryption | AES-256-GCM, random 12-byte IV, HKDF-SHA256, AAD; tamper detection tested |
| Recovery codes | 10 codes, SHA-256 hashed, `used_at IS NULL` single-use update |
| Membership revocation | membership resolved in the session query; non-member ⇒ `SESSION_NONE` |
| Session invalidation | MFA change and password reset bump `auth_version`, delete sessions and challenges |
| CSRF coverage | 16 `verifyCsrf` call sites; ten-route matrix test; all before `readJson` |
| Operator rotation | `credential_hash = sha256(trim(OPERATOR_PASSWORD))`, fails closed when absent |
| Tenant isolation | `cafe_id` in every owner query; image route resolves key from D1 by `id AND cafe_id` |
| Guest tracking | 256-bit HMAC token, hash stored, header-only, token never in a query string |
| Payment authorization | `guardPaid` blocks downgrades; webhook signature + idempotency verified |
| Rate limiting | atomic D1 upsert; login, TOTP and settings limiters tested |
| Headers | CSP without `unsafe-*`, HSTS, `nosniff`, `no-store` on JSON |
| **F-38 (new)** | R2 binding absent from `wrangler.jsonc` — **fixed** by declaring `IMAGES`; verified 18/18 over HTTP |

**F-33 remains open** (deployment configuration): `ADMIN_SECRET` doubles as the MFA key when
`MFA_ENC_KEY` is unset. Only a deployment secret fixes it; set the dedicated key before enrolling
production owners.

---

## 4. Test, build and audit results

All commands run in this pass, in the order shown; harnesses were live on 8790 and 8789.

| Check | Command | Result |
| --- | --- | --- |
| Suite | `npm test` | **492 tests, 492 pass, 0 fail, 0 skipped, 0 cancelled** — exit 0, 107.9 s |
| Build | `npm run build` | exit 0 — 105 modules, `index-*.js` 293.59 kB (94.32 kB gzip), CSS 33.10 kB (7.22 kB gzip) |
| Audit (all) | `npm audit --audit-level=low` | 0 vulnerabilities, exit 0 |
| Audit (prod) | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities, exit 0 |
| Syntax | `node --check` on every `worker/*.js` | clean |
| Image pipeline | `node image-pipeline/self-test.mjs` | 7/7 checks passed, exit 0 |

Result is identical to the 492-test baseline: no test was skipped, added to a skip list, or weakened.

---

## 5. Browser acceptance results

Menu rendered from the production Worker configuration (`wrangler dev`, port 3001, disposable D1):

| Width | `documentElement.scrollWidth` | Viewport | Tap targets < 24 px | Items |
| --- | --- | --- | --- | --- |
| 360 | 343 | 360 | 0 | 27 |
| 390 | 374 | 390 | 0 | 27 |
| 430 | 414 | 430 | 0 | 27 |
| 1280 | 1263 | 1280 | 0 | 27 |

No horizontal page scroll at any width; every visible control is at least 24 px; items without a
photo resolve to `/defaults/coffee.jpg` (category default).

The preceding pass recorded the interactive acceptance run (guest checkout producing pickup #1 with
`tableId 0` and a fragment token, owner status change propagating to the guest view, sold-out
suppression, MFA enroll → sign-out → two-step login, operator console). That evidence stands and was
not re-created here because no UI source changed. **No human has clicked through the board yet** —
see §11.

---

## 6. Image storage status

| Property | Status |
| --- | --- |
| Binding | `IMAGES` → bucket `corner-cup-images`, now declared in `wrangler.jsonc` |
| Local behaviour | `wrangler dev` simulates R2 (`env.IMAGES (corner-cup-images) R2 Bucket local`) |
| Upload | multipart single file, magic-byte + dimension validation, ≤ 1 MB, ≤ 4096 px, ≤ 16 MP |
| Output validation | server decides extension and content type; key is `cafes/<cafeId>/menu/<itemId>/<uuid>.<ext>` |
| Metadata | only the bytes are stored; no EXIF is preserved because no decode/re-encode pipeline runs |
| Public serving | key resolved from D1 by `id AND cafe_id`, never from the URL; `nosniff` + immutable cache |
| Removal | D1 pointer cleared first, object deleted best-effort; orphan is retryable and logged |
| Unbound behaviour | upload and image GET answer 503/404 safely; menu falls back to category defaults |
| Production bucket | **not created** — the deploy will fail until `wrangler r2 bucket create corner-cup-images` runs |

Verified end to end in this pass against real workerd R2 simulation — 18/18 checks:

```
PASS login 200 / session cookie / csrf token
PASS no photo before upload
PASS upload accepted (200) → /api/cafes/corner-cup-cafe/menu/1/image?v=…
PASS image served 200, content-type image/png, nosniff, 33 bytes round-tripped
PASS unknown café cannot read the key (404)
PASS upload without CSRF refused (403)
PASS non-image refused (400)          PASS oversized upload refused (413)
PASS menu points at the stored photo  PASS removal 200, object deleted (404), default restored
```

---

## 7. Authentication runtime status

| Property | Value |
| --- | --- |
| Password hash | Argon2id (parameters unchanged from Stage 17B; never weakened) |
| Local login cost | 129 / 161 / 158 ms for a correct password, 152 ms for a wrong one, end to end in local workerd |
| MFA | TOTP RFC 6238, 30 s step, drift ±1, replay-guarded, encrypted seeds |
| Recovery | 10 single-use hashed codes; operator reset is the fallback |
| Sessions | 12 h idle, 24 h absolute, inventory + revoke + revoke-all |
| **Cloudflare CPU** | **unmeasured** — no deployment exists, so the 10 ms Free-plan ceiling is untested |

Wall-clock timings on a desktop CPU do not prove Cloudflare CPU compatibility; they only prove one
hash per login rather than a queue stall.

---

## 8. Database and recovery status

| Item | Result |
| --- | --- |
| Fresh install | 23 application tables, 24 named indexes + 14 SQLite autoindexes |
| Migrations | additive and idempotent; Stage 17B objects present |
| Restore drill (previous pass, disposable D1) | 23 tables / 68 rows re-imported, `integrity_check = ok`, `foreign_key_check` empty, order + confirmed MFA seed preserved, Worker booted on the restored file |
| Staging data | untouched — no staging database was read, exported, migrated or deleted |
| Production backup | **does not exist** (blocker B-4, account ownership) |

R2 objects are **not** covered by a D1 export; that gap is now written into
`DATABASE_MIGRATION_AND_RECOVERY.md` §8 and `DISASTER_RECOVERY_RUNBOOK.md` §9.

---

## 9. Free-tier compatibility

Measured from the Freebuff Sites quota endpoint for this account on 2026-11-22:

| Resource | Allowance | Used | Fit |
| --- | --- | --- | --- |
| Site requests | 100,000 / month | 12,320 | comfortable for one café |
| CPU time | 5,000,000 ms / month (500,000 ms daily) | 36,171.71 ms | arithmetic below |
| D1 storage | **100,000,000 bytes (100 MB)** | 266,240 | fine for orders/menu; plan exports before it grows |
| D1 rows read | 50,000,000 / month | 207,592 | fine |
| D1 rows written | 100,000 / month | 1,580 | fine for one café; watch busy days |
| R2 storage | **1,000,000,000 bytes (1 GB)** | 0 | ~1,000 full-size (1 MB) photos, or ~10,000 typical 100 kB |
| R2 writes (Class A) | 25,000 / month | 0 | ample |
| R2 reads (Class B) | 250,000 / month | 0 | ample with immutable caching |

**R2 provisioning is supported on the free tier without publishing anything.**
`sites_add_storage {kind:"r2", name:"FILES"}` provisions a bucket for a Sites environment. For this
repository the binding is named `IMAGES`, so the provisioned bucket must be bound as `IMAGES`
(a one-line change to the manifest/`wrangler.jsonc`) or the code's binding name must match. Nothing
was provisioned in this pass: it creates an external resource and Project A must stay unpublished.

**Authentication/CPU arithmetic.** If a login costs about 40 ms of CPU (Argon2id at the chosen cost,
measured wall clock ~130–160 ms mostly spent hashing), then 5,000,000 ms/month allows roughly 125,000
logins per month — far more than one café needs. The binding constraint is the **per-invocation 10 ms
CPU ceiling** on Workers Free, not the monthly total. That ceiling is unmeasured and is the single
reason the Free plan cannot yet be declared sufficient for owner authentication. Options if it is
exceeded: Workers Paid, or a lower Argon2id cost — never a weaker hash.

---

## 10. External dependencies

| Dependency | Exact requirement | Cost | Owner action | Status |
| --- | --- | --- | --- | --- |
| R2 bucket | `wrangler r2 bucket create corner-cup-images`, binding `IMAGES` (now declared) — or `sites_add_storage` kind `r2` | Free (1 GB) | create + deploy | code ready, bucket absent |
| Workers deployment | one Worker, `wrangler deploy` | Free | approve a non-public deploy | never deployed |
| Secrets | `ADMIN_SECRET`, `MFA_ENC_KEY`, `OPERATOR_PASSWORD` | Free | `wrangler secret put` | not set |
| Production D1 backup | account-level export | Free | account owner runs it, or Freebuff support assists | **missing** |
| Razorpay | merchant KYC + live keys | per-transaction fee | owner decision | disabled, correct |
| WorkOS | production directory + redirect URIs | vendor plan | separately approved change | unused by default |
| GitHub | auth + repo + Actions | free for public repos | paused by instruction this pass | CI file prepared, never run |
| Pilot café | a real café and one shift | — | owner | not started |

**WorkOS recommendation, for a future separately approved change:** keep the code dormant, do not
enable it. It adds a provider dependency, an OAuth round trip and a directory to administer, and it
solves only "owner identity in a browser" — not the second factor this project already has. Its
tokens do not prove MFA, so enabling it would not replace the TOTP gate. Remove it only if a future
decision abandons managed owner login entirely; deleting it now would be an unrequested change.

**Razorpay disabled path, verified:** without both `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` the
public config reports online payments off, checkout offers pay-at-counter only, no gateway call is
made, and webhook receipts are rejected. Activation requires: merchant account + KYC, live keys set
as Worker secrets, one small real payment, and reconciliation of that payment against the board.

---

## 11. Human acceptance checklist (10–15 minutes)

Prep: one local Worker running (or the pilot deployment), one owner password, one phone with an
authenticator app, one browser window.

| # | Step | Pass looks like | Time |
| --- | --- | --- | --- |
| 1 | Open `/c/<slug>/admin`, enter the owner password | Sign-in asks for an authenticator code, or lands on the board if MFA is off | 30 s |
| 2 | Enter the 6-digit code from the app | Board loads; no error; wrong code is refused with a message | 30 s |
| 3 | Open the **Security** tab | MFA status, recovery-code count, session list (current device), disable form all render | 1 min |
| 4 | Note how many recovery codes remain; confirm they were stored somewhere safe | A number (10 after enrollment); you know where the file is | 30 s |
| 5 | Sign out, then sign in again | Password prompt → code prompt → board; no stale session | 1 min |
| 6 | Open the guest menu in a second window, add two items, place a counter order | Cart totals correctly; order confirmed with a pickup number | 2 min |
| 7 | Copy the tracking link and open it | Same order, same status, token only after `#` | 30 s |
| 8 | On the board, move the order to **Preparing** | Board updates; no error toast | 30 s |
| 9 | Refresh the guest tracking page | Status shows "Being made" within one poll (~5–10 s) | 30 s |
| 10 | Toggle one item sold out on the board, reload the guest menu | Item shows SOLD OUT and cannot be added | 30 s |
| 11 | (Optional, if R2 is bound) upload a photo on one item, reload the guest menu, then remove it | Photo appears, then the category default returns | 2 min |

Record the result with date, browser, and any control that did not respond to a real pointer click.
No human has performed this checklist yet.

---

## 12. Exact first-café pilot procedure

1. Create the bucket and set secrets (`ADMIN_SECRET`, `MFA_ENC_KEY`, `OPERATOR_PASSWORD`).
2. `npm ci && npm test && npm run build && wrangler deploy` (one non-public deployment first).
3. Open `/operator`, sign in, create the café with the real name, service mode (counter or tables),
   and its starting tables.
4. Sign in to the new café's board with the generated password; change it; enroll TOTP; store the
   recovery codes offline.
5. Build the menu: categories, names, prices, availability; upload photos for the top sellers.
6. Print the table QR codes (table mode) or the counter QR (counter mode) — the URL is
   `/c/<slug>/menu`.
7. Measure login CPU with `wrangler tail` during one sign-in; record it.
8. Run the §11 checklist on the pilot deployment.
9. One staffed shift with a real till: confirm pickup numbers, status transitions, cash marking, and
   that no order is lost on a page refresh.
10. Export the D1 database at the end of the shift and store the file off-account.

Do not enable Razorpay until the pilot shift has run and one small real payment can be reconciled.

---

## 13. Production launch procedure

Prerequisite: explicit owner approval; nothing below has been executed.

1. **Back up first.** `wrangler d1 export corner-cup --remote --output corner-cup-<timestamp>.sql`;
   keep the file off-account; record which `MFA_ENC_KEY` was active.
2. **Secrets.** `wrangler secret put ADMIN_SECRET` (32+ random bytes), `MFA_ENC_KEY` (independent
   value), `OPERATOR_PASSWORD`. Never set `OWNER_PASSWORD` in production — create the café from the
   operator console.
3. **Storage.** `wrangler r2 bucket create corner-cup-images`; the binding is already declared.
4. **Deploy.** `wrangler deploy`; confirm `/api/health` returns `{status:"ok",database:"ok"}`.
5. **Smoke.** Menu loads, one order placed and cancelled, owner signs in and enrolls MFA, one photo
   uploaded and served, then removed.
6. **Measure.** Login CPU from `wrangler tail`; if it exceeds the Free-plan ceiling, move to Workers
   Paid rather than weakening Argon2id.
7. **Operate.** Daily export; weekly integrity check; `auth_events` review after any incident.

---

## 14. Rollback procedure

| Failure | Action | Data consequence |
| --- | --- | --- |
| Bad Worker version | `wrangler rollback` to the previous deployment | none; D1 untouched |
| Bad migration | redeploy previous code; Stage 17B tables are additive | none |
| D1 corruption | stop writes, restore last export into a new database, repoint binding, redeploy | loses data since last export |
| MFA key lost | restore the old key, or clear `owner_totp.confirmed_at` + bump `auth_version` | owners re-enroll; sessions end |
| Owner locked out | operator clears `confirmed_at` and bumps `auth_version` | password-only until re-enrollment |
| R2 broken | remove the binding; menu uses category defaults | uploaded objects remain in the bucket |
| Razorpay broken | remove its secrets; board reverts to counter payments | unpaid orders marked by staff |

---

## 15. Remaining blockers and who must resolve them

| ID | Blocker | Resolver | Blocks |
| --- | --- | --- | --- |
| B-1 | GitHub repository, CI run | owner (auth) — **paused this pass** | CI proof, image publishing workflow |
| B-2 | Workers-Free CPU measurement | owner: one non-public deployment | Free-plan sufficiency for login |
| B-3 | R2 bucket creation | owner: `wrangler r2 bucket create` or `sites_add_storage` | photo uploads in production |
| B-4 | Production D1 backup | account owner / Freebuff support | any restore point |
| B-5 | Razorpay live verification | owner (KYC + live keys) | online payments |
| B-6 | Pilot café shift | owner | real-load behaviour |
| B-7 | WorkOS directory | owner, future change | managed owner login |
| B-8 | Human click-through | any human, ~10 min | UI confidence beyond automation |
| F-33 | `MFA_ENC_KEY` unset ⇒ key reuse | owner: set the secret | seed/key separation |

Nothing in this list is a source defect. Engineering work that can be done without account access,
GitHub, money or a human is complete.
