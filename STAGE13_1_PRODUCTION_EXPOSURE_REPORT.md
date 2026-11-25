# STAGE 13.1 — Production Exposure Report

**Date:** 2026-11-20
**Mode:** investigation only. No deployment, no unpublish, no publish, no authentication, no order, no payment,
no D1 query, no secret read. The only network activity was unauthenticated `GET` requests for public static
resources.
**Question:** is the publicly deployed production application serving the older, potentially vulnerable build?

---

## 1. Answer

**Yes — with high confidence, and one part of it is proven directly rather than inferred.**

Three independent lines of evidence agree:

1. **Provenance.** The production environment's last successful deploy was **2026-11-10T07:48:37Z**. Every
   security remediation this audit relies on landed on **2026-11-15/16**. No deploy, rollback or re-publish
   happened in between.
2. **Directly observable drift.** The live site returns **no security headers at all** — no
   `Content-Security-Policy`, no `Strict-Transport-Security`, no `X-Content-Type-Options`, no
   `X-Frame-Options`, no `Referrer-Policy`, no `Permissions-Policy`. F-04 (which adds exactly those to every
   response) was remediated on 2026-11-15. The served bytes therefore **cannot** be current code.
3. **Client markers.** The public browser bundle contains none of the strings that current source compiles in
   for F-19 (`Current owner password`, `currentPassword`, `reauth_required`), F-07-2B (`ownerAuth`,
   `Redeem invite`, `Invite code`, `managed identity`). The current build contains all of them.

A fourth fact materially raises the stakes: **production has Razorpay credentials configured**
(`RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` both exist as secrets), so online payments are enabled on the
public deployment — contrary to the project decision that Razorpay remains disabled by default.

**Classification: potential active security incident.** The public site is reachable, appears to be in real use
(12,320 requests and 207,464 D1 rows read this month), and is running code from before the F-19 and F-10 fixes.

## 2. Deployment identity (metadata only, verified today)

| Field | Value |
|---|---|
| Site | `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63` — "Corner Cup Café — Razorpay" |
| Environment | `production`, id `fa58771d-25fb-4936-bbad-5cffd6ff3973` |
| Worker name | `site-fa58771d25fb4936bbad5cffd6ff3973` |
| Public URL | `https://site-fa58771d25fb4936bbad5cffd6ff3973.freebuff.page` |
| Published | **true** (`unpublished_at: null`) |
| `deployed_at` | **2026-11-10T07:48:37.788Z** |
| First publish receipt | 2026-11-09T16:14:57Z (`published: true`), succeeded |
| Latest deploy receipt | 2026-11-10T07:48:34 → 07:48:37Z, succeeded |
| Earlier deploys | 2026-11-10T07:42:40Z; 2026-11-09T20:57:19Z; 17:59:13Z; 17:58:24Z; 17:40:06Z; 16:28:01Z; 16:14:34Z |
| Deploys after 2026-11-10 | **none recorded** |
| Preview | id `f4adb117-…`, `published: true`, `deployed_at 2026-11-12T10:35:15Z` |

### Bound resources (names and kinds only — no value read)

| Binding | Kind | Resource | Created |
|---|---|---|---|
| `DB` | D1 | resource `17d9568d-52fd-48c2-8761-b74d97688589`, name `site-6e1c6f7a9a9f4e098f778f9754221b0a` | 2026-11-09T16:14:26Z |
| `ADMIN_SECRET` | secret | — | 2026-11-09T16:14:56Z |
| `RAZORPAY_KEY_ID` | secret | — | 2026-11-09T16:18:07Z |
| `RAZORPAY_KEY_SECRET` | secret | — | 2026-11-09T16:18:00Z |
| `OWNER_PASSWORD` | secret | — | 2026-11-09T16:24:34Z |
| `SERVICE_MODE` | secret | — | 2026-11-09T17:59:50Z |
| `ADMIN_PIN` | secret | — | 2026-11-09T18:59:17Z |
| `OPERATOR_PASSWORD` | secret | — | 2026-11-09T20:57:38Z (re-set 2026-11-11T13:24:17Z) |

