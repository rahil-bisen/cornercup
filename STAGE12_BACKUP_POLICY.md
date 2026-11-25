# Stage 12 — Backup Frequency, Retention and Recovery Objectives

**Date:** 2026-11-20
**Status of this document:** a **proposal**. Nothing in §3–§8 is automated today; §2 states precisely what is
implemented. No paid service is a dependency, and no paid plan is required.
**Companions:** `STAGE11_BACKUP_RESTORE_REPORT.md` (the one measured drill), `DISASTER_RECOVERY_RUNBOOK.md`.

---

## 1. Constraints that shape the policy

| Constraint | Effect on the policy |
|---|---|
| D1 on the Workers **Free** plan | No point-in-time recovery / Time Travel. The recovery point is the last export a human actually took. |
| Zero budget | Storage is the operator's own disk plus one free second location. No paid backup product, no paid plan upgrade, no managed vault. |
| One operator, no on-call rotation | Frequency must be something one person will genuinely do; runbook-or-nothing policies fail. |
| Data volume is tiny | ~16.5 KB per export, 233 KB of SQLite pages, 19 tables, single-digit orders per day. Retention generosity costs nothing. |
| Data is sensitive | Exports contain password hashes, contact fields, order history and guest tracking fields. Encryption and access control are part of the policy, not an afterthought. |
| Deterministic exports (observed) | The Stage 11 re-export was **byte-identical**. Checksum comparison is therefore a usable integrity signal, not just a corruption test. |

## 2. What is implemented today

| Capability | State |
|---|---|
| Manual export before a change | **Implemented** as a habit, not a schedule. Stage 11 exported staging with `wrangler d1 export … --remote`. |
| Export stored outside the repository | **Implemented** — `C:\Users\rahil\corner-cup-backups\stage11-20261119T155325Z\`. |
| Checksum recorded | **Implemented** for the Stage 11 artifact (SHA-256 in the Stage 11 report). No manifest file exists. |
| Restore into an isolated database | **Implemented and proven once** (Stage 11: schema hash, 19 table hashes, aggregates, integrity all matched). |
| Recurring/scheduled backup | **Not implemented.** No cron, no Worker, no CI job, no reminder. |
| Retention or rotation | **Not implemented.** One artifact exists; nothing prunes or expires anything. |
| Off-device / second copy | **Not implemented.** The single copy lives on the operator's laptop. |
| Encryption at rest | **Not implemented** beyond the operating system's disk encryption (if enabled). Exports are plaintext SQL. |
| Automated integrity re-verification | **Not implemented.** |
| Restore drills on a schedule | **Not implemented.** One drill has been performed (Stage 11). |

Everything below is a recommendation until it is recorded as implemented in a later stage.

## 3. Backup frequency

| Trigger | What to back up | Why |
|---|---|---|
| **Before every migration, schema change, or deploy** | `corner-cup-staging` (and later production) | Mandatory. Exports are seconds; a schema change without one is unrecoverable. |
| **Weekly, fixed day** | Active deployment database | Bounds routine loss to seven days. Cheap enough to survive a busy week. |
| **Before any risky manual SQL** | The database being touched | The single most common self-inflicted incident. |
| **Before a café onboarding or menu rewrite** | Same | Content changes are the ones owners notice. |
| **Daily (stretch, only if automated)** | Active database | Reduces RPO to a day without requiring discipline. See §9. |

Manual, documented command (the one proven in Stage 11):

```bash
npx wrangler d1 export corner-cup-staging --remote --config wrangler.staging.jsonc \
  --output "C:/Users/rahil/corner-cup-backups/<YYYYMMDDTHHMMSSZ>/corner-cup-staging_<stamp>.sql"
```

Use `--remote` for a deployed database and `--local` only for local development state. The two are not
interchangeable, and a `--local` export of a deployment recovers nothing.

## 4. Retention

Proposed ladder — sized for 16 KB files, so the cost is a few megabytes:

| Tier | Keep | Rationale |
|---|---|---|
| Pre-change | All, until the change is verified and one week has passed | These are the ones that actually get used. |
| Daily | 14 | Two weeks of "when did this go wrong?" |
| Weekly (first export of the week) | 8 | Two months of history. |
| Monthly (first export of the month) | 6 | Half a year, covers a slow-burn data problem. |
| **Minimum floor** | **3 verified artifacts, one of them off-device** | Never fewer, regardless of any pruning rule. |

Pruning rule: delete only after a newer artifact in the same tier exists **and** has been verified (§6). Never
prune the last three. Never prune anything while an incident is open.

## 5. Storage layout and off-account copy

```
C:\Users\rahil\corner-cup-backups\
  20261119T155325Z\
    corner-cup-staging_20261119T155325Z.sql
    MANIFEST.txt
  <next stamp>\
    ...
