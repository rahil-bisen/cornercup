# Corner Cup — Disaster Recovery Runbook

**Version:** 1.0 — 2026-11-20
**Owner:** the deployment operator (single-operator project; there is no on-call rotation).
**Applies to:** the `corner-cup-staging` Worker and its `corner-cup-staging` D1 database, plus the
not-yet-deployed `corner-cup` production Worker.
**Companions:** `STAGE12_CONFIGURATION_RECOVERY.md` (inventory), `STAGE12_DATABASE_RECONNECTION.md`
(rebinding), `STAGE12_BACKUP_POLICY.md` (backups/RPO/RTO), `STAGE11_BACKUP_RESTORE_REPORT.md` (the one
measured drill), `OPERATIONAL_READINESS.md` (original procedures).

> This runbook is written to be followed under stress by one person. Each step says what to run, what to see,
> and what means stop. Record every command and every response in the incident record (§8) as you go — the
> record is part of the recovery, not paperwork after it.

---

## 1. Incident declaration and scope

### 1.1 Declare an incident when any of these is true

| Signal | Typical cause |
|---|---|
| `GET /api/health` returns non-200, or `database` is not `ok` | D1 unavailable, binding broken, bad deploy |
| Guest menu or staff board returns 500 for every café | Worker exception, schema mismatch, missing binding |
| D1 queries fail with "no such table"/"no such column" | Restore of an older schema, interrupted migration |
| Orders exist but items/permissions look wrong; totals inconsistent | Partial write, wrong database bound |
| Staff cannot sign in and `/api/health` is fine | `ADMIN_SECRET` missing/rotated, secret loss |
| A deploy is followed by errors that were not there before | Bad version is serving |
| A credential is suspected exposed | `ADMIN_SECRET`, `OPERATOR_PASSWORD`, `RAZORPAY_*`, `WORKOS_*`, GitHub/Cloudflare token |

### 1.2 Declare by writing these five lines, before touching anything

```
INCIDENT: <one sentence, observable symptom>
DECLARED: <UTC timestamp> by <operator>
LAST KNOWN GOOD: <version id or timestamp; last verified export path + sha256>
IMPACT: <who cannot do what — guests ordering? staff board? payments?>
CHANGE FREEZE: in effect (no deploys, no migrations, no binding edits until this line is lifted)
```

The freeze is the single most valuable step. Most recoveries fail because something else changed mid-incident.

### 1.3 Scope the incident before acting

Answer, in the record:

1. **Blast radius** — one café, all cafés, or the whole Worker? `/api/cafe` and one `/api/cafes/<slug>/menu`
   per café answer this in seconds.
2. **Data vs routing** — is the data still there and only the path broken (fast, low risk), or is the data
   damaged (slow, high risk)? `PRAGMA integrity_check` and a row count answer this.
3. **Which environment** — staging or production. They are separate Workers with separate configs and separate
   databases. Never fix one by editing the other's file.
4. **Did a deploy precede it?** If yes, version rollback (§7.1) is the first move, not data surgery.
5. **Is a credential involved?** If yes, §4 applies and rotation may be unavoidable.

Stop and reassess if the answer changes while you work.

---

## 2. Database recovery steps

Use when D1 is unavailable, corrupted, or must be rolled back to an earlier state. Total measured cost for this
data set: **under an hour**, most of it verification.

### 2.1 Confirm you actually need a restore

```bash
npx wrangler d1 execute corner-cup-staging --remote --config wrangler.staging.jsonc \
  --command "PRAGMA integrity_check"
npx wrangler d1 execute corner-cup-staging --remote --config wrangler.staging.jsonc \
  --command "SELECT (SELECT count(*) FROM cafes) AS cafes, (SELECT count(*) FROM menu_items) AS menu, (SELECT count(*) FROM orders) AS orders"
```

- `ok` + plausible counts → the database is probably fine; look at code, bindings or secrets instead.
- Errors, `database disk image is malformed`, or counts that contradict the staff board → continue.
- Cloudflare-side outage → check the Cloudflare status page before restoring anything. Restoring during a
  provider incident creates a second problem.

D1 has no point-in-time recovery on the Free plan. The recovery point is the last export you hold.

### 2.2 Pick the artifact

```bash
ls -la "C:/Users/rahil/corner-cup-backups/"
```

