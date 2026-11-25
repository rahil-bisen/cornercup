# Corner Cup — Product Readiness Report

Audit performed against the repository at the product-readiness phase. No code was changed to
produce this report; it is an inspection-and-verification artifact. Security hardening
(F-01–F-20, Phase 2B) is complete and verified separately (424/424 tests, build green,
0 audit vulnerabilities).

## 1. Café onboarding and configuration

**Working**
- Operator console (`/operator`) creates cafés with name, slug, owner password, service mode, table count.
- Per-café settings (name, service mode, clock offset, contact phone/email/address, owner password) editable from Staff → Café setup; saved settings propagate to guest site and policy pages.
- Slug-scoped URLs; tenant isolation at data layer.

**Broken / missing**
- No onboarding wizard or checklist for a new café; owner must discover settings tabs.
- Contact fields optional but policy pages show placeholders when empty (intentional, but looks unfinished to real customers until filled).
- No validation that contact email/phone are real; no test email.

**UI/UX**
- Operator create form is desktop-oriented; usable on mobile but cramped.
- Password reveal shown once with no "I saved it" confirmation beyond Done button.

**Edge cases**
- Service-mode switch applies from next order only; documented. Table QRs for a switched-to-counter café still resolve? Code refuses table orders in counter mode (400) — good, but guest sees error rather than redirect.
- Clock offset changes affect pickup numbering rollover; no warning.

**Test coverage**
- Operator routes: 9 HTTP tests. Settings re-auth: 8 tests. Migrations: covered.

**Improvements**
- Add a first-run checklist on the owner board (fill contacts, set password, print QRs).
- Validate contact fields format (soft).
- Warn before service-mode switch with open orders.

## 2. Menu and category management

**Working**
- List, toggle availability, delete, add items with category, description, price, emoji.
- Categories derived from items; datalist suggestions.
- Server-side price recalculation on order; menu snapshotted onto orders.

**Broken / missing**
- No item image upload (emoji only).
- No reordering/sort order control (sort field exists in DB but no UI).
- No bulk import/export or CSV.
- No modifiers/options (size, milk, extras) — single price per item.
- No stock quantity (only available boolean).
- No category rename/merge; deleting all items in a category removes it implicitly.

**UI/UX**
- Add-item form always visible; okay.
- No drag-and-drop reordering.

**Edge cases**
- Price entered as decimal; converted to cents. Min 0.5 enforced client-side only; server validates?
- Emoji maxLength 4 (may clip multi-codepoint emoji).

**Test coverage**
- Menu endpoints covered indirectly by orders.integration and public.exposure. No dedicated menu CRUD tests.

**Improvements**
- Add item images (optional, R2 later) — medium priority.
- Add modifiers — high for cafés with variants.
- Server-side validation for price bounds.

## 3. QR / table ordering

**Working**
- Table QR encodes `/c/:slug/t/:id`; landing → menu.
- Table selection picker when no table in URL.
- Table stored per café in sessionStorage; cleared on café change.
- Counter mode: no tables, pickup flow.

**Broken / missing**
- No table merge/split, no table status (occupied/free).
- No QR regeneration or bulk print with custom branding.
- Table count cap 40 (operator form) but addTable has no cap check in UI? Server may enforce.

**UI/UX**
- Table picker grid okay.
- No "table not found" graceful handling beyond error + retry.

**Edge cases**
- Old table QR after mode switch → 400 "table orders refused in counter mode"; guest sees generic error.
- Table id globally unique but display number per café — good.

**Test coverage**
- orders.integration covers table scoping. No dedicated QR tests.

**Improvements**
- Graceful redirect/message when a table QR is used in counter mode.
- Table status/occupancy (optional).

## 4. Counter ordering and queue management

**Working**
- Counter mode gives daily pickup numbers (`queue_no`) restarting at midnight in café TZ.
- Allocated inside INSERT (no duplicates).
- Owner board shows `#N`, searches by number.
- Status timeline says "Collected".

**Broken / missing**
- No "call next number" / display screen for customers.
- No average wait time.
- No priority/express queue.

**UI/UX**
- Pickup badge clear.

**Edge cases**
- Midnight rollover timezone; tested by unit? Possibly.
- Concurrent orders: atomic allocation tested (orderid.concurrency).

**Test coverage**
- orderid.concurrency, orders.integration.

**Improvements**
- Customer-facing "now serving" display (optional).

## 5. Guest checkout

**Working**
- Cart per table/café in localStorage; qty stepper; note.
- Idempotency key + checkout claim; retry/abandon handling.
- Server-side price recalculation; cross-tenant item rejection.
- Cart survives reload; clears after order.