Variable quota 11 of 25 used. Observations:

- **Payments are configured.** `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` exist, so this deployment advertises
  `provider: "razorpay"` and shows a live pay button. Whether these are test-mode or live-mode keys is
  **UNVERIFIED** (that requires reading the value, which was not done). Either way it contradicts "Razorpay must
  remain disabled by default".
- **`ADMIN_PIN` exists**, an obsolete credential the current code never reads. Whether the 2026-11-10 build
  still reads it is **UNVERIFIED**.
- `SERVICE_MODE` is stored as a *secret* rather than a plain variable (harmless, but the value is invisible to
  normal config review).
- `OWNER_PASSWORD` is still present, meaning the first-boot password seed may still be able to install a hash if
  the café row ever loses one.

### Database allowance usage (this environment)

`d1Bytes 266,240` · `d1Reads 207,464` · `d1Writes 1,580` · `cpuMs 36,171.71` · site `requests 12,320`
(all month-to-date, reset 2026-12-01). The database is ~266 KB — comparable to the 241,664-byte staging
database, i.e. it holds a real schema and data, not an empty shell.

## 3. Served artifact identity (passive GETs only)

All requests were `GET`, unauthenticated, to public static resources. No API path was touched.

| Artifact | Size | SHA-256 |
|---|---:|---|
| Production `GET /` | 1,145 B | — (HTML shell; title `Order from your table — QR menu`) |
| Production `/assets/index-x3BrWCng.js` | 247,604 B | `d51fc7f27ef4c9decb32402d3e2b5b5d2aefc81dddb3ffec11b43bb9b50061e6` |
| Production `/assets/index-CkJMrsdi.css` | 24,502 B | `46c1644c30c068fb826dc4872d0a8e812dab052b31b110abb596e0781305434f` |
| Preview `/assets/index-Cx9ssJ0q.js` | 252,164 B | `e2bb2bcb5ad42958b115d2613ff8246825b4f3dca1c83539a1d78e80b9576b97` |
| Preview `/assets/index-DFXcUnMc.css` | 28,199 B | `830f44360c65072afb5e689fbb8041a699266bfe67b7ac9b8778bb97189a29c7` |
| Current local build `dist/assets/index-DxE7HcFy.js` | 277,527 B | `04a0bbdff5c5c71914d1e0f2f2c58725dc449d29bb35b3a63c1bc3e318121f59` |
| Current local build `dist/assets/index-lF6Ef0QK.css` | 28,814 B | `a5998a876e2980db2b6241720418ca69952606b007ca755a335c792e5323cb27` |

- **No local artifact matches the production JS** (compared against `dist/`, the Stage 13 isolated build, and
  `sites-build/index.js`). It is a third, older build.
- Production, preview and the current build are **three different bundles** (247.6 KB / 252.2 KB / 277.5 KB).
  The size ordering matches the feature history: the oldest is the public one.
- The asset ETag `"9aee9fc335bf2fb8f29ca5e5ebe3de93"` is Cloudflare's own content hash; it corroborates that the
  file is served as stored, unmodified.

### Response headers (production, verbatim subset)

```
HTTP/1.1 200 OK
Content-Type: text/html
CF-Cache-Status: MISS
Cache-Control: public, max-age=0, must-revalidate
Server: cloudflare
```

