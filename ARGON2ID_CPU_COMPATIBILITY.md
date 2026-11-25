# ARGON2ID — WORKERS CPU COMPATIBILITY

**Status: UNRESOLVED for the launch decision.** The derivation's own CPU cost is now measured locally
(§7, 2026-11-25); the **platform** `cpuTime` for a real Argon2 login, and the plan's per-request ceiling,
remain unmeasured. No parameter, secret or authentication behaviour was changed to obtain anything below.

**Date of measurement:** 2026-11-24
**Environment:** Worker `corner-cup-staging`, version `80f92ceb-b443-4824-a147-1856310e9a52`, deployment
created 2026-11-16T20:09:31Z on account `bca798cecc7dc814299016c208b96ebd`.
**Method:** `wrangler tail --format json` — the platform's own per-event `cpuTime` field, not response latency.
**Deployments performed for this measurement: none.**

---

## 1. The question, precisely

Does the owner-password path — Argon2id at `m=19456 KiB, t=2, p=1` — exceed the per-request CPU limit of the
plan the pilot will run on? The previous figures on record (65/67/68 ms correct password, 53/62/67 ms wrong
password, 0 ms no-hash) were **elapsed wall-clock** times from a since-deleted probe Worker. They could not
answer this, because wall time includes queueing, D1 latency and scheduling.

## 2. Where the code stands (unchanged)

- `worker/passwords.js`: `const ARGON2 = { m: 19456, t: 2, p: 1 }`; two pre-compiled wasm modules
  (`simd.wasm`, `no-simd.wasm`) imported statically because workerd never compiles wasm from bytes.
- Stored hashes are parsed against an exact parameter allowlist before any allocation; a hash with different
  parameters is rejected rather than verified more cheaply.
- One derivation at a time per isolate plus a 3-deep wait queue, so overlapping logins cannot exhaust the
  isolate's memory; a full queue answers "busy" instead of waiting forever.
- Legacy PBKDF2 above 100,000 iterations fails closed with "ask the operator to reset it" rather than being
  verified at a lower cost.

Nothing in this file, in `wrangler.jsonc`, or in any secret differs from the reviewed build.

## 3. Could the platform metric be collected without deploying? Partly.

