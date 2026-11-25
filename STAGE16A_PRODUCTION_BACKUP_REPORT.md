# STAGE 16A — PRODUCTION D1 BACKUP & VERIFICATION

**Date:** 2026-11-20
**Attempted scope:** read-only export of the production D1 database, integrity verification, isolated restore validation.
**Result: NOT PERFORMED — two stop conditions were met before any export command was run.**
No production read was issued, no database was created, nothing was written anywhere.

---

## 1. Outcome in one line

The production database is confirmed and identified, but the **only credential available on this machine belongs
to a different Cloudflare account**, so `wrangler d1 export` cannot reach it; and **encryption at rest could not
be established** on the destination volume. Per the brief's stop conditions, the backup was not attempted.

---

## 2. Confirmed source identity (from platform metadata, no query issued)

| Property | Value |
|---|---|
| Database name | `site-6e1c6f7a9a9f4e098f778f9754221b0a` |
| Database ID | `17d9568d-52fd-48c2-8761-b74d97688589` |
| Owning account | `6e5a40dd9362fb315de7ecbaad2ca12b` (Sites namespace `freebuff-sites-prod`) |
| Bound to | Sites site `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63`, environment `production` (`fa58771d-25fb-4936-bbad-5cffd6ff3973`) |
| Binding name | `DB` (kind `d1`) |
| Storage | 266,240 bytes |
| Rows written / read (month) | 1,580 / 207,464 |
| Status | **not staging, not a restore database** — this is the database behind the production Sites deployment |

This identity is not inferred: it is the `DB` binding returned by `sites_inspect` for the production environment,
and it was recorded identically in `STAGE15_PRODUCTION_CONTAINMENT_DECISION.md` §1.4.

### The three databases that must not be confused

| Database | ID | Account | Role |
|---|---|---|---|
| **Production (target)** | `17d9568d-52fd-48c2-8761-b74d97688589` | `6e5a40dd…` | the database this stage was meant to back up |
| Staging | `39a7899c-0130-4536-9570-f07b6c29b2d4` | `bca798ce…` | Stage 11 source; **must not be exported as "production"** |
| Stage 11 restore target | `2399a1f7-2e26-49bc-89a7-21256439a014` | `bca798ce…` | a preserved drill artifact; must not be touched |

---

## 3. Stop condition 1 — no credential path to the production database

The local Wrangler identity:

```
wrangler 4.158.0
Logged in with an OAuth Token — rahilbisen8@gmail.com
Account: Rahilbisen8@gmail.com's Account   bca798cecc7dc814299016c208b96ebd
Credentials: C:\Users\rahil\AppData\Roaming\xdg.config\.wrangler\config\default.toml
```

That is **not** account `6e5a40dd9362fb315de7ecbaad2ca12b`. Evidence that the production database is invisible to it:

```
$ npx wrangler d1 list
uuid                                  name
2399a1f7-2e26-49bc-89a7-21256439a014  corner-cup-stage11-restore-20261119T155325Z
39a7899c-0130-4536-9570-f07b6c29b2d4  corner-cup-staging

$ npx wrangler d1 info 17d9568d-52fd-48c2-8761-b74d97688589
X [ERROR] Couldn't find a D1 DB with name or binding
  '17d9568d-52fd-48c2-8761-b74d97688589' in your config or the API.
```

Only one Wrangler profile exists (a single `default.toml`); no `CLOUDFLARE_API_TOKEN`,
`CLOUDFLARE_ACCOUNT_ID`, `CF_API_TOKEN` or `CLOUDFLARE_API_KEY` is set in the environment.

**Consequence:** running `wrangler d1 export site-6e1c6f7a… --remote` would fail, and — worse — if a same-named
database were ever created in the personal account, the command could silently export the wrong one. That is
exactly the ambiguity the brief says to stop on. **No export command was run.**

Two facts make this worse rather than better:

- The production environments are **unpublished** (Stage 15), so any in-application or preview-hosted export
  route is unreachable by design.
