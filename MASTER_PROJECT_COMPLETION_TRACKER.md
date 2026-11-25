# Corner Cup — Master Project Completion Tracker

Last updated: 2026-11-22
Branch: `freebuff/qr-code-cafe-ordering-website`
Baseline commit: `023befe`

This tracker records the state of the 19-section master completion mission. Every row states
what was verified, how it was verified, and what (if anything) is still outstanding.

Legend: **DONE** — implemented and verified locally · **DONE (UNVERIFIED UI)** — implemented and
covered by API tests, but not visually inspected · **BLOCKED** — cannot be completed from this
workspace without external access · **N/A** — not applicable within the mission constraints.

---

## 1. Constraints honoured

| Constraint | Status | Evidence |
| --- | --- | --- |
| Zero budget, no paid dependencies | DONE | `npm audit --omit=dev` → 0; no paid services added; Cloudflare Free plan only |
| No production deploy / republish / Razorpay enablement | DONE | No `wrangler deploy`, no `sites_deploy`, no dashboard calls performed |
| No destructive commands (`git reset`, `clean`, force push) | DONE | Worktree is dirty by design and preserved |
| External backup before any change | DONE | `%LOCALAPPDATA%\Temp\corner-cup-mission-backups\pre-mission-20261121T204056Z` (165 status entries captured) |
| No secrets printed or requested | DONE | All secrets referenced by name only; harness credentials are test-only constants already in the repo |
| Argon2id not weakened | DONE | Parameters untouched; see `SECURITY_FINDINGS_REGISTER.md` F-ARG |
| No fake verification | DONE | Every claim below maps to a command that was actually run |

---

## 2. Section-by-section status

### Section 1 — Repository inventory and baseline
**DONE.** 165 dirty entries catalogued, branch and commit recorded, full copy of the dirty worktree
archived before any edit. Pre-existing uncommitted work was left untouched; only new files were
added and files whose defects were in scope were modified.

### Section 2 — Build and test baseline before change
**DONE.** Baseline suite 475/475 passing, `npm run build` green. Recorded so later regressions are
attributable.

### Section 3 — Secret and credential hygiene
**DONE.** `worker/` reads secrets only from bindings (`env.ADMIN_SECRET`, `env.MFA_ENC_KEY`,
`env.OPERATOR_PASSWORD`, `env.WORKOS_*`). No literal secret added. `.env`/`.dev.vars` not read or
written. Service-worker hashing of the operator password keeps the plaintext out of D1.

### Section 4 — Owner authentication hardening audit
**DONE.** See `STAGE17B_AUTH_SECURITY_REPORT.md` §2. Findings from Stage 17A re-verified; the
remaining gaps (no second factor, no session inventory, no revocation UX) were closed.

### Section 5 — TOTP implementation (RFC 6238)
**DONE.** `worker/totp.js`: base32 encode/decode, HOTP/TOTP (SHA-1, 6 digits, 30 s step),
±1 step window, replay rejection via persisted `last_used_step`, `otpauth://` provisioning URI.
Verified against the RFC 6238 Appendix B vectors in `tests/totp.vectors.test.mjs`.

### Section 6 — Encrypted secret storage
**DONE.** AES-256-GCM with a per-secret random IV and `kid`-free single key derived by HKDF-SHA256
from `MFA_ENC_KEY` (falling back to `ADMIN_SECRET`). Tamper detection covered by test (bit-flip in
ciphertext fails to decrypt). If no usable key exists the endpoints answer 503 rather than storing
plaintext.

### Section 7 — Verified MFA enrollment
**DONE.** `POST /admin/mfa/enroll` issues a pending secret; `POST /admin/mfa/confirm` requires a
valid code before the secret becomes active. Enrollment does not enable MFA until confirmation, and
confirmation bumps `auth_version`, deletes sessions and challenges, and clears the cookie.

### Section 8 — MFA on every owner path
**DONE.** Login is two-step: password success yields a 5-minute, hashed, single-use challenge; only
`POST /admin/login/totp` mints a session. Every owner route requires the session cookie plus the
CSRF token; there is no password-only path to a session once MFA is confirmed.

