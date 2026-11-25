# Corner Cup — Stage 3A: Menu Photography Architecture Audit

**Mode: read-only.** No source, schema, test, config, binding or secret was changed. No storage bucket was created. No deployment or publication was performed. Existing dirty and untracked files are preserved. This document stops after the audit and awaits approval before any implementation.

---

## 1. Existing architecture findings

### 1.1 Menu item data model (`worker/db.js`)

`menu_items` table (current):

```sql
CREATE TABLE IF NOT EXISTS menu_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cafe_id INTEGER NOT NULL DEFAULT 1,
  category TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL,
  emoji TEXT NOT NULL DEFAULT '🍽️',
  available INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
)
```

- **No image column exists.** The only visual field is `emoji` (max 8 chars, default 🍽️). `order_items` snapshots `name` and `emoji` at order time, so a future image change does not rewrite past orders — good.
- Multi-tenancy is already enforced: every row carries `cafe_id`, and indexes exist on `(cafe_id, sort)`.
- Schema is migrated via `MIGRATIONS` + `POST_MIGRATIONS` arrays in `worker/db.js`, applied idempotently. New columns must be added the same way (additive `ALTER TABLE … ADD COLUMN`, caught as a no-op when already present).

### 1.2 Public menu API (`worker/api.js` → `getMenu`)

`GET /api/cafes/:slug/menu` returns:

```json
{ "table": {...}, "categories": [ { "name", "items": [ { "id", "name", "description", "priceCents", "emoji", "available" } ] } ] }
```

- No image URL/key is returned today. The frontend has nothing to render even if an image existed.
- Item ids are integers; categories are free-text grouped in JS.

### 1.3 Owner dashboard menu editor (`src/pages/Admin.jsx` → `MenuTab`)

- Lists items grouped by category, showing `menu-emoji small-emoji` + name + price, with an availability toggle and a delete button.
- "Add an item" form: name, category (datalist), price, icon (emoji, maxLength 4), description. No file input, no image preview, no remove-image control.
- Mutations go to `POST/PATCH/DELETE /api/admin/menu[/:id]` with JSON bodies (`BODY_LIMITS.menuItem = 2048`, `adminItem = 1024`).
- `adminUpdateItem` currently accepts **only** `{ available: boolean }` — it cannot update other fields, and there is no image field to set.

### 1.4 Worker routes and authentication (`worker/api.js`)

- All café-scoped routes sit under `/api/cafes/:slug/...`. `handleCafeApi` resolves the café by slug and 404s on unknown slugs (tenant isolation at the edge).
- Admin routes require an owner session: `ownerSession(env, cookie, cafe)` returns `SESSION_OK / SESSION_STORE_DOWN / …`; on failure a 401 with a cleared cookie. `authConfigured(env)` guards the whole admin block.
- Existing admin menu routes:
  - `GET  /api/admin/menu`
  - `POST /api/admin/menu` (create)
  - `PATCH /api/admin/menu/:id` (toggle availability only)
  - `DELETE /api/admin/menu/:id`
  - `POST /api/admin/menu/reseed`
- CSRF: `verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf)` is used by settings save and logout-everywhere, but **not** by the existing menu mutations (toggle/delete rely on the session cookie + SameSite). Image upload/delete should follow the stronger settings pattern.
- Body limits are enforced while streaming in `worker/http.js` (`readText`/`readJson`), with `BodyTooLargeError` → 413. No multipart handling exists; `readJson`/`readText` are the only body readers.

### 1.5 Storage (`wrangler.jsonc`, `package.json`)

- **No R2 binding today.** `wrangler.jsonc` declares only `DB` (D1) and `ASSETS` (static). No `r2_buckets`.
- No storage SDK in `package.json` (no `@aws-sdk/*`, no multer/busboy/formidable). Dependencies are React, Vite, argon2id, qrcode, wrangler.
- The project is deployed through Freebuff Sites (`site.json`), and the platform exposes R2 via `sites_add_storage` (binding name, e.g. `IMAGES`/`FILES`) per environment. That is the intended provisioning path and is free within R2's free tier.
- `corner-cup-transfer/context/PROJECT_CONTEXT.md` already lists "Cloudflare R2 for file storage" as the planned layer, but it was never wired up.

### 1.6 CSP (`worker/http.js`)

```
img-src 'self' data:
```

- Images must be same-origin or `data:`. Any R2 public URL (`*.r2.dev` / custom domain) would require a CSP change; serving images through the Worker keeps `'self'` sufficient and avoids exposing the bucket.

### 1.7 Existing image/asset handling

- QR codes are generated client-side as `data:` URLs (`QRCode.toDataURL`) and downloaded — no server storage.
- Fonts are self-hosted under `/public/fonts`; the favicon is an inline SVG data URL in `index.html`.
- No file upload, no blob handling, no `FormData` usage anywhere in `src/` or `worker/`.

