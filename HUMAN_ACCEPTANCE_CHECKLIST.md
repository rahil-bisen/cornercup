# HUMAN ACCEPTANCE CHECKLIST

**Status: PARTIALLY RUN — local pilot session only.** The 13 numbered items below have **not** been performed as
written; their result boxes stay empty. One human session on **2026-11-24** against the **local pilot** Worker
did execute and pass the 10 flows recorded in [section A](#a-local-pilot-session--2026-11-24-image-storage-disabled).
That session is a real human verification of those 10 flows and nothing more: it is not a staging or production
acceptance, and it does not cover the remaining items.

**Time:** 10–15 minutes · **Where:** an isolated test deployment (staging Worker, or project A's preview once
published), never a live café and never production · **Who:** the owner-to-be on the device they will actually
use, plus one person placing a guest order from a phone.

## A. Local pilot session — 2026-11-24 (image storage disabled)

**Environment:** local pilot Worker at `http://127.0.0.1:8788`, café slug `corner-cup-local-pilot`, isolated
disposable local D1 behind `wrangler.pilot.jsonc`. The `IMAGES`/R2 binding is **not** configured in this pilot
(no payment method on the account), so any image storage behaviour was out of scope.

**Tester:** a person, acting as the café owner, on the device they would use to run a shift.
**Scope:** the 10 flows in the table. Nothing else in this document was performed.

| # | Flow | Result | Notes |
|---|---|---|---|
| A1 | Owner login (password → 6-digit code → board) | **PASS** | Signed in at `/c/corner-cup-local-pilot/owner`; the board is not reachable with the password alone. |
| A2 | TOTP/MFA enrollment and verification | **PASS** | Enrolled an authenticator from the Security tab, confirmed it, then signed in with a generated code. |
| A3 | Guest dine-in ordering | **PASS** | Order placed as a guest from the table link, no account, email or phone. |
| A4 | Order appears on the owner kitchen board | **PASS** | The A3 order showed up on the board with its table and items. |
| A5 | Status transitions New → Preparing → Ready → Served, with customer tracking following | **PASS** | Each step advanced on the board and the guest tracking page reflected the new status. |
| A6 | Counter ordering and queue assignment | **PASS** | Counter order placed and received the next sequential queue number. |
| A7 | Recovery code works once | **PASS** | A saved recovery code from enrollment signed in successfully on first use. |
| A8 | Reusing the same recovery code is rejected | **PASS** | The second attempt with that same code was refused. |
| A9 | Tampered order-tracking token is rejected | **PASS** | An altered token returned “Order not found”; no order details were shown. |
| A10 | Sold-out item is displayed as unavailable with no customer ordering option | **PASS** | In the guest menu the item reads as unavailable and cannot be added to the cart. |

### What this session does **not** establish

- **Sold-out backend rejection was not attempted through the UI.** The refusal of an order containing a sold-out
  item is covered only by the automated `409` check in `scripts/pilot-verify.mjs` — that is automated evidence,
  not a human-verified result, and it must not be recorded as one.
- **Image upload, display and removal (#7) was not run.** The pilot has no R2 bucket or `IMAGES` binding, so this
  stays **blocked (R2 not enabled)**. The only related observation is automated: the upload endpoint answers
  `503` while storage is unconfigured.
- **Not exercised in this session:** invalid/malformed TOTP entry (#2), the spend-after-five-wrong-codes limit,
  session invalidation after a password change or “sign out everywhere” (#4), reading the full Security tab (#5),
  menu item creation/rename/price editing (#6), double-tap double-submit protection and totals reconciliation
  (#8), the illegal `new → served` jump (#9), the tracking token's placement in the URL rather than the path or
  query string (#10), and keyboard-only navigation with announced errors (#13).
- Cookie flags (`HttpOnly`, `SameSite=Strict`), response bodies captured as evidence, and any screenshot records
  were not taken during this session; no screenshots are attached.
- This was a **local** run on one machine. Nothing here describes staging or production behaviour, and no
  deployment was involved.

---

## Prerequisites

- [ ] A running Worker you are allowed to create test data in, running **the current build**; the URL is
      recorded here: `____________`. The existing `corner-cup-staging` Worker is **not** suitable as-is: its
      version (`80f92ceb`, 2026-11-16) predates the MFA schema (no `owner_totp` / `auth_events` tables), so
      tests 1–5 cannot pass there until the current code is deployed to an isolated environment.
- [ ] A café with a known owner password (12+ chars) — any test value, never the pilot's real password
- [ ] A phone with an authenticator app
- [ ] A second browser window or a private window for the guest side
- [ ] R2 enabled on the account **only** if you intend to run #7; otherwise mark #7 blocked

Do not use real customer names, real phone numbers, or real payment details. Payments stay disabled.

---

## 1. Owner sign-in with password and TOTP — 90 s

| | |
|---|---|
| **Steps** | Open `/c/<slug>/admin`. Enter the owner password. When asked, enter the 6-digit code from the authenticator app. |
| **Expected** | Password alone yields a code prompt, never the board. Correct code loads the board. `Set-Cookie` is `HttpOnly` and `SameSite=Strict`. |
| **Evidence** | Screenshot of the code prompt; DevTools → Application → Cookies showing the flags; the URL used. |
| **Result** | ☐ pass ☐ fail — notes: |

## 2. Invalid TOTP rejection — 45 s

| | |
|---|---|
| **Steps** | Sign out. Enter the correct password, then a 6-digit code that is wrong (e.g. swap two digits). Repeat with a 5-digit and a 7-digit entry. |
| **Expected** | Each is refused with a visible message; no session cookie is set; the code prompt remains usable. After five wrong codes the challenge is spent and a fresh password entry is required. |
| **Evidence** | Message text for each of the three shapes; confirmation that no `staff_session_<slug>` cookie exists afterwards. |
| **Result** | ☐ pass ☐ fail — notes: |

## 3. Recovery code use and single-use enforcement — 90 s

| | |
|---|---|
| **Steps** | Sign in with password → choose "use a recovery code" → enter one saved code. Sign out, then try the **same** code again. Then try a code from the saved list that has not been used. |
| **Expected** | First use signs in and the count drops by one. The reused code is refused. The unused code still works. |
| **Evidence** | Remaining-code count before/after; the refusal message on reuse. Keep the codes out of any screenshot. |
| **Result** | ☐ pass ☐ fail — notes: |

## 4. Session invalidation after a security change — 90 s

| | |
|---|---|
| **Steps** | Keep window A signed in. In window B, change the owner password (current password required), then sign out everywhere. Return to window A and reload the board; also try the tracking page in a third tab. |
| **Expected** | Window A is signed out immediately after either action. A copied cookie value is refused. |
| **Evidence** | The first request after the change, with its status (401/redirect), in both windows. |
| **Result** | ☐ pass ☐ fail — notes: |

## 5. Owner security settings — 60 s

| | |
|---|---|
| **Steps** | Open the **Security** tab. Read every value; toggle nothing destructive. Check the sign-out-everywhere control and the MFA status. |
| **Expected** | MFA shows enabled with the correct remaining-recovery-code count; session list renders; actions requiring the password are labelled as such. No console errors. |
| **Evidence** | Screenshot of the tab; console output (should be empty). |
| **Result** | ☐ pass ☐ fail — notes: |

## 6. Menu item editing and price change — 90 s

| | |
|---|---|
| **Steps** | Add an item with a price in whole rupees. Edit its name, then its price. Mark a second item unavailable. Reload the guest menu in the other window. |
| **Expected** | Board shows the new values immediately after save. Prices are stored in paise and displayed correctly (₹120 stays ₹120, not ₹1.20 or ₹12,000). The unavailable item is visible but cannot be added. |
| **Evidence** | Before/after screenshots; the guest-side cart refusing the unavailable item. |
| **Result** | ☐ pass ☐ fail — notes: |

## 7. Image upload, display and removal — 90 s (needs real R2)

| | |
|---|---|
| **Steps** | Upload a photo to an item. Confirm it appears on the board and on the guest menu. Remove it. Reload both. |
| **Expected** | Upload succeeds only when R2 is enabled and the `IMAGES` binding is attached; otherwise the board says storage is not configured (503) and the item keeps its default image. After removal the default returns; no broken image icon. |
| **Evidence** | The upload response status; the served image URL; the same URL after removal. |
| **Result** | ☐ pass ☐ fail ☐ **blocked (R2 not enabled)** — notes: |

## 8. Guest ordering — 2 min

| | |
|---|---|
| **Steps** | In the guest window, add three items to the cart, then place the order as a guest (optional name). Double-tap "Place order" on a second attempt in a fresh cart. |
| **Expected** | No account, no email, no phone required. Totals match the menu. Double submission creates exactly **one** order. A confirmation/pickup number is shown. |
| **Evidence** | Order id(s) created — confirm only one exists for the double-tap; the confirmation screen. |
| **Result** | ☐ pass ☐ fail — notes: |

## 9. Kitchen status transitions — 90 s

| | |
|---|---|
| **Steps** | On the board, move the order **new → preparing → ready → served**. Then attempt an illegal jump (new → served) on a fresh order. |
| **Expected** | Each legal step is one click and the guest page follows. The illegal jump is refused. The board updates without a manual refresh (10 s poll at worst). |
| **Evidence** | Status values in the DB/API after each step; the refusal message for the jump. |
| **Result** | ☐ pass ☐ fail — notes: |

## 10. Guest order tracking — 60 s

| | |
|---|---|
| **Steps** | Open the tracking link on the guest phone; keep it open while the board moves the order forward. |
| **Expected** | Status updates within one poll (~15 s). The tracking token is in the URL fragment/header, never the query string or path. Refreshing keeps working. |
| **Evidence** | Full tracking URL (redact the token); before/after status screenshots. |
| **Result** | ☐ pass ☐ fail — notes: |

## 11. Counter queue numbering — 60 s

| | |
|---|---|
| **Steps** | In counter mode, place two orders in a row and note both pickup numbers. |
| **Expected** | Sequential within the café's local day (e.g. 1 and 2), not random and not duplicated. |
| **Evidence** | Both order ids and their `queue_no` values, plus the café timezone offset in use. |
| **Result** | ☐ pass ☐ fail — notes: |

## 12. Invalid tracking token behaviour — 45 s

| | |
|---|---|
| **Steps** | Open a valid tracking URL with the token altered by one character. Then open it with the token removed entirely. |
| **Expected** | "Ask our staff" style refusal — never the order, never a 500. No order data in the response body. |
| **Evidence** | Both response bodies/status codes; confirm no order fields leak. |
| **Result** | ☐ pass ☐ fail — notes: |

## 13. Keyboard navigation and accessible error announcements — 2 min

| | |
|---|---|
| **Steps** | With the mouse untouched: Tab through the owner sign-in form and submit with Enter. Trigger a wrong-password error. Tab through the cart and place an order with the keyboard only. Inspect the error element in DevTools. |
| **Expected** | Visible focus on every control, logical tab order, Enter submits. Error text is announced (`role="alert"` / `aria-live`), not just coloured. No keyboard trap. |
| **Evidence** | The error element's attributes; focus-order notes; screen-reader announcement if available. |
| **Result** | ☐ pass ☐ fail — notes: |

---

## B. Local pilot acceptance session — 2026-11-24

**Environment:** local pilot Worker at `http://127.0.0.1:8788`, café slug `corner-cup-local-pilot`, isolated
disposable local D1 behind `wrangler.pilot.jsonc`. This is the **same pilot** used for Section A; it is a new,
separate human acceptance pass that records the browser-verified results below. The `IMAGES`/R2 binding is still
**not** configured in this pilot, so image storage behaviour remains out of scope.

**Tester:** a person, acting as the café owner, on the device they would use to run a shift.
**Scope:** the browser-verified checks in the table. Nothing else in this document was changed by this session.

### Browser-verified results (this session)

| # | Test | Result | Evidence |
|---|---|---|---|
| B1 | Cookie `HttpOnly` | **PASS** | Browser showed `HttpOnly = true` |
| B2 | Cookie `SameSite` | **PASS** | Browser showed `SameSite = Strict` |
| B3 | Counter queue numbering | **PASS** | Two consecutive orders received queue numbers 3 and 4 |
| B4 | Duplicate checkout protection | **PASS** | Double-click checkout created exactly one order |
| B5 | Cart total calculation | **PASS** | Three-item cart total matched item prices |
| B6 | Order status progression | **PASS** | New → Preparing → Ready → Served worked |
| B7 | Customer tracking updates | **PASS** | Tracking reflected status changes |
| B8 | Security settings visibility | **PASS** | MFA ON, 10 recovery codes displayed, active session visible |
| B9 | Sign out everywhere | **PASS** | Other browser session was invalidated |
| B10 | Invalid TOTP rejection | **PASS** | Incorrect code rejected |
| B11 | Valid TOTP after a failed attempt | **PASS** | Correct code subsequently authenticated successfully |

### Browser-verified results — not run in this session

1. **Recovery-code count decrement — NOT RUN.** The tester authenticated using an authenticator code instead of a
   recovery code, so no recovery code was consumed; the remaining count stayed at 10. Single-use enforcement of a
   recovery code (#3) is therefore not human-verified by this session.
2. **Menu item creation — PASS (browser-verified).** Adding a menu item from the **Menu** tab on the owner board
   worked; the new item appeared. (Creation itself was not the subject of a dedicated checklist pass this session; it
   is recorded here because the browser was used and the result is real.)
3. **Menu rename and price editing — NOT VERIFIED / POTENTIAL PRODUCT GAP.** No visible UI controls were available on
   the owner board to rename an existing menu item or change its price. This session did **not** inspect the backend
   to decide whether the capability exists server-side; that determination is recorded separately in the menu-management
   investigation notes. Do not mark this pass or fail on the basis of a code inspection — it remains not human-verified
   until the expected edit path is actually exercised from the browser.
4. **Image upload — BLOCKED (R2 not enabled).** The pilot has no R2 bucket or `IMAGES` binding, so image upload,
   display and removal (#7) could not be run. This is the same blocked state recorded in Section A.
5. **Extended TOTP lockout / rate-limit test — NOT RUN.** Deliberately skipped to avoid burning the sign-in budget;
   do not run it here.
6. **Password-change session invalidation — NOT RUN.** Out of scope for this session (a credential change, not a menu
   or ordering check); the password-change half of #4 is not exercised here.
7. **Keyboard-only accessibility and screen-reader announcements — NOT RUN.** Not performed this session (#13).

---

## C. MFA key hardening — 2026-11-25 (automated only, no human pass)

`worker/totp.js` no longer derives the MFA key from `ADMIN_SECRET`; a strict 32-byte base64url
`MFA_ENC_KEY` is mandatory, `MFA_ENC_KEY_PREVIOUS` is decrypt-only for rotation, and a missing/malformed key
fails closed with 503. That change is covered by automated unit and HTTP tests (see
`CORNER_CUP_FINAL_LAUNCH_COMPLETION_PLAN.md` §12.2), including an enrolled café whose key is removed and then
restored.

**No human browser pass was run after this change.** The pilot was not restarted and no sign-in was attempted
(the owner's authenticator code was unavailable). Items A1, A2, B8, B10 and B11 were performed on the earlier
build; they are not evidence for the new key path. Treat that path as **code-verified only** until a person
repeats enrollment and sign-in on a deployment with the dedicated key.

## Sign-off

| Item | Result | By | Date |
|---|---|---|---|
| 1–13 above (staging/production acceptance, as written) | **not run** | — | — |
| Section A, local pilot session, flows A1–A10 | **10/10 pass** | human tester (café owner) | 2026-11-24 |
| Section A, sold-out backend rejection | **not human-verified** — automated `409` check only | — | — |
| Section A, image upload/display/removal (#7) | **blocked (R2 not enabled)** | — | — |
| Section B, local pilot acceptance session, browser-verified checks B1–B11 | **11/11 pass** (browser-verified) | human tester (café owner) | 2026-11-24 |
| Section B, recovery-code count decrement (#3) | **not run** — authenticator code used instead | — | — |
| Section B, menu item creation | **PASS** (browser-verified) | human tester (café owner) | 2026-11-24 |
| Section B, menu rename and price editing (#6) | **not human-verified / potential product gap** — no UI controls found; backend not yet inspected for the session's pass/fail record | — | — |
| Section B, image upload/display/removal (#7) | **blocked (R2 not enabled)** — same as Section A | — | — |
| Section B, extended TOTP lockout/rate-limit test | **not run** — avoided to protect sign-in budget | — | — |
| Section B, password-change session invalidation (#4, password half) | **not run** — out of scope for this session | — | — |
| Section B, keyboard-only accessibility and screen-reader announcements (#13) | **not run** | — | — |
| Section C, MFA key hardening (dedicated key, no fallback, rotation) | **automated pass only** — no human browser pass after the change | — | 2026-11-25 |

Anything that fails here is a launch blocker, not a nice-to-have. Record failures in the finding register with
the same evidence discipline used for the code review, and do not proceed to the pilot until each is closed or
explicitly accepted by the owner.
