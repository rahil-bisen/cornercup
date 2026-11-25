# Stage 3G — Safe Image Decoding Feasibility Audit

**Decision: NO-GO** for adding decode-and-re-encode to the Corner Cup upload Worker on Workers Free.
Both candidates are licence-compatible and bundleable, and SIP does produce fresh, metadata-free JPEGs —
but on Workers Free's **10 ms CPU** budget even the smallest realistic transcode measured **16 ms of wall
time**, and normal 1 MB photos measured **138–654 ms** in local `workerd`. WebP at the current 16 MP cap
also risks the **128 MB** memory limit (Node peak RSS +167 MB for one 16 MP WebP).

Nothing in the project was modified. All numbers come from an isolated PoC at
`%TEMP%\stage3g-poc` (Windows temp, outside the repository), run 2026-11-20.

---

## 1. Candidate comparison

| | `@standardagents/sip` 1.0.1 | `imagescript` 3.20.5 |
| --- | --- | --- |
| Licence | MIT (package); bundled wasm also contains libjpeg-turbo (IJG/BSD-3) and libspng (BSD-2) — no `THIRD_PARTY_NOTICES` in the package | Dual **AGPL-3.0-or-later OR MIT**; MIT is available and fine commercially, but the AGPL option is unusual for a dependency |
| Published | 1.0.1 on **2026-04-08** (54 versions since 2025-12-31); no release in ~7 months | 3.20.5 on **2026-11-19**, plus v4.0.0-rc.6 on 2026-11-20 — very active |
| Runtime deps | `@jsquash/webp@1.5.0`, `@jsquash/avif@2.1.1`, `wasm-feature-detect@1.10.1` (Apache-2.0) | **None** |
| Known vulns | `npm audit --omit=dev` → **0 vulnerabilities** | same audit run: 0 |
| Workers story | Ships a `workerd` export condition (`dist/workerd.js`) that imports `dist/sip.wasm`; works with Corner Cup's existing `{"type":"CompiledWasm","globs":["**/*.wasm"]}` rule | Pure TypeScript, no wasm — runs anywhere, but pays full JS decode cost |
| Input formats | JPEG (libjpeg-turbo, scanline + DCT scaling), PNG (libspng, scanline), WebP / AVIF via `@jsquash` (**full-frame decode**) | JPEG, PNG, GIF, TIFF, and (decode only) WebP |
| Output | **Always JPEG**, transparency discarded | JPEG, PNG, WebP encode |
| Bundle cost | 559 KB `sip.wasm` + 138 KB `webp_dec.wasm` + 1.17 MB `avif_dec.wasm` ≈ **1.87 MB of wasm** (AVIF is a dynamic import and stays in the bundle) | ~2.5 MB of JS/TS output, no wasm |
| Error surface | libspng and libwebp reject truncated input; **libjpeg-turbo does not** (see §3) | throws on truncated input in the cases tested, but silently upscales and is 2–3× slower than SIP |

Both fit Corner Cup's existing Vite/Worker setup without any paid service. SIP needs **no** config beyond
the wasm rule the project already has; ImageScript needs nothing at all.

### The WebP caveat is worse than documented

The docs say WebP "decodes the whole image into memory first". They do not say that **WebP does not work
in workerd out of the box**. `@jsquash/webp`'s Emscripten glue resolves `webp_dec.wasm` relative to
`import.meta.url` and calls `fetch()`; in a Worker that path does not exist, so the first WebP upload dies
with:

```
Aborted(both async and sync fetching of the wasm failed)
```

SIP has an undocumented escape hatch: set `globalThis.__SIP_CODEC_WASM__ = { webp: <CompiledWasm import> }`
before the first decode. With that one line the PoC processed WebP correctly in workerd. Without it, **one
of the three formats the product accepts would fail 100% of the time** — a trap worth recording even though
the recommendation is NO-GO.

---

## 2. Security assessment (measured, not assumed)

Existing Corner Cup validation was read, not changed: `worker/api.js` checks the magic bytes, parses
dimensions from the **header** (PNG IHDR, JPEG SOF scan, WebP VP8/VP8L/VP8X), enforces 1 MB / 4096 px /
16 MP, and serves the stored bytes with the sniffed content type and `x-content-type-options: nosniff`.
That is header inspection, exactly as Stage 3G states — it is not decoding.