| Expected header (current code, F-04) | Present on production |
|---|---|
| `Content-Security-Policy` | **No** |
| `Strict-Transport-Security` | **No** |
| `X-Content-Type-Options` | **No** |
| `X-Frame-Options` | **No** |
| `Referrer-Policy` | **No** |
| `Permissions-Policy` | **No** |
| `Cache-Control` | present (platform asset default, not the app's `no-store` for JSON) |

The absence of the entire header set is the strongest single piece of evidence: those headers are applied by
`withSecurityHeaders()` in `worker/http.js` and `worker/index.js` on **every** response, API and static, in
current code. A response without them is not being produced by current code.

## 4. Provenance: can the deployed artifact be matched to a commit?

**No — and this is itself a finding.**

| Question | Answer |
|---|---|
| Is there a build stamp in the served HTML/JS? | No version, commit or build id is embedded. |
| Is `sites-build/index.js` the served client bundle? | No. It is a *Worker* bundle (99,986 B, contains `worker/db.js` SCHEMA). The served client bundle is the Vite output (`index-x3BrWCng.js`). |
| Does `sites-build/index.js` match the production deploy time? | It is dated **2026-11-12T16:04**, which is *after* the production deploy (2026-11-10) and coincides with the preview deploy (2026-11-12T10:35). It most likely represents the preview build, not production. |
| Is there a recorded commit → deployment mapping? | None. No CI, no deploy log, no tag, no release note. |
| Can the served JS be reconstructed from a commit? | **No.** The 45-file HEAD cannot build (11 imports are untracked), and even a complete build today produces a different hash. |

Therefore the deployed production artifact is identifiable **by hash** (§3) but not **by commit**. It can be
dated only indirectly: before 2026-11-15, and specifically from a tree at or before the 2026-11-10 deploy.

## 5. Marker comparison (public client bundles)

| Marker (compiled string) | Production | Preview | Current local build | Meaning |
|---|---:|---:|---:|---|
| `Current owner password` | 0 | 0 | 1 | F-19 UI field |
| `currentPassword` | 0 | 0 | 1 | F-19 request field |
| `reauth_required` | 0 | 0 | 1 | F-19 error-code handling |
| `ownerAuth` | 0 | 0 | 1 | F-07-2B config label |
| `Redeem invite` | 0 | 0 | 1 | F-07-2B claim flow |
| `Invite code` | 0 | 0 | 1 | F-07-2B claim flow |
| `managed identity` | 0 | 0 | 1 | F-07-2B managed login copy |
| `admin_token` | 1 | 1 | 1 | Legacy cleanup (present in all eras) |
| `paymentMethod` | 1 | 1 | 1 | Payment selection (present in all eras) |

Interpretation: the public client cannot even *offer* a current-password field, cannot send it, and has no
managed-auth flow. That is consistent with a pre-2026-11-15 build. `admin_token` being present in all three is
expected — the removal call has existed for longer and is not a differentiator.

## 6. What remains UNVERIFIED (stated, not assumed)

1. **The server-side Worker bytes are not publicly readable.** The client bundle and response headers are
   proxies, not the execution code. Everything about F-19/F-10 *enforcement* is therefore inference from
   provenance plus the header evidence, not direct observation.
2. **The production database's schema version** — `owner_sessions` may or may not exist there. Not queried.
3. **Whether the site holds real café data, real orders, or real money** — counts are non-zero (207,464 rows
   read; 266 KB stored) but content was not examined.
4. **Whether the Razorpay keys are test-mode or live** — value deliberately unread.
5. **Whether the site is actually being used by a café today** — the daily request counter showed 1 request for
   the current day at inspection time, which suggests low or no live traffic right now, while the monthly figure
   (12,320) shows it has served traffic.
6. **Whether the preview deployment is the 2026-11-12 build** — plausible from timestamps and `sites-build`
   dating, not proven.

## 7. Exposure assessment

### 7.1 F-19 — owner password change without re-authentication

| | |
|---|---|
| **Current source enforces** | `verifyOwnerReauth` runs before any hashing or UPDATE (`worker/api.js:2367-2438`, called at `:2513-2517`): missing current password → 400; wrong → 401 `reauth_required` with nothing written; 5 failures/10 min → 429; no hash or unsupported work factor → 409 operator reset; store failure → 503. A successful change bumps `auth_version` (other devices signed out) and reissues this browser's session. |
| **Historical artifact contains** | No `currentPassword`, no `verifyOwnerReauth`, no `reauth_required` (Stage 13 marker scan of `sites-build/index.js`). |
| **Public artifact evidence** | Production client: 0 occurrences of all three strings; deploy date 2026-11-10 < fix date 2026-11-15; live responses lack the F-04 header set from the same remediation wave. |
| **Assessment** | **Consistent with vulnerable.** On the deployed build, anyone holding a valid staff session — a shared tablet left signed in, a copied cookie, a stolen device — can replace the owner password **without knowing the current one**, and thereby lock the real owner out of their own café. |
| **Severity** | **HIGH** for the deployed environment. Not exploitable without a session, so it is not an unauthenticated takeover; it is a privilege-persistence flaw. |
| **Unverified** | The exact server code. Inference is strong (provenance + missing headers) but not a byte-level reading of the Worker. |

### 7.2 F-10 — owner session revocation

| | |
|---|---|
| **Current source enforces** | `owner_sessions` is a server-side allowlist (`worker/session.js`): a token is a session only if a live row matches `session_id` + `cafe_id`, within a 12 h idle window **and** a 24 h absolute cap. Ordinary sign-out deletes that row; sign-out-everywhere bumps `auth_version` via CAS and reissues the caller's session. Store errors fail closed with 503. |
| **Historical artifact contains** | No `owner_sessions` usage at all (0 occurrences across `sites-build/index.js`); the migration and the module postdate 2026-11-10. |
| **Public artifact evidence** | Production is the 2026-11-10 build; the owner-session table landed 2026-11-15. |
| **Assessment** | **Consistent with the pre-fix behaviour**: ordinary sign-out clears the browser cookie but does not invalidate the token server-side, so a copied cookie stays valid until its 12-hour expiry; there is no per-device revocation and no absolute cap. |
| **Severity** | **MEDIUM-HIGH** for the deployed environment (time-bounded: at most 12 h from issue under the old scheme). |
| **Unverified** | Whether the production D1 has the `owner_sessions` table (it would be inert in that build even if present). |

### 7.3 Related exposure found while checking the above

| Item | Evidence | Severity |
|---|---|---|
| **No security headers on the public site** (F-04) | Response headers in §3 | **HIGH** — no CSP (so any injected script is unrestricted), no frame protection (clickjacking), no HSTS (downgrade), no nosniff |
| **Payments enabled on a public, unapproved deployment** | `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` bound | **HIGH** — money can be taken by an unreviewed build; card/UPI UX and CSP assumptions for Razorpay were never verified on a live origin |
| **`ADMIN_PIN` still configured** | Binding list | **LOW-MEDIUM** — unused by current code; unknown for that build |
| **Unknown/unmanaged database** | `site-6e1c6f7a…`, 266 KB, 1,580 writes | **HIGH** — it is outside the documented backup regime (Stage 11/12 cover only `corner-cup-staging`) |

## 8. Incident statement

> **A publicly reachable production deployment of Corner Cup is serving a build from 2026-11-10. That build
> predates the 2026-11-15/16 security remediations, and its responses demonstrably lack the security-header
> set those remediations added. Razorpay credentials are configured on it. On the evidence available, the
> deployment permits an owner-password change from a session alone (F-19) and does not revoke owner sessions
> server-side (F-10). This is a potential active security incident requiring owner attention and a decision.**

Nothing was done about it in this stage: no unpublish, no secret rotation, no deploy. Those are decisions for
the owner (plan items R-1, R-3, R-4).

**If the owner decides to act immediately, the smallest safe action is to unpublish the production and preview
environments** — it retains code, data, secrets and URLs, stops serving within ~30 seconds, and is fully
reversible. Rotating `ADMIN_SECRET` also ends every existing session, but note it additionally invalidates guest
tracking links derived from it, so it is a bigger action.

## 9. Evidence inventory (preserved outside the repository)

`C:\Users\rahil\corner-cup-backups\stage13-1-20261120T114817Z\evidence\`

| File | Bytes |
|---|---:|
| `prod-root.html` / `prod-root.headers` | 1,145 / 662 |
| `prod-index-x3BrWCng.js` / `.headers` | 247,604 / 704 |
| `prod-index-CkJMrsdi.css` / `.headers` | 24,502 / 698 |
| `preview-root.html` / `preview-root.headers` | 1,145 / 666 |
| `preview-index-Cx9ssJ0q.js` | 252,164 |
| `preview-index-DFXcUnMc.css` | 28,199 |

These are public static assets only — no API response, no session, no credential, no customer data.
