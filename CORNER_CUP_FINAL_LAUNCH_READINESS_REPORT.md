# Corner Cup — Final Launch Readiness Report

Date: 2026-11-23
Branch: `freebuff/qr-code-cafe-ordering-website` (worktree dirty by design; nothing committed)
Scope: local engineering only — no production deploy, no republishing, no payments, no production access, no GitHub, no paid services

**Verdict: CODE COMPLETE — EXTERNAL SETUP REMAINS**

---

## 1. Executive summary

Every engineering task that can be completed without account access, money, GitHub or a human was
completed and re-verified in this pass. The product builds, its full suite passes, its customer and
owner surfaces were exercised in a real browser, the image path works against workerd R2, and the
database install/upgrade/restore path passes a disposable drill.

Three items remain outside engineering control, unchanged from the previous pass:

1. **R2 is disabled on the Cloudflare account** (`code 10042`). The free Sites quota allows 1 GB with
   zero used, but a Sites-provisioned bucket can only be attached by deploying Project A, which is
   prohibited. No bucket was created and no existing data was touched.
2. **Argon2id CPU consumption on Workers Free remains unresolved.** Argon2id is configured at
   `m=19456 KiB, t=2, p=1`, unchanged. A previous probe recorded approximately 65–68 ms per login,
   but those are elapsed wall-clock timings, not platform-reported CPU time, so they do not
   establish that the Free plan's 10 ms per-request ceiling is exceeded. Compatibility stays
   unresolved until actual CPU time is measured in the deployed Worker runtime. The hash must not
   be weakened to obtain a passing result.
3. **Production D1 existence and current status remain unresolved.** Stage 16A previously identified
   a production database under a different Freebuff account; the latest authenticated-account check
   did not find one, which does not establish that it was deleted. No production export or backup
   has been obtained. The export/encrypt/checksum procedure was proved end to end on a disposable
   local database.

No production resource was deployed, published, paid for or modified in this pass.

---

## 2. What this pass actually did

| Area | Work performed | Evidence |
| --- | --- | --- |
| Baseline | Read the prior reports; verified git branch, dirty tree, D1 list, Sites publication state | `git status`, `wrangler d1 list`, `sites_list` |
| R2 | Re-attempted bucket listing; confirmed R2 still disabled; inspected free Sites R2 quota | API error `10042`; quota `r2Bytes 1 GB, used 0` |
| Runtime | Re-ran the complete validation gate twice (before and after the only source edit) | 492/492 both runs |
| Database | Re-ran the disposable fresh-install / dump / restore / legacy-upgrade drill | 13/13 pass |
| Recovery | Proved export → SHA-256 → AES-256-CBC (PBKDF2, 200k) → decrypt → hash match → integrity check | byte-identical round trip |
| Customer UI | Mobile layout at 360/390/430/1280; guest checkout; tracking; error state | live browser against `wrangler dev` |
| Owner UI | Sign-in screen, wrong-password rejection, no-session assertion | live browser |
| Payments | Source audit of gating, webhook validation, idempotency; frontend bundle secret scan | 0 credentials in `dist/` |
| Accessibility | Found and fixed unannounced error messages (F-39); verified live | `role="alert"` present, no cookie |
| Docs | This report plus addenda in six operational documents | below |

The only source change in this pass is the accessibility attribute described in §7. No Argon2id
parameter, authentication control, binding, secret or migration was modified.

---

## 3. R2 resource status (Execution A)

| Item | Result |
| --- | --- |
| Intended bucket name | `corner-cup-images` (confirmed in `wrangler.jsonc`) |
| Existing bucket with conflicting data | none — the API cannot even list buckets |
| Cloudflare account R2 | **disabled** — `Please enable R2 through the Cloudflare Dashboard. [code: 10042]` |
| Sites free quota | 1,000,000,000 bytes storage, 25,000 Class A writes, 250,000 Class B reads per month; **0 used** |
| Sites provisioning | possible in principle, but the bucket attaches only through a Sites deployment of Project A, which is prohibited; it would also live on a different Cloudflare account than `wrangler deploy` uses |
| Bucket created | **no** |
| Binding state | `r2_buckets: [{ binding: "IMAGES", bucket_name: "corner-cup-images" }]` preserved in `wrangler.jsonc` |
| Local integration | `wrangler dev` exposes `env.IMAGES (corner-cup-images) R2 Bucket local`; upload/read/delete/fallback verified |

