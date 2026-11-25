# Stage 12 — Operational Recovery Readiness Report

**Date:** 2026-11-20
**Scope:** Worker configuration inventory, database reconnection procedure, backup/retention policy,
local compatibility test against the Stage 11 restore, and a disaster-recovery runbook.
**Production:** not accessed, not changed. No Cloudflare API call was made in this stage — every Wrangler
command used was `--local`.
**Staging database and Worker:** not contacted, not changed.
**Stage 11 restore database:** not contacted, not changed.
**Final rating:** **PARTIAL PASS**

---

## 1. Deliverables

| Document | Covers |
|---|---|
| `STAGE12_CONFIGURATION_RECOVERY.md` | Phase 1 — full configuration inventory + recovery checklist |
| `STAGE12_DATABASE_RECONNECTION.md` | Phase 2 — identify, verify, rebind, validate, roll back |
| `STAGE12_BACKUP_POLICY.md` | Phase 3 — frequency, retention, storage, encryption, RPO/RTO, drills |
| `DISASTER_RECOVERY_RUNBOOK.md` | Phase 5 — the eight-section operational runbook |
| `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` | Phase 6 — this report |
| Local harness (gitignored) | Phase 4 — `.wrangler/stage12-compat/wrangler.jsonc` and its state |

Nothing in the repository's application code, configuration files, tests or `package.json` was modified.

## 2. Completed recovery capabilities

1. **Configuration is fully inventoried and recoverable from Git.** Worker names, entry points, D1 bindings,
   compatibility date, WASM/asset rules, variables, secret *names* and external dependencies are recorded with
   integrity hashes for the three config files.
2. **Config integrity is provable.** The staging config hash `7f59ffc197d3…5718` matches the value recorded
   before the Stage 6 deployment, so the configuration serving staging has not drifted.
3. **Database restore is proven.** Stage 11 restored staging into an isolated D1 with matching schema hash,
   19/19 table counts, 19/19 full-row hashes, aggregates and `integrity_check`, and a byte-identical re-export.
4. **The restored data is application-compatible.** Phase 4 below exercised the real Worker against a local
   copy of that restore: the app boots, serves menu/tables/config from restored rows, creates no duplicate seed
   data, and leaves 18 of 19 tables byte-identical after boot.
5. **Rebinding has a documented, reversible procedure** with pre-conditions that prevent binding a drill
   database, and three rollback levers (version rollback, config revert, maintenance stub).
6. **A usable runbook exists** with declaration/scope, database recovery, Worker recovery, secret restoration
   without value exposure, routing, post-recovery verification, rollback and an incident-record template.
7. **Failure modes are named.** Secret-loss consequences (staff sessions, guest tracking links, in-flight
   WorkOS logins, webhook signatures) are documented before anyone rotates a key in a panic.

## 3. Incomplete capabilities

| Capability | State | Why it matters |
|---|---|---|
| Scheduled/automated backups | **Not implemented** | RPO is "whenever someone last remembered". Policy only. |
| Off-device backup copy | **Not implemented** | One laptop disk failure loses every recovery point. |
| Encryption of backup artifacts | **Not implemented** | Stage 11's 16.5 KB artifact is plaintext SQL containing password hashes and contact data. |
| Retention/rotation | **Not implemented** | One artifact exists; nothing prunes, nothing enforces a floor of three. |
| Automated checksum re-verification | **Not implemented** | Rot would go unnoticed until a real restore. |
| Worker redeploy drill (config recovery end to end) | **Not executed** | §3 of the runbook is documented, not exercised. |
| Secret restoration drill | **Not executed** — and the live secret inventory was deliberately not queried | A "recovered" Worker can pass health checks while sign-in and ordering still answer 503. |
| Production recovery | **Not possible as configured** | `wrangler.jsonc` still carries the placeholder D1 id `00000000-…`; production has never been deployed. |
| RTO end-to-end | **Estimated, not measured** | Only the database-only path has real numbers. |
| DNS/custom-domain recovery | **Not applicable today** (no routes/domains) | Becomes a gap the moment a custom domain is added. |
| WorkOS/Razorpay recovery paths | **Unverified** | Both sandboxes remain unvalidated from earlier stages. |

## 4. Configuration inventory (summary)

