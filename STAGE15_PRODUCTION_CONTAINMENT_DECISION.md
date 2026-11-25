# STAGE 15 — PRODUCTION CONTAINMENT DECISION

**Date:** 2026-11-20
**Mode:** strictly read-only. No unpublish, publish, deploy, DNS change, binding change, secret access or customer
contact was performed. The only network activity was unauthenticated `GET` of public static URLs plus platform
metadata reads.
**Question:** should the stale public production deployment be contained, and how?

## 0. Recommendation (stated first)

**UNPUBLISH** — take **both** environments of site `6f1c2a48-…` offline, keep the site, its database, its secrets
and its URL intact, and republish only after the source is reproducible and the build is current.

This is reversible in one call, deletes nothing, and removes the live F-19/F-10-pre-fix build (including a
payment-enabled one) from the public internet. The second Sites project (`4a2196dc-…`) is **already offline**
and needs no action.

---

## 1. Confirmed facts

### 1.1 There are two Sites projects — only one is live

| Project | Name | Production | Preview |
|---|---|---|---|
| **A** `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63` | Corner Cup Café — Razorpay | **published** | **published** |
| **B** `4a2196dc-7182-45ab-bd5e-0582d20e4cb0` | Corner Cup Café | unpublished 2026-11-09T16:30:44Z | unpublished 2026-11-09T16:30:46Z |

Both projects are owned by the same account, are not scheduled for deletion (`deleting_at: null`), and are
independent of each other. `site.json` records that B is “stuck behind an unresolved deploy operation”; B's
environments were nonetheless unpublished, and its URLs answer `404 Not found` today (verified).

### 1.2 Project A — exact identities and timestamps

| Field | Production | Preview |
|---|---|---|
| Environment id | `fa58771d-25fb-4936-bbad-5cffd6ff3973` | `f4adb117-90b4-49ea-9193-aefa06b95d50` |
| Worker name | `site-fa58771d25fb4936bbad5cffd6ff3973` | `site-f4adb11790b449ea9193aefa06b95d50` |
| URL | `https://site-fa58771d25fb4936bbad5cffd6ff3973.freebuff.page` | `https://site-f4adb11790b449ea9193aefa06b95d50.freebuff.page` |
| `published` | **true** | **true** |
| `deployed_at` | **2026-11-10T07:48:37.788Z** | **2026-11-12T10:35:15.155Z** |
| `unpublished_at` | `null` | `null` |
| Custom domain | none (`domain: freebuff.page`, `subdomain: null`) | none |

Project created 2026-11-09T16:14:15Z. Production was first published 2026-11-09T16:14:57Z.

**Every operation on production, newest first** (all `succeeded`): secret `OPERATOR_PASSWORD`
2026-11-11T13:24:16Z (twice, 13:23 and 13:24) · deploy 2026-11-10T07:48:34Z · deploy 07:42:40Z · secret
`OPERATOR_PASSWORD` 2026-11-09T20:57:37Z · deploy 20:57:19Z · secret `ADMIN_PIN` 19:00:35Z · secret `ADMIN_PIN`
18:59:16Z · secret `SERVICE_MODE` 17:59:49Z · deploy 17:59:13Z · deploy 17:58:24Z · deploy 17:40:06Z · deploy
16:28:01Z · secret `OWNER_PASSWORD` 16:24:32Z · secret `RAZORPAY_KEY_ID` 16:18:06Z · secret
`RAZORPAY_KEY_SECRET` 16:17:55Z · secret `RAZORPAY_KEY_ID` 16:15:33Z · **publish** 16:14:57Z · secret
`ADMIN_SECRET` 16:14:54Z · deploy 16:14:34Z · D1 created 16:14:25Z.

**No deploy and no publish operation exists after 2026-11-10T07:48:37Z.** The only later writes are secret
values, which change configuration, not code.

### 1.3 What is being served right now (verified today)

| Check | Result |
|---|---|
| `GET /` on production | **200**, 1,145 bytes, `text/html`, `cache-control: public, max-age=0` |
| `GET /assets/index-x3BrWCng.js` | **200**, **247,604 bytes** — identical size to the Stage 13.1 capture (SHA-256 `d51fc7f2…61e6`) |
| HTML references | `assets/index-x3BrWCng.js`, `assets/index-CkJMrsdi.css` — unchanged |
| `GET /` on preview | **200**, 1,145 bytes |
| `GET /assets/index-Cx9ssJ0q.js` on preview | **200**, **252,164 bytes** (SHA-256 `e2bb2bcb…6b97`) |

