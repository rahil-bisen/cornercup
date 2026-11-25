# PRODUCTION D1 RECOVERY — WHAT FREEBUFF MUST PROVIDE, AND HOW TO VERIFY IT

**Status: NO BACKUP OBTAINED.** As of 2026-11-25 there is still no export, dump, checksum or encrypted
artefact of the production database. Nothing in this document was run against production; no production
read or write was attempted, and neither environment was published or changed.

**Purpose:** state exactly what Freebuff support must hand over for a *verified logical export*, and give a
tested procedure that turns that artefact into a checked, encrypted, restorable backup — or into an explicit
"the database is gone" finding that can be recorded honestly.

---

## 1. Identity, re-confirmed from platform metadata (read-only, 2026-11-25)

Read through `sites_inspect` on environment `fa58771d…`; no database query was issued.

| Property | Value |
|---|---|
| Site | `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63` — "Corner Cup Café — Razorpay" |
| Environment | `fa58771d-25fb-4936-bbad-5cffd6ff3973` (`production`) |
| Worker | `site-fa58771d25fb4936bbad5cffd6ff3973` |
| Platform account | `6e5a40dd9362fb315de7ecbaad2ca12b` (`freebuff-sites-prod`) |
| D1 binding | `DB`, record `b80703c2-944c-460d-8a21-57ea05a80bf9`, created 2026-11-09T16:14:26.348Z |
| D1 database name | `site-6e1c6f7a9a9f4e098f778f9754221b0a` |
| D1 database id | `17d9568d-52fd-48c2-8761-b74d97688589` |
| Provisioning receipt | `6e1c6f7a-9a9f-4e09-8f77-8f9754221b0a`, `kind: d1`, `state: succeeded`, completed 2026-11-09T16:14:26.379Z |
| Reported storage | 266,240 bytes (`d1Bytes` used 266,240 of 100,000,000) |
| Publication | **`published: false`**, `unpublished_at` 2026-11-20T12:21:55.638Z |
| Other bindings present (names only) | `ADMIN_PIN`, `ADMIN_SECRET`, `OPERATOR_PASSWORD`, `OWNER_PASSWORD`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `SERVICE_MODE` |

This reconfirms what Stage 16A and the escalation packet recorded: the **metadata** is intact and
self-consistent. It does **not** prove the database exists, is readable, or has ever been backed up. The
latest authenticated check from this machine (account `bca798ce…`, a different Cloudflare account) cannot see
the database at all.

---

## 2. What Freebuff must provide

Only one of these three outcomes is acceptable. "It should still be there" is not.

### Option A — hand over the export (preferred)

A logical SQL export of database `17d9568d-52fd-48c2-8761-b74d97688589`, plus the following **seven fields**.
Without all seven it is an unverified file, not a backup.

| # | Field | Why it is required |
|---|---|---|
| 1 | The database id `17d9568d-…` quoted in the handover note | Proves which database this file came from; name alone is ambiguous |
| 2 | **Complete** dump: schema **and** data, all tables | A `--no-data` or `--table`-filtered export cannot restore the café |
| 3 | Export timestamp (UTC) and the snapshot it represents | Sets the recovery point; D1 has no point-in-time recovery on this plan |
| 4 | Exact byte size of the file | Detects truncation in transit |
| 5 | **SHA-256 of the exact bytes** | The only check that the file arrived unaltered |
| 6 | The command/tool used (platform export vs `wrangler d1 export`) | Reproducibility; distinguishes logical from physical copy |
| 7 | Confirmation the database was not being written to during the export | A dump taken mid-write can be internally inconsistent |

Delivery must not put production data in chat. A private file transfer or a signed URL to the artefact is
fine; the hash may be sent separately.

### Option B — scoped read-only access (alternative)

A temporary token limited to **D1 Read** on account `6e5a40dd…`, or a platform-issued credential for exactly
that database, valid for one export window. Then this machine runs the export itself (§3) and revokes the
token. The token must never be written to the repository, `.dev.vars`, a log or a chat message.

### Option C — a definitive non-existence statement (also an answer)

If the database is gone, support must say so explicitly, with the retention window that applied and when the
data ceased to exist. That is recorded as a finding, not paraphrased as "deleted" or "unavailable".

