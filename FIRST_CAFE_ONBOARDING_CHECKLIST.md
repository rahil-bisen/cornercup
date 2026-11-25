# Corner Cup — First Café Onboarding & Operations Checklist

**Status: LOCAL PILOT ONLY.**

Every address in this document is a **local test address** (`http://127.0.0.1:8788`). It works only on the
computer that is running the pilot. It is **not** a public café website, customers cannot scan it over the
internet, and this pilot is **not production-ready**.

This guide is for the café owner and their staff. It assumes no technical knowledge. Where a step needs a
computer, it means the one computer running the local pilot.

---

## 0. What you need before you start

| Item | Why |
| --- | --- |
| The computer running the local pilot | Everything in this pilot lives on it. |
| The pilot's owner password | Stored in `.local-pilot/pilot.env` on that computer. Read it there; never write it in this guide, a chat, or a screenshot. |
| A phone with an authenticator app | The second sign-in step (6-digit code). |
| A printer | The QR pack is a printable PDF. |
| One café device (tablet or phone) | This becomes the staff board. |
| This checklist, printed | Tick as you go. |

Start the pilot if it is not already running:

```bash
node scripts/local-pilot.mjs start   # then open http://127.0.0.1:8788
node scripts/local-pilot.mjs status  # shows the PID and whether /api/health is ok
```

---

## 1. Open the owner board

1. On the café computer, open: **http://127.0.0.1:8788/c/corner-cup-local-pilot/owner**
2. Type the owner password from `.local-pilot/pilot.env`.
3. The pilot's owner account already has an authenticator enrolled, so a second screen asks for a code.
   Enter the current 6-digit code from the authenticator app — or one unused recovery code.
4. The board opens on **Orders**. Across the top you will see five tabs: **Orders**, **Menu**,
   **Tables & QR**, **Café setup**, **Security**.

A password alone never opens the board. If you have lost both the phone and the recovery codes, the pilot
owner cannot sign in; an operator reset is required (see §13).

---

## 2. Owner password rules

- The owner password is the only account for this café. There is no separate "staff account".
- Use at least 12 characters. A change needs the **current** password, and it signs out every other device.
- Store it in a password manager, or on paper kept off the café device.
- Never send it in chat, email or a screenshot, and never write it in this repository.

To change it: **Security** tab → type the current password → save. Every other signed-in device is signed
out immediately; this device stays signed in.

---

## 3. Set up the authenticator (MFA)

The pilot café is already enrolled. This is the procedure to repeat for a new café or after an operator reset.

1. **Security** tab → **Two-factor is off** → type the owner password → **Set up two-factor**.
2. A secret appears (and an "Open in your authenticator app" link). Add it to the phone's authenticator app.
3. Type the 6-digit code the app shows into **Code from the app** → **Turn on two-factor**.
4. The board shows **ten recovery codes once** and signs this device out.
5. Sign in again: password → current 6-digit code.

Notes:

- If the Security tab says two-factor isn't configured, the deployment's `MFA_ENC_KEY` is missing or not 32
  base64url bytes. There is no fallback to `ADMIN_SECRET`; an operator must set the key.
- A code can be used only once. A code from the previous 30 seconds is rejected — wait for the next one.
- Five wrong codes in ten minutes locks the code prompt for a while; the password step is also rate-limited.
- Enrolling, disabling, changing the password and regenerating recovery codes all ask for the current password.

---

## 4. Recovery codes — storage instructions

Recovery codes are the way back in when the phone is lost, broken or wiped.

- There are **10**, each works **once**, and they are **shown only at enrolment** (or when you replace them).
- Write them on paper, or print them, and store them **away from the café device** — for example in the
  owner's safe or a locked drawer. Two copies in two places is sensible.
- Never store them in the same bag as the phone, in a screenshot, in chat, in email, or in this repository.
- Do not photograph them with the same phone that holds the authenticator.
- If the set is lost or used up: **Security** → **Recovery codes** → **Replace recovery codes**. It asks for
  the password and a current authenticator code, and **every old code stops working immediately**.
- Losing both the phone and every recovery code means the operator must reset the owner account.

---

## 5. Verify the café name and the menu

**Café setup** tab:

- Café name, contact phone, email, address, timezone offset and service mode.
- Open the customer menu in another tab and confirm the name at the top matches the real café.

**Menu** tab:

- Items are grouped by category. Each row shows the price, an availability switch, **Edit**, and delete.
- Check every price against the printed menu. Prices are in rupees in the form and are stored in paise.
- Check one sold-out item: the guest menu must show it as unavailable and refuse to add it to the cart.
- The pilot deliberately keeps one sold-out item — **Masala Chai**. Do not delete or re-enable it during
  onboarding; it is the "sold out" test fixture.
- Photo upload is **not available in the pilot** (no image storage is configured). The board will say image
  storage is not configured; items keep their default photo or emoji. That is expected.
- Menu editing is currently **on hold** as a feature: do not use this shift to change menu items beyond what
  the owner has explicitly approved.

---

## 6. Table mode versus counter mode

Only one mode is active at a time. Switch in **Café setup → Service mode**.

| | **Tables** | **Counter** |
| --- | --- | --- |
| Best for | Dine-in cafés where guests sit down | Takeaway / pickup counters |
| QR codes | One per table, placed on the table | One code for the counter/menu link |
| What the guest picks | Their table is part of the link; no table entry needed | No table; they order for pickup |
| How the order appears | Labelled with the table number | Labelled **Counter** with a daily pickup number |
| Queue numbers | Not used | Used, reset each local day (1, 2, 3 …) |

- **The pilot is currently in counter mode.** Table QR codes open the menu, but table-labelled ordering is
  only meaningful in **tables** mode. Switch to tables before placing table QR codes on real tables.
- Switching mode is a server-side change. Orders already placed keep the label they were placed with.
- QR codes printed for one mode should be reprinted after a mode change — the pilot's QR pack is generated
  from the current configuration.

---

## 7. Staff access and permissions

- **There are no per-staff accounts and no staff passwords.** Staff use the café's single owner session on
  the dedicated café device.
- Anyone holding that device is, in effect, the owner: they can change prices, see all orders and change
  security settings. Treat the device as a key to the café.
- Keep the device on a lock screen, signed in only to the café account, and not shared with personal apps.
- Sign out on the device at closing only if the device leaves the premises: **Security → Sign out of this
  device**. **Sign out everywhere** ends every device's session and needs the password again to return.
- The operator password (which creates cafés and resets owner passwords) belongs to the operator only and
  must never be stored on the café device.
- As a rule for the pilot: one named person owns the device, the password and the recovery codes.

---

## 8. Customer ordering instructions

Give guests these instructions (print them next to the QR code if helpful):

> **Ordering at Corner Cup**
> 1. Scan the QR code on your table (or at the counter).
> 2. Choose your items and quantity, then **Add to cart**.
> 3. Check the total, add a note for the kitchen if needed.
> 4. Choose **Pay at counter** and place the order.
> 5. Keep the confirmation page open — it shows your order status and updates itself.
> 6. Pay at the counter when you collect. The order is not paid just because it was placed.