### 1.8 Café ownership / authorization

- Tenant isolation is consistent: `cafe_id` on `menu_items`, `orders`, `tables`; queries always filter by `cafe.id` resolved from the slug.
- Owner identity: password flow (argon2id) or WorkOS managed identity; sessions in `owner_sessions` with `cafe_id`. `ownerSession(env, cookie, cafe)` validates.
- Operator console is separate (cross-café) and gated by `OPERATOR_PASSWORD` + CSRF.

### 1.9 Frontend rendering of menu items (`src/pages/Menu.jsx`)

- Each card renders `.menu-emoji` (52px tile) with the item's emoji. There is no `<img>`. The emoji is the only visual.
- Card structure (from Stage 2): `.menu-card` → `.menu-name`, `.menu-desc`, `.menu-foot` (price + add/stepper). Layout is a single column; adding a photo must not make cards excessively tall.

---

## 2. Recommended storage solution and cost implications

### 2.1 Recommendation: Cloudflare R2, provisioned through the Freebuff Sites platform, served via the Worker

| Option | Verdict |
|---|---|
| **Cloudflare R2 (via `sites_add_storage`, binding e.g. `IMAGES`)** | **Recommended.** S3-compatible, zero egress cost, generous free tier, native Workers binding (`env.IMAGES`), no new dependency. |
| Existing platform storage | Same R2, just provisioned per environment by the platform. No separate service. |
| Static bundled default images (`public/defaults/...`) | **Use for defaults only.** Free, cached by Vite/ASSETS, no DB row needed. Not suitable for owner uploads (would require a rebuild per upload). |
| Cloudflare Images / Image Resizing | Paid. Rejected under the zero-budget constraint. |
| Third-party (S3, Imgix, Cloudinary, Firebase Storage) | Paid or requires new credentials/billing. Rejected. |

### 2.2 Free-tier limits (R2)

- Storage: 10 GB/month free.
- Class A operations (writes/lists): 1,000,000/month free.
- Class B operations (reads): 10,000,000/month free.
- Egress: free (no bandwidth charges).

A café with ~50 items × ~500 KB photos ≈ 25 MB per café; ~400 cafés fit in 10 GB. At 1 read per menu view, 10M reads/month is ample. Uploads are Class A and number in the hundreds. **No paid tier is needed for the expected scale.**

### 2.3 Cost implications

- Zero new monthly cost at expected scale. No new npm dependency (R2 is a Workers binding, accessed as `env.IMAGES`).
- Local development: Wrangler provides a local R2 (Miniflare) automatically, so no account or bucket is needed to develop/test.
- Only cost risk: if a café uploads very large or many images, storage could exceed 10 GB. Mitigated by the size cap (§3) and by cleanup on replace/delete.

### 2.4 Resizing without paid services

- Cloudflare Image Resizing / Cloudflare Images are paid → not available.
- Server-side resizing in a Worker is possible only via WebAssembly (e.g. wasm-vips), which adds bundle size and complexity and is not recommended on the free tier.
- **Recommendation:** accept client-uploaded images up to a cap, validate magic bytes and (best-effort) dimensions on the server, store as-is, and let the browser scale via CSS (`object-fit: cover` in a fixed box). Optionally resize client-side with the Canvas API before upload as a UX optimization, but never trust the client's claim — the server's size cap and magic-byte check are authoritative.
- Default images are bundled at the target display size (e.g. 400×400) so no runtime resizing is needed for them.

---

## 3. Storage investigation — decisions

| Question | Decision |
|---|---|
| Maximum image size | **1 MB** (500 KB preferred target). Reject above 1 MB. |
| Allowed formats | **JPEG, PNG, WebP only.** SVG rejected (no demonstrated safe sanitizer). GIF rejected (animation/abuse). |
| Dimensions / aspect ratio | Display box **square (1:1)**, 400×400 px recommended for defaults; uploads accepted at any dimensions up to 4096×4096, rendered with `object-fit: cover` in a square tile. |
| Resizing | None server-side (free tier). Client may downscale; server enforces size cap + magic bytes. |
| Isolation by café | Object key always includes `cafe_id` (and item id): `cafes/{cafeId}/menu/{itemId}/{uuid}.{ext}`. Key is generated server-side; never accepted from the client. |
| Deleted/replaced cleanup | On replace: delete the previous object (best-effort, logged on failure). On item delete: delete its image. On upload failure mid-flight: delete the just-written object. Orphan sweep is not required at this scale but can be added later. |
| Default image restoration | Removing a custom photo sets `image_key = NULL`, reverting to the bundled default / emoji. The R2 object is deleted. |

---

## 4. Database changes required

One additive migration in `worker/db.js` (`MIGRATIONS` array):

