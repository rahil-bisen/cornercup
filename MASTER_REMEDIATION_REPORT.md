# MASTER REMEDIATION REPORT

**Date:** 2026-11-20
**Scope:** local repository, local tests, local builds, local documentation.
**Outcome:** the actionable local blockers are resolved or precisely documented. Production launch is **NO-GO**
for reasons that are external or measurement-dependent, not because of unresolved code defects.

---

## 1. Initial condition

| Fact | Value |
|---|---|
| Branch / HEAD | `freebuff/qr-code-cafe-ordering-website` / `023befea5b337f8daa783ac7b7fd323bd8dffac8` (2026-11-12) |
| Tracked files | 45, of which **27 modified** |
| Untracked files | 177 (98 collapsed entries), including **12 modules the Worker imports** |
| Staged | 0 |
| Remote | none |
| Build from a fresh clone | **impossible** — 12 imported modules were untracked |
| Public production deployment | published, last deployed **2026-11-10T07:48:37Z**, serving a build that predates every
  2026-11-15/16 fix |
| `wrangler.jsonc` production D1 | `00000000-0000-0000-0000-000000000000` (placeholder) |

## 2. Source preservation — IMPLEMENTED and VERIFIED

Two independent snapshots, neither overwriting the other:

| Snapshot | Files | Bytes | Manifest SHA-256 | Result |
|---|---:|---:|---|---|
| `stage13-1-20261120T114817Z` (pre-remediation) | 228 | 3,246,477 | `c23a7e076616580378bc738b74dca6fb402a01d8f81d53c906bff994a0de00d5` | **VERIFIED** |
| `stage14-20261120T121328Z` (post-remediation) | 237 | 3,341,749 | `be69bbba7ead0034e608da82648ac3649ffb4a81cf08e5c01f4082a59f1b2cf4` | **VERIFIED** |

Each contains: extracted `worktree/` (paths preserved), `worktree.tar`, `MANIFEST.sha256`, `filelist.txt`,
`corner-cup-repo.bundle` (all refs), git state files, and `EXCLUSIONS.txt`. Verification is per-file size **and**
SHA-256 against the live tree: 0 mismatches, 0 extras, 0 omissions. All **12** critical modules present:
`passwords`, `session`, `tracking`, `orderids`, `owner`, `workos`, `jwt`, `pkce`, `revocations`, `authmode`,
`payments`, `menuScope`.

Excluded and never read: `.dev.vars`, `.env*`, keys, `.wrangler/` (holds a staging data copy), `.qa-logs/`,
`node_modules/`. The tracked `.dev.vars.example` templates **are** included — they contain empty placeholders.

## 3. Build reproducibility — reconciled, and honestly incomplete

Every relative import in `worker/` and `src/` was resolved against the filesystem. Result: **0 missing targets**.
The application is complete on disk but **not reproducible from Git**, because 12 of those files are untracked.

| Imported from | Modules |
|---|---|
| `worker/api.js` | `authmode`, `cafes`, `db`, `http`, `orderids`, `orders`, `owner`, `pkce`, `revocations`, `session`, `tracking` |
| `worker/owner.js` | `cafes`, `http`, `jwt`, `pkce`, `revocations`, `session`, `workos` |
| `worker/db.js`, `worker/cafes.js` | `passwords` |
| `worker/revocations.js` | `workos` |
| `src/pages/*` | `src/lib/{api,config,money,checkout,menuScope,payments,razorpay}.js` |

**Correct eventual source-control action:** commit the 12 modules plus the 5 test helpers they depend on
(`tests/harness/credentials.mjs`, `tests/lib/db.mjs`, `tests/setup/register.mjs`,
`tests/setup/argon2id-wasm-hooks.mjs`, `tests/fixtures/workos.mjs`) in one commit reviewed as production code,
then add a CI job that clones and builds. Both snapshots make this safe to do later; nothing was staged or
committed, because that requires the owner's approval.

## 4. What was implemented in this stage

Six files changed, one new test file, seven documents. No refactor, no feature.

