# Stage 3I-A — Private GitHub Repository Hygiene Audit

**Verdict: not ready to push as-is — one blocking issue, plus five high-severity preparation items.**
The working tree is a **complete, building, 475-test-passing application**, but `HEAD` is not: the last commit
predates the authentication, payments and photography work, so 10 `worker/` modules, 3 `src/lib/` modules, the
whole `public/` asset set and 46 `tests/` entries exist **only as untracked files**. A naive `git add -A` would
nonetheless sweep in 267 untracked files including a **full duplicate copy of the project**
(`corner-cup-transfer/`, 62 files) and 55 screenshots — and would still leave the repository unable to build from
a fresh clone in the sense that matters most: the *committed* tree lacks the files the build imports.

Read-only: no index entry, worktree file, source file, config or test was modified. The only file added is this
report.

---

## 1. Git inventory

### 1.1 Repository identity

| Item | Value |
| --- | --- |
| Branch | `freebuff/qr-code-cafe-ordering-website` (the only branch; no upstream, nothing tracking) |
| HEAD | `023befea5b337f8daa783ac7b7fd323bd8dffac8` |
| HEAD subject | "Add versioned owner sessions with an operator-driven password reset" |
| HEAD author / date | `Rahil <rahilbisen8@gmail.com>`, Thu 12 Nov 2026 14:45:24 +0530 |
| Commits | **7** (no merges, no tags, no other branches) |
| Remotes | **0** — `git remote -v` is empty; no `origin`, no fetch/push URLs, no remote-tracking refs |
| Submodules | none (`.gitmodules` absent) |
| Workflow files | none (`.github/` absent) |
| Tracked files | **45** |
| Working-tree status | **157 entries**: 27 modified, 0 deleted/renamed, 130 untracked |
| Files git would add right now | **267** (`git ls-files --others --exclude-standard`) |
| Ignored files on disk | **9,274** |

The brief's "156 pre-existing dirty entries" is exact: the tree held 156 before Stage 3H added its report, and
157 now. Everything except `STAGE3H_IMAGE_PROCESSING_ARCHITECTURE_REPORT.md` pre-dates this audit and was
preserved untouched.

### 1.2 History

```
023befe Add versioned owner sessions with an operator-driven password reset
f0aef0e Enforce NEW → PREPARING → READY → SERVED order workflow
30c1db3 Trim whitespace from operator and legacy owner passwords before compare
f8a9bb5 Track the QR-ordering source in a baseline commit
5c037a7 Freebuff: Cloud's files for chat 0db48f77-…
9569b7f Import cloud project files
12ab8a3 Initial cloud project
```

History is **linear and shallow**: three Freebuff import commits followed by four development commits. `f8a9bb5`
is the baseline that added `.dev.vars.example` (template only, 36 lines, no values). The author identity in every
commit is a personal Gmail address — visible in `git log` forever once pushed, and worth deciding on before the
first push (see §7.6).

### 1.3 What HEAD contains, and what it is missing

| Directory | In HEAD | On disk | Missing from the commit |
| --- | --- | --- | --- |
| `worker/` | 6 | **16** | `authmode.js`, `jwt.js`, `orderids.js`, `owner.js`, `passwords.js`, `pkce.js`, `revocations.js`, `session.js`, `tracking.js`, `workos.js` |
| `src/lib/` | 5 | **8** | `menuImages.js`, `menuScope.js`, `payments.js` |
| `src/pages/`, `src/components/` | 9 | 9 | — (but all 9 are modified) |
| `tests/` | 12 | 47 entries | 35 test files + `tests/setup/` (2 files) + `tests/lib/`, `tests/fixtures/` |
| `public/` | 0 | **9** | 6 default photographs + 2 fonts + `OFL.txt` |
| `scripts/` | 0 | **5** | staging migration generators |

The consequence is concrete: `worker/api.js` at HEAD imports `./session.js`, `./owner.js`, `./authmode.js`,
`./revocations.js` and `./pkce.js`, and none of those files exist in the commit. `npm run build` would still
succeed (those imports are Worker-side, not in the Vite graph) but `wrangler dev`/`deploy` and **the entire test
suite** would fail, and `tests/setup/register.mjs` — which `package.json`'s `test` script now requires — is
untracked.

