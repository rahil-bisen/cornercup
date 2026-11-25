# Stage 3I-F — Final Redaction and Verification Report

**Project:** Corner Cup (`corner-cup-qr-ordering`)
**Stage:** 3I-F — final publication cleanup of the 167-file publication set
**Date:** 2026-11-21
**Mode:** copy → redact → verify (read-only with respect to the worktree, the source snapshot and the earlier snapshot)
**Deliverable:** this report only

---

## 1. Executive verdict

**PASS.**

The final publication snapshot at `C:\Users\rahil\AppData\Local\Temp\corner-cup-publication-final` is ready to be committed to a private GitHub repository as a 167-file initial import.

- The condition carried out of Stage 3I-E (**C1**) is closed: the account-specific staging hostname is gone from all six files, replaced by `[DEPLOYMENT_URL]` with the surrounding prose, tables and command examples left readable.
- The independent full-snapshot scan found **one further account-specific identifier the earlier reviews missed** — a real Cloudflare D1 database id, present in full in three generator scripts and in truncated form in two reports. It has been redacted with `[D1_DATABASE_ID]` and is reported as **F2** below.
- Total redaction: **12 placeholder substitutions across 10 files**. The other **157 files are byte-identical to the source snapshot**.
- No credentials, populated environment files, private keys, access tokens or realistic secrets exist anywhere in the set. The only environment file is `.dev.vars.example`, whose nine secret keys are all empty.
- Counts, sizes, duplicate-hash check, `.gitignore` coverage and a simulated `git add -n` all confirm the set stages exactly 167 files and nothing else.

Nothing blocks creating the private repository. Residual items in §5 are privacy polish and pre-deployment work, not publication blockers (§9).

---

## 2. Copy integrity verification

**Destination precondition.** `C:\Users\rahil\AppData\Local\Temp\corner-cup-publication-final` did **not** exist when the stage began (existence test returned `NOT_EXISTS`). It was created empty by this stage; nothing was overwritten.

**Copy.** The 167-file source snapshot was copied with a byte-preserving archive pipeline (no line-ending or attribute translation) into the new destination. No exclusions were needed: the source snapshot contains no `dist/`, `node_modules/`, `.wrangler/`, `.git/` or harness state to leave behind.

**Verification against the source manifest** — the SHA-256 manifest recorded in `STAGE3I_D_PUBLICATION_PREPARATION_REPORT.md` Appendix B, before any edit:

| Check | Result |
|---|---|
| Expected file count | 167 |
| Files present in destination | 167 |
| File-set difference vs source (both directions) | 0 missing, 0 unexpected |
| SHA-256 match against Appendix B manifest | **167 / 167**, 0 mismatch |

**Source snapshot untouched.** Re-verified at the end of the stage: 167 files on disk, 167/167 still matching the Appendix B manifest. The earlier 173-file `corner-cup-snapshot` and the worktree were not opened for writing.

---

## 3. Six-file redaction table

### 3.1 C1 — deployment hostname (required condition from Stage 3I-E)

The account-specific staging hostname (`<worker>.<account-subdomain>.workers.dev`) was replaced with `[DEPLOYMENT_URL]`. The full URL form was replaced, so no scheme-qualified or bare occurrence of the account subdomain survives.

| # | File | Replacements | Where | Reads correctly after edit |
|---|---|---|---|---|
| 1 | `DISASTER_RECOVERY_RUNBOOK.md` | 1 | URL-discipline paragraph (L159) | Yes — "…is `[DEPLOYMENT_URL]`. A different name is a different site and breaks the…" |
| 2 | `STAGE12_CONFIGURATION_RECOVERY.md` | 1 | Operator URL block (L93) | Yes — the URL stands alone as before, now generic |
| 3 | `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` | 1 | Routes/custom-domains table row (L77) | Yes — "`workers.dev` only: `[DEPLOYMENT_URL]`" |
| 4 | `STAGE3_DEPLOYMENT_PREFLIGHT.md` | 1 | Preflight summary table, `URL` row (L13) | Yes |
| 5 | `STAGE6_STAGING_DEPLOYMENT.md` | 1 | Deployment record bullet (L7) | Yes — "Worker `corner-cup-staging`, URL `[DEPLOYMENT_URL]`" |
| 6 | `STAGE8A_OPERATOR_AUTH_PREP.md` | 2 | `B=` and `O=` shell variables on one line (L50) | Yes — both variables keep their role |
| | **Total** | **7** | | |

