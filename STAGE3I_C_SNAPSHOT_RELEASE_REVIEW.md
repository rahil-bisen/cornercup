# Stage 3I-C — Snapshot Release Review

**Reviewed:** `C:\Users\rahil\AppData\Local\Temp\corner-cup-snapshot` (173 files, 3.1 MB), against
`STAGE3I_B_SNAPSHOT_PREPARATION_REPORT.md`.
**Mode:** read-only. Nothing in the worktree or the snapshot was modified; the only file added is this report.

---

## 1. Executive verdict

## Verdict: CONDITIONAL PASS

The snapshot is **technically publishable today**: it is complete, byte-identical to the working tree, free of
credential values and local databases, and a fresh copy installs, passes 475/475 tests, builds and validates with
Wrangler without credentials. Nothing in the source, tests, lockfile or configuration blocks a private
repository.

It is **not yet a clean release** because of the documentation layer: **19 of the 55 reports carry deployment
identifiers, live production URLs or a personal email address**, and **5 reports document an abandoned
authentication path** that has no maintenance value but does carry third-party identity strings. Publishing the
snapshot as-is would put a live production URL, two Sites project ids, D1 database ids and a personal Gmail
address into repository history permanently — and "private" is not a guarantee (visibility can change, access can
be granted, forks and exports exist), which is exactly the assumption the stage instructions forbid.

Decisions needed before the first push (all mechanical, none architectural):
**redact 19 reports, exclude 5, decide on `site.json`**, and add the missing `.gitignore` entries (§5).

---

## 2. Snapshot integrity

| Check | Result |
| --- | --- |
| Source files (excluding `node_modules/`, `dist/`, `.wrangler/`, harness state) | **173** — matches 3I-B exactly |
| Total size | **3.1 MB** (2.64 MiB of unique bytes); 3.3 MB with `dist/` |
| Per-area counts vs 3I-B | `worker/` 16/16, `src/` 20 (8 lib), `public/` 9/9, `tests/` 59 (50 suites), `scripts/` 5/5, root config 9, reports 55 — **all match** |
| Missing files | **none** |
| Extra / unexpected files | **none** (extension census: 62 `.mjs`, 55 `.md`, 25 `.js`, 11 `.jsx`, 6 `.jpg`, 4 `.json`, 3 `.jsonc`, 2 `.woff2`, 1 each `.txt`/`.html`/`.css`/`.gitignore`/`.example`) |
| Duplicate content | **0 duplicate groups** — 173 files, 173 distinct SHA-256 hashes |
| Empty or truncated files | **0 zero-byte files**; no mojibake in source (console display only) |
| Executable bits / scripts / binaries | **none** in the source set. The only binaries are 6 JPEG defaults and 2 WOFF2 fonts — expected assets |
| Fidelity to the working tree | **173 / 173 byte-identical**, 0 differing, 0 missing in source (SHA-256 comparison) |
| Generated state inside the snapshot | `node_modules/` 244 MB, `dist/` 916 KB (12 files), `.wrangler/` empty — **all created by the 3I-B validation run**, all git-ignored (§5) |
| Git metadata | none in the snapshot itself |

Completeness spot-checks that would break a build if absent: `worker/session.js`, `worker/owner.js`,
`worker/authmode.js`, `worker/jwt.js`, `worker/workos.js`, `worker/pkce.js`, `worker/revocations.js`,
`worker/tracking.js`, `worker/orderids.js`, `worker/passwords.js`; `src/lib/{menuImages,menuScope,payments}.js`;
`tests/setup/register.mjs`, `tests/setup/argon2id-wasm-hooks.mjs`; `public/defaults/*.jpg`, `public/fonts/*.woff2`;
`package-lock.json`. **All present.**

**Integrity: PASS.** No missing, extra, duplicated or unexpected files, and no drift from the source.

---

## 3. Secret and test-fixture hygiene

### 3.1 `.dev.vars.example`

- 9 secret-class keys are present and **all empty** (`ADMIN_SECRET=`, `OWNER_PASSWORD=`, `OPERATOR_PASSWORD=`,
  `ADMIN_PIN=`, `RAZORPAY_KEY_ID=`, `RAZORPAY_KEY_SECRET=`, `RAZORPAY_WEBHOOK_SECRET=`, `TELEGRAM_BOT_TOKEN=`,
  `TELEGRAM_OWNER_CHAT_ID=`).
