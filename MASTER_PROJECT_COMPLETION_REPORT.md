# Corner Cup — Master Project Completion Report

Date: 2026-11-22
Branch: `freebuff/qr-code-cafe-ordering-website` (baseline `023befe`)
Scope: the 19-section master completion mission, executed inside the stated constraints.

---

## 1. Final status

**CODE COMPLETE — EXTERNAL SETUP REMAINS**

Every code-level item in the mission is implemented and verified locally. The remaining items are
all external: GitHub access, a non-public deployment for CPU measurement, R2 provisioning, the
production D1 export, Razorpay merchant approval, WorkOS production directory, and a pilot café.

Nothing in this report was deployed. No production resource was touched.

---

## 2. What exists now that did not before

| Area | Change |
| --- | --- |
| Second factor | Full RFC 6238 TOTP: enrollment, verified confirmation, login gate, encrypted seed storage, replay protection |
| Recovery | 10 hashed single-use recovery codes, shown once, each use audited |
| Sessions | Inventory endpoint, per-session revoke, revoke-all, membership gating on every managed request, invalidation on MFA change |
| CSRF | Required on all ten state-changing owner routes, enforced before body parsing |
| Audit | `auth_events` table recording every authentication outcome with actor, café, IP hash, UA, timestamp |
| Operator auth | Sessions bound to `sha256(OPERATOR_PASSWORD)`; rotation invalidates; missing digest fails closed |
| Tests | +17 tests, two new suites (RFC vectors, MFA flows including a 10-route CSRF matrix); suite now 492/492 |
| CI | `.github/workflows/ci.yml` (prepared, never executed on a runner) |
| Images | EXIF-strip/resize/encode pipeline in `image-pipeline/` with 7/7 self-test and a prepared workflow |
| Docs | Tracker, this report, Stage 17B report, findings register, CI instructions, migration/recovery doc, two runbook addenda |

---

## 3. Security posture

The control set that a café owner actually depends on is now:

1. **Password + second factor** to obtain any owner session.
2. **Single-use, short-lived challenge** between the two steps.
3. **CSRF token** on every mutating route, checked before any body is parsed.
4. **Per-request membership check** for managed sessions, so removing a person removes their access
   on the next request rather than at the next expiry.
5. **Atomic revocation**: deleting a session row and bumping `auth_version` happen in one batch.
6. **Audited everything**: every success and failure path writes an `auth_events` row.
7. **Fail closed**: no encryption key ⇒ 503; no operator digest ⇒ no session; unknown membership ⇒
   `SESSION_NONE`.

Explicitly **not** weakened: Argon2id parameters, existing rate limits, existing origin checks.
Explicitly **not** added: session-length shortcuts, test-only CSRF bypasses, plaintext secrets.

Residual risks are catalogued in `SECURITY_FINDINGS_REGISTER.md`; the material one is that a
compromised `ADMIN_SECRET` (when used as the MFA key fallback) would expose TOTP seeds. Setting a
dedicated `MFA_ENC_KEY` removes that coupling.

---

## 4. Verification performed

| Check | Result |
| --- | --- |
| `npm test` | **492 pass / 0 fail** |
| `npm run build` | success; 293.33 kB JS, 94.22 kB gzip |
| `npm audit` | 0 vulnerabilities |
| `npm audit --omit=dev` | 0 vulnerabilities |
| Fresh D1 database boot | `GET /api/health` 200 twice, no worker errors |
| Fresh schema | 24 tables, 38 indexes, `credential_hash` present, seed data intact |
| Image pipeline self-test | 7/7 |

Test harnesses: auth worker on `127.0.0.1:8790`, batch worker on `127.0.0.1:8789`, both run with
`--persist-to` scratch directories. `npm test` must be run with both harnesses up; an `npm install`
while they run kills them (SQLITE_BUSY), so restart them afterwards.

---

## 5. Verification **not** performed

Stated plainly so nobody mistakes local green for production ready:

- **No CI run on GitHub.** The workflow file exists but has never executed on a runner.
- **No deployment of any kind.** CPU cost of Argon2id on Workers Free is therefore unmeasured.
- **The Security tab was not visually inspected.** It is exercised by API tests only.
- **R2 uploads were not exercised end to end** because the bucket is not bound.
- **No production D1 backup** was taken in this session (blocked by account ownership).
- **Razorpay live mode** was not enabled or tested.
- **No real café shift** was observed.

---

## 6. Recommended order for the remaining work

1. Run the CI workflow once on GitHub (B-1). This is the cheapest way to catch
   environment-specific breakage before anything is deployed.
2. Deploy to a non-public Worker and measure Argon2id CPU (B-2). If it exceeds the Free-plan budget,
   the decision is a paid plan or a cost reduction — not a weakened hash.
3. Create and bind the R2 bucket (B-3), then exercise one real photo upload.
4. Take the production D1 export and store it outside the account (B-4).
5. Configure the WorkOS production directory (B-7) and run one managed-owner login.
6. Onboard a pilot café with `FIRST_CAFE_ONBOARDING_CHECKLIST.md` (B-6).
7. Razorpay (B-5) last, only after the café accepts money in a real shift.

---

## 7. Status rationale

"Code complete" because every mission item that can be implemented in this workspace is implemented
and covered by a passing test. "External setup remains" because the checks that would prove the code
in its real environment — CI, deployment, bindings, backups, a live payment account — all require
access this environment does not have. No item was marked verified on the strength of a weaker check.

---

## Addendum — 2026-11-22 (release-candidate finalization)

This report is superseded in detail by `CORNER_CUP_FINAL_RELEASE_CANDIDATE_REPORT.md`; the status is
unchanged.

Re-verification in this pass found **no source-level defect**. Every F-21…F-32 control was located in
the source and matched to a passing test; F-36 (Security tab) was closed by inspecting the UI; F-37
(Argon2id) now has local workerd timings of 129/161/158 ms for a correct login and 152 ms for a wrong
one. The full gate was re-run: 492/492 tests, build 293.59 kB JS / 94.32 kB gzip, audit 0, syntax
clean, image self-test 7/7. A dump/restore/boot drill on a disposable D1 preserved the order and the
encrypted MFA seed with `integrity_check = ok`.