Both environments are therefore **live and serving the stale builds**, not merely “published” in metadata.

### 1.4 Configuration bound to production (names and kinds only — no value was read)

| Binding | Kind | Resource |
|---|---|---|
| `DB` | D1 | `17d9568d-52fd-48c2-8761-b74d97688589` / `site-6e1c6f7a9a9f4e098f778f9754221b0a` |
| `ADMIN_SECRET` | secret | — |
| `ADMIN_PIN` | secret | — (unused by current code) |
| `OWNER_PASSWORD` | secret | — |
| `OPERATOR_PASSWORD` | secret | — |
| `RAZORPAY_KEY_ID` | secret | — |
| `RAZORPAY_KEY_SECRET` | secret | — |
| `SERVICE_MODE` | secret | — |

Preview binds a **different** database (`72841897-c150-413d-82d6-9fd36d55d7d5` /
`site-5f96a1b6cb84459a9eb3d2cb56fbb241`), plus `ADMIN_SECRET`, `EXPORT_TOKEN`, `OPERATOR_PASSWORD` and
`RAZORPAY_KEY_ID` (key id only, no secret).

### 1.5 Usage evidence (platform counters, checked 2026-11-20T10:16:55Z)

| Counter | Used | Limit | Interpretation |
|---|---:|---:|---|
| Requests, month to date | 12,320 | 100,000 | some traffic this month |
| **Requests, today** | **1** | 10,000 | essentially nothing today |
| CPU ms, today | 0.428 | 500,000 | one request's worth |
| D1 rows written, today | 0 | 10,000 | no orders/status changes today |
| D1 rows read, month | 207,464 | 50,000,000 | consistent with browsing earlier in the month |
| D1 rows written, month | 1,580 | 100,000 | small; consistent with testing, not a busy café |
| D1 storage | 266,240 B | 100 MB | a real schema with some rows |

### 1.6 What “unpublished” looks like (measured on project B, not assumed)

```
GET https://site-8cde8b8d75c74317a77658adb95874fa.freebuff.page/
HTTP/1.1 404 Not Found
Content-Type: text/plain;charset=UTF-8
Not found
```

9 bytes, plain text, instant, no error page and no stack trace. Project B still lists its `deployed_at`,
its bindings and its URLs — being unpublished is not being deleted.

---

## 2. Unverified assumptions

1. **Whether any diner or café currently depends on the production URL.** No analytics exist beyond the counters
   in §1.5; the daily figure of 1 suggests not, but this is inference.
2. **What is inside the production database.** No query was run. 266 KB and 1,580 writes are consistent with a
   test café and a handful of test orders — not proof.
3. **Whether `RAZORPAY_KEY_ID`/`_SECRET` are test-mode or live-mode keys.** Values were never read. If they are
   live keys, the exposure in §3 is materially worse.
4. **Whether any QR code pointing at the production URL has been printed or shared.** The repository cannot
   answer this; `site.json` and the deployment records cannot either.
5. **Whether the preview environment's response headers match production's.** Today's capture recorded
   Content-Type/Cache-Control/Server only; the full header audit (F-04 absent) was performed against production
   in Stage 13.1.
6. **Whether project B's “unresolved deploy operation” has any side effect beyond its own environments.** Its
   environments are unpublished and its URLs 404, so it presents no public surface.

None of these change the recommendation: every one of them argues for taking the stale build offline, not for
leaving it up.

---

## 3. Security exposure (unchanged from Stage 13.1, still live)

| Exposure | Evidence | Severity |
|---|---|---|
| Public site runs a **2026-11-10** build; every fix landed 2026-11-15/16 | deploy receipt, no later deploy | Critical (drift) |
| **No security headers at all** — no CSP, HSTS, `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` | Stage 13.1 header capture; today's response still 1,145 B / same bundle | High |
| **F-19**: owner password change without the current password | build predates the fix; client has no `currentPassword`/`reauth_required` markers | High |
| **F-10**: no server-side session revocation | build predates `owner_sessions`; no managed-auth markers | Medium-High |
| **Payments configured on a public pre-fix build** | `RAZORPAY_KEY_ID` + `RAZORPAY_KEY_SECRET` both bound | High |
| **Second public surface**: preview, 2026-11-12 build, also pre-fix, with a D1 and an `EXPORT_TOKEN` | preview is published and serving (200, 252,164 B) | Medium-High |
| `ADMIN_PIN` still configured (unused by current code) | binding list | Low |