Per-file checks performed: the account subdomain token is absent from all six files (0 occurrences), `[DEPLOYMENT_URL]` is present at each edited site, the line-level context was read back, and no section, table row or code block was removed. No other file in the snapshot contained the hostname, so no seventh file needed editing.

### 3.2 F2 — Cloudflare D1 database id (new finding, missed by 3I-E)

The scan required by §4 surfaced a real staging D1 database id (UUID form) in three staging SQL generator scripts, and its truncated prefix in two reports. This is an account-specific Cloudflare resource identifier, so it was redacted with `[D1_DATABASE_ID]`.

| # | File | Replacements | Form found | Where |
|---|---|---|---|---|
| 1 | `scripts/gen-staging-fresh.mjs` | 1 | full UUID | header comment `Target: D1 "corner-cup-staging" (ID …)` |
| 2 | `scripts/gen-staging-freshsafe.mjs` | 1 | full UUID | same header comment |
| 3 | `scripts/gen-staging-migrations.mjs` | 1 | full UUID | same header comment |
| 4 | `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` | 1 | truncated form | "Staging D1 … (`…`)" row of the not-contacted table |
| 5 | `STAGE13_PRODUCTION_READINESS_AUDIT.md` | 1 | truncated form | same table in the containment section |
| | **Total** | **5** | | |

Only comment/table text changed: the generator scripts still emit the same SQL, still name the target database `corner-cup-staging`, and their behaviour is unchanged. Neither file is imported by the Worker or by the test suite. `grep` for the id returns 0 results in the final snapshot.

### 3.3 Combined edit accounting

| Metric | Value |
|---|---|
| Files edited | 10 (6 for C1, 4 additional for F2; `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` is in both groups) |
| Substitutions | 12 (7 + 5) |
| Files byte-identical to source | 157 |
| Files added or removed by editing | 0 |

**Edit hygiene.** The first pass over the six C1 files was performed through a text-mode rewrite, which silently normalised the mixed CRLF/LF line endings of those files. That pass was discarded: each of the six files was re-derived from the untouched source with a byte-level substring replacement, so the only difference from source is the intended text substitution and the original line endings are preserved. The F2 edits were byte-level from the start. Final per-file sizes differ from source only by the exact length delta of the replaced strings.

---

## 4. Full-snapshot sensitivity scan results

All 167 files, binary-safe read, scanned by category. No sensitive value is reproduced in this report.