### Section 9 — Recovery codes
**DONE.** 10 codes, shown once at enrollment, stored only as SHA-256 hashes, single-use
(`used_at` set in the same statement that matches the hash), and each use is recorded as an auth
event.

### Section 10 — Replay protection
**DONE.** TOTP replay blocked by a conditional `UPDATE … WHERE last_used_step IS NULL OR
last_used_step < ?`; recovery-code replay blocked by the hash+`used_at IS NULL` predicate; challenge
replay blocked by deleting the challenge row on success. All three are covered by tests.

### Section 11 — Session binding and revocation
**DONE.** Managed (WorkOS) sessions resolve membership on every request; a removed member's session
returns `SESSION_NONE`. Operator revoke deletes the session rows and bumps `auth_version` in one
batch. `GET /admin/sessions` lists active sessions and `POST /admin/sessions/:id/revoke` revokes
one. MFA changes invalidate all sessions. Sign-out-everywhere is implemented as revoke-all.

### Section 12 — CSRF on every state-changing owner route
**DONE.** Token issued with the session and required by header on login, logout, settings, menu,
orders, tables, MFA, session revoke and password change. Enforced **before** body parsing so a
forged request never reaches JSON decoding. Ten-route CSRF matrix test in
`tests/mfa.flows.test.mjs`. Test fixtures were updated to send real tokens rather than relaxing the
check (decision D-17B-9).

### Section 13 — Audit trail
**DONE.** `auth_events` records login success/failure, MFA challenge issued, MFA success/failure,
enrollment, disable, recovery-code use, session revoke and membership rejection, each with café,
actor, IP hash, user agent and timestamp.

### Section 14 — Image architecture
**DONE.** Resolution order (owner override → item default → category default → emoji) and the
52 px medallion are unchanged. Re-encoding stays outside the Worker: `image-pipeline/` implements
EXIF-strip/resize/encode and passes its own self-test 7/7.

### Section 15 — CI
**DONE (LOCAL).** `.github/workflows/ci.yml` is written and reviewed but has never executed on
GitHub; there is no remote in this environment. Local equivalent: the same command sequence was run
by hand (see `CI_AND_BUILD_INSTRUCTIONS.md`) and passed.

### Section 16 — Database migrations and recovery
**DONE.** Four new migrations plus `credential_hash`, applied idempotently by `init()`. Verified on
a **fresh** D1 database: 23 application tables (including `owner_totp`, `owner_totp_recovery`,
`owner_totp_challenges`, `auth_events`), the `credential_hash` column, 24 named indexes plus 14
SQLite autoindexes (38 index entries), the café row, 27 menu items and 8 tables seeded. Recovery
procedure documented in `DATABASE_MIGRATION_AND_RECOVERY.md`.

### Section 17 — Verification
**DONE.** 492/492 tests pass (0 fail), build green, `npm audit` 0, fresh-DB boot 200 twice with no
worker errors, image self-test 7/7.

### Section 18 — Documentation
**DONE.** See the deliverable index below.

### Section 19 — Final status
**CODE COMPLETE — EXTERNAL SETUP REMAINS.** See `MASTER_PROJECT_COMPLETION_REPORT.md` §7.

### Section 20 — Final launch-readiness mission (2026-11-22)
**DONE (local), with two conclusions later corrected.** A temporary probe Worker recorded 65/67/68 ms
(login), 53/62/67 ms (wrong password) and 0 ms (ping) on the real Workers runtime. Those are
**elapsed wall-clock timings, not platform-reported CPU time**, so they do not establish Workers CPU
consumption or the 10 ms Free per-request ceiling; Workers Free compatibility remains unresolved until
real CPU time is measured. Argon2id parameters were not weakened. R2 is disabled on the account
(error 10042); bucket creation is blocked. Production D1 existence and status are unresolved (Stage
16A identified a database under a different Freebuff account). DB drill passed 13/13. Full evidence
in `CORNER_CUP_FINAL_LAUNCH_READINESS_REPORT.md`; see the evidence correction in §9.

Probe directory removed; harnesses stopped. Git status remains dirty with no commits.