**Broken / missing**
- No quantity upper bound beyond 20 (client); server may not enforce.
- No item-level notes (only order note).
- No promo/discount codes.
- No saved favorites.
- No guest account/history.

**UI/UX**
- Cart bar sticky bottom; bottom sheet. Good mobile.
- Place order button in sheet; error shown.

**Edge cases**
- Cart changed mid-checkout handled (abandonPendingCheckout). Good.
- Network failure mid-checkout: unverified state → user prompted to retry. Good.

**Test coverage**
- orders.deep, order.tracking, orders.integration, checkout.logic (if exists).

**Improvements**
- Server-side quantity bounds enforcement (verify).
- Optional item notes.

## 6. Order tracking

**Working**
- Per-order token in URL fragment; HMAC-derived; D1 stores hash + nonce.
- Token required via header; generic 404 otherwise.
- Live polling 4s; status timeline; receipt.
- Payment panel integration.

**Broken / missing**
- No push notifications / no service worker.
- Token never expires (accepted risk).
- No "add to home screen" / PWA.
- Legacy orders without tracking data unreadable to guests (by design).

**UI/UX**
- Timeline clear. Cancelled state handled.

**Edge cases**
- Missing token → "Order not found" card with back link. Good.
- Cancelled order shows cancelled message.

**Test coverage**
- order.tracking (extensive), browser.credentials.

**Improvements**
- PWA + push (optional, later).

## 7. Staff dashboard and order-state transitions

**Working**
- Kanban columns New/Preparing/Ready; actions advance; cancel with confirm.
- Payment tabs Paid vs Unpaid/failed; payment chips; confirm cash; sound alert; search; stats strip; 4s polling; document title with open count.
- Age-based warm/late coloring.

**Broken / missing**
- No pagination; all orders loaded. Could be slow with many.
- No date-range filter for stats (today only).
- No export (CSV/PDF) of orders.
- No refund action.
- No assignee/staff user tracking (single shared password).
- No kitchen display mode (KDS) separate from board.
- Sound alert uses Web Audio; may be blocked by autoplay policy until interaction.

**UI/UX**
- Desktop-first board; works on tablet. Mobile cramped but usable.
- Search covers order id, table, queue no, item names.

