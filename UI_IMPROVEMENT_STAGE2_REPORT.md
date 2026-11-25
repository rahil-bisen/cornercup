# Corner Cup — UI Improvement Stage 2: Implementation Report

**Scope:** frontend presentation only. No backend, API, database, authentication, payment, routing or order-logic change. Nothing staged, committed, deployed or published.

**Result:** all four areas implemented, 449/449 tests pass, production build succeeds. One new test file was added; no existing assertion was weakened or removed.

---

## 1. What changed

### 1.1 Menu and touch usability

**Touch targets.** Every guest control now clears 44×44. Measured on the live build at 360px: **0 interactive elements under 44px** on the menu screen (was 28).

| Control | Before | After |
|---|---|---|
| Category chip | 35px tall | 44px tall |
| Add button | 36×36 | 44×44 |
| Stepper ± | 30×30 | 44×44 |
| Sheet close | 34×34 | 44×44 |

**Category active state.** The rail is now driven by a scroll-spy in `Menu.jsx`: the current section is the last one whose top has passed just under the sticky rail, plus an end-of-page rule so the final section can win even when it is too short to reach that line. Chips carry `aria-current="true"` and an ink-filled active style in the existing palette.

Verified live (360px viewport, root scroll positions):

| Target section | Scroll Y | Active chip |
|---|---|---|
| top | 0 | Coffee |
| Breakfast | 1095 | Breakfast |
| Lunch | 1880 | Lunch |
| Something Sweet | 2685 | Something Sweet |
| Cold Drinks | 3176 | Cold Drinks |
| bottom | max | Cold Drinks |

The first implementation throttled with `requestAnimationFrame`, which never fires while a tab is occluded — the rail froze on the first category. It was replaced with an 80ms timer throttle that runs regardless of paint.

**Clipping.** The rail moved into a sticky wrapper with a right-edge fade, `scroll-padding-inline` and 34px of end padding, so the next chip reads as "more to the right" instead of a word sliced by the viewport.

**Card hierarchy.** The item card was restructured: the name owns the full text column, the description follows at 14–15px, and price plus control share a `.menu-foot` row — price left, control right. Name, price and stepper can no longer collide at 360px (measured text column 218px against a 198px price+stepper row).

**Sold out.** The whole-card `opacity: 0.62` is gone. The medallion greyscales, the name shifts to `--ink-soft`, the price is struck through and the existing `Sold out` pill moves up beside the name. `item.available` still gates the controls exactly as before.

**Loading.** The skeleton now includes the category rail and a third line per card, so the real content does not shift the layout when it lands.

### 1.2 Café error state

`Menu.jsx` resolves every blocking failure into one `failure` object with one retry:

- café config failed → "We couldn't open this menu" + the server's message + one `Try again` (retries config, tables and menu) + a `Back to the start` link;
- menu request failed (unknown table, expired link) → "Hmm, that link didn't work" with the same single retry.

The table picker is no longer reachable while the café itself is unresolved. Measured on `/c/no-such-cafe/menu`: **1 state card, 1 alert, 1 retry button, no table picker** (previously 2 identical alerts and 2 retry buttons). `/c/corner-cup-caf/t/99` shows the unchanged API message "We couldn't find that table. Please scan the QR code again." with one retry. Retrying keeps exactly one card.

### 1.3 Order tracking

`headingFor()` maps the real status:

| Status | Table order | Pickup order |
|---|---|---|
| `new` | Order confirmed | Order confirmed |
| `preparing` | Being made | Being made |
| `ready` | Your order is ready | Ready to collect |
| `served` | Served | Collected |
| `cancelled` | Order cancelled | Order cancelled |

`new` deliberately keeps "Order confirmed": it is accurate there, and the existing regression test asserts it.

The queue number (or table) is now `.queue-number` at `clamp(2.4rem, 12vw, 3.1rem)` above the heading. Measured on a live pickup order at 390px: queue number **46.8px**, heading **23.2px** — the number is the largest text on the page.

Loading the tracking page now shows a header skeleton plus a four-step timeline skeleton instead of a bare "Finding your order…" line. Polling, token handling, error handling and the payment panel are untouched.

### 1.4 Cart sheet

`CartSheet` now renders an inner dialog component only while open, so focus work has an exact lifetime:

- focus moves to the close button on open;
- `Escape` closes (suppressed while `placing`, so a submitted order's reply is never orphaned);
- `Tab`/`Shift+Tab` wrap inside the dialog;
- on close, focus returns to the element that opened it — measured: `document.activeElement === .cart-bar` after `Escape`, and `body.sheet-open` is cleared;
- the footer was reordered to helper copy → total → primary button, so the action is last and survives keyboard compression; `max-height: 90dvh` (with a `90vh`/`84vh` fallback) keeps total and button on screen when the note field has focus;
- each line shows its unit price only when quantity is above one ("₹220.00 each" beside "₹440.00"); at quantity one the duplicated figure is gone;
- a secondary "Add more items" action closes the sheet.

`.sheet-foot` still contains the place-order button **first**, which is what `tests/menu.component.test.mjs` selects. Checkout payload, idempotency handling, cart keys and the `sheet-open` body class are unchanged.

### 1.5 Shared styling

One additive CSS block at the end of `styles.css` (clearly delimited) overrides base rules by cascade rather than rewriting anything. It also adds:

- `:focus-visible` rings for add, stepper, icon, category and sheet controls (previously only four selectors had them);
- one width for state-card actions, so primary and secondary stack evenly;
- a 430px breakpoint giving larger medallions and slightly larger names;
- `theme-color` aligned to `--ink` (`#241814`) in `index.html`.

Duplicate CSS blocks were **not** consolidated: `.landing`, `.table-chip`, `.landing-note` and `.site-foot-links a` are redefined later in the same file and interact with cascade order. Consolidating them is a separate, higher-risk change and was deliberately left out of an otherwise additive stage.

---

## 2. Modified and added files

**Modified**

| File | Change |
|---|---|
| `src/pages/Menu.jsx` | category scroll-spy + `aria-current`/active chip, sticky rail wrapper and fade, header brand mark and honest badge caption, restructured card (`.menu-name`, `.menu-desc`, `.menu-foot`), single failure state with one retry, shaped skeleton, `sectionId()` helper |
| `src/components/CartSheet.jsx` | rewritten: dialog lifecycle, Escape, focus trap and restoration, reordered keyboard-safe footer, "Add more items", de-duplicated line pricing, `aria-labelledby` |
| `src/pages/OrderStatus.jsx` | `headingFor()` status copy, prominent `.queue-number`, header hierarchy, tracking skeleton |
| `src/styles.css` | additive Stage 2 block (targets, rail, card, sold-out, queue number, sheet, focus rings, 430px rules); `overflow-x: hidden` on the sheet body |
| `index.html` | `theme-color` `#231713` → `#241814` |

**Added**

| File | Purpose |
|---|---|
| `tests/orderstatus.status.test.mjs` | pins status-aware headings, pickup vs table wording, queue-number element, cancelled timeline |
| `UI_IMPROVEMENT_STAGE2_REPORT.md` | this report |
| `ui-audit/after-*.png` | after screenshots (§5) |

Unchanged by this stage: `worker/**`, `src/lib/**`, `src/main.jsx` routing, `src/components/PaymentPanel.jsx`, `src/components/SiteFooter.jsx`, `src/pages/Landing.jsx`, `Admin.jsx`, `Operator.jsx`.

`.icon-btn` is also used by one staff control (delete menu item in `Admin.jsx`), which inherits the 44px size. That is a larger, still-fitting target, not a layout change; it is the only non-guest effect of the shared block.

---

## 3. Test and build results

| Check | Result |
|---|---|
| Targeted: `tests/menu.component.test.mjs` + `tests/orderstatus.component.test.mjs` | **14 pass, 0 fail** |
| New: `tests/orderstatus.status.test.mjs` | **4 pass, 0 fail** |
| Full suite `npm test` | **449 tests, 449 pass, 0 fail, 0 skipped**, exit 0 (445 existing + 4 new) |
| `npm run build` | **exit 0** — `index-Bg9KrlpZ.js` 281.60 kB (gzip 90.87 kB), `index-CQLR4mz5.css` 32.36 kB (gzip 7.05 kB) |

No assertion was relaxed, deleted or skipped. The one test that constrains copy — `assert.match(page.text(), /Order confirmed/)` for a `new` order — passes because that exact wording is preserved for `new`.

---

## 4. Verification matrix

Measured on the built app served by local `wrangler dev` (local dev D1 only).

| Width | Horizontal overflow | Targets < 44px | Rail | Notes |
|---|---|---|---|---|
| 360×800 | none (`scrollWidth` 343) | **0** | scrolls, fade, active | price and stepper share one row without collision |
| 390×844 | none (`scrollWidth` 374) | **0** | scrolls, fade, active | — |
| 430×932 | none (`scrollWidth` 414) | **0** | scrolls (5th chip faded) | larger medallions from the 430px breakpoint |
| 768×1024 | none | — | fits (5 chips) | page 720px centred |
| 1280×900 | none | — | fits | page 720px centred, card right edge 976 |

Behaviour checks performed in the browser:

- **Category rail** — all five sections activate correctly, including the previously failing last section.
- **Cart sheet** — opens, `Escape` closes, focus lands on "Close order" on open, `Tab` from the last control wraps to the first, focus returns to `.cart-bar` on close, body scroll lock applied and cleared, footer CTA visible, no horizontal scroll inside the sheet.
- **Error state** — one card, one retry, no table picker; retry re-renders a single card; unknown table keeps its original API message.
- **Order tracking** — a real local pickup order rendered "Order confirmed" with pickup number `1` at 46.8px, the payment panel unchanged (`Pay ₹180.00`, counter fallback), and the timeline at step 1.
- **Checkout** — placing that order went through the unchanged path (`POST /api/cafes/<slug>/orders` → `/c/<slug>/order/<id>#t=<token>`); no payment endpoint was called by the UI.

---

## 5. Before / after

| Screen | Before | After |
|---|---|---|
| Menu 390 | `![before](ui-audit/01-menu-390.png)` | `![after](ui-audit/after-03-menu-390.png)` |
| Menu 360 | `![before](ui-audit/04-menu-360.png)` | `![after](ui-audit/after-01-menu-360.png)` |
| Menu 430 | — | `![after](ui-audit/after-04-menu-430.png)` |
| Menu 768 / 1280 | — | `![after](ui-audit/after-05-menu-768.png)` · `![after](ui-audit/after-07-menu-1280.png)` |
| Cart sheet | `![before](ui-audit/02-cart-sheet-390.png)` | `![after](ui-audit/after-09-cart-390.png)` |
| Error state | `![before](ui-audit/05-error-state-360.png)` | `![after](ui-audit/after-06-error-390.png)` |
| Order tracking | — | `![after](ui-audit/after-08-status-390.png)` |

---

## 6. Unresolved issues and limitations

1. **Table-service (dine-in) screens were not visually verified.** Both cafés in the local dev database run `service_mode = counter`; changing that would alter data outside the stage's boundaries. The table branches are unchanged and covered by the existing component tests.
2. **Screenshots above ~531 CSS px are cropped by the capture tool.** The 768px and 1280px captures show only the left portion; their layout was verified by DOM measurement (page width 720, no overflow, rail fits) rather than by eye.
3. **The cart sheet body still reports a 2px horizontal overhang** (`scrollWidth` 345 vs `clientWidth` 343) from sub-pixel flex rounding. It is contained with `overflow-x: hidden`; no content is clipped. A structural fix would mean reworking the line row, which was not worth the risk here.
4. **No product-detail page or customisation exists**, and none was added: items carry no options or images in the API or schema, so both would be backend work.
5. **Razorpay's `theme.color` remains `#231713`.** It is a payment-configuration value, so it was left untouched; the audit's colour alignment was applied only to `theme-color` in `index.html`.
6. **Duplicate CSS blocks remain** (§1.5). Consolidation is deferred as a separate change.
7. **One local dev order (`FL3LJA`) was created** while verifying the tracking page end-to-end. It exists only in the local dev D1; no production or staging data was touched.
8. **The close button shows its focus ring on open** because focus is moved programmatically. This is intentional for keyboard users; it is visible in the "after" sheet screenshot.
9. **Admin inherits the 44px `.icon-btn`**, a deliberate shared-size change (§2).

**Stopped here for review.** No further UI work, no deployment, no publication, no commit.
