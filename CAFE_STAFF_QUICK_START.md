# Corner Cup — Staff Quick Start

**For the café's staff device. Local pilot only — not a public website.**

The board address is:

**http://127.0.0.1:8788/c/corner-cup-local-pilot/owner**

Print this page and keep it under the counter.

---

## 1. Open the owner/staff dashboard

1. On the café device, open the address above.
2. Type the café password, then the 6-digit code from the authenticator app.
3. You land on **Orders**. The tabs are **Orders**, **Menu**, **Tables & QR**, **Café setup**, **Security**.

Do not create accounts and do not change the password. There are no individual staff logins; the device is
the login.

## 2. Find new orders

- New orders appear in the **New** column, usually within 10 seconds.
- The **Paid** / **Unpaid / failed** switch filters the list. In this pilot, orders are unpaid until you
  record the cash.
- Use the search box for an order number, a table, or a pickup number.

## 3. Accept and prepare an order

- Read the items, quantities and the guest's note.
- Press **Preparing** on the order card. The guest's tracking page changes to "preparing".

## 4. Mark an order Ready

- When the food is plated or packed, press **Ready**.
- In counter mode, call the pickup number now.

## 5. Mark an order Served

- Hand the order over **and** confirm payment (see below), then press **Done**.
- Served orders move to **Show completed** at the bottom of the board.
- Never press Done before the guest has the food.

## 6. Handle counter queue numbers

- Every counter order gets a pickup number (#1, #2, …) that resets each day.
- The number on the ticket is the number the guest sees. Call exactly that number.
- At closing, write down the last number used.

## 7. Handle sold-out products

- **Menu** tab → find the item → switch it to **Sold out**.
- The guest menu keeps showing it but will not let anyone order it.
- Switch it back to **Available** when it is genuinely back.
- Do not delete items to hide them. In this pilot, **Masala Chai is meant to stay sold out** as the test item.

## 8. If the internet or the ordering system stops working

1. Stop taking app orders.
2. Switch to paper tickets: use the **`PAPER_FALLBACK_RUNBOOK.md`** sheet and number them **P-01, P-02, …**
   (never reuse a digital number).
3. Tell guests the approximate wait.
4. When the system is back, follow the runbook to enter only un-served paper orders — once each.
5. Write down the time it stopped and what you did.

If only the screen is frozen: reload the page once. If it is still broken, use paper.

---

## Payment reminder

Online payment is **off**. A placed order is **not paid**. Take cash/UPI at the counter, then press
**Cash received** on the order before marking it **Done**. See `PAYMENT_DISABLED_OPERATIONS.md`.

## Never

- Never edit the database, delete orders, or "reset" the pilot to fix a screen.
- Never change the password, disable two-factor, or enable payments during a shift.
- Never tell a guest the app took their payment.
- Never share the password or the recovery codes.