Choose the newest artifact **older than the damage** and verify it before use:

```bash
sha256sum "C:/Users/rahil/corner-cup-backups/<stamp>/corner-cup-staging_<stamp>.sql"
grep -c "CREATE TABLE" "…/corner-cup-staging_<stamp>.sql"
grep -c "INSERT INTO"  "…/corner-cup-staging_<stamp>.sql"
```

Expect 19 `CREATE TABLE` and a non-zero `INSERT INTO` count. Compare the SHA-256 with the manifest / Stage 11
record. A file that fails its hash is not a backup — go back one generation.

### 2.3 Restore into a NEW database (never over the live one)

```bash
npx wrangler d1 create corner-cup-restore-<YYYYMMDDTHHMMSSZ>
# note the uuid it prints — that is the new database_id

npx wrangler d1 execute corner-cup-restore-<stamp> --remote \
  --file "C:/Users/rahil/corner-cup-backups/<stamp>/corner-cup-staging_<stamp>.sql" --yes
```

Expect `92 queries executed successfully` for this schema. Keep the damaged database in place: it is evidence
and may be partially readable.

### 2.4 Verify before rebinding

Run every check in `STAGE12_DATABASE_RECONNECTION.md` §3. Minimum:

- `PRAGMA integrity_check` → `ok`
- 19 user tables, 21 non-auto indexes, 1 trigger, `cafes` row with the expected `slug`
- `menu_items` 27, `tables` 8, `orders`/`order_items` match the artifact's counts
- order totals (`sum(total_cents)`) match the last known good figure

Re-export the restored database and compare its SHA-256 to the source artifact. Byte equality is expected for
this schema (Stage 11 observed it); a difference is a finding to explain before rebinding.

### 2.5 Rebind and validate

Follow `STAGE12_DATABASE_RECONNECTION.md` §4–§6: edit `database_name` + `database_id` only, deploy, expect the
first `/api/*` request to run `ensureDb()` (a write — schema no-ops plus opportunistic pruning of expired
`rate_limits` rows), then run the read-only compatibility checks.

### 2.6 If the restore itself is bad

Do not iterate on a live binding. Revert the config (§7.2), take stock, and re-import into a second fresh
database. Two failed restores in a row means the artifact is wrong, not the procedure.

---

## 3. Worker configuration recovery

Use when the Worker is gone, the config drifted, or the bundle must be rebuilt. The configuration is small and
fully tracked; recovery is a checkout + build + deploy.

1. **Recover the code and config**

   ```bash
   git log --oneline -5            # find the deployed commit
   git status                      # working tree must be understood before deploying anything
   sha256sum wrangler.jsonc wrangler.staging.jsonc wrangler.staging-maint.jsonc
   ```

   Compare against `STAGE12_CONFIGURATION_RECOVERY.md` §2. If a hash differs, decide deliberately whether the
   difference is a legitimate later change (keep it) or drift (restore it). Do not "just deploy and see".

2. **Recreate the Worker shell** (only if it was deleted; a renamed Worker needs the original name back)

   ```bash
   npx wrangler deploy --config wrangler.staging.jsonc
   ```

   The Worker name determines the public URL: `corner-cup-staging` →
   `https://corner-cup-staging.rahilbisen8.workers.dev`. A different name is a different site and breaks the
   WorkOS redirect URI.

3. **Rebuild the bundle** — `dist/` is gitignored, so it must be regenerated, not restored:

   ```bash
   npm ci
   npm run build
   ls dist/index.html dist/assets
   ```

4. **Dry-run and read the bindings it prints**

   ```bash
   npx wrangler deploy --dry-run --config wrangler.staging.jsonc --outdir "<path outside repo>"
   ```

   Expect: `env.DB` → the intended database name, `env.ASSETS`, the three vars, both Argon2id `.wasm` files in
   the bundle, and no `00000000-…` id anywhere. A missing `CompiledWasm` rule fails the bundling step, not the
   deploy — which is why the dry run matters.

5. **Deploy** (only with the go-ahead recorded in the incident log):

   ```bash
   npx wrangler deploy --config wrangler.staging.jsonc
   ```

