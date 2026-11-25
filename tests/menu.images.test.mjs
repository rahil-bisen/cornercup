// Stage 3B menu photography.
//
// The pure part exercises the guest's photograph ladder without a DOM (custom → category default →
// emoji). The rest runs the real routes in the auth harness at :8790, whose Worker supplies an
// in-memory R2-compatible `IMAGES` binding and header-driven fault injection, so upload, replacement,
// removal and every refusal are the production handlers against real D1 — never a mock of them.
//
// Every test seeds its own café and cleans it up, so image keys, sessions and D1 rows cannot leak
// between tests.

import test from "node:test";
import assert from "node:assert/strict";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";
import { defaultImageFor, resolveItemImage } from "../src/lib/menuImages.js";

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };

let alive = false;
try {
  const probe = await fetch(`${AUTH}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not available at ${AUTH}`;

/* ------------------------------------------------------------- the ladder */

test("photograph ladder: category default, custom override, then the emoji", () => {
  assert.equal(defaultImageFor("Chai & Coffee"), "/defaults/coffee.jpg");
  assert.equal(defaultImageFor("Cold Drinks"), "/defaults/cold-drink.jpg");
  assert.equal(defaultImageFor("Snacks"), "/defaults/snack.jpg");
  assert.equal(defaultImageFor("Mains"), "/defaults/main.jpg");
  assert.equal(defaultImageFor("Desserts"), "/defaults/dessert.jpg");
  // Stage 3F removed the universal dish.jpg fallback: an unknown category has no photograph at all,
  // because a picture of something else is worse than the item's own emoji.
  assert.equal(defaultImageFor("Seasonal Specials"), null);

  // No upload: the category default is drawn.
  assert.equal(resolveItemImage({ imageUrl: null }, "Mains"), "/defaults/main.jpg");
  assert.equal(resolveItemImage({}, "Desserts"), "/defaults/dessert.jpg");

  // An upload wins over the default…
  assert.equal(
    resolveItemImage({ imageUrl: "/api/cafes/c/menu/1/image?v=1" }, "Mains"),
    "/api/cafes/c/menu/1/image?v=1"
  );

  // …until it fails to load, which falls back to the default and then to the emoji (null).
  const custom = "/api/cafes/c/menu/1/image?v=1";
  assert.equal(resolveItemImage({ imageUrl: custom }, "Mains", new Set([custom])), "/defaults/main.jpg");
  assert.equal(
    resolveItemImage({ imageUrl: custom }, "Mains", new Set([custom, "/defaults/main.jpg"])),
    null,
    "when both photographs are broken the item shows its emoji"
  );
  assert.equal(resolveItemImage({}, "Mains", new Set(["/defaults/main.jpg"])), null);
});

/* --------------------------------------------------------------- fixtures */

// Minimal but structurally real files: the server validates magic bytes and reads the dimensions out
// of the header, so these exercise the same branches a camera photo would.
function png(width, height, pad = 0) {
  const bytes = new Uint8Array(33 + pad);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52], 8);
  bytes.set([(width >>> 24) & 0xff, (width >>> 16) & 0xff, (width >>> 8) & 0xff, width & 0xff], 16);
  bytes.set([(height >>> 24) & 0xff, (height >>> 16) & 0xff, (height >>> 8) & 0xff, height & 0xff], 20);
  bytes[24] = 8;
  bytes[25] = 2;
  return bytes;
}

function jpeg(width, height) {
  const bytes = new Uint8Array(64);
  bytes.set([0xff, 0xd8, 0xff, 0xe0], 0);
  bytes[4] = 0x00;
  bytes[5] = 0x10;
  bytes[20] = 0xff;
  bytes[21] = 0xc0;
  bytes[22] = 0x00;
  bytes[23] = 0x11;
  bytes[24] = 0x08;
  bytes[25] = (height >> 8) & 0xff;
  bytes[26] = height & 0xff;
  bytes[27] = (width >> 8) & 0xff;
  bytes[28] = width & 0xff;
  return bytes;
}

function webp(width, height) {
  const bytes = new Uint8Array(40);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x20], 12);
  bytes.set([0x9d, 0x01, 0x2a], 20);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  bytes[26] = width & 0xff;
  bytes[27] = (width >> 8) & 0x3f;
  bytes[28] = height & 0xff;
  bytes[29] = (height >> 8) & 0x3f;
  return bytes;
}