Aggravating factor: an attacker needs no new capability — a copied staff cookie, a shared tablet, or a curious
visitor who finds the URL is enough to exercise F-19's missing check.

---

## 4. Customer impact

| Scenario | Impact of unpublishing |
|---|---|
| No café live (most likely — the project has never onboarded one) | **None.** The URL stops serving; nobody is ordering. |
| A test QR in circulation | A tester sees `404 Not found` instead of the menu. Annoying, harmless. |
| A real café trading on this URL | Ordering, tracking and the staff board all stop within ~30 s. **This is the only scenario that needs care**, and it is also the scenario in which the current build is least acceptable (payments enabled, F-19/F-10 missing). |

The counters support the first row: 1 request today, 0 D1 writes today, and 12,320 requests spread across the
month — nothing resembling a trading café. But because a printed QR code cannot be recalled by this stage, the
containment decision must be made with the owner's knowledge of whether any table cards exist.

**Nothing here contacts customers**, and nothing should until the owner confirms there are none.

---

## 5. Does unpublishing production affect preview? **No.**

They are independent environments: separate ids, separate workers, separate URLs, separate deployments
(2026-11-10 vs 2026-11-12), **separate D1 databases**, separate secret sets, and separate `published` flags.

Direct evidence from project B: its two environments were unpublished as two distinct operations two seconds
apart (16:30:44Z and 16:30:46Z), and each carries its own `unpublished_at`. There is no shared state between
them except the project record itself.

Consequence worth knowing: because **both** environments of project A are published, unpublishing only
production leaves the site holding one of the six publication slots. Unpublishing both frees the slot and removes
the second stale surface.

---

## 6. Is unpublishing reversible? Yes — with the exact procedure

`published=false` stops serving but retains **code, data, secrets, bindings and URL**. `sites_inspect` shows
`published: false` with `unpublished_at` set, while `deployed_at`, `bindings` and `db` remain listed (project B is
the worked example). Unpublishing is explicitly **not deletion**: data is not removed, and the exact deployment
that was serving becomes servable again.

**Restore (production):**

1. `sites_set_published { siteId: "6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63", environment: "production",
   requestId: "<new uuid>", published: true }`.
2. Confirm the receipt is `succeeded`; `sites_inspect` shows `published: true` and `unpublished_at: null`.
3. `GET /` returns **200** with 1,145 bytes and `assets/index-x3BrWCng.js` (247,604 B) — i.e. the *same* build,
   which is the point of a rollback.
4. Serving resumes within ~30 seconds of the receipt.

**Restore (preview):** identical, with `environment: "preview"` and its own `requestId`.

**What to do differently on restore:** restoring is only appropriate as an emergency rollback. The intended path
after containment is a *new* deployment of a current, reproducible build (§7), not a republish of the stale one.

---

## 7. Can the deployment be replaced safely once the source is reproducible? Yes

Requirements, all of which are already tracked as blockers in `PRODUCTION_DEPLOYMENT_CHECKLIST.md`:

| Prerequisite | Why it matters here | State |
|---|---|---|
| Source reproducible (12 modules tracked) | the Sites build is produced from the tree; today a fresh clone cannot build | ☐ |
| `DB` binding retained **by name** | the existing 266 KB database must survive the replacement | ✅ binding already named `DB` |
| Sign-in CPU measured (Argon2id ≈47 ms) | a replacement that cannot sign the owner in is not a fix | ☐ |
| TOTP before a real café | policy | ☐ |
| Razorpay consciously disabled or approved | the replacement should not silently turn payments on | ☐ |

Replacement procedure, once those hold: build the release, `sites_deploy` the manifest for the environment
(existing bindings and secrets survive; the D1 named `DB` stays attached), verify headers and the F-19/F-10
behaviour, then `sites_set_published(published: true)`. Note that a deploy does **not** republish an unpublished
environment — publishing is a separate, explicit step. And if the replacement must not keep the old data, export
first; the 266 KB database has no export and no point-in-time recovery.