6. **Confirm which version is serving**

   ```bash
   npx wrangler deployments status --config wrangler.staging.jsonc
   npx wrangler tail corner-cup-staging --format pretty   # then hit /api/health once
   ```

   `deployments list` is eventually consistent on this project (Stage 6); trust `deployments status` and
   `tail`, which print the serving `scriptVersion`.

---

## 4. Secret restoration without exposing values

Secrets exist only in Cloudflare and the operator's password manager. They are never in Git, never in
`wrangler.jsonc`, never in this runbook.

### 4.1 Names to restore

Required: `ADMIN_SECRET`, `OPERATOR_PASSWORD`.
Feature-gated: `OWNER_PASSWORD` (first-boot seed only), `ORDER_TRACK_SECRET`, `WORKOS_CLIENT_ID`,
`WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_ISSUER`, `WORKOS_AUDIENCE`, `WORKOS_STATE_ENCRYPTION_KEY`,
`WORKOS_API_BASE`, `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_OWNER_CHAT_ID`. `ADMIN_PIN` is not read by the code — do not restore it.

### 4.2 Set a value without it appearing anywhere

```bash
npx wrangler secret put ADMIN_SECRET --config wrangler.staging.jsonc
# paste at the prompt; the value is not echoed and lands only in Cloudflare
```

Rules:

- Type or paste at the prompt. Never `echo … | wrangler secret put`, never a value in a shell variable that
  gets logged, never a value in a command line (shell history, process list).
- Never `wrangler secret list` output pasted into chat, tickets or a report — it prints names, but names plus
  dates still describe the deployment to an attacker.
- Never read a secret back to "check" it. Cloudflare cannot return it; any tool that claims to is reading a file
  you shouldn't have written.
- Values come from the password manager. If a value is missing there, it is lost: re-issue it at the provider.

### 4.3 Verify by behaviour, not by value

| Check | Without the secret | With it |
|---|---|---|
| `POST /api/cafes/<slug>/admin/login` | `503` | `401` (wrong password) or `200` (correct) |
| `GET /api/cafes/<slug>/config` → `payments` | `{"provider":"none","gateway":false}` | `provider: "razorpay"` once both gateway keys exist |
| `POST /api/cafes/<slug>/razorpay/webhook` with a bad signature | `503` | `400` |
| Managed sign-in `/api/cafes/<slug>/owner/start` | `503` (missing WorkOS config) | `302`/`409` depending on `owner_auth` |
| Order creation | `503` ("Ordering isn't configured") | `201` with a tracking token |

Run at most one attempt per path: sign-in attempts are rate-limited and lockout is persisted.

### 4.4 Rotation consequences — state these in the incident record before rotating

| Rotated secret | Consequence |
|---|---|
| `ADMIN_SECRET` | Every staff and operator session becomes invalid (HMAC key). Guest tracking tokens that fell back to it also stop working: existing guest links break permanently. |
| `ORDER_TRACK_SECRET` | Existing guest tracking tokens stop validating; orders remain in the database but their links die. Never rotate casually. |
| `WORKOS_STATE_ENCRYPTION_KEY` | In-flight managed sign-ins fail (their PKCE verifier is sealed with the old key); new sign-ins work. |
| `RAZORPAY_*` keys | In-flight checkout intents fail; webhook signatures fail until the dashboard secret matches. |
| `TELEGRAM_*` | Alerts stop; no data impact. |
| `OPERATOR_PASSWORD` | `/operator` sign-in changes; existing operator sessions are unaffected (they are signed, not password-bound). |

If exposure is suspected, rotate first and accept the session/tracking loss — do not wait for a root cause.

---

## 5. DNS and routing considerations

**Current state: there is no DNS to repair.** No `routes` and no `custom_domains` exist in any Wrangler config,
so every deployment is reachable only at its `workers.dev` hostname derived from the Worker name.

| Scenario | What to do |
|---|---|
| Worker redeployed under the same name | Nothing. The `workers.dev` URL is unchanged. |
| Worker deleted, then recreated with the same name | URL returns once the first deployment is live; propagation is seconds. |
| Worker recreated under a different name | The public origin changes. Update `WORKOS_REDIRECT_URI` (Worker secret **and** WorkOS dashboard) and any Razorpay webhook URLs, or managed sign-in and payments silently fail. |
| `workers.dev` disabled at account level (`workers_dev: false`) | Re-enable it in the dashboard, or add a route/custom domain — but the config has neither, so nothing will serve until one exists. |
| Custom domain added later | It becomes infrastructure this runbook does not yet cover: re-point the DNS record, confirm the certificate is active, then verify the same origin is registered at WorkOS/Razorpay. Update this runbook at the same time. |
| Cached SPA assets look stale after recovery | Static assets are content-hashed by Vite; `index.html` is the only mutable file. A hard reload resolves it. Do not "fix" it with cache headers during an incident. |

