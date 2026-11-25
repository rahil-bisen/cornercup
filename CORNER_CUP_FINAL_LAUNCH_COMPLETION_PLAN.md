# CORNER CUP — FINAL LAUNCH COMPLETION PLAN

**Date:** 2026-11-24
**Authoritative for launch status.** Where this document and an earlier report disagree, this one wins, and the
disagreement is listed in §13.
**Documentation only.** Nothing was deployed, published, or changed in Cloudflare, staging, production, secrets,
bindings, databases or authentication. No Git operation was performed.

---

## 1. Executive verdict

**NOT APPROVED FOR LAUNCH.**

The software is complete and passes its full gate: **532/532 tests, exit 0** (re-run 2026-11-25; 492/492 was
the 2026-11-24 count before the MFA-recovery, menu-editing and MFA-key tests were added — see §12.1/§12.2),
production build exit 0,
`npm audit` 0 vulnerabilities on both trees, `node --check` clean on all 17 Worker modules, image pipeline
7/7, and a disposable dump/restore check 8/8 against the harness database. No open code defect is known.

What is missing is not code. Five things stand between this build and a café:

1. **R2 is disabled on the owner's Cloudflare account** (`10042 NotEntitled`) — menu-photo uploads cannot work
   until the account has an R2 subscription. Only the account owner can do this, in the dashboard.
2. **The production D1 is under Freebuff's platform account**, not the owner's. Its platform metadata is
   intact, but **no export or backup of that data exists** and access is unresolved.
3. **The Argon2id derivation's CPU cost is still unmeasured.** What was measured (39–59 ms per cold API request
   on staging) says something about that Worker, not about Argon2id and not about the account's plan.
4. **Configuration gaps** — the code now requires a dedicated `MFA_ENC_KEY` but no deployment has one, a legacy
   `OWNER_PASSWORD` is still present on the old production environment, Razorpay is half-configured.
5. **No human has performed the acceptance checklist**, and real R2 upload/read/delete has never been verified.

Every one of those is an owner or support action, or a person with a phone. None is an engineering task.

---

## 2. Completed code and security work

| Area | State |
|---|---|
| Owner authentication | Per-café Argon2id password (`m=19456 KiB, t=2, p=1`), exact-parameter allowlist on read, one derivation at a time with a bounded queue, legacy PBKDF2 above 100k iterations fails closed |
| Second factor | RFC 6238 TOTP, 6 digits / 30 s / ±1 step, replay guard on `last_used_step`, 5-minute single-use password→TOTP challenge, 10 single-use recovery codes stored as SHA-256 digests |
| Sessions | Server-side `owner_sessions` rows, cookie `staff_session_<slug>`, HttpOnly, sameSite=Strict, Secure on https, 12 h idle / 24 h absolute, `auth_version` invalidation on password change or sign-out-everywhere |
| CSRF | Origin equality **and** a hashed token bound to the live session row |
| Multi-tenancy | Per-café credentials, per-café cookies, no shared fallback password |
| Ordering | Server-side price recomputation, integer paise, idempotent checkout claim, 16 KB body cap, 40-line cap |
| Tracking | Order token in the URL fragment + header, never in path/query; invalid token shows "ask our staff" |
| Payments | Razorpay only when both keys exist; otherwise counter payment. Card data never reaches the Worker |
| Images | EXIF-strip/resize/WebP pipeline with a 7/7 self-test; upload path answers 503 when `IMAGES` is absent |
| Security findings | F-37 remains "Unresolved (measurement pending)"; F-39 (`role="alert"`) fixed |
| Earlier audit evidence | 492/492 twice previously, audit 0 on both trees, backup round trip byte-identical, disposable D1 drill 13/13 |

Today's full gate is in §12. Nothing in the working tree was modified by this review.

---

## 3. R2 — `NotEntitled`, and the exact owner action

`npx wrangler r2 bucket list` on account `bca798cecc7dc814299016c208b96ebd` returns:

```
Please enable R2 through the Cloudflare Dashboard. [code: 10042]
```

Cloudflare's error reference defines `10042` as **`NotEntitled`** (HTTP 403): the account has no R2
subscription. It is not `AccessDenied` (10003), not a missing bucket, and not fixable in this repository.

**Owner steps (dashboard only — Wrangler has no enablement command):**

1. Sign in to <https://dash.cloudflare.com> as `rahilbisen8@gmail.com`.
2. **Storage & databases → R2 → Overview** → complete the "Add R2 subscription" checkout ($0 on the free tier;
   a payment method is required).