```

`MANIFEST.txt` (one line per artifact, append-only) records:

```
stamp | database name | database id | bytes | sha256 | user tables | orders | order_items | wrangler version | operator
```

**Off-account requirement.** One copy on the laptop is not a backup. The proposal is two free locations:

1. **Local disk** (primary, fast to restore).
2. **A second physical device** — external drive or a second computer, stored separately from the laptop.
3. **Optional, still free** — an encrypted archive in a personal cloud drive or Cloudflare R2's free allowance
   (10 GB). Optional because the provider's free tier can change; the policy must survive without it.

Never place an export in the repository, in a synced project folder, in a chat, or in an issue tracker.
`.gitignore` already excludes `*.sqlite`, `*.sqlite-wal`, `*.sqlite-shm`, `audit-package/`, `corner-cup-*.zip`
and `.dev.vars`; the backup directory lives outside the repository, which is the stronger guarantee.

## 6. Integrity and checksum verification

1. **On creation** — `sha256sum <file>` immediately; record it in `MANIFEST.txt` with byte size and row counts
   from a `SELECT count(*)` per table against the same database.
2. **On schedule (monthly)** — re-hash every retained artifact and compare to the manifest. A mismatch means
   storage rot or tampering; quarantine the artifact and take a fresh export.
3. **Before relying on one** — import it and compare. The Stage 11 method is the reference: import into a
   disposable local SQLite, hash ordered `sqlite_master` rows for schema, hash each table's full row content for
   data, compare aggregates, run `PRAGMA integrity_check`. Do not print row values while doing it.
4. **After a restore** — re-export the restored database and compare to the source artifact. Byte equality is
   expected for this schema and was observed in Stage 11; a difference is a finding, not a rounding error.

A checksum proves the file did not change. It does not prove the file is restorable. Only a drill (§8) proves
that.

## 7. Encryption and access control

Exports are plaintext SQL containing `pass_hash`, contact fields, `track_hash`, order history and session rows.
Treat every artifact as a credential store.

| Control | Proposal |
|---|---|
| At rest | Full-disk encryption on the machine holding the backup directory (BitLocker on Windows). |
| Archive encryption | Before any copy leaves the machine, wrap it: `7z a -p -mhe=on -mx=9 <stamp>.7z <stamp>.sql` or `age -p -o <stamp>.age <stamp>.sql`. Passphrase lives in a password manager, never in a file next to the archive. |
| Key custody | One passphrase per archive generation or one long-lived passphrase in the password manager, recorded with its creation date. Losing the passphrase loses the backup — say so out loud in the runbook. |
| Access | The backup directory is readable only by the operator's OS account. No shared folders, no sync clients pointed at it. |
| Handling | Never paste an export into chat, a ticket, an email or a commit. Never `cat` it in a session that is being recorded. Read it with SQL, and hash values rather than printing them. |
| Disposal | Shred/overwrite when an artifact leaves retention; deleting a file is not erasure on SSDs — rely on disk encryption for the residual copy. |
| Restore targets | A restored D1 database is production-grade sensitive data. Leave it unbound, record its id, and delete it only through an explicit, recorded decision. |

## 8. Recovery objectives and drills

### Proposed objectives

| Objective | Target | Basis |
|---|---|---|
| **RPO — routine** | ≤ 7 days (weekly export) | Achievable manually with zero budget. |
| **RPO — before a change** | 0 (export taken in the same session) | Non-negotiable for migrations and deploys. |
| **RPO — if §9 automation lands** | ≤ 24 hours | Nightly scheduled export. |
| **RTO — database only** | ≤ 30 minutes | Measured: export 17 s (Stage 11), `d1 create` ~30 s, import 8.4 ms / 92 statements, verification minutes. |
| **RTO — database + Worker** | ≤ 60 minutes | Assumes config in Git, secrets in the password manager and a working build. **Not measured end to end.** |
| **RTO — with secret loss** | Same day | Requires re-issuing credentials at WorkOS/Razorpay; outside anyone's control. |

Distinguish the measured number from the assumed one: the database-only path is measured, the end-to-end path is
an estimate that the first full drill should replace.

### Drill schedule

| Drill | Frequency | Pass condition |
|---|---|---|
| Export + checksum + manifest | Weekly (with the backup) | Artifact exists, hash recorded, size plausible. |
| Import into an isolated database + schema/data comparison | **Quarterly** | Full Stage 11 comparison: 19 table counts, 19 row hashes, schema hash, aggregates, `integrity_check` = `ok`. |
| Full recovery rehearsal (config + secrets + deploy + verify) against a non-production Worker | **Twice a year** | Runbook §2–§6 completes with no undocumented step. |
| Checksum re-verification of all retained artifacts | Monthly | Every hash matches the manifest. |

Every drill produces a short report with date, artifact hash, target database id, checks performed, and a
PASS/PARTIAL/FAIL rating — the same shape as `STAGE11_BACKUP_RESTORE_REPORT.md`. A drill that is not written
down did not happen.

## 9. Optional zero-cost automation (proposal, not implemented)

If the operator wants RPO ≤ 24 h without remembering:

- A GitHub Actions scheduled workflow (free minutes on the free tier, more on public repos) running
  `wrangler d1 export … --remote` with a scoped `CLOUDFLARE_API_TOKEN` stored as a repository secret, then
  uploading the encrypted archive as a **private** artifact or to free-tier R2.
- Constraints to accept before doing it: the token is a standing credential with D1 read access, the export is
  plaintext unless encrypted in the job, and artifact retention on the free tier is short. This trades one risk
  for another and must be an explicit decision, not a default.
- Cheaper and safer first step: a local scheduled task (`schtasks`) that runs the export and appends to
  `MANIFEST.txt`, with a reminder to copy off-device weekly.

Neither exists today. Do not describe the project as having automated backups.

## 10. Summary table

| Attribute | Proposed | Implemented today |
|---|---|---|
| Routine frequency | Weekly + before every change | Ad hoc, before changes only |
| Retention | 14 daily / 8 weekly / 6 monthly, floor of 3 | Unlimited, unmanaged (1 artifact) |
| Off-account copy | Second device, encrypted | None |
| Integrity | SHA-256 on write, monthly re-verify | SHA-256 recorded once |
| Encryption | Disk encryption + encrypted archive off-device | Disk encryption only (unverified) |
| RPO | 7 days (24 h if automated) | Time of last manual export |
| RTO | 30 min DB / 60 min full | ~1 hour DB-only, measured once |
| Drills | Quarterly restore, twice-yearly full | One restore drill (2026-11-19) |