Routing invariants worth checking after any recovery:

- `/api/*` reaches the Worker (not the asset handler) — `run_worker_first: true`.
- Deep links return HTML, not 404 — SPA fallback.
- `/c/<slug>/menu` returns the café in the restored data, not a freshly seeded one.

---

## 6. Post-recovery verification

Run in order; stop at the first failure and treat it as a new incident step, not a reason to keep clicking.

### 6.1 Liveness and data

```bash
curl -s https://<origin>/api/health
curl -s https://<origin>/api/cafe
curl -s https://<origin>/api/cafes/<slug>/menu   | head -c 400
curl -s https://<origin>/api/cafes/<slug>/tables | head -c 200
curl -s https://<origin>/api/cafes/<slug>/config
```

Expect: `status ok` / `database ok`; the expected café `slug`; 5 categories and 27 items with the restaurant's
real prices; 8 tables in table mode (0 in counter mode); `payments.provider` matching the configured secrets.

### 6.2 Integrity against the artifact

Compare live counts with the artifact's manifest: `cafes`, `menu_items`, `orders`, `order_items`, `tables`, and
`sum(total_cents)`. Differences are expected only for writes that happened after the export; explain each one.

### 6.3 Static and tenant boundary

- `GET /` and a deep link (`/c/<slug>/order/<id>`) return the SPA shell (`id="root"` present).
- `GET /api/cafes/not-a-real-slug/menu` returns `404`.
- One asset (`/assets/*.js`) returns `200` with a JavaScript content type.

### 6.4 Auth and payments (only with explicit approval)

- Staff sign-in returns `401` for a wrong password (not `503` — that would mean a secret is still missing).
- `/operator` is reachable and refuses a wrong password.
- One counter-payment order end to end, or a Razorpay test-mode payment, then confirm the ticket settles once and
  a replayed webhook does not settle it twice.
- Guest tracking link resolves for the new order; confirm an old link's behaviour is documented rather than
  assumed.

### 6.5 Runtime health

```bash
npx wrangler tail corner-cup-staging --format pretty
```

Watch for 5xx, `Error 1102` (CPU — Argon2id's Workers CPU cost is unresolved: the one probe on record
recorded roughly 65–68 ms of *elapsed* time per login, which is not a platform CPU measurement. Watch
for 1102 and read the reported per-request CPU time before assuming Workers Paid is required), D1
exceptions, and
`scriptVersion` consistency.
Leave the tail running through the first few real requests.

### 6.6 Close-out gates

- [ ] Health, menu, tables, config correct.
- [ ] Counts and totals reconciled with the artifact.
- [ ] SPA + tenant boundary behave.
- [ ] Staff sign-in works (or its absence is explained).
- [ ] No unhandled 5xx in `tail` during the observation window.
- [ ] Data-loss window written down (from RPO to the recovery point actually used).
- [ ] Incident record complete; change freeze lifted explicitly.

---

## 7. Rollback procedure

Rollback is a first-class recovery action, not a failure. Prefer it over debugging on a live system.

### 7.1 Worker version (fastest, restores code + bindings)

```bash
npx wrangler deployments list --config wrangler.staging.jsonc
npx wrangler deployments status --config wrangler.staging.jsonc
npx wrangler rollback <deployment-id> --config wrangler.staging.jsonc
```

Version rollback also rolls back the D1 binding that version carried, which is exactly what you want when the
bad change was a rebind.

### 7.2 Config-only revert

Restore the previous `database_name`/`database_id` (or any other drifted value) in the config file, review the
diff, then `npx wrangler deploy --config <config>`. The diff must be the reverse of the change that caused the
incident — no opportunistic edits.

### 7.3 Safe state (stop the bleeding without deleting anything)

```bash
npx wrangler deploy --config wrangler.staging-maint.jsonc
```

