# Corner Cup — Local Pilot Guide

Status: **LOCAL PILOT READY** — prepared and verified locally. It is **not** HUMAN ACCEPTANCE PASSED:
a person still has to complete the checklist in `HUMAN_ACCEPTANCE_CHECKLIST.md` (adapted to the
local URLs below) and a staffed pilot shift.

This pilot is completely local and disposable. It uses:

| Thing | Where |
| --- | --- |
| Worker config | `wrangler.pilot.jsonc` (R2 deliberately not declared) |
| D1 database | `.local-pilot/state/v3/d1/miniflare-D1DatabaseObject/*.sqlite` (own binding `DB`) |
| Local-only credentials | `.local-pilot/pilot.env` (generated once; gitignored) |
| Logs / PID | `.local-pilot/logs/`, `.local-pilot/pilot.pid` |
| App source | the current working tree, built into `dist/` |

It never reads or writes the staging or production database, and it uses no Cloudflare account.
`wrangler.jsonc` and its `IMAGES` binding are untouched; only `wrangler.pilot.jsonc` omits R2.

---

## 1. URLs

| Screen | URL |
| --- | --- |
| Menu (table 1, dine-in) | http://127.0.0.1:8788/c/corner-cup-local-pilot/t/1 |
| Menu (no table) | http://127.0.0.1:8788/c/corner-cup-local-pilot/menu |
| Owner sign-in | http://127.0.0.1:8788/c/corner-cup-local-pilot/owner |
| Kitchen board | same owner URL after sign-in (Orders tab) |
| Health | http://127.0.0.1:8788/api/health |

The operator console (create additional cafés) is intentionally closed: no `OPERATOR_PASSWORD` is
configured in the pilot.

---

## 2. Owner credentials

The owner password is the generated `OWNER_PASSWORD` value in `.local-pilot/pilot.env`. It is a
local-only credential; it is not written in this guide or any report. Open that file to read it.

`ADMIN_SECRET`, `MFA_ENC_KEY` and `ORDER_TRACK_SECRET` are separate random values generated for this
pilot only. `MFA_ENC_KEY` is independent of `ADMIN_SECRET`, so TOTP secrets are encrypted under their
own key. Do not edit or remove that value: as of 2026-11-25 there is no `ADMIN_SECRET` fallback, and
the pilot's two-factor sign-in fails closed (503) without it.

To start over with fresh credentials as well as fresh data: stop the pilot, delete
`.local-pilot/pilot.env`, then start it again. (A normal reset keeps the credentials so the owner
password stays stable.)

---

## 3. Turning on the authenticator (TOTP)

1. Open the owner URL and sign in with the owner password.
2. Choose the **Security** tab.
3. Under **Two-factor is off**, type the owner password and press **Set up two-factor**.
4. Add the shown secret to an authenticator app (Google Authenticator, 1Password, Authy, …), or open
   **Open in your authenticator app** on the same phone.
5. Type the 6-digit code into **Code from the app** and press **Turn on two-factor**.
6. Copy the ten **Recovery codes** now — they are shown once, each works once, and they are not
   stored anywhere retrievable.
7. The board signs you out. Sign in again with the password, then the current code.

Sign-in afterwards is password → 6-digit code (or one recovery code). A code cannot be reused.

---

## 4. Suggested acceptance sequence (disposable data only)

1. **Guest menu** — open table 1. All 27 items appear across five categories with bundled
   photographs and emoji fallbacks. No broken images.
2. **Cart and checkout** — add two items, leave a note, choose pay-at-counter, place the order.
   Note the pickup number and open the tracking page from the confirmation.
3. **Counter queue** — in the board's **Orders** tab the order appears as *new*; advance it
   *preparing → ready → served* and watch the guest tracking page.
4. **Dine-in** — place a second order from table 1; it carries “Table 1” instead of a pickup number.
   Advancing a status out of order must be refused.
5. **Sold out** — **Menu** tab: turn an item off. The guest menu shows it unavailable and checkout
   refuses it. Turn it back on. Add and delete a test item.
6. **Photo upload (expected unavailable)** — try **Upload photo**. The pilot has no R2 bucket, so it
   answers “Image storage is not configured.” nothing crashes, and the menu keeps its defaults.
7. **Service modes** — **Café setup** tab: switch to counter and back to tables. Counter orders get
   queue numbers; table orders get table labels.
8. **Security** — enable TOTP as in §3; confirm every other device is signed out, a password alone
   only earns a code prompt, a spent code is refused, and a recovery code works once.
9. **Keyboard and errors** — tab through the menu and board; focus is visible, the cart quantity and
   menu-photo actions use live regions, and errors are `role="alert"`. Try an invalid table link to
   see the error announcement.
10. **Invalid tracking token** — edit the tracking URL's `#t=` value; the order must not load.

The automated equivalent of steps 1–8 is `node scripts/pilot-verify.mjs` (62 checks; run it against a
freshly reset pilot, because it enrolls TOTP and places orders).

---

## 5. Resetting disposable data

```bash
node scripts/local-pilot.mjs reset
```

This stops the Worker, deletes **only** `.local-pilot/state` (the disposable D1 database, orders,
menu edits and TOTP enrollment), and starts it again. Generated credentials in
`.local-pilot/pilot.env` are kept, so the owner password is unchanged. The menu returns to the 27
seeded items, eight tables and no orders. TOTP must be enrolled again.

---

## 6. Stopping everything

```bash
node scripts/local-pilot.mjs stop
node scripts/local-pilot.mjs status   # confirm: not running, health down
```

`stop` kills the recorded PID and its `workerd` child only. If you also started the test harnesses,
stop those terminal jobs as well; they listen on 8789 and 8790, not 8788.

---

## 7. What this pilot does not prove

- R2 upload/read/delete against a real bucket (R2 is unavailable on the account and intentionally
  off here).
- Production Workers CPU cost of Argon2id.
- Real payments (none configured; checkout offers counter payment only).
- Human usability and a staffed service shift.