| File | Change | Why |
|---|---|---|
| `worker/api.js` | `checkApiRateLimit` split into `checkReadRateLimit` (per-isolate fixed window, exported `createWindowLimiter`) and `checkDurableApiRateLimit` (unchanged D1 upsert). `READ_METHODS`, `API_READ_WINDOW_MS/MAX/MAX_KEYS`, `API_READ_MAX` override. Cleanup sampling now runs on the durable path only | Removes one D1 write per poll — the F-06 write-amplification defect |
| `src/pages/Admin.jsx` | `BOARD_POLL_MS = 10 s`; polling pauses on `visibilitychange`, refreshes immediately on return | 900 → 360 requests/hour per board; zero while hidden |
| `src/pages/OrderStatus.jsx` | `ORDER_POLL_MS = 15 s`; same visibility behaviour | 900 → 240 requests/hour per guest page |
| `tests/rate.readwindow.test.mjs` | **new**, 6 unit tests | Ceiling, boundary, isolation, bounded store, expiry-first reclaim, sustained polling |
| `tests/rate.limit.test.mjs` | 4 new tests (reads create no row; writes still counted; no shared counter; reads never clean) + 2 cleanup tests now trigger via a write | Proves the split against the real Worker |
| `tests/operator.revocation.test.mjs` | concurrent logout-all assertion made order-aware (at most one replacement valid, both originals revoked) | The old assertion encoded an ordering concurrency legitimately violates |

## 5. Production exposure — **CONFIRMED**

Evidence, unchanged from Stage 13.1 and re-checked today:

- Deployed **2026-11-10T07:48:37Z**; no deploy since. Every fix landed 2026-11-15/16.
- Live responses carry **no** CSP, HSTS, nosniff, `X-Frame-Options`, `Referrer-Policy` or `Permissions-Policy` —
  headers current code applies to every response (F-04). This is direct, externally observable proof of drift.
- Served bundle `d51fc7f2…` matches no local artifact; it lacks every F-19 client marker
  (`currentPassword`, `reauth_required`, `Current owner password`) and every managed-auth marker.
- **Razorpay credentials are bound on that deployment**, so an unreviewed build can present a payment UI.

**F-19 and F-10 are therefore CONFIRMED exposed** as *deployed behaviour*: the code cannot be current, and the
client cannot even send a current password. Server bytes remain unobservable (UNVERIFIED at byte level), which
is stated rather than glossed over.

## 6. Security matrix — F-01 to F-20

Full detail in `SECURITY_REMEDIATION_MATRIX.md`. Summary: **18 FIXED, 2 PARTIAL (F-07 provider contract,
F-09 payments disabled by policy), 0 critical open, 0 high open.** One low-severity behavioural item (N-06) and
one test-infrastructure item (N-09) remain open by choice.

No security control was removed, weakened, or bypassed to make anything pass. Argon2id parameters are untouched.

## 7. Rate limiting — fixed, with measured capacity

| Metric | Before | After |
|---|---:|---:|
| D1 writes per open board, 8 h | 7,200 | **0** |
| D1 writes, 5 boards, 24 h | 108,000 | **0** |
| Requests per board per hour | 900 | 360 (0 while hidden) |
| Writes per month, 5 boards + 200 orders/day | > 100,000 (quota exhausted in ~3 days) | ≈ 93,600 (94 %), driven by orders, not screens |

Login lockout, re-authentication, payment and operator limits remain durable and atomic. The documented
trade-off is that the **read** ceiling is per isolate rather than global — see
`RATE_LIMIT_CAPACITY_REPORT.md` §5, which states the bypass envelope and why it is acceptable on a free tier.

## 8. Authentication — decided, not deployed

`AUTHENTICATION_DECISION.md`: stay on local Argon2id + sessions + TOTP; do not integrate Firebase (it offers no
TOTP on a free budget) and do not switch to WorkOS until a sandbox exists. **Blocking fact:** Argon2id costs
~47 ms CPU locally and the Free plan allows 10 ms — owner sign-in on Workers Free is **UNVERIFIED and at risk**.
Reducing Argon2id is not an option, so the resolution is either a paid plan or the already-written managed path.

## 9. Testing and quality gates

| Gate | Result |
|---|---|
| Full suite (`npm test`, both harnesses up) | **445 tests, 445 pass, 0 fail, 0 skipped** (85.96 s, exit 0) |
| New rate-limit unit tests | 6/6 |
| Rate-limit suite against live Worker harness | 16/16 |
| F-10/F-19 suites (session, owner, operator, reauth) | pass, individually and in the full run |
| Frontend production build | pass — 278.09 kB JS / 89.95 kB gzip; 28.81 kB CSS / 6.39 kB gzip |
| Worker build (same Vite/wrangler pipeline) | pass (`wrangler deploy --dry-run` not run — no deploy) |
| `npm audit` | **0** info / low / moderate / high / critical |
| Schema consistency | covered by `migrations*` tests (fresh + legacy, second boot no-op) |
| Restored-database compatibility | Stage 11/12 harness retained; not re-run this stage |