Per the mission's own instruction, the blocked R2 step was stopped in isolation and every other task
continued. No production or staging database was read or altered, and no object was uploaded to any
remote bucket.

**Operations already proven against workerd R2 (previous pass, unchanged code):** upload accepted,
public route serves `image/png` with `nosniff` and immutable caching, cross-café read refused (404),
upload without CSRF refused (403), non-image refused, oversize refused (413), removal deletes the
object and restores the category default, unknown key never served. Public serving resolves the key
from D1 by `id AND cafe_id`, never from the URL.

---

## 4. Runtime CPU and Argon2id (Execution B)

### Current configuration

Argon2id remains configured at `m=19456 KiB, t=2, p=1`, verified in source today. Nothing about the
hash was changed in this pass, and nothing may be changed to make a budget check pass.

### What the previous probe actually recorded

A temporary probe Worker (`corner-cup-cpu-probe`) was deployed to the real Cloudflare runtime
(usage model `standard`), exercised, then deleted; the probe URL returns 404. What it recorded were
**elapsed response timings**, which include isolate scheduling, request handling and response
writing:

| Endpoint | Elapsed time (ms), wall-clock |
| --- | --- |
| `/login` correct password | 65 / 67 / 68 |
| `/wrong` wrong password | 53 / 62 / 67 |
| `/ping` baseline | 0 |

### Conclusion

These are elapsed wall-clock measurements, not Cloudflare-reported CPU time. They are consistent
with an expensive key derivation but they **do not independently establish CPU consumption**, and
they cannot by themselves prove or disprove the Workers Free 10 ms per-request ceiling. An earlier
version of this report described the 65–68 ms figure as "Workers CPU"; that characterisation was
unsupported and is corrected here.

**Workers Free compatibility remains unresolved** until actual platform-reported CPU time is
measured in the deployed Worker runtime (for example the CPU time reported per request in
`wrangler tail` or the Workers analytics CPU histogram). Do not weaken the hashing parameters to
obtain a passing result. The eventual decision is still Workers Paid or a separately approved design
change, but that decision is not yet forced by evidence.

- Memory on the isolate also remains unmeasured.
- Re-measuring was deliberately not attempted in this pass: it requires a deployment, which was
  outside the authorised scope.

---

## 5. Production database backup (Execution C)

### Status

**Production D1 existence and current status remain unresolved.** Stage 16A previously identified a
production D1 database under a different Freebuff account:

| Item | Value recorded by Stage 16A |
| --- | --- |
| Database name | `site-6e1c6f7a9a9f4e098f778f9754221b0a` |
| Database ID | `17d9568d-52fd-48c2-8761-b74d97688589` |
| Binding | `DB` in the production Sites environment |

Stage 16A found it inaccessible through the currently authenticated Wrangler account, because its
account ID differed from the Freebuff account owning the database. The latest authenticated-account
check (`wrangler d1 list`) returned only:

- `corner-cup-staging`
- `corner-cup-stage11-restore-20261119T155325Z` (a restore test)

That result does **not** establish that the previously identified production database was deleted or
does not exist; it only shows it is not listed for this account. There is no export API in the
available Sites tooling, and the old production Worker must not be republished to expose one.
**No production export or backup has been obtained.** Account ownership and access must be confirmed
with Freebuff support or the account owner. This report does not claim the database is currently
accessible, active, deleted, or backed up.

### Procedure proved today on a disposable local database

1. `wrangler d1 export corner-cup --local --output corner-cup-<timestamp>.sql` → 49,592 bytes.
2. `sha256sum` → `673256ef40dc1925c1f5a0e768abde51214703bd717fa264f2b6aca9db364773`.
3. `openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt` with a random 128-bit passphrase.
4. Decrypt and `cmp` → **byte-identical**; SHA-256 matched again.
5. Import the decrypted SQL into a fresh SQLite database → 24 tables, `integrity_check = ok`,
   `foreign_key_check` 0 rows.
6. Plaintext decrypted copy deleted; only the checksum log remains.

This is the exact procedure to run against production once the account owner has access. Store the
passphrase separately from the encrypted file, record the active `MFA_ENC_KEY` alongside it, and keep
the file off-account.

### Who must act

The account owner (or Freebuff support) must either grant this account access to the production D1
database or run the export themselves with the commands above. No ownership bypass was attempted.

---

## 6. Authentication acceptance (Execution D)