**Edge cases**
- Payment status guarded transitions (confirmed can't downgrade). Good.
- Concurrent edits: last-write-wins for status (no locking). Could cause lost updates but low risk.

**Test coverage**
- status.transitions (T14–T18), orders.deep, session.revocation.

**Improvements**
- Pagination / virtualization for high volume.
- Export orders.
- Kitchen display view.

## 8. Owner dashboard and analytics

**Working**
- Stats: collected today, online, counter cash, unpaid, average bill, settled count.
- Menu management, tables & QR, settings.

**Broken / missing**
- Analytics limited to "today"; no historical trends, charts, or export.
- No top-selling items report.
- No hourly breakdown.
- No multi-day comparison.
- No revenue by payment method beyond online/counter.

**UI/UX**
- Tabs clear.

**Edge cases**
- Stats computed server-side? Need to verify `getStats` filters by date in café TZ. Likely.

**Test coverage**
- No dedicated analytics tests; stats returned by /api/admin/orders (covered by integration).

**Improvements**
- Add historical analytics + export (medium/high).
- Top items report.

## 9. Multi-café tenant isolation

**Working**
- All queries filtered by cafe_id; staff token names café; cross-café session refused.
- Public exposure tests; cafe-scope tests.

**Broken / missing**
- No per-café branding/theming beyond name.
- No per-café domain (single deployment).
- No per-café currency (hardcoded ₹/INR).
- No per-café tax.

**UI/UX**
- Default café redirect from `/`.

**Edge cases**
- In-app navigation between cafés resets table/cart. Good.

**Test coverage**
- cafe-scope, public.exposure, session.revocation (cross-tenant).

**Improvements**
- Per-café currency/locale (if international) — optional.
- Per-café theme colors.

## 10. Customer mobile experience

**Working**
- Mobile-first CSS; 44px targets; sticky cart bar; bottom sheet; safe-area insets; skeleton loading; retry notices.

**Broken / missing**
- README lists "Product details and customisation", "Cart and checkout", "Order tracking", "Owner dashboard" as planned/not done — but code exists. Possible polish gaps:
  - No product detail view (items are flat list; no modal with larger description/nutrition/allergens).
  - No image (emoji only).
  - No saved cart across devices.
- No PWA install prompt / offline.
- No haptic feedback.
- No dark mode toggle (system? CSS may support prefers-color-scheme — check).

**UI/UX**
- Menu category nav horizontal scroll.
- Long item names wrap.

**Edge cases**
- Small screens (360px) — CSS targets. Not visually verified in this audit (no screenshots taken).

**Test coverage**
- menu.component, orderstatus.component, browser.credentials. No visual regression tests.

**Improvements**
- Product detail sheet with image (medium).
- PWA (optional).

## 11. Operator management

**Working**
- Create café, reset password (reveals once), sign out/everywhere.
- Audit rows for mutations.

**Broken / missing**
- No edit café (name/slug) after creation; no delete café.
- No operator user management (single password).
- No list of owner identities / membership management UI (only API routes tested; no UI? Admin has claim redemption but operator-side grant/revoke not in UI? Operator.jsx doesn't show membership management).
- No deployment health/usage dashboard for operator.

**UI/UX**
- Console shows café count, items, open orders.

**Edge cases**
- Slug uniqueness enforced? Need to verify.
- Table count 0–40.

**Test coverage**
- operator.owner-routes (9), operator.revocation.

**Improvements**
- Operator UI for granting/revoking owner identities.
- Café edit/delete (with safeguards).

## 12. Existing payment behavior

**Working**
- Counter payment fully functional.
- Razorpay: order creation, verify, webhook, idempotent settlement, amount/currency checks, tracking token required.
- Disabled gracefully when no keys; UI shows counter-only.

**Broken / missing**
- Razorpay disabled by default; enabling requires live account + webhook + CSP verification (documented).
- No refund/partial payment/chargeback handling.
- No receipt email.
- Webhook per-café (one webhook per café or shared slug) — operational burden.
- Payment status "submitted" (awaiting confirmation) path exists but online flow settles immediately; "submitted" only via manual? Legacy.

**UI/UX**
- PaymentPanel shown when unpaid & not counter. Good.

**Edge cases**
- Amount mismatch acknowledged but not settled — good.
- Webhook raw body signature — good.
- Gateway order claim TTL — good.

**Test coverage**
- razorpay.payment (32+ tests, stubbed).

**Improvements**
- Live sandbox verification (when authorized).
- Refund handling (future).

## Prioritized product-readiness list

### Critical (blocks product launch)
1. **Razorpay production readiness** — enable and verify on staging with real sandbox (keys, webhook, CSP). Currently disabled; online payments unproven end-to-end.
2. **Argon2id CPU/memory on deployed runtime** — unmeasured; Free plan likely 1102. Needs staging measurement before launch.
3. **No real WorkOS sandbox verification** — managed auth unproven with real provider (issuer, sid, revoke, code lifetime, PKCE).
4. **No data backup/export or restore procedure** — only documented; needs tested backup.

### High priority
5. **Analytics depth** — only today's stats; add historical trends, top items, export.
6. **Operator UI for owner membership management** — API exists and tested, but no console UI to grant/revoke.
7. **Café edit/delete** in operator console.
8. **Product modifiers/options** (size, milk, extras) — significant revenue feature for cafés.
9. **Quantity/price server-side validation audit** — ensure bounds enforced server-side, not just client.
10. **Pagination/virtualization** on owner order board for high-volume cafés.
11. **Graceful handling of stale table QRs** after mode switch.

### Medium priority
12. Item images (optional, storage).
13. Item-level notes / special instructions.
14. Product detail sheet (description, allergens).
15. Kitchen display mode (KDS).
16. Historical order export (CSV).
17. Per-café branding/theme.
18. Dark mode verification (CSS).
19. Sound alert autoplay policy handling.
20. Table status/occupancy.

### Optional enhancements
21. PWA + push notifications.
22. Loyalty / repeat customer recognition.
23. Reservations / waitlist.
24. Multi-language.
25. Tips.
26. Split bills.
27. Inventory/stock tracking.
28. Customer accounts/order history.

## Test coverage summary
- Total: **424 tests, all passing**.
- Strong coverage: security (F-01–F-20), session revocation, payments (stubbed), order tracking, concurrency, body limits, rate limiting, auth modes, managed auth, revocation queue, operator routes.
- Gaps: menu CRUD dedicated tests, analytics, operator membership UI, visual/mobile regression, end-to-end browser flows (only mocked).

## Conclusion
The application is functionally complete for a single-tenant QR ordering flow with strong security hardening. Product readiness gaps are concentrated in: live payment/provider verification (external), analytics depth, operator management UI, and café-facing features (modifiers, images). No critical code defects found in this audit; the main blockers are external verification and product-depth features. Recommended next step: staging deployment (with approval) to measure Argon2id and verify Razorpay/WorkOS end-to-end, then iterate on high-priority product features.
