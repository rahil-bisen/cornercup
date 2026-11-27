# Deploying the demo-ready build to Cloudflare

Exact steps to put the `demo-ready` branch on the existing Worker
`https://corner-cup.rahilbisen8.workers.dev`. Hosting stays on Cloudflare (Workers + D1 + R2).
Run every command from the project folder in PowerShell.

**Nothing here has been run against the live Worker yet.** Steps marked ⚠ change the live site or its
database; run them yourself, in order.

## What the live account looked like on 2026-11-27 (read-only checks)

| Item | Value |
| --- | --- |
| Worker | `corner-cup`, current version `18d56a57-4991-41d9-9edc-672a98cfd808` (2026-11-26) |
| D1 database | `corner-cup` (`eefda06c-f8d6-483d-85f2-a6a21b1827d8`) |
| R2 bucket | `corner-cup-images` (exists) |
| Secrets set | `ADMIN_SECRET`, `OPERATOR_PASSWORD` |
| Secrets not set | `MFA_ENC_KEY` (two-factor sign-in stays off), `RAZORPAY_*` (online payment stays off — intended) |

---

## 1. Prepare (no live changes)

```powershell
git switch demo-ready
```

```powershell
npm ci
```

```powershell
npx wrangler whoami
```

`whoami` must show the account that owns `corner-cup`. If not, run `npx wrangler login`.

Run the tests the way CI does. They need the two local test Workers, so open two extra terminals:

```powershell
npx wrangler dev --config tests/harness/wrangler.auth.jsonc --port 8790 --ip 127.0.0.1
```

```powershell
npx wrangler dev --config tests/harness/wrangler.jsonc --port 8789 --ip 127.0.0.1
```

Then, in the first terminal:

```powershell
npm.cmd test
```

```powershell
npm.cmd run build
```

Expected: `ℹ fail 0`, `ℹ skipped 0` and a clean Vite build. (On 2026-11-27 this was 591 passed.)

## 2. ⚠ Back up the live database first

```powershell
New-Item -ItemType Directory -Force backups | Out-Null
```

```powershell
npx wrangler d1 export corner-cup --remote --output "backups/corner-cup-$(Get-Date -Format yyyyMMdd-HHmm).sql"
```

This only reads the database, but the file contains customer orders and password hashes: keep it out of
Git (`backups/` is not committed — check with `git status` that it does not appear) and delete it once the
deploy is confirmed.

D1 also keeps 30 days of point-in-time history. Note the time now, so you can restore to it:

```powershell
npx wrangler d1 time-travel info corner-cup
```

## 3. ⚠ Deploy

```powershell
npm.cmd run deploy
```

That runs `vite build` and `wrangler deploy`. Note the new version id it prints.

## 4. Database migrations — what happens and how to make it safe

There are **no separate SQL migration files to run**. The Worker brings the schema up to date by itself on
the first API request each new instance receives (`worker/db.js` `ensureDb` → `SCHEMA`, `MIGRATIONS`,
`POST_MIGRATIONS`). Every statement is additive and repeatable: `CREATE TABLE/INDEX/TRIGGER IF NOT EXISTS`,
`ALTER TABLE … ADD COLUMN` (skipped when the column exists) and one guarded `UPDATE` that only fills
`tables.number` where it is NULL. Nothing is dropped or rewritten.

This deploy changes **how** those statements are sent (2 round trips instead of ~77 on an up-to-date
database), not **what** they do. To apply them safely:

1. Make sure step 2 (backup) is done.
2. Trigger the first instance and check it answers:

   ```powershell
   curl.exe -s https://corner-cup.rahilbisen8.workers.dev/api/health
   ```

   Expect `{"status":"ok","database":"ok",…}`.
3. If it does not, roll back the code (step 7) — the schema statements cannot have removed anything.

## 5. ⚠ Create or reset the demo café

```powershell
node scripts/demo-cafe.mjs --remote --confirm chai-kona
```