| Check | Result |
| --- | --- |
| Owner sign-in screen renders at 390 px | pass — labelled password field, disabled submit until input |
| Wrong password | pass — "That password doesn't match.", **no cookie set** |
| Enter key submits the form | pass |
| TOTP gate, challenge single use, replay counter | covered by suite (`mfa.flows`, `totp.vectors`, `owner.signin`) |
| Recovery codes: 10, hashed, single use | covered by suite (`mfa.flows`) |
| Session inventory, per-device revoke, revoke-all | covered by suite (`session.revocation`, `owner.revocation`) |
| Operator credential rotation invalidates sessions | covered by suite (`operator.revocation`) |
| Argon2id parameters | `m=19456, t=2, p=1` — unchanged |
| Full MFA click-through with a real authenticator | **not performed by a human** |

The human checklist below is unchanged and still pending; automation cannot substitute for a phone
with an authenticator app.

---

## 7. Security findings

No new material finding was discovered. Source review re-confirmed the payment and tenant controls,
and one accessibility defect was found and fixed.

| ID | Finding | Status |
| --- | --- | --- |
| F-33 | `ADMIN_SECRET` doubles as the MFA key when `MFA_ENC_KEY` is unset | **Open** — deployment secret, set `MFA_ENC_KEY` |
| F-37 | Argon2id CPU cost | **Unresolved** — prior probe recorded ~65–68 ms of *elapsed* time per login on the real runtime; not a CPU-time measurement, so the Workers Free 10 ms ceiling is neither confirmed nor excluded |
| F-38 | R2 binding missing from `wrangler.jsonc` | **Closed** — binding declared; upload path verified in workerd |
| F-39 | Auth/payment error messages were not announced (WCAG 4.1.3) | **Closed this pass** — `role="alert"` added to 9 error paragraphs in `Admin.jsx`, `Operator.jsx`, `PaymentPanel.jsx`; verified live |

Payment controls re-verified in source today:

- Webhook: raw body, constant-time HMAC-SHA256 against `RAZORPAY_WEBHOOK_SECRET`; unsigned or wrongly
  signed bodies rejected before parsing.
- Settlement: captured status, exact `total_cents`, INR only; mismatches are acknowledged but never
  settle.
- Idempotency: every settlement is guarded by `payment_status != 'confirmed'`; staff downgrades to
  unpaid/submitted/failed carry the same guard, so a paid ticket cannot be un-paid.
- Credentials: only `RAZORPAY_KEY_ID` (public by design) reaches the browser; the secret and webhook
  secret exist only as Worker secrets. The built bundle contains no secret value — the single scan hit
  is a user-facing error message naming `ADMIN_SECRET`/`MFA_ENC_KEY`.

WorkOS remains **dormant and unused by default**: every café defaults to `owner_auth = 'local'`, and
the managed path fails closed without its environment variables. Recommendation unchanged: keep it
dormant; it does not replace the TOTP factor. Razorpay remains **disabled** in production
configuration; nothing was enabled.

---

## 8. Customer, owner and operator acceptance (Execution G)

Live browser run against `wrangler dev` with the production asset build and local R2:

| Check | Result |
| --- | --- |
| Menu renders | 27 items, 5 categories, accessible names on every add control |
| Mobile 360 / 390 / 430 / 1280 | scrollWidth 343 / 374 / 414 / 1263 — no horizontal overflow at any width |
| Tap targets under 24 px | 0 at every width (28 controls) |
| Images without `alt` | 0 |
| Unnamed interactive controls | 0 |
| Add to cart (trusted pointer) | pass — cart bar appeared with correct count |
| Cart totals | Espresso ₹180 + Cappuccino ₹220 = **₹400.00** |
| Kitchen note | preserved through checkout |
| Place order | pass — **pickup number 1**, order `#L5P9MV` |
| Tracking link | token only in the URL fragment (`#t=…`), never in the path or query |
| Order status display | "Order received" with the four-step timeline |
| Invalid tracking link | friendly "Order not found" state, no stack trace |
| Counter-service mode | honoured (no table required, pickup numbering) |
| Owner sign-in rejection | pass, no session cookie |
| Owner board status change / sold out / tables | covered by the suite (browser-level owner run recorded in the prior pass; no UI logic changed) |
| Operator login, café creation, tenant isolation | covered by `operator.*` and `cafe-scope` suites, all passing |

One automation note for honesty: trusted-pointer clicks on the add buttons failed while the cart
sheet backdrop was open, then worked normally with the sheet closed. This was the modal overlay doing
its job, not a defect; the sheet traps focus correctly (close button focused on open) and `Escape`
closes it.

---

