# Stage 3I-D — Publication-Clean Snapshot Preparation

**Source snapshot:** `C:\Users\rahil\AppData\Local\Temp\corner-cup-snapshot` (173 files, 2.64 MiB)
**Stage 3I-C review:** `STAGE3I_C_SNAPSHOT_RELEASE_REVIEW.md`
**New destination:** `C:\Users\rahil\AppData\Local\Temp\corner-cup-publication` (167 files, 2.55 MiB)
**Mode:** preparation only. No repository, remote, commit, push, deploy, or publication was created.

---

## 1. Executive verdict

# CONDITIONAL PASS

The new snapshot is **buildable, tested and clean of credential values**: it installs from the unchanged
lockfile, passes 475/475 tests, builds byte-identically to the source, and validates with Wrangler dry-run.
All 19 sensitive reports were redacted by value replacement (identifiers → `[IDENTIFIER]`, live URLs →
`[DEPLOYMENT_URL]`, personal addresses → `dev@example.invalid` / `service-account@example.invalid`), the 6
excluded files are gone, and the `.gitignore` gap for harness state directories is closed.

It is **not yet an unconditional PASS** because the redaction was mechanical (value replacement only): the
narratives of the 19 reports still describe production state, containment decisions and recovery procedures
in prose, and 4 reports still contain generic platform references (`freebuff.` account/issuer URLs and
`workers.dev`) plus my own placeholders that a sensitivity scanner flags. None of those is a secret or a
site-specific identifier, but they must be read as **platform references, not deployment URLs**, and the
human reviewer should decide whether the production-exposure narrative itself should ship. That decision is
out of scope for this stage.

---

## 2. Snapshot integrity and manifest

### 2.1 Build method

Deterministic, explicit file selection: a single Python pass over the source snapshot copied every file except
`node_modules/`, `dist/`, `.wrangler/`, `.git/` and any `tests/harness/.state-*` path, and explicitly skipped
the 6 excluded files. No source file was edited in the source snapshot or the worktree. All work happened in
the destination directory.

### 2.2 Counts

| | Source (3I-B) | New (3I-D) |
| --- | --- | --- |
| Source files (excluding generated/local state) | 173 | 167 |
| Total size | 2.64 MiB (2,772,059 B) | 2.55 MiB (2,677,284 B) |
| `worker/` | 16 | 16 |
| `src/` | 20 | 20 |
| `public/` | 9 | 9 |
| `tests/` | 59 | 59 |
| `scripts/` | 5 | 5 |
| Root reports | 55 | 36 (19 redacted, 5 excluded, 1 `site.json` excluded; `README.md` retained) |
| Other root files | 9 | 8 (`site.json` excluded) |

### 2.3 File-level diff against the source snapshot

| Category | Count | Files |
| --- | --- | --- |
| Unchanged (byte-identical) | 140 | everything except the lists below |
| Redacted | 19 | the reports in §3 |
| Test-fixture hygiene | 7 | 6 test files + `tests/harness/wrangler.auth.jsonc` (§6) |
| `.gitignore` | 1 | added 2 rules (§5) |
| Excluded | 6 | §4 |
| Newly added | 0 | — |

SHA-256 of every one of the 167 files is in **Appendix B**.

### 2.4 Generated state

`npm ci`, `npm test`, `npm run build` and the Wrangler dry-run were run inside the destination, so
`node_modules/` (≈244 MB), `dist/` (≈916 KB) and `.wrangler/` (empty) now exist there. They are all
git-ignored and are **not** part of the 167-file publication set. This matches the 3I-B/3I-C convention.
After validation, all generated directories (`node_modules/`, `dist/`, `.wrangler/`, `tests/harness/.wrangler/`,
`tests/harness/.state-*/`) were removed, so the destination now contains only the 167 publication files.

---

## 3. Report redaction table (all 19)

Redaction was value replacement only — no technical section was removed and no heading was changed. Counts are
replacements per file; no value is reproduced.

| # | Report | UUIDs | Hex-32 | Live URLs | Emails | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `MASTER_REMEDIATION_REPORT.md` | 1 | 0 | 0 | 0 | §1 initial condition |
| 2 | `PRODUCTION_DEPLOYMENT_CHECKLIST.md` | 1 | 0 | 0 | 0 | §0 hard blockers |
| 3 | `STAGE10A_AUTH_AUDIT.md` | 1 | 0 | 0 | 0 | title/intro |
| 4 | `STAGE10A1_AUTH_REMEDIATION_PLAN.md` | 1 | 0 | 0 | 0 | title/intro |
| 5 | `STAGE10B_WORKOS_SANDBOX_REPORT.md` | 1 | 0 | 0 | 0 | title/intro |
| 6 | `STAGE11_BACKUP_RESTORE_REPORT.md` | 2 | 0 | 0 | 0 | §2 source/target identities |
| 7 | `STAGE12_CONFIGURATION_RECOVERY.md` | 6 | 0 | 0 | 0 | §3, §4 |
| 8 | `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` | 4 | 0 | 0 | 0 | §4, §8.1 |
| 9 | `STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md` | 3 | 3 | 1 | 0 | §2, §3, bound resources |
| 10 | `STAGE13_1_REMEDIATION_PLAN.md` | 1 | 1 | 0 | 0 | §6 |
| 11 | `STAGE13_PRODUCTION_READINESS_AUDIT.md` | 5 | 0 | 2 | 0 | §1, §3.1, §3.2 |
| 12 | `STAGE15_PRODUCTION_CONTAINMENT_DECISION.md` | 10 | 4 | 3 | 0 | §1.1–§1.6 |
| 13 | `STAGE16A_PRODUCTION_BACKUP_REPORT.md` | 11 | 6 | 0 | 6 | §2, §3, §6 (3 Gmail + 3 service-account) |
| 14 | `STAGE3_DEPLOYMENT_PREFLIGHT.md` | 4 | 0 | 0 | 0 | §1, §2, §9 |
| 15 | `STAGE4_STAGING_CONFIGURATION.md` | 5 | 0 | 0 | 0 | §2, §3, §7 |
| 16 | `STAGE5_FINAL_STAGING_SAFETY_REVIEW.md` | 3 | 0 | 0 | 0 | title, §4 |
| 17 | `STAGE6_STAGING_DEPLOYMENT.md` | 4 | 0 | 0 | 0 | target/deployment record |
| 18 | `STAGE7_AUTH_FUNCTIONAL_READINESS.md` | 2 | 0 | 0 | 0 | §1 |
| 19 | `STAGE3I_A_REPOSITORY_HYGIENE_REPORT.md` | 0 | 0 | 0 | 4 | §1.1, §3.1 (2 Gmail + 2 service-account) |

