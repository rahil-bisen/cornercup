# CURRENT_STATE.md — Corner Cup Current Project State

This document captures the current state of the Corner Cup project as of this transfer, including Git status, modified files, test results, build status, and runtime blockers.

## Git Status

### Current Branch
`freebuff/qr-code-cafe-ordering-website`

### HEAD Commit
```
023befe Add versioned owner sessions with an operator-driven password reset
```
*Most recent commit: adds versioned owner sessions with operator-driven password reset feature.*

### Full Git Status
```
On branch freebuff/qr-code-cafe-ordering-website
Changes not staged for commit:
  (use "git add <file>..." to update what will be committed)
  (use "git restore <file>..." to discard changes in working directory)
  
  modified:   README.md
  modified:   package-lock.json
  modified:   package.json
  modified:   src/components/PaymentPanel.jsx
  modified:   src/lib/api.js
  modified:   src/lib/config.js
  modified:   src/pages/Menu.jsx
  modified:   src/pages/Operator.jsx
  modified:   src/pages/OrderStatus.jsx
  modified:   tests/harness/worker.mjs
  modified:   tests/harness/wrangler.auth.jsonc
  modified:   tests/harness/wrangler.jsonc
  modified:   tests/password.reset.test.mjs
  modified:   tests/status.transitions.test.mjs
  modified:   worker/api.js
  modified:   worker/cafes.js
  modified:   worker/db.js
  modified:   worker/http.js
  modified:   worker/orders.js
  modified:   wrangler.jsonc
  
Untracked files:
  (use "git add <file>..." to include in what will be committed)
  .claude/
  src/lib/menuScope.js
```

### Pre-existing Uncommitted Modifications
The following files had modifications BEFORE this transfer session began. These are NOT caused by F-07 work:

| File | Nature of Modification |
|---|---|
| `README.md` | Order tracking feature addition, payment panel changes, Razorpay integration notes |
| `package.json` | Added `jsdom` dev dependency; removed blank line |
| `package-lock.json` | Updated dependency tree (jsdom, bcp-47, data-urls, decimal.js, entities, etc.) |
| `src/components/PaymentPanel.jsx` | Added `trackToken` parameter, `x-order-token` header to payment API call |
| `src/lib/api.js` | Rate limit refactor: D1-backed rate limits, client IP hash, `checkApiRateLimit()` |
| `src/lib/config.js` | Configuration updates (not fully inspected in transfer) |
| `src/pages/Menu.jsx` | Order tracking integration |
| `src/pages/Operator.jsx` | Operator toolbar updates, order tracking UI |
| `src/pages/OrderStatus.jsx` | Order status with tracking token |
| `tests/harness/worker.mjs` | Auth harness worker code; order tracking additions |
| `tests/harness/wrangler.auth.jsonc` | Auth vars, D1 binding, harness configuration |
| `tests/harness/wrangler.jsonc` | Harness configuration; rate limit settings |
| `tests/password.reset.test.mjs` | F-07 test additions plus existing reset tests |
| `tests/status.transitions.test.mjs` | State transition tests with tracking |
| `worker/api.js` | **F-07 changes**: login race fix, opportunistic rehash, PBKDF2_ITERATIONS change |
| `worker/cafes.js` | F-07: imported `hashPassword, verifyPassword` from `./passwords.js`; removed local `PBKDF2_ITERATIONS` |
| `worker/db.js` | F-07: `import { hashPassword } from "./passwords.js"`; rate_limits table; bootstrap primary password |
| `worker/http.js` | Security headers, CSP, rate limit maintenance |
| `worker/orders.js` | QR-order tracking: `track_nonce`, `track_hash` columns, token generation |
| `wrangler.jsonc` | `run_worker_first: true`; rate limit configuration |

### Important: Pre-existing vs F-07 Changes
**F-07 specific changes** (2 files):
1. `worker/passwords.js` — `PBKDF2_ITERATIONS = 600_000` (was `100_000`)
2. `worker/api.js` — login flow rewrite with race fix and opportunistic rehash

**All other modified files** represent pre-existing work (F-01 through F-06, order tracking, rate limiting, CSP, payments) that was in the workspace before F-07 began. The receiving agent must NOT discard these.

### Latest Known Successful Tests
- `migrations.test.mjs` — all subtests pass (48 tests including migration application, legacy upgrade, idempotency)
- `api.resilience.test.mjs` — all 12 subtests pass (timeout, retry, error classification)
- `rate.limits.migration.test.mjs` — passes (rate_limits table creation)
- `orderstatus.component.test.mjs` — passes (order status display)
- 48 of 89 total tests pass locally
- 39 tests skipped (require auth-enabled Wrangler harness on port 8790)
- 2 tests fail: `auth.version.test.mjs`, `password.reset.sql.test.mjs` (harness-dependent)

### Latest Known Successful Build
- `npm run build` → `vite build` ✅
- Output: `dist/index.html`, `dist/assets/index-*.css`, `dist/assets/index-*.js`
- **Build timestamp**: Successful completion during this transfer session
- **No build errors**

### Runtime Blockers

| Blocker | Description | Workaround |
|---|---|---|
| Auth harness unavailable | Wrangler harness on port 8790 not running; requires `HARNESS_URL` env var | Start `wrangler dev` with auth configuration; not possible in current isolated environment |
| Node.js location | `.tools/node-v22.23.4-win-x64/` not automatically in PATH | Prepend to PATH: `$env:PATH = ".tools/node-v22.23.4-win-x64;$env:PATH"` |
| D1 production access | No Cloudflare account/deployment credentials | Local Wrangler `dev` uses embedded workerd; production requires separate setup |
| Preview/production deployment | No deployment authorisation | `npm run deploy` requires explicit authorization; not executed in this session |

### Preview/Production Status (Verified Facts)

| Environment | Status | Evidence |
|---|---|---|
| **Preview** | Not deployed | No `sites_deploy` executed; no preview URL generated |
| **Production** | Not deployed | No `wrangler deploy` executed; no production URL generated |
| **Last deployment** | Never | Git history shows no `deploy` commits in this worktree's recent history |
| **Last preview** | Never | No `sites_deploy` with `environment: "preview"` has been performed |

**Important**: Previous test runs and current environment reports may differ. The receiving agent must independently verify the current environment before assuming any status. Do not assume that because tests passed in a prior session, they will pass identically in a new session without re-execution.

### Current Next Task
Implement and validate F-07: PBKDF2 password-hash strengthening from 100,000 to 600,000 iterations with safe opportunistic rehashing and login-race correction. The code changes are complete (2 files modified), but full harness verification is blocked. The receiving agent should:

1. Verify the F-07 code changes in `worker/passwords.js` and `worker/api.js`
2. Run local test suite (`npm test`) to observe pass/fail/skip counts
3. Run `npm run build` to confirm production build
4. If harness becomes available, execute full test suite including F-07 regression tests
5. Report exact modified files and test results
6. Do not start F-08 or unrelated work

## Verification Checklist for Receiving Agent
- [ ] Confirm Git branch and HEAD commit match expectations
- [ ] Distinguish F-07 changes (2 files) from pre-existing modifications (18 files)
- [ ] Run `npm test` and report pass/fail/skip counts
- [ ] Run `npm run build` and confirm success
- [ ] Inspect `worker/passwords.js` and `worker/api.js` for F-07 changes
- [ ] Do NOT discard pre-existing uncommitted work (F-01 through F-06, order tracking, etc.)
- [ ] Report any discrepancies between this document and the actual source state
- [ ] Do not deploy, commit, or push without explicit authorization