- Only three **non-secret** defaults carry a value: `CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN`.
- The file is a correct template; no change needed. **PASS.**

### 3.2 `OPERATOR_PASSWORD` occurrences: test-only, confirmed

Seven files reference the name; the value is a **fixture literal**, established four ways:

1. **Runtime has no fallback.** `worker/api.js` → `operatorLogin` reads `env.OPERATOR_PASSWORD`, trims it, and
   returns **503** when it is empty. There is no default, no hardcoded comparison string, no branch in which a
   literal from the repository could authenticate a request.
2. **Tests declare it locally** as a module constant and send it as a request body to the local harness
   (`/api/operator/login`, CSRF checks, revocation, rate-limit tests). They do not read it from any environment
   file.
3. **The harness supplies it through Wrangler `vars`** in `tests/harness/wrangler.auth.jsonc`, i.e. the disposable
   local harness database — never a deployed environment.
4. **The harness documents its fixtures** (`tests/harness/credentials.mjs`): "Nothing here is a real credential:
   the harness only ever runs locally."

A production deployment takes the operator password from the platform secret store; if it were set to this
literal, that would be an operator error, not a repository leak. **Conclusion: test fixture, not a secret.** The
only residual note is hygiene: the local `.dev.vars` happens to reuse the same literal, so the value is already
public in the test suite — do not reuse it for any real deployment (§8, item 3).

### 3.3 Other hardcoded credentials

| Category | Finding |
| --- | --- |
| `password`/`secret`/`token` string literals in code | **0 in `worker/` and `src/`.** Only in `tests/` (32 payload strings) and `tests/harness/credentials.mjs` (2 documented fixtures) — all local-harness inputs |
| Long base64 blobs | **0** in source (the one candidate match in `worker/api.js` was a false positive of the regex, not a blob) |
| 32+ hex strings in code/tests | **0** |
| Bearer tokens | **0** |
| Private keys / certificates | **0** anywhere |
| Real-format Razorpay keys (`rzp_live_`, full `rzp_test_`) | **0** |
| GitHub / AWS / Cloudflare tokens | **0** |
| Local database records | none possible — no SQLite or SQL file exists in the snapshot |
| Environment files with values | none — only `.dev.vars.example` (empty) |

**Result: no genuine secret is in the snapshot.** All 32-hex and UUID-shaped strings in the snapshot are in
**documentation** (deployment, environment and database identifiers), not in executable code — see §4.

---

## 4. Report-by-report sensitivity inventory

Automated profiling of all 55 root reports (UUID/32-hex identifiers, `*.freebuff.page` URLs, email addresses,
secret/password vocabulary, exploit vocabulary, recovery vocabulary, local URLs, session vocabulary), then a
manual read of the highest-signal files. **No value is reproduced here** — only filenames, sections and types.

### 4.1 Sensitive-content map (19 files carry something that should not be published as-is)

