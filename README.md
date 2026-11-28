# Corner Cup — QR table ordering

A café website where guests scan the QR code on their table, browse the menu on their own phone and send the
order straight to the kitchen. Staff get a live order board, menu availability controls and printable table QR
codes.

One deployment serves **several cafés**. Each tenant lives at `/c/<slug>` with its own menu, tables, orders,
staff password and settings; nothing crosses between them. The operator console at `/operator` creates a new
client in one form — no rebuild and no second deployment.

Each café runs in one of two modes: **tables** (default — every order belongs to a table) or **counter** (no
tables at all — each order gets a pickup number the guest is called by).

Built with React + Vite on the front and a Cloudflare Worker API backed by Cloudflare D1. Menu photographs
are stored in Cloudflare R2.

## Design strategy (mobile-first)

Guests arrive by scanning a QR code on a table, so **360–430px phones are the design target** and every
wider breakpoint only adds room. Desktop guest layouts stay responsive but are not the priority; the
owner dashboard is the opposite — it is tuned for tablets and desktops because that is where staff work.

Rules the CSS follows:

- **Base styles are the phone styles.** Wider layouts are added with `min-width` queries, never the reverse.
- **44px minimum touch targets** for every button, link and chip a thumb can press.
- **No horizontal overflow** — `overflow-x: clip` plus wrapping/ellipsis for long café names and item names.
- **Sticky bottom actions** for the cart and checkout, inside the thumb zone, respecting `env(safe-area-inset-bottom)`.
- **Bottom sheets** for product customisation and the cart, closing on backdrop tap and Escape.
- **Readable type** — body copy at 14px or larger, generous line height, and spacing that scales at 430px.
- **Light payloads** — no image sprites to load, menus render from a single JSON call, and QR images are
  generated on demand rather than shipped with the app.

Rollout is page by page, each one built and checked at 360px, 390px, 430px and a tablet/desktop width:

| Step | Page | Status |
| --- | --- | --- |
| 1 | Mobile landing page (`Landing.jsx`) | Done — compact header, thumb-reachable CTA, 62px table targets |
| 2 | Menu browsing (`Menu.jsx`) | Next |
| 3 | Product details and customisation | Planned — bottom sheet |
| 4 | Cart and checkout | Planned — sticky bottom bar |
| 5 | Order tracking (`OrderStatus.jsx`) | Planned |
| 6 | Owner dashboard (`Admin.jsx`) | Planned — tablet/desktop first |

## What's inside

| Area | Route | What it does |
| --- | --- | --- |
| Root | `/` | Sends visitors to the primary café's guest site, exactly like the single-café build did |
| Operator console | `/operator` | Creates cafés, shows each one's item and open-order counts |
| Café landing | `/c/:slug` | Explains the flow and links to each table's menu |
| Guest menu | `/c/:slug/t/:table` | Live menu, cart, order notes, "send to kitchen" |
| Guest menu (counter mode) | `/c/:slug/menu` | Same menu with no table — the order gets a pickup number |
| Order tracking | `/c/:slug/t/:table/order/:orderId` | Razorpay payment, live status timeline and receipt |
| Order tracking (counter mode) | `/c/:slug/order/:orderId` | Same tracking, worded as a pickup order |
| Staff | `/c/:slug/owner` | Order board, payment confirmation, menu availability, table QR codes, café setup |
| Policy pages | `/c/:slug/about`, `/contact`, `/pricing`, `/terms`, `/privacy`, `/refund` | Per-café business details |

Every `/api/...` call in the browser is automatically rewritten to `/api/cafes/:slug/...` from the address bar,
so a page can only ever read the café it belongs to.

Orders are stored in D1. Guests pay through **Razorpay Checkout** — UPI, cards, netbanking and wallets inside
Razorpay's own sheet — and the ticket settles itself via the verified browser callback and a signed webhook.

This repository is the Razorpay version. The direct-UPI (no-gateway) board is a separate build, so no UPI
handle is sent to the browser here and there is no provider switch to flip.

## Adding a café (one deployment, many clients)