3. Confirm **Billing → Subscriptions** lists R2. If activation loops ("subscription update already in
   progress" / returns to the enable screen), open a **Billing** ticket quoting the account ID, `10042`, and
   `GET /accounts/…/r2/buckets`; do not click Activate repeatedly.
4. Verify: `npx wrangler r2 bucket list` returns an empty table instead of `10042`.
5. **Then**, with explicit approval, `npx wrangler r2 bucket create corner-cup-images`.

**Not done, deliberately:** no bucket created, no deploy performed to attach one, no alternate bucket or account
used, no paid plan purchased. The Sites free allowance (`r2Bytes` 1 GB, 0 used) is a platform allowance and does
**not** enable R2 on the owner's own account.

**Until this is done:** uploads answer 503 and menu items keep their bundled defaults. A pilot can run only if
every item on that café's menu uses a bundled default image — to be checked against the real menu, not assumed.

---

## 4. Production D1 — ownership, evidence, export status

**Identity (preserved exactly as Stage 16A recorded it, re-confirmed 2026-11-24):**

| Property | Value |
|---|---|
| Database name | `site-6e1c6f7a9a9f4e098f778f9754221b0a` |
| Database ID | `17d9568d-52fd-48c2-8761-b74d97688589` |
| Binding | `DB`, record `b80703c2-944c-460d-8a21-57ea05a80bf9`, created 2026-11-09T16:14:26Z |
| Platform account | `6e5a40dd9362fb315de7ecbaad2ca12b` (`freebuff-sites-prod`) |
| Site / environment / worker | `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63` / `fa58771d-25fb-4936-bbad-5cffd6ff3973` / `site-fa58771d25fb4936bbad5cffd6ff3973` |
| Reported storage | 266,240 bytes (`d1Bytes` 266,240 of 100,000,000) |
| Publication | `published: false`, unpublished 2026-11-20T12:21Z |

**What the evidence proves — and does not.** The site record, environment record, `DB` binding and the original
provisioning receipt (`kind: "d1"`, `state: "succeeded"`) are intact in platform metadata as of 2026-11-24.
That is **platform metadata only**. It does **not** prove the underlying database exists, is readable, or has
been backed up, and it does **not** prove deletion. The latest authenticated-account check
(`wrangler d1 list` on `bca798ce…` → only `corner-cup-staging` and the Stage 11 restore DB; `d1 info` for both
the name and the ID → "Couldn't find a D1 DB") shows only that this account does not own it.

**Export status: none has been obtained** (re-checked 2026-11-25). No dump, no checksum, no encrypted artefact
of production data exists anywhere. The exact handover requirements (seven fields, including the database id,
UTC timestamp, byte size and SHA-256) and the tested verifier are now in
`PRODUCTION_D1_RECOVERY_PROCEDURE.md`. The procedure to run once access exists is proven (export → SHA-256 → AES-256-CBC/PBKDF2-200k
→ decrypt and `cmp` → import into a fresh SQLite → `integrity_check` / `foreign_key_check`), and it was last
demonstrated byte-identically on a disposable database.

Two traps, both real: never create a database with that name in the owner's account (Wrangler resolves by name
and would export the wrong one), and never "clean up" by deleting the Sites project — that destroys the
database along with the code.

---

## 5. Argon2id CPU — what is measured and what is not

**Measured (2026-11-24, `wrangler tail --format json`, platform `cpuTime`, staging Worker `corner-cup-staging`
version `80f92ceb…`; no deployment made):**

| Request | Platform CPU | Wall |
|---|---|---|
| `GET /api/health` (cold isolate) | 42 ms | 4,957 ms |
| `POST …/admin/login` (no stored hash) | 2 ms | 120 ms |
| `GET /api/cafe` (cold isolate) | 49 ms | 5,639 ms |
| `GET /` (static) | 0 ms | 311 ms |
| warm `/api/health`, `/api/cafe` | 1 ms, 1 ms | ~120 ms |
| repeat run | 39, 52, 59 ms cold; 0–1 ms warm/static | — |

**What this means:** platform CPU is available and is not latency. Requests costing 39–59 ms of CPU were served
normally, with no CPU-limit termination. **Do not infer the account's billing plan from this** — the plan was
not read from billing and is unknown. The dominant cost is `ensureDb`, which runs the schema batch once per
isolate on every `/api/*` request; the Argon2 path is not in these numbers at all.