---

## 3. Deliverable index

| File | Purpose |
| --- | --- |
| `MASTER_PROJECT_COMPLETION_TRACKER.md` | This file |
| `MASTER_PROJECT_COMPLETION_REPORT.md` | Narrative completion report and final status |
| `STAGE17B_AUTH_SECURITY_REPORT.md` | What changed in owner auth and why |
| `SECURITY_FINDINGS_REGISTER.md` | Open/closed findings with severity and owner |
| `CI_AND_BUILD_INSTRUCTIONS.md` | How to build, test and run CI |
| `DATABASE_MIGRATION_AND_RECOVERY.md` | Migration inventory and recovery steps |
| `DISASTER_RECOVERY_RUNBOOK.md` | Appended Stage 17B addendum |
| `OPERATIONAL_READINESS.md` | Appended Stage 17B addendum |

---

## 4. Decision log (Stage 17B)

| ID | Decision | Rationale |
| --- | --- | --- |
| D-17B-1 | MFA secret encrypted with AES-256-GCM, key via HKDF-SHA256 from `MFA_ENC_KEY`, fallback `ADMIN_SECRET` | No new secret required for existing deployments; envelope-free single key keeps the code small |
| D-17B-2 | Missing/invalid encryption key ⇒ 503, never plaintext storage | Fail closed; storing a TOTP seed in the clear would defeat the control |
| D-17B-3 | Stateless password check plus stateful challenge row | The challenge row is what makes replay impossible |
| D-17B-4 | `auth_version` bump invalidates sessions on MFA change and membership removal | Cheap, atomic, no session-table scan on the hot path |
| D-17B-5 | Operator sessions store `sha256(trim(OPERATOR_PASSWORD))`; rotation invalidates | Password rotation must not require a migration step |
| D-17B-6 | Missing digest fails closed (no session) | Prevents legacy rows from surviving the change |
| D-17B-7 | CSRF enforced before body parsing | A forged request must not reach the JSON parser; also caps work done by attackers |
| D-17B-8 | `image_jobs` table deliberately **not** added | It would only be written by the GitHub Action, and that trust relationship does not exist yet; adding an unused table would imply a pipeline that is not wired |
| D-17B-9 | Test fixtures send real CSRF tokens instead of bypassing the check | A test-only bypass would mean the tested path is not the shipped path |
| D-17B-10 | Rate limit TOTP attempts per café+IP (5 / 10 min) in addition to login | TOTP is 6 digits; unbounded guessing is the obvious attack |

---

## 5. External blockers

| ID | Blocker | Effect | Unblocks with |
| --- | --- | --- | --- |
| B-1 | No GitHub CLI, token or SSH key in this environment | CI workflow never executed on a runner; image pipeline not wired; nothing pushed | `gh auth login` or a PAT/SSH key, plus explicit approval to push |
| B-2 | Argon2id CPU cost on Workers Free is unmeasured | Cannot assert the login path fits the 10 ms CPU budget | One non-public deployment, then `wrangler tail` timings |
| B-3 | R2 bucket not bound in `wrangler.jsonc` | Photo upload returns 503 "Storage is not configured" | `wrangler r2 bucket create` + binding, then redeploy |
| B-4 | Production D1 export blocked by account ownership | No independent production backup snapshot | Account owner runs the export in `DATABASE_MIGRATION_AND_RECOVERY.md` §5 |
| B-5 | Razorpay live verification not performed | Payment path only verified in test mode | Merchant account approval (explicitly out of scope) |
| B-6 | Real-café acceptance not performed | No evidence from an actual service shift | A pilot café using staging |
| B-7 | WorkOS production directory not configured | Managed owner login cannot be exercised against production | WorkOS project + directory sync |
| B-8 | Security tab not visually inspected | Layout/contrast of the new panel unconfirmed | Open `/admin` in a browser with an MFA-enabled owner |

---

## 6. Verification ledger