- The current source contains **no** `EXPORT_TOKEN` handling (`grep` over `worker/`, `src/`, `tests/` → no
  matches), so there is no supported application-level export path even if the site were serving.

---

## 4. Stop condition 2 — encryption at rest could not be established

```
$ powershell Get-BitLockerVolume -MountPoint 'C:'
Get-CimInstance : Access denied
Get-Win32EncryptableVolumeInternal : C: does not have an associated BitLocker volume.
```

BitLocker status is **UNVERIFIED**: the query was refused for lack of privilege, and the same call reported no
associated BitLocker volume for `C:` — which is consistent with the volume being unencrypted, but is not proof.

Per the brief, an unestablished encryption state means the artifact may not be described as a securely protected
backup. Since a plaintext export of production data would be the first copy of customer/owner/order records
outside the platform, this alone was treated as a stop condition.

**Access restriction of the intended destination** (measured):

```
C:\Users\rahil\corner-cup-backups
  NT AUTHORITY\SYSTEM:(OI)(CI)(F)
  BUILTIN\Administrators:(OI)(CI)(F)
  RAHIL\rahil:(OI)(CI)(F)
```

No `Everyone`, no `Users`, no network share. Access is limited to the signed-in user, SYSTEM and local
administrators — necessary but **not** a substitute for encryption at rest.

---

## 5. What exists on disk today (and what it does not cover)