**Totals:** 65 UUIDs, 14 hex-32, 6 live URLs, 10 email addresses replaced.

Replacements used: UUIDs → `[IDENTIFIER]`; bare 32-hex → `[IDENTIFIER]`; `*.freebuff.page`/`*.freebuff.com`
deployment URLs → `[DEPLOYMENT_URL]`; `@gmail.com` addresses → `dev@example.invalid`; service-account
addresses (`*.iam.gserviceaccount.com`) → `service-account@example.invalid`; any other email →
`dev@example.invalid`.

**Residuals after redaction (verified benign):** `MASTER_REMEDIATION_REPORT.md`, `SECURITY_STATUS.md`,
`STAGE3C_MENU_PHOTOGRAPHY_REVIEW.md`, `STAGE3H_IMAGE_PROCESSING_ARCHITECTURE_REPORT.md`,
`STAGE13_1_SOURCE_PRESERVATION_REPORT.md`, `STAGE3_DEPLOYMENT_PREFLIGHT.md`, `STAGE4`,
`STAGE5`, `STAGE11`, `STAGE12_CONFIGURATION_RECOVERY`, `STAGE13_1_PRODUCTION_EXPOSURE`,
`STAGE13_1_REMEDIATION_PLAN`, `STAGE15`, `STAGE16A`, `STAGE3I_A` still contain 32+ hex strings — these are
commit SHAs and build hashes quoted in technical narrative, not identifiers (spot-checked). `STAGE13`,
`STAGE15`, `STAGE3H`, `STAGE3I_A` still contain `freebuff.` — platform references (the public Freebuff
account URL and the `workers.dev`/`freebuff.page` platform domain in security-boundary prose), not
deployment URLs. `STAGE16A` and `STAGE3I_A` still contain `@…` matches — these are my own
`dev@example.invalid` placeholders, not real addresses. `src/pages/Admin.jsx`,
`tests/fixtures/workos.mjs`, and several test files contain `@` and `password:`/`secret:` literals — these are
test fixtures and UI strings, covered in §7.

No report was marked for exclusion in this stage: every one of the 19 could be redacted without losing its
technical meaning.

---

## 4. Excluded-file inventory

| File | Reason (from 3I-C) |
| --- | --- |
| `FIREBASE_INTEGRATION_PLAN.md` | Abandoned Firebase path; third-party service-account identity in §7; 68 credential-vocabulary lines; duplicates the decision already in `AUTHENTICATION_DECISION.md` |
| `FIREBASE_MFA_EVIDENCE.md` | Same abandoned path; service-account identity in §2.2 |
| `FIREBASE_MFA_READINESS.md` | Same; service-account identity in §2.1 |
| `ZERO_BUDGET_AUTH_FEASIBILITY.md` | Firebase feasibility study; service-account identity in §5; decision already captured |
| `F07_VALIDATION_REPORT.md` | Declared historical by `SECURITY_STATUS.md`; describes the abandoned PBKDF2 600 k design |
| `site.json` | Deployment metadata (Sites project id, production/preview URLs, previous site ids); not referenced by any code or build (verified); not needed to build, test or deploy via `sites.manifest.json` |

No other file was excluded. All 36 remaining reports (30 KEEP + 6 of the 19 redacted? no — all 19 redacted remain)
are present: 30 KEEP + 19 REDACTED = 49? Wait — the source had 55 reports. 5 excluded + 1 site.json (not a report) = 50 reports remain. 30 KEEP + 19 REDACTED = 49. Plus `README.md` (counted in KEEP) = 50. Correct: 55 − 5 = 50 reports, and 30 + 19 = 49 because `README.md` is the 50th (included in the 30). Reconciles.

---

## 5. `.gitignore` changes

Two narrow rules added to the existing file; no existing rule removed or broadened.

```diff
+# harness state and local tool state (Stage 3I-C)
+tests/harness/.state-*/
+tests/harness/.wrangler/
```

Verified with `git check-ignore`: the directory `tests/harness/.state-a2` and every file beneath it now match,
as does `tests/harness/.wrangler/`. All previously ignored paths (node_modules, dist, .wrangler, .dev.vars,
.env, *.sqlite*, *.log, archives, audit-package) remain ignored. No source, test fixture or documentation path
is hidden by the new rules.

---

## 6. Test-fixture changes

The repeated `OPERATOR_PASSWORD` literal in 6 test files plus `tests/harness/wrangler.auth.jsonc` was replaced
with a clearly synthetic, unmistakably test-only value:

`corner-cup-harness-operator-password-fixture-not-a-real-secret`

Files changed (7): `tests/body.limit.test.mjs`, `tests/operator.owner-routes.test.mjs`,
`tests/operator.revocation.test.mjs`, `tests/password.reset.test.mjs`, `tests/rate.limit.test.mjs`,
`tests/session.revocation.test.mjs`, `tests/harness/wrangler.auth.jsonc`.

All six test files shared one literal value (verified before replacement); the harness var was updated to the
same new value, so the fixture still authenticates against the harness. No production runtime configuration,
Worker code, authentication logic or test assertion was touched. All 475 tests still pass (§8).

---

## 7. Secret and infrastructure sensitivity scan

