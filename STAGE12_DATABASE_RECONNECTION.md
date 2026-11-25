# Stage 12 — Database Reconnection Procedure

**Date:** 2026-11-20
**Scope:** documented procedure only. No binding was changed, no deployment was made, no migration was run,
no database was written, and no production resource was contacted.
**Companions:** `STAGE12_CONFIGURATION_RECOVERY.md`, `DISASTER_RECOVERY_RUNBOOK.md`,
`STAGE11_BACKUP_RESTORE_REPORT.md`.

---

## 1. When this procedure applies

Use it after a restore has produced a **new, separate** D1 database that holds recovered data, and the
application must be pointed at it. It covers rebinding, validating, and backing out.

It does **not** cover the restore itself (create database → import export → compare), which is Stage 11's
verified procedure and is summarised in `DISASTER_RECOVERY_RUNBOOK.md` §2.

Two rules govern everything below:

1. **A restore target is not automatically a recovery target.** Stage 11's
   `corner-cup-stage11-restore-20261119T155325Z` is a drill artifact. It must never receive application traffic
   or a binding; it exists to prove the backup works.
2. **Never rebind by editing a running deployment's database in place.** Change the repository's
   `database_id`, review it, deploy, then verify. The config file is the audit trail.

## 2. Step 1 — Identify the correct restored database

```bash
npx wrangler d1 list
```

Record, and refuse to continue until all four match the restore runbook's record:

| Field | Must be |
|---|---|
| `name` | The name chosen at restore time, e.g. `corner-cup-restore-20261201T090000Z` |
| `uuid` | The id printed by `wrangler d1 create` during that restore |
| `created_at` | The restore window, not "today by accident" |
| `version`/`num_tables` | 19 user tables for this schema |

Then confirm the database is not already in use:

```bash
grep -rn "database_id" wrangler*.jsonc
```

The candidate id must appear in **no** config file yet. If it does, either the rebind already happened (check
`wrangler deployments list`) or the wrong database was created.

## 3. Step 2 — Verify its identity before connecting anything

Still read-only, still no binding. Four independent checks:

```bash
# 3.1 Object inventory — expect 19 user tables (+ sqlite_sequence), 21 non-auto indexes, 1 trigger
npx wrangler d1 execute <RESTORE_DB> --remote --json \
  --command "SELECT type, count(*) FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' GROUP BY type"

# 3.2 Integrity
npx wrangler d1 execute <RESTORE_DB> --remote --json --command "PRAGMA integrity_check"

# 3.3 The café identity — the row the application will actually serve
npx wrangler d1 execute <RESTORE_DB> --remote --json \
  --command "SELECT id, slug, service_mode, tz_offset_min, owner_auth, auth_version FROM cafes"

# 3.4 Volume — must match the incident's last known good numbers
npx wrangler d1 execute <RESTORE_DB> --remote --json \
  --command "SELECT (SELECT count(*) FROM menu_items) AS menu, (SELECT count(*) FROM orders) AS orders, (SELECT count(*) FROM order_items) AS items, (SELECT coalesce(sum(total_cents),0) FROM orders) AS cents"
```

Cross-check 3.3/3.4 against the backup manifest written at export time. `slug` is the tenant boundary: if it is
not the expected slug, every guest and staff URL will 404 and you are looking at the wrong database.

Do not proceed if `PRAGMA integrity_check` is anything other than `ok`, or if the café row is missing (an empty
database will be seeded with `CAFE_NAME`/`SERVICE_MODE` from the config on first request — that is a different
recovery, not this one).

## 4. Step 3 — Update the environment's D1 binding

Edit only the `database_id` of the `DB` entry in the config for the affected Worker:

```jsonc
"d1_databases": [
  {
    "binding": "DB",                 // never rename: application code reads env.DB
    "database_name": "<restore db name>",
    "database_id": "<restore db uuid>"
  }
]
```

Rules:

- Leave `binding: "DB"` alone. Renaming it breaks every query in `worker/`.
- Update `database_name` too, so a future reader cannot mistake the old name for the live target.
- If a maintenance stub config exists for the environment (`wrangler.staging-maint.jsonc`), update it in the
  same change. A rollback that points the stub at the old, damaged database is worse than no rollback.
- Never edit `wrangler.jsonc` (production) as part of a staging recovery, or the reverse.
- Review with `git diff -- <config>` before deploying. The diff must be exactly two lines per config.

Then deploy the unchanged application:

```bash
npm ci
npm run build
npx wrangler deploy --dry-run --config <config>   # expect env.DB → <restore db name>
npx wrangler deploy --config <config>
```

## 5. Step 4 — Validate schema and migrations

The application self-migrates on the first `/api/*` request (`ensureDb()` in `worker/db.js`): `SCHEMA`,
`MIGRATIONS` (duplicate-column tolerant), `POST_MIGRATIONS`, the idempotency index, then first-boot seeding.
That means **the first request is a write**, and validation must expect it.