Full detail in `STAGE12_CONFIGURATION_RECOVERY.md`.

| Item | Value |
|---|---|
| Workers | `corner-cup` (not deployed), `corner-cup-staging` (deployed), staging maintenance stub (not deployed) |
| Environments | No `env` blocks — each config file is a complete environment; "environments" are separate Workers |
| Entry points | `worker/index.js` (application), `.staging-maint/index.js` (503 stub) |
| D1 binding | `DB` everywhere — application contract, must not be renamed |
| D1 ids | production: `00000000-0000-0000-0000-000000000000` (**placeholder**); staging: `39a7899c-0130-4536-9570-f07b6c29b2d4`; Stage 11 drill: `2399a1f7-2e26-49bc-89a7-21256439a014` (unbound) |
| Compatibility | `2025-11-01` everywhere; **no** `compatibility_flags` |
| Build/runtime rules | `CompiledWasm` on `**/*.wasm` with `fallthrough: true` (Argon2id binaries) |
| Assets | `./dist`, binding `ASSETS`, SPA fallback, `run_worker_first: true` (stub has none) |
| Variables | `CAFE_NAME`, `SERVICE_MODE`, `CAFE_TZ_OFFSET_MIN` (first-boot values only; database wins afterwards) |
| Routes / custom domains | **None** — `workers.dev` only: `https://corner-cup-staging.rahilbisen8.workers.dev` |
| Required secret | `ADMIN_SECRET` (absent → staff sign-in, operator console and order creation 503) |
| Feature secrets (names only) | `OPERATOR_PASSWORD`, `OWNER_PASSWORD`, `ORDER_TRACK_SECRET`, `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_ISSUER`, `WORKOS_AUDIENCE`, `WORKOS_STATE_ENCRYPTION_KEY`, `WORKOS_API_BASE`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_OWNER_CHAT_ID` |
| External dependencies | Cloudflare Workers + D1 (required); WorkOS, Razorpay, Telegram (feature-gated, all free-tier) |
| Config hashes | `wrangler.jsonc` `3df6a29e…96a0`, `wrangler.staging.jsonc` `7f59ffc1…5718`, `wrangler.staging-maint.jsonc` `58c011dc…2084` |
| Toolchain | Node `v26.13.1`, Wrangler `4.158.0` |

No secret value was read, printed, copied or modified. `wrangler secret list` was deliberately not run, so this
inventory proves what the code *requires*, not what currently exists on the deployed Worker.

## 5. Database recovery procedure (summary)

Documented in full in `STAGE12_DATABASE_RECONNECTION.md`; the operational sequence is in
`DISASTER_RECOVERY_RUNBOOK.md` §2.

1. **Triage** — `PRAGMA integrity_check` plus café/menu/order counts to separate data damage from routing or
   secret problems, and to avoid restoring during a provider outage.
2. **Select the artifact** — newest export older than the damage; verify SHA-256, 19 `CREATE TABLE`, non-zero
   `INSERT INTO`.
3. **Restore into a new database** — `d1 create` then `d1 execute --remote --file`; never import over the live
   database; keep the damaged one for evidence.
4. **Verify identity** — name, uuid, creation time, table count first; then `integrity_check`, café slug, and
   counts/totals against the manifest. Re-export and compare hashes.
5. **Rebind** — change only `database_name` + `database_id`, in every config that binds `DB` for that
   environment (including the maintenance stub), after a `--dry-run` that shows the new target.
6. **Validate** — pre-boot export, one `/api/health`, post-boot export; expect identical schema, unchanged row
   counts, and only the app's own housekeeping writes.
7. **Roll back if validation fails** — version rollback or config revert; maintenance stub as the safe state;
   never iterate on a live binding.

## 6. Backup and retention recommendations

Full rationale in `STAGE12_BACKUP_POLICY.md`. All of it is **proposed**; none of it is automated.

| Area | Recommendation |
|---|---|
| Frequency | Before every migration/deploy (mandatory), weekly routine, before any risky manual SQL |
| Retention | 14 daily, 8 weekly, 6 monthly, floor of 3 verified artifacts, one of them off-device |
| Storage | Outside the repository; primary local directory + second physical device; optional encrypted free-tier cloud copy |
| Integrity | SHA-256 + byte size + row counts in an append-only `MANIFEST.txt`; monthly re-hash of every retained artifact |
| Restore proof | Quarterly isolated restore comparison using the Stage 11 method; twice-yearly full recovery rehearsal |
| Encryption | BitLocker on the host; `7z -p -mhe=on` or `age -p` before any copy leaves the machine; passphrase in a password manager, never beside the archive |
| Access control | Operator OS account only, no shared/synced folders, never in Git/chat/tickets, SQL-and-hashes when inspecting |
| Cost | Zero. No paid product is required; the optional cloud copy uses a free allowance and is never the only copy |
| Automation (optional) | Local scheduled task first; CI-scheduled export only as an explicit decision, because it creates a standing Cloudflare token |

Current reality, stated plainly: **one plaintext artifact on one laptop, taken by hand, with a recorded
checksum and no schedule.**

## 7. RPO / RTO

| Objective | Proposed | Actually achieved today |
|---|---|---|
| RPO — routine | ≤ 7 days | Time of the last manual export (Stage 11: 2026-11-19T15:53Z) |
| RPO — before a change | 0 (same-session export) | Followed for the one change that was backed up; not enforced by tooling |
| RPO — with automation | ≤ 24 hours | Not applicable — no automation exists |
| RTO — database only | ≤ 30 minutes | Evidence: export 17 s, import 92 statements / 8.4 ms, verification minutes. **Measured once.** |
| RTO — database + Worker | ≤ 60 minutes | **Estimated.** Worker redeploy + secret restoration has never been rehearsed. |
| RTO — with secret loss | Same day | Not measured; depends on WorkOS/Razorpay re-issuance. |

## 8. Compatibility test results (Phase 4)

### 8.1 Why this was safe

The test ran **entirely locally**: a dedicated config with a **local-only** D1 binding, a dedicated persistence
directory, loopback port 8799, and no `.dev.vars` beside the config. It therefore ran with **no application
secrets at all**. No Worker was deployed, no binding was changed, no remote D1 was contacted, and the Stage 11
restore database was never pointed at by anything.

Harness: `.wrangler/stage12-compat/wrangler.jsonc` (gitignored), `database_id`
`11111111-1111-4111-8111-111111111111` (a local placeholder that D1 never sees), seeded from
`corner-cup-staging_20261119T155325Z.sql` (16,553 bytes, SHA-256 `e2a6afe6…0c8c`) via
`wrangler d1 execute DB --local --persist-to .wrangler/stage12-compat/persist --file …` → **92 statements
succeeded**.

### 8.2 Seed fidelity (proves the copy equals the verified restore)

| Check | Local compat copy | Stage 11 verified import | Match |
|---|---|---|---|
| User tables | 19 (+`sqlite_sequence`) | 19 | ✅ |
| Indexes | 33 total (21 non-auto + 12 auto) | 21 non-auto | ✅ |
| Triggers | 1 (`cafes_auth_mode_generation_step`) | 1 | ✅ |
| `PRAGMA user_version` | 0 | 0 | ✅ |
| Ordered `sqlite_master` hash | `ce012fc9…9a80` | `ce012fc9…9a80` | ✅ |
| Row counts, all 19 tables | identical | identical | ✅ |
| `PRAGMA integrity_check` | `ok` | `ok` | ✅ |

(The `ce012fc9…` hash is computed with the Stage 12 query
`SELECT type||'|'||name||'|'||tbl_name||'|'||ifnull(sql,'') FROM sqlite_master ORDER BY type,name`; Stage 11's
`904e47…` used a different serialisation of the same objects, so only like-for-like comparisons are made.)

### 8.3 Application behaviour (8 read-only requests, no writes issued by the test)

| Request | Result |
|---|---|
| `GET /api/health` | `200`, `status=ok`, `database=ok` |
| `GET /api/cafe` | `200`, `slug=corner-cup-staging`, keys `name,serviceMode,slug` |
| `GET /api/cafes/corner-cup-staging/menu` | `200`, 5 categories, **27 items** (6/6/6/6/3), `table: null` (counter mode) |
| `GET /api/cafes/corner-cup-staging/tables` | `200`, 8 tables |
| `GET /api/cafes/corner-cup-staging/config` | `200`, keys `cafe,currency,ownerAuth,payments,service,slug`, `payments={"provider":"none","gateway":false,"keyId":null}` |
| `GET /api/cafes/unknown-slug/menu` | `404` — tenant boundary intact |
| `GET /` | `200`, SPA shell (801 bytes, `id="root"`) |
| `GET /c/corner-cup-staging/menu` | `200`, SPA deep link resolves |

Bindings reported by the local server: `env.DB` (local), `env.ASSETS`, and only the three non-secret vars —
confirming that no secret was loaded and that the test exercised fail-closed configuration.

### 8.4 Effect of application boot on recovered data

`ensureDb()` runs on the first `/api/*` request and **is a write path**. After the boot, all 19 tables were
compared row-by-row (counts + full-row SHA-256, values hashed in memory, nothing printed):

- **18 of 19 tables byte-identical**, including `cafes`, `menu_items`, `orders`, `order_items`, `tables` and
  `checkout_claims`.
- **`rate_limits`: 2 → 1.** The removed row had `expires <= now`; `cleanupExpiredRateLimits`
  (`worker/api.js`) prunes expired counters opportunistically. Expected application housekeeping, not data loss.
- Schema unchanged after boot (same ordered hash, 33 indexes, 1 trigger, `integrity_check` = `ok`) — every
  `CREATE … IF NOT EXISTS` and duplicate `ADD COLUMN` was a genuine no-op on the restored schema.
- No re-seeding occurred: still 1 café, 27 menu items, 8 tables, 2 orders, 3 order items, 2 checkout claims.

This also settles an operational question the runbook now states explicitly: **a Worker pointed at a restored
database writes to it** (migrations are no-ops, but housekeeping rows are pruned). Verification must therefore
either accept that write or run against a copy — which is what Stage 12 did.

### 8.5 Not verified (deliberately)

| Not tested | Reason |
|---|---|
| Order creation, payment, webhooks | Out of scope and forbidden by the stage constraints |
| Staff/operator/owner sign-in, sessions, AuthKit | Authentication activity is out of scope |
| Any stateful write path | Read-only compatibility only |
| The deployed Cloudflare runtime | Local `workerd` only; the Free-plan Argon2id CPU risk (Error 1102) is unchanged |
| WorkOS-managed owner auth against restored identities | No managed identities exist in this data set (`cafe_owners` = 0) |
| Guest order tracking against restored orders | Needs a token derived from `ADMIN_SECRET`/`ORDER_TRACK_SECRET`; deriving one is tracking/auth activity |

## 9. Remaining risks and blockers

| # | Risk / blocker | Severity | Notes |
|---|---|---|---|
| 1 | **No automated or scheduled backup**; RPO = last manual export | High | Free plan has no point-in-time recovery. A forgotten export is a permanent loss window. |
| 2 | **Single, unencrypted backup copy on one laptop** | High | Artifact contains password hashes and contact data; disk failure or theft loses both data and backups. |
| 3 | **No Worker redeploy drill** — config recovery is documented, not exercised | Medium | The 60-minute full-recovery RTO is an estimate. |
| 4 | **Secret inventory unverified** (deliberately not queried); Stage 6 recorded an empty list | Medium | A recovered Worker can be "healthy" (health/menu 200) while sign-in and ordering 503. Verification-by-behaviour is documented but unrun. |
| 5 | **Production is not recoverable as configured** — `wrangler.jsonc` still holds `00000000-…` | Medium | No production database id is recorded anywhere. Production has never been deployed. |
| 6 | **Stage 11 restore database is a live, unbound drill artifact** containing staging data | Medium | It must never be bound or given traffic. It needs an explicit keep/delete decision — not taken in this stage. |
| 7 | **Retention and checksum re-verification are policy only** | Medium | Bit rot would surface only during a real incident. |
| 8 | **Argon2id on Workers Free (Error 1102)** remains unmeasured on the deployed runtime | Medium | A recovery could restore everything and still break sign-in for CPU reasons. Inherited from earlier stages. |
| 9 | **WorkOS / Razorpay recovery paths unverified** | Medium | Both sandboxes remain unvalidated; a key re-issue flow has never been rehearsed. |
| 10 | **No custom-domain/DNS procedure** | Low today, High if a domain is added | No `routes`/`custom_domains` exist, so routing recovery is a no-op — and therefore untested. |
| 11 | **`wrangler deployments list` is eventually consistent** for this Worker | Low | Recovery verification must trust `deployments status` / `tail`, as Stage 6 established. |
| 12 | **Compatibility was proven locally, not on Cloudflare** | Low | Local `workerd` with no secrets; sufficient for schema/data compatibility, not for runtime limits. |

## 10. Final readiness rating

### **PARTIAL PASS**

**Why it is a pass at all**

- A complete, verifiable configuration inventory now exists, with integrity hashes, and it matches the
  configuration that is actually deployed.
- The database restore path is proven end to end once (Stage 11) and, in this stage, the restored data was
  shown to be *application*-compatible: the real Worker boots against it, serves restored café/menu/table data,
  leaves the schema untouched, does not re-seed, and changes only expired rate-limit counters.
- Reconnection, rollback, secret restoration and incident handling are documented to the level of exact commands
  with pre-conditions that prevent the dangerous mistakes (binding a drill database, importing over a live one,
  pasting secret values, deploying the placeholder production id).
- RPO/RTO/RPO-with-automation are stated as numbers with their evidence and their gaps, and the policy is
  explicitly separated from what exists.

**Why it is not a full pass**

- Nothing about backups is automated, encrypted or off-device; today's real RPO is "whenever an export was last
  taken", and there is exactly one copy on one laptop.
- No recovery path has been exercised end to end: no Worker redeploy, no secret restoration, no full RTO
  measurement. The runbook is therefore *documented*, not *proven*.
- Production cannot be recovered as configured (placeholder database id), and the staging secret state is
  unknown because it was intentionally not queried.

To reach PASS: encrypt and copy the Stage 11 artifact off-device, adopt the retention floor, run one full
recovery rehearsal on a non-production Worker (rebuild + redeploy + secrets + verify), and record a measured
end-to-end RTO.

## 11. Exactly what changed in this stage

**Created (5 documentation files):**

- `STAGE12_CONFIGURATION_RECOVERY.md`
- `STAGE12_DATABASE_RECONNECTION.md`
- `STAGE12_BACKUP_POLICY.md`
- `DISASTER_RECOVERY_RUNBOOK.md`
- `STAGE12_OPERATIONAL_RECOVERY_REPORT.md` (this file)

**Created (local, gitignored test harness, no source impact):**

- `.wrangler/stage12-compat/wrangler.jsonc` — local-only config, never deployed
- `.wrangler/stage12-compat/persist/…` — local SQLite copy of the Stage 11 restore (sensitive: contains staging
  data; kept for evidence, not encrypted)
- `.wrangler/stage12-compat/baseline/{pre-boot.sqlite,counts-*.txt}`, `.wrangler/stage12-compat/compare.mjs`,
  `.wrangler/stage12-compat/dev.log` — verification evidence
- A temporary root-level `wrangler.stage12-compat.jsonc` was written and then removed during setup; it does not
  exist now.

**Modified:** nothing. No application code, test, config, `package.json` or lockfile was edited.

**Untouched, verified:**

| Asset | State |
|---|---|
| Production Worker / `wrangler.jsonc` | Not contacted, unchanged (hash `3df6a29e…96a0`) |
| Staging Worker `corner-cup-staging` | Not contacted, not deployed; no Wrangler command touched it |
| Staging D1 `corner-cup-staging` (`39a7899c…b2d4`) | Not contacted — read or written; no export, no query |
| Staging configs | Unchanged (`7f59ffc1…5718`, `58c011dc…2084`) |
| Stage 11 restore DB (`2399a1f7…a014`) | Not contacted, not deleted, still unbound |
| Stage 11 backup artifacts | Not read for modification, not moved, not deleted |
| D1 bindings / migrations | No binding changed, no migration executed against any remote database |
| Secrets | No value read, printed, copied, set or rotated; `secret list` not run |
| Payments / authentication / orders | No payment, auth or order activity; the local test was read-only requests against a disposable copy |
| Git | No add, commit, reset, clean, checkout or discard; 0 files staged; existing modified and untracked work preserved |
| Dev server | Started on `127.0.0.1:8799`, stopped; port refuses connections afterwards |