### 1.4 `.gitignore` as it stands (tracked, unchanged by this audit)

```
node_modules/   dist/   .wrangler/   .tools/   sites-build/
.admin-secret.txt   .operator-password.txt   .dev.vars   .env   .DS_Store   *.log
.razorpay-key-id.txt   .razorpay-key-secret.txt
audit-package/   corner-cup-*.zip   *.sqlite   *.sqlite-wal   *.sqlite-shm
```

Verified with `git check-ignore -v`, the important cases all hold:

| Path | Verdict | Rule |
| --- | --- | --- |
| `.dev.vars` | **ignored** | `.dev.vars` |
| `corner-cup-transfer/project/.dev.vars` | **ignored** | `.dev.vars` (matches at any depth) |
| `.razorpay-key-id.txt` (root and nested copy) | **ignored** | `.razorpay-key-id.txt` |
| `tests/harness/.wrangler/**` | **ignored** | `.wrangler/` |
| `.review-state/`, `.state-ui/`, `tmp-ui/` (Miniflare D1 SQLite) | **ignored, file by file** | `*.sqlite`, `-wal`, `-shm` — 0 addable files |
| `.local-logs/`, `.f07-pbkdf2/`, `.fc.log`, `path.log` | **ignored** | `*.log` |
| `corner-cup-source.zip` (4.0 GB) | **ignored** | `corner-cup-*.zip` |
| `audit-package/` | **ignored** | `audit-package/` |
| `node_modules/`, `dist/`, `sites-build/`, `.tools/` | **ignored** | explicit |

The local database directories are invisible to `git status` only because **every file inside them matches
`*.sqlite*`**. The directories themselves are not ignored, so anything non-SQLite dropped there later would be
committed without warning (§7.3).

---

## 2. Dirty-worktree classification

### 2.1 Modified (27 files, +5,871 / −1,048)

All 27 are **legitimate application changes that must be in the snapshot**. None is scratch.

| Group | Files | Change |
| --- | --- | --- |
| Worker | `worker/api.js` (+2,611/−…), `cafes.js`, `db.js`, `http.js`, `index.js`, `orders.js` | Auth/session extraction, photography routes, Razorpay, tracking, CSRF, rate limits. `api.js` is the bulk of the diff. |
| Frontend | `src/pages/{Admin,Menu,Operator,OrderStatus}.jsx`, `src/components/{CartSheet,PaymentPanel}.jsx`, `src/lib/{api,config}.js`, `src/styles.css`, `index.html` | Menu photography UI, payment panel, mobile/a11y work, design pass. |
| Tests | `tests/harness/worker.mjs` (+1,197), `harness/wrangler*.jsonc`, `migrations`, `orders.integration`, `password.reset`, `status.transitions` | In-memory R2, fault injection, new suites. |
| Config | `package.json`, `package-lock.json` (+414), `wrangler.jsonc`, `README.md` | `argon2id` + `jsdom` added, React Router 6→7, `test` script now needs `tests/setup/register.mjs`, wasm rule + `run_worker_first` in Wrangler. |

`package.json` and `wrangler.jsonc` diffs were read in full: no credentials, no account ids, no secrets.

### 2.2 Untracked (130 status entries → 267 individual files)

