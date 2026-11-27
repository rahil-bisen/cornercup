# Corner Cup — sales demo guide

A five-minute demo of QR table ordering for café owners, using the demo café **Chai Kona Café**.
You need two screens: a **phone** (the guest) and a **laptop or tablet** (the staff board).

| What | Address |
| --- | --- |
| Guest landing page | `https://corner-cup.rahilbisen8.workers.dev/c/chai-kona` |
| Guest menu at table 3 | `https://corner-cup.rahilbisen8.workers.dev/c/chai-kona/t/3` |
| Staff board | `https://corner-cup.rahilbisen8.workers.dev/c/chai-kona/owner` |
| Printable table QR codes | `qr-pack/demo/chai-kona-table-qr-codes.pdf` (tables 1–6) |

The demo café takes payment **at the counter only**. Online payment is switched off on this deployment,
and nothing in the demo shows or promises it.

---

## Before each demo (2 minutes)

1. **Reset the demo café.** This clears last time's orders and puts the menu, prices, sold-out item,
   tables and café details back. It touches no other café.

   ```powershell
   node scripts/demo-cafe.mjs --remote --confirm chai-kona
   ```

   You need `npm ci` done once in the project folder, and to be signed in to Cloudflare
   (`npx wrangler login`). The script refuses a live run without `--confirm chai-kona`.

2. **First time only — set the owner password.** A newly created demo café has no password, so its
   board refuses sign-in. Open `/operator`, sign in, find **Chai Kona Café** and use **Reset
   password**. A reset keeps the password you set, so you only do this once.

3. **Sign in to the staff board** on the laptop and leave it on the **Orders** tab. Turn
   **Sound on** so the new-order chime plays (browsers only allow sound after a click).

4. **Open the guest menu on the phone.** Scan the table 3 code from the printed sheet, or open the
   table 3 address above. Close any old order-tracking tab on the phone: after a reset its order no
   longer exists.

---

## The five-minute walkthrough

**0:00 — The problem (say it, don't show it).** Guests wait to catch someone's eye, orders get
misheard, and a printed menu can't say what has run out.

**0:30 — Scan and browse (phone).**
- Scan the table 3 code. The menu opens already knowing the table — no app, no sign-up.
- Swipe the category bar: Chai & Coffee, Cold Drinks, Snacks, Mains, Desserts. Prices are in ₹.
- Point out **Chicken Biryani — Sold out**. The guest can see it but can't order it.

**1:30 — Build an order (phone).**
- Tap **+** on Masala Chai twice and on Veg Biryani once. The cart bar at the bottom keeps the count
  and total.
- Open the cart and type a note: *"Less sugar in one chai please."*
- The cart says **Pay at the counter when you collect — card, cash or UPI.** Tap **Send order**.

**2:15 — It lands in the kitchen (laptop).**
- Within about 10 seconds the order appears under **New**, with a highlight, a "1 new order"
  badge, the chime (if Sound is on), and the count in the browser tab title.
- The card shows the table, the items, the guest's note and **Unpaid ₹290.00**.

**2:45 — Move it along (both screens).**
- On the laptop press **Preparing**. On the phone the tracking page moves to **Being made** on
  its own.
- Press **Ready**, then **Served**. The phone follows each step.
- Press **Payment received** when the guest pays at the counter. The phone now says **Paid at the
  counter**, and the totals at the top of the board update (**Collected today**, **At the counter**,
  **Average bill**).

**3:45 — Change the menu live (laptop).**
- Open the **Menu** tab. Flip **Paneer Butter Masala** to **Sold out**. Refresh the phone: it shows
  Sold out and can't be added.
- Press **Edit** on Masala Chai and change the price to ₹45. Save. New orders pay ₹45; orders
  already placed keep the price they were taken at.

**4:30 — Tables and QR codes (laptop).**
- Open **Tables & QR**: one code per table, **Print sheet**, or **Download PNG** for a single code.

**5:00 — Close.** Every café gets its own address, menu, tables, password and orders on the same
service. Nothing to install for guests or staff — a browser is enough.

---

## If something goes wrong

| What you see | What to do |
| --- | --- |
| The phone shows "Order not found" | The demo was reset after that order. Go back to the table address and order again. |
| The board refuses sign-in | The password was never set, or was changed. Reset it in `/operator`. |
| No chime | Press **Sound on** once; the browser blocks sound until the page is clicked. |
| The order hasn't appeared after 10 s | Check both screens are online. The board refreshes every 10 seconds and right away when its tab comes back into view. |
| "Café not found" | The address is mistyped. The slug is `chai-kona`. |

---

## Questions café owners ask

Answers cover only what this build does and has been tested to do.

**Do guests need to install an app or create an account?**
No. They scan the table's QR code and the menu opens in the phone's browser.

**How does the kitchen get the order?**
On the staff board, in any browser on a laptop, tablet or phone. New orders appear within about 10
seconds, are highlighted, show in the tab title and can play a chime.

**Can I mark items as sold out?**
Yes, with one tap on the Menu tab. Guests see "Sold out" and can't order it.

**Can I change prices and items myself?**
Yes. Add, edit and delete items, change prices and descriptions, and upload a photo for each item
from the Menu tab. Price changes apply to new orders only.

**How do guests pay?**
In this setup, at the counter by card, cash or UPI, as they do today. Staff press **Payment
received** and the guest's screen shows it as paid.

**Can guests pay online?**
The software supports Razorpay checkout, but it is switched off on this deployment and wasn't
part of this demo's testing. Don't promise it until it has been set up and tested for your café.

**Do I need tables, or can guests order at the counter?**
Either. Each café is set to **table service** (orders come from a table's code) or **counter
service** (orders get a pickup number). The demo uses table service.

**Can I print the QR codes?**
Yes. The Tables & QR tab prints a sheet with one code per table, or downloads each code as an image.

**Do I see my sales?**
The Orders tab shows today's totals: collected, paid at the counter, unpaid, and the average bill,
in your café's time zone (IST for the demo).

**Can another café see my menu or orders?**
No. Each café has its own address, menu, tables, orders and staff password. Tests check that one
café's requests can't read another's.

**How secure is the staff sign-in?**
Owner passwords are stored as Argon2id hashes, sign-in attempts are rate-limited, and sessions can be
signed out on every device at once. These are covered by the automated test suite. The software also
supports two-factor sign-in with an authenticator app, but it is not switched on for this deployment,
so don't offer it yet.

**What does it run on?**
Cloudflare Workers with a Cloudflare D1 database. Menu photos are stored in Cloudflare R2.

**What if the internet drops?**
Ordering needs a connection on both the guest's phone and the staff screen. Keep a paper menu for
outages.