| Report | Type of content | Section(s) |
| --- | --- | --- |
| `STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md` | **Live production URL**, Sites site id, production environment id, staged-resources id; plus a statement that the public deployment runs pre-remediation code with payments enabled | §2 "Deployment identity", §3 "Served artifact identity", bound-resources table |
| `STAGE15_PRODUCTION_CONTAINMENT_DECISION.md` | 13 identifiers (two Sites projects, environment ids), 2 live URLs, containment timeline | §1.1, §1.2, §1.4, §1.6 |
| `STAGE16A_PRODUCTION_BACKUP_REPORT.md` | 15 identifiers (D1 database ids, export ids), **3 personal Gmail addresses** | §2 "Confirmed source identity", §3 "Stop condition 1", §6 "Verification performed" |
| `STAGE13_PRODUCTION_READINESS_AUDIT.md` | 6 identifiers, 1 live URL, exploit-path detail | §1, §3.1, §3.2 |
| `STAGE13_1_REMEDIATION_PLAN.md` | 2 identifiers (production D1) | §6 |
| `MASTER_REMEDIATION_REPORT.md` | 1 identifier | §1 "Initial condition" |
| `PRODUCTION_DEPLOYMENT_CHECKLIST.md` | 1 identifier | §0 "Hard blockers" |
| `STAGE10A_AUTH_AUDIT.md` | 1 identifier, auth-bypass analysis | title/intro block |
| `STAGE10A1_AUTH_REMEDIATION_PLAN.md` | 1 identifier, exploit vocabulary | title/intro block |
| `STAGE10B_WORKOS_SANDBOX_REPORT.md` | 1 identifier (WorkOS sandbox) | title/intro block |
| `STAGE11_BACKUP_RESTORE_REPORT.md` | 2 identifiers (source/target database identity) | §2 |
| `STAGE12_CONFIGURATION_RECOVERY.md` | 6 identifiers (workers, environments, D1 bindings) | §3, §4 |
| `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` | 2 identifiers | §4, §8.1 |
| `STAGE3_DEPLOYMENT_PREFLIGHT.md` | 4 identifiers (worker version, database binding, rollback ids) | §1, §2, §9 |
| `STAGE4_STAGING_CONFIGURATION.md` | 4 identifiers (staging D1 binding, maintenance config) | §2, §3, §7 |
| `STAGE5_FINAL_STAGING_SAFETY_REVIEW.md` | 3 identifiers (deployed version pins) | title, §4 |
| `STAGE6_STAGING_DEPLOYMENT.md` | 4 identifiers (deployment record) | Title, "Target", "Deployment" |
| `STAGE7_AUTH_FUNCTIONAL_READINESS.md` | 2 identifiers | §1 |
| `STAGE3I_A_REPOSITORY_HYGIENE_REPORT.md` | **2 personal Gmail addresses** (commit author), one 32-hex string | §1.1 "Repository identity", §3.1 "Findings" |

### 4.2 Classification of all 55 reports

**KEEP — 31 files.** Technical or product documentation with no identifiers, URLs or personal data; all are
useful for building, maintaining or reasoning about the application.

| Report | Why KEEP |
| --- | --- |
| `README.md` | Setup, commands, ports, env-var names — the entry point |
| `AUTHENTICATION_DECISION.md` | Design rationale for the shipped auth model |
| `COMPLETE_SECURITY_AUDIT.md` | F-01–F-20 findings; the code it describes is in the repo |
| `SECURITY_STATUS.md` | 758-line verification ledger; the project's own security record |
| `SECURITY_FINDINGS_MATRIX.md`, `SECURITY_REMEDIATION_MATRIX.md`, `SECURITY_REMEDIATION_LOG.md` | Finding-to-fix traceability |
| `SECURITY_DEPLOYMENT_CHECKLIST.md`, `SECURITY_TEST_REPORT.md` | Pre-deploy checks (local URLs only) |
| `DISASTER_RECOVERY_RUNBOOK.md` | Operational recovery procedure, no ids or URLs |
| `OPERATIONAL_READINESS.md`, `PRODUCT_READINESS_REPORT.md`, `RATE_LIMIT_CAPACITY_REPORT.md` | Operational and capacity analysis |
| `FIRST_CAFE_ONBOARDING_CHECKLIST.md`, `STAGING_READINESS_CHECKLIST.md` | Process checklists without identifiers |
| `STAGE12_BACKUP_POLICY.md` | Backup frequency/retention policy — no identifiers |
| `STAGE12_DATABASE_RECONNECTION.md` | Reconnection procedure; refers to `database_id` as a configuration **field**, with no value |
| `STAGE13_1_SOURCE_PRESERVATION_REPORT.md` | Source-preservation procedure; no id, URL or address values |
| `STAGE8A_OPERATOR_AUTH_PREP.md` | Operator-console design |
| `STAGE3A`–`STAGE3H` (8 reports) | Menu photography, accessibility, image decoding, image-processing architecture — directly relevant to the code |
| `UI_IMPROVEMENT_AUDIT.md`, `UI_IMPROVEMENT_STAGE2_REPORT.md`, `UI_IMPROVEMENT_STAGE2_1_REVIEW.md`, `UI_IMPROVEMENT_STAGE2_2_REPORT.md` | Design decisions for the shipped UI |

