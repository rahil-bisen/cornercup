# Corner Cup — Security Findings Register

Date: 2026-11-22 (supersedes nothing — `SECURITY_FINDINGS_MATRIX.md` remains the historical record)

This register carries forward every finding from the Stage 13–17 matrices and adds the Stage 17B
authentication findings. Status vocabulary: **Verified fixed** · **Partially verified** ·
**Open** · **Accepted risk** (documented and justified; never used to hide a critical).

---

## 1. Carried forward (F-01 … F-20)

| ID | Finding | Original | Current | Status | Note |
| --- | --- | --- | --- | --- | --- |
| F-01 | Deployment-wide fallback password | Critical | — | Verified fixed | Login reads only `cafe.pass_hash` |
| F-02 | Guessable guest order tracking | High | — | Verified fixed | 256-bit HMAC token, hash stored, header-only |
| F-03 | Unauthenticated payment/status mutation | High | — | Verified fixed | Guarded transitions, `guardPaid`, webhook re-checks |
| F-04 | Missing security headers | Medium | — | Verified fixed | CSP without `unsafe-*`, HSTS, `no-store` |
| F-05 | Operator create-café CSRF | High | — | Verified fixed | CSRF before body read |
| F-06 | Weak rate limiting | Medium | — | Verified fixed | Atomic D1 upsert, bounded windows |
| F-07 | Password hashing / managed identity | Critical | Medium | Partially verified | Provider contract needs a sandbox |
| F-08 | Unbounded request bodies | High | — | Verified fixed | Streaming counter, 16 bounded call sites |
| F-09 | Razorpay validation / production readiness | High | Low (disabled) | Partially verified | No live verification, no refunds |
| F-10 | Session revocation | High | — | Verified fixed | Live-row + version + idle window in SQL |
| F-11 | Cookie-name collision | Medium | — | Verified fixed | Full slug, capped length |
| F-12 | Malformed cookie parsing | Medium | — | Verified fixed | Fail closed, no throw |
| F-13 | PhonePe removal | Medium | — | Verified fixed | Zero references |
| F-14 | Order-ID collision retry | Medium | — | Verified fixed | Bounded retries, fresh credentials |
| F-15 | Health endpoint disclosure | Low | — | Verified fixed | `{status, database, time}` only |
| F-16 | Dependency vulnerabilities | Medium | — | Verified fixed | `npm audit` 0 |
| F-17 | Google Fonts privacy | Low | — | Verified fixed | Self-hosted WOFF2 |
| F-18 | Public menu/table exposure | Medium | — | Verified fixed | Allow-listed serializers |
| F-19 | Password change without current password | High | — | Verified fixed | Reauth + rate limit + version CAS |
| F-20 | Browser-observable security | Medium | — | Verified fixed (static) | No credential in web storage |

Behavioural/informational items N-01 … N-07 stay as recorded in `SECURITY_FINDINGS_MATRIX.md`; the
only one still open is N-06 (a raced counter-payment write can report "confirmed" while writing
nothing — behaviour, not an exploit).

---

## 2. Stage 17B additions

| ID | Finding | Severity | Status | Resolution / residual |
| --- | --- | --- | --- | --- |
| **F-21** | No second factor on the owner surface — one password yielded a full session | High | **Verified fixed** | RFC 6238 TOTP with verified enrollment; login is two-step; every owner route requires an MFA-backed session. Tests: `totp.vectors`, `mfa.flows` |
| **F-22** | TOTP codes replayable within the drift window | Medium | **Verified fixed** | Persisted `last_used_step` with a conditional UPDATE; a repeated step updates zero rows. Test: replay case in `mfa.flows` |
| **F-23** | TOTP seeds would sit in plaintext in D1 | High | **Verified fixed** | AES-256-GCM, random IV per write, HKDF-derived key; 503 if no usable key. Test: encryption round-trip + tamper |
| **F-24** | No recovery path if the authenticator device is lost | Medium | **Verified fixed** | 10 single-use SHA-256-hashed recovery codes, shown once, audited on use. Test: single-use case |
| **F-25** | No session inventory; no way to end one session or all sessions | High | **Verified fixed** | `GET /admin/sessions`, `POST /admin/sessions/:id/revoke`, revoke-all; atomic batch with `auth_version` bump |
| **F-26** | Removing a member did not end their session until expiry | High | **Verified fixed** | Membership resolved per request in `ownerSession()`; non-member ⇒ `SESSION_NONE`. Test: `owner.revocation`, `mfa.flows` |
| **F-27** | MFA state change left old sessions alive | Medium | **Verified fixed** | Enroll-confirm, disable and password reset delete sessions + challenges and bump `auth_version` |
| **F-28** | Partial CSRF coverage on mutating owner routes | High | **Verified fixed** | Token required on all ten mutating routes, enforced before body parsing; 10-route matrix test |
| **F-29** | Operator session survived an `OPERATOR_PASSWORD` rotation | Medium | **Verified fixed** | `credential_hash = sha256(trim(password))` compared per request; missing digest fails closed |
| **F-30** | No queryable authentication audit trail | Medium | **Verified fixed** | `auth_events` for success, failure, enrollment, recovery use, revoke and membership rejection |
| **F-31** | TOTP endpoint could be brute-forced | Medium | **Verified fixed** | Dedicated limiter, 5 attempts / 10 minutes per café+IP hash |
| **F-32** | Login challenge token could be replayed | Medium | **Verified fixed** | 32-byte token stored hashed, 5-minute expiry, deleted on use |
| **F-38** | The R2 binding was declared nowhere, so menu-photo uploads would answer 503 on any deployment built from this repository's own configuration | Medium | **Verified fixed** (2026-11-22) | `wrangler.jsonc` now declares `r2_buckets: [{binding:"IMAGES", bucket_name:"corner-cup-images"}]`. Verified over HTTP against real workerd R2: upload 200, GET 200 with `image/png` + `nosniff`, bytes round-trip, foreign café 404, missing CSRF 403, non-image 400, >1 MB 413, removal 200 then 404. Creating the bucket remains a deployment step (B-3) |