| # | Category | Entries | Files | Verdict |
| --- | --- | --- | --- | --- |
| U1 | **Application source** — `worker/` (10), `src/lib/` (3), `tests/` (46 entries: 35 suites, `setup/` 2, `lib/` 1, `fixtures/` 1, harness configs), `public/` (9 assets), `scripts/` (5) | 65 | ~152 | **Include.** Without these the commit does not build, test or render. |
| U2 | **Engineering reports** — 53 root `*.md` (F07, SECURITY_*, STAGE*, STAGING_*, UI_*, ZERO_BUDGET_*) | 54 | 54 | **Include** (project record) or move to `docs/`; they contain no secrets, but several quote production URLs. |
| U3 | **Deployment/ops artefacts** — `wrangler.staging.jsonc`, `wrangler.staging-maint.jsonc`, `staging-migrations{,-fresh,-freshsafe}.sql`, `start-auth-harness.ps1` | 6 | 6 | **Review.** SQL dumps are schema-only (0 `INSERT`); staging configs carry a D1 `database_id` (§3.5). |
| U4 | **Duplicate project copy** — `corner-cup-transfer/` (868 KB, incl. its own `.dev.vars`, `.razorpay-key-id.txt`, `.gitignore`) | 1 | **62 addable** | **Exclude.** A second, stale copy of the whole app; adding it would fork the source of truth. Its nested `.dev.vars` is ignored, but the surrounding source is not. |
| U5 | **Screenshots / QA evidence** — `screenshots/` (20, 2.5 MB), `ui-audit/` (35, 3.3 MB), `screenshot-landing.png` | 3 | 56 | **Exclude** from the initial snapshot (or a `docs/screenshots/` follow-up). |
| U6 | **Scratch & scratch scripts** — `.script/` (10 files: eval/e2e helpers), `.pbkdf2-bench/` (2), `.tgz2` (JSON, 89 B), `.tgz3` (gzip, 17 KB) | 5 | 14 | **Exclude.** `.script/` contains local evaluation harnesses; scanned clean of literal secrets. |
| U7 | **Ignored local state (not addable)** — `.review-state/` (4.3 MB, 22 files), `.state-ui/` (584 KB), `tmp-ui/` (4.1 MB), `.local-logs/`, `.f07-pbkdf2/`, `tests/harness/.wrangler/` (504 MB), `node_modules/`, `dist/`, `sites-build/`, `audit-package/`, `*.zip` (4.0 GB), `.tools/` | 0 | 9,274 | **Exclude — already ignored.** 504 MB of `tests/harness/.wrangler` is the single biggest thing on disk. |

Nothing was deleted: there are **no deleted or renamed tracked files**, so no data-loss decisions are pending.

---

## 3. Secret and privacy audit

Method: pattern scan of the whole tree (excluding `node_modules`, `.git`, `.tools`, `sites-build`,
`audit-package`) for Razorpay key shapes, AWS/GitHub token shapes, PEM private keys, literal `KEY=value`
assignments, and Cloudflare/WorkOS credential names; `git check-ignore` per path; per-file token fingerprints
(SHA-256 prefixes only, never values); and a central-directory listing of the 4 GB source archive. **No secret
value is reproduced anywhere in this report.**

### 3.1 Findings