| Check | Command | Result |
| --- | --- | --- |
| Unit + integration suite | `npm test` | 492 pass, 0 fail |
| Production build | `npm run build` | success, 293.33 kB JS / 94.22 kB gzip |
| Dependency audit | `npm audit` | 0 vulnerabilities |
| Runtime audit | `npm audit --omit=dev` | 0 vulnerabilities |
| Fresh-DB migration | `wrangler dev --persist-to /tmp/freshdb-1`, `GET /api/health` ×2 | 200, no errors |
| Schema inventory | sqlite over the fresh persist dir | 23 application tables, 24 named + 14 auto indexes, seed data present |
| Image pipeline | `node image-pipeline/self-test.mjs` | 7/7 |
| Syntax of CI scripts | `node --check` on changed worker files | clean |

---

## 7. Finalization pass — 2026-11-22

Every finding F-01…F-37 was re-checked against the current source, not against the earlier reports.
Full detail lives in `CORNER_CUP_FINAL_RELEASE_CANDIDATE_REPORT.md`.

**Re-verified in source:** TOTP gate and replay counter, encrypted seed (AES-256-GCM + HKDF),
recovery-code single use, challenge single use, CSRF on all 16 mutating call sites (verified before
body parsing), per-request membership gate, atomic revocation with `auth_version`, operator
`credential_hash`, streaming body limits, image magic-byte/dimension validation, tenant scoping.

**Status changes:** F-36 (Security tab) **closed** — rendered and exercised in a browser at
360/390/430/1280. F-37 (Argon2id cost) **partially verified** — 129/161/158 ms per correct login,
152 ms per wrong one, measured end to end against local workerd; Cloudflare CPU still unmeasured.
F-33 remains open as a deployment configuration item.

**Re-executed gate:** 492/492 tests, build 293.59 kB JS / 94.32 kB gzip, `npm audit` 0 (all and
prod), `node --check` clean on every Worker module, image self-test 7/7.

**New evidence gathered:** live browser acceptance for guest ordering (pickup #1, token in fragment,
live status), sold-out propagation, image fallbacks, MFA enrollment → sign-out → two-step login,
operator console, and a full dump/restore/boot drill on a disposable D1 (integrity ok, no FK
violations, data and MFA seed preserved).

**Verdict:** `B. CODE COMPLETE — EXTERNAL SETUP REMAINS`. Blocker B-8 (human click-through) was
added; B-1…B-7 are unchanged.

---

## 8. One-pass final completion — 2026-11-22

A single continuous pass over the remaining locally resolvable work. GitHub was **paused by
instruction**: no CLI authentication, no repository, no remote, no commit, no push, no Actions run.
The 167-file publication snapshot was left untouched.

### What changed

- `wrangler.jsonc` — added the R2 binding:
  `"r2_buckets": [{ "binding": "IMAGES", "bucket_name": "corner-cup-images" }]`, with a comment that a
  deploy needs `wrangler r2 bucket create corner-cup-images`.
  This closes **F-38**: every photo upload would have answered 503 on a deployment built from the
  repository's own configuration, because `env.IMAGES` did not exist.
- No other source, test or config file was modified. The existing image handlers, validation, tests
  and harness fake-R2 binding were already correct and were left alone.

### What was re-verified rather than assumed

| Check | Result |
| --- | --- |
| `npm test` (harnesses on 8790/8789) | 492/492 pass, 0 fail, 0 skipped, exit 0, 107.9 s |
| `npm run build` | exit 0 — 293.59 kB JS / 94.32 kB gzip, 33.10 kB CSS / 7.22 kB gzip |
| `npm audit` (all and prod) | 0 vulnerabilities, exit 0 |
| `node --check worker/*.js` | clean |
| `node image-pipeline/self-test.mjs` | 7/7 |
| Real-R2 HTTP round trip (new) | 18/18 checks against `wrangler dev` with local R2 simulation |
| Mobile layout 360/390/430/1280 | scrollWidth 343/374/414/1263, zero page overflow, zero tap targets < 24 px |
| Sites publication state | both Corner Cup projects report `published: false` (unpublished_at set) |

### Infrastructure findings

- Freebuff Sites **does** support free R2 provisioning: `sites_add_storage` kind `r2`, allowance
  1 GB object storage, 25,000 writes and 250,000 reads per month. Nothing was provisioned (it creates
  an external resource and Project A must stay unpublished). Note the binding name must be `IMAGES`
  to match the code, not the default `FILES`.