503 on every route, D1 still bound, no assets, no writes. Use it when the site must stop serving broken
responses while data work continues. For a plain Worker like this one, the maintenance stub or a version
rollback is the only lever — there is no publish/unpublish switch to flip.

### 7.4 Data rollback

Only after the code/config is stable. Restore the pre-incident export into a **new** database, verify, rebind
(§2). Never import over a live database. If writes continued after the damage, record the lost interval
explicitly — it is the RPO actually incurred.

### 7.5 Rollback limits

- A rollback cannot recover rows written after the last export.
- A rollback cannot recover deleted secrets; it only restores the code path that needs them.
- Rolling back across a schema migration is safe here (all migrations are additive and idempotent), but the
  older code may ignore newer columns — confirm the older code does not depend on a table it does not know.
- After any rollback, the *next* deploy must not silently reintroduce the bad change: record the commit that
  must not be redeployed.

---

## 8. Communication and incident record checklist

### 8.1 Who to tell, and when

| Audience | When | What |
|---|---|---|
| The operator (self-note in the incident record) | Immediately | The five declaration lines (§1.2). |
| The affected café owner | As soon as guest ordering is confirmed impacted | Plain language: what guests see, whether orders/payments were lost, when the next update comes. No internal jargon. |
| Razorpay / WorkOS support | Only if their side is implicated | Incident id, timestamps, order/payment ids — never keys. |
| Guests | Only if payment was taken without an order, or a tracking link is dead | The owner communicates; the operator supplies the facts. |

### 8.2 Incident record template (keep it in one file per incident)

```
Incident id:        INC-<YYYYMMDD>-<n>
Declared / resolved (UTC):
Severity:           SEV1 (no ordering/payments) | SEV2 (degraded) | SEV3 (internal only)
Symptom as observed:
Detection source:   health check / owner report / tail / deploy
Environment:        staging | production
Last known good:    version id, artifact path + sha256, timestamp
Root cause (final):
Contributing factors:
Recovery path taken:  (commands, in order, with outcomes)
Data loss window:     from <timestamp> to <timestamp>; rows/orders affected
Secrets rotated:      names only, plus the consequence accepted
Bindings changed:     from -> to, with the config file and diff
Verification evidence:  health/menu/counts/tail results
Rollback used:        yes/no, which lever
Communication log:    who, when, channel
Follow-up actions:    owner + due date
Runbook gaps found:   (edit this runbook in the same week)
```

### 8.3 Checklist

- [ ] Five declaration lines written and timestamped.
- [ ] Change freeze stated and honoured.
- [ ] Blast radius, data-vs-routing, environment and deploy-correlation recorded.
- [ ] Every command and response logged (secrets redacted — names only).
- [ ] Rollback point identified **before** the first change.
- [ ] Verification results attached.
- [ ] Data-loss window quantified.
- [ ] Owner informed at declaration and at resolution.
- [ ] Freeze lifted explicitly, in writing.
- [ ] Post-incident review within five working days; runbook and this document updated.

---

# STAGE 14 UPDATE — BACKUP, RETENTION AND RESTORE VALIDATION

**Date:** 2026-11-20. This section is appended; everything above it remains valid and unmodified.

## What is implemented (automated, verified)

| Control | Evidence |
|---|---|
| External source snapshot with per-file SHA-256 manifest | `C:\Users\rahil\corner-cup-backups\stage13-1-20261120T114817Z` — 228 files, 3,246,477 bytes, manifest `c23a7e07…00d5`, `RESULT: VERIFIED` |
| Snapshot includes every untracked module | 12/12 hash-checked (`worker/passwords.js` … `src/lib/menuScope.js`) |
| Second snapshot after this stage's changes | `stage14-*` directory, same procedure, new manifest (§ below) |
| Git history preserved independently of the worktree | `corner-cup-repo.bundle`, `git clone` restores all refs |
| Restore validation harness | Stage 11 isolated restore database; Stage 12 compatibility harness — both retained, neither deleted |
| Secrets kept out of backups | `.dev.vars`, `.env*`, keys, `.wrangler/` excluded by rule; recorded in `EXCLUSIONS.txt`; contents never read |

## What is documentation-only (not automated)

- Off-device replication: the procedure is written down; no scheduled copy exists.
- Encryption at rest of the backup archive: recommended, **not** implemented (see below).
- Retention rotation: policy stated, no automated pruning.
- Point-in-time recovery of D1: **not available** on the free tier. The only recovery point is the most recent
  export.