- No account, email or phone number is required.
- A sold-out item is visible but cannot be added to the cart.
- The customer's tracking page shows the status only to someone holding that order's link.
- In counter mode the confirmation shows a pickup number (for example **#4**). In tables mode it shows the
  table.

---

## 9. Kitchen order management

The **Orders** tab is the kitchen board. It refreshes every 10 seconds while the tab is visible and pauses
when the tab is hidden (this also saves cost).

- Two filters at the top: **Paid** and **Unpaid / failed**. In this pilot every order is counter/unpaid until
  staff record the cash.
- Each order card shows the table or pickup number, the items and quantities, the note, the total, a payment
  chip and the next action button.
- Use the search box to find an order by order id, table label or pickup number.
- Newly paid tickets are announced with a short beep (browser sound must be allowed on the device).
- **Show completed** at the bottom lists served and cancelled orders for the day.

---

## 10. Order status workflow

Every order moves one step at a time, in this order:

**New → Preparing → Ready → Served**

| Column | Button | What it tells the guest |
| --- | --- | --- |
| New | **Preparing** | "We have your order and are making it." |
| Preparing | **Ready** | "It is ready — collect it / we are bringing it." |
| Ready | **Done** | "Served. Thank you." |

- Illegal jumps are refused by the server (for example New straight to Served). The button changes with the
  column, so staff cannot normally attempt one.
- **Cancel** is for an order that will not be made. Cancelled orders stay visible under completed.
- The guest's tracking page follows each step on its next refresh (~15 seconds).
- Do not mark an order Served before the food is actually handed over.

---

## 11. Counter queue workflow

In counter mode each order gets a **pickup number** for the local day, starting at 1.

1. The guest places the order and sees the number, for example **#4**.
2. The board shows the same number on the order card.
3. Call the number when the order reaches **Ready**.
4. When the guest pays and collects, record the cash (§12) and mark the order **Served**.
5. The numbering resets the next local day. Note the last number used at closing so the next shift knows.

---

## 12. End-of-day reconciliation (10 minutes)

Do this before closing, on the board, with the cash drawer open.

1. **Orders → Unpaid / failed.** Confirm every counter order that paid cash shows the **Pay at counter** chip
   after you press **Cash received**. Any order still **Unpaid** is either unpaid or forgotten — check it.
2. Count the cash and UPI receipts. Compare with the total of the orders marked **Cash received**.
3. **Orders → Paid** shows today's totals: orders, takings and the unpaid amount.
4. Confirm every open order is either **Served** or **Cancelled**. Nothing should stay in New or Preparing
   overnight.
5. Write down the last pickup number used today.
6. Write one line in the shift log: date, number of orders, cash + UPI taken, any difference and why, and
   anything the board did wrongly.
7. Nothing is deleted or exported. There is no export beyond the board's day view. Never edit the database.

If cash does not match, write the difference down before trying to explain it. Do not change order statuses
to make numbers agree.

---

## 13. Troubleshooting and support

| Symptom | First check | Then |
| --- | --- | --- |
| "Owner sign in" loops back | Password typed correctly? | Use a recovery code, then replace the recovery set. |
| A 6-digit code is rejected | Wrong app account? Phone clock set automatically? | Wait for the next code. Five wrong codes locks the prompt for a few minutes. |
| Board shows no orders | Right café? Tab visible (polling pauses when hidden)? | Reload the page; check `http://127.0.0.1:8788/api/health`. |
| New order missing | Was it placed in the other service mode? | Search by pickup number / table; check the Unpaid filter. |
| QR code will not scan | Printed too small or glare? | Type the URL under the code by hand; reprint from the QR pack at full size. |
| Guest cannot add an item | Item marked sold out? | Check **Menu**; re-enable only if it is genuinely available. |
| Photo upload says storage is not configured | Expected in the pilot (no R2) | Do not retry; the default photo stays. |
| Board is slow or stops updating | Is the pilot still running on the computer? | `node scripts/local-pilot.mjs status`. Restart with `start`, not `reset`. |
| Everything is down | Power / Wi-Fi / computer asleep? | Switch to the paper fallback (`PAPER_FALLBACK_RUNBOOK.md`). |

**Support rules for staff**

- Record the time, the order number and the exact message. Do not try to fix data.
- Never run `reset`, delete the café, or change the database to "clear" a problem: that deletes the day's
  orders along with the problem.
- Never enable online payments, image storage or a deployment to get past a screen.
- Escalate to the named owner/support contact; the owner escalates to the operator for password or MFA
  resets.

**Escalation contacts** (fill in before the first shift)

| Role | Name | Phone | Notes |
| --- | --- | --- | --- |
| Café owner | | | Owns password + recovery codes |
| Shift lead | | | Runs the board |
| Technical support | | | Pilot computer, restart, logs |
| Operator (password/MFA reset) | | | Holds the operator credential |

---

## 14. QR code package and its limits

The printable pack is in **`qr-pack/`**:

- `qr-pack/corner-cup-local-pilot-qr-pack.pdf` — the file to print (A4, three labelled codes per page).
- `qr-pack/counter-menu.png`, `qr-pack/table-01.png` … `table-08.png` — bare QR images.
- `qr-pack/README.md` — regeneration instructions.

**These are LOCAL TEST codes.** They contain `http://127.0.0.1:8788`, which only works on the pilot computer.
A customer's phone on café Wi-Fi cannot use them, and they must never be presented as the café's real
ordering codes. Real QR codes must be generated against the café's eventual publicly deployed HTTPS domain;
that domain does not exist yet.

---

## 15. Onboarding sign-off

- [ ] Owner signed in with password + authenticator code.
- [ ] Recovery codes written down and stored off the device.
- [ ] Café name, timezone and contact details verified.
- [ ] Menu prices checked against the printed menu; Masala Chai still marked sold out.
- [ ] Service mode chosen and explained to staff.
- [ ] Staff device identified, locked, and signed in once.
- [ ] QR pack printed and marked **LOCAL TEST ONLY**; table codes placed only in tables mode.
- [ ] One test order placed, advanced through every status, and served.
- [ ] One counter order's cash recorded with **Cash received**.
- [ ] Paper fallback kit printed and in the drawer.
- [ ] Escalation contacts filled in above.

Owner: ____________________  Date: ____________  Signature: ____________________

---

# Appendix A — Engineering readiness checklist (pre-existing)

> Preserved from the previous version of this file. This part is for engineers and operators, not for café
> staff. It records capability and known limits; it is not a customer-facing guide.

## 1. Operator creates the café

- ✓ Operator console at `/operator`, separate password (`OPERATOR_PASSWORD`), separate cookie, separate CSRF binding.
- ✓ Creating a café requires a name, slug, owner password (12–100 chars), service mode and table count.
- ✓ CSRF: Origin must equal the request origin, plus a token bound to the operator session.
- ✓ Duplicate slugs are rejected; the slug cap (40 chars) keeps cookie names unique.
- ⚠ The operator password is a single deployment-wide value. Rotation is a manual secret change that signs the operator out everywhere.

## 2. Owner is assigned

- ✓ The owner password set at creation is the café's only credential. There is no shared fallback.
- ✓ Operator can reset an owner password later, which bumps `auth_version` and signs out every device.
- ☐ Email invitation / verified identity does not exist (see `AUTHENTICATION_DECISION.md`).

## 3. Owner signs in securely

- ✓ `POST /api/cafes/:slug/admin/login`, Argon2id verify, HttpOnly `SameSite=Strict` cookie, `Secure` on https.
- ✓ Lockout after 8 failures per 10 minutes per café+IP; counter resets on success.
- ⚠ **Argon2id CPU is only partly measured.** 2026-11-24 platform data shows 42–59 ms of CPU per cold API request being served normally (that is `ensureDb`, not the hash). 2026-11-25 local measurements put the derivation itself at p50 31–47 ms / max 63–94 ms of CPU (`ARGON2ID_CPU_COMPATIBILITY.md` §7). The platform `cpuTime` for a real login and the plan's ceiling are still unmeasured. Read that file before choosing a plan.
- ✓ TOTP second factor is implemented: enrollment, ±1-step window, replay guard, 10 single-use recovery codes.

## 4. Café settings

- ✓ Settings page edits name, contact, address, timezone offset, service mode.
- ✓ A password change requires the current password (F-19) and is rate-limited; a failure writes nothing.
- ✓ Changing the password signs out other devices and keeps this one signed in.
- ✓ "Sign out everywhere" requires CSRF and a confirmation.

## 5. Menu

- ✓ Categories and items with name, price, description, emoji, availability.
- ✓ Prices are integers in paise; the client formats, never calculates the payable amount.
- ✓ Unavailable items are visible but not orderable.
- ⚠ No bulk import; items are entered one at a time.

## 6. Ordering mode

- ✓ `tables` and `counter` are mutually exclusive; switching mode is a server-side transition with a guard.
- ✓ Tables mode: `/c/:slug/t/:tableNo`, orders carry a real `table_id` and `queue_no` NULL.
- ✓ Counter mode: `/c/:slug/menu`, orders carry `table_id = 0`, `table_label = "Counter"`, and a **daily sequential** `queue_no`.
- ✓ A QR minted before a mode switch cannot be replayed afterwards.

## 7. QR codes and counter links

- ✓ Table QR codes are generated client-side (`qrcode`) as data URLs against the current origin.
- ⚠ QR images are not stored server-side; reprint from the board if a table is renamed.
- ✓ A printable local pack is generated by `scripts/make-qr-pack.mjs` into `qr-pack/`.

## 8. Guest ordering (no account, ever)

- ✓ No sign-in, no email required; a name is optional.
- ✓ Cart is scoped by café **and** table, so switching cafés never mixes carts.
- ✓ Checkout is idempotent: a double-tap creates one order (`idempotency` claim + abandon path).
- ✓ Body size bounded (16 KB), 40-line cap, server recomputes every price.

## 9. Staff process orders

- ✓ Board lists live orders, statistics, and a beep for newly paid tickets.
- ✓ Transitions are one step at a time: new → preparing → ready → served; invalid jumps refused.
- ✓ A `confirmed` payment cannot be downgraded; staff cannot mark it unpaid.
- ✓ Board polls every 10 s and **stops while the tab is hidden**.

## 10. Customer tracks the order

- ✓ `/c/:slug/t/:tableId/order/:orderId` (dine-in) and `/c/:slug/order/:orderId` (counter).
- ✓ The tracking token travels in the URL **fragment** and an `x-order-token` header, never in the path/query.
- ✓ Without a valid token the page shows "ask our staff", not the order.
- ✓ Polls every 15 s, paused while hidden.

## 11. Daily operations

- ✓ Board shows today's totals, queue numbers, and per-order payment state.
- ✓ Staff can mark cash/counter payments and close tickets.
- ✓ Owner can revoke every session; operator can reset a forgotten owner password.
- ☐ No reporting/export beyond the board's day view.
- ☐ No refunds; Razorpay stays disabled by policy.

## 12. Owner MFA enrollment and recovery-code custody

- [ ] Owner signs in on the café's own device and opens **Security → Enable authenticator**.
- [ ] Enrollment asks for the current password again (a live session is not proof of the credential).
- [ ] Owner scans the QR (or types the base32 secret) into a phone authenticator; issuer reads `Corner Cup`.
- [ ] Owner enters one generated code to confirm; only a **confirmed** enrollment gates sign-in.
- [ ] The 10 recovery codes are written on paper or printed, stored **off the device**, and never in chat, email, a screenshot or this repository.
- [ ] `MFA_ENC_KEY` is set on the deployment: exactly 32 random bytes, unpadded base64url, independent of `ADMIN_SECRET`. There is **no fallback** — without it the Security tab reports two-factor unavailable and sign-in for an enrolled café answers 503.
- [ ] Owner knows: losing the phone **and** the codes means an operator reset, which also resets the password.

## 13. Staff access and permissions

- [ ] The board is reached at `/c/<slug>/owner` (or `/admin`); it is the only staff surface.
- [ ] **There are no per-staff accounts.** Staff share the café's owner session, so the board runs on one dedicated café device, signed in once and left signed in.
- [ ] That device has a lock screen, and the browser is not shared with personal accounts.
- [ ] `OPERATOR_PASSWORD` is known to the operator only and differs from `ADMIN_SECRET`.
- [ ] Staff know how to sign out everywhere (Security tab).
- [ ] A named person owns the operator credential and the recovery codes.

## 14. Money — payments stay disabled unless separately approved

- [ ] Payment provider is `none`: `RAZORPAY_KEY_ID` and `RAZORPAY_KEY_SECRET` are **absent** from the pilot deployment.
- [ ] With the keys absent, `/api/…/config` reports `provider: none` and the guest is offered counter payment.
- [ ] If online payment is ever approved: test-mode keys, a webhook secret, one end-to-end test payment, a webhook signature test, a refund path and a reconciliation owner must exist **before** enabling it. A refund path does not exist in this build.
- [ ] The pilot takes cash/UPI at the counter, recorded in the board as staff mark payment — never edited in the database by hand.

## 15. End-of-shift reconciliation (10 minutes)

- [ ] Board shows today's totals for the café's local day (timezone offset from `CAFE_TZ_OFFSET_MIN`).
- [ ] Count of orders on the board equals the number of tickets served plus the number still open.
- [ ] Sum of counter-paid amounts equals the cash + UPI actually taken; note any difference with a reason.
- [ ] Every open order is either served or explicitly cancelled; nothing is left in `new`/`preparing` overnight.
- [ ] Queue numbers used today are recorded, so tomorrow's start is known.
- [ ] One line is written in the shift log.
- [ ] Nothing is exported or deleted.

---

# Appendix B — Status of each capability (local pilot, today)

**Tested and working in the pilot**

- Owner sign-in with password + TOTP; recovery-code single use; session revocation; MFA enrollment/disable.
- Guest ordering (table and counter), idempotent checkout, server-recalculated totals.
- Kitchen board, one-step status workflow, guest tracking, counter queue numbering.
- Availability/sold-out handling and menu display.
- Automated suite: 532 tests passing locally (including menu editing, MFA key validation/rotation, orders, auth and migrations).

**Unavailable in the pilot**

- Online payments (no provider, no keys; guest pays at the counter).
- Photo upload/display/removal (no R2 binding; upload answers 503).
- Report export beyond the day view; refunds; per-staff accounts; email invitations.
- Public QR codes usable from a customer's phone over the internet.

**Needs production infrastructure before a real café can use this**

- A publicly deployed HTTPS domain (the QR pack must be regenerated against it).
- Cloudflare R2 if photos are wanted; a payment provider only if separately approved.
- A backup/retention policy for the production database, and an operator on call.

**Needs a human café-owner decision**

- Tables or counter mode (and whether to print per-table codes).
- Final menu, prices and which items are sold out on the day.
- Cash/UPI policy, rounding, and who reconciles the drawer.
- Whether staff share one device, and who holds the password and recovery codes.
- Opening hours, cancellation policy, and how to tell guests about delays.
- Support/escalation contacts and who may approve menu changes.

**This pilot is not production-ready.** Nothing in this document is a production deployment, and no production
or staging environment or database was touched by it.
