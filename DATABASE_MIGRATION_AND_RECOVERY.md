# Database Migration and Recovery

Target: Cloudflare D1 (SQLite). Schema is applied by `worker/db.js` → `init()`.

---

## 1. How migrations run

`init()` executes, in order and idempotently:

1. `SCHEMA` — `CREATE TABLE IF NOT EXISTS` for the base tables.
2. `MIGRATIONS` — statements guarded by the current schema state; each is safe to re-run.
3. `POST_MIGRATIONS` — indexes.

`init()` is called lazily on the first request that needs the database, so a cold start performs the
migration once. Statements are guarded so concurrent isolates cannot corrupt each other, but the
first boot after a migration should still be a single request, not a burst.

---

## 2. Migration inventory (current tree)

| Migration | Object | Notes |
| --- | --- | --- |
| base | cafés, menu items, categories, orders, order items, tables, settings, sessions, rate limits | pre-existing |
| `owner_totp` | MFA seed (encrypted), `confirmed_at`, `last_used_step`, `auth_version` | Stage 17B |
| `owner_totp_recovery` | recovery code hashes, `used_at` | Stage 17B |
| `owner_totp_challenges` | hashed login challenges with expiry | Stage 17B |
| `auth_events` | authentication audit log | Stage 17B |
| `ALTER TABLE operator_sessions ADD COLUMN credential_hash` | binds operator session to password | Stage 17B; legacy rows have no digest and therefore fail closed |