| Artifact | Size | Date | What it is | Is it a production backup? |
|---|---:|---|---|---|
| `corner-cup-preview-d1-2026-11-12T10-20-00-061Z.sql` | 43,685 B | 2026-11-12 | **preview** environment export (preview's own DB `72841897-…`) | **No** |
| `pre-migration-20261116-030132.sql` | 32 B | 2026-11-16 | effectively empty stub | No |
| `stage11-…/corner-cup-staging_20261119T155325Z.sql` | 16,553 B | 2026-11-19 | staging export (SHA-256 `e2a6afe6…0c8c`) | No |
| `stage11-…/corner-cup-stage11-restore_…sql` | 16,553 B | 2026-11-19 | restore-target dump from the drill | No |
| `stage11-…/metrics.sql`, `query.sql` | 2,535 / 3,102 B | 2026-11-19 | drill queries, not data | No |

**There is no export of the production database anywhere on this machine.** The preview export must not be
mistaken for one: it holds preview data in a different database belonging to a different environment. Anyone
reading the backup folder could reasonably make that mistake, which is why it is called out here.

---

## 6. Verification performed (non-destructive, and all that was safe to do)

| Check | Method | Result |
|---|---|---|
| Production DB identity | `sites_inspect` production binding `DB` | `17d9568d-…` / `site-6e1c6f7a…`, account `6e5a40dd…` — **confirmed** |
| Is it staging or a restore DB? | name, id, owning account, binding path | **No** — different account, different id, bound to the live production deployment |
| Local credential identity | `wrangler whoami` | account `bca798ce…`, email `rahilbisen8@gmail.com` — **does not match** |
| Reachability of production DB | `wrangler d1 list`, `d1 info <id>` | **not visible** → stop |
| Encryption at rest | `Get-BitLockerVolume` | **access denied / no associated volume** → stop |
| Destination access restriction | `icacls` | user + SYSTEM + Administrators only |
| Publication state unchanged | `GET` both URLs | production **404**, preview **404** (still contained) |
| Source untouched | `git status` | 27 modified, 110 untracked, 0 staged — unchanged |

Restore verification: **not attempted and remains outstanding**, because there is no artifact to restore.

---

## 7. Exact actions required to unblock (each needs owner approval)

**A. Provide a reading path to account `6e5a40dd…` — either:**

1. **Platform-side export (preferred, no new credentials).** Use the Sites/database management surface for site
   `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63` → production → database `site-6e1c6f7a9a9f4e098f778f9754221b0a`
   and download the SQL export. Store it directly into a new restricted folder
   `C:\Users\rahil\corner-cup-backups\stage16a-production-<UTC timestamp>\`. If the platform offers no export, the
   alternative below is the only route.
2. **Scoped API token.** Create a token in the platform account with **D1 Read** (no write scopes), export it to
   the environment as `CLOUDFLARE_API_TOKEN` for the duration of one command, then run:

   ```bash
   DEST="C:/Users/rahil/corner-cup-backups/stage16a-production-$(date -u +%Y%m%dT%H%M%SZ)"
   mkdir -p "$DEST"
   npx wrangler d1 export site-6e1c6f7a9a9f4e098f778f9754221b0a --remote \
     --output "$DEST/production_$(date -u +%Y%m%dT%H%M%SZ).sql"
   ```

   The token must be revoked immediately afterwards. It must never be written into the repository, `.dev.vars`
   or a log.

**B. Decide the at-rest question — either:**

- enable BitLocker on `C:` (owner action; may require administrator), **or**
- accept plaintext-on-restricted-directory with the risk written down, **or**
- encrypt the artifact with `age`/`7z` using a passphrase the owner stores in a password manager (the passphrase
  must never be pasted here or stored beside the file).

Only after (A) and a decision on (B) can this stage be re-run as a *completed* backup.

---

## 8. Verification plan, ready to execute once the artifact exists

1. Record size and SHA-256 of the raw export; never modify the file afterwards.
2. Count structure **without printing contents**: `CREATE TABLE`, `CREATE INDEX`, `CREATE TRIGGER`, `INSERT`
   statements; compare against the 19-table schema the migrations define.
3. Restore into an **isolated local** target only — no remote database, no Worker, no binding:

   ```bash
   npx wrangler d1 execute corner-cup-stage16a-verify --local \
     --persist-to ./.wrangler/stage16a-verify \
     --file "<export>.sql" --yes
   ```

   This is chosen deliberately over a remote restore: it cannot touch production, staging or the Stage 11 restore
   database, creates no account-level resource, and keeps the extra copy of sensitive data on the same restricted
   volume instead of a second cloud database.
4. On the restored copy: `PRAGMA integrity_check` (`ok`), table/index/trigger counts, per-table `COUNT(*)`, and a
   SHA-256 over each table's rows compared against the same query run read-only against the source
   (`d1 execute --remote --json`), printing hashes only.
5. Compare `sqlite_master.sql` DDL byte-for-byte.
6. Record every result; keep the local restore target and the export; delete nothing.

---

## 9. Recovery limitations (unchanged, and now more precise)

- **No production backup exists.** If the production database were lost today, there is nothing to restore from.
- **No point-in-time recovery**: D1 on this plan has no Time Travel, so the recovery point is whatever export a
  human takes.
- **The only exports that exist are staging and preview.** Neither can reconstruct the production database:
  different ids, different accounts, different data.
- **Containment removed the application-level workaround**: with both environments unpublished, an in-app export
  endpoint could not be reached even if one existed in that build.
- **The artifact, once produced, is plaintext SQL** unless the owner opts into encryption (§7B). It will contain
  password hashes, contact fields, order history and guest tracking data.

---

## 10. Confirmation of non-modification

- **No export was run**; no SQL file was created, copied, moved or deleted.
- **No database was created, queried, migrated, written to or dropped** — production, staging and the Stage 11
  restore database are untouched.
- **No Worker, binding, secret, environment variable, route, DNS record, deployment or publication state was
  changed.** Production and preview still return `404`, as Stage 15 left them.
- **No secret was read.** Credential presence was checked by name only; the token file was never opened or printed.
- **No existing backup was overwritten or removed.** All five prior snapshots and all six existing `.sql`
  artifacts remain in place.
- **The repository is unchanged**: 27 modified files, 110 untracked entries, 0 staged — identical to before this
  stage, except for this report.

**Bottom line:** the production database is identified beyond doubt, but backing it up is blocked on account
access, and the destination's encryption state is unverified. Both are owner decisions, not engineering ones.