**KEEP AFTER REDACTION — 19 files.** Substantive documentation worth keeping, but each contains at least one
deployment identifier, live URL, internal endpoint or personal address. Redaction is mechanical: replace
identifier tables with `<site-id>` / `<environment-id>` / `<database-id>`, replace live URLs with
`https://<deployment>`, replace personal addresses with `Corner Cup <dev@example.invalid>`, and drop the
version-id pins.

The 19 are exactly the list in §4.1. Highest priority: `STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md` and
`STAGE15_PRODUCTION_CONTAINMENT_DECISION.md` (live URLs plus an inventory of what production is running),
`STAGE16A_PRODUCTION_BACKUP_REPORT.md` (personal addresses and database ids), and
`STAGE3I_A_REPOSITORY_HYGIENE_REPORT.md` (the commit-author address; only that section needs touching).

**EXCLUDE — 5 files.** Redaction would not make them worth publishing: they document an abandoned path, carry
third-party identity strings, and duplicate decisions that are already captured elsewhere.

| Report | Why EXCLUDE |
| --- | --- |
| `FIREBASE_INTEGRATION_PLAN.md` | Abandoned Firebase path (superseded by the WorkOS/local decision); 68 credential-vocabulary lines and a Google service-account identity in §7. Publishing plans for an integration that will never exist only misleads future maintainers. |
| `FIREBASE_MFA_EVIDENCE.md` | Same abandoned path; service-account identity in §2.2; evidence belongs with the abandoned branch, not the product repo |
| `FIREBASE_MFA_READINESS.md` | Same; service-account identity in §2.1 |
| `ZERO_BUDGET_AUTH_FEASIBILITY.md` | Firebase feasibility study, same third-party identity in §5; the decision it fed is already in `AUTHENTICATION_DECISION.md` |
| `F07_VALIDATION_REPORT.md` | Explicitly declared historical by `SECURITY_STATUS.md` ("protected, unmodified, now historical"); describes the abandoned PBKDF2 600 k design. Keep locally as an archive. |

**Counts reconcile: 31 + 19 + 5 = 55.**

---

## 5. `.gitignore` findings

The snapshot's `.gitignore` is the project's tracked file, unmodified (I did not touch it).

```
node_modules/   dist/   .wrangler/   .tools/   sites-build/
.admin-secret.txt   .operator-password.txt   .dev.vars   .env   .DS_Store   *.log
.razorpay-key-id.txt   .razorpay-key-secret.txt
audit-package/   corner-cup-*.zip   *.sqlite   *.sqlite-wal   *.sqlite-shm
```

Verified in a disposable copy that had already run `npm ci`, `npm test` and `npm run build`, by listing what a
fresh add would take (`git ls-files --others --exclude-standard`, nothing staged):

| Path | Verdict | Consequence |
| --- | --- | --- |
| `node_modules/` (244 MB) | **ignored** (`.gitignore:1`) | A fresh `git add` takes **173 files**, exactly the snapshot — **0** generated paths |
| `dist/` (12 files) | **ignored** (line 2) | Build output cannot be committed |
| `.wrangler/` | **ignored** (line 3) | Wrangler state cannot be committed |
| `.dev.vars`, `.env` | **ignored** (lines 8–9) | Local credentials cannot be committed |
| `*.sqlite`, `-wal`, `-shm` | **ignored** (lines 18–20) | Local D1 state cannot be committed |
| `*.log`, `*.zip`, `audit-package/` | **ignored** (lines 11, 17, 16) | Logs and archives cannot be committed |
| `tests/harness/.state-a2/<file>.sqlite` | **ignored** (`*.sqlite`) | Harness databases stay out |
| `tests/harness/.state-a2/<other file>` (e.g. `config.json`) | **NOT ignored** | ⚠️ **Gap**: the directory is not ignored, only its SQLite/log contents. A non-SQLite file dropped there by a future tool would be committed. |
| `tests/harness/.wrangler/`, `tests/harness/.state-*` (directory level) | not ignored as directories | Same gap, same low risk |

