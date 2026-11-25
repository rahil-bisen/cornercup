# Corner Cup — First Café Shift Run Sheet

**Local pilot only.** Board: `http://127.0.0.1:8788/c/corner-cup-local-pilot/owner` · Café:
`corner-cup-local-pilot` · Date: ____________ · Shift lead: ____________________

Print one sheet per shift and keep it at the counter.

---

## 1. Opening checks (before the doors open)

| Check | Done | Notes |
| --- | --- | --- |
| Pilot computer is on, awake, and not set to sleep | ☐ | |
| `node scripts/local-pilot.mjs status` shows health **ok** | ☐ | |
| Board loads and sign-in works (password → authenticator code) | ☐ | |
| The board shows today with no stale orders in New/Preparing | ☐ | |
| Menu and prices match the printed menu | ☐ | |
| Sold-out items are marked (Masala Chai stays sold out as the fixture) | ☐ | |
| Service mode is the one for today (currently **counter**) | ☐ | |
| QR codes on hand and marked **LOCAL TEST ONLY** | ☐ | |
| Café device charged and on the café Wi-Fi | ☐ | |
| Browser sound allowed (new-order beep) | ☐ | |
| Paper kit, printed menu and cash log at the counter | ☐ | |
| Escalation contacts visible (onboarding §13) | ☐ | |

---

## 2. Test order (before the first customer)

Place one small test order and walk it through every step.

- [ ] Order placed; it appears in **New** within ~10 seconds.
- [ ] **Preparing** pressed; guest tracking page says preparing.
- [ ] **Ready** pressed; guest tracking page says ready.
- [ ] **Cash received** pressed (test amount); chip changes to **Pay at counter**.
- [ ] **Done** pressed; order moves to **Show completed**.
- [ ] Test order id recorded: ____________ (do not delete it; note it in the log).

If any step fails, stop and use the paper fallback until it is fixed.

---

## 3. Staff briefing (2 minutes)

- [ ] Every staff member knows the board address and where the device lives.
- [ ] Everyone knows the status rule: **New → Preparing → Ready → Served**, one step at a time.
- [ ] Everyone knows the payment rule: **order placed ≠ paid**; collect, press **Cash received**, then **Done**.
- [ ] Everyone knows how to mark an item sold out (Menu tab) and that Masala Chai stays sold out.
- [ ] Everyone knows the paper fallback trigger and the `P-` numbering rule.
- [ ] One person is named for reconciliation at closing.

---

## 4. Customer QR test

**On the pilot, a real phone cannot open these codes**: they contain `127.0.0.1`, which only exists on the
pilot computer. Verify on the pilot computer instead.

- [ ] Open `http://127.0.0.1:8788/c/corner-cup-local-pilot/menu` in a second browser window: the menu loads.
- [ ] Open `http://127.0.0.1:8788/c/corner-cup-local-pilot/t/1` (repeat for tables 2–8): each table link loads.
- [ ] Add an item to the cart; the total matches the menu price.
- [ ] Check an item marked sold out cannot be added.
- [ ] Place one guest order and confirm it reaches the board.
- [ ] Note for the owner: real customer-facing QR codes need the public HTTPS domain and must be regenerated
      against it before they are printed for guests.

---

## 5. Kitchen workflow test

- [ ] A real order is visible complete: items, quantities, note, total, payment chip.
- [ ] The order card's next-action button matches its column.
- [ ] The guest tracking page follows each status change.
- [ ] Search finds an order by number, table or pickup number.
- [ ] **Paid** and **Unpaid / failed** filters both show the expected orders.

---

## 6. Payment verification (every order, all shift)

- [ ] Cash/UPI counted **before** the order is handed over.
- [ ] **Cash received** pressed for every collected order.
- [ ] **Done** pressed only after payment (unless the owner's written policy says otherwise).
- [ ] No order is treated as paid because it exists.

Payment stays disabled: see `PAYMENT_DISABLED_OPERATIONS.md`.

---

## 7. Mid-shift checks (every 2 hours)

| Time | New/Preparing orders sane | Unpaid orders checked | Queue numbers correct | Device/battery ok | Notes |
| --- | --- | --- | --- | --- | --- |
| | ☐ | ☐ | ☐ | ☐ | |
| | ☐ | ☐ | ☐ | ☐ | |
| | ☐ | ☐ | ☐ | ☐ | |
| | ☐ | ☐ | ☐ | ☐ | |

Also check:

- [ ] The board tab has stayed visible (polling pauses when hidden).
- [ ] The beep still works.
- [ ] No order has been left in New for more than a few minutes.

---

## 8. Closing reconciliation

- [ ] Every open order is **Served** or **Cancelled**; nothing left in New/Preparing.
- [ ] **Unpaid / failed** checked: each remaining order is genuinely unpaid and noted.
- [ ] Board **Pay at counter** total: ₹ ____________
- [ ] Cash counted: ₹ ____________   UPI counted: ₹ ____________
- [ ] Difference (board − counted): ₹ ____________   Reason: ______________________________
- [ ] Last counter queue number used: ______
- [ ] Paper orders, if any: slips issued ______ / served ______ / cancelled ______ / entered ______
- [ ] Paper cash log total: ₹ ____________ (added separately to the board total)
- [ ] One line written in the shift log.
- [ ] Device left locked and signed in (or signed out if it leaves the premises).
- [ ] Nothing deleted or exported.

Shift log line: ______________________________________________________________

---

## 9. Incident log

| Time | What happened | Orders affected | Action taken | Resolved by |
| --- | --- | --- | --- | --- |
| | | | | |
| | | | | |
| | | | | |
| | | | | |

Rules: record the exact on-screen message, never fix a problem by editing data, never `reset` the pilot, and
escalate to the owner/support contact.

---

## 10. Sign-off

| Role | Name | Signature | Time |
| --- | --- | --- | --- |
| Shift lead | | | |
| Owner review | | | |

**This sheet is local-pilot evidence, not production acceptance.** No deployment, publishing, payment provider
or production database is involved.
