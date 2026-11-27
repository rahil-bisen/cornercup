# Corner Cup — QR table ordering for cafés

**Guests scan, order and track from their own phone. Your staff see every order on one live board.**
No app to install for anyone: a phone browser for guests, any browser for staff.

## For your guests
- **Scan and order.** Each table has its own QR code; the menu opens already knowing the table.
- **A clear, live menu.** Categories, photos, prices in ₹, and items you've run out of marked
  **Sold out** so they can't be ordered.
- **Notes for the kitchen.** "Less sugar", "no onions" — typed once, printed on the ticket.
- **Live order tracking.** Received → Being made → Ready → Served, updating on its own, plus
  **Paid at the counter** once your staff take payment.
- **Pay as they do today.** At the counter, by card, cash or UPI.

## For your staff
- **One live order board.** New orders appear within about 10 seconds, highlighted, with an
  optional chime and the count in the browser tab.
- **One tap per step.** Preparing → Ready → Served, and **Payment received** when the guest pays.
- **Today's numbers.** Collected, paid at the counter, still unpaid, and the average bill, in your
  café's time zone.

## For you, the owner
- **Edit your own menu.** Add, edit or remove items, change prices, upload photos, and flip items
  to sold out in one tap. Price changes apply to new orders only.
- **Print your QR codes.** One code per table, as a print-ready sheet or single images.
- **Table service or counter service.** Orders come from tables, or get a pickup number.
- **Your café, kept separate.** Your own web address, menu, tables, orders and staff password.
- **A protected staff sign-in.** Hashed passwords, rate-limited sign-in, "sign out everywhere", and
  optional two-factor sign-in with an authenticator app.

## What it runs on
Cloudflare Workers, a Cloudflare D1 database, and Cloudflare R2 for menu photos.

---

*Online payment (Razorpay) is supported by the software but is not switched on for this demo and is
not part of what has been tested for it. Everything listed above was exercised on the demo café or is
covered by the project's automated tests.*