Recommended additions (already proposed in 3I-A §7.3, **not applied**): `corner-cup-transfer/`, `.state-*/`
(`tests/harness/.state-*/`, `.state-ui/`, `.review-state/`, `tmp-ui/`), `.script/`, `.pbkdf2-bench/`, `.tgz*`,
`screenshots/`, `ui-audit/`, `screenshot-*.png`, `.local-logs/`, `.f07-pbkdf2/`.

**Generated directories in the snapshot:** `node_modules/`, `dist/` and an empty `.wrangler/` exist, created by
the 3I-B validation. They are **safely ignored**, and all three are recreated from scratch by `npm ci` and
`npm run build` — nothing in them is needed to reproduce the project. A publication step should simply not copy
them.

---

## 6. Fresh-checkout-style validation

**Not a Git clone.** No repository exists, nothing was cloned, and no remote was contacted. What was tested is a
**disposable file copy** of the snapshot with generated and local state removed — the closest available
approximation of a fresh checkout.

| Item | Value |
| --- | --- |
| Copy | `C:\Users\rahil\AppData\Local\Temp\stage3i-c-verify` |
| Copied | **173 files, 2.64 MiB**; excluded `node_modules/`, `dist/`, `.wrangler/`, `tests/harness/.state-*`, `.git` |
| Pre-state | `node_modules/` absent, `dist/` absent, `.wrangler/` absent, 0 harness state dirs |
| Node / npm | **v26.13.1** / **11.20.0** (identical to 3I-B) |
| `npm ci --no-audit --no-fund` | **exit 0** — 244 MB installed from the **unchanged** lockfile (no dependency update, no lockfile rewrite). npm printed its informational `install-scripts` notice for `esbuild`/`workerd`; still unnecessary for build and tests |
| `npm test` | **exit 0 — 475 tests, 475 pass, 0 fail, 0 skipped, 0 cancelled**, 130.3 s |
| `npm run build` | **exit 0** — 105 modules, 2.01 s; `index-B_nBG-g5.css` 33.10 kB, `index-CIYopyjw.js` **287.11 kB** (gzip 92.71 kB) — **byte-identical file names to the source and snapshot builds** |
| `npx wrangler deploy --dry-run` | **exit 0** (wrangler 4.158.0) — read 15 files from `dist/`, total upload 237.21 KiB (gzip 54.76 KiB), bindings `env.DB` (D1 `corner-cup`), `env.ASSETS`, and the three vars. No account, no credentials, no network side effect |
| Post-state in the copy | `node_modules/`, `dist/`, `.wrangler/` recreated; a fresh add still takes exactly **173** files (0 generated) |

### Limitations

- **Not a Git clone and not a CI run.** Line endings, file modes and `.gitattributes` behaviour were not
  exercised; the copy preserves the files as they are on this machine (CRLF for some text files, which Git would
  normalise only if configured to).
- **Windows only**, one Node version. No Linux/macOS run, no Node 20/22 run.
- **No harness `wrangler dev` process was started** for these commands; the 50 HTTP suites start their own
  harness internally, so the Worker code paths are covered, but a deployed-environment smoke test was not
  performed (out of scope: no deployment allowed).
- The `IMAGES` R2 binding is still absent, so photo routes answer 503 — a known provisioning gap, not a
  reproducibility failure.
- `npm ci` used `--no-audit --no-fund`; the dependency audit result was not re-derived in this stage.

---

## 7. Final proposed publication manifest

Nothing below has been applied. This is a decision list.

### 7.1 Publish unchanged — 148 files

| Group | Files | Notes |
| --- | --- | --- |
| `worker/*.js` | 16 | Complete Worker |
| `src/**` | 20 | 8 lib modules, 6 pages, 4 components, `main.jsx`, `styles.css` |
| `public/**` | 9 | 6 photographs, 2 fonts, `OFL.txt` — licence text included, which is required |
| `tests/**` | 59 | 50 suites, setup, harness, fixtures |
| `scripts/*.mjs` | 5 | Migration tooling |
| Build/config | 7 | `package.json`, `package-lock.json`, `wrangler.jsonc`, `vite.config.js`, `index.html`, `.gitignore`, `sites.manifest.json` |
| Config example | 1 | `.dev.vars.example` (empty placeholders only) |
| Root reports classified KEEP | 31 | §4.2 — the 31 includes `README.md` |
| **Total** | **148** | 173 − 19 (redaction) − 5 (exclude) − 1 (`site.json`); 16+20+9+59+5+7+1+31 = 148 |