### What is *not* acceptable

- A schema-only dump, a row count, or a screenshot.
- An export of a *different* database (staging `39a7899c-…`, the Stage 11 restore DB `2399a1f7-…`, or the
  preview DB) presented as production.
- A verbal assurance that the data is safe.
- Creating a same-named database in the owner's account to "recover" it — Wrangler resolves by name, so any
  export would silently read the wrong database.

---

## 3. Safe export procedure (run only once access exists)

Destination: a new directory outside the repository, e.g. `C:/Users/rahil/corner-cup-backups/prod-<UTC>/`.
Never export into the project tree. Never commit the artefact.

```bash
set -euo pipefail
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
DEST="C:/Users/rahil/corner-cup-backups/prod-$STAMP"
mkdir -p "$DEST"

# 1. Prove which account/database you are about to read. If the id is not 17d9568d-…, STOP.
npx wrangler d1 info 17d9568d-52fd-48c2-8761-b74d97688589

# 2. Export the remote database by ID (not by name), full schema + data.
npx wrangler d1 export 17d9568d-52fd-48c2-8761-b74d97688589 --remote \
  --output "$DEST/production_$STAMP.sql"

# 3. Hash the bytes exactly as written; record size.
sha256sum "$DEST/production_$STAMP.sql" | tee "$DEST/SHA256SUMS"
stat -c '%s bytes' "$DEST/production_$STAMP.sql"   # or: wc -c < file

# 4. Encrypt at rest (AES-256-CBC, PBKDF2 200k, salted). Passphrase lives in a password manager,
#    never beside the file and never in this repository.
openssl rand -hex 32 > "$DEST/.key"           # move this into the password manager, then delete it
openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt \
  -in "$DEST/production_$STAMP.sql" -out "$DEST/production_$STAMP.sql.enc" \
  -pass file:"$DEST/.key"
shred -u "$DEST/.key" 2>/dev/null || rm -f "$DEST/.key"

# 5. Verify the artefact before deleting the plaintext: hash, decrypt round trip, isolated import,
#    integrity_check and foreign_key_check. This script exists in the repository.
node scripts/verify-d1-export.mjs "$DEST/production_$STAMP.sql.enc" \
  --decrypt --passphrase-file <(printf '%s' "$PROD_BACKUP_PASSPHRASE") \
  --report "$DEST/verify.json"
```

Then, only after `verify.json` says `"ok": true`:

6. Delete the plaintext dump (`shred -u`), keep the `.enc`, `SHA256SUMS` and `verify.json`.
7. Store a second copy of the `.enc` on different media, and the passphrase in a password manager.
8. Record in `DISASTER_RECOVERY_RUNBOOK.md`'s log: database id, timestamp, size, SHA-256, who exported it,
   where both copies are, and the restore drill result.

### Local note learned on 2026-11-25

`wrangler d1 export` has **no `--persist-to` flag**; local exports read the state directory relative to the
config file. For a *remote* export this does not matter, but anyone repeating the local drill must copy the
database into the config-relative `.wrangler/state/...` path or run the harness without `--persist-to`.
Using the wrong state directory silently exports a different (older) local database — the same class of
mistake as the name-collision trap.

---

## 4. The verifier (`scripts/verify-d1-export.mjs`)

New in this pass, and built to make verification independent of Cloudflare, Docker or the `sqlite3` CLI:

- Computes SHA-256 of the file bytes, and the plaintext hash after decryption.
- When `--decrypt` is used, re-encrypts the plaintext with the same salt and requires the result to be
  **byte-identical** to the received file — proving the crypto round trip, not assuming it.
- Rejects an empty dump, or one that drops tables without creating them.
- Imports the dump into a throwaway SQLite file using Node's built-in `node:sqlite` (no server, no network,
  no Worker).
- Runs `PRAGMA integrity_check` and `PRAGMA foreign_key_check`, counts tables/indexes/triggers/views and
  per-table rows, prints **no row contents**, and exits non-zero on failure.

Usage:

```bash
node scripts/verify-d1-export.mjs <dump.sql> [--sha256 <hex>] [--report <path>]
node scripts/verify-d1-export.mjs <dump.sql.enc> --decrypt --passphrase-file <path> [--sha256 <hex>]
```