```sql
ALTER TABLE menu_items ADD COLUMN image_key TEXT
ALTER TABLE menu_items ADD COLUMN image_updated_at TEXT
```

- `image_key` NULL = use the bundled default / emoji fallback. Non-null = R2 object key (server-generated, includes cafe id).
- `image_updated_at` (ISO timestamp) is used as a cache-busting query parameter on the image URL, so a replacement is visible without changing the route.
- `order_items` is **not** changed: orders snapshot `name` + `emoji` already; images are a live menu concern, not an order record. (Adding an image snapshot to receipts is out of scope for 3A.)
- `POST_MIGRATIONS` needs no new index for 3A (lookups are by item id, already PK). An index on `(cafe_id, image_key)` is optional and can be deferred.

---

## 5. API and authorization changes required

### 5.1 Public menu (`GET /api/cafes/:slug/menu`)

Add to each item:

```json
{ "id", "name", "description", "priceCents", "emoji", "available", "imageUrl": "/api/cafes/:slug/menu/123/image?v=2026-..." | null }
```

- `imageUrl` is null when `image_key` is null (client then uses the bundled default or emoji).
- URL is same-origin so the existing CSP `img-src 'self'` covers it.

### 5.2 Image serving (`GET /api/cafes/:slug/menu/:itemId/image`)

- Resolve item by `id AND cafe_id` (from slug). 404 if missing or `image_key` is null.
- Fetch the object from `env.IMAGES` by the stored key (never from query/path input). 404 if the object is gone.
- Return the bytes with `Content-Type` from the stored metadata, `Cache-Control: public, max-age=31536000, immutable` (cache busting is via `?v=`), `ETag` from R2's etag.
- `304` handling via `If-None-Match` is optional but cheap.
- No auth required (public menu). The key is never exposed; only the server reads it from D1.

### 5.3 Upload (`POST /api/admin/menu/:id/image`)

- Auth: `ownerSession` must be `SESSION_OK` for this café (same gate as other admin routes), plus `verifyCsrf` (parity with settings save).
- Body: `multipart/form-data` with a single `file` field. Enforce `BODY_LIMITS` (add `image: 1_048_576` — 1 MB) via `Content-Length` pre-check and streamed read; `request.formData()` is available in workerd.
- Validation:
  1. Reject if no file or more than one file.
  2. Size ≤ 1 MB (streamed byte count, not just Content-Length).
  3. Magic bytes must match JPEG (`FF D8 FF`), PNG (`89 50 4E 47 0D 0A 1A 0A`) or WebP (`RIFF....WEBP`). Reject anything else, including SVG and GIF.
  4. Extension/MIME from the client is ignored for the decision; the stored `Content-Type` is derived from the detected format.
  5. Best-effort dimension parse (JPEG/PNG/WebP headers); reject if either dimension > 4096 or < 1.
- Storage:
  1. Verify the item exists and belongs to this café.
  2. Generate key `cafes/{cafe.id}/menu/{id}/{crypto.randomUUID()}.{ext}`.
  3. `await env.IMAGES.put(key, bytes, { httpMetadata: { contentType } })`.
  4. Update `menu_items SET image_key = ?, image_updated_at = ? WHERE id = ? AND cafe_id = ?`.
  5. Best-effort delete the previous `image_key` (if any); log, do not fail the request on delete error.
- Return `{ ok: true, imageUrl }`.

### 5.4 Remove (`DELETE /api/admin/menu/:id/image`)

- Same auth/CSRF gate.
- Set `image_key = NULL, image_updated_at = ?`, then best-effort delete the R2 object. Return `{ ok: true }`.

### 5.5 Create/update item payloads

- `POST /api/admin/menu` and `PATCH` remain JSON. No image in the JSON body (size). Image is a separate resource, which keeps body limits small and avoids base64 bloat.