| Route | Available? | Verdict |
|---|---|---|
| Tail an existing deployment (`corner-cup-staging`) | **Yes** — deployed 2026-11-16, still serving | Used for everything in §4 |
| Tail `corner-cup` (project A's Worker name) | No — `wrangler deployments list` → `10007 This Worker does not exist on your account` | Not used; publishing project A is prohibited |
| Publish project A to reach its preview environment | Prohibited | Not done |
| Local `wrangler dev` CPU counter | Runs workerd locally, but reports no platform CPU metric | Not evidence; not used |
| Sites quota `cpuMs` (36,171.71 ms of 5,000,000 this month) | Aggregate for all requests on the account | Cannot attribute a single login; not used |

**Why the Argon2 path itself could not be measured:** the staging Worker serves exactly one café, and that
row has no password hash —

```
1 | slug=corner-cup-staging | mode=counter | hashlen=0 | algo=none
```

`POST /api/cafes/corner-cup-staging/admin/login` therefore returns 503 "This café hasn't set an owner
password yet" **before** any derivation runs (`worker/api.js`, the `!cafe.pass_hash` branch). The only way to
create an Argon2 hash there is the operator console (`OPERATOR_PASSWORD` is set, value not readable) or the
owner password change (needs a session). Both require a credential this review must not read, set or reset.
Per the mission's stop rule, the measurement stops there: **no secret was set, no café, menu item or order was
created or modified (the staging `orders` table still holds its 2 pre-existing rows), and no deployment was
made.** One wrong-password sign-in was sent, which is what produced event 2 in §4.

### 3.1 Caveat — the staging build is older than this repository

The deployed version (`80f92ceb`, 2026-11-16) predates the MFA work: its D1 database has no `owner_totp`,
`owner_totp_recovery`, `owner_totp_challenges` or `auth_events` table. So staging is a valid source of
**platform CPU behaviour** (it runs the same `ensureDb`-per-isolate structure and the same runtime), but it is
**not** a valid environment for accepting the current build's authentication or security features. Measuring
the Argon2 path there (§5) would additionally require deploying the current code first, which is prohibited.

## 4. What was measured, and what it says

Twelve events captured in one tail session. All `outcome: ok`, all `scriptVersion 80f92ceb`, no exceptions.

| # | Request | Status | Platform CPU (`cpuTime`) | Wall (`wallTime`) |
|---|---|---|---|---|
| 1 | `GET /api/health` | 200 | **42 ms** | 4,957 ms |
| 2 | `POST /api/cafes/corner-cup-staging/admin/login` (wrong password, no stored hash) | 503 | 2 ms | 120 ms |
| 3 | `GET /api/cafe` | 200 | **49 ms** | 5,639 ms |
| 4 | `GET /` (static asset) | 200 | 0 ms | 311 ms |
| 5 | `GET /api/health` | 200 | 1 ms | 120 ms |
| 6 | `GET /api/cafe` | 200 | **39 ms** | 5,551 ms |
| 7 | `GET /` | 200 | 1 ms | 141 ms |
| 8 | `GET /api/health` | 200 | **52 ms** | 5,111 ms |
| 9 | `GET /api/cafe` | 200 | 1 ms | 123 ms |
| 10 | `GET /` | 200 | 0 ms | 148 ms |
| 11 | `GET /api/health` | 200 | 1 ms | 119 ms |
| 12 | `GET /api/cafe` | 200 | **59 ms** | 5,132 ms |

(A second tail session replayed nine of these events with identical numbers; it is not a separate run.)

### 4.1 Findings

1. **The platform metric is available and is not latency.** `cpuTime` and `wallTime` diverge by two orders of
   magnitude (42 ms vs 4,957 ms). Any future report must quote `cpuTime`.
2. **Requests costing 39–59 ms of CPU were served normally** (HTTP 200, `outcome ok`, no
   `exceededCpu`/1102). Workers Free documents a 10 ms CPU limit per request with termination on breach, so
   **this deployment is not behaving like a 10 ms-capped Worker**. Either the account is not on Workers Free,
   or the Free ceiling is not enforced here as documented. The plan itself was not read from billing and is
   **not** asserted either way.
3. **The expensive part is not Argon2id — it is database initialisation.** `worker/index.js` calls
   `ensureDb` on every `/api/*` request, and `ensureDb` runs the full schema batch + migrations + seed checks
   once per isolate (`worker/db.js`, module-level `ready`). Those cold-isolate requests are the 39–59 ms ones.
   Warm requests in the same session cost **1 ms**; a static asset costs **0–1 ms**.
4. **Consequence for a genuinely Free plan:** even a menu fetch or `/api/health` would breach a hard 10 ms
   ceiling before Argon2 is involved. If the pilot target really is Workers Free, this initialisation cost is
   an independent blocker, and it is the cheaper one to fix (an idempotent, once-per-deployment migration
   rather than a per-isolate batch).
5. **The Argon2 figure is still unknown.** Nothing in this table measures a derivation — event 2 exited before
   it. It is *not* evidence that Argon2 fits, and *not* evidence that it does not.

## 5. The exact remaining measurement (needs no deployment)

Once a staging café has an Argon2id hash — created through the operator console, or by the owner setting a
password on a staging device — run exactly this. Do not use production, do not reuse the pilot owner's real
password, and do not lower `m`, `t` or `p` to make a number look better.

```bash
# 1. One tail session per probe; capture the platform field, not curl's timer.
npx wrangler tail corner-cup-staging --format json > tail-login.jsonl

# 2. In a second shell: 10 correct-password sign-ins, 10 wrong-password sign-ins.
for i in $(seq 10); do
  curl -s -o /dev/null -X POST \
    -H 'content-type: application/json' \
    -H 'origin: https://corner-cup-staging.rahilbisen8.workers.dev' \
    -d "{\"password\":\"$TEST_PASSWORD\"}" \
    https://corner-cup-staging.rahilbisen8.workers.dev/api/cafes/corner-cup-staging/admin/login
  curl -s -o /dev/null -X POST -H 'content-type: application/json' \
    -H 'origin: https://corner-cup-staging.rahilbisen8.workers.dev' \
    -d '{"password":"wrong-password-for-measurement"}' \
    https://corner-cup-staging.rahilbisen8.workers.dev/api/cafes/corner-cup-staging/admin/login
done

# 3. Baseline in the same session: a static asset and /api/health.
curl -s -o /dev/null https://corner-cup-staging.rahilbisen8.workers.dev/
curl -s -o /dev/null https://corner-cup-staging.rahilbisen8.workers.dev/api/health

# 4. Stop the tail (Ctrl+C) and read the platform numbers.
node -e '
const fs=require("fs");
for (const raw of fs.readFileSync("tail-login.jsonl","utf8").split(/\n(?=\{\n?)/)) {
  if (!raw.trim().startsWith("{")) continue;
  const e=JSON.parse(raw);
  const u=e.event?.request?.url?.replace("https://corner-cup-staging.rahilbisen8.workers.dev","");
  console.log(`${e.cpuTime}ms cpu  ${e.wallTime}ms wall  ${e.outcome}  ${u}`);
}'
```

Notes that keep the numbers valid:

- Sign-in is rate-limited to 8 failures per 10 minutes per café+IP; 10 wrong attempts will lock that IP out.
  Either send five wrong attempts per window with a pause, or accept that the last few answer 429 — record
  which is which rather than discarding the run.
- Each correct-password sign-in creates a session row and a cookie; sign out between attempts, or expect the
  session table to grow (staging only).
- Report the **p50 and the maximum** of the correct-password `cpuTime` values, the same for wrong-password, and
  the static-asset baseline. One number is not a measurement.
- Re-run once after a quiet period so a cold isolate's initialisation cost is visible separately from the
  derivation.

## 6. Decision rule (unchanged)

- Correct-password CPU comfortably under the ceiling of the plan the pilot will actually run on → no change;
  ship as is.
- Over it → Workers Paid (30 s default) or an explicitly approved design change. **Never** a weaker hash, a
  lower `m`, a cached plaintext comparison, or an auth shortcut.
- If the target plan is Workers Free and §4.1(4) holds, the per-isolate `ensureDb` batch must be addressed
  regardless of Argon2.

## 7. Derivation-only CPU measurement (2026-11-25, local)

**Method.** `scripts/measure-argon2-cpu.mjs` — the same wasm bytes and the same call shape as
`worker/passwords.js` `derive()`, with the parameters read from that file and asserted (`m=19456, t=2, p=1`;
the script exits non-zero if they differ). It reports **process CPU** (`process.cpuUsage()` user+system),
not wall-clock, for one derivation, after a warm-up. Ten samples, Node v26.13.1, Windows x64, AMD Ryzen 5 220.

| Metric | Run 1 CPU (ms) | Run 2 CPU (ms) | Run 2 wall (ms) |
|---|---:|---:|---:|
| warm-up (includes wasm instantiation) | 78.0 | 78.0 | 46.5 |
| min | 15.0 | 15.0 | 26.2 |
| **p50** | **31.0** | **32.0** | 29.3 |
| mean | 34.4 | 42.2 | — |
| **max** | **63.0** | **94.0** | 40.3 |

Three runs on the same tree. The Windows process-CPU clock ticks at ~15.6 ms, so individual values are
quantised (15/31/47/63/94); p50 was **31, 32 and 47 ms** — the third run was taken while two local dev Workers
were running, and process CPU is load-sensitive on this machine. The 94 ms value is a six-tick outlier (GC or
scheduler noise). Treat the **31–47 ms p50 range**, not one number, as the result. Wasm SHA-256: SIMD `50647e10…8b4b0e`,
no-SIMD `1f16d8de…bc4f8e`. Raw record (run 2): `ARGON2ID_CPU_LOCAL_2026-11-25.json`.

**What this establishes**

1. The KDF itself costs **tens of milliseconds of CPU** on a desktop core — not 3–5 ms. A hard 10 ms
   per-request CPU cap cannot host this derivation at these parameters on comparable hardware.
2. The earlier 65/67/68 ms wall figures were dominated by the derivation, not by HTTP or D1. That was the
   open question about those numbers, and it is now answered.
3. Database initialisation is a **separate** cost, already measured on-platform at 39–59 ms cold and 1 ms
   warm (§4). For a warm isolate, login platform CPU ≈ derivation CPU + query; for a cold one, add the
   `ensureDb` batch.

**What this does not establish**

- The platform `cpuTime` for a login, or the plan's ceiling. A desktop Node measurement is not a Cloudflare
  measurement, and the 15.6 ms Windows timer granularity quantises the samples (hence 15/31/47/63).
- That the deployed Worker would be terminated. The observed staging deployment served 39–59 ms CPU requests
  without termination (§4.1), so a Free-tier 10 ms cap is *not* demonstrated by this machine either.

**Why the platform number is still blocked.** The staging café has `pass_hash = NULL`; producing a hash needs
the operator credential (unreadable) or an owner session, and the mission forbids changing staging. A new
deployment to measure it is also forbidden. So the outstanding measurement is unchanged: §5, run by the owner
on an environment that has an Argon2 hash, with the plan name read from billing at the same time.

**Decision input, stated plainly:** if the pilot targets Workers Free (10 ms), this derivation alone exceeds
the cap by roughly 3–6× even before `ensureDb`. The honest options are Workers Paid, or an explicitly
approved design change — never a weaker hash.

---

## 8. Can a permitted environment produce a platform CPU reading? No (2026-11-25)

Every environment that has a real Argon2 hash lacks a platform `cpuTime` metric, and the only environment
with that metric lacks a hash — and may not be written to.

| Environment | Platform `cpuTime`? | Real Argon2 login? | Permitted now? | Verdict |
|---|---|---|---|---|
| Local pilot `127.0.0.1:8788` | **No** — `wrangler dev` exposes no platform metric | Yes (owner hash exists) | **Must not be interrupted**, and sign-in needs a TOTP code | Cannot be used, and would not answer the plan question |
| Local harness `127.0.0.1:8790` | **No** | **Yes** — the harness owner password (`harness-owner-password`) is a real Argon2 login through the production handler | Yes | Proves the code path, not Cloudflare CPU. A V8 sample profile here would be *local* CPU, not the platform's `cpuTime` |
| Staging Worker | **Yes** (tail `cpuTime`) | **No** — `pass_hash = NULL` | Reads/tail yes; writes, secret changes and deploys **no** | Creating a hash needs the operator credential (unreadable) or an owner session; the deployed build also predates the MFA schema. Blocked by the mission's own restrictions, not by tooling |
| Production (Sites) | Unknown | No access | Prohibited | Unpublished, platform account, no export |

The measurement script itself is not the gap: `scripts/measure-argon2-cpu.mjs` reads the parameters from
`worker/passwords.js` and refuses to run if they differ, asserts the same two wasm imports and the same
salt/tag sizes, and instantiates the same package binaries (hashes recorded in the JSON). What it cannot do is
run inside Cloudflare and ask the platform what the request cost.

### 8.1 Request-cost separation, as far as the evidence goes

| Component | Evidence | Value |
|---|---|---|
| Per-isolate database initialisation (`ensureDb`) | Platform `cpuTime`, cold `/api/health` and `/api/cafe` | 39–59 ms cold, 1 ms warm |
| Static asset serving | Platform `cpuTime` | 0–1 ms |
| Argon2id derivation | Local process CPU, exact wasm/params (not platform) | p50 31–47 ms, max 63–94 ms (three runs) |
| Session row insert + HMAC token | **Not isolated** | A few D1 writes plus one HMAC; needs a per-event tail on a deployed build to quantify |
| Whole password-only login | Wall clock only (old probe) | 65–68 ms elapsed, not CPU |

A warm login therefore costs at least the derivation plus session work, and a cold one adds `ensureDb`. The
exact split needs the platform number that is missing.

### 8.2 Evidence needed to close this blocker

1. A deployment (or preview) running **this** build, with a café that has a real Argon2 hash and a known
   test-only password.
2. A `wrangler tail --format json` session capturing per-event `cpuTime` for **10 correct** and **10 wrong**
   sign-ins (mind the 8-per-10-minute lockout), plus `/api/health`, `/api/cafe` and `/` as baselines.
3. One **cold-isolate** run and one **warm** run, so `ensureDb` is separated from the derivation.
4. The **plan name read from billing**, not inferred from behaviour.
5. A decision recorded against that ceiling: stay, Workers Paid, or an approved design change. Parameters
   stay `m=19456 KiB, t=2, p=1` in every branch.

None of the five can be obtained without a deployment, a credential change or a plan decision — all outside
this mission's restrictions. The blocker therefore remains **UNRESOLVED**, not "passing".

---

## 9. Corrections

| Date | Correction |
|---|---|
| 2026-11-24 | First platform CPU capture for this project. Earlier 65–68 ms figures are elapsed wall-clock only and are not restated as CPU anywhere. |
| 2026-11-25 | Derivation-only CPU measured locally (§7), two runs: p50 31–32 ms, max 63–94 ms. This is **not** platform `cpuTime`; the launch decision remains open pending §5 and the plan name. |
| *(next)* | Record the Argon2-specific platform p50/max here once §5 has been run, with the plan name read from billing at the same time. |