### Proven today on a disposable database (not production)

A real D1 logical export of the local harness database (450,821 bytes) was:

| Check | Result |
|---|---|
| SHA-256 | `4a87f64eb49048ad5576d81e4d345bf60c8b6bdcb3d93c622d98df656448478e` |
| Import into fresh SQLite | succeeded |
| `integrity_check` | `ok` |
| `foreign_key_check` violations | 0 |
| Tables restored | 23 (matches the 23 `CREATE TABLE` statements in `worker/db.js`) |
| Indexes restored | 38 (D1 materialises unique/constraint indexes beyond the 21 declared in code) |
| AES-256-CBC/PBKDF2-200k encrypt → decrypt | **byte-identical** (same SHA-256) |
| Encrypted-file verification | `ok: true`, 23 tables, FK 0 |

This proves the *procedure and tooling*. It says nothing about the production database, and the row counts in
that dump are harness test data.

---

## 5. What has not been done, and will not be done without authorization

- No production export, no production query, no production write, migration, reset or deletion.
- No attempt to reach the database with another account, token, or borrowed credential.
- No database created with the production name in the owner's account.
- No site deletion, unpublish, republish or deployment.
- No secret or binding changed on either environment.
- No claim that a backup exists. **It does not.**

---

## 6. Recovery position while this is open

| Item | State |
|---|---|
| Production backup | **None.** RPO is undefined because no successful export exists. |
| Point-in-time recovery | Not available on this plan; the only recovery point is a human export. |
| Restore procedure | Proven on disposable databases only (this pass: 23 tables, 38 indexes, FK 0, encrypted round trip identical). Never exercised against production data. |
| DB-only RTO | ~30 minutes measured on a disposable copy; full recovery ~60 minutes estimated, never drilled. |
| Safe alternative until resolved | Do not relaunch over that database. Either obtain the export, or have the owner formally accept starting without the old data — in writing. |

---

## 7. The questions support must answer

1. Does `17d9568d-52fd-48c2-8761-b74d97688589` still exist on account `6e5a40dd…`?
2. If yes: will you provide the complete logical export with the seven fields in §2, or scoped read-only access
   to run it ourselves?
3. If no: when did it cease to exist, and what retention window applied?
4. Was any export taken by the platform at unpublish time (2026-11-20T12:21Z), and where is it?

Until at least one of those is answered with evidence, the launch criterion "a production D1 export exists
with a SHA-256 and a drilled restore" remains **unmet**.

---

## 8. Three different things, never to be conflated

| Thing | What it is | State today |
|---|---|---|
| **Provider metadata** | Site/environment records, the `DB` binding record and the provisioning receipt, read through the platform API | **Intact and re-confirmed 2026-11-25.** Proves a database was provisioned; proves nothing about its contents |
| **Verified logical export** | A complete SQL dump with database id, UTC time, byte size, SHA-256, tool, and a clean `integrity_check`/FK result after restore | **Does not exist.** This is what §2 and §3 define and what `scripts/verify-d1-export.mjs` checks |
| **Provider-held backup** | A snapshot the platform itself retains and can restore on request | **None known and none promised.** D1 on this plan has no point-in-time recovery; do not assume one exists |

A support reply saying "the database exists" is metadata. Only the artefact in row 2 changes the recovery
position, and only after it has been hashed and restored.

## 9. Follow-up request (ready to send — not sent)

> Subject: Follow-up — production D1 export for Corner Cup (site `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63`)
>
> Following up on the export request for database `17d9568d-52fd-48c2-8761-b74d97688589` (binding `DB`,
> environment `fa58771d-25fb-4936-bbad-5cffd6ff3973`). To close this I need one of:
>
> 1. the complete logical export (schema **and** data) with the database id, UTC export time, byte size,
>    SHA-256 of the exact file, and the tool used; or
> 2. scoped read-only access to that database for one export window; or
> 3. a written statement that it no longer exists, with the retention window that applied.
>
> Please confirm whether the platform took any export at the 2026-11-20T12:21Z unpublish, and please do not
> delete, migrate or redeploy the site while this is open. The environments are already unpublished.

This message contains only IDs and non-secret metadata, and no production data. It has **not** been sent by
this mission.