### 5.6 New routes summary

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/cafes/:slug/menu/:itemId/image` | none | Serve R2 object |
| POST | `/api/admin/menu/:itemId/image` | owner session + CSRF | Upload/replace |
| DELETE | `/api/admin/menu/:itemId/image` | owner session + CSRF | Remove (restore default) |

### 5.7 Cross-cutting

- `BODY_LIMITS` gains `image: 1_048_576`.
- `wrangler.jsonc` gains an `r2_buckets` entry (binding `IMAGES`), provisioned via the platform for both preview and production.
- CSP `img-src 'self' data:` already covers the proxied image route; no change needed unless a public R2 URL is used (not recommended).

---

## 6. Owner dashboard changes

In `src/pages/Admin.jsx` → `MenuTab`:

- Each `.admin-item` row gains a small thumbnail (48×48, rounded) showing the current image or the emoji fallback, plus an "Upload/Replace" file input (hidden, triggered by a button) and a "Remove photo" button (only when an image exists).
- "Add an item" form gains an optional photo picker that uploads after the item is created (two-step: create item → upload image), because the item id is needed for the key. Alternatively, accept the file in the same form and do create-then-upload in sequence.
- Upload uses `FormData` with the file; show a preview before committing; disable during upload; surface validation errors from the server.
- No new page/route; everything stays in the existing Menu tab.

---

## 7. Customer menu changes

In `src/pages/Menu.jsx`:

- Render an image in the medallion slot when `item.imageUrl` is present: replace the emoji glyph with `<img src={item.imageUrl} alt="" loading="lazy" decoding="async" />` inside the existing `.menu-emoji` tile, keeping the same 52px box, border-radius and fallback styling.
- When `imageUrl` is null, fall back to the bundled default image for the item's category, then to the emoji. Default mapping lives in a small client-side map (`category → /defaults/<name>.jpg`), shipped under `public/defaults/`.
- `loading="lazy"` + fixed dimensions to avoid CLS; `object-fit: cover`.
- No change to card height budget: the image occupies the existing medallion footprint; the card structure (name, description, foot) is untouched.
- `OrderStatus`/receipts are unaffected (they use emoji snapshot).

---

## 8. Security risks and mitigations

| Risk | Mitigation |
|---|---|
| Unauthorized upload/replace/remove | Reuse `ownerSession` gate; add `verifyCsrf` for the two mutating routes; item lookup scoped by `cafe_id`. |
| Client-supplied storage key / café id | Server generates the key from `cafe.id` + `item.id` + UUID; café id comes from the slug route, never the body. |
| Path traversal via key or filename | Key is never taken from input; filename is discarded; read route resolves key from D1 by item id. |
| Cross-café access | `WHERE id = ? AND cafe_id = ?` on every read/write; unknown item → 404 (no existence leak). |
| Oversized upload | `Content-Length` pre-check + streamed byte count ≤ 1 MB; 413 on overflow. |
| Unsupported / spoofed type | Magic-byte detection is authoritative; extension/MIME ignored. SVG and GIF rejected. |
| SVG XSS | SVG not allowed at all (no sanitizer demonstrated). If ever needed, requires a separate reviewed sanitizer. |
| Private file exposure | Images are public menu assets by design; served via Worker with long cache. No credentials or private data in R2. Bucket is not public; reads are proxied. |
| Orphaned objects | Best-effort delete on replace/remove/item-delete; log failures. A periodic sweep can be added later. |
| Cache staleness after replace | `?v=image_updated_at` in the URL + immutable cache headers → new version fetches fresh. |
| CSP | No change needed (`img-src 'self'`). |
| DoS via many uploads | Rate limiting already exists for API routes (`checkApiRateLimit`); image route inherits it. Size cap limits per-request cost. |

---

## 9. Implementation sequence

1. **Provision storage** (platform): `sites_add_storage` R2 binding `IMAGES` for preview and production. Add the binding to `wrangler.jsonc` (local dev gets R2 automatically).
2. **Migration**: add `image_key`, `image_updated_at` to `menu_items` via `MIGRATIONS`.
3. **Worker read path**: update `getMenu`/`adminMenu` SELECT + mapping; add image serving route.
4. **Worker write path**: add upload + remove routes with validation, storage, cleanup, and CSRF.
5. **Defaults**: add `public/defaults/*.jpg` set + client category→default map + emoji fallback.
6. **Admin UI**: thumbnail, upload/replace/remove in `MenuTab`.
7. **Customer UI**: image in medallion slot in `Menu.jsx`.
8. **Tests**: magic-byte validation, size limit, auth/CSRF, cross-café isolation, path traversal, cleanup, cache-busting URL.
9. **Verification**: local wrangler dev with R2, two cafés, upload/replace/remove, public menu render, CSP check.

---

## 10. Files likely to change

| File | Change |
|---|---|
| `worker/db.js` | Migration adding `image_key`, `image_updated_at` to `menu_items` |
| `worker/api.js` | `getMenu`, `adminMenu`, `adminCreateItem` mapping; new image serve/upload/remove handlers; route registration; `BODY_LIMITS.image` |
| `worker/http.js` | `BODY_LIMITS.image` |
| `wrangler.jsonc` | `r2_buckets` binding `IMAGES` |
| `src/pages/Admin.jsx` | `MenuTab`: thumbnail, upload/replace/remove controls |
| `src/pages/Menu.jsx` | Render image in medallion slot; default map |
| `src/styles.css` | `.menu-emoji img` sizing (`object-fit: cover`) |
| `public/defaults/*` | Bundled default food images (new) |
| `tests/*` | New image validation/auth/cleanup tests |

No change to `order_items`, order flow, payment, or tracking.

---

**Stop. Awaiting approval before implementation.**