### 7.2 Require redaction before publishing — 19 files

All reports listed in §4.1. Redaction targets, in order of value:
identifiers in deployment/identity tables → `<site-id>`, `<environment-id>`, `<database-id>`, `<version-id>`;
live `*.freebuff.page` URLs → `https://<deployment-origin>`;
personal Gmail addresses (in `STAGE16A` §3/§6 and `STAGE3I_A` §1.1/§3.1) → project identity;
the production-state narrative in `STAGE13_1`/`STAGE15` may stay, since it is the reason the project made its
containment decision — but the URLs and ids around it must go.

### 7.3 Recommended for exclusion — 6 files

| File | Reason |
| --- | --- |
| `FIREBASE_INTEGRATION_PLAN.md` | Abandoned path; third-party service-account identity; misleading to future maintainers |
| `FIREBASE_MFA_EVIDENCE.md` | Same |
| `FIREBASE_MFA_READINESS.md` | Same |
| `ZERO_BUDGET_AUTH_FEASIBILITY.md` | Same; decision already captured in `AUTHENTICATION_DECISION.md` |
| `F07_VALIDATION_REPORT.md` | Declared historical by `SECURITY_STATUS.md`; describes an abandoned design |
| `site.json` | Deployment metadata: Sites project id, production/preview URLs, previous site ids. **Not referenced by any code** (verified: no import, no build reference) and not needed to build, test or deploy through `sites.manifest.json`. If retained, it needs the same redaction as the reports. |

### 7.4 Required for a reproducible build and test — 114 files

The 148 in §7.1 minus the 31 reports and the 3 non-build files (`.gitignore`, `.dev.vars.example`,
`sites.manifest.json`) = 114: `worker/` 16, `src/` 20, `public/` 9, `tests/` 59, `scripts/` 5 = 109, plus
`package.json`, `package-lock.json`, `wrangler.jsonc`, `vite.config.js`, `index.html` = **114** build-and-test
files (`.gitignore`, `.dev.vars.example`, `sites.manifest.json` and `README.md` are repository hygiene, not build
inputs). Verified sufficient by §6.

### 7.5 After publication

Add `STAGE3I_B_SNAPSHOT_PREPARATION_REPORT.md` and this review to the repository's documentation set (neither is
in the snapshot, which was frozen before they were written), and apply the `.gitignore` additions from §5 in a
first follow-up commit.

---

## 8. Blocking issues for repository creation

| # | Blocker | Severity | Why it blocks | Resolution |
| --- | --- | --- | --- | --- |
| **C1** | **19 reports contain deployment identifiers, live URLs or a personal email** | **Blocking a clean release** | Repository history is effectively permanent; visibility can change; the stage forbids assuming private = safe | Redact per §7.2, or exclude those reports |
| **C2** | **5 reports document an abandoned auth path with third-party service-account identities** | **Blocking a clean release** | No maintenance value, misleading, carries external identity strings | Exclude per §7.3 |
| **C3** | **`site.json` carries Sites project/environment ids and both live URLs** and is unused by code | High | Identifies the running deployment to anyone with repository access | Exclude, or redact (§7.3) |
| **C4** | **`.gitignore` does not ignore `tests/harness/.state-*/`, `.script/`, `screenshots/`, `ui-audit/`, `.tgz*`, `corner-cup-transfer/`** as directories | Medium | Harmless for this snapshot (none of those paths exist in it or would be added), but a later commit from the working tree would sweep them in | Add the 3I-A §7.3 lines before the first commit from a normal worktree |
| **C5** | **Local dev `OPERATOR_PASSWORD` equals the test fixture literal** | Low | Not a leak (the literal is already in the tracked suite), but it must never be reused as a real operator password | Change the local `.dev.vars` value; set a distinct production secret |
| **C6** | **No `.github/workflows`** exists | Low (process) | Branch protection cannot require status checks until a build+test workflow exists | Start with review-only protection; add CI, then require it |
| **C7** | **`IMAGES` R2 binding not provisioned**; `database_id` is a placeholder | Low | Photo routes 503 and `wrangler d1` commands need a real id locally | Provision per Stage 3B §10 when photos go live; not a repository blocker |
| **C8** | **Platform-specific metadata committed** (`sites.manifest.json`, `site.json`) | Low | Ties the repository to one hosting path | Keep `sites.manifest.json` (deploy path); decide on `site.json` (C3) |

