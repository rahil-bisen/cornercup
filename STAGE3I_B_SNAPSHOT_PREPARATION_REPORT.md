# Stage 3I-B — Clean Private Repository Snapshot

**Status: complete and validated.** A 173-file, 3.1 MB source snapshot of the full Corner Cup application was
built in a temporary directory outside the working tree, then installed, tested, built and config-checked **inside
that snapshot**: 475/475 tests pass, the production build reproduces the source build byte-for-byte, and
`wrangler deploy --dry-run` validates the Worker and its bindings with no credentials and no remote access.

Nothing in the original working tree was modified, nothing was deleted anywhere, and the only file added to the
project is this report. No `git add`, commit, push, reset, clean, checkout or rebase was run; no remote, repository,
token, secret or deployment was created.

---

## 1. Snapshot location

| Item | Value |
| --- | --- |
| Path | `C:\Users\rahil\AppData\Local\Temp\corner-cup-snapshot` |
| Outside the working tree | **Yes** — separate directory, sibling to the Temp PoCs, not inside the project |
| Source | `C:\Users\rahil\.freebuff\worktrees\0db48f77\…\` (read-only reads) |
| Builder | `C:\Users\rahil\AppData\Local\Temp\stage3i-b\make_snapshot.py` (explicit allowlist + deny rules) |
| Files | **173** (source; excludes `node_modules/` 244 MB and built `dist/` 12 files) |
| Size | **3.1 MB** source, **3.3 MB** including the built `dist/` |
| Git metadata | none — the directory is plain files, not a repository |

The builder never walks the tree blindly: it copies a fixed root list, every root-level `*.md`, and the five source
directories, and it **refuses** any path whose name or extension matches a deny rule. A mistake in the allowlist
therefore fails closed instead of leaking a credential.

---

## 2. Inclusion rules actually applied

**Root files (10):** `package.json`, `package-lock.json`, `wrangler.jsonc`, `vite.config.js`, `index.html`,
`.gitignore`, `.dev.vars.example`, `README.md`, `sites.manifest.json`, `site.json`.

**Root documentation:** every `*.md` at the repository root (55 files) — architecture, security, operational and
stage reports, from `README.md` through `STAGE3I_A_REPOSITORY_HYGIENE_REPORT.md`.

**Source directories (5):** `worker/`, `src/`, `public/`, `scripts/`, `tests/`.

**Deny rules** (directory names, exact filenames, and suffixes): `.git`, `node_modules`, `dist`, `sites-build`,
`.tools`, `.wrangler`, `.freebuff`, `__pycache__`, `screenshots`, `ui-audit`, `tmp-ui`, `.review-state`, `.state-ui`,
`.local-logs`, `.qa-logs`, `.script`, `.pbkdf2-bench`, `.staging-maint`, `.f07-pbkdf2`, `corner-cup-transfer`,
`audit-package`; filenames `.dev.vars`, `.env*`, `.razorpay-key-id.txt`, `.razorpay-key-secret.txt`,
`.admin-secret.txt`, `.operator-password.txt`; suffixes `.sqlite*`, `.log`, `.zip`, `.tgz`, `.sql`, `.pem`, `.key`,
`.p12`, `.pfx`, `.crt`.

---

## 3. Included file manifest

| Area | Files | Size | Contents |
| --- | --- | --- | --- |
| `worker/` | **16** | 305 KB | `api.js`, `db.js`, `index.js`, `http.js`, `cafes.js`, `orders.js`, `session.js`, `owner.js`, `authmode.js`, `jwt.js`, `passwords.js`, `pkce.js`, `revocations.js`, `tracking.js`, `orderids.js`, `workos.js` — the complete Worker, including the 10 modules that exist only in the working tree |
| `src/` | **20** | 256 KB | 8 `lib/*.js` (incl. `menuImages.js`, `menuScope.js`, `payments.js`), 6 pages, 4 components, `main.jsx`, `styles.css` |
| `public/` | **9** | 592 KB | 6 default menu photographs, 2 self-hosted WOFF2 fonts, `OFL.txt` |
| `tests/` | **59** | 754 KB | **50** `*.test.mjs` suites, `setup/` (2: `register.mjs`, `argon2id-wasm-hooks.mjs`), `harness/` (4: `worker.mjs`, `credentials.mjs`, `wrangler.jsonc`, `wrangler.auth.jsonc`), `lib/db.mjs`, `fixtures/workos.mjs`, `gate2-measure.mjs` |
| `scripts/` | **5** | 24 KB | staging migration generators and runner |
| Root config/manifest | **9** | ~103 KB | `package.json`, `package-lock.json` (the full lockfile), `wrangler.jsonc`, `vite.config.js`, `index.html`, `.gitignore`, `.dev.vars.example`, `sites.manifest.json`, `site.json` |
| Root documentation | **55** | 1,020 KB | All root `*.md` reports |
| **Total** | **173** | **3.1 MB** | |

Required-module verification (all present, none truncated):

```
worker:  16 / 16    src/lib: 8 / 8    public: 9 / 9    scripts: 5 / 5
tests/setup/register.mjs            present
tests/setup/argon2id-wasm-hooks.mjs present
tests/harness/worker.mjs            present
tests/lib/db.mjs                    present
tests/fixtures/workos.mjs           present
.github/                            absent (no workflow existed in the source)
```

The count was verified twice, independently: the builder reported what it copied, and a second pass re-walked the
source with the same rules and diffed the result against the snapshot —

```
expected: 173   actual: 173
MISSING from snapshot: none
EXTRA in snapshot: none
```

`.dev.vars.example` is the only environment file in the snapshot, and all nine secret-class keys in it are **empty**
(`ADMIN_SECRET=`, `OWNER_PASSWORD=`, `OPERATOR_PASSWORD=`, `RAZORPAY_KEY_ID=`, `RAZORPAY_KEY_SECRET=`,
`RAZORPAY_WEBHOOK_SECRET=`, `TELEGRAM_BOT_TOKEN=`, `ADMIN_PIN=`, `TELEGRAM_OWNER_CHAT_ID=`). The only non-empty
values are the three documented non-secret defaults (`CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN`).

---

## 4. Excluded file manifest

Every exclusion below was verified by scanning the finished snapshot for the same paths **after** the copy
(`.dev.vars`, `.env`, `.wrangler`, `corner-cup-transfer`, `tests/harness/.wrangler`, `.review-state`, `.state-ui`,
`.razorpay-key-id.txt` → all **absent**), and by a content scan for `*.sqlite*`, `*.sql`, `*.zip`, `*.log`, `*.pem`,
`*.key` anywhere in the snapshot → **no matches**.

| Excluded path | Files | Size | Reason |
| --- | --- | --- | --- |
| `.dev.vars` | 1 | 1 KB | **Populated credentials**: owner/operator passwords, `ADMIN_SECRET` session key, Razorpay key id + secret |
| `.razorpay-key-id.txt` | 1 | 1 KB | Test-mode payment key id (identifier, still excluded) |
| `corner-cup-transfer/` | **65** | 868 KB | Duplicate, stale copy of the whole project — including its **own** `.dev.vars` and key-id file |
| `.wrangler/` | 1,049 | **387 MB** | Wrangler/Miniflare state, logs and bundled dev builds |
| `tests/harness/.wrangler/` | 53 | **228 MB** | Miniflare state from harness runs |
| `tests/harness/.state-a2/` | 22 | **221 MB** | Local D1/cache/KV/R2 SQLite state |
| `tests/harness/.state-p2/` | 22 | 5.1 MB | Same, second profile |
| `tests/harness/.state-plain/`, `.state-stage14/` | — | — | Same family; every file inside matched a deny rule (0 copied) |
| `.review-state/` | 22 | 4.3 MB | **Local D1 database**: café data, password hashes, live session rows |
| `.state-ui/` | 22 | 584 KB | Same, UI review profile |
| `tmp-ui/` | 22 | 4.1 MB | Same, temp profile |
| `.local-logs/` | 5 | 72 KB | Test/build logs |
| `.qa-logs/` | 28 | 3.2 MB | QA logs and evidence JSON |
| `.script/` | 10 | 74 KB | Scratch evaluation scripts |
| `.pbkdf2-bench/`, `.f07-pbkdf2/`, `.staging-maint/` | 3 | 10 KB | Benchmarks and a one-off maintenance worker |
| `.tgz2`, `.tgz3` | 2 | 17 KB | Temporary archives (JSON + gzip) |
| `screenshots/`, `ui-audit/`, `screenshot-landing.png` | 56 | 5.8 MB | Generated review artefacts |
| `audit-package/` | 102 | 1.4 MB | Generated audit export (contains its own copy of the tree) |
| `corner-cup-source.zip`, `corner-cup-audit-package.zip`, `corner-cup-transfer.zip` | 3 | **4.0 GB** | Backup archives |
| `staging-migrations*.sql` (3) | 3 | 23 KB | Backup/schema SQL exports (0 rows, but excluded per the brief) |
| `wrangler.staging.jsonc`, `wrangler.staging-maint.jsonc` | 2 | — | Staging configs carrying a real D1 `database_id`; not required to build or test (see §7) |
| `start-auth-harness.ps1` | 1 | — | Local harness launcher, Windows-only convenience |
| `dist/` (source copy), `sites-build/`, `.tools/` | 12 + 2 + 2,034 | 1 MB + 101 KB + 100 MB | Build output and the portable Node toolchain |
| `node_modules/` | — | ~1.0 GB | Reinstalled in the snapshot from the lockfile instead of copied |
| `.git/` | — | — | Git metadata is intentionally absent |

**Total excluded: roughly 5.7 GB across ~3,400 files**, of which 4.0 GB is the ZIP set and 836 MB is Miniflare
state. Nothing was deleted from the source; every exclusion is a copy decision.

---

## 5. Secret scan results

Three independent checks were run **against the snapshot**, not the source.

### 5.1 Exact-value scan (the decisive one)

Every non-empty secret-class value was read from the source `.dev.vars` and the Razorpay key-id file and searched
for, byte-for-byte, in all 173 snapshot files. Values were never printed.

| Credential | Matches in snapshot |
| --- | --- |
| `OWNER_PASSWORD` | **0** |
| `ADMIN_SECRET` | **0** |
| `RAZORPAY_KEY_ID` | **0** |
| `RAZORPAY_KEY_SECRET` | not checked by value: the local entry is a placeholder shorter than the scan threshold. The snapshot contains no `RAZORPAY_KEY_SECRET` assignment with a value at all. |
| `.razorpay-key-id.txt` content | **0** |
| `OPERATOR_PASSWORD` | **7** — see below |

**The one hit is benign and predates this snapshot.** The local dev operator password is the *same literal* the
test suite already uses as its fixture (`tests/body.limit.test.mjs`, `operator.owner-routes.test.mjs`,
`operator.revocation.test.mjs`, `password.reset.test.mjs`, `rate.limit.test.mjs`, `session.revocation.test.mjs`, and
`tests/harness/wrangler.auth.jsonc`). Those files were already tracked in `HEAD`, so the value is public in the
repository's own history; the snapshot leaks nothing new. It does mean the **local** operator password equals a
test fixture — worth changing in `.dev.vars` and never reusing as a real credential, and recorded here rather than
silently ignored.

### 5.2 Pattern scan (paths only, no values)

| Pattern | Result |
| --- | --- |
| `rzp_live_` | 0 code hits (one prose mention inside the Stage 3I-A report, describing the *absence* of live keys) |
| `rzp_test_` (≥8 chars after prefix) | **0** — the only key ids present are short fixture placeholders (12/16 characters, and one 13-character placeholder shared with the local dev file) that are not real-format keys |
| `BEGIN … PRIVATE KEY` | 0 |
| `ADMIN_SECRET=`, `RAZORPAY_KEY_SECRET=`, `OPERATOR_PASSWORD=`, `OWNER_PASSWORD=`, `WORKOS_API_KEY=`, `TELEGRAM_BOT_TOKEN=` **with a value** | 0 real values (the matches are empty assignments in `.dev.vars.example`, or quoted prose in the Stage 3I-A report) |
| `ghp_…`, `github_pat_…`, `AKIA…` | 0 |

### 5.3 Structural scan

| Check | Result |
| --- | --- |
| Any `*.sqlite*` in the snapshot | **none** |
| Any `.sql`, `.zip`, `.log`, `.pem`, `.key`, `.p12`, `.pfx`, `.crt` | **none** |
| Any `tests/harness/.state-*` or `tests/harness/.wrangler` | **none** |
| `.dev.vars` / `.env*` files | **none** (only `.dev.vars.example`, all secret keys empty) |
| Local database *records* | none possible — no SQLite file exists in the snapshot |

---

## 6. Validation, run inside the snapshot

All four commands ran in `C:\Users\rahil\AppData\Local\Temp\corner-cup-snapshot` with no access to the original
tree, no credentials and no remote.

| # | Command | Result |
| --- | --- | --- |
| 1 | `npm ci --no-audit --no-fund` | **exit 0.** 244 MB `node_modules` from the committed lockfile; `argon2id` and its wasm present. npm printed an informational `install-scripts` notice for `esbuild`/`workerd` (npm 11 does not auto-run them) — neither was needed: the build and the full suite worked, because the platform binaries arrive via the optional packages. |
| 2 | `npm run build` | **exit 0.** 105 modules transformed, 1.95 s. `dist/index.html` 0.81 kB, `assets/index-B_nBG-g5.css` 33.10 kB, `assets/index-CIYopyjw.js` **287.11 kB** (gzip 92.71 kB) — **identical hashes and sizes to the build in the working tree**, so the snapshot is content-identical where it matters. |
| 3 | `npm test` | **exit 0. 475 tests, 475 pass, 0 fail, 0 skipped, 0 cancelled**, 112.0 s (2.0 s faster than in the working tree). Includes the argon2id wasm hook, the WorkOS/JWT suites and the 50 HTTP suites against the in-memory harness. |
| 4 | `npx wrangler deploy --dry-run --outdir <temp>` | **exit 0** with wrangler 4.158.0. Read **15 files from `dist/`**, total upload 237.21 KiB (gzip 54.76 KiB), and resolved the bindings: `env.DB` (D1 `corner-cup`), `env.ASSETS`, plus the three configured vars (`CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN`). No account, credentials or network call required. |

`wrangler dev` was **not** started (it would bind a port and is unnecessary: the dry-run already proves the Worker
bundles with its wasm rule, and the 50 HTTP suites exercise the same code through the harness).

---

## 7. Comparison against the Stage 3I-A manifest, and deviations

| 3I-A recommendation | This snapshot | Note |
| --- | --- | --- |
| Include all 16 `worker/*.js` | **16** | ✓ |
| Include all `src/**` incl. 3 untracked `lib` modules | **20 files, 8 `lib`** | ✓ |
| Include `public/**` (9) | **9** | ✓ |
| Include `tests/**` minus `harness/.wrangler` | **59 files, 50 suites** | ✓ (+2 more harness state dirs excluded than 3I-A listed: `.state-a2`, `.state-p2`, `.state-plain`, `.state-stage14`) |
| Include `scripts/*.mjs` (5) | **5** | ✓ |
| Include `package.json` **and** `package-lock.json` | both | ✓ |
| Include `wrangler.jsonc`, `sites.manifest.json`, `.gitignore`, `.dev.vars.example`, `README.md` | all | ✓ |
| Include 54 root reports | **55** | ✓ (+ the 3I-A report itself, now that it exists) |
| Exclude `.dev.vars`, local DBs, `corner-cup-transfer/`, harness state, archives, screenshots, scratch, generated bundles | all excluded | ✓ |
| `wrangler.staging*.jsonc` — "only if the `database_id` is acceptable" | **excluded** | Deliberate: they are not needed to build or test, and they carry a real staging D1 id. Restore from the working tree when staging operations are needed. |
| `staging-migrations*.sql` — optional | **excluded** | The brief lists backup SQL as excluded; the schema is reproducible from `worker/db.js`. |
| `start-auth-harness.ps1` — dev convenience | **excluded** | Windows-only launcher; the test suite does not use it. |
| Screenshots / QA evidence — exclude from the initial snapshot | **excluded** | 56 files, 5.8 MB, retained in the working tree. |

---

## 8. Unresolved dependencies and caveats

1. **`IMAGES` (R2) binding is still not configured.** The Worker expects it, so photo upload/read answer `503`
   until provisioned. The dry-run confirms it is *absent by configuration*, not by defect; this matches Stage 3B/3F
   and is not introduced by the snapshot.
2. **`wrangler.jsonc` carries a placeholder `database_id`** (`00000000-…`). Local `wrangler dev` uses its own D1;
   a real deployment needs the id filled in locally. Nothing to fix for the snapshot.
3. **No `engines` field** in `package.json`. Validated on Node **26.13.1** / npm **11.20.0** only. A CI runner on an
   older Node should be pinned explicitly in a future workflow (carried over from 3I-A B8).
4. **No `.github/` directory and therefore no workflow.** Branch protection cannot require status checks until a
   build+test workflow exists; this is the B5 item from 3I-A, unchanged and out of scope here.
5. **`tests/harness/.state-*` will be recreated** on the first harness run inside the snapshot; the snapshot's
   `.gitignore` already ignores `*.sqlite*` and `*.log`, and the recommended additions from 3I-A §7.3 (which would
   also cover the state directory names) were **not** applied — no file was modified.
6. **Validation left three ignored directories in the snapshot** — `node_modules/` (244 MB), `dist/`
   (12 files) and `.wrangler/` (from the dry-run). All three match the snapshot's own `.gitignore`, so they cannot
   be committed; they exist only because the validation commands ran in place.
7. **Install scripts are not auto-approved by npm 11.** `npm ci` succeeded without them; if a future dependency
   needs a postinstall step, CI must approve it explicitly (`npm install-scripts approve <pkg>`).
8. **The snapshot is not a repository.** It has no `.git`, no remote, no commits — publication is Stage 3I-C's
   decision, not this stage's.

None of the above prevents the snapshot from being committed as-is: it builds, tests and validates.

---

## 9. Boundaries respected

- **Original working tree untouched:** no existing file was written, renamed or deleted. `git status` reports
  159 entries — the 156 pre-existing plus the Stage 3H, 3I-A and (this) 3I-B reports — and `git diff --stat` is
  unchanged at 27 files / +5,871 / −1,048. The index is empty; there are still 0 remotes.
- No `git add`, commit, push, reset, clean, checkout, switch, rebase or stash; no remote, repository, App, token,
  secret or workflow created; no deployment and no production/staging access.
- The only file added to the project is this report. Everything else lives under `%TEMP%`.
- **No secret value appears in this report:** findings name paths, key names, counts and modes only. The single
  exact-value match is described by file and key name, not by value.
- Nothing was deleted: the snapshot is additive, and its validation wrote only inside itself (`node_modules/`,
  `dist/`, harness state) plus a build output directory under `%TEMP%`.