Sequence:

1. **Before the first request**, record the schema hash so any change is attributable:

   ```bash
   npx wrangler d1 export <RESTORE_DB> --remote --output pre-boot.sql
   # (hash it; keep it outside the repository)
   ```

2. `GET /api/health` — one request, one isolate. Expect `{"status":"ok","database":"ok"}`.
3. **After boot**, compare:

   ```bash
   npx wrangler d1 export <RESTORE_DB> --remote --output post-boot.sql
   ```

   Expected on a healthy restore: **identical schema** (all `CREATE … IF NOT EXISTS` are no-ops, duplicate
   `ADD COLUMN`s are skipped), **unchanged row counts** for `cafes`, `menu_items`, `orders`, `order_items`,
   `tables`, `checkout_claims`, and at most the app's own housekeeping writes — expired `rate_limits` rows are
   pruned opportunistically (`cleanupExpiredRateLimits`, `worker/api.js`). Stage 12's local compatibility run
   observed exactly that and nothing else.
4. Check the artisan invariants directly:

   ```bash
   npx wrangler d1 execute <RESTORE_DB> --remote --json --command \
     "SELECT (SELECT count(*) FROM orders WHERE id NOT IN (SELECT order_id FROM order_items)) AS orders_without_items,
             (SELECT count(*) FROM order_items WHERE order_id NOT IN (SELECT id FROM orders)) AS orphan_items,
             (SELECT count(*) FROM orders WHERE queue_no IS NOT NULL AND table_id <> 0) AS bad_counter_rows"
   ```

   `orders_without_items` is 0 for the current staging data set; `orphan_items` must always be 0.

5. Confirm the newer schema objects exist: `idx_orders_idempotency_key` (partial unique) and the
   `cafes_auth_mode_generation_step` trigger. Missing either one means the restore predates them and the
   application will apply them on boot — acceptable, but it must be recorded, because ordering is disabled when
   the idempotency index cannot be created.

## 6. Step 5 — Verify application compatibility

Read-only requests first, in this order, recording status and body shape:

| Check | Expect |
|---|---|
| `GET /api/health` | `200`, `status: ok`, `database: ok` |
| `GET /api/cafe` | `200`, primary café `slug` matches the restored row |
| `GET /api/cafes/<slug>/menu` | `200`, 5 categories, 27 items, prices present, `table: null` in counter mode |
| `GET /api/cafes/<slug>/tables` | `200`, 8 tables |
| `GET /api/cafes/<slug>/config` | `200`, `payments.provider` matches the secrets present, `ownerAuth` matches `cafes.owner_auth` |
| `GET /c/<slug>/menu` | `200`, SPA HTML (asset binding intact) |
| `GET /api/cafes/unknown-slug/menu` | `404` — the tenant boundary did not widen |

Then, only with explicit approval, the stateful paths: staff sign-in (needs `ADMIN_SECRET` + a password hash),
one order, one payment. Stage 12 did none of these and treated them as out of scope.

## 7. Step 6 — Roll back the binding if validation fails

Rollback is config-level and fast. Do it as soon as a check fails; do not debug against the live binding.

1. **Restore the previous config** from Git (`git checkout -- <config>` is a mutation — prefer
   `git show <rev>:<config>` written to a temporary file and diffed, then edited back by hand under review).
2. Redeploy the previous configuration: `npx wrangler deploy --config <config>`.
3. If code was also deployed, roll back the version instead, which restores code and bindings together:
   `npx wrangler deployments list --config <config>` → `npx wrangler rollback <deployment-id> --config <config>`.
4. If the environment must be taken fully offline while it is sorted out, deploy the maintenance stub
   (`wrangler deploy --config wrangler.staging-maint.jsonc`): 503 on every route, D1 still bound, no data touched.
5. Leave the failed restore database in place. It is evidence. Do not delete it while the incident is open.
6. Record which checks failed, at which step, with the exact response bodies (minus secrets).

**Rollback restores routing, not data.** If the failed validation wrote into the restore database, that database
is now divergent. Either re-import the export into a fresh database and start again, or accept and document the
divergence.

## 8. Checklist (copy into the incident record)

- [ ] Restore database identified by name, id, creation time, table count.
- [ ] Candidate id absent from every config before the change.
- [ ] `integrity_check` = `ok`; 19 user tables; 1 trigger; `user_version` recorded.
- [ ] Café row present with the expected `slug`; counts match the backup manifest.
- [ ] Only `database_name` + `database_id` changed, in every config for that environment that binds `DB`.
- [ ] `--dry-run` shows `env.DB` → the restore database.
- [ ] Pre-boot export taken; post-boot schema compared; housekeeping writes explained.
- [ ] Read-only compatibility checks all pass.
- [ ] Stateful checks (if approved) recorded separately.
- [ ] Previous config / deployment id recorded for rollback **before** deploying.
- [ ] Incident record updated with every command run.
