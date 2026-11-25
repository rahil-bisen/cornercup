# Stage 3B — Menu Photography: Implementation Report

**Status:** implemented and verified locally. Nothing was deployed, published, or run against
production or staging. Stopping here for review.

**Scope shipped:** category-default photographs, owner uploads that override them, removal that
restores the default immediately, emoji as the final fallback, unchanged card geometry.

---

## 1. Files changed

| File | Change |
| --- | --- |
| `worker/db.js` | Two additive `ALTER TABLE menu_items ADD COLUMN` statements appended to `MIGRATIONS` (`image_key TEXT`, `image_updated_at TEXT`). No other schema touched; `order_items` is untouched. |
| `worker/api.js` | Image helpers (`detectImageFormat`, `imageContentType`, `imageExtension`, `imageDimensions`, `validateImageBytes`, `readImageBytes`, `itemImageUrl`); handlers `getMenuImage`, `adminUploadImage`, `adminRemoveImage`; `getMenu` and `adminMenu` now return `imageUrl` + `hasCustomImage`; `adminDeleteItem` best-effort deletes the item's object; routes registered in `handleCafeApi`. |
| `worker/http.js` | Unchanged. The JSON `BODY_LIMITS` table is deliberately left alone (see §4). |
| `src/lib/menuImages.js` | **New.** The guest photograph ladder as a pure, testable helper: `defaultImageFor(category)`, `resolveItemImage(item, category, broken)`, `FALLBACK_IMAGE`. |
| `src/pages/Menu.jsx` | Medallion renders the resolved photograph inside the existing 52 px tile, with `alt={item.name}`, `loading="lazy"`, `decoding="async"` and an `onError` that marks the source broken so the next step of the ladder is drawn. |
| `src/pages/Admin.jsx` | Menu tab photo control: pick → preview → Save / Cancel, Replace, Remove, and a per-row "Custom photo" / "Default photo" / "Preview (not saved)" label plus uploading/saving states. The CSRF token is now passed down and sent with both mutations. |
| `src/lib/api.js` | One change: do not force `content-type: application/json` when the body is `FormData`, so the browser's multipart boundary survives. |
| `src/styles.css` | `.menu-emoji img { width/height 100%; object-fit: cover; display: block }`. The 52 px medallion rule is unchanged. |
| `public/defaults/*.jpg` | Six bundled default photographs: `coffee.jpg`, `cold-drink.jpg`, `snack.jpg`, `main.jpg`, `dessert.jpg`, `dish.jpg`. |
| `tests/harness/worker.mjs` | In-memory R2-compatible `IMAGES` binding (singleton per harness process), plus header-driven fault injection (`x-harness-fail-image-put/get/delete`, `x-harness-fail-menu-d1-read/write`, `x-harness-no-image`). |
| `tests/migrations.test.mjs` | New Stage 3B migration test. |
| `tests/menu.images.test.mjs` | **New.** Ladder unit tests plus twelve HTTP tests against the real handlers. |
| `tests/public.exposure.test.mjs` | Item-shape expectation extended with `imageUrl` and `hasCustomImage`. |

No payment, authentication, order-flow or session logic was changed.

---

## 2. Database migration

```sql
ALTER TABLE menu_items ADD COLUMN image_key TEXT;
ALTER TABLE menu_items ADD COLUMN image_updated_at TEXT;
```

- **Additive and nullable.** Every existing menu row keeps working with `NULL`, which the API reads as
  "no owner photo — use the category default, then the emoji". Nothing is backfilled.
- **Not in the base schema.** As with the reset-password columns, the columns exist only in
  `MIGRATIONS`, so a fresh database and a legacy one arrive at the same shape through the same
  statements.
- **Idempotent.** A re-run meets `duplicate column name`, which the existing `migrate()` /
  `isDuplicateAddColumn()` machinery scrubs as its own no-op; any other error is still thrown.
- **`order_items` untouched.** An order keeps the name, emoji and price it was sold with; the test
  asserts its column list is byte-identical before and after migrating a legacy database.