Verified on a **fresh** database: **23 application tables**, `credential_hash` present, seed café
`corner-cup-cafe` with 27 menu items and 8 tables created. Index accounting: 24 named indexes plus
14 SQLite autoindexes implied by UNIQUE constraints = 38 index entries (earlier notes that said
"38 indexes" counted all of them; "24 tables" counted miniflare's internal `_cf_KV` too).

---

## 3. Verifying a migration locally

```bash
npx wrangler dev --port 8791 --persist-to /tmp/freshdb-1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8791/api/health   # expect 200
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8791/api/health   # again: 200, no errors
```

Then inspect the SQLite file under the persist directory:

```bash
python - <<'PY'
import sqlite3, glob
db = sorted(glob.glob('/tmp/freshdb-1/**/*.sqlite', recursive=True))[0]
c = sqlite3.connect(db)
print(c.execute("select count(*) from sqlite_master where type='table'").fetchone())
print([r[1] for r in c.execute("pragma table_info(operator_sessions)")])
PY
```

Expect 23 application tables and `credential_hash` in the column list. A second `init()` must be a
no-op; running the health check twice verifies that.

---

## 4. Applying to an existing (staging) database

1. Take an export first (§5). Do not migrate a database you cannot restore.
2. Record the current table and index counts.
3. Deploy the Worker (or run `wrangler dev --remote` against staging if the environment allows it).
4. Hit `/api/health` once and confirm 200.
5. Re-count tables and indexes; the delta must equal exactly the objects listed in §2.
6. Confirm that existing owners can still sign in. An owner with no `owner_totp` row is unaffected —
   MFA is only enforced once `confirmed_at` is set.

There is no down-migration. Rolling back means restoring the export from step 1. The new tables are
additive and can simply be left in place if a code rollback is needed.

---

## 5. Backup and export

```bash
# whole database, staging or production
npx wrangler d1 export <database-name> --remote --output backup-$(date +%Y%m%dT%H%M%SZ).sql
```

Rules:

- Never overwrite an existing backup file. Timestamp every export.
- Store exports **outside** the Cloudflare account. An export that only lives in the same place as
  the database is not a backup.
- A production export has **not** been taken in this session: it is blocked by account ownership
  (blocker B-4). That is the single most important outstanding operational item.

---

## 6. Restoring

```bash
npx wrangler d1 execute <database-name> --remote --file backup-YYYYMMDDTHHMMSSZ.sql
```

Order matters on a partial restore: base tables before the Stage 17B tables, because
`operator_sessions.credential_hash` is an `ALTER`. Restoring a full export handles the order for you.

After restore:

1. `GET /api/health` → 200.
2. Sign in as an owner. If MFA was enabled, the seed decrypts with the **same** `MFA_ENC_KEY` /
   `ADMIN_SECRET` that was in use when it was written. A changed key means affected owners must
   re-enroll — expected, and the operator-assisted path is documented in
   `DISASTER_RECOVERY_RUNBOOK.md`.
3. All operator sessions from before the restore will still be valid if the restored
   `credential_hash` matches the current `OPERATOR_PASSWORD`; rotate the password if that is not
   intended.

---

## 6a. Restore drill — measured 2026-11-22

Executed against a disposable database created for the release-candidate pass (never staging or
production):

| Step | Result |
| --- | --- |
| Dump all app tables to SQL | 23 tables, 68 rows |
| Import into an empty database | 23 tables, 68 rows, 1 order, 1 confirmed MFA seed, 6 `auth_events` |
| `PRAGMA integrity_check` | `ok` |
| `PRAGMA foreign_key_check` | no rows |
| Boot the Worker on the restored file | `/api/health` 200, menu 200, password accepted → `mfaRequired` (proves the seed decrypts under the same key) |

This is a **local** drill. A staging backup has not been restored in this pass and a production
backup does not exist yet (blocker B-4).

## 7. Lost second factor

If an owner loses both their authenticator and their recovery codes:

1. An operator sets `owner_totp.confirmed_at = NULL` for that café (or deletes the row).
2. The next login is password-only and the owner re-enrolls immediately.
3. Invalidate the café's sessions (`auth_version` bump) as part of the same change.

This path exists deliberately, so it must be protected by operator authentication — which it is.
Log the action; `auth_events` will show the subsequent re-enrollment.

## 7a. Measured CPU and R2 status (2026-11-22)

A temporary probe Worker recorded 65/67/68 ms for a correct password and 53/62/67 ms for a wrong one
on the real Workers runtime. Those are **elapsed wall-clock timings, not platform-reported CPU time**,
so they do not establish CPU consumption and cannot by themselves prove or disprove the Workers Free
10 ms per-request ceiling. Argon2id remains at `m=19456, t=2, p=1`. **Workers Free compatibility is
unresolved** until actual CPU time is measured in the deployed runtime; the parameters must not be
weakened to obtain a passing result.

R2 is disabled on the Cloudflare account (error 10042). The bucket `corner-cup-images` cannot be
created until the account owner enables R2 in the Dashboard. The binding is declared in
`wrangler.jsonc` and validated by dry-run.

**Production D1 existence and current status remain unresolved.** `wrangler d1 list` on the currently
authenticated account shows only `corner-cup-staging` and a restore test database
(`corner-cup-stage11-restore-20261119T155325Z`). Stage 16A previously identified a production database
`site-6e1c6f7a9a9f4e098f778f9754221b0a` (ID `17d9568d-52fd-48c2-8761-b74d97688589`) under a different
Freebuff account, which that check could not reach. The absence of a listing does not establish that
the database was deleted or does not exist. No production export or backup has been obtained; account
ownership and access must be confirmed with Freebuff support or the account owner.

## 8. What a D1 export does not contain: R2 objects

A D1 export is a complete copy of the **database**, and of nothing else. Menu photographs live in the
R2 bucket bound as `IMAGES` (`corner-cup-images`) and are referenced by `menu_items.image_key`.

Consequences to plan for:

1. **A database restore alone loses every uploaded photo.** The rows come back pointing at keys that
   still exist only if the bucket survived. The menu degrades to category defaults with no error.
2. **Back up the objects separately.** Either keep versioning on the bucket, or copy the objects out:
   `wrangler r2 object get corner-cup-images <key> --file <path>` per key, or a bulk copy with an
   S3-compatible client using an R2 API token. Record the export date with the D1 dump; restore them
   as a pair.
3. **A photo can be orphaned safely.** Upload writes the object before the pointer and deletes the
   object after the pointer is cleared, so the only inconsistency a crash can create is an
   unreferenced object — never a row pointing at nothing that was just uploaded. Orphans are listed
   by comparing bucket keys with `menu_items.image_key` and can be deleted.
4. **Removing the binding is a valid emergency action.** Photos fall back to category defaults; the
   objects stay in the bucket and can be re-attached later.
5. **Bucket creation is not part of a restore.** A new deployment needs
   `wrangler r2 bucket create corner-cup-images`; the binding itself is declared in `wrangler.jsonc`.

The measured restore drill in §6a covers the database only, which is why this section exists.

---

## 9. Backup export drill — 2026-11-23 (disposable database only)

The full off-account backup procedure was executed against the **local disposable** database; no
staging or production database was read or written.

| Step | Command | Result |
| --- | --- | --- |
| Export | `wrangler d1 export corner-cup --local --output <file>` | 49,592 bytes |
| Checksum | `sha256sum` | `673256ef40dc1925c1f5a0e768abde51214703bd717fa264f2b6aca9db364773` |
| Encrypt | `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt` | 49,616 bytes |
| Decrypt | `openssl enc -d` | byte-identical to the export (`cmp` clean), SHA-256 matched |
| Restore proof | import decrypted SQL into fresh SQLite | 24 tables, `integrity_check = ok`, `foreign_key_check` 0 rows |
| Hygiene | plaintext decrypted copy deleted | only the checksum log retained |

Use this exact sequence for the production export once account access exists, keep the passphrase
separate from the encrypted file, and record which `MFA_ENC_KEY` was active. R2 objects are still not
covered by a D1 export — copy them separately as described in §8.