Cafés are rows in the `cafes` table, and every other table carries a `cafe_id`. Two client cafés never share a
menu item, a table, an order or a password, even though they share one Worker and one database.

1. Set `OPERATOR_PASSWORD` on the deployment (a secret, not in `wrangler.jsonc`) — without it `/operator` is
   closed.
2. Open `/operator`, sign in, and fill in the new café's name, web address, owner password and service style.
3. Hand the client two addresses: `/c/<slug>` for guests and `/c/<slug>/owner` for staff.

New cafés start with no menu items or tables. The owner adds the café's real menu and, for table service,
its actual tables before inviting guests. Sample data is available only when `SEED_DEMO_DATA=true` is
explicitly enabled for a local or test environment.

Table ids stay globally unique because orders point at them, but the **number a guest sees** restarts at 1 for
each café, so every client's QR codes read `/c/<slug>/t/1`, `/2`, …

What a café can change for itself lives in **Staff → Café setup**:

- **Café name** — shown on every guest page, the staff board and the Razorpay checkout.
- **Service style** — *table service* (guests scan a table QR) or *counter* (pickup numbers, no tables).
  The change applies from the next order; orders already placed keep the table or number they were taken with.
- **Café clock** — the UTC offset that decides when daily takings and pickup numbers roll over.
- **Phone, email, address** — quoted by that café's `/about`, `/contact`, `/terms`, `/privacy` and `/refund`. A
  field left empty keeps its `[Business Name]`-style placeholder visible on purpose, because a payment
  provider's website review expects real details on those pages.
- **Owner password** — hashed with Argon2id before it is stored, so a database dump does not hand over any
  client's staff board. Each café's session lives in its own `staff_<slug>` cookie, so one
  browser can stay signed into two clients at once.

The menu and the tables already live in the database and have their own tabs, so a fresh outlet is: sign in →
set the name and service style → fill in the contact details → adjust the menu → add tables (table service
only). Nothing in that list needs a build or a deploy.

`CAFE_NAME`, `SERVICE_MODE` and `CAFE_TZ_OFFSET_MIN` can optionally bootstrap the first café. They are
intentionally absent from the production Wrangler config: production starts without a café until an operator
creates one using the real business details.

## Run it locally

```bash
npm install
npm run dev        # builds the app, then serves it with wrangler on http://localhost:3000
```

`npm run dev` builds the frontend and starts `wrangler dev`, which serves the static build, the `/api` routes
and a local SQLite database. Copy `.dev.vars.example` to `.dev.vars` to opt into the local demo café, sample
menu and numbered tables; `SEED_DEMO_DATA=true` is test/development-only and must not be deployed.