- **No production or staging migration was run.** The harness and any local `wrangler dev` use their
  own local D1 only.

Migration tests added (`tests/migrations.test.mjs`):
- fresh database: columns created, a new row stores `NULL`/`NULL`;
- legacy database: an existing item (name, emoji, price) survives, gains `NULL` photo columns, and
  `order_items` is unchanged;
- the column behaves as a key — set, matched against `cafes/<id>/menu/<id>/…`, then cleared to restore
  the default;
- second migration run is a no-op and changes no row.

---

## 3. Storage binding

- The Worker expects an **R2-compatible binding named `IMAGES`** exposing `put(key, bytes, { httpMetadata })`,
  `get(key)`, `delete(key)`.
- **No real bucket was created and Cloudflare configuration was not touched.** `wrangler.jsonc` still has
  no `r2_buckets` entry, so on a local `wrangler dev` the upload/remove routes answer
  `503 "Image storage is not configured."` and the public image route answers 503 for a stored key.
  Display of the bundled defaults is unaffected. This is the expected state until provisioning is
  approved (§9).
- **Local tests use an isolated fake.** `tests/harness/worker.mjs` injects an in-memory store for every
  `/api/*` request, so upload, replacement, deletion and every failure branch run the production code
  against real D1 and an object store that never leaves the process.
- Keys are generated server-side and namespaced:
  `cafes/<cafe_id>/menu/<item_id>/<crypto.randomUUID()>.<jpg|png|webp>`. The café id and the item id
  are always taken from the resolved café and the D1 row, never from client input.

---

## 4. API

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /api/cafes/:slug/menu/:itemId/image` | public | Serve the stored object |
| `POST /api/cafes/:slug/admin/menu/:itemId/image` | owner session + CSRF | Upload or replace |
| `DELETE /api/cafes/:slug/admin/menu/:itemId/image` | owner session + CSRF | Remove, restoring the default |

Public and admin menu payloads gained `imageUrl` (versioned, `null` when there is no upload) and
`hasCustomImage`. The guest item shape is now exactly
`available, description, emoji, hasCustomImage, id, imageUrl, name, priceCents`.

**Note on route order (bug found and fixed during testing):** the generic
`POST /api/admin/menu` (create item) and `DELETE /api/admin/menu/:id` (delete item) matchers were
registered before the photo routes, so an upload was being parsed as JSON item creation (400) and an
image delete would have removed the item. The narrower `…/menu/:id/image` routes now match first, and
the new tests cover both verbs.

### Security controls

- **Keys resolved from D1 only.** The client never sends a key; every read and write looks up
  `image_key` by `id AND cafe_id` from the resolved café.
- **Ownership on every mutation.** The image routes live behind the existing `ownerSession()` gate, so a
  token minted for café A is rejected by café B even if it is presented under B's cookie name (test
  asserts 401). Naming another café's item id under your own slug resolves to 404.
- **CSRF.** Upload and delete use `verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf)` — the
  same Origin check + per-session token binding the settings save uses. Missing token, unknown token and
  foreign `Origin` are all 403 (each asserted).
- **Signature validation.** JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`) and WebP
  (`RIFF….WEBP`) magic bytes decide the type. SVG, text and anything unrecognised → 415; a recognised
  signature whose header cannot be parsed → 400.
- **Limits.** ≤ 1 MB (`1 048 576` bytes, enforced while reading and again on the buffer), ≤ 4096 px per
  side and ≤ 16 MP, read from the PNG IHDR, the JPEG SOF0/1/2 marker or the WebP VP8/VP8L/VP8X header.
  Violations → 413. The multipart body carries no `BODY_LIMITS` entry; the JSON limits are unchanged.
- **Response headers.** Stored `Content-Type` (derived from the bytes at upload time, not from the
  browser-supplied file type), `X-Content-Type-Options: nosniff`, and
  `Cache-Control: public, max-age=31536000, immutable`. The route is same-origin, so the existing
  `img-src 'self' data:` CSP still holds.
