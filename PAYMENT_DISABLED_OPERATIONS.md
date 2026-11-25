# Corner Cup — Payment-Disabled Operating Procedure

**Applies to: the local pilot, where online payment is switched off.**

This is not a temporary screen the staff should try to "fix". The pilot has no payment provider configured:
`payments.provider` is `none` and there is no gateway key. All money is taken by the café, at the counter.

---

## 1. What "payment disabled" means

- The guest is offered **Pay at counter** only. There is no card, UPI or wallet checkout in the app.
- When the guest places an order, it is recorded as a **counter / unpaid** order. The kitchen ticket exists;
  the money has not been collected by the app.
- The café collects payment directly: cash, or the café's own UPI/QR scanner, according to the owner's policy.
- The board then records the collection with **Cash received**, which changes the order's payment chip to
  **Pay at counter** and counts it in the day's takings.

## 2. What staff must do

1. Read the order total on the board.
2. Collect the money at the counter (cash/UPI, per café policy).
3. Confirm the amount received matches the total **before** handing over the order.
4. Press **Cash received** on that order.
5. Then, and only then, press **Done** to mark it Served.

**An order on the board is not proof of payment.** Anyone can place an order from a table QR code. Only the
cash/UPI in your hand is proof.

## 3. Rules that must not be broken

- **Do not treat an order's existence as proof of payment.** The guest may have closed the tab or walked away.
- **Do not mark Done before payment is confirmed**, unless the café owner has an explicit written policy for
  "serve first, pay later" (for example a regular account). Get that policy in writing before using it.
- **Do not promise automated payment reconciliation.** The app does not talk to a bank, a card network or a
  UPI provider in this pilot. Nothing is settled automatically.
- **Do not enable a payment provider** to make a screen disappear. That is a separate, approved change.
- **Do not edit the database** to fix a payment state. Use the board's **Cash received** control, or record
  the discrepancy in the shift log.

## 4. What the guest is told

Use wording close to this:

> "You'll pay at the counter when you collect. Placing the order doesn't charge you — the total shown is what
> you'll pay."

If a guest asks whether the app took their money: **no**, the app never takes money in this pilot.

## 5. Reading the payment chips

| Chip on the board | Meaning | What staff do |
| --- | --- | --- |
| **Unpaid** | Nothing collected yet | Collect, then press **Cash received** |
| **Pay at counter** | Cash/UPI recorded by staff | Nothing further |
| **Awaiting confirmation** | Only used by an online provider — should not appear in this pilot | Treat as unpaid until confirmed |
| **Paid · Razorpay** | Only used by an online provider — should not appear in this pilot | Do not rely on it here |
| **Payment failed** | Only used by an online provider — should not appear in this pilot | Collect at the counter |

If a chip other than **Unpaid** or **Pay at counter** ever appears in this pilot, stop and tell the owner:
online payment may have been enabled by mistake.

## 6. Day-end

- Total of orders marked **Pay at counter** must equal cash + UPI actually counted.
- Any **Unpaid** order is either unpaid or forgotten: check it before closing.
- Write the takings and any difference in the shift log. Do not adjust statuses to make the numbers match.
- Nothing is exported automatically. The day view on the board is the record; the shift log is the human
  record.

## 7. What would need to change before online payment is allowed

Not part of this pilot, and not a staff action. Before enabling any provider the owner and operator would
need: an approved provider account, test-mode keys, a webhook secret, one end-to-end test payment, a webhook
signature test, a **refund path** (which does not exist in this build), a reconciliation owner, and a written
policy for failed or disputed payments.

Until then: **cash/UPI at the counter, recorded by staff, nothing else.**