## Backup procedure (verified)

```bash
# 1. Take the snapshot with a new timestamped directory — never overwrite a previous one.
DEST=~/corner-cup-backups/stage14-$(date -u +%Y%m%dT%H%M%SZ); mkdir -p "$DEST/worktree"
git ls-files > "$DEST/filelist.txt"
git ls-files --others --exclude-standard >> "$DEST/filelist.txt"
find sites-build dist -type f >> "$DEST/filelist.txt" 2>/dev/null
sort -u -o "$DEST/filelist.txt" "$DEST/filelist.txt"
grep -vE '(^|/)\.dev\.vars$|(^|/)\.env$|(^|/)\.env\.|(^|/)\.qa-logs/|(^|/)\.wrangler/' \
  "$DEST/filelist.txt" > "$DEST/f.txt" && mv "$DEST/f.txt" "$DEST/filelist.txt"

# 2. One archive and one extracted tree.
tar -cf "$DEST/worktree.tar" -T "$DEST/filelist.txt"
tar -xf "$DEST/worktree.tar" -C "$DEST/worktree"

# 3. History, independently.
git bundle create "$DEST/corner-cup-repo.bundle" --all

# 4. Verify: counts, sizes and hashes against the live tree.
node "$DEST/verify.mjs" "$PWD" "$DEST"      # expect RESULT: VERIFIED
sha256sum "$DEST/MANIFEST.sha256"           # record this value in the runbook log
```

The `.dev.vars` exclusion is exact-name: the tracked `.dev.vars.example` templates **are** preserved (they hold
empty placeholders only).

## Encryption and off-device storage (recommended, needs an owner decision)

- Encrypt the archive with `age` or `7z -p` before it leaves the machine; store the passphrase in a password
  manager, never in the repository.
- 3-2-1: the working copy, the external snapshot on this machine, and one copy on a different device or an
  encrypted cloud drive. Today only the first two exist.
- Do not store the passphrase and the archive in the same place.

## Restore validation (the part that actually proves the backup)

1. Restore the **archive** into a scratch directory; run `verify.mjs` → 228/228 files, 0 mismatches.
2. Clone the **bundle** into a scratch directory; confirm `git log` reaches HEAD `023befea…` and
   `git status` shows the same 27 modified files.
3. Build from the restored tree (`npm ci && npm run build`) — this is the check that the untracked modules are
   genuinely present, because a tree missing them cannot build.
4. Restore the database export into a disposable local SQLite; run `PRAGMA integrity_check` (`ok`) and compare
   the 19-table schema.
5. Point the Stage 12 harness at the restored database; run the compatibility tests.
6. Only then consider the backup proven.

## Secret restoration without exposing values

Secrets are **not** in any backup, by design. Recreate them from the provider dashboards: `ADMIN_SECRET`
(random, ≥32 chars, rotate on any suspicion), `OWNER_PASSWORD` (bootstrap only), `OPERATOR_PASSWORD`,
`RAZORPAY_KEY_ID`/`_SECRET` (only when payments are approved). Never paste a value into chat, a document, a
commit or a log. Verification is behavioural: sign in, and confirm a missing secret yields 503 rather than 500.

## RPO / RTO, stated honestly

| Scenario | RPO | RTO | Reality |
|---|---|---|---|
| Source code lost on this machine | last snapshot (manual) | ~15 min | Verified, restore-tested |
| Source code lost + machine lost | last off-device copy | ~30 min | **Not automated** — depends on the owner making the copy |
| Production D1 corrupted | last manual export | ~1 h | No PITR on free tier; export cadence is manual |
| Deployment rolled back | 0 (previous artifact retained) | ~5 min | Provider-side rollback |

Until exports are scheduled, the honest statement is: **RPO is "whatever the last manual export was"**.

---

## Addendum — 2026-11-22 (Stage 17B owner MFA)

**New failure mode: a lost second factor.** An owner who loses both their authenticator and their
recovery codes cannot sign in. The documented recovery path is an operator action: clear
`owner_totp.confirmed_at` (or delete the row) for that café and bump `auth_version` so existing
sessions die with it. Resume with `DATABASE_MIGRATION_AND_RECOVERY.md` §7.