- **No leakage.** Responses contain no bucket name, account id or credential; failures are logged with
  café id, item id, object key and error message only — never image bytes. Tests scan the upload response
  and the admin row for bucket/credential markers.

---

## 5. Replacement and deletion consistency

Upload is ordered **object first, reference second, delete last**:

1. `IMAGES.put(newKey, bytes, { httpMetadata })`. A failure here returns **502** and D1 is untouched — the
   previous photo keeps serving (asserted).
2. `UPDATE menu_items SET image_key = ?, image_updated_at = ? WHERE id = ? AND cafe_id = ?`. A failure (or
   a zero-row update) deletes the just-written object best-effort and returns **502**; the old key is
   still the one D1 names, so the old bytes are still served (asserted, then the same replacement
   succeeds on retry).
3. Only after that commit is the previous object deleted, best-effort.

Removal commits `image_key = NULL` first, so the default is live immediately, and then deletes the
object best-effort.

**Orphan handling (documented, retryable):**
- An object whose key was never committed (step 1 succeeded, step 2 failed) is deleted inline; if that
  delete also fails, the object is an orphan and the request still reports the 502.
- An object superseded by a replacement or a removal whose delete failed is an orphan.
- Either way the request already succeeded or already reported its failure, so nothing user-visible is
  lost, and the operation is safe to repeat. Because every key is
  `cafes/<id>/menu/<itemId>/<uuid>.<ext>`, an operator sweep can list the bucket and delete objects whose
  key is absent from `menu_items.image_key`. No background sweeper or cron exists yet; that is the
  intended cleanup path.

---

## 6. Customer menu

Ladder per item, implemented in `src/lib/menuImages.js`:

1. the owner's upload (`item.imageUrl`, already versioned by `image_updated_at`);
2. the category default — Chai & Coffee → `coffee.jpg`, Cold Drinks → `cold-drink.jpg`, Snacks →
   `snack.jpg`, Mains → `main.jpg`, Desserts → `dessert.jpg`, any other category → `dish.jpg`;
3. the item's emoji.

A source that fails to load is recorded once in a `brokenImages` set, so the next render falls through
to the default and then to the emoji; nothing loops back to a failing URL. The photograph renders
inside the existing `.menu-emoji` tile unchanged (52 × 52 px, 14 px radius, `overflow: hidden`) with
`object-fit: cover`, so the card layout and visual identity are untouched. The `alt` text is the item
name, and the tile drops `aria-hidden` when a photograph is drawn so that alt text is actually exposed;
the emoji tile keeps `aria-hidden` because an emoji is decoration.

---

## 7. Owner dashboard

In the Menu tab, each row now has:

- **Upload / Replace** file picker (`accept="image/jpeg,image/png,image/webp"`).
- **Preview before saving:** the medallion shows the object URL of the chosen file and the row says
  "Preview (not saved)", with **Save photo** and **Cancel**. Cancel revokes the object URL.
- **Custom vs default:** "Custom photo" or "Default photo" under the price, plus the actual thumbnail.
- **Remove photo** (only when a custom photo exists, with a confirmation that the category default
  returns).
- **Feedback:** "Uploading…" / "Saving…" while the request is in flight, and the API's own message in the
  alert line on failure (413, 415, 403, 502 all surface as text).

Both mutations send `x-csrf-token`; the tab is only reachable behind the café's own session, so an owner
signed into one café cannot see or act on another café's items.

---

## 8. Test results

### Targeted

```
node --import ./tests/setup/register.mjs --test --test-concurrency=1 \
  tests/migrations.test.mjs tests/menu.images.test.mjs

✔ photograph ladder: category default, custom override, then the emoji
✔ a seeded item has no photograph and no image route until one is uploaded
✔ upload stores the file, serves it with a safe content type and reports it everywhere
✔ JPEG and WebP uploads are accepted; the served type follows the bytes
✔ replacing a photo versions the URL and leaves only the new object readable
✔ removing a photo restores the default immediately
✔ invalid uploads are refused and change nothing
✔ image mutations require the owner session, a matching Origin and a live CSRF token
✔ one café cannot read or change another café's menu photo
✔ a failed storage upload leaves the previous photo in place
✔ a failed database update keeps the previous photo and cleans up the new object
✔ the image route degrades honestly when storage is not configured
✔ Stage 3B: menu photography columns are nullable, additive and re-runnable
(+ the four pre-existing migration tests)
```

