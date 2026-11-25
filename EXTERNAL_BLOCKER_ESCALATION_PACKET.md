# EXTERNAL BLOCKER ESCALATION PACKET — R2, PRODUCTION D1, ARGON2ID CPU

**Date:** 2026-11-24
**Nature:** documentation only. Nothing was deployed, published, created, deleted or reconfigured.
**Purpose:** turn the three remaining external blockers into exact, copy-pasteable actions for the account
owner (R2) and for Freebuff support (production D1), without weakening the build or guessing about state.

---

## 0. One table

| # | Blocker | Who can clear it | Exact next action | Status today |
|---|---|---|---|---|
| 1 | R2 disabled on the owner's Cloudflare account (`code 10042`) | Account owner (`rahilbisen8@gmail.com`, account `bca798ce…`) | Dashboard → Storage & databases → R2 → complete the R2 subscription checkout (§1.3) | **Blocked on dashboard action** — not a code or Wrangler problem |
| 2 | Production D1 lives in Freebuff's platform account, not the owner's | Freebuff support + platform account `6e5a40dd…` | Send the request in §2.5 (site/env/DB IDs included) | **Unresolved** — database presence neither confirmed nor disproved (§2.3) |
| 3 | Argon2id Workers Free CPU compatibility unmeasured | Whoever runs the deployed Worker | One `wrangler tail` per-request CPU reading (§3.2) | **Unresolved pending a platform number**; parameters stay `m=19456 KiB, t=2, p=1` |

No item here requires a deploy, a paid plan, a secret change, or a code change.

---

## 1. R2 — error `10042`, and the exact account-level fix

### 1.1 The error, verbatim

```
$ npx wrangler r2 bucket list
X [ERROR] A request to the Cloudflare API (/accounts/bca798cecc7dc814299016c208b96ebd/r2/buckets) failed.
  Please enable R2 through the Cloudflare Dashboard. [code: 10042]
```

Re-confirmed 2026-11-24 against account `bca798cecc7dc814299016c208b96ebd`, Wrangler 4.166.0.

### 1.2 What `10042` actually means

Cloudflare's R2 error-code reference lists `10042` as **`NotEntitled`**, HTTP 403, "Account not entitled to
this feature", with the fix "Ensure your account has an R2 subscription."

That is the whole diagnosis: **the account has no R2 subscription**, so every `/r2/…` API call — including a
read-only `list` — is refused before any bucket logic runs. It is *not* an `AccessDenied` (`10003`) and *not*
a missing bucket. There is nothing to fix in this repository, in `wrangler.jsonc`, or in the CI workflow.

### 1.3 Supported steps to enable R2 (owner, dashboard only — no CLI path exists)

Cloudflare's "Get started with R2" states the prerequisite plainly: "You need a Cloudflare account with an R2
subscription." Wrangler has no enablement command; `workers-sdk` issue #15468 asks for one precisely because
the CLI cannot do it.

1. Sign in at <https://dash.cloudflare.com> as the owner of account `bca798ce…` (the Wrangler-authenticated
   identity, `rahilbisen8@gmail.com`).