It only touches the café at `/c/chai-kona` (see the script header and `tests/demo-cafe.test.mjs`).
**First time only:** open `https://corner-cup.rahilbisen8.workers.dev/operator`, sign in, and use **Reset
password** on Chai Kona Café to set its owner password. Keep it in your password manager.

## 6. Check every link

| Link | Expect |
| --- | --- |
| `/api/health` | `status ok, database ok` |
| `/c/chai-kona` | Chai Kona Café landing page, six tables, "pay at the counter" wording, no UPI/card/wallet promise |
| `/c/chai-kona/t/3` | Menu with photos, Chicken Biryani sold out |
| `/c/chai-kona/owner` | Owner sign-in → board with "Guests pay at the counter" |
| `/operator` | Operator sign-in |
| `/c/demo-01` | **Café not found** page (not a generic café) |
| `/c/corner-cup/t/1` | "Menu not available yet" while that café has no items |

Place one test order on `/c/chai-kona/t/3` and walk it to Served on the board, then reset the demo café
again (step 5).

To see cold-start time after the deploy, run this in a second terminal, then load `/api/health` once after
a quiet minute:

```powershell
npx wrangler tail corner-cup --format json
```

Before this build, the first API request to a new instance took 15.4–15.9 s of wall time (measured
2026-11-27); expect a large drop.

## 7. Rolling back

Code (instant, keeps the database as it is):

```powershell
npx wrangler rollback 18d56a57-4991-41d9-9edc-672a98cfd808
```

Database (only if data went wrong; this overwrites everything written since the timestamp):

```powershell
npx wrangler d1 time-travel restore corner-cup --timestamp "<the time you noted in step 2>"
```

---

## Argon2id owner sign-in and Cloudflare CPU limits

Owner passwords are hashed with Argon2id at `m=19456 KiB, t=2, p=1` (OWASP baseline). These parameters
are **not** changed by this build and must not be lowered to save CPU.

| Measurement (2026-11-27) | Result |
| --- | --- |
| One derivation, local process CPU, exact Worker wasm and parameters (`scripts/measure-argon2-cpu.mjs`) | p50 **78 ms**, min 46, max 110 ms (10 samples, machine also running three local Workers; 2026-11-25 runs on the same machine gave p50 31–47 ms) |
| Live Worker, platform `cpuTime`, cold API requests | **57–99 ms**, all `outcome: ok`, none terminated |
| Live Worker, warm API requests | 1 ms |

What this means:

- **Workers Free** allows 10 ms of CPU per request. One Argon2id derivation alone costs several times that,
  so owner sign-in **cannot** fit a strictly enforced Free limit at these parameters.
- The live Worker already serves cold requests at 57–99 ms of CPU without termination, so the account is
  either on **Workers Paid** (30 s default CPU limit — ample) or Free is not enforcing its limit here. The
  plan could not be read with the current login. **Check it:** Cloudflare dashboard → Workers & Pages →
  Plans.
- **If the account is on Workers Paid:** no change needed. Sign-in stays at full strength.
- **If it is on Workers Free:** move to Workers Paid before relying on owner sign-in. Do **not** reduce
  `m`, `t` or `p`, cache passwords, or add a sign-in shortcut.

To get the platform number for a real sign-in after deploying (uses the demo café's password you set; do at
most 5 attempts per 10 minutes, the sign-in lockout is 8 failures):

```powershell
npx wrangler tail corner-cup --format json > tail-login.jsonl
```

Sign in once on `/c/chai-kona/owner`, sign out, sign in again, then stop the tail (Ctrl+C) and look at
the `cpuTime` of the `POST …/admin/login` events. Record the plan name next to the numbers in
`ARGON2ID_CPU_COMPATIBILITY.md` §9.

## Two-factor sign-in (optional)

The code supports authenticator-app two-factor sign-in, but it is off on the live Worker because
`MFA_ENC_KEY` is not set. To turn it on, generate a 32-byte key and set it yourself — never commit or
paste it anywhere else:

```powershell
npx wrangler secret put MFA_ENC_KEY
```

(See `.dev.vars.example` for the format.) Until then, don't offer two-factor sign-in in a demo.