| Property | SIP | Evidence |
| --- | --- | --- |
| Rejects truncated PNG | ✅ | 50%-truncated and IHDR-only PNG → `Failed to start PNG decompression` in 0.3–5 ms |
| Rejects truncated WebP | ✅ | 50%-truncated and 40-byte WebP → `Decoding error` |
| Rejects garbage | ✅ | random bytes, `FF D8 FF E0` + random → `Unsupported image format` |
| **Rejects truncated JPEG** | ❌ **No** | A JPEG cut at 50% (413 KB of 826 KB) **transcoded successfully** to a valid 800×800 JPEG. Cutting to the first 600 bytes also produced a valid 10.7 KB JPEG. libjpeg-turbo treats the missing entropy data as damage and fills it, so the caller receives a "valid" file. |
| What the truncated JPEG actually contains | — | Decoded the PoC output: mean luminance of the top / middle / bottom thirds = **127.4 / 127.7 / 128.0** — a uniform grey image. A half-uploaded photo would be stored and served as a plausible-looking blank. |
| Forged dimensions | ✅ | A 195-byte PNG whose IHDR was rewritten to 40000×40000 (CRC fixed) failed in 0.4 ms with `Failed to read PNG row`; no 6.4 GB allocation. SIP trusts the header for `inspect()`, so a dimension check must still run *before* `transform()`. |
| Decompression bomb | ✅ memory, ❌ CPU | 4096×4096 solid PNG = **2.2 KB** on the wire; decoded successfully, `peakPipelineBytes` 4.6 KB (the scanline path works as advertised) but **279 ms** of CPU. Memory is bounded, time is not. |
| Strips EXIF/GPS | ✅ | Spliced an APP1 Exif segment containing `GPSLatitude=28.6139;GPSLongitude=77.2090` into a 2048×2048 JPEG; the 800×800 output contains no `Exif` and no `GPS` string. Output is re-encoded from scanlines, never copied. |
| Fresh output bytes | ✅ | Output is always a new JPEG; original bytes (and thumbnails, ICC, XMP) never survive. |
| Robustness | ⚠️ | Failed PNG decodes also reject an internal promise that nobody awaits — Node printed 4 `UNHANDLED` rejections for 4 failures. In Workers this means log noise (and, on a strict runtime, an aborted isolate) for every rejected upload. |

**Consequence.** Decoding genuinely closes the "malformed bytes stored as a valid image" gap for PNG and
WebP, and closes metadata leaks for all three. It does **not** close it for JPEG, where truncation is
silently repaired. Any implementation must therefore treat "the decoder returned an image" as necessary but
not sufficient: re-check the output's dimensions and marker structure, and — if truncation matters — reject
inputs whose libjpeg warnings are non-empty (SIP does not currently surface them, which is a gap).

---

## 3. Performance feasibility

Environment: Node v26.13.1 (same V8 family as workerd) and `wrangler dev` 4.158.0 / workerd locally on the
same Windows machine, synthetic fixtures (noise + gradients) encoded to the stated sizes, target
"≤1600 px, quality 82" — the plausible menu-photo output.

### Node, `transform()` + `collect()` (wall time, RSS delta via `--expose-gc`)

| Input | Bytes on wire | Time | RSS delta | SIP peak pipeline bytes |
| --- | --- | --- | --- | --- |
| 1024² JPEG | 193 KB | **116 ms** | +7.5 MB | 0.2 MB |
| 1024² PNG | 415 KB | **121 ms** | +2.7 MB | 0.4 MB |
| 1024² WebP | 192 KB | **227 ms** | +13.9 MB | 0.2 MB |
| 2048² JPEG (~1 MB class) | 807 KB | **447 ms** | +10.6 MB | 0.8 MB |
| 2048² PNG | 1.99 MB | **456 ms** | +7.7 MB | 2.0 MB |
| 2048² WebP | 845 KB | **894 ms** | **+66.6 MB** | 0.8 MB |
| 4096² JPEG (≈16 MP) | 2.99 MB | **596 ms** | +28.0 MB | 3.0 MB |
| 4096² PNG (≈16 MP) | 9.66 MB | **1127 ms** | +27.9 MB | 9.7 MB |
| 4096² WebP (≈16 MP) | 3.46 MB | **2612 ms** | **+166.6 MB** | 3.5 MB |