**Not measured: the Argon2id derivation.** The staging café has `pass_hash = NULL` (`hashlen=0`), so the login
returned 503 "This café hasn't set an owner password yet" **before any derivation ran**. Producing a hash there
needs the operator credential (value unreadable) or an owner session — a configuration/credential change, which
is prohibited. The recorded 65/67/68 ms and 53/62/67 ms figures remain **elapsed wall-clock**, never CPU.

**2026-11-25 update — the derivation itself is now measured as CPU, not wall clock.**
`scripts/measure-argon2-cpu.mjs` runs the same wasm module with the same parameters and reports process CPU:
**p50 31–47 ms, max 63–94 ms per derivation** across three runs on the development machine, idle and under
load (`ARGON2ID_CPU_COMPATIBILITY.md` §7). That
answers "how much CPU does the hash cost" — tens of milliseconds — but not "what does the platform charge for
it, and what is the plan's ceiling". If the target is Workers Free (10 ms), these parameters cannot fit;
the choice remains Workers Paid or an approved design change. The platform figure is still owed.

**Consequence:** compatibility is **unresolved**. `m=19456 KiB, t=2, p=1` is unchanged and must not be weakened.
The exact procedure to finish the measurement — with no deployment — is in `ARGON2ID_CPU_COMPATIBILITY.md` §5:
one tail session, 10 correct + 10 wrong sign-ins, a static baseline, report p50 and max, mind the 8-per-10-minute
lockout.

---

## 6. Production configuration gaps

Full detail: `PRODUCTION_CONFIGURATION_INVENTORY.md`. No secret value was read or printed anywhere.

| Gap | State | Why it matters |
|---|---|---|
| **`MFA_ENC_KEY`** | **Required by the code since 2026-11-25; set on no deployment** (local pilot has its own independent key; staging, old production and future production do not) | The `ADMIN_SECRET` fallback is **removed**. `worker/totp.js` accepts only exactly 32 base64url bytes, derives the AES-256-GCM key with HKDF, and fails closed (503) when the key is missing or malformed. A deployment without it cannot enroll or verify a second factor. `MFA_ENC_KEY_PREVIOUS` is decrypt-only for rotation |
| **`OWNER_PASSWORD`** | **Set on the old production environment** | It is a first-café bootstrap value only (guarded by `pass_hash IS NULL`, 12–100 chars). Production cafés must be created from `/operator`. Remove it at the next deploy; never set it on a new one |
| **Razorpay** | `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` present on the old production env; **`RAZORPAY_WEBHOOK_SECRET` absent** | Payments were never fully configured there. The keys must not carry over to the pilot; with them absent the guest is offered counter payment. There is no refund path in this build |
| `ADMIN_PIN` | Listed in `.dev.vars.example`; present on old production | **Dead config** — no `env.ADMIN_PIN` read path exists in `worker/`. Misleading, not dangerous |
| `ORDER_TRACK_SECRET` | Not set anywhere | Optional: tracking tokens derive from `ADMIN_SECRET` |
| `RAZORPAY_WEBHOOK_SECRET`, `TELEGRAM_*`, `WORKOS_*` | Not set | Optional; WorkOS is unused by the password + TOTP flow |
| `DB` binding | `wrangler.jsonc` still holds the placeholder id `00000000-…` | Correct for this repository, wrong for any deploy |
| `IMAGES` binding | Declared, never attached to a real deployment | R2 disabled on the account (§3) |

Required for any authenticated surface and currently **not set for a future production deployment**:
`ADMIN_SECRET`, `OPERATOR_PASSWORD`, `MFA_ENC_KEY`.

---

## 7. Human acceptance — status: NOT RUN

`HUMAN_ACCEPTANCE_CHECKLIST.md` defines 13 checks in 10–15 minutes: password + TOTP sign-in, invalid TOTP,
recovery-code single use, session invalidation after a security change, owner security settings, menu/price
editing, image upload/display/removal, guest ordering, kitchen status transitions, guest tracking, counter queue
numbering, invalid tracking token, keyboard navigation and accessible error announcements.

**No item has been performed by a person.** Nothing may be reported as passing until it is. The existing staging
Worker cannot host tests 1–5: its version predates the MFA schema and its D1 has **no `owner_totp`,
`owner_totp_recovery`, `owner_totp_challenges` or `auth_events` tables**. Acceptance requires an isolated
environment running the current build.

---

## 8. First-café pilot readiness

`FIRST_CAFE_ONBOARDING_CHECKLIST.md` now carries the operational half (§§12–16): MFA enrollment and
recovery-code custody off-device, staff access (one café device — there are no per-staff accounts), payments
staying disabled, end-of-shift reconciliation, and a pilot-day run sheet with a paper fallback.