Scanned every one of the 167 source files (binary files excluded from text scanning).

| Category | Result |
| --- | --- |
| Credential-shaped literals (`password`/`secret`/`token`/`apikey` with a quoted value ≥6 chars) | 30 files, all in `tests/` and `tests/harness/` — every one is a local-harness input (`tests/harness/credentials.mjs` documents them as non-real). Zero in `worker/` or `src/` |
| Long base64 blobs | 0 |
| 32+ hex strings | present only in reports (commit/build hashes) and tests; none is a credential or live id |
| Bearer tokens / private keys / certificates | 0 |
| Real-format payment keys (`rzp_live_`, `rzp_test_` with a real tail) | 0 |
| Cloud provider tokens (GitHub/AWS/Cloudflare) | 0 |
| Populated environment files | 0 (only `.dev.vars.example`, all 9 secret keys empty) |
| Personal email addresses | 0 real ones. `dev@example.invalid` / `service-account@example.invalid` (my placeholders) and test-fixture addresses (`test@…`) only |
| Live deployment / preview URLs | 0 real ones. `[DEPLOYMENT_URL]` placeholders plus generic platform references (`freebuff.com` account URL, `workers.dev`, `freebuff.page` domain in boundary prose) |
| Infrastructure identifiers (site/env/db ids) | 0 in code or tests. Reports use `[IDENTIFIER]` |
| Database exports / archives / logs / local DBs / generated state | 0 (no SQLite, SQL, zip, log, or audit-package file) |
| Generated directories | `node_modules/`, `dist/`, `.wrangler/` exist from validation and are git-ignored; not part of the 167-file set |

**No genuine secret or live infrastructure identifier is in the snapshot.** The remaining scan hits are test
fixtures, platform references, build hashes and my own placeholders, each of which is benign and documented.

---

## 8. Validation results

All commands run from `C:\Users\rahil\AppData\Local\Temp\corner-cup-publication` only.

| Command | Result |
| --- | --- |
| `npm ci --no-audit --no-fund` | **exit 0** — 244 MB from the **unchanged** lockfile; no dependency or lockfile change. Informational `install-scripts` notice for `esbuild`/`workerd` only |
| `npm test` | **exit 0 — 475 tests, 475 pass, 0 fail, 0 skipped, 0 cancelled**, 101.1 s |
| `npm run build` | **exit 0** — 105 modules, 1.26 s; `index-B_nBG-g5.css` 33.10 kB, `index-CIYopyjw.js` 287.11 kB (gzip 92.71 kB) — **byte-identical asset names to the source and 3I-B/3I-C builds** |
| `npx wrangler deploy --dry-run` | **exit 0** (wrangler 4.158.0) — 15 files from `dist/`, 237.21 KiB (gzip 54.76 KiB), bindings `env.DB` (D1 `corner-cup`), `env.ASSETS`, and the 3 vars. No account, credentials or network side effect |

Required configuration examples present: `.dev.vars.example` (9 empty secret placeholders + 3 non-secret
defaults), `wrangler.jsonc`, `vite.config.js`, `sites.manifest.json`, `package.json`/`package-lock.json`.

No generated or local-state file is in the 167-file publication set; the validation-created `node_modules/`,
`dist/` and `.wrangler/` are ignored by `.gitignore`.

Two harness processes (`wrangler dev` on 127.0.0.1:8789 and :8790) were started to enable the HTTP-level
suites and were stopped afterwards (workerd and node processes terminated; ports released).

---

## 9. Remaining publication blockers

| # | Item | Severity | Resolution |
| --- | --- | --- | --- |
| D1 | Production-exposure narrative still in prose in `STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md` and `STAGE15_PRODUCTION_CONTAINMENT_DECISION.md` (what production was running, containment timeline) | Low (reviewer judgement) | Human reviewer decides whether to publish the narrative; values are already gone |
| D2 | Generic platform references remain (`freebuff.com` account URL, `workers.dev`, `freebuff.page` domain in boundary prose) | Low | Benign; could be replaced with `[PLATFORM]` if desired |
| D3 | `dev@example.invalid` / `service-account@example.invalid` placeholders are themselves email-shaped and trip naive scanners | Low | Acceptable; or replace with non-email tokens |
| D4 | No `.github/workflows` (carried from 3I-C C6) | Low (process) | Add CI, then require it |
| D5 | `IMAGES` R2 binding unprovisioned; `database_id` is a placeholder (carried from 3I-C C7) | Low | Provision when photos go live |
| D6 | `.gitignore` still lacks the broader 3I-A §7.3 entries (`corner-cup-transfer/`, `.script/`, `screenshots/`, `ui-audit/`, `.tgz*`, etc.) — none of those paths exist in this snapshot, so nothing is at risk today | Low | Add before the first commit from a normal worktree |

Nothing blocks the technical content. The code, tests, lockfile, assets and configuration are complete,
reproducible and clean.

---

## 10. Explicit confirmation of all restrictions

- **No GitHub repository created**, no remote configured, no stage/commit/push/publish.
- **No deployment, provisioning, secret change, or production/staging access.** Wrangler ran with
  `--dry-run` only; no account credentials were used.
- **No source, snapshot or secret modified in the original worktree.** The only file added to the worktree is
  this report. `git diff --cached` = 0 entries; `git diff --shortstat` unchanged at 27 files / +5,871 / −1,048.
- **The 3I-B snapshot was not modified or overwritten**; the new snapshot was built from it by copy.
- **Nothing deleted from either source.** Excluded files were simply not copied.
- **No application behavior or architecture changed** (value-only test fixture rename; value-only report
  redaction; two ignore rules).
- **No dependency version changed and no lockfile regenerated** — `npm ci` used the unchanged lockfile.
- **No security control weakened** and no test assertion changed; all 475 tests still pass.
- **All work happened in the destination directory** (plus this report in the worktree).
- **No credential value appears in this report or the new snapshot.** Findings name files, sections, key names
  and counts only.