**Nothing blocks the *technical* content**: the code, tests, lockfile, assets and configuration are complete,
reproducible and clean. C1–C3 are documentation decisions; C4–C8 are hygiene follow-ups.

---

## 9. Confirmations

- **No GitHub repository was created**, and no remote was configured. `git remote` reports **0** remotes in the
  original worktree.
- **Nothing was committed, staged, amended, pushed, reset, cleaned, checked out or rebased.** The index is empty
  (`git diff --cached --name-only` lists 0 entries). The one `git init` performed anywhere was inside the
  disposable verification copy in `%TEMP%`, created solely to test ignore rules — no commit was made there either,
  and it touched neither the worktree nor the snapshot.
- **No source, snapshot, configuration or secret was changed.** The snapshot is byte-identical to the working
  tree (173/173 hashes match) and no file inside it was written; the validation ran only in
  `%TEMP%\stage3i-c-verify`, a disposable copy, and in `%TEMP%` build output directories.
- **`.gitignore` was read, not modified.**
- **No deployment, publication, provisioning, secret change, or production/staging access** occurred; Wrangler
  ran with `--dry-run` only.
- **Original worktree state preserved:** `git status --porcelain` reports 160 entries = 27 modified + 133
  untracked; that is the pre-stage state (27 modified + 132 untracked) plus **this report**, the single file this
  stage added. `git diff --shortstat` is unchanged at 27 files / +5,871 / −1,048.
- **No credential value appears in this report** — findings name files, sections, key names and counts only.

## Appendix A — Report classification index (all 55, alphabetical)

Every `.md` file at the snapshot root, exactly once. `KEEP` files need no change; `REDACT` files are
published only after the named values are replaced; `EXCLUDE` files are left out of the repository.