| ID | Path | Finding type | Severity | State |
| --- | --- | --- | --- | --- |
| **S1** | `.dev.vars` (244 B) | **Complete local credential set**: 9 populated keys — `OWNER_PASSWORD`, `ADMIN_PIN`, `ADMIN_SECRET` (session-signing key), `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `OPERATOR_PASSWORD`, plus 3 non-secret settings | **High** if ever committed; currently contained | Ignored by `.dev.vars`, untracked, 0 addable |
| **S2** | `corner-cup-transfer/project/.dev.vars` | **Second copy of the same class of credentials**, inside an otherwise-addable directory (62 addable files) | **High** if that directory is added carelessly | Ignored by `.dev.vars`; the *surrounding* files are not ignored |
| **S3** | `.razorpay-key-id.txt` (24 B) | A **test-mode** Razorpay key id (`rzp_test_…`, 23 chars, distinct from every fixture). The id is not the secret, but it identifies the account | Medium | Ignored, untracked |
| **S4** | `corner-cup-transfer/project/.razorpay-key-id.txt` | Duplicate of S3 in the duplicate tree | Medium | Ignored |
| **S5** | `tests/harness/.wrangler/tmp/dev-*/worker.js` (+ `.map`), 5 bundles | Bundled dev Worker containing the **same test key id literal**, inside 504 MB of Miniflare state | Low | Ignored by `.wrangler/` |
| **S6** | `.review-state/`, `.state-ui/`, `tmp-ui/` (Miniflare D1, 4.3 MB + 584 KB + 4.1 MB) | **Local database with café data**: `password_resets`, `owner_sessions`, café password hashes, orders | **High** if committed; contained today | Ignored via `*.sqlite*`; **directories themselves are not ignored** |
| **S7** | `.review-state/`, `.state-ui/`, `tmp-ui/` | Same as S6 — a second and third copy of the same D1 state | High if committed | As above |
| **S8** | `wrangler.staging.jsonc`, `wrangler.staging-maint.jsonc` | D1 `database_id` UUID and staging worker/database names (infrastructure identifiers, not credentials) | Low | Untracked, **not ignored** — would be committed |
| **S9** | `site.json`, `sites.manifest.json` | Tracked deploy metadata: production and preview `*.freebuff.page` URLs and site ids | Low | Already tracked |
| **S10** | `corner-cup-source.zip` (4.0 GB) | Source archive on disk | Low | Ignored by `corner-cup-*.zip`; **verified not to contain `.dev.vars`, `.env*` or `*razorpay-key*`** |
| **S11** | `staging-migrations*.sql` (3 files) | Schema exports; **0 `INSERT` statements**, no data | Info | Untracked, not ignored |
| **S12** | All commits | Author identity `Rahil <rahilbisen8@gmail.com>` in every commit | Info | Permanent once pushed |

### 3.2 Categories checked and found clean

| Check | Result |
| --- | --- |
| AWS access keys (`AKIA…`) | none |
| GitHub tokens (`ghp_…`, `github_pat_…`) | none |
| PEM private keys / `.pem` / `.key` / `.p12` / `.pfx` / `.crt` / `id_rsa*` anywhere in the tree | **none** |
| Live Razorpay keys (`rzp_live_…`) | **none anywhere**, including history |
| `.env`, `.env.local`, `.env.*` on disk | **none** (only `.dev.vars.example`, a value-free template) |
| Cloudflare API token **values** | none. The string `CLOUDFLARE_API_TOKEN` appears only as an instruction in `STAGE12_BACKUP_POLICY.md` and `STAGE16A_PRODUCTION_BACKUP_REPORT.md` |
| Cloudflare account id in configs/docs | none found (no 32-hex identifiers outside `node_modules`) |
| R2 credentials / bucket names | none; no `r2_buckets` entry exists |
| Payment credentials | test-mode key id only; **no** key secret outside `.dev.vars` |
| Backups / DB exports with rows | none — the three SQL files are schema-only |
| 4 GB archive contents | no credential files |
| `scripts/`, `.script/`, `*.ps1` | read `$env:` only; **no literal secret assignments** |

### 3.3 Exposure assessment

The credential set exists in **at most three places on this machine** (`.dev.vars` ×2, plus the ignored Miniflare
bundles), all outside git, and none of them would be added by `git add -A`. Nothing needs rotating *because of
git*. Two practical caveats:

- `.dev.vars` will be **uploaded with any full-folder copy** (the `corner-cup-transfer/` tree already proves this
  happens). Rotating `ADMIN_SECRET`, the owner/operator passwords and the Razorpay test key before the repository
  goes private is cheap insurance, not a requirement.
- The Miniflare SQLite files hold password **hashes** and live session rows. They are ignored, but they are
  plaintext-readable by anyone with the folder; deleting them after the last local review is good hygiene.

---

## 4. Historical exposure findings

**No credential was ever committed.** Evidence:

1. **Paths ever present in history** (`git log --all --name-only`, all 7 commits): the only secret-adjacent paths
   are `.dev.vars.example` and three test files (`auth.secrets.test.mjs`, `password.reset*.test.mjs`). `.dev.vars`,
   `.env`, `.wrangler/`, `*.sqlite`, `*.sql`, `*.zip`, `*.pem` and `*.key` **never appear**.
2. **Content search across every commit** (`git rev-list --all` + `git grep`): **zero** matches for
   `rzp_live_`, `rzp_test_`, `BEGIN … PRIVATE KEY`.
3. `git log -S` flagged commit `f8a9bb5` for the strings `ADMIN_SECRET=` and `RAZORPAY_KEY_SECRET=`. That commit
   added `.dev.vars.example` (36 lines) whose assignments are **empty**; the flag comes from the variable names,
   not values. Confirmed by the stat: `.dev.vars.example | 36 +` and nothing else.
4. The two `src/lib/razorpay.js` and test fixtures use obvious placeholders (distinct from the real test key id by
   length and fingerprint).

**Therefore: no history rewrite is needed, and none is proposed.** The only permanent exposure is the commit
author's personal email address (§3.1 S12) and the production URLs already in `site.json` — both acceptable for a
private repository, both worth a conscious decision.

---

## 5. Include / exclude manifest

### 5.1 Include — application source (required to build, test and run)

| Path | Files | Why |
| --- | --- | --- |
| `worker/*.js` (all 16, of which 10 untracked) | 16 | The Worker; `api.js` imports every one of them |
| `src/**` (all pages, components, `lib/*.js` incl. the 3 untracked) | 26 | SPA |
| `public/**` (`defaults/` 6 photos, `fonts/` 2 + `OFL.txt`) | 9 | Menu default photography and self-hosted fonts; `/defaults/*` is referenced at runtime |
| `tests/**` excluding `tests/harness/.wrangler/` | 47 entries | 475-test suite; `tests/setup/register.mjs` is required by `npm test` |
| `scripts/*.mjs` | 5 | Staging migration generation/application |
| `index.html`, `vite.config.js` | 2 | Build entry |
| `package.json`, `package-lock.json` | 2 | Dependencies and the lockfile — **both**, `npm ci` needs the lock |
| `wrangler.jsonc`, `sites.manifest.json` | 2 | Worker and deploy configuration (no secrets) |
| `.gitignore`, `.dev.vars.example` | 2 | Template and ignore rules |
| `README.md` | 1 | Setup instructions |
| `src/styles.css` | 1 | Design system |

### 5.2 Include — project record (recommended)

| Path | Files | Note |
| --- | --- | --- |
| Root `*.md` reports (F07, SECURITY_*, STAGE*, STAGING_*, UI_*, ZERO_BUDGET_*) | 54 | 53 untracked + `README.md`. No secrets; several quote production URLs. Consider `docs/` grouping in a later commit. |
| `wrangler.staging.jsonc`, `wrangler.staging-maint.jsonc` | 2 | **Only if** the staging `database_id` is acceptable in a private repo (S8). |
| `staging-migrations*.sql` | 3 | Schema-only exports; reproducible from `worker/db.js`, so optional. |
| `start-auth-harness.ps1` | 1 | Local harness launcher; dev convenience. |

### 5.3 Exclude — must not be committed

| Path | Size / files | Reason |
| --- | --- | --- |
| `.dev.vars` | 244 B | Real local credentials (S1) |
| `corner-cup-transfer/` | 868 KB / 62 addable files | **Duplicate stale copy of the entire project, with its own credentials** (S2, S4) |
| `.review-state/`, `.state-ui/`, `tmp-ui/` | 9.0 MB | Local D1 databases with hashes and sessions (S6, S7) |
| `tests/harness/.wrangler/` | **504 MB** | Miniflare state and bundled dev builds (S5) |
| `.local-logs/`, `.qa-logs/`, `.f07-pbkdf2/`, `.fc.log`, `node-std.log`, `path*.log` | — | Run logs |
| `.script/`, `.pbkdf2-bench/`, `.tgz2`, `.tgz3` | 14 files | Scratch scripts and temp archives |
| `screenshots/`, `ui-audit/`, `screenshot-landing.png` | 56 files, 5.8 MB | QA evidence; keep local or in an external archive |
| `audit-package/`, `corner-cup-*.zip` | 4.0 GB + 1.4 MB | Generated exports |
| `node_modules/`, `dist/`, `sites-build/`, `.tools/` | — | Build and toolchain output |

### 5.4 Excluded but **not yet ignored** — the gap to close

Adding these to `.gitignore` is **not** done by this audit (recommended in §7.3): `corner-cup-transfer/`,
`.script/`, `.pbkdf2-bench/`, `.tgz2`, `.tgz3`, `screenshots/`, `ui-audit/`, `screenshot-landing.png`, `.review-state/`,
`.state-ui/`, `tmp-ui/`, `.local-logs/`, `.f07-pbkdf2/`.

---

## 6. Reproducibility assessment

### 6.1 Toolchain and commands

| Item | Value |
| --- | --- |
| Node | **v26.13.1** (tests run on `node --test`; no `engines` field in `package.json`) |
| npm | 11.20.0 |
| Install | `npm ci` — 4 runtime deps (`argon2id` 1.0.1, `qrcode`, `react`, `react-dom`) + 4 dev deps (`@vitejs/plugin-react`, `jsdom`, `vite`, `wrangler`), 4,900+ locked packages |
| Build | **`npm run build`** = `vite build` |
| Test | **`npm test`** = `node --import ./tests/setup/register.mjs --test --test-concurrency=1 tests/*.test.mjs` |
| Dev | `npm run dev` (build + `wrangler dev --ip 0.0.0.0 --port 3000`) |
| Deploy | `npm run deploy` (build + `wrangler deploy`) — not run by this audit |

### 6.2 Verification performed (read-only in the repository)

| Check | Result |
| --- | --- |
| `npx vite build --outDir "$TEMP/stage3i-build"` | **exit 0**, 105 modules, built in 1.99 s; `index-CIYopyjw.js` 287.11 kB (gzip 92.71 kB), `index-B_nBG-g5.css` 33.10 kB. Output written outside the repo, so `dist/` and the index are untouched. |
| `npm test` | **exit 0 — 475 tests, 475 pass, 0 fail, 0 skipped, 0 cancelled**, 120.7 s |
| Working tree still dirty? | Yes — 156 pre-existing entries preserved, unchanged by both commands |

So the **current worktree is reproducible**: a fresh clone of *these files* plus `npm ci` builds and passes the
full suite with no local state. Two caveats make that statement narrower than it sounds.

### 6.3 A clean checkout of `HEAD` would not reproduce the application

| Requirement | In HEAD? | Consequence of using HEAD as the snapshot |
| --- | --- | --- |
| `worker/session.js`, `owner.js`, `authmode.js`, `jwt.js`, `passwords.js`, `pkce.js`, `revocations.js`, `tracking.js`, `orderids.js`, `workos.js` | **No** | `worker/api.js` imports all of them → `wrangler dev`/`deploy` fail to bundle |
| `src/lib/menuImages.js`, `menuScope.js`, `payments.js` | **No** | Vite build fails on the modified `Menu.jsx`/`CartSheet.jsx` imports |
| `public/defaults/*.jpg`, `public/fonts/*.woff2` | **No** | Build succeeds but the app renders without default photography or brand fonts |
| `tests/setup/register.mjs`, `tests/setup/argon2id-wasm-hooks.mjs` | **No** | `npm test` cannot even start (`--import` target missing) |
| 35 newer test suites | **No** | Coverage claim of 475 tests is unreproducible |
| Modified `wrangler.jsonc` (`CompiledWasm` rule, `run_worker_first`) | **No** | Argon2id wasm would not load in `workerd` |

**The snapshot must therefore be the worktree, not `HEAD`.** `HEAD` is a historical baseline, not a buildable state.

### 6.4 Environment variables — names only

Nothing below has a value in this report. `ADMIN_SECRET` is the only one the application **requires** (its
absence fails closed with 503); the rest degrade to a documented mode.

| Name | Required | Used for |
| --- | --- | --- |
| `ADMIN_SECRET` | **yes** | HMAC signing of owner/operator session tokens |
| `ADMIN_PIN` | no | staff fallback PIN |
| `OWNER_PASSWORD`, `OPERATOR_PASSWORD` | no | first-café owner fallback, `/operator` console |
| `CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN`, `CAFE_SLUG` | no | first-café defaults and clock |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | no | online payments (absent → counter payment) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` | no | new-order alert |
| `ORDER_TRACK_SECRET` | no | guest order-tracking token derivation |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_ISSUER`, `WORKOS_AUDIENCE`, `WORKOS_REDIRECT_URI`, `WORKOS_STATE_ENCRYPTION_KEY`, `WORKOS_API_BASE` | no | managed identity (F-07); unused while `cafes.owner_auth = 'local'` |
| `API_READ_MAX`, `RATE_LIMIT_CLEANUP_PROBABILITY` | no | rate-limit tuning |
| Bindings: `DB` (D1), `ASSETS`, `IMAGES` (R2) | `DB`+`ASSETS` | `IMAGES` is expected by the photo routes and answers 503 until provisioned |

`.dev.vars.example` (tracked) lists 11 of these with empty values — it is a correct template and needs no change.

### 6.5 Missing or at-risk pieces for a fresh clone

1. **`tests/setup/` and `public/` are the two hard gaps** — both untracked today, both required.
2. `IMAGES` R2 binding is absent from `wrangler.jsonc`, so photo upload/read answer 503 until provisioned; this is
   documented behaviour, not a defect, but a fresh clone will look broken if the reviewer expects photos.
3. `wrangler.jsonc` still carries a placeholder `database_id` (`00000000-…`), so `wrangler d1` commands against a
   real account need the id filled in locally — fine, but worth a README note.
4. **No `engines` field**: the suite depends on Node ≥ 20 features (`node --test`, `--import`) and was verified on
   Node 26. A CI runner defaulting to Node 18/20 could behave differently. Recommend pinning `engines.node`
   and a CI `setup-node` version in a later stage.

---

## 7. Recommended initial repository setup

### 7.1 Name and branch

- **Repository:** `corner-cup` (private). It matches the Worker name, the D1 database name and the product; the
  `package.json` name `corner-cup-qr-ordering` is the acceptable alternative if `corner-cup` is taken.
- **Default branch:** `main`. The current branch (`freebuff/qr-code-cafe-ordering-website`) is a tooling artefact;
  rename locally and push `main`, leaving the old name behind rather than publishing it.
- **One initial commit, no history import of the 4 GB archives.** The 7 existing commits can be kept (they contain
  no secrets — §4), or the first push can be a single squashed snapshot; either is safe. Keeping them preserves
  the audit trail, which this project clearly values.

### 7.2 Safe initial snapshot approach (the only step that must not be improvised)

1. **Dry-run first:** `git add -n <paths>` for the allowlist, or `git status --porcelain` cross-checked against
   §5.1/§5.2. Never `git add -A` / `git add .` — that is how `corner-cup-transfer/` (62 files) gets in.
2. Add by path group, checking the count after each: `worker src public tests scripts index.html vite.config.js
   package.json package-lock.json wrangler.jsonc sites.manifest.json .gitignore .dev.vars.example README.md`, then
   the report set.
3. **Verify before committing:** total tracked files ≈ 170–230 (not 267); `git ls-files | grep -c corner-cup-transfer`
   = 0; `git ls-files | grep -c '\.dev\.vars$'` = 0; no path under `.review-state/`, `.state-ui/`, `tmp-ui/`,
   `.script/`, `screenshots/`, `ui-audit/`, `tests/harness/.wrangler/`; and
   `git grep -l 'rzp_test_' --cached` returns only test fixtures, never `.dev.vars`.
4. Commit, then **push to the private repository only**, and confirm from the GitHub file list that no credential
   path is present.

### 7.3 `.gitignore` additions (proposed, **not applied** by this audit)

```
# local review / dev state and duplicated trees
corner-cup-transfer/
.review-state/
.state-ui/
tmp-ui/
.local-logs/
.f07-pbkdf2/
.script/
.pbkdf2-bench/
.tgz*
screenshots/
ui-audit/
screenshot-*.png
```

Rationale: `*.sqlite*` and `*.log` already hide the *contents* of the state directories, but not the directories'
future non-SQLite contents, and nothing at all hides `corner-cup-transfer/`, `.script/`, `.tgz*` or the screenshot
folders. Adding these is a one-line-per-item change with no effect on the app.

### 7.4 Files to include and exclude

See §5.1–5.4. Short version: **include** all `worker/`, `src/`, `public/`, `tests/`, `scripts/`, the three config
files, both lockfile-bearing `package*.json`, `.gitignore`, `.dev.vars.example`, `README.md` and the report set;
**exclude** `corner-cup-transfer/`, every local database directory, all logs/scratch archives, all screenshots and
every generated bundle.

### 7.5 Branch protection for `main`

| Setting | Recommended |
| --- | --- |
| Require a pull request before merging | **On**, 1 approval (raise to 2 when a second maintainer exists) |
| Dismiss stale approvals on new commits | On |
| Require review from Code Owners | Later, once a `CODEOWNERS` exists — this is the control that protects the future image-processing workflow (Stage 3H §3.2 B6) |
| Require status checks | Build + test once a workflow exists; until then, review-only |
| Require conversation resolution | On |
| Require linear history | On (this history is linear already) |
| Allow force pushes / deletions | **Off** |
| Include administrators | On — otherwise the protection is advisory for the owner |
| Require signed commits | Optional; do not block on it |

### 7.6 GitHub Actions permissions (minimum for this repository)

| Setting | Value | Why |
| --- | --- | --- |
| Default workflow permissions | **Read repository contents** | The app needs no write token |
| Allow GitHub Actions to create/approve PRs | **Off** | Removes an escalation path |
| Allow actions from | **Only verified creators / selected actions**, or none | Supply-chain hygiene |
| `GITHUB_TOKEN` write scopes in any workflow | none | No release/deploy workflow exists |
| Repository secrets | none yet | `.dev.vars` is local; deployments go through Freebuff Sites |
| Environments | none required | Add `production` with required reviewers if a deploy workflow is ever added |
| `id-token: write` | not granted by default | Only the future image workflow in Stage 3H should request it, scoped to that job |

Optional, worth doing at creation time: commit under a project identity (`Corner Cup <dev@…>`) rather than a
personal Gmail, so the address in every future commit matches the project, and decide whether the 7 existing
commits keep theirs.

---

## 8. Blocking issues

| # | Issue | Severity | Why it blocks | Resolution |
| --- | --- | --- | --- | --- |
| **B1** | **`HEAD` is not a buildable snapshot.** 10 `worker/` modules, 3 `src/lib/` modules, `public/` (9 assets) and `tests/setup/` exist only as untracked files. | **Blocking** | A commit of the current index would publish a repository whose Worker cannot bundle and whose test command cannot start. | Snapshot the **worktree** (§7.2), never `git add -A` on the index as it stands. |
| **B2** | **`corner-cup-transfer/` is a full duplicate project with its own `.dev.vars` and `.razorpay-key-id.txt`**, 62 addable files. | **Blocking** | A single careless `git add -A` publishes a second copy of the app plus its credential folder. | Exclude it (§5.3); add it to `.gitignore` (§7.3); delete it after the push if it is stale. |
| **B3** | **Three local D1 databases** (`.review-state/`, `.state-ui/`, `tmp-ui/`) hold café data, password hashes and session rows. | High | Only `*.sqlite*` hides them; the directories are not ignored, so any future non-SQLite file there is committed. | Add the directories to `.gitignore`; delete them after the last local review. |
| **B4** | **`.dev.vars` with `ADMIN_SECRET` and `RAZORPAY_KEY_SECRET` sits at the repo root** (ignored, but one `--no-verify` or folder copy away). | High | A committed session-signing key invalidates every session assumption in the auth design. | Keep it ignored; rotate before the repository goes live if it ever left the machine. |
| **B5** | **No CI workflow exists**, yet branch protection should require status checks. | Medium | Enabling "require status checks" with no workflow makes `main` unmergeable. | Start with review-only protection; add a build+test workflow, then require it. |
| **B6** | **267 files are addable, 55 of them screenshots and 62 a duplicate tree.** | Medium | The manifest, not `git add -A`, has to drive the first commit. | Use §5.1/§5.2 as the allowlist and verify counts before committing. |
| **B7** | **Personal email in all 7 commits**; production URLs already in `site.json`. | Low | Permanent, public metadata once pushed (private repo mitigates). | Decide before the first push; rewriting is not required. |
| **B8** | **No `engines.node`.** Verified on Node 26 only. | Low | A CI runner on an older Node may fail `--import`/`node --test` semantics. | Pin the version in `package.json` and in CI when the workflow is added. |

**Nothing in this list requires a history rewrite or a secret rotation to proceed.** B1–B2 are the two that turn a
routine first push into a leak or a broken repository, and both are avoided by snapshotting an explicit allowlist.

---

## 9. Boundaries respected

- No `git add`, commit, push, reset, clean, checkout, switch, rebase, stash, tag or remote change; the index and
  every working-tree file are exactly as found (157 status entries before and after: the 156 pre-existing plus the
  Stage 3H report).
- No source, configuration, test or `.gitignore` edit; no dependency installed; no file deleted.
- `npm test` and a build to a **temp** output directory were run to verify reproducibility; neither wrote into the
  repository (`dist/`, `sites-build/` and the index are unchanged).
- No GitHub repository, App, token, secret, workflow or remote created; no deployment, no production or staging
  access.
- No secret value is printed in this report: findings name paths, key **names**, lengths, modes and SHA-256
  prefixes only.