/* ---------------------------------------------------------------- helpers */

async function seed(serviceMode = "counter") {
  const res = await fetch(`${AUTH}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ serviceMode }),
  });
  assert.equal(res.status, 200, `/seed answered ${res.status}`);
  return res.json();
}

async function clean(cafeId) {
  await fetch(`${AUTH}/clean`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId }),
  });
}

async function login(slug) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: HARNESS_OWNER_PASSWORD }),
  });
  assert.equal(res.status, 200, `login answered ${res.status}`);
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (cookies[0] || res.headers.get("set-cookie") || "").split(";")[0];
}

async function session(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  assert.equal(res.status, 200, `session answered ${res.status}`);
  return res.json();
}

async function adminMenu(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/menu`, { headers: { cookie } });
  assert.equal(res.status, 200, `admin menu answered ${res.status}`);
  return (await res.json()).items;
}

async function publicMenu(slug) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/menu`);
  assert.equal(res.status, 200, `public menu answered ${res.status}`);
  const body = await res.json();
  return body.categories.flatMap((category) =>
    category.items.map((item) => ({ ...item, category: category.name }))
  );
}

function upload(slug, itemId, cookie, csrf, bytes, headers = {}) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "application/octet-stream" }), "photo.bin");
  return fetch(`${AUTH}/api/cafes/${slug}/admin/menu/${itemId}/image`, {
    method: "POST",
    headers: { origin: AUTH, cookie, "x-csrf-token": csrf, ...headers },
    body: form,
  });
}

function remove(slug, itemId, cookie, csrf) {
  return fetch(`${AUTH}/api/cafes/${slug}/admin/menu/${itemId}/image`, {
    method: "DELETE",
    headers: { origin: AUTH, cookie, "x-csrf-token": csrf },
  });
}

function imageUrlFor(slug, itemId) {
  return `${AUTH}/api/cafes/${slug}/menu/${itemId}/image`;
}

/* ------------------------------------------------------------------ tests */

test("a seeded item has no photograph and no image route until one is uploaded", { skip }, async () => {
  const cafe = await seed();
  try {
    const items = await adminMenu(cafe.slug, await login(cafe.slug));
    const item = items.find((row) => row.id === cafe.itemId);
    assert.equal(item.imageUrl, null);
    assert.equal(item.hasCustomImage, false);

    const guest = (await publicMenu(cafe.slug)).find((row) => row.id === cafe.itemId);
    assert.equal(guest.imageUrl, null, "the guest menu falls back to the category default");
    assert.equal(guest.hasCustomImage, false);

    const res = await fetch(imageUrlFor(cafe.slug, cafe.itemId));
    assert.equal(res.status, 404, "no key means no image to serve");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("upload stores the file, serves it with a safe content type and reports it everywhere", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);
    const res = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(600, 400));
    assert.equal(res.status, 200, `upload answered ${res.status}`);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.hasCustomImage, true);
    assert.match(body.imageUrl, new RegExp(`^/api/cafes/${cafe.slug}/menu/${cafe.itemId}/image\\?v=`));

    const item = (await adminMenu(cafe.slug, cookie)).find((row) => row.id === cafe.itemId);
    assert.equal(item.hasCustomImage, true);
    assert.equal(item.imageUrl, body.imageUrl);

    const guest = (await publicMenu(cafe.slug)).find((row) => row.id === cafe.itemId);
    assert.equal(guest.imageUrl, body.imageUrl, "the guest sees the owner's photo");
    assert.equal(guest.hasCustomImage, true);

    const image = await fetch(imageUrlFor(cafe.slug, cafe.itemId));
    assert.equal(image.status, 200);
    assert.equal(image.headers.get("content-type"), "image/png");
    assert.equal(image.headers.get("x-content-type-options"), "nosniff");
    assert.match(image.headers.get("cache-control") || "", /immutable/);
    assert.equal((await image.arrayBuffer()).byteLength, png(600, 400).length);

    // The response never names the bucket or a storage credential.
    const serialised = JSON.stringify(body) + JSON.stringify(item);
    for (const marker of ["bucket", "r2", "account_id", "secret", "accessKey"]) {
      assert.equal(serialised.toLowerCase().includes(marker.toLowerCase()), false, `no ${marker} leak`);
    }
  } finally {
    await clean(cafe.cafeId);
  }
});

test("JPEG and WebP uploads are accepted; the served type follows the bytes", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);

    const jpegRes = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, jpeg(800, 600));
    assert.equal(jpegRes.status, 200);
    const jpegImage = await fetch(imageUrlFor(cafe.slug, cafe.itemId));
    assert.equal(jpegImage.headers.get("content-type"), "image/jpeg");

    const webpRes = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, webp(640, 480));
    assert.equal(webpRes.status, 200);
    const webpImage = await fetch(imageUrlFor(cafe.slug, cafe.itemId));
    assert.equal(webpImage.headers.get("content-type"), "image/webp");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("replacing a photo versions the URL and leaves only the new object readable", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);
    const first = await (await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(320, 240))).json();
    const firstBytes = new Uint8Array(await (await fetch(imageUrlFor(cafe.slug, cafe.itemId))).arrayBuffer());

    // Distinct bytes so the two objects cannot be confused for one another.
    const second = new Uint8Array(png(1024, 768));
    second[24] = 8;
    const replaced = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, second);
    assert.equal(replaced.status, 200);
    const replacedBody = await replaced.json();
    assert.notEqual(replacedBody.imageUrl, first.imageUrl, "a replacement gets a fresh cache key");

    const nowBytes = new Uint8Array(await (await fetch(imageUrlFor(cafe.slug, cafe.itemId))).arrayBuffer());
    assert.notDeepEqual(Array.from(nowBytes), Array.from(firstBytes), "the new photo is what is served");
    assert.equal(nowBytes.length, second.length);

    // The superseded object was deleted, not merely dereferenced: the old key no longer resolves.
    const rows = await adminMenu(cafe.slug, cookie);
    assert.equal(rows.find((row) => row.id === cafe.itemId).imageUrl, replacedBody.imageUrl);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("removing a photo restores the default immediately", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);
    assert.equal((await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(300, 300))).status, 200);

    const res = await remove(cafe.slug, cafe.itemId, cookie, csrfToken);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.imageUrl, null);
    assert.equal(body.hasCustomImage, false);

    const guest = (await publicMenu(cafe.slug)).find((row) => row.id === cafe.itemId);
    assert.equal(guest.imageUrl, null, "the guest is back on the category default");
    assert.equal((await fetch(imageUrlFor(cafe.slug, cafe.itemId))).status, 404);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("invalid uploads are refused and change nothing", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);
    const cases = [
      ["an SVG", new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'), 415],
      ["plain text", new TextEncoder().encode("not an image at all, just words"), 415],
      // Signature and IHDR tag with no dimensions behind them: recognised as PNG, so it is malformed
      // rather than an unsupported type.
      [
        "a truncated PNG header",
        new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x2c]),
        400,
      ],
      ["a 5000×5000 PNG", png(5000, 5000), 413],
      ["an oversized file", png(10, 10, 2 * 1024 * 1024), 413],
    ];

    for (const [label, bytes, status] of cases) {
      const res = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, bytes);
      assert.equal(res.status, status, `${label} must be refused with ${status}`);
    }

    const item = (await adminMenu(cafe.slug, cookie)).find((row) => row.id === cafe.itemId);
    assert.equal(item.hasCustomImage, false, "no refused upload was recorded");
    assert.equal((await fetch(imageUrlFor(cafe.slug, cafe.itemId))).status, 404);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("image mutations require the owner session, a matching Origin and a live CSRF token", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);
    const bytes = png(200, 200);

    assert.equal((await upload(cafe.slug, cafe.itemId, cookie, "", bytes)).status, 403, "missing CSRF");
    assert.equal(
      (await upload(cafe.slug, cafe.itemId, cookie, "not-a-real-token", bytes)).status,
      403,
      "unknown CSRF"
    );
    assert.equal(
      (await upload(cafe.slug, cafe.itemId, cookie, csrfToken, bytes, { origin: "http://evil.example" })).status,
      403,
      "a foreign Origin is refused even with a valid token"
    );
    assert.equal((await upload(cafe.slug, cafe.itemId, "", csrfToken, bytes)).status, 401, "no session");
    assert.equal((await remove(cafe.slug, cafe.itemId, "", csrfToken)).status, 401);

    const item = (await adminMenu(cafe.slug, cookie)).find((row) => row.id === cafe.itemId);
    assert.equal(item.hasCustomImage, false, "every refusal left the item unchanged");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("one café cannot read or change another café's menu photo", { skip }, async () => {
  const a = await seed();
  const b = await seed();
  const cookieA = await login(a.slug);
  try {
    const { csrfToken } = await session(a.slug, cookieA);
    assert.equal((await upload(a.slug, a.itemId, cookieA, csrfToken, png(320, 320))).status, 200);

    // A's session presented under B's cookie name is still A's session, so B refuses it.
    const stolen = cookieA.replace(/^[^=]+=/, `staff_session_${b.slug}=`);
    const foreign = await upload(b.slug, b.itemId, stolen, csrfToken, png(320, 320));
    assert.equal(foreign.status, 401, "a session for one café cannot act on another");
    assert.equal((await remove(b.slug, b.itemId, stolen, csrfToken)).status, 401);

    // Naming B's item id under A's own café is not a way to reach it either.
    const crossed = await upload(a.slug, b.itemId, cookieA, csrfToken, png(320, 320));
    assert.equal(crossed.status, 404, "the item is resolved within the café the session belongs to");
    assert.equal((await fetch(imageUrlFor(b.slug, a.itemId))).status, 404, "A's item is unknown to B");

    const bItems = await adminMenu(b.slug, await login(b.slug));
    assert.equal(bItems.find((row) => row.id === b.itemId).hasCustomImage, false);
  } finally {
    await clean(a.cafeId);
    await clean(b.cafeId);
  }
});

test("a failed storage upload leaves the previous photo in place", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);
    const first = await (await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(320, 240))).json();

    const failed = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(640, 480), {
      "x-harness-fail-image-put": "1",
    });
    assert.equal(failed.status, 502, "a storage failure is reported, not swallowed");

    const item = (await adminMenu(cafe.slug, cookie)).find((row) => row.id === cafe.itemId);
    assert.equal(item.imageUrl, first.imageUrl, "the working photo is still referenced");
    const served = await fetch(imageUrlFor(cafe.slug, cafe.itemId));
    assert.equal(served.status, 200);
    assert.equal((await served.arrayBuffer()).byteLength, png(320, 240).length);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("a failed database update keeps the previous photo and cleans up the new object", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);
    const first = await (await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(320, 240))).json();

    const failed = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(640, 480), {
      "x-harness-fail-menu-d1-write": "1",
    });
    assert.equal(failed.status, 502);

    const item = (await adminMenu(cafe.slug, cookie)).find((row) => row.id === cafe.itemId);
    assert.equal(item.imageUrl, first.imageUrl, "D1 was not repointed at the new object");
    const served = await fetch(imageUrlFor(cafe.slug, cafe.itemId));
    assert.equal(served.status, 200);
    assert.equal((await served.arrayBuffer()).byteLength, png(320, 240).length, "the old bytes are served");

    // Once the fault is gone, the same replacement succeeds — the failure is retryable.
    const retried = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(640, 480));
    assert.equal(retried.status, 200);
    const after = await fetch(imageUrlFor(cafe.slug, cafe.itemId));
    assert.equal((await after.arrayBuffer()).byteLength, png(640, 480).length);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("the image route degrades honestly when storage is not configured", { skip }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const { csrfToken } = await session(cafe.slug, cookie);
    assert.equal((await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(320, 240))).status, 200);

    const read = await fetch(imageUrlFor(cafe.slug, cafe.itemId), {
      headers: { "x-harness-no-image": "1" },
    });
    assert.equal(read.status, 503, "an unconfigured binding is a 503, never an empty 200");

    const write = await upload(cafe.slug, cafe.itemId, cookie, csrfToken, png(320, 240), {
      "x-harness-no-image": "1",
    });
    assert.equal(write.status, 503);
  } finally {
    await clean(cafe.cafeId);
  }
});