---

## 8. Dependencies on existing production traffic

- **No application component depends on the deployment being reachable.** The repository references the URLs only
  in `site.json` / `sites.manifest.json` (documentation) and in historical reports.
- **No custom domain, DNS record or subdomain** is configured, so unpublishing touches no DNS.
- **No scheduled job, webhook or integration** points at the production URL — Razorpay webhooks are configured in
  the Razorpay dashboard, not in this repository, and payments are not in use; if any webhook target does point
  here, deliveries will 404 while unpublished, which is the desired outcome for an unapproved build.
- The only real dependency is **human**: whether a QR code exists in the physical world.

---

## 9. Exact external action required

Both calls are the same operation, one per environment, each with its **own new** `requestId`.

```
sites_set_published { siteId: "6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63",
                      environment: "production",
                      requestId: "<uuid v4>",
                      published: false }          # → receipt must read succeeded

sites_set_published { siteId: "6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63",
                      environment: "preview",
                      requestId: "<a different uuid v4>",
                      published: false }          # → receipt must read succeeded
```

Verification, in order:

1. `sites_inspect` (production, then preview) → `published: false`, `unpublished_at` set, `bindings` and the D1
   still listed.
2. `GET /` on both URLs → `404` with the 9-byte `Not found` body (the shape measured in §1.6).
3. `GET /assets/index-x3BrWCng.js` on production → `404` (the bundle is no longer public).
4. `sites_list` → project A shows both environments unpublished; the site no longer occupies a publication slot.

**Do not delete the site.** Deletion would destroy the D1 database, the secrets and the URL; unpublish is the
reversible step and is all that is needed.

---

## 10. Rollback procedure

| Trigger | Action |
|---|---|
| A real café turns out to be trading on the URL | `sites_set_published(published: true)` for production with a new `requestId`; serving resumes in ~30 s with the same build (§6) |
| The replacement deployment misbehaves | Deploy the previous artifact again, or republish the saved (unpublished) deployment |
| The database must be preserved before any change | Export first — nothing in this stage's recommendation touches data, but the export is still missing |

Rollback requires no DNS, no secret rotation and no data restore, because unpublishing changed none of them.

---

## 11. Options considered

| Option | Effect | Verdict |
|---|---|---|
| **UNPUBLISH** (production + preview) | stale build off the internet in ~30 s; data/secrets/URL retained; one call to reverse; frees the publication slot | **Recommended** |
| KEEP TEMPORARILY WITH WARNINGS | requires deploying to show a warning (a deploy we cannot yet do safely), or compensating controls that are themselves risky: rotating `ADMIN_SECRET` ends every session **and invalidates guest tracking links**; a WAF/Access rule is an external change that leaves the vulnerable app reachable to anyone who passes it | Rejected: it leaves the F-19/F-10 build public and the “warning” cannot reach a diner |
| Alternative containment: keep serving, block only the owner routes | requires a deploy; and the missing F-04 headers/CSP still expose every visitor | Rejected |
| Delete the site | destroys the database, secrets and URL; irreversible | Rejected — never necessary here |

---

## 12. Final recommendation

> ### UNPUBLISH
> Take **both** environments of site `6f1c2a48-9b3d-4e57-8a10-2c5d7b9e4f63` offline now
> (`published=false`, one new `requestId` per environment). Leave site `4a2196dc-…` alone — it is already offline.
> Keep every database, secret and URL. Republish only when a current, reproducible build has passed the
> deployment checklist, or as an emergency rollback if a real café is found to be trading on the URL.

**Why this and not “warnings”:** the deployed build cannot be patched without a deploy, cannot display a notice
without a deploy, and carries a payment-enabled owner flow whose password-change check is missing. The only
control that is both immediate and reversible is to stop serving it.

**Why it is safe:** nobody appears to be trading on it (1 request today, 0 writes today), unpublishing deletes
nothing, reverses in one call, touches no DNS, and the second project proves the mechanism works without losing
data.

**What it does not fix:** the exposure is *contained*, not remediated. Production still runs stale code, the
database still has no export, and the source still cannot be cloned and built. Those remain the blockers in
`PRODUCTION_DEPLOYMENT_CHECKLIST.md` §0.