2. Select **Storage & databases → R2 → Overview** (<https://dash.cloudflare.com/?to=/:account/r2/overview>).
3. Complete the checkout flow — **"Add R2 subscription to my account"**. R2 requires a payment method on
   file even for the free allowance; the summary shows **$0 due today** on the free tier (10 GB storage,
   1M Class A, 10M Class B operations per month).
4. Confirm the subscription is actually active: **Manage account → Billing → Subscriptions** must list R2.
   This check matters — see §1.4.
5. Verify from this machine: `npx wrangler r2 bucket list` must return an empty table instead of `10042`.
6. **Only then**, and only with explicit approval, create the bucket the app already declares:
   `npx wrangler r2 bucket create corner-cup-images` (binding `IMAGES` in `wrangler.jsonc`).

### 1.4 If step 3 loops (known Cloudflare-side failure mode)

There is a documented pattern where clicking "Activate" returns "A subscription update is already in
progress. Wait a few minutes and try again.", or bounces back to the "Add R2 subscription" screen while
Billing already shows R2 active, and the API keeps returning `10042`. That is a Cloudflare provisioning
bug, not something the owner can configure around.

- Do **not** re-click activation repeatedly (it queues duplicate subscription requests).
- Open a **Billing** ticket at <https://dash.cloudflare.com/?to=/:account/support> → get help → technical
  support → open a case, quoting: account ID `bca798cecc7dc814299016c208b96ebd`, error `10042`
  `NotEntitled` on `GET /accounts/…/r2/buckets`, R2 not listed or "active but not provisioned" in Billing.
- Community threads show support resolving this by forcing the subscription active on the account.
- If `10042` somehow persists after Billing shows R2 active, refresh the local OAuth scopes with a fresh
  `npx wrangler login` and re-run step 5 before assuming anything else.

### 1.5 What must not be done

- Do not deploy Project A (or any project) merely to attach a bucket.
- Do not create the bucket in a different account, under a different name, or against the Freebuff platform
  account — the binding name and bucket name in `wrangler.jsonc` are the contract.
- Do not move to a paid plan to work around this: the free R2 allowance is sufficient, and the blocker is
  entitlement, not capacity.
- Do not remove the `r2_buckets` declaration to make a deploy succeed. A deploy without the bucket fails on
  the missing bucket by design; shipping a Worker whose uploads 503 is worse.

### 1.6 Why the Sites quota does not solve it

The Freebuff Sites free quota does include object storage — `r2Bytes` limit 1,000,000,000, used 0 (checked
2026-11-24) — but that is the *platform's* allowance for Sites-managed storage. It does not enable R2 on the
owner's own Cloudflare account (`bca798ce…`), which is the account Wrangler uses for `wrangler r2 bucket …`.
The two are unrelated.

### 1.7 If R2 stays disabled

Image **uploads** stay unavailable (the endpoint answers 503 by design). The app still serves its bundled
default menu imagery, so a pilot can run **only if every item on that café's menu uses a bundled default
image**. That has to be checked against the real menu with the owner before a shift; it is not assumed here.

---

## 2. Production D1 — ownership mismatch, and the exact support request

### 2.1 Confirmed identity (unchanged; IDs preserved exactly as Stage 16A recorded them)

| Property | Value |
|---|---|
| Database name | `site-6e1c6f7a9a9f4e098f778f9754221b0a` |
| Database ID | `17d9568d-52fd-48c2-8761-b74d97688589` |
| Binding | `DB` (kind `d1`), binding record `b80703c2-944c-460d-8a21-57ea05a80bf9` |
| Binding created | 2026-11-09T16:14:26.348Z |
| Owning Cloudflare account | `6e5a40dd9362fb315de7ecbaad2ca12b`, namespace `freebuff-sites-prod` |
| Site | `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63` — "Corner Cup Café — Razorpay" |
| Environment | `fa58771d-25fb-4936-bbad-5cffd6ff3973` (`production`) |
| Worker | `site-fa58771d25fb4936bbad5cffd6ff3973` |
| Storage | 266,240 bytes (platform quota, `d1Bytes` used 266,240 of 100,000,000) |
| Rows read / written this month | 207,720 / 1,580 |

### 2.2 Fresh evidence captured today (2026-11-24)

- `sites_inspect` on environment `fa58771d…` still returns the `DB` binding with `resource_id`
  `17d9568d-52fd-48c2-8761-b74d97688589` and `resource_name`
  `site-6e1c6f7a9a9f4e098f778f9754221b0a`.
- The environment's operation history still contains the original provisioning receipt
  (`kind: "d1"`, `state: "succeeded"`, `result.resourceId` = the same ID), completed
  2026-11-09T16:14:26.379Z.
- Both environments of this site are `published: false`; the unpublish receipts are from
  2026-11-20T12:21Z.
- The platform D1 quota still shows 266,240 bytes in use.

**How to read that evidence:** it proves the *platform metadata* — site record, environment record, binding
record and provisioning receipt — is intact and mutually consistent. It does **not** independently prove the
underlying database currently exists, is readable, or is backed up. Those remain unverified.

### 2.3 What is established vs. what is not

**Established**
- A production D1 was provisioned for this site's production environment on 2026-11-09, under Freebuff's
  platform account `6e5a40dd…`.
- The binding and provisioning receipts are still present in the platform today.
- This machine's Wrangler identity is a *different* Cloudflare account — `bca798ce…`
  (`rahilbisen8@gmail.com`) — and that account's `wrangler d1 list` returns only `corner-cup-staging`
  (`39a7899c-…`) and `corner-cup-stage11-restore-20261119T155325Z` (`2399a1f7-…`).
- `wrangler d1 info 17d9568d-…` and `wrangler d1 info site-6e1c6f7a…` both answer
  "Couldn't find a D1 DB with name or binding" — the expected result for a database in another account.

**Not established (and therefore not claimed anywhere in this project's reports)**
- That the database currently exists and is readable.
- That the database was deleted, emptied, or replaced (no evidence points either way).
- That any export, dump or backup of production data exists. **None has been obtained.**
- Whether the rows counted by the platform quota belong to this database or to the pool.

The latest authenticated-account check does **not** prove deletion. It only shows the account it ran
against.

### 2.4 Two traps to avoid while this is open

1. **Never create a database named `site-6e1c6f7a9a9f4e098f778f9754221b0a` in the owner's account.**
   Wrangler resolves by name or binding; a same-named local database would make
   `wrangler d1 export` silently export the wrong one — the exact ambiguity Stage 16A stopped on.
2. **Do not delete the Sites project to "clean up".** Delete site removes the project's code, secrets, its
   D1 database and its R2 bucket. That would destroy the only known copy of the production data. Leave the
   site saved and unpublished until the export exists.

### 2.5 Exact information and request for Freebuff support

Everything below is safe to send as-is. It contains no secret values — only IDs, names and non-secret
metadata.

> **Subject:** Production D1 export/access request — Corner Cup Café — Razorpay (site
> `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63`)
>
> **Account:** the Freebuff account that owns the site (`Corner Cup Café — Razorpay`, created
> 2026-11-09) — identified by the site ID below.
>
> **Context.** The site's production environment is unpublished and will stay unpublished during a
> containment review. Before any relaunch I need a verified backup of the production database. I cannot
> export it myself: the database is provisioned under Freebuff's platform Cloudflare account, and my local
> Wrangler login is a different Cloudflare account, so D1 is not visible to it.
>
> **Identifiers**
> - Site: `Corner Cup Café — Razorpay`, id `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63`
> - Environment: `production`, id `fa58771d-25fb-4936-bbad-5cffd6ff3973`
> - Worker: `site-fa58771d25fb4936bbad5cffd6ff3973`
> - D1 binding: `DB`, binding record `b80703c2-944c-460d-8a21-57ea05a80bf9`
> - D1 database name: `site-6e1c6f7a9a9f4e098f778f9754221b0a`
> - D1 database id: `17d9568d-52fd-48c2-8761-b74d97688589`
> - Provisioned: 2026-11-09T16:14:26Z (operation `6e1c6f7a-9a9f-4e09-8f77-8f9754221b0a`, state succeeded)
> - Reported storage: 266,240 bytes; platform quota `d1Bytes` used 266,240 of 100,000,000
>
> **Requests, in order of preference**
> 1. Confirm whether database `17d9568d-52fd-48c2-8761-b74d97688589` still exists on the platform account
>    `6e5a40dd9362fb315de7ecbaad2ca12b`, and whether it holds the data written before 2026-11-20.
> 2. Produce a logical export of that database (SQL dump) and share it with me through a channel that does
>    not put production data in chat, together with its SHA-256 — or, if that is not possible, tell me the
>    supported export path for a single environment.
> 3. Alternatively, tell me how to obtain scoped, read-only access to that one database for the duration of
>    the export.
> 4. If the database no longer exists, say so explicitly and describe the retention that applied, so the
>    finding can be recorded accurately. Please do not describe it as "deleted" or "active" without
>    confirming which is true.
>
> **Please do not** delete, reconfigure, migrate or redeploy the site or its database while this is open.
> The environments are already unpublished; nothing needs to be torn down for me to complete the backup.

After support answers, run the proven procedure (export → `sha256sum` → AES-256-CBC/PBKDF2-200k encrypt →
decrypt and `cmp` → import into a fresh SQLite file → `integrity_check` / `foreign_key_check`) documented in
`CORNER_CUP_FINAL_LAUNCH_READINESS_REPORT.md` §5 and `DATABASE_MIGRATION_AND_RECOVERY.md` §7a. Store the
passphrase separately from the file and record the active `MFA_ENC_KEY` alongside it.

If the export must be produced by the owner instead, that requires either a platform-issued credential for
account `6e5a40dd…` or a temporary read-only token scoped to `17d9568d-…`; neither exists today and neither
should be improvised.

**Acceptance criteria for the artefact** are now written down in `PRODUCTION_D1_RECOVERY_PROCEDURE.md` §2: the
database id, a complete schema+data dump, the UTC export time, the byte size, the SHA-256 of the exact bytes,
the tool used, and confirmation that the database was not being written during the export. A file without
those is not a verified export. §4 of that document describes `scripts/verify-d1-export.mjs`, which was proven
this pass on a real D1 dump (23 tables, 38 indexes, `integrity_check=ok`, FK 0, encrypted round trip
byte-identical).

---

## 3. Argon2id CPU compatibility (measurement still owed)

**2026-11-25:** the derivation's own CPU cost is now measured locally — p50 31–47 ms, max 63–94 ms per
Argon2id hash across three runs on the development machine (`ARGON2ID_CPU_COMPATIBILITY.md` §7), and §8 lists
the five pieces of evidence needed to close the platform question. That is process CPU, not platform
`cpuTime`, and it does not name the plan's ceiling; the platform reading in §3.2 remains owed.

Unchanged position, one line: the recorded 65/67/68 ms (correct password), 53/62/67 ms (wrong password) and
0 ms (no-hash baseline) are **elapsed wall-clock** figures from a since-deleted probe Worker. They do not
establish Cloudflare CPU consumption, so they neither prove nor disprove that the Workers Free 10 ms CPU
limit is exceeded.

### 3.1 Non-negotiables

Keep Argon2id at `m=19456 KiB, t=2, p=1`. Do not lower the parameters, do not swap in a cheaper KDF, and do
not describe the current timings as CPU time in any future report.

### 3.2 The measurement that settles it

1. Deploy once to an environment with `wrangler tail` attached (a preview/staging Worker is enough — this is
   the measurement the Sites platform reports, not a guess).
2. Perform ~10 owner sign-ins with a real password, and ~10 with a wrong one.
3. Read the per-request CPU time from the tail output / Workers analytics histogram, not the client-side
   elapsed time.
4. Compare against 10 ms (Workers Free per-request CPU).

Decision rule: if the measured CPU is under the ceiling, the Free tier stands and no change is needed. If it
is over, the choice is Workers Paid (30 s default CPU) or an explicitly approved design change — never a
weaker hash. Either outcome is a billing/platform decision, not a code defect.

---

## 4. Consolidated state after this packet

- **Code:** complete; the gate was re-run on 2026-11-25 — **532/532 tests**, production build exit 0,
  `npm audit` 0 on both trees, image self-test 7/7, and a real D1 dump restored with `integrity_check=ok`,
  FK 0 and a byte-identical encrypted round trip (earlier: 492/492, drill 13/13). MFA encryption now requires
  a dedicated `MFA_ENC_KEY` with no `ADMIN_SECRET` fallback; no deployment has it yet, so that stays a
  configuration blocker rather than a code defect.
- **R2:** blocked on the owner's dashboard subscription step; no bucket exists and none should be created until that is done.
- **Production D1:** platform metadata intact, data state unresolved, no export obtained; the support request
  is ready to send in §2.5.
- **Argon2id:** unmeasured; one `wrangler tail` CPU reading settles it (§3.2). Parameters unchanged.
- **Everything else is human-gated, not engineering-gated:** enable R2, send §2.5, take the CPU reading,
  then run the §12 acceptance checklist and the §13 pilot. GitHub remains paused by instruction.

---

## 5. Corrections to this packet

Anything above that turns out to be wrong must be corrected here, with a date, rather than edited silently:

- *(none yet)*
