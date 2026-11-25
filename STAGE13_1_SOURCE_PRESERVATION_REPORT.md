# STAGE 13.1 — Source Preservation Report

**Date:** 2026-11-20
**Mode:** preservation only. No repository file was modified, renamed, moved or deleted. No `git add`,
`commit`, `reset`, `checkout`, `clean` or `restore` was run. Nothing was staged.
**Purpose:** guarantee that the entire working state — including the eleven untracked modules the application
imports — survives independently of this machine's Git state, before any further investigation.

---

## 1. Verdict

**PRESERVATION COMPLETE AND VERIFIED.**

| Check | Result |
|---|---|
| Files captured | **228 of 228 listed** (no extras, no omissions) |
| Bytes captured | **3,246,477** |
| SHA-256 per file | **228/228 match the live working tree** (0 mismatches, 0 size mismatches) |
| Manifest integrity | `MANIFEST.sha256` SHA-256 `c23a7e076616580378bc738b74dca6fb402a01d8f81d53c906bff994a0de00d5` |
| Single-archive copy | `worktree.tar`, 3,430,400 bytes |
| Tracked files | **45 of 45** present (working-tree contents, i.e. including the 27 modifications) |
| Untracked files | **175 of 177** present (2 deliberate exclusions, §6) |
| Gitignored build artifacts | 8 present (`sites-build/` 2, `dist/` 6) |
| Critical modules | **12 of 12** present and hash-verified (§7) |
| Git history | `corner-cup-repo.bundle`, 149,393 bytes, all refs |
| Previous backups | untouched; this is a new timestamped directory, nothing overwritten |

## 2. Git state at capture

Captured at `2026-11-20T11:48:28Z` and stored verbatim in the backup (`GIT_STATE.txt`,
`git-status-porcelain.txt`, `git-diff-stat.txt`, `git-staged-stat.txt`, `git-log.txt`, `FS_TIMESTAMPS.txt`).

| Field | Value |
|---|---|
| Branch | `freebuff/qr-code-cafe-ordering-website` |
| HEAD commit | `023befea5b337f8daa783ac7b7fd323bd8dffac8` |
| HEAD date / subject | 2026-11-12 14:45:24 +0530 · "Add versioned owner sessions with an operator-driven password reset" |
| Tracked files | 45 |
| Modified tracked files | 27 |
| Untracked entries (collapsed) | 98 |
| Untracked files (expanded) | 177 |
| Staged files | **0** |
| Remote configured | none (`git remote -v` empty) |

**The 27 modified tracked files**

```
README.md                              package.json                 src/pages/Menu.jsx
index.html                             package-lock.json            src/pages/Operator.jsx
src/components/CartSheet.jsx           src/pages/Admin.jsx          src/pages/OrderStatus.jsx
src/components/PaymentPanel.jsx        src/lib/api.js               src/styles.css
src/lib/config.js                      tests/harness/worker.mjs     tests/harness/wrangler.auth.jsonc
tests/harness/wrangler.jsonc           tests/migrations.test.mjs    tests/orders.integration.test.mjs
tests/password.reset.test.mjs          tests/status.transitions.test.mjs
worker/api.js                          worker/cafes.js              worker/db.js
worker/http.js                         worker/index.js              worker/orders.js
wrangler.jsonc
```

Per-file modification times and sizes for every tracked file are in `FS_TIMESTAMPS.txt`; the full porcelain
status is in `git-status-porcelain.txt`.

## 3. Backup location and layout

```
C:\Users\rahil\corner-cup-backups\stage13-1-20261120T114817Z\
  worktree\                     228 files, paths preserved exactly (repository-relative)
  worktree.tar                  3,430,400 bytes — the same tree as one archive
  MANIFEST.sha256               <sha256>  <relative path>   × 228
  filelist.txt                  the exact list of 228 paths captured
  EXCLUSIONS.txt                what was left out and why (no excluded file was read)
  GIT_STATE.txt                 branch, HEAD, counts, remote
  git-status-porcelain.txt      full status (27 modified, 98 untracked entries, 0 staged)
  git-diff-stat.txt             per-file diffstat of the 27 modifications
  git-staged-stat.txt           empty (nothing staged)
  git-log.txt                   last 12 commits
  FS_TIMESTAMPS.txt             mtime/size for each tracked file
  corner-cup-repo.bundle        complete Git history (all refs) via `git bundle create --all`
  evidence\                     Stage 13.1 production-exposure evidence (separate report)
  verify.mjs                    the verification script used below (reproducible check)
```

`worktree/` alone is a complete, directly usable copy: it can be compared, diffed, zipped or copied onto
another machine without needing Git. `corner-cup-repo.bundle` restores the history side
(`git clone corner-cup-repo.bundle`), and the two together reconstruct the repository plus all uncommitted work.

## 4. What the 228 files comprise

| Category | Count | Notes |
|---|---:|---|
| Tracked files at their current on-disk content | 45 | Includes all 27 modifications; this is the working tree, not HEAD |
| Untracked, non-ignored files | 175 | Application source, tests, documentation, transfer copies, helper scripts |
| Gitignored build artifacts included deliberately | 8 | `sites-build/index.js`, `sites-build/README.md`, `dist/` (6 files) |
| **Total** | **228** | |

Included because they matter for recovery or for the exposure investigation:

- **All eleven untracked application modules** plus `src/lib/payments.js` and `src/lib/menuScope.js` (§7).
- `sites-build/index.js` (99,986 bytes) — the historical build artifact whose provenance Stage 13 questioned.
- `dist/` — the last local Vite build (6 files, ~427 KB), useful for bundle comparison.
- `corner-cup-transfer/` (65 files) — the earlier transfer bundle, including its own copies of
  `worker/passwords.js` and `worker/tracking.js`.
- `staging-migrations*.sql`, `scripts/*.mjs`, `.staging-maint/index.js`, `wrangler.staging*.jsonc` — the staging
  and rollback configuration, needed to rebuild an environment.
- All Stage 3–13 reports, including `STAGE13_PRODUCTION_READINESS_AUDIT.md`.

## 5. Verification method and result

`verify.mjs` (preserved in the backup) performs, for every path in `filelist.txt`:

1. `statSync` on the live file and the preserved copy → **size equality**;
2. SHA-256 of both → **hash equality**;
3. writes `MANIFEST.sha256` from the live hashes;
4. walks the preserved tree and reports any file **not** in the list (extras);
5. re-hashes the twelve critical modules and asserts presence.

Output:

```
files listed:      228
files in backup:   228
extra in backup:   0
total bytes:       3246477
manifest lines:    228
manifest sha256:   c23a7e076616580378bc738b74dca6fb402a01d8f81d53c906bff994a0de00d5
problems:          0
RESULT: VERIFIED
```

Independent re-check of the three counts that matter: tracked `45/45`, untracked `175/177`, gitignored extras
`8`. The only two untracked omissions are the two documented exclusions in §6.

## 6. Exclusions (recorded; contents never read)

| Excluded | Reason |
|---|---|
| `.dev.vars` (root) | Local development secrets. Excluded by exact-name rule; **never opened, never copied, never hashed**. |
| `.env`, `.env.*` | None present; excluded by rule. |
| `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `.razorpay-key-id.txt`, `.admin-secret.txt`, `.operator-password.txt` | No such file present as a tracked/untracked entry; excluded by rule. |
| `.qa-logs/audit.json` | Transient local run log (~2.5 MB of logs in that directory overall). Not source or work product; may contain request paths. |
| `.script/.argon2id-restore/argon2id.tgz` | Third-party npm package archive; restorable from the registry. |
| `.wrangler/` | Local Wrangler state, which includes a Stage 12 disposable copy of staging data (hashed credentials). Sensitive and reproducible. |
| `node_modules/` | Reproducible with `npm ci` from the preserved `package-lock.json`. |
| `.git/` internals | Replaced by `corner-cup-repo.bundle`, which restores history exactly. |

**Included on purpose:** `.dev.vars.example` (tracked) and
`corner-cup-transfer/project/.dev.vars.example` (untracked). Both are templates containing empty
placeholders only — no values — and they are part of the reproducible state. An initial over-broad filter
excluded them; the backup was rebuilt so that **45/45 tracked files** are present.

## 7. The twelve critical modules

All present and hash-verified. The first ten are untracked in Git, which is why this backup exists.

| File | Bytes | SHA-256 (first 16) | Tracked in Git? |
|---|---:|---|---|
| `worker/passwords.js` | 7,539 | `5de52a5a55ae76c0` | **No** |
| `worker/session.js` | 18,217 | `fac4ea80adb9b3a9` | **No** |
| `worker/tracking.js` | 3,356 | `112237e08aa2e948` | **No** |
| `worker/orderids.js` | 3,060 | `09187063a9dc4db2` | **No** |
| `worker/owner.js` | 20,370 | `a68968ce9c406af5` | **No** |
| `worker/workos.js` | 7,748 | `9bf3fa6602d4e27b` | **No** |
| `worker/jwt.js` | 7,199 | `70c0b72441c60f39` | **No** |
| `worker/pkce.js` | 4,401 | `1bf79a573051b364` | **No** |
| `worker/revocations.js` | 5,567 | `bf5bcb229f0e47ec` | **No** |
| `worker/authmode.js` | 7,192 | `336ec1e776178b62` | **No** |
| `src/lib/payments.js` | 1,904 | `fd4ec1784eb7877e` | **No** |
| `src/lib/menuScope.js` | 905 | `e332d8959a3aeb3d` | **No** |

Cross-check: `worker/passwords.js` `5de52a5a…` and `worker/tracking.js` `112237e0…` match the hashes recorded
independently in `SECURITY_STATUS.md` §9 on 2026-11-15, so these files have not drifted since that checkpoint.

## 8. Why this matters (and what it does not fix)

`worker/api.js` imports these modules at the top of the file. A fresh `git clone` of
`023befea5b33…` therefore **cannot build**: `npm run build` fails on unresolved imports, and the Worker cannot
be bundled. The preserved state is now the only complete copy of the running application.

What this report guarantees:

- every byte of current work exists in two forms (directory + tar) outside the repository, with a per-file
  manifest;
- the eleven (twelve, counting both `src/lib` files) modules Stage 13 identified as untracked are captured;
- the historical `sites-build/index.js` and the local `dist/` bundle are preserved as forensic evidence for
  the exposure investigation;
- nothing was altered in place, so the working tree is exactly as it was before this stage.

What it does **not** do: it is not a Git commit. Until these files are staged and committed, `git clean -fdx`
or a lost laptop still destroys the only working copy — the backup only covers the second case. Committing them
is remediation (Stage 13.1 plan item R-2) and was deliberately not performed here.
