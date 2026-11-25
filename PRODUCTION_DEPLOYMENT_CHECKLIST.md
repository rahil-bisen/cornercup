# PRODUCTION DEPLOYMENT CHECKLIST

**Status:** nothing in this document has been executed. Every unchecked box is an external action that needs
the owner's explicit approval. Items marked **[APPROVAL]** must not be attempted by an agent.

Legend: ✓ done and verified locally · ☐ not done · **[APPROVAL]** requires the owner's go-ahead.

---

## 0. Hard blockers (deployment is refused until all are true)

| # | Condition | State |
|---|---|---|
| B-1 | **Production D1 identity resolved** — `wrangler.jsonc` still carries `00000000-0000-0000-0000-000000000000` | ☐ **blocking** |
| B-2 | The 12 untracked worker modules are in version control, so a clean clone builds | ☐ **blocking** (needs first commit approval) |
| B-3 | Owner sign-in CPU measured on workerd (Argon2id ≈47 ms vs 10 ms Free limit) | ☐ **blocking** (needs a deployment) |
| B-4 | TOTP MFA implemented for owner sign-in | ☐ **blocking** for a real café |
| B-5 | Production and preview Sites environments made safe or taken offline | ☐ **blocking** (currently serving the 2026-11-10 build) |
| B-6 | Razorpay explicitly configured as disabled (or approved as enabled with reconciled test keys) | ☐ **blocking** |
| B-7 | Full suite green on the exact tree being built | ✓ locally (see `MASTER_REMEDIATION_REPORT.md` §9) |

## 1. Pre-flight (local, no approval needed)

- ✓ `npm ci` from the preserved lockfile succeeds.
- ✓ `npm run build` succeeds — 278.09 kB JS / 89.95 kB gzip, 28.81 kB CSS / 6.39 kB gzip.
- ✓ `npm test` passes on the current tree (harnesses on 8789 and 8790).
- ✓ `npm audit` → 0 vulnerabilities.
- ✓ `worker/http.js` applies CSP/HSTS/nosniff/DENY/referrer/permissions to JSON **and** static responses.
- ✓ `tests/security.headers.test.mjs` proves the header set on a live Worker response.
- ☐ Re-run all of the above immediately before the deploy and attach the output to the release record.

## 2. Configuration to confirm before building **[APPROVAL for any change]**

| Item | Current value | Must be |
|---|---|---|
| Worker name | `corner-cup` | unchanged |
| Entry | `worker/index.js` | unchanged |
| Compatibility date | `2025-11-01` | unchanged |
| Assets | `./dist`, binding `ASSETS`, SPA fallback, `run_worker_first: true` | unchanged |
| D1 binding | `DB` → placeholder id | **real database id** (B-1) |
| `SERVICE_MODE` | `counter` | must match the café actually onboarded |
| `CAFE_TZ_OFFSET_MIN` | `330` | café's timezone |
| WASM rule | `CompiledWasm` glob `**/*.wasm` | unchanged (Argon2id needs it) |
| Observability | enabled | enabled |

Secrets (names only — never values): `ADMIN_SECRET`, `OWNER_PASSWORD` (bootstrap only), `OPERATOR_PASSWORD`,
`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and legacy `ADMIN_PIN` (**should be deleted** once no old build is
served — it is unused by current code).

## 3. Deployment steps (in order) **[APPROVAL required for 3.2 onward]**

1. **Freeze.** Announce the window; no source changes during the deploy.
2. **[APPROVAL]** Unpublish the stale production and preview environments (or accept the risk in writing).
3. **[APPROVAL]** Export the existing Sites database before touching anything (it holds real data, 266 KB).
4. **[APPROVAL]** Create the production D1 database; record its id in `wrangler.jsonc` (B-1). Run the schema
   through `ensureDb` on first boot; do **not** hand-run migrations.
5. **[APPROVAL]** Apply secrets. `ADMIN_SECRET` must be fresh and ≥32 random characters. `OWNER_PASSWORD`
   should be set only for the very first boot and rotated away afterwards.
6. **[APPROVAL]** `npm run build && npx wrangler deploy --dry-run` → confirm `DB` binds the real id and that
   nothing unexpected is uploaded.
7. **[APPROVAL]** Deploy.
8. Verify (§4). Do not announce the café until §4 passes.

## 4. Post-deploy verification (read-only)

| Check | Expected |
|---|---|
| `GET /api/health` | `{status:"ok",database:"ok"}` and **all six security headers** present |
| `GET /` | SPA shell, CSP present, no console errors |
| Header audit | CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy` |
| Owner sign-in | succeeds **and** CPU under the plan limit (B-3); no Error 1102 in logs |
| Re-authentication | wrong current password → 401 `reauth_required`, **nothing written**; correct → 200 |
| Sign-out | copied cookie → 401 afterwards |
| Static asset | hashed bundle 200, correct content type |
| Guest menu | loads with real menu data, no tenant leakage |

## 5. Rollback

Preconditions: the previous deployment's artifact stays available (Sites keeps it; Workes keeps the last
version), and the database export from step 3 exists.

1. **Code rollback:** `wrangler rollback` (or re-publish the previous Sites deployment). No database change.
2. **If the schema is at fault:** restore the export into a fresh database, then repoint `DB`. Never run a
   down-migration against live data.
3. **If a secret is compromised:** rotate `ADMIN_SECRET` (ends every session, also invalidates guest tracking
   links derived from it — announce it), then `RAZORPAY_KEY_*` via the provider dashboard.
4. Record what was rolled back, when, and the artifact hash.

## 6. Explicitly out of scope until approved

- Enabling Razorpay. Payments stay disabled by policy; the code path is validated but never exercised against a
  live gateway.
- Custom domains and DNS.
- Deleting any database, backup or environment.
- Any migration on production data.

## 7. Sign-off

| Role | Name | Date | Scope approved |
|---|---|---|---|
| Owner | | | |
| Deployer | | | |
| Rollback owner | | | |