Coverage against the required list: default selection by category and emoji fallback (unit), upload and
replacement, removal/default restoration, invalid signatures (SVG, text, truncated header), oversized
file, excessive dimensions, cross-café authorization (session and item id), missing/invalid CSRF and
foreign Origin, failed R2 upload, failed D1 update, old-image preservation, cache versioning
(`?v=` changes on replacement; `immutable` on the versioned URL) and broken-image fallback (unit +
`onError` wiring).

### Full suite

```
npm test    → tests 462, pass 462, fail 0, skipped 0   (~100 s)
```

(449 before this stage; +13 net after adding the photography tests.)

### Production build

```
npm run build → vite build, 105 modules transformed, built in 1.93 s, exit 0
```

---

## 9. Security findings

| Finding | Severity | Status |
| --- | --- | --- |
| Photo upload/delete routes were shadowed by the generic menu POST/DELETE matchers, so uploads failed 400 and an image DELETE would have deleted the whole menu item | High (correctness + data loss) | **Fixed** — narrower routes matched first; both verbs covered by tests |
| The admin UI's `call()` did not attach a CSRF token, so upload/remove would always have been refused once CSRF was enforced | High (feature dead on arrival) | **Fixed** — token passed into `MenuTab` and sent on both mutations |
| Declared upload `Content-Type` is attacker-controlled | Low | Mitigated — type comes from magic bytes; served with `nosniff`; extension derived server-side |
| Unbounded multipart body before validation | Medium | Mitigated — `Content-Length` pre-check plus a size check while reading and again on the buffer; over-limit → 413 before any storage write |
| Cross-tenant guessing of item ids | — | Blocked — every query is `id AND cafe_id`; cross-café session reuse and cross-café item ids both asserted |
| Bucket/credential disclosure | — | None — no key, bucket name or credential in responses or logs; only café/item id and object key appear in error logs |

Residual: image bytes are structurally validated (signature + dimensions), not fully pixel-decoded.
workerd has no image decoder without Cloudflare Images/Image Resizing, which is a paid service and out
of scope. The object is served back with the type its own bytes declare and `nosniff`, so a payload that
somehow satisfied the header checks still cannot execute as HTML or script.

---

## 10. Unresolved external provisioning (required before any deployment)

1. **A real R2 binding.** Either provision storage through the Sites tooling (`sites_add_storage`, kind
   `r2`, name `IMAGES`) or create the bucket and add an `r2_buckets` entry to `wrangler.jsonc`:
   `{ "binding": "IMAGES", "bucket_name": "<bucket>" }`. Not done: this stage forbids Cloudflare binding
   changes. Until then the upload/remove routes are 503 and the image GET is 503 for stored keys.
2. **A deploy-time check that the binding is attached** — a smoke upload/read/remove against the deployed
   environment, since a missing binding is only visible at request time.
3. **An orphan sweep (optional, operational).** No scheduled job exists; cleanup of objects whose key is
   no longer referenced relies on the documented listing comparison.
4. **Default photography is bundled, not served from storage.** The six JPEGs total ~460 KB and ship in
   the Vite build; replacing them with café-specific art later would be a data change, not a code change.

---

## 11. Boundaries respected

- Local implementation only; no real bucket created; no Cloudflare binding, variable or secret changed.
- No production or staging database access, and no migration applied outside local D1.
- No deployment, no publication, no hosting change.
- No payment, authentication or order-flow behaviour changed (CSRF was added only to the new routes, and
  the admin UI now sends a token that already existed).
- Dirty and untracked worktree files were preserved; nothing was staged, committed, reset, cleaned or
  discarded.
- No paid service or new dependency was introduced (the fake R2 is ~80 lines inside the test harness).