**New failure mode: a rotated MFA encryption key.** TOTP seeds are AES-256-GCM-encrypted with a key
derived from `MFA_ENC_KEY` only — as of 2026-11-25 there is **no `ADMIN_SECRET` fallback**, and a
missing or malformed key makes sign-in fail closed with 503 instead of decrypting under another
secret. Restoring a database under a different key makes existing seeds undecryptable: put the
retired key in `MFA_ENC_KEY_PREVIOUS` (decrypt-only) for the rotation window, or affected owners must
re-enroll. Record which key was in use at each backup, in the backup's filename or a sidecar note —
never the key value itself.

**Restore order.** The Stage 17B tables are additive and `operator_sessions.credential_hash` is an
`ALTER`, so a full export restores cleanly; a partial restore must apply base tables first.

**New objects to check after a restore** (previously absent): `owner_totp`, `owner_totp_recovery`,
`owner_totp_challenges`, `auth_events`, and the `credential_hash` column. A fresh database should
show 24 tables and 38 indexes.

**Unchanged and still true:** no PITR on the free tier, exports are manual, and a production export
has still not been taken (blocker B-4). The honest RPO remains "whatever the last manual export was".

---

## 9. Menu photographs (R2) — recovery

Applies to the bucket bound as `IMAGES` (`corner-cup-images`). Added 2026-11-22 after the R2 binding
was declared in `wrangler.jsonc`.

### 9.1 What breaks without it

Uploaded photos are referenced by `menu_items.image_key`. If the bucket is lost, every item with a
custom photo falls back to its category default (or its emoji) — the menu still works and no order is
affected, but the café's photography is gone.

### 9.2 If the binding is missing or misconfigured

`env.IMAGES` undefined ⇒ upload answers `503 Image storage is not configured.` and image GET answers
`503 Storage is not configured.` The menu keeps serving defaults. Fix:

```bash
wrangler r2 bucket create corner-cup-images     # only if the bucket does not exist
# wrangler.jsonc already declares: r2_buckets: [{ binding: "IMAGES", bucket_name: "corner-cup-images" }]
wrangler deploy
```

An item that still shows "Default photo" after the fix has no `image_key` — the pointer, not the
bucket, is what a re-upload repairs.

### 9.3 If the bucket is deleted

1. Recreate the bucket with the same name and redeploy (the binding is already declared).
2. Restore objects from the off-account copy or bucket versioning, preserving original keys
   (`cafes/<cafeId>/menu/<itemId>/<uuid>.<ext>`); restoring under different keys requires repointing
   `menu_items.image_key`, so prefer the original keys.
3. Verify: open one item's photo in the guest menu; a 404 means the key did not come back.
4. If objects are unrecoverable, clear the pointers so the board stops offering a broken photo:
   `UPDATE menu_items SET image_key = NULL` for the affected rows, then re-upload.

### 9.4 Restore pairing rule

Restore D1 and R2 from the **same timestamp** where possible. A D1 restore that points at an older
bucket shows the previous photos for those items; that is cosmetic and self-corrects on re-upload,
but record it in the incident log so nobody hunts a phantom bug.

### 9.5 What not to do

- Do not delete the bucket to "reset" photos: that destroys objects the pointers still reference.
- Do not repoint `image_key` at keys you have not verified exist.
- Do not widen the public image route to accept a key from the URL; it resolves the key from D1 by
  `id AND cafe_id` on purpose.

---

## 10. Backup verification drill — 2026-11-23

The export → encrypt → verify chain was executed on a disposable local database (no staging or
production data):

1. `wrangler d1 export corner-cup --local` produced 49,592 bytes.
2. SHA-256 recorded: `673256ef40dc1925c1f5a0e768abde51214703bd717fa264f2b6aca9db364773`.
3. Encrypted with AES-256-CBC, PBKDF2, 200,000 iterations, random salt and a random passphrase.
4. Decryption produced a byte-identical file (`cmp` clean) with the same SHA-256.
5. The decrypted SQL rebuilt 24 tables in a fresh database with `integrity_check = ok` and zero
   foreign-key violations.
6. The plaintext decrypted copy was deleted immediately after verification.

Run this same sequence for the production database when account access exists, and treat a backup as
unverified until the checksum matches after decryption.