- **No claim that a private repository makes residual sensitive information harmless** — the publication
  decision remains with the human reviewer.
- Stopped after producing this report. No repository creation, remote configuration, staging, commit, push,
  deploy or publication was performed.

## Appendix B — SHA-256 manifest of the 167 publication files

Generated from `C:\Users\rahil\AppData\Local\Temp\corner-cup-publication` (excluding generated
directories and local state). Verify any file with `sha256sum`.

| # | File | SHA-256 |
| --- | --- | --- |
| 1 | `.dev.vars.example` | `771c3b4c0af7afcb134d72de6c47fd2ca61caee7fc9a189eb67623470bcc3e17` |
| 2 | `.gitignore` | `576fa22135c43a804d996769bc132a683dab1ee9093c0b4150367f746029110d` |
| 3 | `AUTHENTICATION_DECISION.md` | `8e8e0e78145436ff1155e1a495dd945359f466ef84bf39ffe4147d2e8d3f0e1b` |
| 4 | `COMPLETE_SECURITY_AUDIT.md` | `c00cb6d65cfd7815494d97965fd743dd1a40f4dfbccdecc7765f787b3715e0e5` |
| 5 | `DISASTER_RECOVERY_RUNBOOK.md` | `3ae7a420c0e4e06cadda2698ccf63cef67d11b6e105a915ba74bf28562b72dd1` |
| 6 | `FIRST_CAFE_ONBOARDING_CHECKLIST.md` | `552fd2b4a71681e46b84386d30fa499cb3ca63a477a03d91f7f0cafbea9fd16f` |
| 7 | `MASTER_REMEDIATION_REPORT.md` | `e25b06cab0558614df8f05d98ebe6edab474bd3dfd0d3be3809a8021680b825a` |
| 8 | `OPERATIONAL_READINESS.md` | `ab5e8056652542de67bfb71d12fb804fb9fe7344e14555c6fee9d2bf2eee98e8` |
| 9 | `PRODUCTION_DEPLOYMENT_CHECKLIST.md` | `de575fd92a40c13c329fe2bd2e0bb3696a8fddb272b07e1a7986ed5202cf0809` |
| 10 | `PRODUCT_READINESS_REPORT.md` | `b524c9a6f210a032589582f8f28df4991b063f39b1c768c5270cc6d527c828c4` |
| 11 | `RATE_LIMIT_CAPACITY_REPORT.md` | `bb13a17abe565b1b15f0beb8f351552393cf4b94ecd2ad53039b7649131dfcfb` |
| 12 | `README.md` | `ad92d9aeb9878b0e91e11a37e36e952edd1533d7d95b611de024de5beddddf06` |
| 13 | `SECURITY_DEPLOYMENT_CHECKLIST.md` | `1591a9ce16eb32c94601b130ed181d2ad13f63c607e5534d320babcf602ff1ad` |
| 14 | `SECURITY_FINDINGS_MATRIX.md` | `a55174a027c18f9646ce03ac4c30c879cd29311f0398279faff976285c7cb926` |
| 15 | `SECURITY_REMEDIATION_LOG.md` | `ba08e00510cced8c282c182d96db2021a6aff100f0472098464ecde9a2480383` |
| 16 | `SECURITY_REMEDIATION_MATRIX.md` | `e5c91b216822643f795fcc5b704f48d4654c4e06c61cf90233ad9da60c2ae81a` |
| 17 | `SECURITY_STATUS.md` | `dc05a43953aee1b0303f8ff50e5c049d6bbdbca0a2df769461a181e9ed43d96a` |
| 18 | `SECURITY_TEST_REPORT.md` | `966dbc87add8e4f84cb06bb770e63bd285f25a97ba9bda6cb7a8216b5bededac` |
| 19 | `STAGE10A1_AUTH_REMEDIATION_PLAN.md` | `0622aa9ec0706eed9dc6b7202f035e4c78fd3183f3533bf9770342f3d1178c9c` |
| 20 | `STAGE10A_AUTH_AUDIT.md` | `2dd0f23a88b2e99fd11ddce6e252502ce1a1ff764d1c458d84bb473953437eb3` |
| 21 | `STAGE10B_WORKOS_SANDBOX_REPORT.md` | `29dec14d28e4bd3ed877b065eec563ebb45f1bdcc67c5c0a78a9b2621fabbf03` |
| 22 | `STAGE11_BACKUP_RESTORE_REPORT.md` | `a31816863aa383f0cb230deb77878a1b00e080228eae2b586ef83c2ab808ab67` |
| 23 | `STAGE12_BACKUP_POLICY.md` | `2e7d9b648b8eba5fede2d63c7f00bc46fdbc104ea93ac3a350f36d28e45fe25a` |
| 24 | `STAGE12_CONFIGURATION_RECOVERY.md` | `67924d62c8118057c0ce90910efbef8e3a78966bfe18ffda9f31a2a9b50dff7a` |
| 25 | `STAGE12_DATABASE_RECONNECTION.md` | `f454131d93293b2dd6a6b7c45b8e95bd8e2339e075e745a8f002edaa62968af9` |
| 26 | `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` | `ace1a87337f03f20a82c17d298ce4dd94888813fb680c5ce9dd2c209d68768ca` |
| 27 | `STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md` | `7d99a46f70703374002ca1b9577c1bb222d580d9a72c0f4296cfb02c51e00ff1` |
| 28 | `STAGE13_1_REMEDIATION_PLAN.md` | `f25653b38c970861cc90f1a3e269847830a5ecd30e16ebdec44b3d645bcdce11` |
| 29 | `STAGE13_1_SOURCE_PRESERVATION_REPORT.md` | `56fc120268c49d628c21fd5c34eb9bf898f7005010122ef2540cea7106b46a4a` |
| 30 | `STAGE13_PRODUCTION_READINESS_AUDIT.md` | `fff647524846a6781ec9d2444b7daeff0c5d5fbc03af4d7a731f4dcaa09c700a` |
| 31 | `STAGE15_PRODUCTION_CONTAINMENT_DECISION.md` | `a61b9429ba094ffb5ec2d40e737a0a752ecb2b4cc400259c29b61e5ed83f0933` |
| 32 | `STAGE16A_PRODUCTION_BACKUP_REPORT.md` | `6594c62de890f92d2a1e759df01ff51c90f524510af8cb312ca69f7ea535e686` |
| 33 | `STAGE3A_MENU_PHOTOGRAPHY_AUDIT.md` | `f096f3e8f834af73be0e7b0529b8690f818bfaa300339b5a83d3c491e1424637` |
| 34 | `STAGE3B_MENU_PHOTOGRAPHY_REPORT.md` | `e07ba51bcdf8197bc824949f8de0aa9ec93d390d39fce45cf17e357a85276521` |
| 35 | `STAGE3C_MENU_PHOTOGRAPHY_REVIEW.md` | `611e6eb6ddc0caf202f629239d05672234b36ff8dca2bace1295cac468c757b9` |
| 36 | `STAGE3D_MENU_MOBILE_ACCESSIBILITY_REPORT.md` | `9d087b586929eb86727772c01964b8430337cafc1d29797c7736fe139bb5faed` |
| 37 | `STAGE3E_DEFAULT_IMAGE_DIVERSITY_AUDIT.md` | `e29930503ffa7d6ebe5efecacf9a5d3abaccdebeaa62d7be881faf0627c7425a` |
| 38 | `STAGE3F_DEFAULT_IMAGE_MAPPING_REPORT.md` | `48d94a4811176e87c868c6cfc53c916738ca512683294182fd66ea3349641458` |
| 39 | `STAGE3G_IMAGE_DECODING_FEASIBILITY_REPORT.md` | `bd8e6c937c6ae2fdfd8d3463f292cdfe28aec9eb3efec9caace435630c14e02f` |
| 40 | `STAGE3H_IMAGE_PROCESSING_ARCHITECTURE_REPORT.md` | `4dccf2e9014326fd3d3b6920c3ea988c02a20616354ecf002a2649b62ce3b2ba` |
| 41 | `STAGE3I_A_REPOSITORY_HYGIENE_REPORT.md` | `ec87e4768c8c0fb04a9118bd536669e86f4f26b50a4e0c90c0a7a6aa149b697b` |
| 42 | `STAGE3_DEPLOYMENT_PREFLIGHT.md` | `d8e69c91ad7fe1593d6a99b065133dff72d0fed7ad17d58d2ebbaf47872ac6c4` |
| 43 | `STAGE4_STAGING_CONFIGURATION.md` | `f27a1e2e3c3c65850b729ad85576baed90190eba6bc2fe5ad7e1d8a76b04fa82` |
| 44 | `STAGE5_FINAL_STAGING_SAFETY_REVIEW.md` | `6bfd1d43a0dd18be75dd3d00186cdcb2e9351491d78afab20a1e84322ae85487` |
| 45 | `STAGE6_STAGING_DEPLOYMENT.md` | `ec9512077899955e8dedebe0390943efe73705faf4da49e1486e9d69d854bd12` |
| 46 | `STAGE7_AUTH_FUNCTIONAL_READINESS.md` | `d49950b2316509d42924ddcdd976f84c092621088d252504654a99d961747fe2` |
| 47 | `STAGE8A_OPERATOR_AUTH_PREP.md` | `3cb1f7beb731c8a1a6845f96057aa275ea3aefa7e26c34a2187b91e6115e8ac9` |
| 48 | `STAGING_READINESS_CHECKLIST.md` | `0319dbe962c1c97b9a46d9ec63ee9b2a3be08c438699d2bb356650e09075a9c8` |
| 49 | `UI_IMPROVEMENT_AUDIT.md` | `3e88f76556eb9d290a9a3f16808e7cffea215bb3cff0d1b163d4ea46ff9eb483` |
| 50 | `UI_IMPROVEMENT_STAGE2_1_REVIEW.md` | `64dd82d216c32782129cf625cef5435076ddb52f788d9915767d3ab9c72129d0` |
| 51 | `UI_IMPROVEMENT_STAGE2_2_REPORT.md` | `5a6f1c141d3f57779b617c588cbb7e44cf1a3d6e7d4ae6dbc176a5966a2ae655` |
| 52 | `UI_IMPROVEMENT_STAGE2_REPORT.md` | `8e1066c95907a31bfc742a16caf70fcd467e83ff2662b108e087f7e95905309d` |
| 53 | `index.html` | `ba3be4758f3785efed37051adda483168cb9d39003b04ae5f12d7efe4e9e1e7e` |
| 54 | `package-lock.json` | `392fd1f7fc1f4438874cc91c2564364ee92a2f92bbac91977a358dc5f2e31c56` |
| 55 | `package.json` | `1ba45ab8f83dc2f80df8e1e33b29c9c8caa04488b3ad393876c983859a3862bd` |
| 56 | `public/defaults/coffee.jpg` | `d04b049e9b172d8ba640e04d27ee1479ad4bf7cad25852e190e7aa51d876e5da` |
| 57 | `public/defaults/cold-drink.jpg` | `9330b8308edfc7e9d8954b213ead12c0aa95d80632c6a8e4349c3afeaae66dda` |
| 58 | `public/defaults/dessert.jpg` | `8bbadae7778b9fdbfe6d465be4e9b5507ebf31f9450e9d9b1d0275282e794a7c` |
| 59 | `public/defaults/dish.jpg` | `4a26e1a742e7d6e67842a6d5969306fb07843c8348a72164c53ae90d39996335` |
| 60 | `public/defaults/main.jpg` | `9144635e72a9deb2561d35c556abcc50b8f984e3dcd6bac7facb21671108f09e` |
| 61 | `public/defaults/snack.jpg` | `4a7dc798f1ea6f656e4920cc81e3cb7033e6bdafbdb7834e442bbf1b655f49e8` |
| 62 | `public/fonts/OFL.txt` | `74a4fbd71ac354b6f99743c1dfd7e0df813cb01e538ffce7e1fa5e13c0111e70` |
| 63 | `public/fonts/fraunces-latin.woff2` | `7234ed860a9cc83045413c4faee63c960a8f2d1917adcf728119307d56e0d783` |
| 64 | `public/fonts/inter-latin.woff2` | `3100e775e8616cd2611beecfa23a4263d7037586789b43f035236a2e6fbd4c62` |
| 65 | `scripts/gen-staging-fresh.mjs` | `125fe458532a6ef571aa557666f3241b30a05bd6d5bad95ad4ce847b31aa6e1c` |
| 66 | `scripts/gen-staging-freshsafe.mjs` | `c744344db1651b9e1306f5c147219556652b8ede564646fce1de65c6e2336791` |
| 67 | `scripts/gen-staging-migrations.mjs` | `d413e48c3ce5f2a54a57182ade5cb4a2933c249bca445d3e0c3058da39556166` |
| 68 | `scripts/run-staging-migrations.mjs` | `7368959555ea36d7dcc425828e13946dcbdffdbb4c72b0105550ca858706051a` |
| 69 | `scripts/staging-migrate.mjs` | `6f56f38ec80ea97c8e9d7d2e051c0a5dd572160917363d48797b6a9e6a970253` |
| 70 | `sites.manifest.json` | `5c7cdf93f4ebd70ecf51f79131c73eeb41208e60575fa8c8376c76355880f7a8` |
| 71 | `src/components/CartSheet.jsx` | `a9499e13253796a628a25006da0fca816ceb52fd964581b8dabf4078d6f2a343` |
| 72 | `src/components/PaymentPanel.jsx` | `d06a8d6987f3234c33e9c7440fe9cb3bab1c313190b7bb4c9839025c8007183a` |
| 73 | `src/components/SiteFooter.jsx` | `be9779256f04d122a0d4d57b91fa06fe17ec83c5fee48ef1ad8e55ca1fb0ed26` |
| 74 | `src/lib/api.js` | `1d8874d00a8e8b7804fe75752ac7cc8bcdb1b93455939ac43b97dbe51040f8f9` |
| 75 | `src/lib/checkout.js` | `d5eda89185e8403f741b4ed144386ac3d56c1cbccfffda3ff7e99e70c483fe4a` |
| 76 | `src/lib/config.js` | `179f893709c0ee971278c11abca937cdb8a3368c98e5c7e05b0bd524487f73d4` |
| 77 | `src/lib/menuImages.js` | `c975cb6814f8b45d10bae7874381a9eb9970a3b01998fde4865ec2fcd12fee68` |
| 78 | `src/lib/menuScope.js` | `e332d8959a3aeb3d198258fdcad9adc306ab994007a5023a79f4836024d172db` |
| 79 | `src/lib/money.js` | `940dac67026b2b7634051131ac32bfe74cba55205bf38dd81766250d8a1f2c31` |
| 80 | `src/lib/payments.js` | `fd4ec1784eb7877e3aab44c2b991eb3951c6aa49dfcc246db9dc27e6e2eaa667` |
| 81 | `src/lib/razorpay.js` | `94e1f999341f5c499f5065e7438120c39f81782fa7c16de448525dadb1e03464` |
| 82 | `src/main.jsx` | `d97f1ccf22abcecbcf37bbd95edfbcf7f40c4ba4a82588798b1c7337a7776feb` |
| 83 | `src/pages/Admin.jsx` | `06e785d9f397199e0c75e370d855eaf67988f59d0e43de2b879bd0fbb0d2e2dc` |
| 84 | `src/pages/DefaultCafe.jsx` | `981bb1f3cdd337416316c41d7afc0430896e3f1db5fc7f22770e95016d78be14` |
| 85 | `src/pages/Landing.jsx` | `2b388056ad32aae2ee0e820dbf3f8e92850bbe218d53b93a2fb81a6af24f36a0` |
| 86 | `src/pages/Legal.jsx` | `bebbaf543626cac4fa9d97fc681da7a74320ead372dea78d122284fa66cc9cd6` |
| 87 | `src/pages/Menu.jsx` | `5bc340454c5e6bfcd4c18179f09aa06b6ffac84238503c233ff496075fd8327e` |
| 88 | `src/pages/Operator.jsx` | `bf47be5c3d4a11f08d1496246cad0d48882120593bbeb4287ed252947e0719af` |
| 89 | `src/pages/OrderStatus.jsx` | `37294e108060adf1647b9c21f8f533f490b86791c0f68d656f3ebc55496d5b28` |
| 90 | `src/styles.css` | `fb9a402f1a059b13042ebb2700ae41238c36dd45a5f7b6252baf1005351cb226` |
| 91 | `tests/admin.menu.controls.test.mjs` | `651327a30bd04507100463d15c41179438096396599a505f30d42b190aafddb8` |
| 92 | `tests/api.resilience.test.mjs` | `a1fb9c743e2d50e4a16f6a5b5f84e07ff0188077de2efcd1c743c07b36c31121` |
| 93 | `tests/argon2.passwords.test.mjs` | `9c441462447a6d492d6c81f661b29f3896923aa6bebd1110e94d8423756d531a` |
| 94 | `tests/auth-mode.atomicity.test.mjs` | `e32c5dbd331dd7d8e8124ee09a1d4b8000f24cb779e8b3fc84f4ee6a8287213d` |
| 95 | `tests/auth-mode.d1.test.mjs` | `177a8f5b929b62116bd374f9394ed3de0d619c90333c61a8efbeb3bfbfe3a14a` |
| 96 | `tests/auth.empty-login.test.mjs` | `4a103a2ef44f90f6942675ccb1e8daab55bc473fb3f9222d7692b75bd500bbca` |
| 97 | `tests/auth.fallback.test.mjs` | `a0915b48a4932505427173a03e2d5a7cdd3472c4dd779f59a05ab0c48c624871` |
| 98 | `tests/auth.race.test.mjs` | `c88d45f992305ff3cb24a3e26d1eb99d69f21079e77e23de380cac14a9e95fd5` |
| 99 | `tests/auth.secrets.test.mjs` | `c2ff06eb0a5ea9e5f061360b9abe63d756383f0d21d180f6353d7d70449b30f5` |
| 100 | `tests/auth.version.test.mjs` | `a5043d4f145cb3dd594021b60cd35ca57f2adde5ed4c7ad571693ce2ade4dac7` |
| 101 | `tests/body.limit.test.mjs` | `6e0bfac47de239b5abdbcab0f2853015a1ac60c5b04bac370618c7544a24e346` |
| 102 | `tests/browser.credentials.test.mjs` | `4f04496a696f4a0fa0185c72e9db9f2b5d33dd768503817ed414e5926174511c` |
| 103 | `tests/cafe-scope.test.mjs` | `49e119aaddeae55a9691c3529ebf61c1c87e846899f6defa673f3ff1054f0bee` |
| 104 | `tests/checkout.logic.test.mjs` | `81b82a4a6a9e31b910ce0a28ec9e97f79289e56ad5bb7f4682baed62fc98d6fb` |
| 105 | `tests/cookie.malformed.test.mjs` | `611c1e288a8542db0b078d72d9b5e5ef44e9fc751c1b8ffc39a439eef1639dc6` |
| 106 | `tests/cookie.name.test.mjs` | `3c1abcca13185210155509564c570c31849efebda19a4f17b3b8ba75ded2f758` |
| 107 | `tests/f07-regression.test.mjs` | `3e005c2720a188ed9cdafbb9582baf5ac9534257422f5b0a8c13e4aba37d8736` |
| 108 | `tests/fixtures/workos.mjs` | `dd2e15173ab7d55fc9202411b0db870a72304fe9135af5757e1c4d210e05fb65` |
| 109 | `tests/gate2-measure.mjs` | `5f989ac8c78b145da95f9df8c607de75fc834cddb359b2d51787b456d081fc60` |
| 110 | `tests/harness/credentials.mjs` | `68f5b80729b31eec39fa8d937e109d9874b163ed0ad04c494fd8e8dd94c2d524` |
| 111 | `tests/harness/worker.mjs` | `7bf69c40d0bfcf30c79432e38983e1cdcf377b93cd25d71df30b85dba4fa9386` |
| 112 | `tests/harness/wrangler.auth.jsonc` | `3123b40203d3e4f1ec5ab2b926df1e656f45b5886a64012e3f27bad47c2c697f` |
| 113 | `tests/harness/wrangler.jsonc` | `7fcd68708b30ae720be5d0538a23f47adffe5ca0c62a896f2490719d41532242` |
| 114 | `tests/health.test.mjs` | `630bd7c836315846cef93a722d918b68e890efc8e1469f3dc19a32c7bdedc9d4` |
| 115 | `tests/lib/db.mjs` | `32833a3fefb629b362bbb3501a2bb43667b374a52ea7f3f06f81894418a91bf8` |
| 116 | `tests/menu.component.test.mjs` | `8c8c9b0b7310fa982d06bfab0384e85b76b9cfc7720cf9e19beb422f43f5894a` |
| 117 | `tests/menu.defaults.test.mjs` | `ea6b025bc21e8d3e0e4706d9c1c7ea5774d8ea6331c69da26c2e051291e14e94` |
| 118 | `tests/menu.images.test.mjs` | `d7db4f2b9db8265cfe25b00772e0bec875298048ab489e2b64f609f85a767967` |
| 119 | `tests/migrations.owner-auth.test.mjs` | `95ac876349aff1f3b0a021439c9b00e190b92ae53806f306b8d85b9508156249` |
| 120 | `tests/migrations.test.mjs` | `6877b6b42ad54e10b3fab7fc0979aaf69b04f499f3537ffcbe78534a39965bdf` |
| 121 | `tests/operator.owner-routes.test.mjs` | `0bf9babb2342b13e00065d9a1685476893562f789a33f0db291874261047c13d` |
| 122 | `tests/operator.revocation.test.mjs` | `5976f3657fa4d9b7ff0f01f50978e4e88132947a8c2018b962862aab6cf37345` |
| 123 | `tests/order.tracking.test.mjs` | `2220e79fffe495c99405406118b24d9f26829f93ba936e8a780070ddbaeaac54` |
| 124 | `tests/orderid.concurrency.test.mjs` | `f7e12716abcf00304e09e0dca3f166e71320480fcb6c4114e163bb9c4ee87f81` |
| 125 | `tests/orderids.test.mjs` | `eafe20d0a1bd25c15008cd70b339c1dd4bab3d4c9151fcf6093c3e0de2047c9f` |
| 126 | `tests/orders.deep.test.mjs` | `599ace97a475688f5e3b3cec8f9d4d40e66fd4e05d5f9e1b34dce0b7ba1fad90` |
| 127 | `tests/orders.harness.test.mjs` | `bf967a0a32497c4e7cd6ff951d73e21086a4763676eafa786d81393b35e93dc2` |
| 128 | `tests/orders.integration.test.mjs` | `ac5a889c3de9175425275ca06b07df1716d065447245fdcb22670c3ad470ad1e` |
| 129 | `tests/orderstatus.component.test.mjs` | `e7864deb345900c09c7f3afe82b329357377cde5be6089bb2611526de8a91181` |
| 130 | `tests/orderstatus.status.test.mjs` | `045242d9f51476a535f94389aecd6499f7bd4209c0caa36f8844d2e963936e76` |
| 131 | `tests/owner.queue.test.mjs` | `4c4990c42938ad30681acdb70fd017a96a2f7efebada2d6ba0cd3be813a72c59` |
| 132 | `tests/owner.revocation.test.mjs` | `6f9ebfddc0745a1ed5e689729238aac71618cf6a9978ee55c9688996e91039a7` |
| 133 | `tests/owner.routes.http.test.mjs` | `848d3b329159a8b729918f4866f78fa9eb22f7993fdae7b586a6c8daa4af41f7` |
| 134 | `tests/owner.signin.test.mjs` | `7683f83307f50db12afada1dcaab8e2cb30e40380f3919671611c5c4cf15fb46` |
| 135 | `tests/password.reset.sql.test.mjs` | `8a64d5665f792479364f15ece8292ca3bb9e3cce9c447ba667fc88f2e6a342b9` |
| 136 | `tests/password.reset.test.mjs` | `3bea242975620ad73cf4225f194f6c08d4c52ac031deea8f3ce243ee1e206d46` |
| 137 | `tests/payments.selection.test.mjs` | `1fd4d1659357a2b7507e73efd06d2000c66ba815d6fa66d254fec3c5c6b8a889` |
| 138 | `tests/public.exposure.test.mjs` | `104f2f36e7ec9cfc88a9fa81058bac547b4420e6c9a00270932b44fbf8ef62a4` |
| 139 | `tests/rate.limit.test.mjs` | `7a27f3a0ac8513011599c4e9817f1b628b0e1203ae6ca0bdc4332d4b4019a7e1` |
| 140 | `tests/rate.limits.migration.test.mjs` | `3cc8d6233dccaa0576e164663b1fc10620ebba759a3dfcf61fe7824842f837b0` |
| 141 | `tests/rate.readwindow.test.mjs` | `120f53dbb2a92605c2351f206f29be0f5b9d4d9a2daff3da555b7ee06a13f1f4` |
| 142 | `tests/razorpay.payment.test.mjs` | `d74a7626cd4b40d1aa68712aefef6ba56e87d3f6df197568c4fe7ac13da272d7` |
| 143 | `tests/security.headers.test.mjs` | `05f67fd30b64e1d15b9445043760a6708aca6e4df817999084b1c73332ce63ce` |
| 144 | `tests/session.revocation.test.mjs` | `1da678bb33242ece1eb5b0c4cf28790b00ccdbfe3bf822cbb78435af1effa7d3` |
| 145 | `tests/settings.reauth.test.mjs` | `95a1b1892e2822c9a9af0528f7fe0ccd6a72ed75409db51033a6d20969f7f328` |
| 146 | `tests/setup/argon2id-wasm-hooks.mjs` | `e6c29f92a0b39c3de390497173ae540613fc2a81c378e6aa25cb90061a5571a5` |
| 147 | `tests/setup/register.mjs` | `95fcc399b29959e3c5738920e51fef00c86b9cad33c60013ce27ac096cf952e9` |
| 148 | `tests/status.transitions.test.mjs` | `c694c7a6216cc58ebbb0db4988b1d7210949ec88106272055c2d2371be73fc86` |
| 149 | `tests/workos.jwt.test.mjs` | `04dde1d1e48b56528c7bbd1f0f3fdbc84d2c1e8e459ace875c7537bdd26143f4` |
| 150 | `vite.config.js` | `400ef97cfc227e91d525ea166aee8019eaf9dc4489a7eef304d369b1238234d5` |
| 151 | `worker/api.js` | `500efd1c9de183e95a502d13899024826f5dfa42d833e4f34f017f110d7951d0` |
| 152 | `worker/authmode.js` | `336ec1e776178b6206957ea35989ebe524a3de0a0d60b1f8a1ec254279c8348d` |
| 153 | `worker/cafes.js` | `32992d79f9efb51bfa15cf5259b8479df05ccfcd394718173795a4625ff76c10` |
| 154 | `worker/db.js` | `bd8e4abc8f25276e5548d73f9db2ad51afb71ba02848db3c14d746bc1f869cbf` |
| 155 | `worker/http.js` | `d698bcd3274ba8dffba8a9da266dcd2801ebcf56285a4b92e66a395e84f5c80b` |
| 156 | `worker/index.js` | `30ac4608c30545a6b0f79da3afcabfde588ae6f3ce0c62c0faddb8d7036d4293` |
| 157 | `worker/jwt.js` | `70c0b72441c60f399b4e1ac1ca18b8dc60422eb139a6b961c7945fcc0968ac18` |
| 158 | `worker/orderids.js` | `09187063a9dc4db214ad3f762470d9c2118c6a371971cf0678cba93485a7403d` |
| 159 | `worker/orders.js` | `4e9d0553a30b1b86ed93c49963f9d2f240132afcdb3e06b05b19b1cd97d28013` |
| 160 | `worker/owner.js` | `a68968ce9c406af509a0f72bfaa17306c948c6cc450bbbae7960d9e22f33659b` |
| 161 | `worker/passwords.js` | `5de52a5a55ae76c0b92b366792883b99820ebecfac31663ea80d107b2153d469` |
| 162 | `worker/pkce.js` | `1bf79a573051b364b27091eb5dde7f651034b5302c54b98c720149ee96d16081` |
| 163 | `worker/revocations.js` | `bf5bcb229f0e47ec6c6f6e63e2a00c6c5f7810efe8ced603355de07067244d2f` |
| 164 | `worker/session.js` | `fac4ea80adb9b3a9775abb37c4758bd603a8d83eca34fe33f1bc73aeb1fbabab` |
| 165 | `worker/tracking.js` | `112237e08aa2e9481f5bbd81a76a8e7dc51c770d2a00a29a9f4f2e6d47249ed4` |
| 166 | `worker/workos.js` | `9bf3fa6602d4e27bdc838d21879cddf29c6b5cb16514405887a9a7f415025051` |
| 167 | `wrangler.jsonc` | `3df6a29ed38315b29608c7e2831cef9eef35c0a9362384ac4429db1a01bc96a0` |

**Total: 167 files.**