Two documentation figures were corrected: the schema is **23 application tables** (not 24 — the
extra table was miniflare's internal `_cf_KV`) and "38 indexes" means 24 named plus 14 autoindexes.

The blockers are unchanged: CI has never run, nothing is deployed, R2 is unbound, there is no
production backup, Razorpay and WorkOS are unverified, and no human has clicked through the board.

---

## Addendum — 2026-11-22 (one-pass final completion)

GitHub work was paused by instruction; everything else that could be done locally was done in one
continuous pass.

**One real defect found and fixed.** `wrangler.jsonc` declared no R2 binding, so on any deployment
built from this repository's own configuration `env.IMAGES` would be undefined and every menu-photo
upload would answer 503 (F-38). The binding `IMAGES` → `corner-cup-images` is now declared and the
whole path was verified over HTTP against real workerd R2 simulation: 18/18 checks (upload, serve
with `image/png` + `nosniff`, byte round-trip, cross-café refusal, CSRF refusal, non-image refusal,
size refusal, removal, default restored). Creating the bucket stays a deployment step.

**Gate re-run:** 492/492 tests (0 fail/skip), build 293.59 kB JS / 94.32 kB gzip, npm audit 0 on both
trees, `node --check` clean, image self-test 7/7.

**New measured facts:** local R2 works through the declared binding; mobile layout is clean at
360/390/430/1280 with no horizontal scroll and no control under 24 px; the Freebuff Sites free tier
allows 1 GB of R2, 100 MB of D1, 50M D1 reads, 100k D1 writes and 5,000,000 ms of CPU per month.

**Unchanged:** no deployment, so Workers-Free per-invocation CPU is still unmeasured (B-2); no
production backup (B-4); Razorpay test-only and disabled (B-5); WorkOS dormant (B-7); no human
click-through (B-8); both Sites projects still `published: false`.

See `CORNER_CUP_ONE_PASS_FINAL_REPORT.md` for the consolidated report.

---

## Addendum — 2026-11-22 (final launch-readiness mission)

A temporary probe Worker was run against the real Workers runtime and then deleted (post-delete URL
returns 404). It recorded 65/67/68 ms for a correct login, 53/62/67 ms for a wrong password and 0 ms
for a no-hash baseline. **These are elapsed wall-clock timings, not platform-reported CPU time**, so
they do not establish CPU consumption and do not prove the Workers Free 10 ms per-request ceiling is
exceeded. (This addendum originally read the figures as workers CPU and drew that conclusion; the
characterisation was unsupported and is corrected here — see the 2026-11-23 evidence correction.)
Workers Free compatibility remains unresolved until real CPU time is measured in the deployed runtime.
Argon2id parameters were not weakened and must not be.

R2 is disabled on the Cloudflare account (error 10042); the bucket `corner-cup-images` cannot be
created until the owner enables R2. Production D1 existence and status are unresolved — see the
evidence correction below.

The DB drill passed 13/13 checks (23 tables, dump/restore, image key and version preserved, order
preserved, `integrity_check = ok`, `foreign_key_check` 0). The full validation gate passed:
492/492 tests, build 293.59 kB JS (94.32 kB gzip), audit 0, syntax clean, image self-test 7/7.

Probe directory removed; harnesses stopped. Git status remains dirty with no commits.

Full evidence: `CORNER_CUP_FINAL_LAUNCH_READINESS_REPORT.md`.

---

## Final all-in-one launch-readiness pass — 2026-11-23

Current reality was verified rather than inherited from earlier reports. The complete gate was run
twice: 492/492 tests, build exit 0 (293.70 kB JS / 94.32 kB gzip), `npm audit` 0 on both trees,
`node --check` clean, image self-test 7/7, disposable DB drill 13/13. The guest flow was exercised in
a browser at 360/390/430/1280 (no overflow, no control under 24 px) through checkout (pickup #1,
₹400, note preserved, token only in the fragment), an invalid tracking link produced a friendly error,
and owner sign-in rejected a wrong password with no cookie.

One defect was found and fixed: auth and payment error messages were not announced to assistive
technology (WCAG 4.1.3). `role="alert"` was added to nine error paragraphs and verified live; the
suite still passes 492/492 afterwards.

Position on R2 is unchanged: disabled on the account (`code 10042`). The Argon2id position is
**unresolved**: the ~65–68 ms figures on record are elapsed wall-clock timings, not Workers CPU, so
they neither prove nor exclude the 10 ms Free ceiling — actual platform CPU time must still be
measured. The encrypted-backup procedure was proved end to end on a disposable local database (export
49,592 bytes, SHA-256, AES-256-CBC/PBKDF2-200k, byte-identical decrypt, 24 tables,
`integrity_check = ok`, 0 FK violations). Production D1 existence and status remain unresolved; no
production export or backup has been obtained.

### Evidence correction — 2026-11-23 (documentation only)

Two conclusions in the addenda above outran the evidence and are corrected here. Older text is left in
place above with a pointer rather than silently rewritten.

1. **Argon2id CPU.** Argon2id remains configured at `m=19456 KiB, t=2, p=1`. Previous login
   measurements of approximately 65–68 ms are elapsed wall-clock timings and do not independently
   establish Cloudflare CPU consumption. Workers Free compatibility remains unresolved until actual
   platform-reported CPU time is measured in the deployed Worker runtime. Do not weaken the hashing
   parameters to obtain a passing result.
2. **Production D1.** Existence and current status remain unresolved. Stage 16A previously identified
   `site-6e1c6f7a9a9f4e098f778f9754221b0a` (ID `17d9568d-52fd-48c2-8761-b74d97688589`) under a
   different Freebuff account. The latest authenticated-account `wrangler d1 list` did not find a
   production database, but that does not establish the previously identified database was deleted or
   does not exist. No production export or backup has been obtained. Account ownership and access must
   be confirmed with Freebuff support or the account owner.

No source code, deployment, resource or secret was changed by this correction.

**Verdict:** `CODE COMPLETE — EXTERNAL SETUP REMAINS`. No deploy, publish, payment, GitHub operation
or paid service occurred.