With the example local variables, the database creates the demo café from `CAFE_NAME` and seeds its sample
menu and tables. Open `http://localhost:3000/` to see the directory and click through to that café. To preview
what a guest sees, open `http://localhost:3000/c/<slug>/t/3` (or pick a table from the café's landing page).
The staff screen is at `/c/<slug>/owner`, and
`http://localhost:3000/operator` is where more cafés are created — set `OPERATOR_PASSWORD` in `.dev.vars`
first.

## Order tracking

A guest tracks an order with a per-order token, issued **once** in the checkout reply and carried in the URL
fragment (`/c/<slug>/order/<id>#t=…`), so it never appears in a request line, an access log or a `Referer`. The
token is 43 URL-safe characters derived with HMAC-SHA256 from a 192-bit per-order nonce and a key built from
`ORDER_TRACK_SECRET` (or `ADMIN_SECRET` when that is unset). D1 stores only the nonce and `sha256(token)`, so a
database dump cannot be replayed, and a checkout retry returns the same token because it is recomputed from the
stored nonce rather than remembered.

`GET /api/cafes/:slug/orders/:id` and `POST /api/cafes/:slug/orders/:id/payment` both require the token in an
`x-order-token` header and answer one generic 404 for a missing, wrong or legacy token — an order id alone is not
a credential. Orders placed before this shipped have no tracking data and stay unreadable to guests; staff see
them on the board as before.

## Staff passwords

The passwords and the token-signing secret are Worker configuration:

- `OPERATOR_PASSWORD` — unlocks `/operator`. No default: unset means the console is closed.
- `OWNER_PASSWORD` — used once, at startup, to seed the **first café's own password hash** only when
  `CAFE_NAME` is explicitly configured. Production's recommended `/operator` setup does not need it because
  the owner password is set during café creation. It must meet the same 12-character minimum as any other owner password;
  a missing or shorter value is never installed. It is never compared at sign-in and never applies to another
  café. `ADMIN_PIN` is not read at all: a café with no stored hash refuses sign-in (503) until the operator sets
  a password.
- `CAFE_NAME` — optional name for an environment-bootstrapped first café. It is intentionally absent from the
  production config; the authenticated operator creates the real production café.
- `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` / `RAZORPAY_WEBHOOK_SECRET` — the gateway keys. Without the key
  secret guests are offered counter payment instead of a pay button. Never put any of these in
  `wrangler.jsonc` or a committed file.
- `ADMIN_SECRET` — signing key for staff sessions. Required on every deployment; locally it comes from `.dev.vars`. Without it, sign-in returns 503. For a real deployment
  set it as a secret: `npx wrangler secret put ADMIN_SECRET`.

Staff sessions last 12 hours and are signed with HMAC-SHA256, so a guest cannot reach an admin API by guessing
URLs. The signed token names its owner (`cafe:12`, or `operator`), so a session issued for one café is refused
by every other one. It travels as an `HttpOnly; SameSite=Strict` cookie (`staff_<slug>`, and `staff_operator`
for the console), so no script on the page can read or copy it, and `POST /api/cafes/:slug/admin/logout`
clears it. `GET /api/cafes/:slug/admin/session` tells the board whether a session is still valid without
exposing the token. The staff board is not linked from the guest pages — staff go straight to
`/c/<slug>/owner`.

## Taking payments

After sending an order the guest lands on a payment card with one **Pay ₹X** button. It opens Razorpay's own
checkout, so UPI, cards, netbanking and wallets all work without the guest installing anything, and the ticket
settles itself — staff never confirm a gateway payment by hand.

A guest who would rather settle later can pick *I'll pay at the counter instead*; the order then shows
**Pay at counter** and staff take the money at the till.

Without `RAZORPAY_KEY_SECRET` the card shows counter payment instead of a pay button that would fail, and the
staff header reads *Razorpay keys missing — counter payments only*. There is deliberately no direct-UPI
fallback in this build.

### How the Razorpay flow fits together

Set three secrets and the payment card becomes a single **Pay ₹X** button (UPI, cards, netbanking, wallets)
that marks the order paid on its own.

1. Create a Razorpay account, then *Settings → API Keys → Generate key*. Start with a test-mode key.
2. Give the Worker the credentials:
   - deployed: `npx wrangler secret put RAZORPAY_KEY_ID`, then the same for `RAZORPAY_KEY_SECRET`
   - local: copy `.dev.vars.example` to `.dev.vars` (gitignored) and fill in the two values
3. In Razorpay go to *Settings → Webhooks → Add webhook*:
   - URL: `https://your-site/api/cafes/<slug>/webhooks/razorpay` (one webhook per café, or point every
     café's payments at the same slug if they share one Razorpay account)
   - Active events: `payment.captured`, `order.paid`, `payment.failed`
   - Set a webhook secret and put it in `RAZORPAY_WEBHOOK_SECRET` the same way
4. Restart the dev server (or deploy). The payment card now shows the **Pay ₹X** button.

How it fits together:

- **`POST /api/orders/:id/payment/razorpay`** creates a Razorpay order for the server-calculated total, stores
  its id in `orders.payment_ref`, and returns the key id and order id to the browser. It never trusts a client
  amount.
- **`POST /api/orders/:id/payment/razorpay/verify`** takes the signed triple Checkout returns to the browser,
  recomputes HMAC-SHA256(`order_id|payment_id`, `RAZORPAY_KEY_SECRET`), then asks Razorpay for that payment and
  confirms only when it is `captured` for at least the ticket total. The ticket settles the moment the guest
  finishes paying, which works before any webhook exists.
- **`POST /api/webhooks/razorpay`** reads the raw body, checks `X-Razorpay-Signature` (HMAC-SHA256 of the exact
  body with `RAZORPAY_WEBHOOK_SECRET`) in constant time, and only then confirms the ticket. A bad signature
  gets `400` and changes nothing.
- Confirmation is idempotent (`order.paid` and `payment.captured` can both arrive), records the Razorpay
  payment id, and ignores amounts below the ticket total rather than trusting a partial payment.
- The guest page polls the ticket and flips to **Paid** by itself; `payment.failed` leaves it unpaid so they can
  retry.
- Without Razorpay keys, online checkout is unavailable and guests can choose counter payment for staff
  confirmation; this build does not provide direct UPI checkout.

## Editing the menu

Everything is editable from **Staff → Menu**: toggle items sold out, delete items, and add new ones. The
seed data lives in `worker/db.js` if you would rather start from your own menu.

## QR codes

**Staff → Tables & QR** renders a QR code per table pointing at `/c/<slug>/t/<number>`. Download the PNGs (or
use *Print sheet*) and put one on each table. Adding a table creates a new code automatically.

## Counter service (no tables)

A café that takes orders at the counter instead of table service is switched in **Staff → Café setup**
(*Service style → counter*), which is per tenant, so other cafés on the deployment keep their tables.

- The guest opens `/c/<slug>/menu` (or scans one generic QR for the whole café) and orders without picking a
  table.
- Each order gets a **pickup number** — `#1`, `#2`, … — that restarts at midnight in the café's timezone
  (`CAFE_TZ_OFFSET_MIN`, default 330 for IST). The number is allocated inside the `INSERT`, so two guests
  ordering at once cannot be given the same token.
- The order page says "Pickup #12" and the timeline ends in **Collected** rather than *Served*.
- The staff board shows `#12` in place of a table label, searches by number, and the rest of the board is
  unchanged.
- Table orders are refused with a 400 in this mode, so an old table QR can never create a ticket nobody can
  deliver.

Orders in both modes share one `orders` table; table orders have a null `queue_no`, pickup orders have a null
(`0`) table id. Switching a café between modes keeps its history.

## Database and media storage

The Worker uses Cloudflare D1 for all application data and Cloudflare R2 (`IMAGES`) for menu photographs.
The D1 schema, incremental compatibility migrations, indexes and trigger are managed by `worker/db.js`.
Production startup does not create a café or seed sample business data. `SEED_DEMO_DATA=true` is reserved for
local/test environments. The production application has no Supabase, PostgreSQL connection or Hyperdrive
database path.

## Deploying

The app is a Worker plus static assets, so it deploys to Cloudflare:

```bash
npm run deploy
```

`npm run deploy` builds and runs `wrangler deploy --env=`, which targets the top-level configuration (the
live `corner-cup` Worker). The `selfhost` environment in `wrangler.jsonc` is only for `wrangler dev`.

`wrangler.jsonc` binds the existing `corner-cup` D1 database (`eefda06c-f8d6-483d-85f2-a6a21b1827d8`)
as `DB` and the existing `corner-cup-images` R2 bucket as `IMAGES`. The initial deployment uses
`workers.dev`; no custom-domain routes are configured.

Before deployment, configure `ADMIN_SECRET` and `OPERATOR_PASSWORD` as Worker secrets. They are the only
secrets `wrangler.jsonc` marks as required for a deploy: Wrangler refuses to deploy while a listed secret is
missing, so optional ones are deliberately not listed and are picked up whenever they are set. Production starts with
an empty café directory; use the authenticated `/operator` flow to create the real café and its owner password,
then enter the actual menu and table data from the owner board. Do not configure `SEED_DEMO_DATA` in production.
Configure `MFA_ENC_KEY` to enable
owner two-factor authentication. If enabling WorkOS-managed owner authentication, configure its
`WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_ISSUER`, and
`WORKOS_STATE_ENCRYPTION_KEY` values as well. `OWNER_PASSWORD` is only needed for a deliberately environment-bootstrapped first café;
`ADMIN_PIN` is not read at all.

### Hosting on Render (`npm start`)

`npm start` runs `wrangler dev --env selfhost`, which does **not** read ordinary process environment variables by default.
It loads only the keys listed under `env.selfhost.secrets.required` in `wrangler.jsonc`, so a new key the
Worker reads must be added there too.
With no `.dev.vars` file it only looks at `.env` files, so variables entered in Render's dashboard are invisible
to the Worker and checkout answers `503 Ordering isn't configured` (no `ORDER_TRACK_SECRET`/`ADMIN_SECRET`).

In the Render service → **Environment**:

1. Add `CLOUDFLARE_INCLUDE_PROCESS_ENV` = `true`. This tells wrangler to pass Render's variables to the Worker.
2. Add the secrets (`ADMIN_SECRET`, `OPERATOR_PASSWORD`, `OWNER_PASSWORD`, `MFA_ENC_KEY`, optionally
   `ORDER_TRACK_SECRET` and the Razorpay keys) as normal environment variables.
3. Do **not** add a Secret File named `.dev.vars` or `.env`: a `.dev.vars` file makes wrangler ignore the
   process environment entirely.
4. Save, then redeploy (or *Manual Deploy → Deploy latest commit*).

Note that `wrangler dev` keeps D1 in a local file under `.wrangler/state`. On Render that file lives on the
instance's temporary disk, so data does not survive a restart or redeploy unless it is moved to persistent
storage (see "Data on Render" below).

### Data on Render

`npm start` passes no `--persist-to`, so the D1 database is a SQLite file under `.wrangler/state/` in the
app folder. Render resets that folder on every deploy and restart (free instances also restart after idling).
The app then recreates its tables and seeds the demo menu, so it *looks* healthy, but cafés created in
`/operator`, owner passwords and MFA enrollments, menu edits, tables and all orders are gone.

Options, best first:

1. **Deploy to Cloudflare Workers with a real D1 database** (`npx wrangler d1 create corner-cup`, put the id in
   `wrangler.jsonc`, `npm run deploy`, secrets via `wrangler secret put`). This is what the app is built for:
   D1 is durable and has point-in-time restore. Render is then not needed.
2. **Stay on Render with a persistent disk** (paid instance): attach a disk, e.g. at `/var/data`, and change the
   Render start command to `npx wrangler dev --ip 0.0.0.0 --port 3000 --persist-to /var/data/wrangler`. Data
   survives restarts, but this is still a development server on one instance, and backups are up to you.
3. **Keep Render free as a demo only**, accepting that data is wiped regularly.

## Notes

- Table numbers are sequential within each café and appear in guest URLs; the internal row id stays the
  join key for orders, so two cafés can both have a "Table 1".
- Every menu, order, table and setting query is filtered by `cafe_id`, and the staff token names its café, so
  one client's session cannot read another's board even with a guessed URL.
- Prices are stored in paise (integer cents) and always recalculated on the server when an order is placed, so
  the price shown in the browser cannot be tampered with.
- The UPI amount in the intent link comes from the server-calculated total, not from the browser's cart.
- Order ids are short random codes (e.g. `4KQ8ZT`), friendly to read aloud at the counter. Counter-mode
  orders also carry a small daily pickup number (`queue_no`) for calling guests.
- Menu items are snapshotted onto the order, so deleting an item later does not rewrite history.
- `POST /api/admin/menu/reseed` replaces a menu with the sample list and is disabled unless
  `SEED_DEMO_DATA=true`; never enable it in production. Existing orders keep their own item snapshots.

## Razorpay checkout, owner board and policy pages

### Routes

Every route below lives under `/api/cafes/:slug/` — the café is the tenant boundary, so an unknown slug is a
404 rather than a fallback. `/api/health` and `/api/operator/*` are the only deployment-wide endpoints;
the café list itself is operator-only.

| Route | What it is |
| --- | --- |
| `POST /api/cafes/:slug/orders` | Creates a pending order. The browser sends only `tableId`, item ids and quantities; every price and the total come from D1. |
| `POST /api/orders/:id/payment/razorpay` | Creates a Razorpay order for the server total and returns the public key id and Razorpay order id. |
| `POST /api/orders/:id/payment/razorpay/verify` | Verifies HMAC-SHA256(`order_id\|payment_id`) with the key secret, fetches the payment, checks currency, order and exact amount, then marks the ticket paid. |
| `POST /api/razorpay/webhook` | Razorpay webhook. `X-Razorpay-Signature` is checked against the **raw** body with `RAZORPAY_WEBHOOK_SECRET`. Same handler as `/api/webhooks/razorpay`. |
| `GET /api/health` | Liveness: Worker + D1 check. No secrets. |
| `GET /api/admin/settings` | Reads the per-café configuration (name, service style, clock, contact details). Staff session required. |
| `PATCH /api/admin/settings` | Saves any subset of those settings after validation. Staff session required. |
| `GET /owner` | Owner board (`/admin` still works). Paid orders by default, an *Unpaid / failed* tab, Preparing/Done buttons, payment id per order. |
| `/about`, `/contact`, `/pricing`, `/terms`, `/privacy`, `/refund` | Policy pages with `[Business Name]`, `[Address]`, `[Phone]`, `[Email]` placeholders. |

### Environment variables

| Name | Purpose |
| --- | --- |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Gateway credentials. Both are required before online payments turn on. |
| `RAZORPAY_WEBHOOK_SECRET` | Verifies `/api/razorpay/webhook`. Without it the endpoint returns 503. |
| `ADMIN_SECRET` | Required signing secret for staff and operator authentication. |
| `OPERATOR_PASSWORD` | Unlocks `/operator`, where cafés are created. No default: unset closes the console. |
| `OWNER_PASSWORD` | Seeds the first café's own password hash only when `CAFE_NAME` is explicitly configured, and only while that café has no hash. It must be 12–100 characters. Production's operator-created café sets its own hashed password and does not need this secret. `ADMIN_PIN` is not read. |
| `MFA_ENC_KEY` | Encrypts owner TOTP secrets at rest; required to enable two-factor enrollment. |
| `WORKOS_CLIENT_ID`, `WORKOS_API_KEY`, `WORKOS_REDIRECT_URI`, `WORKOS_ISSUER`, `WORKOS_STATE_ENCRYPTION_KEY` | Required only when enabling WorkOS-managed owner authentication. Treat the API key and state encryption key as secrets. |
| `SERVICE_MODE` | Optional starting value only when `CAFE_NAME` is set: `tables` or `counter`. |
| `CAFE_NAME` | Optional name to bootstrap the first café; intentionally absent from the production config. |
| `CAFE_TZ_OFFSET_MIN` | Optional starting clock offset only when bootstrapping the first café. |
| `SEED_DEMO_DATA` | Local/test only. Must not be enabled in production; it seeds the sample menu and numbered tables. |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_OWNER_CHAT_ID` | Optional. Paid orders are pushed to Telegram, with three attempts; a failure never affects the payment. |

There is no database connection string to set: the database is the `DB` D1 binding, already attached to each environment.

### webhook / checkout notes

- The webhook handles `payment.captured`, `order.paid` and `payment.failed`. Confirmation is a single
  conditional `UPDATE ... WHERE payment_status != 'confirmed'`, so a repeated event can never mark an
  order twice or send a second alert. If the database call itself fails the handler returns 5xx and
  Razorpay retries.
- An amount that does not match the ticket exactly is acknowledged (`ignored: "amount-mismatch"`) and
  never settles the order, so retries stop without the order being marked paid.
- Checkout is opened with `key`, `order_id`, `amount`, `currency` and a theme colour only. No
  `config.display` overrides, so UPI and every other method Razorpay enables stay visible.
