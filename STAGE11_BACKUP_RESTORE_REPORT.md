# Stage 11 — Staging Database Backup & Restore Drill

**Date:** 2026-11-19
**Scope:** `corner-cup-staging` D1 → external SQL export → isolated restore database → read-only comparisons.
**Production:** not accessed, not modified, not deployed.
**Original staging database:** read-only during this drill (export and `SELECT` only; no migrations, writes, orders, payments, or auth changes).
**Final status:** **PASS**

---

## 1. Procedure used

The repository's documented procedure in `OPERATIONAL_READINESS.md` §1 was followed:

1. Export the deployed database with `wrangler d1 export … --remote`.
2. Store the artifact outside the repository and record timestamp, size, and checksum.
3. Create a fresh isolated D1 database as the restore target.
4. Import the SQL artifact with `wrangler d1 execute … --remote --file`.
5. Compare schema and aggregate data per table.
6. Keep the restore target and the backup artifact; delete nothing.

No new backup process was invented. The documented `--local` variant was not used because the source is the deployed staging database; `--remote` is the documented variant for that case.

## 2. Source and target identities

| Role | Database name | Database ID | Region | Tables | Size |
|---|---|---|---|---|---|
| Source | `corner-cup-staging` | `39a7899c-0130-4536-9570-f07b6c29b2d4` | APAC | 19 | 241,664 bytes |
| Restore target | `corner-cup-stage11-restore-20261119T155325Z` | `2399a1f7-2e26-49bc-89a7-21256439a014` | APAC | 19 | 241,664 bytes |

The restore target was created solely for this drill. No Worker binding, secret, route, or deployment was pointed at it. The staging Worker configuration (`wrangler.staging.jsonc`) was not changed.

## 3. Backup artifact

| Property | Value |
|---|---|
| Location | `C:\Users\rahil\corner-cup-backups\stage11-20261119T155325Z\corner-cup-staging_20261119T155325Z.sql` |
| Export started | 2026-11-19T15:53:25Z |
| Export completed | 2026-11-19T15:53:42Z |
| Method | `npx wrangler d1 export corner-cup-staging --remote --config wrangler.staging.jsonc` |
| Size | 16,553 bytes |
| SHA-256 | `e2a6afe6efa661f5f6a18cd9498f1a7a1c6dcda816e6c8d8077d8a602f3e0c8c` |
| Contents | `PRAGMA defer_foreign_keys=TRUE;`, 19 `CREATE TABLE`, 18 `CREATE INDEX`, 1 `CREATE TRIGGER`, 49 `INSERT INTO` statements |

The artifact is stored outside the repository. It was preserved; no cleanup or deletion was performed. It contains production-like staging data (including hashed credentials and contact fields), so it must be treated as sensitive and kept out of source control and chat.

## 4. Restore procedure and result

```bash
npx wrangler d1 create corner-cup-stage11-restore-20261119T155325Z
npx wrangler d1 execute corner-cup-stage11-restore-20261119T155325Z \
  --remote \
  --file "C:/Users/rahil/corner-cup-backups/stage11-20261119T155325Z/corner-cup-staging_20261119T155325Z.sql" \
  --yes
```

Result:

- 92 queries executed successfully.
- 272 rows read, 215 rows written, 8.43 ms SQL duration.
- 19 tables created.
- Database size after import: 241,664 bytes.
- No Worker or application connected to the restored database.

A second export of the restored database produced a **byte-for-byte identical** file: 16,553 bytes and SHA-256 `e2a6afe6efa661f5f6a18cd9498f1a7a1c6dcda816e6c8d8077d8a602f3e0c8c`.

## 5. Verification method

- Remote exports were written to the external backup directory.
- Both SQL artifacts were imported into local, disposable SQLite databases (`backup-local.db`, `restored-local.db`) outside the repository.
- Schema was compared by hashing ordered `sqlite_master` rows (`type,name,tbl_name,sql`).
- Each table's row count and full-row content hash were computed independently from each local import; row values were hashed in memory and never printed.
- Order, menu, membership, session, and item aggregates were compared independently.
- `PRAGMA integrity_check` was run on both local imports.
- The restored database was also exported directly from D1 and compared to the original artifact by size and SHA-256.

Because Wrangler's `--json` multi-statement output returned only the first result set, the detailed aggregate comparison was run against the local SQLite imports of the two exports. The restored remote export was byte-identical to the source export, so this is a comparison of the same verified content, not a substitute for the restore.

## 6. Schema and migration comparison

| Check | Source backup | Restored database | Match |
|---|---|---|---|
| User tables | 19 | 19 | ✅ |
| Indexes (non-auto) | 21 | 21 | ✅ |
| Triggers | 1 | 1 | ✅ |
| `PRAGMA user_version` | 0 | 0 | ✅ |
| Schema hash (ordered `sqlite_master`) | `904e475225977735c2bdd60964d7ba9ef51365ff753262e66af6fd6b32ef7918` | same | ✅ |
| `PRAGMA integrity_check` | `ok` | `ok` | ✅ |