Readiness by capability:

| Capability | Ready? |
|---|---|
| Create café, owner password, mode, tables | Yes (code + tests) |
| Owner sign-in with TOTP | Yes in code; **not human-verified**; staging build lacks the tables |
| Menu, categories, prices, availability | Yes |
| Guest ordering, queue numbers, tracking | Yes (code + tests) |
| Kitchen transitions | Yes |
| Photo upload | **No** — R2 disabled |
| Online payment | **No, by design** — must stay off |
| End-of-shift reconciliation | Procedure written; never performed |
| Staff permissions | Single shared credential per café; no roles. Accepted limitation, must be documented to the café |

---

## 9. Backup and restore readiness

| Item | State |
|---|---|
| Procedure | Export → SHA-256 → AES-256-CBC/PBKDF2-200k → decrypt + `cmp` → import into fresh SQLite → `integrity_check` + `foreign_key_check`. Documented in `DISASTER_RECOVERY_RUNBOOK.md`, `DATABASE_MIGRATION_AND_RECOVERY.md` §7a |
| Proven | Yes, on disposable databases: encrypted round trip byte-identical, 24 tables, `integrity_check=ok`, FK 0; earlier drill 13/13 |
| Re-run today | Disposable copy/restore of the harness D1: **8/8**, `integrity_check=ok`, FK 0, 24 tables / 38 indexes preserved |
| Production backup | **None obtained** (§4, re-checked 2026-11-25). Ownership unresolved; handover criteria in `PRODUCTION_D1_RECOVERY_PROCEDURE.md` |
| Restore drill on a real backup | **Never performed** — only disposable databases. On 2026-11-25 a real D1 dump was restored, integrity-checked (23 tables, 38 indexes, FK 0) and round-tripped through encryption byte-identically with `scripts/verify-d1-export.mjs` |
| RPO/RTO | RPO = last successful export (none exists); DB-only RTO measured at ~30 min, full recovery ~60 min estimated and never exercised |

The restore path is trustworthy for *a* database. It is untested against the *production* database because that
database is not reachable.

---

## 10. Exact owner and Freebuff support actions

**Account owner (in this order)**

1. **Enable R2** in the Cloudflare dashboard (§3), verify `wrangler r2 bucket list` returns empty, then approve
   `wrangler r2 bucket create corner-cup-images`.
2. **Send the support request** in `EXTERNAL_BLOCKER_ESCALATION_PACKET.md` §2.5 (site, environment, worker,
   binding record, DB name and ID, provisioning receipt) and ask support to (a) confirm the database exists,
   (b) export it with a SHA-256, or (c) grant scoped read-only access for the export, or (d) state plainly that
   it is gone.
3. **Set `MFA_ENC_KEY`** to an independent 32+ character random value on the pilot deployment; keep
   `ADMIN_SECRET` and `OPERATOR_PASSWORD` distinct from it and from each other.
4. **Do not set `OWNER_PASSWORD`** on the pilot deployment; remove it (and the dead `ADMIN_PIN`) from the old one.
   Keep every `RAZORPAY_*` variable unset.
5. **Take one platform CPU reading** for the Argon2 login using `ARGON2ID_CPU_COMPATIBILITY.md` §5, and record the
   plan name at the same time.
6. **Run the acceptance checklist** on a device with an authenticator app, then enroll TOTP and store the
   recovery codes off-device.
7. **Run one staffed pilot shift** with payments off, then the end-of-shift reconciliation.

**Freebuff support**

- Resolve `17d9568d-52fd-48c2-8761-b74d97688589` ownership and export (§4). Nothing else in this plan blocks
  on support.

**Not authorised in this pass, and not done:** publishing either Sites project, deploying any Worker, creating
or deleting resources, changing secrets or bindings, touching the database, GitHub operations.

---

## 11. Remaining risks

