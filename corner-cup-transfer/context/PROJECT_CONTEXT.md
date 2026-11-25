# PROJECT_CONTEXT.md — Corner Cup Project Overview

## Product Overview

**Corner Cup** is a QR-based, multi-tenant café ordering SaaS. Its purpose is to let cafés create digital menus, accept customer orders through QR codes, and manage orders through an operator/admin interface.

### Core Features

- **QR-based ordering**: Customers scan a QR code to access the café's menu and place orders
- **Multi-tenant**: Each café has isolated data (database rows, settings, passwords)
- **Two ordering modes**: Tables mode and Counter mode
- **Admin/operator interface**: Staff can manage cafés, menus, orders, and settings
- **QR order tracking**: Secure tokens carry order capability, not order IDs alone
- **Razorpay payments**: Integrated but disabled in preview

### Target Deployment

- Cloudflare Workers with D1 (SQLite) database
- Cloudflare R2 for file storage
- Sign in with Freebuff for authentication
- Preview and production environments

## Technology Stack

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite 6 |
| Build | Vite production build |
| API Cloudflare Worker | JavaScript, D1, R2 |
| Database | Cloudflare D1 (SQLite) |
| Storage | Cloudflare R2 |
| Authentication | Sign in with Freebuff (OIDC) |
| Payments | Razorpay (disabled in preview) |
| CLI | Wrangler 4.20.0 |

### Component Communication

1. **Customer → Frontend**: Customer visits `/c/<slug>/menu` or `/c/<slug>/t/<tableNo>`
2. **Frontend → Worker API**: API calls to `/api/cafes/:slug/...` with order tracking tokens
3. **Worker API → D1**: Database operations for cafés, orders, menus, rate limits
4. **Worker API → R2**: File storage for menu items, assets
5. **Worker → Razorpay**: Payment processing (disabled in preview)
6. **Worker → Freebuff OIDC**: Authentication sign-in/sign-out
7. **Worker → Worker**: Internal rate limiting, CSRF validation

## Ordering Architecture

There are two mutually exclusive café modes:

### Tables Mode

- **Customer URL**: `/c/<slug>/t/<tableNo>`
- **Orders have a real `table_id`** (the table number)
- `queue_no` is NULL
- Each table has a label and seats count
- Orders are associated with a specific table

### Counter Mode

- **Customer URL**: `/c/<slug>/menu`
- **Orders use `table_id=0`** (counter, no specific table)
- `table_label=Counter`
- A daily incrementing `queue_no` is assigned per order
- Customers order at the counter; orders are fulfilled in queue order

### Mode Switching

- Initial mode is set at café creation (`service_mode: "tables"` or `"counter"`)
- After saved in **Staff → Café setup**, the database value wins
- The panel overrides the starting value
- Transitions between modes are not permitted after initial save

## Checkout and Tracking

- **Guest checkout**: No forced account creation
- **Dine-in tracking**: `/c/<slug>/t/<tableId>/order/:orderId`
- **Pickup tracking**: `/c/<slug>/order/:orderId`
- **Tracking architecture**: Uses secure tokens, NOT order IDs alone

### Token Storage

- Order tokens are 43 URL-safe characters
- Derived with HMAC-SHA256 from a 192-bit per-order nonce and a key built from `ORDER_TRACK_SECRET` (or `ADMIN_SECRET` when unset)
- The token itself is NEVER stored in plaintext; only `sha256(token)` is persisted in D1
- A checkout retry returns the same token because it is recomputed from the stored nonce

### Fragment and Request Header

- Token is carried in the URL fragment (`#t=...`) so it never appears in request lines, access logs, or `Referer`
- API calls require the token in an `x-order-token` header
- One generic 404 is answered for missing, wrong, or legacy tokens — an order ID alone is not a credential

### Validation Architecture

- `authorisedOrder()` function validates: token exists, matches cafe_id, HMAC verification passes
- If token is missing, wrong, or legacy (no track_hash), handler answers one generic 404
- This confirms NOTHING about whether the order id exists — prevents information leakage
- The same generic 404 path is used for: missing token, wrong token, legacy row with no hash

## Cart Architecture

### Café and Table Isolation

- Each café has completely isolated data in D1
- Table-level and order-level isolation within each café
- Cart state is scoped to the current café context
- Café switching is not permitted within a session

### Session Storage Keys

- Staff sessions: `staff_session_<slug>` (HttpOnly cookie, SameSite=Strict)
- Customer order tracking: URL fragment only (never sent to server in request line)

### Café Switching

- Not supported within a browser session
- Each café has its own URL and context
- Operator can switch between cafés via the admin interface (different session per café)

### Counter/Table Transitions

- Once a café's service_mode is set, it persists in the database
- The initial mode is set at creation; the database value wins thereafter
- No programmatic transition between modes

### API Resilience Work

- Request timeouts (15s default)
- Retry logic for idempotent operations
- Stale request protection (requests are aborted on timeout, signal cancellation)
- Rate limiting with D1-backed durable windows (survive isolate restarts)
- Error boundaries and generic 404/503 responses that don't leak internals

## Payments

- **Razorpay integration**: Configured but disabled in preview environment
- Payment endpoints require `x-order-token` header and valid capability
- Online payments turn on only when `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, and `RAZORPAY_WEBHOOK_SECRET` are set
- In preview: payments remain disabled; guests offered counter payment instead
- **Do not enable payment processing** without explicit authorization and Razorpay key configuration
- The integration is architected so that plaintext card data never passes through the browser; Razorpay SDK handles client-side encryption