### Open and residual (Stage 17B)

| ID | Item | Severity | Status | Detail |
| --- | --- | --- | --- | --- |
| **F-33** | `ADMIN_SECRET` doubles as the MFA encryption key when `MFA_ENC_KEY` is unset | Medium | **Code fixed 2026-11-25; deployment secret outstanding** | `worker/totp.js` now requires `MFA_ENC_KEY` (exactly 32 random bytes, unpadded base64url), derives the AES-256-GCM key with HKDF and **has no `ADMIN_SECRET` fallback**: missing/malformed ⇒ `mfaConfigured=false`, enrollment 503, existing seed 503 rather than decrypting under another secret. `MFA_ENC_KEY_PREVIOUS` is decrypt-only for rotation. Enrollments written by an older build under `ADMIN_SECRET` cannot be migrated without that key; see `PRODUCTION_CONFIGURATION_INVENTORY.md` §6 for the re-enrollment procedure. No deployment has the new secret yet, so the configuration half stays open |
| **F-34** | TOTP is phishable in real time; no hardware-key option | Low | Accepted risk | TOTP chosen for zero cost and universal authenticator support |
| **F-35** | Recovery codes are only as safe as the owner's storage of them | Low | Accepted risk | Operator-assisted reset is documented in `DATABASE_MIGRATION_AND_RECOVERY.md` §7 |
| **F-36** | Security tab UI never visually inspected | Low | **Verified fixed** (2026-11-22) | Rendered and exercised in a browser at 360/390/430/1280: enrollment shows the secret and `otpauth` link, confirmation signs the board out, re-login demands the code, enabled state reports 10 recovery codes, session list and disable form render, no layout break. Note: two controls were driven with DOM `click()`/`requestSubmit()` because coordinate clicks were unreliable in the automation; a human pointer pass is still advisable |
| **F-37** | Argon2id CPU cost on Workers Free | Operational | **Unresolved (measurement pending)** | A temporary probe Worker (`corner-cup-cpu-probe`, deployed and deleted) recorded `/login` 65/67/68 ms, `/wrong` 53/62/67 ms, `/ping` 0 ms against the real Workers runtime — but these are **elapsed wall-clock timings, not platform-reported CPU time**. They do not independently establish CPU consumption and neither confirm nor exclude the Workers Free 10 ms/request ceiling. Workers Free compatibility stays unresolved until actual CPU time is measured in the deployed runtime (per-request CPU in `wrangler tail` or the Workers CPU histogram). The eventual options are Workers Paid or a separately approved design change; parameters must not be weakened. Argon2id unchanged at `m=19456, t=2, p=1`. Full evidence in `CORNER_CUP_FINAL_LAUNCH_READINESS_REPORT.md` §4 |

---

## 3. Summary

- Verified fixed across the project: **30 findings** (F-01…F-06, F-08, F-10…F-32).
- Partially verified: **2** — F-07 (needs a WorkOS sandbox), F-09 (Razorpay disabled by design).
- Open at the deployment layer: **1** — F-33 (code now mandates a dedicated key; no deployment has one yet).
- Unresolved pending measurement: **1** — F-37 (wall-clock timings exist; platform CPU time pending B-2).
- Closed in the finalization pass: **F-36** (Security tab inspected in a real browser).
- Closed in the one-pass completion: **F-38** (R2 binding declared; image upload verified end to end in workerd).
- Critical open: **0**. High open: **0**. Medium open: **1** (F-07 provider contract).

No finding was downgraded without a test or an inspection that justifies it, and no finding was
closed by relaxing a check.

---

## 4. Addendum — 2026-11-23 (all-in-one launch-readiness pass)

**New finding, fixed in this pass**

| ID | Severity | Finding | Resolution |
| --- | --- | --- | --- |
| F-39 | Low | Authentication and payment error messages were rendered as plain paragraphs, so assistive technology did not announce them (WCAG 4.1.3 Status Messages). | Added `role="alert"` to the nine error paragraphs in `Admin.jsx`, `Operator.jsx` and `PaymentPanel.jsx`. Verified live: the sign-in rejection is exposed as an alert and no session cookie is set. |

**Re-verified in source today, no change:** webhook raw-body HMAC before parsing; exact amount and
INR currency required to settle; `payment_status != 'confirmed'` guard on every settlement and on
staff downgrades; only the public key id reaches the browser; the built bundle contains no secret
value (the single scan match is an error message naming `ADMIN_SECRET`/`MFA_ENC_KEY`).

**Status counts after this pass:** F-33 open (deployment secret), F-37 partially verified
(wall-clock 65–68 ms only; Workers Free CPU ceiling unproven either way), F-38 and F-39 closed. Critical open 0, high open 0.