Tables present in both: `auth_mode_transitions`, `cafe_owners`, `cafes`, `checkout_claims`, `csrf_tokens`, `menu_items`, `operator_audit`, `operator_sessions`, `order_items`, `orders`, `owner_claims`, `owner_identities`, `owner_login_states`, `owner_sessions`, `password_resets`, `provider_revocations`, `rate_limits`, `tables`, `tx_guard`.

There is no dedicated migrations table in this schema; migration history is represented by the additive schema objects and column set in `worker/db.js`. The ordered schema hash and object counts match exactly, including the `cafes_auth_mode_generation_step` trigger and the owner-auth/session indexes.

## 7. Record counts

| Table | Rows |
|---|---:|
| `cafes` | 1 |
| `tables` | 8 |
| `menu_items` | 27 |
| `orders` | 2 |
| `order_items` | 3 |
| `checkout_claims` | 2 |
| `rate_limits` | 2 |
| `password_resets` | 0 |
| `csrf_tokens` | 0 |
| `operator_sessions` | 0 |
| `owner_sessions` | 0 |
| `owner_identities` | 0 |
| `cafe_owners` | 0 |
| `owner_login_states` | 0 |
| `auth_mode_transitions` | 0 |
| `operator_audit` | 0 |
| `tx_guard` | 0 |
| `owner_claims` | 0 |
| `provider_revocations` | 0 |

All counts match between source and restored. Per-table full-row content hashes also match for all 19 tables; zero mismatches.

## 8. Order, item, menu, and membership aggregates

| Metric | Source | Restored | Match |
|---|---:|---:|---|
| Orders | 2 | 2 | ✅ |
| Orders total (`total_cents`) | 43,000 | 43,000 | ✅ |
| Orders with `queue_no` present | 2 | 2 | ✅ |
| Sum of `queue_no` | 3 | 3 | ✅ |
| Orders with `table_id` present | 2 | 2 | ✅ |
| Orders with `payment_method = 'counter'` | 2 | 2 | ✅ |
| Orders with `track_nonce` present | 2 | 2 | ✅ |
| Orders with `track_hash` present | 2 | 2 | ✅ |
| Order items | 3 | 3 | ✅ |
| Sum of item quantity | 6 | 6 | ✅ |
| Sum of `price_cents * qty` | 43,000 | 43,000 | ✅ |
| Orphan order items (no matching order) | 0 | 0 | ✅ |
| Menu categories (distinct) | 5 | 5 | ✅ |
| Menu items | 27 | 27 | ✅ |
| Available menu items | 27 | 27 | ✅ |
| `cafe_owners` rows | 0 | 0 | ✅ |
| `owner_identities` rows | 0 | 0 | ✅ |
| `owner_sessions` rows | 0 | 0 | ✅ |

Distributions:

- Order status: `new` = 2.
- Payment status: `unpaid` = 2.
- Payment method: `counter` = 2.
- Café auth mode: `local` = 1.
- Owner roles: none (`cafe_owners` empty).

Counter/queue and dine-in/table fields both survive the round trip on the same two orders; guest tracking fields (`track_nonce`, `track_hash`) are present on both and their row content hashes match. No guest token, password hash, contact value, or other sensitive field was printed.

## 9. Discrepancies and failed checks

**None.** All 19 table counts, all 19 full-row content hashes, the schema hash, index/trigger counts, `user_version`, order/item aggregates, status/payment distributions, and integrity checks matched.

No check was skipped. Signature-style byte comparison of the source and restored exports also matched exactly.

## 10. Recovery limitations

1. **Manual export only on Free:** this D1 is on the Free plan; recovery point is the last successful export. There is no verified point-in-time recovery in this drill.
2. **Backup sensitivity:** the SQL artifact contains staging data, including password hashes, contact fields, order records, and tracking fields. It must remain outside source control and be access-controlled. It was not printed or transmitted.
3. **Restore target retained:** `corner-cup-stage11-restore-20261119T155325Z` remains in place and is not bound to a Worker. It is an isolated drill artifact and should not receive application traffic.
4. **Local SQLite copies:** `backup-local.db` and `restored-local.db` were created outside the repository for comparison. They are disposable drill artifacts and were not connected to any application.
5. **No application boot:** the restored database was not exercised through `ensureDb()` or the Worker. Schema completeness was verified against the source export, not by booting the app against the target.
6. **Drill scope:** this proves the backup artifact restores into D1 with matching schema and data. It does not prove a full production recovery runbook (DNS, Worker version rollback, secret rotation) end to end.

## 11. Final status

**PASS**

- Backup exported successfully and preserved externally.
- Isolated restore completed successfully.
- Schema, indexes, trigger, migration state, record counts, content hashes, order/queue/table/tracking fields, order-item relationships, and payment/status distributions all match.
- No production database access or changes.
- No staging database writes, migrations, Worker deployment, order creation, payment activity, or authentication changes.
- No existing database or backup artifact was deleted.
- No Git mutations were performed.