| Risk | Severity | Mitigation |
|---|---|---|
| R2 disabled → no photo uploads | Medium | Run the pilot on bundled default images, or wait for enablement |
| Argon2id CPU unmeasured | **High** (launch gate) | §5 procedure; decide Workers Paid vs. approved change; never weaken the hash |
| `ensureDb` costs 39–59 ms CPU per cold isolate | Medium | Independent of Argon2; if the target plan is 10 ms-capped, this alone breaks every `/api/*` call. Address before relying on a Free plan |
| Production data has no backup | **High** | Support/owner export (§4); no relaunch over that database until it exists |
| Human acceptance never performed | **High** | §7 says it plainly — until a person runs it, nothing is verified |
| TOTP secrets share key material with `ADMIN_SECRET` | Medium | Set `MFA_ENC_KEY` (#3 above) |
| Single shared staff credential per café | Medium | Documented limitation; secure the café device |
| Staging runs an older build without MFA tables | Medium | Never use it for auth acceptance; deploy the current build to an isolated environment |
| `OWNER_PASSWORD` / Razorpay keys left on the old env | Medium | Remove before any republish |
| No per-staff accounts, no refunds, no reporting export | Low–Medium | Accepted scope; tell the café |

---

## 12. Verification run today (2026-11-24, current working tree)

| Check | Command | Result | Exit |
|---|---|---|---|
| Test suite | `npm test` with harnesses on `127.0.0.1:8790` (auth) and `:8789` (batch) | **492 tests, 492 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo**, 97.3 s | **0** |
| Production build | `npm run build` | `dist/index.html` 0.81 kB (gzip 0.49), CSS 33.10 kB (7.22 gzip), JS 293.70 kB (94.32 gzip), built in 1.48 s | **0** |
| Audit (prod deps, high) | `npm audit --omit=dev --audit-level=high` | `found 0 vulnerabilities` | **0** |
| Audit (all deps) | `npm audit` | `found 0 vulnerabilities` | **0** |
| Worker syntax | `node --check worker/*.js` (17 modules) | clean, no output | **0** |
| Image pipeline | `node image-pipeline/self-test.mjs` | **7/7 checks passed** | **0** |
| Disposable DB copy/restore | local byte copy of the harness D1, then `integrity_check` + `foreign_key_check` | **8/8**; 24 tables, 38 indexes, row counts preserved, FK 0 | **0** |

Notes, stated rather than smoothed over:

- The first `npm test` invocation failed with `ECONNREFUSED 127.0.0.1:8790` because the documented harness
  prerequisite (`CI_AND_BUILD_INSTRUCTIONS.md` §3) was not running. Both harnesses were started on isolated
  `--persist-to` directories, health-checked (HTTP 200 on both), and the suite then passed. **No test was
  skipped, weakened or edited.**
- The harnesses were stopped afterwards; ports 8789/8790 were left closed.
- No defect was found, so nothing was refactored or "fixed".

---

### 12.1 Re-run 2026-11-25 (current working tree)

| Check | Command | Result | Exit |
|---|---|---|---|
| Test suite | `npm test` with harnesses on `127.0.0.1:8790` (auth) and `:8789` (batch) | **532 tests, 532 pass, 0 fail, 0 skipped, 0 cancelled, 0 todo**, 84.2 s | **0** |
| Production build | `npm run build` | JS 299.49 kB (95.52 gzip), CSS 33.10 kB (7.22 gzip), `index.html` 0.81 kB, built in 1090 ms | **0** |
| Audit (prod deps, high) | `npm audit --omit=dev --audit-level=high` | `found 0 vulnerabilities` | **0** |
| Audit (all deps) | `npm audit` | `found 0 vulnerabilities` | **0** |
| Worker syntax | `node --check worker/*.js` | clean | **0** |
| Image pipeline | `node image-pipeline/self-test.mjs` | **7/7** | **0** |
| Disposable D1 dump → restore | `scripts/verify-d1-export.mjs` on a 451,389-byte harness export | 23 tables, 38 indexes, `integrity_check=ok`, FK 0; encrypted round trip byte-identical (same SHA-256) | **0** |
| Argon2 derivation CPU | `scripts/measure-argon2-cpu.mjs` (asserts source params, wasm imports, salt/tag) | p50 47 ms on this run (31–47 across three), max 63 ms; local process CPU, **not** platform | **0** |
| Local pilot health | `GET http://127.0.0.1:8788/api/health` | `{"status":"ok","database":"ok"}` — no order created or changed | **0** |

### 12.2 MFA key hardening (2026-11-25)

`worker/totp.js` now derives the AES-256-GCM key **only** from `MFA_ENC_KEY`:

| Property | Before | After |
|---|---|---|
| Key material | `MFA_ENC_KEY \|\| ADMIN_SECRET`, any value ≥16 chars | `MFA_ENC_KEY` only, exactly 32 bytes as unpadded base64url (43 chars), canonical re-encode check |
| Fallback | Silent HKDF(`ADMIN_SECRET`) | **None** — missing/malformed ⇒ `mfaConfigured=false`, enrollment 503, existing seed 503 |
| Envelope | `iv.ciphertext` | `v2.iv.ciphertext`; the old two-part form is still accepted under the same key |
| Rotation | Not supported | `MFA_ENC_KEY_PREVIOUS` is **decrypt-only**; a missing current key is fatal even with it set |
| KDF / cipher | HKDF-SHA256 → AES-256-GCM, 12-byte IV, AAD | Unchanged (same salt/info/AAD, so the pilot's existing rows decrypt) |

Tests added: 9 unit tests in `tests/totp.vectors.test.mjs` (missing, malformed, valid, independence from
`ADMIN_SECRET`, legacy envelope, rotation, previous-only refusal; three fallback-era tests replaced, net +6)
and 2 HTTP tests in `tests/mfa.flows.test.mjs`
(unavailable/503 without a key; enrolled café fails closed and recovers). Total suite: **532/532**.

Human acceptance: **not run** for this change — see `HUMAN_ACCEPTANCE_CHECKLIST.md` §C. An owner with an
enrollment written by an older build under `ADMIN_SECRET` cannot be migrated without that key; the documented
recovery is re-enrollment (operator clears the TOTP rows after identity verification), which is destructive
and was **not** performed.

**§12.1 notes:** the bundle grew from 293.70 kB to 299.49 kB because of the menu-editing and MFA-recovery work already
in the tree, not from this pass. Harness workerd processes were terminated by PID afterwards and ports
8789/8790 are closed; the local pilot on 8788 was not touched. **No test was skipped, weakened or edited.**

---

## 13. Superseded statements (so no earlier report misleads)

| Earlier statement | Correction |
|---|---|
| "Workers Free cannot run the current owner login; the Free 10 ms ceiling is exceeded" | Not established. Those were wall-clock figures; the Argon2 CPU is unmeasured (§5) |
| "Production D1 does not exist" | Never claimed and never established. Metadata is intact; data state and export are unresolved (§4) |
| "TOTP second factor not implemented" (in `FIRST_CAFE_ONBOARDING_CHECKLIST.md`) | Implemented and tested; that line was corrected on 2026-11-24 |
| "47 ms locally vs 10 ms Free" (same file) | Superseded by the platform data in §5 |
| "`MFA_ENC_KEY` separates the MFA key" | **Code fixed 2026-11-25:** a dedicated key is mandatory, strict-validated and there is no `ADMIN_SECRET` fallback. **Configuration still open:** no deployment has one yet, so F-33 remains open at the deployment layer (§6) |
| "The software passes 492/492 tests" (2026-11-24) | Superseded by **532/532** on 2026-11-25 (§12.1/§12.2); the extra tests cover MFA recovery-code regeneration, menu editing, and MFA key validation/rotation |
| "Backup verified" | Verified only against disposable databases; **no production backup exists** (§9) |

---

## 14. Objective launch approval criteria

Launch is approved only when **every** line is true, with evidence attached for each:

- [ ] Full gate green on the exact commit to be deployed: `npm test` 532/532 (2026-11-25), build exit 0, both audits 0,
      `node --check` clean, image self-test 7/7.
- [ ] R2 enabled on the account; `corner-cup-images` exists; real upload → display → delete verified on the
      deployed environment (checklist #7).
- [ ] All 13 human acceptance checks pass on an isolated environment running the current build, signed and
      dated by the person who ran them.
- [ ] A production D1 export exists, with a SHA-256, encrypted at rest, and a restore from **that** artefact has
      been drilled (`integrity_check=ok`, FK 0) — or the owner formally accepts starting without the old data.
- [ ] Argon2id CPU measured with platform `cpuTime` on the deployed build: p50 and max recorded, plan named, and
      a decision recorded (stay on the current plan, or Workers Paid, or an approved design change). No parameter
      reduction.
- [ ] `ADMIN_SECRET`, `OPERATOR_PASSWORD`, `MFA_ENC_KEY` set as three distinct values on the deployment (`MFA_ENC_KEY` = exactly 32 random bytes, unpadded base64url);
      `OWNER_PASSWORD`, `ADMIN_PIN` and all `RAZORPAY_*` absent.
- [ ] Owner TOTP enrolled, 10 recovery codes stored off-device, one code used and one reuse refused.
- [ ] Payments confirmed disabled (`provider: none`) unless separately approved with a tested refund path.
- [ ] One staffed pilot shift completed with reconciliation signed, or an explicit owner decision to launch
      without a pilot.

**Until then: NOT APPROVED FOR LAUNCH.**