| # | Report | Class | Concern |
| --- | --- | --- | --- |
| 1 | `AUTHENTICATION_DECISION.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 2 | `COMPLETE_SECURITY_AUDIT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 3 | `DISASTER_RECOVERY_RUNBOOK.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 4 | `F07_VALIDATION_REPORT.md` | EXCLUDE | declared historical by SECURITY_STATUS.md; abandoned PBKDF2 design |
| 5 | `FIREBASE_INTEGRATION_PLAN.md` | EXCLUDE | abandoned path; third-party service-account identity (§7) |
| 6 | `FIREBASE_MFA_EVIDENCE.md` | EXCLUDE | abandoned path; third-party identity (§2.2) |
| 7 | `FIREBASE_MFA_READINESS.md` | EXCLUDE | abandoned path; third-party identity (§2.1) |
| 8 | `FIRST_CAFE_ONBOARDING_CHECKLIST.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 9 | `MASTER_REMEDIATION_REPORT.md` | REDACT | 1 identifier (§1) |
| 10 | `OPERATIONAL_READINESS.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 11 | `PRODUCTION_DEPLOYMENT_CHECKLIST.md` | REDACT | 1 identifier (§0) |
| 12 | `PRODUCT_READINESS_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 13 | `RATE_LIMIT_CAPACITY_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 14 | `README.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 15 | `SECURITY_DEPLOYMENT_CHECKLIST.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 16 | `SECURITY_FINDINGS_MATRIX.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 17 | `SECURITY_REMEDIATION_LOG.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 18 | `SECURITY_REMEDIATION_MATRIX.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 19 | `SECURITY_STATUS.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 20 | `SECURITY_TEST_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 21 | `STAGE10A1_AUTH_REMEDIATION_PLAN.md` | REDACT | 1 identifier; exploit vocabulary |
| 22 | `STAGE10A_AUTH_AUDIT.md` | REDACT | 1 identifier; auth-bypass analysis |
| 23 | `STAGE10B_WORKOS_SANDBOX_REPORT.md` | REDACT | 1 identifier (WorkOS sandbox) |
| 24 | `STAGE11_BACKUP_RESTORE_REPORT.md` | REDACT | 2 identifiers (§2) |
| 25 | `STAGE12_BACKUP_POLICY.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 26 | `STAGE12_CONFIGURATION_RECOVERY.md` | REDACT | 6 identifiers (§3, §4) |
| 27 | `STAGE12_DATABASE_RECONNECTION.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 28 | `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` | REDACT | 2 identifiers (§4, §8.1) |
| 29 | `STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md` | REDACT | live production URL; Sites site id; production environment id; resource id |
| 30 | `STAGE13_1_REMEDIATION_PLAN.md` | REDACT | 2 identifiers (production D1) |
| 31 | `STAGE13_1_SOURCE_PRESERVATION_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 32 | `STAGE13_PRODUCTION_READINESS_AUDIT.md` | REDACT | 6 identifiers; 1 live URL; exploit-path detail |
| 33 | `STAGE15_PRODUCTION_CONTAINMENT_DECISION.md` | REDACT | 13 identifiers (two Sites projects, environment ids); 2 live URLs |
| 34 | `STAGE16A_PRODUCTION_BACKUP_REPORT.md` | REDACT | 15 identifiers (D1 database ids, export ids); 3 personal Gmail addresses |
| 35 | `STAGE3A_MENU_PHOTOGRAPHY_AUDIT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 36 | `STAGE3B_MENU_PHOTOGRAPHY_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 37 | `STAGE3C_MENU_PHOTOGRAPHY_REVIEW.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 38 | `STAGE3D_MENU_MOBILE_ACCESSIBILITY_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 39 | `STAGE3E_DEFAULT_IMAGE_DIVERSITY_AUDIT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 40 | `STAGE3F_DEFAULT_IMAGE_MAPPING_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 41 | `STAGE3G_IMAGE_DECODING_FEASIBILITY_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 42 | `STAGE3H_IMAGE_PROCESSING_ARCHITECTURE_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 43 | `STAGE3I_A_REPOSITORY_HYGIENE_REPORT.md` | REDACT | 2 personal Gmail addresses (commit author); 1 32-hex value |
| 44 | `STAGE3_DEPLOYMENT_PREFLIGHT.md` | REDACT | 4 identifiers (§1, §2, §9) |
| 45 | `STAGE4_STAGING_CONFIGURATION.md` | REDACT | 4 identifiers (§2, §3, §7) |
| 46 | `STAGE5_FINAL_STAGING_SAFETY_REVIEW.md` | REDACT | 3 identifiers (version pins) |
| 47 | `STAGE6_STAGING_DEPLOYMENT.md` | REDACT | 4 identifiers (deployment record) |
| 48 | `STAGE7_AUTH_FUNCTIONAL_READINESS.md` | REDACT | 2 identifiers (§1) |
| 49 | `STAGE8A_OPERATOR_AUTH_PREP.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 50 | `STAGING_READINESS_CHECKLIST.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 51 | `UI_IMPROVEMENT_AUDIT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 52 | `UI_IMPROVEMENT_STAGE2_1_REVIEW.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 53 | `UI_IMPROVEMENT_STAGE2_2_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 54 | `UI_IMPROVEMENT_STAGE2_REPORT.md` | KEEP | no identifiers, URLs, addresses or credential vocabulary |
| 55 | `ZERO_BUDGET_AUTH_FEASIBILITY.md` | EXCLUDE | abandoned path; third-party identity (§5); decision already recorded |

**Totals: KEEP 31, REDACT 19, EXCLUDE 5 = 55.**

Classification rules applied: an identifier, live deployment URL or personal address forces `REDACT`;
a report whose subject is abandoned, superseded or duplicated elsewhere is `EXCLUDE` even after redaction;
everything else is `KEEP` — security architecture, exploit history and recovery procedures are deliberately
kept, because the code and tests that implement and verify them are published in the same repository.