### The three "1 MB" cases, measured exactly

| Input (encoded to ≈1 MB) | Bytes on wire | Time | RSS delta | SIP peak pipeline bytes |
| --- | --- | --- | --- | --- |
| 1800² JPEG | 0.77 MB | **389 ms** | +21.3 MB | 0.8 MB |
| 1500² PNG | **1.00 MB** | **273 ms** | +6.9 MB | 1.0 MB |
| 2350² WebP | 0.99 MB | **1135 ms** | **+73.8 MB** | 1.0 MB |

Decode only (no resize/encode), Node: 1024² JPEG **33 ms**, PNG **52 ms**, WebP **145 ms**; 2048² JPEG
**73 ms**; 4096² JPEG **272 ms**; 4096² WebP **1964 ms**. Encoding is roughly half the cost, so there is no
"decode but skip encode" shortcut that reaches 10 ms either.

### Local workerd (`wrangler dev`, 127.0.0.1), wall time inside the Worker

| Request | Time |
| --- | --- |
| 1024² JPEG → ≤1600 | **219 ms** |
| 1024² PNG → ≤1600 | **138 ms** |
| 1024² WebP → ≤1600 (codec preloaded) | **344 ms** |
| 2048² WebP → ≤1600 | **954 ms** |
| 4096² WebP → ≤1600 | **2870 ms** |
| 4096² JPEG → ≤256 | **94 ms** |
| 4096² JPEG → ≤1024 | **208 ms** |
| 4096² JPEG → ≤1600 | **654 ms** |
| 1024² JPEG → ≤256 | **16 ms** (DCT 1/8 scaling) |
| 50%-truncated JPEG | **489 ms**, then stored as grey |

### Verdict on the 10 ms budget

* Best case measured anywhere: **16 ms wall** for a 193 KB 1024² JPEG scaled to 256 px. Wall time includes
  response overhead, but the wasm work dominates; CPU is the large majority of it.
* Every realistic path is **100 ms – 2.9 s**, i.e. **10–290×** the Free-plan CPU allowance.
* Reducing the output size does not save the input scan: 4096² JPEG → 256 px still costs 94 ms.
* Related costs outside the request: ~1.87 MB of wasm must be compiled at isolate start-up (1 s limit, and
  the compile competes with the first request).
* Free-plan cron triggers have the same 10 ms CPU limit, and `ctx.waitUntil()` does not extend CPU time, so
  "hand it off inside the same Worker" does not help. Queues, Durable Objects and Image Resizing are paid
  features.

**10 ms CPU is not achievable for photos of this size, and the miss is not marginal.** Local numbers cannot
prove production CPU compliance in either direction, but they are conclusive for a NO-GO: no measurement
came within an order of magnitude of the budget.

### Memory

* JPEG and PNG are genuinely streamed: peak pipeline buffers stayed at 0.2–9.7 MB for inputs up to 16 MP.
  Memory is **not** the blocker for those two formats.
* WebP (and AVIF) take SIP's `SimpleDecoder`: full-frame decode, then `Uint8Array(width*height*3)` copy
  inside SIP on top of the decoder's RGBA buffer. At 16 MP that is ~67 MB + ~50 MB before wasm heap, and
  Node peak RSS grew by **167 MB** — over the 128 MB isolate limit on its own. At the current 4096 px /
  16 MP cap, **a single WebP upload can OOM the isolate (error 1102)**.

---

## 4. Workers Free compatibility summary

| Constraint | SIP | ImageScript |
| --- | --- | --- |
| Bundles into existing Vite/Worker build | ✅ with the existing `CompiledWasm` rule | ✅ |
| WebP works unmodified | ❌ needs `__SIP_CODEC_WASM__` preload | ✅ |
| 128 MB memory | ✅ JPEG/PNG; ❌ WebP near 16 MP | ⚠️ one full RGBA bitmap (67 MB at 16 MP) plus JS overhead — tight but plausible |
| 10 ms CPU | ❌ 16–2900 ms measured | ❌ 300 ms – 2.8 s measured |
| Output type | JPEG only (stored type/extension changes to `image/jpeg` / `.jpg`, alpha dropped) | any |
| Cost | $0 | $0 |