- The Sites quota also caps **D1 storage at 100 MB** on this free tier (not Cloudflare's 5 GB D1
  allowance), 50M rows read and 100k rows written per month, and 5,000,000 ms of CPU per month.
- Per-invocation CPU for Workers Free remains **unmeasured** (B-2). Monthly CPU arithmetic alone does
  not settle the 10 ms per-request ceiling.

### Status changes

- **F-38 closed** (new finding, fixed in configuration and verified over HTTP).
- F-33 remains open (deployment secret `MFA_ENC_KEY`).
- Blockers B-1…B-8 unchanged; B-1 explicitly paused for this pass.

### Deliverables

`CORNER_CUP_ONE_PASS_FINAL_REPORT.md` (15 sections), this section, the master report addendum, the
register entry, the database document's R2 export gap (§8), the disaster-recovery media section (§9)
and the operational-readiness addendum.

**Verdict:** `CODE COMPLETE — EXTERNAL SETUP REMAINS`.

---

## 9. Final all-in-one launch readiness — 2026-11-23

A single continuous pass re-verified current reality instead of trusting earlier reports. GitHub,
deployment, publishing, payments and paid services remained untouched.

**Re-measured / re-run today**

| Check | Result |
| --- | --- |
| `npm test` (before the only edit) | 492/492 pass, 0 fail, 0 skipped, exit 0 |
| `npm test` (after the edit) | 492/492 pass, exit 0 |
| `npm run build` | exit 0 — 293.70 kB JS / 94.32 kB gzip |
| `npm audit` (all and prod) | 0 vulnerabilities |
| `node --check worker/*.js` | clean |
| Image self-test | 7/7 |
| Disposable DB drill | 13/13 pass |
| Browser layout 360/390/430/1280 | scrollWidth 343/374/414/1263, 0 overflow, 0 tap targets < 24 px |
| Guest checkout | pickup #1, ₹400 total, note preserved, token in fragment |
| Owner wrong password | rejected, no cookie |
| Frontend secret scan | 0 credential values in `dist/` |

**Changed this pass:** one accessibility fix — `role="alert"` on nine error paragraphs in
`Admin.jsx`, `Operator.jsx` and `PaymentPanel.jsx` (F-39). No authentication, hashing, binding,
migration or payment control was altered.

**Infrastructure:** R2 still returns `code 10042` (disabled on the account); the free Sites quota shows
1 GB R2 with 0 used, but attaching a Sites bucket requires deploying Project A, which is prohibited.
No bucket created, no data touched.

**Verdict:** `CODE COMPLETE — EXTERNAL SETUP REMAINS`. See
`CORNER_CUP_FINAL_LAUNCH_READINESS_REPORT.md`.

### Evidence correction — 2026-11-23 (documentation only)

Two statements in this tracker and its addenda outran their evidence. The historical entries are kept as
recorded, with the corrections below rather than a silent rewrite.

1. **Argon2id CPU.** `m=19456 KiB, t=2, p=1`, unchanged. Previous login measurements of
   approximately 65–68 ms are **elapsed wall-clock timings** and do not independently establish
   Cloudflare CPU consumption. Workers Free compatibility remains unresolved until actual
   platform-reported CPU time is measured in the deployed Worker runtime. Do not weaken the hashing
   parameters to obtain a passing result.
2. **Production D1.** Existence and current status remain **unresolved**. Stage 16A previously
   identified a production D1 database under a different Freebuff account:
   `site-6e1c6f7a9a9f4e098f778f9754221b0a`, ID `17d9568d-52fd-48c2-8761-b74d97688589`. The latest
   authenticated-account check did not find a production database, but this does not establish that the
   previously identified database was deleted or does not exist. No production export or backup has
   been obtained. Account ownership and access must be confirmed with Freebuff support or the account
   owner.

Blocker B-2 therefore stays open in its original, unmeasured form, and B-4 stays open for an additional
reason: ownership and existence are unconfirmed.