| Category | Result |
|---|---|
| Account subdomain token (the account-specific `workers.dev` subdomain) | **0 occurrences** |
| Concrete `<name>.workers.dev` hostname | **0** — the only remaining `workers.dev` text (13 mentions) is generic: `*.workers.dev` wildcards, `<staging-worker>.workers.dev` templates, "use a workers.dev origin" guidance |
| Other `*.pages.dev`, `*.vercel.app`, `*.netlify.app`, tunnel or custom domains | **0** |
| Personal email addresses | **0** |
| Email-shaped strings, total | 35, all non-personal: 5 × `@example.invalid` report placeholders (2 reports), 1 × `hello@cornercup.in` business contact used as the email-input placeholder in the café admin form, 29 synthetic test addresses (`@example.test` / `@example.com`) |
| Cloudflare account ids (32-hex) | **0** |
| UUIDs, total | 4: 3 × all-zero placeholders (`wrangler.jsonc`, `tests/harness/wrangler.jsonc`, `tests/harness/wrangler.auth.jsonc`), 1 × synthetic image key inside a test fixture |
| Cloudflare D1 / Sites / deployment identifiers (full) | **0** after F2 |
| Private key blocks | **0** |
| AWS access key ids | **0** |
| GitHub tokens (`ghp_`, `gho_`, `ghs_`, `ghu_`, `ghr_`) | **0** |
| Slack tokens | **0** |
| Stripe live keys | **0** |
| OpenAI-style keys | **0** |
| Google API keys | **0** |
| JWTs (`eyJ…`) | **0** |
| Cloudflare API tokens | **0** |
| Razorpay live key ids | **0** (only `rzp_test_*` synthetic fixtures) |
| WorkOS client ids / API keys | **0** real (only `client_test_phase2b` and `sk_test_…not_a_secret` fixtures) |
| Populated environment files | **0** — the only environment file is `.dev.vars.example`; all nine secret keys (`ADMIN_PIN`, `ADMIN_SECRET`, `OPERATOR_PASSWORD`, `OWNER_PASSWORD`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID`) ship empty; only three non-secret defaults are filled (`CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN`) |
| `.env`, `.dev.vars`, `*.vars`, credentials `*.toml` present | **0** |
| Credential **paths** mentioned in prose | 1 (the local Wrangler config path in `STAGE16A_PRODUCTION_BACKUP_REPORT.md`) — path only, no content |
| Test-harness operator password | Synthetic fixture value only, unchanged from 3I-E; production auth still refuses to sign sessions without a configured secret (empty fallback → 503) |
| Secrets inside build output | **0** — no build output is in the snapshot |

**Generic platform documentation vs account-specific information.** `freebuff.page` appears 4 times in 4 files and `freebuff.com` 0 times, all inside boundary/scope prose ("no request was made to any `workers.dev` or `freebuff.page` URL", "platform documentation, not this project's account"). `site.json` also records the platform's site/production/preview vocabulary. These are treated as generic platform references and retained: they describe *what kind* of platform component is involved, never a tenant subdomain, account tag or token. Every reference that pointed at *this* account's resources — the staging hostname and the D1 id — is now a bracketed placeholder.

---

## 5. Remaining infrastructure or privacy concerns

None is a publication blocker; each is either inherent to the engineering record or explicitly deferred.

| # | Concern | Scope | Assessment |
|---|---|---|---|
| **R1** | Local Windows user paths — `C:\Users\<user>\corner-cup-backups\…` | 9 files, 19 lines (`DISASTER_RECOVERY_RUNBOOK.md` 4, `STAGE16A_PRODUCTION_BACKUP_REPORT.md` 4, `STAGE12_BACKUP_POLICY.md` 3, `STAGE11_BACKUP_RESTORE_REPORT.md` 2, `STAGE13_PRODUCTION_READINESS_AUDIT.md` 2, and 1 each in `STAGE13_1_PRODUCTION_EXPOSURE_REPORT.md`, `STAGE13_1_REMEDIATION_PLAN.md`, `STAGE13_1_SOURCE_PRESERVATION_REPORT.md`, `STAGE3C_MENU_PHOTOGRAPHY_REVIEW.md`) — plus one `.freebuff` worktree path | Discloses a local username and backup directory layout. No credential, no hostname, no path that resolves outside the owner's machine. Carried from 3I-E (R2). Optional normalisation to `<user>` remains available as a follow-up edit. |
| **R2** | Truncated 8-hex fragments — 45 across 11 reports | Mostly SHA-256 **file/config** prefixes used as an evidence trail (`wrangler.jsonc` hash, build-asset hashes, export checksums). A minority are 32-bit prefixes of resource ids (staging config hash, restore database, site id) | A 32-bit prefix of a UUID or a hash prefix is not resolvable to a resource and is not a credential. Truncation is deliberate in the reports and preserves the audit argument. |
| **R3** | Staging resource **names** (`corner-cup-staging`, 89 mentions) | Recovery and deployment reports | Project names, not account-specific. Required for the recovery narrative to mean anything; identical to any similarly named deployment. |
| **R4** | No CI workflow in the set | Repository root | Carried from 3I-E: acceptable for the initial private import; must be added and required via branch protection as the first follow-up commit. |
| **R5** | Placeholder D1 id in `wrangler.jsonc` (`00000000-…`) and no `IMAGES` R2 binding | `wrangler.jsonc` | Deliberate: the publication snapshot is not deployable as-is. Application/deployment limitation, documented in `README.md`, not a privacy issue. |
| **R6** | `sites.manifest.json` references `./sites-build/index.js` | Root | The directory is gitignored and absent; harmless pointer used by the review tooling. |

---

## 6. Final file count and total size

| Metric | Value |
|---|---|
| Files | **167** |
| Total size | **2,676,992 bytes** (2.55 MiB) |
| Zero-byte files | 0 |
| Duplicate content (identical SHA-256) | 0 groups |
| Files missing vs source | 0 |
| Files unexpected vs source | 0 |
| Files changed vs source | 10 (all intentional redactions) |
| Generated folders present (`dist/`, `node_modules/`, `.wrangler/`, `sites-build/`) | none |
| Local state present (`.git/`, `.state-*`, `.dev.vars`, `*.sqlite*`, `*.db`, `*.log`) | none |
| Size delta vs source snapshot | −292 bytes, fully accounted for by the 12 substitutions |

---

## 7. SHA-256 manifest location and verification results

| Item | Value |
|---|---|
| Manifest | `C:\Users\rahil\AppData\Local\Temp\corner-cup-publication-final.sha256` |
| Format | `sha256sum` compatible, `"<hash>  <relative/path>"`, forward-slash relative paths, sorted |
| Entries | 167 (one per file, no extras) |
| Manifest file SHA-256 | `517257ebce626c88e71455dfcdf517e3e262bb0401f02a816fc6402cc48745b5` |
| Verification | `sha256sum -c` run inside the snapshot → **167 OK, 0 FAILED** |
| Location rationale | Kept beside, not inside, the snapshot so the published file count stays exactly 167 |

The source manifest (Appendix B of the 3I-D report) remains valid for the pre-edit state and is superseded by this manifest for the final state.

---

## 8. Simulated staging results

A disposable copy of the final snapshot was created at `C:\Users\rahil\AppData\Local\Temp\stage3if-gitcheck` — outside the worktree and outside both snapshots — initialised as an empty Git repository, and the index populated with a dry run only.

| Check | Result |
|---|---|
| `git add -n .` exit status | 0 |
| Entries listed for staging | **167** |
| Entries staged but absent from the snapshot | 0 |
| Snapshot files not staged | 0 |
| Ignored entries present in the tree (`git status --ignored` → `!!`) | 0 — nothing needed to be ignored |
| Real `git add`, commit, branch or remote created | none (dry run only; the route directory was never touched) |

`.gitignore` coverage confirmed: `node_modules/`, `dist/`, `.wrangler/`, `.tools/`, `sites-build/`, `.admin-secret.txt`, `.operator-password.txt`, `.dev.vars`, `.env`, `.DS_Store`, `*.log`, `.razorpay-key-id.txt`, `.razorpay-key-secret.txt`, `audit-package/`, `corner-cup-*.zip`, `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `tests/harness/.state-*/`, `tests/harness/.wrangler/`. Source and fixture files that must ship (including `.dev.vars.example` and `tests/harness/wrangler*.jsonc`) are **not** excluded — verified by their presence in the 167 staged entries.

---

## 9. Remaining publication blockers

**For creating a private GitHub repository from this snapshot: none.**

The set is complete, byte-verified, secret-clean, self-consistent (167 files, no duplicates, no generated or local state), and stages exactly as intended.

Before anything changes hands or goes live, the following are the intended next steps rather than blockers of this snapshot:

1. **Human review of this report and the final snapshot** — the stop condition of this stage.
2. Create the private repository `corner-cup`, configure the remote, commit the 167-file set.
3. Add the CI workflow (`npm ci`, `npm test`, `npm run build`) and require it via branch protection before the first outside contributor.
4. Optional polish: **R1** username-path normalisation (9 files, 19 lines) if the owner wants the machine layout out of the docs.
5. Before any deployment from the published copy: replace the placeholder `database_id`, provision the `IMAGES` R2 binding, and set real secrets through the platform's secret store rather than a committed file.

---

## 10. Explicit confirmation of restrictions

- **No GitHub repository** was created; no remote, branch, staging area, commit, push or publication exists because of this stage.
- **No deployment, no production or staging access.** No Wrangler, platform or network command was run against any environment; no resource was read or written.
- **The original worktree was not modified.** The only file this stage adds there is `STAGE3I_F_FINAL_REDACTION_REPORT.md`. No configuration, source, test, dependency or lockfile change was made anywhere.
- **Neither existing snapshot was modified or overwritten.** `corner-cup-publication` re-verified at 167/167 against its own manifest after this stage; `corner-cup-snapshot` was not opened for writing.
- **No application logic, dependency or lockfile change.** The ten edited files contain comment, prose and table text only; `package.json`, `package-lock.json`, `worker/`, `src/`, `tests/` and the Wrangler configs are byte-identical to the source snapshot.
- **All edits occurred in the new destination** (`corner-cup-publication-final`); nothing outside it was edited.
- **No credentials were printed or exposed.** This report names no hostname, database id, key or token, and no scan output containing a sensitive value was reproduced.
- **Nothing was deleted** from any existing directory. Scratch material (analysis scripts, the staging dry-run copy, the manifest) lives outside the three project directories.
- **Git operations were dry-run only, in a disposable copy** — never in the worktree, the source snapshot or the final snapshot.

This stage stops here, as instructed. The next step is the human review of `corner-cup-publication-final` and this report.