---

## 5. Architecture options

**A. Decode and re-encode inside the Worker.** Rejected on CPU (and on WebP memory). Would fail on
Workers Free for any real photo.

**B. Browser-side conversion plus mandatory server validation.** The browser already decodes at native
speed for free and can produce a small, canonical JPEG. But the brief is right that this cannot be the
security boundary: the client decides the bytes, and the server still cannot verify them without decoding.
Today's header checks (magic bytes, IHDR/SOF/VP8 dims, size caps) catch accidental garbage and oversized
header claims, not malformed entropy data. Acceptable only as a UX step, not a trust boundary.

**C. Off-request-path processing (recommended, if pixel verification becomes a requirement).** Keep the
upload path exactly as it is (signature check, 1 MB / 4096 px / 16 MP, owner session + CSRF untouched) and
move real decoding to a free runner outside the Worker's CPU budget — e.g. a GitHub Actions job with
`sharp` (native libvips, milliseconds per photo) triggered after commit, reading and writing R2 through its
S3-compatible API, with the Worker refusing to serve a photo until the job marks it verified. Zero
subscription cost; costs are latency (seconds), an extra CI credential, and an external dependency. Not
provisioned here — R2/secret changes are out of scope for this audit.

**Recommendation.** Do **not** implement A. If Stage 3G's threat model (guests rendering owner-uploaded
bytes) needs pixel-level assurance, implement C; this audit should be re-run with real production CPU
figures only after a paid plan or C exists. Until then, keep the current header validation, and add the two
cheap hardening measures that do not need a decoder: reject JPEGs whose EOI marker is missing (a streaming
scan for `FF D9`, which would have caught the grey-image case) and enforce a pixel-budget re-check on the
decoded output of any future pipeline.

---

## 6. Known limitations of this audit

* Local `wrangler dev` does **not** report per-request CPU time and does not enforce the 128 MB isolate
  limit, so memory conclusions rest on Node RSS plus SIP's documented full-frame WebP path, not on a
  production `1102`. The CPU conclusion does not depend on that gap: even wall time is 10–290× over budget.
* Measurements are single-shot on synthetic fixtures (noise/gradient), not a benchmark suite; a 1 MB
  real-world photo of a café dish will have different entropy and may differ by tens of percent.
* WebP fixtures were produced by `@jsquash/webp` itself; real-world WebP from phones/iOS may include alpha,
  EXIF or animation chunks that were not exercised.
* AVIF was inspected in the bundle only; no AVIF fixture was decoded, and Corner Cup does not accept AVIF.
* "Truncated JPEG accepted" was reproduced in Node and in workerd via the same code path, but only with a
  progressive-free baseload JPEG; progressive and CMYK JPEGs were not tested.
* The PoC lives outside the tree at `%TEMP%\stage3g-poc` (`bench.mjs`, `bench2.mjs`, `bench3.mjs`,
  `worker.js`, `wrangler.jsonc`, `fixtures/`); the local `wrangler dev` server was stopped afterwards.
* No production or staging access, no deploy/commit/push, no R2 provisioning, no binding, secret,
  dependency, migration or source change.

---

## 7. Decision

**NO-GO** for SIP or ImageScript as an in-Worker decode/re-encode step on Cloudflare Workers Free.

Both pass the licence, dependency and bundling tests, and SIP is the better candidate by a wide margin
(scanline JPEG/PNG, real metadata stripping, robust rejection of truncated PNG/WebP and forged dimensions).
They fail the **10 ms CPU** constraint on every realistic path — 16 ms in the single best case, 270 ms for a
1 MB PNG, 400 ms for a 1 MB JPEG, 1.1 s for a 1 MB WebP, up to 2.9 s at 16 MP WebP — WebP additionally
risks the **128 MB** limit at the current 16 MP cap, and SIP silently accepts truncated JPEGs — so even where
it runs, its output cannot be trusted without extra checks.

The revised, zero-budget recommendation is **C**: keep today's header validation in the Worker, and if
pixel-level verification is required, run the decode in a free out-of-band runner rather than in the request
path.