## 9. Test, build and audit results (Execution H)

| Check | Command | Result |
| --- | --- | --- |
| Suite (before edit) | `npm test` with harnesses 8790/8789 | **492 tests, 492 pass, 0 fail, 0 skipped, 0 cancelled**, exit 0, 103.9 s |
| Suite (after edit) | `npm test` | **492/492 pass**, exit 0 |
| Build | `npm run build` | exit 0 — 105 modules, 293.70 kB JS (94.32 kB gzip), 33.10 kB CSS (7.22 kB gzip) |
| Audit (all) | `npm audit --audit-level=low` | 0 vulnerabilities, exit 0 |
| Audit (prod) | `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities, exit 0 |
| Syntax | `node --check` on every `worker/*.js` | clean, exit 0 |
| Image pipeline | `node image-pipeline/self-test.mjs` | 7/7, exit 0 |
| DB drill | disposable SQLite drill | **13/13 pass** |
| Secret scan | `dist/` for secret names | 0 credential values |

No test was skipped, weakened or added to a skip list. The first harness start in this session hit a
stale `SQLITE_BUSY` lock from an orphaned `workerd`; that process was identified by PID and killed,
after which both harnesses started cleanly and every run passed.

---

## 10. Free-tier compatibility

| Resource | Free allowance | Position |
| --- | --- | --- |
| Site requests | 100,000 / month (12,320 used) | comfortable for one café |
| CPU time | 5,000,000 ms / month (36,171.71 used) | monthly total fine; the per-request 10 ms ceiling is the **unresolved** question (no platform CPU measurement exists yet) |
| D1 storage | 100 MB (266,240 bytes used) | fine; export before it grows |
| D1 rows read / written | 50M / 100k per month | fine for one café |
| R2 storage | 1 GB (0 used) | ~1,000 full-size photos |
| R2 writes / reads | 25,000 / 250,000 per month | ample |

**Free-tier verdict:** the workload fits the monthly quotas. Whether the current Argon2id login fits
the Workers Free **per-request CPU limit is unresolved** — the only figures on record are elapsed
wall-clock timings, not platform CPU time. If a real measurement shows the ceiling is exceeded, the
choice is Workers Paid or an approved redesign, never a weaker hash. This would be a platform-billing
decision, not a code defect.

---

## 11. Exact remaining human actions

Nothing else remains for engineering. The authoritative, consolidated version of this list (with the objective
approval criteria) is `CORNER_CUP_FINAL_LAUNCH_COMPLETION_PLAN.md` §10 and §14. These are the outstanding
actions, in order:

1. **Enable R2** in the Cloudflare Dashboard for account `bca798cecc7dc814299016c208b96ebd`, then run
   `wrangler r2 bucket create corner-cup-images`. (Free.) `10042` means `NotEntitled` — the account has no
   R2 subscription, and only the dashboard can add one: `EXTERNAL_BLOCKER_ESCALATION_PACKET.md` §1.
2. **Measure actual Workers CPU time for the Argon2id login** in the deployed runtime (per-request
   CPU in `wrangler tail` or Workers analytics), then decide Workers Paid vs. an approved design
   change. Wall-clock timings on record do not answer this. Do not lower the hash parameters. Platform CPU
   data captured 2026-11-24 (42–59 ms per cold API request, served normally — so the 10 ms ceiling is not
   being enforced here) and the exact remaining procedure: `ARGON2ID_CPU_COMPATIBILITY.md`.
3. **Set production secrets** when deploying: `ADMIN_SECRET`, an independent `MFA_ENC_KEY`,
   `OPERATOR_PASSWORD`. Never set `OWNER_PASSWORD` in production; create cafés from the operator
   console.
4. **Resolve production D1 ownership and access** (copy-ready support request, with every site/env/binding/
   DB identifier: `EXTERNAL_BLOCKER_ESCALATION_PACKET.md` §2), then obtain a production export from the owning
   Freebuff account or Freebuff support. Stage 16A's `17d9568d-52fd-48c2-8761-b74d97688589` should be
   treated as still existing until an owner confirms otherwise. Then run the export → checksum →
   encrypt procedure in §5 and store the file off-account.
5. **Perform the §12 human acceptance run** (~10–15 min) with a phone authenticator.
6. **Run the first-café pilot** (§13) with one staffed shift.
7. **Approve production launch** (§14) explicitly. GitHub remains paused by instruction; it is not
   required for the pilot.

---

## 12. Human acceptance checklist (10–15 minutes)

Prep: one running Worker (or the pilot deployment), one owner password, one phone with an
authenticator app, one browser.

| # | Step | Pass looks like | Time |
| --- | --- | --- | --- |
| 1 | Open `/c/<slug>/admin`, enter the owner password | Sign-in asks for an authenticator code, or lands on the board if MFA is off | 30 s |
| 2 | Enter the 6-digit code | Board loads; a wrong code is refused with a message | 30 s |
| 3 | Open the **Security** tab | MFA status, recovery-code count, session list, disable form render | 1 min |
| 4 | Note remaining recovery codes | A number (10 after enrollment) and you know where the file is | 30 s |
| 5 | Sign out, sign in again | Password → code → board; no stale session | 1 min |
| 6 | Guest menu in a second window: add two items, place a counter order | Totals correct; pickup number shown | 2 min |
| 7 | Open the tracking link | Same order/status; token only after `#` | 30 s |
| 8 | Move the order to **Preparing** on the board | Board updates; no error | 30 s |
| 9 | Refresh guest tracking | Status updates within one poll (~5–10 s) | 30 s |
| 10 | Mark one item sold out, reload the menu | SOLD OUT shown and not addable | 30 s |
| 11 | (If R2 bound) upload a photo, reload menu, remove it | Photo appears, then the category default returns | 2 min |

Record date, browser and any control that did not respond to a real pointer click. Not yet performed.

---

## 13. First-café pilot procedure

1. Create the bucket and set secrets (step §11.1, §11.3).
2. `npm ci && npm test && npm run build && wrangler deploy` — one non-public deployment first.
3. Open `/operator`, sign in, create the café with its real name, service mode and starting tables.
4. Sign in to the new board with the generated password; change it; enroll TOTP; store recovery codes
   offline.
5. Build the menu; upload photos for the top sellers.
6. Print table QR codes (table mode) or the counter QR (counter mode): `/c/<slug>/menu`.
7. Watch one sign-in with `wrangler tail`; record the CPU figure.
8. Run the §12 checklist on the pilot deployment.
9. One staffed shift with a real till: confirm pickup numbers, status transitions, cash marking, and
   that no order is lost on refresh.
10. Export D1 at end of shift and store it off-account.

Do not enable Razorpay until the pilot shift has run and one small real payment can be reconciled.

---

## 14. Production launch and rollback

### Launch (requires explicit owner approval)

1. **Back up first:** export D1, verify checksum, encrypt, store off-account; record `MFA_ENC_KEY`.
2. **Secrets:** `ADMIN_SECRET` (32+ random bytes), independent `MFA_ENC_KEY`, `OPERATOR_PASSWORD`.
3. **Storage:** confirm `corner-cup-images` exists; the binding is already declared.
4. **Deploy:** `wrangler deploy`; `/api/health` returns `{status:"ok",database:"ok"}`.
5. **Smoke:** menu loads; one order placed and cancelled; owner signs in and enrolls MFA; one photo
   uploaded, served and removed.
6. **Measure:** login CPU from `wrangler tail`; if above the plan's ceiling, move to Workers Paid
   rather than weakening Argon2id.
7. **Operate:** daily export, weekly `integrity_check`, `auth_events` review after any incident.

### Rollback

| Failure | Action | Data consequence |
| --- | --- | --- |
| Bad Worker version | `wrangler rollback` | none; D1 untouched |
| Bad migration | redeploy previous code; migrations are additive | none |
| D1 corruption | stop writes, restore last verified export into a new database, repoint binding, redeploy | loses data since last export |
| MFA key lost | restore the old key, or clear `owner_totp.confirmed_at` + bump `auth_version` | owners re-enroll; sessions end |
| Owner locked out | operator clears `confirmed_at`, bumps `auth_version` | password-only until re-enrollment |
| R2 broken | remove the binding; menu uses category defaults | objects remain in the bucket |
| Razorpay broken | remove its secrets; board reverts to counter payments | staff mark unpaid orders |

---

## 15. Final verdict

**CODE COMPLETE — EXTERNAL SETUP REMAINS**

The codebase is complete and verified: 492/492 tests, clean build, zero vulnerabilities, clean
syntax, working image pipeline, passing database drill, a proven encrypted-backup procedure, and a
browser-verified customer and owner surface. The only remaining items are account-level (R2 enable,
Workers plan), support-level (production D1 export) and human (acceptance run, pilot shift, launch
approval).

No production resource was touched. No money was spent. No GitHub operation was performed.
