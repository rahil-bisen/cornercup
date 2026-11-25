# Corner Cup — Paper Fallback Runbook

**Use this when the ordering system is unavailable and customers are waiting.**

The café must be able to serve without the app. This runbook is written for the local pilot: the "system" is
the pilot Worker on `http://127.0.0.1:8788`, running on one computer. If that computer, its browser or the
Worker stops, the café keeps trading on paper and reconciles afterwards.

---

## 1. When to switch to paper

Switch if **any** of these is true for more than about two minutes:

- The board will not load, or reloading once does not fix it.
- `http://127.0.0.1:8788/api/health` does not say the database is ok.
- New orders are not appearing while customers are placing them.
- The café computer is off, asleep and cannot be woken, or has no power.

Announce the switch to staff in one sentence: **"We're on paper until further notice."**

---

## 2. Paper kit (keep it at the counter)

- A pad of duplicate order slips, pre-numbered or hand-numbered.
- Two pens.
- The printed menu with prices (the same prices the app uses).
- A calculator (do not do totals in your head).
- The cash box and a **separate cash log sheet** (see §8).
- This runbook, the staff quick start, and the incident log from the shift run sheet.

---

## 3. Numbering manual orders without clashing with digital queue numbers

The app's counter queue numbers (#1, #2, #3 …) come from the database and continue from where they stopped
when the system returns. **Never reuse or guess a digital number.**

- Number every paper ticket with a **P** prefix: **P-01, P-02, P-03 …**
- Keep one paper sequence per day. Never restart it mid-shift, and never issue the same P-number twice.
- If a slip is spoiled, cross it out, keep it, and use the next number — do not reissue the number.
- Tell the guest the paper number exactly as written: "Your number is P-04."
- When the system returns, digital numbers resume from the database's own counter. The two sequences cannot
  collide because one is numeric and one is `P-`.

---

## 4. Taking a handwritten order

On the slip write, in this order:

1. **P-number** (top, large).
2. Table number, or "COUNTER".
3. Guest name or a short description (for calling the order).
4. Each item, quantity, and unit price from the printed menu.
5. **Total**, calculated twice.
6. Payment: **UNPAID** until cash/UPI is in hand; then write **PAID** and the amount.
7. Time taken.

Read the order back to the guest before they leave the counter.

---

## 5. Kitchen flow on paper

- Clip slips in the order they were taken.
- Write the status on the slip as it moves:
  **RECEIVED → MAKING → READY → SERVED**
- When an order is called, circle the P-number and write the time.
- Keep served slips in a separate pile — they are the day's record.

---

## 6. Communicating delays to customers

- Give an honest estimate when the order is taken: "About 15 minutes on paper."
- If the estimate changes, tell the guest before they ask.
- When calling orders, call the **P-number**, not a guessed digital number.
- If a guest placed an order in the app just before the outage, check both the board (if it comes back) and
  the paper slips before remaking anything.

---

## 7. When the system comes back

1. Confirm the board loads and `/api/health` is ok.
2. **Do not enter paper orders that are already served or collected.** Entering them would create duplicate
   tickets and double-count the day's revenue.
3. For paper orders **still being prepared**, choose one of these and write the choice on the slip:
   - **Keep on paper** (preferred when the order is nearly ready): finish it on paper, record the cash in the
     paper cash log, and add a line to the shift log.
   - **Enter into the app** only if the kitchen still needs tracking: enter it as a new order, write the new
     digital order id on the paper slip, and tell the guest their new number. Never do both.
4. Mark each slip **ENTERED `<order id>`** or **SERVED ON PAPER** so nobody processes it twice.
5. Test one small order in the app to confirm statuses and payment recording work again.
6. Announce: **"We're back on the system."**

---

## 8. Recording cash separately

Paper money must never be mixed into the app's figures by editing orders.

Use a **paper cash log** with these columns:

| Time | P-number | Amount | Cash / UPI | Received by | Notes |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

- Write every paper payment at the moment it is taken.
- Count the drawer at the end of the shift and compare with the paper log **and** the board's total of
  **Pay at counter** orders. They are two separate totals that are added together for the day.
- Do not press **Cash received** on a digital order to represent paper money. That would make the board
  disagree with reality.

---

## 9. Preventing duplicate fulfilment

- One named person owns reconciliation at the end of the outage.
- Before handing over any order, check **both**: the board (if available) and the paper pile.
- Match on table/guest, items and time — not only on the number.
- Every paper slip must end with exactly one of: **SERVED ON PAPER**, **ENTERED `<order id>`**, or
  **CANCELLED**.
- Every digital order created during or after the outage must have exactly one status path. Never re-enter an
  order "just in case".

---

## 10. Reconcile after service resumes

1. Count the paper slips: issued, served, cancelled, entered.
2. Total the paper cash log.
3. Note the last digital queue number before the outage and the first one after it.
4. Compare the day's takings: board **Pay at counter** total + paper cash log total.
5. Write any difference and its reason in the shift log. Do not alter orders to force a match.
6. Record the outage in the incident log (start, end, orders affected, what was done).

---

## 11. What not to do

- Do not restart or `reset` the pilot to "clear" the outage: `reset` deletes the local database and the day's
  orders.
- Do not delete orders, change statuses, or edit the database to tidy up.
- Do not deploy, publish or enable a payment provider to work around the problem.
- Do not keep the app open and take app orders while telling guests they are on paper — pick one path per
  order.