**Flaky-test investigation (honest result).** Running four harness-heavy suites in one process produced 3–5
order-dependent failures, varying per run, all `403` from CSRF verification. A controlled A/B — swapping in the
**pre-change** `worker/api.js` from the verified snapshot and running the identical batch — reproduced the same
class of failures, so this is **pre-existing test-state coupling, not a product regression and not caused by this
stage's change**. Each file passes standalone (20/20 for `operator.revocation`), and the authoritative full run
above was clean. One genuine defect was fixed along the way: the concurrent logout-all assertion assumed both
replacements survive, which the shared auth version makes impossible by design.

## 10. Production infrastructure — plan only

`wrangler.jsonc` still binds the placeholder D1 id. It was **not** changed: that is a production binding edit and
needs approval. `PRODUCTION_DEPLOYMENT_CHECKLIST.md` lists the exact configuration table, the seven hard
blockers, the approved step order, post-deploy verification and rollback.

## 11. Order lifecycle and payments — verified locally, unchanged

Counter orders (`table_id = 0`, `table_label = "Counter"`, daily sequential `queue_no`) and dine-in orders
(real `table_id`, `queue_no` NULL) are covered by `orders.integration`, `orderids`, `orderid.concurrency`,
`status.transitions` and `orders.deep`. Guests may only select `counter` payment; a `confirmed` payment cannot be
downgraded; webhook signature, amount and currency are re-checked; verification is idempotent. Razorpay stays
disabled by policy, so "production-ready payments" is **not** claimed.

## 12. Remaining blockers

| # | Blocker | Owner action required |
|---|---|---|
| 1 | Public production deployment serves the pre-fix build, with payments configured | Unpublish both environments (reversible) |
| 2 | Production D1 id is a placeholder | Create the database, record its id |
| 3 | 12 modules untracked — no reproducible build | Approve the first commit |
| 4 | Argon2id vs 10 ms CPU unmeasured on workerd | Approve a non-public deployment to measure |
| 5 | TOTP MFA not implemented | Approve the work, then launch |
| 6 | `.dev.vars.example` drift / no CI | Approve CI setup |
| 7 | Production database has no export | Export before any change |

## 13. External approvals required (nothing done)

Creating or changing production D1; unpublishing/publishing; applying or rotating secrets; creating a WorkOS or
Firebase account; a paid Workers plan; DNS; deleting any environment, database or backup; the first Git commit.
Each is listed with its exact action in `PRODUCTION_DEPLOYMENT_CHECKLIST.md` §3 and `AUTHENTICATION_DECISION.md` §6.

## 14. Rollback

Code: `wrangler rollback` / re-publish the previous Sites deployment (no data change). Data: restore the export
into a fresh database and repoint `DB` — never down-migrate live data. Secrets: rotate `ADMIN_SECRET` (ends all
sessions *and* invalidates guest tracking links) or the Razorpay pair via the provider dashboard. Source: restore
either verified snapshot; `git clone corner-cup-repo.bundle` restores history.

## 15. Recommendation

**NO-GO for production launch. CONDITIONAL GO to continue local development and to run the CPU measurement.**

Local code quality is not the blocker: the suite is green, the audit is clean, the build is reproducible from the
snapshot, and the one genuine write-amplification defect is fixed and proven. The blockers are a stale public
deployment, an unresolved production database identity, an unreproducible Git tree, an unmeasured CPU cost, and
the missing second factor. Four of those five need the owner's approval rather than more code.

## 16. Compliance statement

- **Production untouched** — no deploy, no unpublish/publish, no binding or secret change, no order, no payment,
  no authentication attempt. The only access was passive `GET`s of public static assets in Stage 13.1.
- **Staging untouched** — no deploy, no orders, no payment, no auth or session change, no migration.
- **Existing databases preserved** — nothing dropped, migrated or written. All test databases are local and
  isolated (`tests/harness/.state-stage14`, `.state-plain`).
- **Existing backups preserved** — `stage11-20261119T155325Z`, `qa`, `stage13-1-…` all intact; two new snapshots
  added, none overwritten.
- **Secrets untouched** — no secret read, printed, rotated or added.
- **No deployments of any kind.**
- **No destructive Git operations** — no clean/reset/checkout/stash; nothing staged or committed.
- **All pre-existing modified and untracked work preserved** — 27 modifications and every untracked file remain;
  the only additions are the six changed/new source and test files listed in §4 and the documents.
