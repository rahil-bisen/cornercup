// Menu item editing — backend contracts exercised over the real Worker HTTP surface (auth harness,
// port 8790). These are the functional tests behind the new owner-board “Edit” path: rename, price,
// category, description, emoji and availability, plus every refusal and the historical-order-integrity
// property that the edit feature must not break.
//
// The harness owns its own disposable D1 directory, so every café and every order here is synthetic and
// cleaned up in the test's finally block. Nothing here touches a deployed environment.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const H = process.env.HARNESS_URL || "http://127.0.0.1:8789";
const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };

let alive = false;
try {
  const probe = await fetch(`${H}/read`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cafeId: -1, key: "probe" }) });
  alive = probe.status === 200;
} catch {
  alive = false;
}
const skip = alive ? false : `harness not reachable at ${H}`;
const authSkip = (await fetch(`${AUTH}/primary`, { method: "GET" }).then((r) => r.ok).catch(() => false)) ? false : `auth harness not reachable at ${AUTH}`;

const ITEM_PRICE_CENTS = 10000;

async function reachable(base, path, body) {
  try {
    const res = await fetch(`${base}${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(1500) });
    return res.status === 200;
  } catch {
    return false;
  }
}

async function seed(base = H, options = {}) {
  const res = await fetch(`${base}/seed`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ serviceMode: "counter", ...options }) });
  assert.equal(res.status, 200, `/seed answered ${res.status}`);
  return res.json();
}

async function clean(cafe, base = H) {
  await fetch(`${base}/clean`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cafeId: cafe.cafeId }) });
}

async function stored(base, cafe, key) {
  const res = await fetch(`${base}/read`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cafeId: cafe.cafeId, key }) });
  assert.equal(res.status, 200, `/read answered ${res.status}`);
  return res.json();
}

// Returns the session cookie every caller actually needs: passing the whole result as a header sends
// "[object Object]" and every following request looks unauthenticated.
async function login(slug, password = "harness-owner-password") {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/login`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ password }) });
  assert.equal(res.status, 200, `sign-in answered ${res.status}`);
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (list[0] || res.headers.get("set-cookie") || "").split(";")[0];
}

async function csrfFor(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  const payload = await res.json().catch(() => ({}));
  return (payload && payload.csrfToken) || "";
}

function adminHeaders(cookie, token) {
  return { ...JSON_HEADERS, cookie, origin: AUTH, ...(token ? { "x-csrf-token": token } : {}) };
}

async function adminPatch(slug, itemId, cookie, token, body) {
  return fetch(`${AUTH}/api/cafes/${slug}/admin/menu/${itemId}`, {
    method: "PATCH",
    headers: adminHeaders(cookie, token),
    body: JSON.stringify(body),
  });
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
  return body.categories.flatMap((category) => category.items.map((item) => ({ ...item, category: category.name })));
}

async function placeOrder(base, cafe, key, body) {
  return fetch(`${base}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
  });
}

function cart(cafe, itemId, qty = 1, priceCents, extra = {}) {
  return { note: "", paymentMethod: "counter", items: [{ itemId, qty, priceCents }], ...extra };
}

/* -------------------------------------------------------------------- 1. rename an existing item */

test("rename an existing menu item", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);
    const before = await adminMenu(cafe.slug, cookie);
    const item = before.find((row) => row.id === cafe.itemId);
    assert.ok(item, "the seeded item exists");
    assert.equal(item.name, "Harness Item");

    const renamed = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { name: "Chai Latte" });
    assert.equal(renamed.status, 200, `rename answered ${renamed.status}`);
    const payload = await renamed.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.item.name, "Chai Latte");
    assert.equal(payload.item.priceCents, ITEM_PRICE_CENTS, "rename did not touch the price");

    const after = await adminMenu(cafe.slug, cookie);
    const updated = after.find((row) => row.id === cafe.itemId);
    assert.equal(updated.name, "Chai Latte");
    assert.equal(updated.priceCents, ITEM_PRICE_CENTS);

    const guest = (await publicMenu(cafe.slug)).find((row) => row.id === cafe.itemId);
    assert.equal(guest.name, "Chai Latte", "the customer menu reflects the rename");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 2. change the price */

test("change an item's price", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);

    const updated = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { priceCents: 1250 });
    assert.equal(updated.status, 200);
    const payload = await updated.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.item.priceCents, 1250);
    assert.equal(payload.item.name, "Harness Item", "a price-only edit keeps the name");

    const after = await adminMenu(cafe.slug, cookie);
    const item = after.find((row) => row.id === cafe.itemId);
    assert.equal(item.priceCents, 1250);

    const guest = (await publicMenu(cafe.slug)).find((row) => row.id === cafe.itemId);
    assert.equal(guest.priceCents, 1250, "the customer menu reflects the new price");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 3. change category and description */

test("change category and description", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);

    const updated = await adminPatch(cafe.slug, cafe.itemId, cookie, token, {
      category: "Specialty Drinks",
      description: "House-made, served hot.",
    });
    assert.equal(updated.status, 200);
    const payload = await updated.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.item.category, "Specialty Drinks");
    assert.equal(payload.item.description, "House-made, served hot.");
    assert.equal(payload.item.priceCents, ITEM_PRICE_CENTS, "an edit of other fields leaves the price alone");

    const after = await adminMenu(cafe.slug, cookie);
    const item = after.find((row) => row.id === cafe.itemId);
    assert.equal(item.category, "Specialty Drinks");
    assert.equal(item.description, "House-made, served hot.");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 4. change the emoji */

test("change the emoji", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);

    const updated = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { emoji: "☕" });
    assert.equal(updated.status, 200);
    const payload = await updated.json();
    assert.equal(payload.ok, true);
    assert.equal(payload.item.emoji, "☕");

    const after = await adminMenu(cafe.slug, cookie);
    const item = after.find((row) => row.id === cafe.itemId);
    assert.equal(item.emoji, "☕");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 5. change availability */

test("toggle availability without touching other fields", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);

    const off = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { available: false });
    assert.equal(off.status, 200);
    const offPayload = await off.json();
    assert.equal(offPayload.ok, true);
    assert.equal(offPayload.item.available, false);
    assert.equal(offPayload.item.priceCents, ITEM_PRICE_CENTS, "availability-only edit keeps the price");

    const afterOff = await adminMenu(cafe.slug, cookie);
    assert.equal(afterOff.find((row) => row.id === cafe.itemId).available, false);

    const on = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { available: true });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).item.available, true);

    const afterOn = await adminMenu(cafe.slug, cookie);
    assert.equal(afterOn.find((row) => row.id === cafe.itemId).available, true);
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 6. reject invalid prices */

test("reject invalid prices", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);
    const invalid = [
      ["zero", { priceCents: 0 }],
      ["negative", { priceCents: -50 }],
      ["non-finite string", { priceCents: "free" }],
      ["NaN", { priceCents: Number(NaN) }],
      ["too large", { priceCents: 1_000_001 }],
    ];
    for (const [label, body] of invalid) {
      const res = await adminPatch(cafe.slug, cafe.itemId, cookie, token, body);
      assert.equal(res.status, 400, `${label} must be refused`);
      assert.match(String((await res.json()).error), /price/i, `${label} names the price`);
      // The item is unchanged.
      const after = await adminMenu(cafe.slug, cookie);
      assert.equal(after.find((row) => row.id === cafe.itemId).priceCents, ITEM_PRICE_CENTS, `${label} left the price alone`);
    }
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 7. reject invalid names and malformed payloads */

test("reject invalid names and malformed payloads", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);

    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { name: "   " })).status,
      400,
      "a blank name is refused"
    );
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { name: "" })).status,
      400,
      "an empty name is refused"
    );

    // A PATCH with no supported field is refused. Reporting success for a no-op would hide a client
    // bug and rewrite the row with values the caller never sent.
    const empty = await adminPatch(cafe.slug, cafe.itemId, cookie, token, {});
    assert.equal(empty.status, 400, "an empty payload is refused");
    assert.match((await empty.json()).error, /nothing to update/i);

    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { name: "x".repeat(61) })).status,
      400,
      "an over-long name is refused, not silently truncated"
    );
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { category: "x".repeat(41) })).status,
      400,
      "an over-long category is refused"
    );
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { description: "x".repeat(161) })).status,
      400,
      "an over-long description is refused"
    );
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { emoji: "🍽️🍽️🍽️🍽️🍽️" })).status,
      400,
      "an over-long icon is refused"
    );

    const stillOriginal = (await adminMenu(cafe.slug, cookie)).find((row) => row.id === cafe.itemId);
    assert.equal(stillOriginal.name, "Harness Item", "no refused name edit landed");
    assert.equal(stillOriginal.category, "Harness", "no refused category edit landed");

    // Completely malformed JSON on the PATCH is a bad request, not a 500.
    const malformed = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/menu/${cafe.itemId}`, {
      method: "PATCH",
      headers: adminHeaders(cookie, token),
      body: "{ not json",
    });
    assert.equal(malformed.status, 400, "malformed JSON is a 400");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 7b. reject wrong types */

test("reject editable fields of the wrong type", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);
    const wrong = [
      ["name as a number", { name: 42 }],
      ["name as an object", { name: { text: "Latte" } }],
      ["category as an array", { category: ["Coffee"] }],
      ["description as a number", { description: 7 }],
      ["emoji as a boolean", { emoji: true }],
      ["price as numeric text", { priceCents: "1200" }],
      ["price as a fraction", { priceCents: 12.5 }],
      ["price as NaN", { priceCents: Number.NaN }],
      ["availability as text", { available: "true" }],
      ["availability as a number", { available: 1 }],
      ["description as null", { description: null }],
    ];
    for (const [label, body] of wrong) {
      const res = await adminPatch(cafe.slug, cafe.itemId, cookie, token, body);
      assert.equal(res.status, 400, `${label} must be refused`);
    }

    const after = await adminMenu(cafe.slug, cookie);
    const item = after.find((row) => row.id === cafe.itemId);
    assert.equal(item.name, "Harness Item", "no wrongly typed edit landed");
    assert.equal(item.priceCents, ITEM_PRICE_CENTS, "the price did not ride along");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 8. reject unauthenticated requests */

test("reject unauthenticated edit requests", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  try {
    const noSession = await adminPatch(cafe.slug, cafe.itemId, "", null, { name: "Stolen" });
    assert.equal(noSession.status, 401, "no session is refused");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 9. reject missing or invalid CSRF tokens */

test("reject missing or invalid CSRF tokens", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, "", { name: "No proof" })).status,
      403,
      "a missing CSRF token is refused"
    );
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, "not-a-real-token", { name: "Bad proof" })).status,
      403,
      "an unknown CSRF token is refused"
    );

    const after = await adminMenu(cafe.slug, cookie);
    const item = after.find((row) => row.id === cafe.itemId);
    assert.equal(item.name, "Harness Item", "every refused write left the item unchanged");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 10. reject cross-café item modification */

test("a session for one café cannot edit another café's item", { skip, timeout: 30_000 }, async () => {
  const a = await seed();
  const b = await seed();
  const cookieA = await login(a.slug);
  try {
    // A's session, presented against B's item id under B's café. The session is A's, so B refuses it.
    const token = await csrfFor(a.slug, cookieA);
    const foreign = await adminPatch(b.slug, b.itemId, cookieA, token, { name: "Cross-cafe rename" });
    assert.equal(foreign.status, 401, "a session for one café is refused on another");

    // A's own session presented under B's cookie name is still A's session, so B refuses that too.
    const stolen = cookieA.replace(/^[^=]+=/, `staff_session_${b.slug}=`);
    const alsoForeign = await adminPatch(b.slug, b.itemId, stolen, token, { name: "Cross-cafe rename" });
    assert.equal(alsoForeign.status, 401, "the cookie name does not masquerade as B's session");

    // A's session trying to edit B's item id under A's own café — the item is resolved within A, so it is
    // unknown to A rather than editable.
    const crossed = await adminPatch(a.slug, b.itemId, cookieA, token, { name: "Cross-cafe rename" });
    assert.equal(crossed.status, 404, "A's session cannot reach B's item through A's café");

    const aAfter = await adminMenu(a.slug, cookieA);
    const aItem = aAfter.find((row) => row.id === a.itemId);
    assert.equal(aItem.name, "Harness Item", "A's item was not renamed by any of these attempts");

    const bCookie = await login(b.slug);
    const bAfter = await adminMenu(b.slug, bCookie);
    const bItem = bAfter.find((row) => row.id === b.itemId);
    assert.equal(bItem.name, "Harness Item", "B's item was not renamed either");
  } finally {
    await clean(a);
    await clean(b);
  }
});

/* -------------------------------------------------------------------- 11. preserve existing order snapshots after editing */

test("existing orders keep their item names and prices after the menu item is edited", { skip, timeout: 45_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);

    // One order at the seeded price.
    const key1 = webcrypto.randomUUID();
    const first = await placeOrder(H, cafe, key1, cart(cafe, cafe.itemId, 1, ITEM_PRICE_CENTS));
    assert.equal(first.status, 201, "the first order was created");
    // The token is a sibling of the order in the create response, not a field on the order.
    const { order: order1, trackToken } = await first.json();
    assert.equal(order1.totalCents, ITEM_PRICE_CENTS);
    assert.equal(order1.items[0].name, "Harness Item");
    assert.equal(order1.items[0].priceCents, ITEM_PRICE_CENTS);

    // Edit the menu item: rename + reprice.
    const edited = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { name: "Renamed Latte", priceCents: 1250 });
    assert.equal(edited.status, 200);
    const editedPayload = await edited.json();
    assert.equal(editedPayload.item.name, "Renamed Latte");
    assert.equal(editedPayload.item.priceCents, 1250);

    // A second order now uses the new price.
    const key2 = webcrypto.randomUUID();
    const second = await placeOrder(H, cafe, key2, cart(cafe, cafe.itemId, 1, 1250));
    assert.equal(second.status, 201, "the second order used the edited price");
    const { order: order2 } = await second.json();
    assert.equal(order2.totalCents, 1250);
    assert.equal(order2.items[0].name, "Renamed Latte");
    assert.equal(order2.items[0].priceCents, 1250);

    // The first order is still the old snapshot.
    const firstStored = await stored(H, cafe, key1);
    assert.equal(firstStored.orders.length, 1);
    const firstRow = firstStored.orders[0];
    assert.equal(firstRow.total_cents, ITEM_PRICE_CENTS, "the first order's total is unchanged");
    assert.equal(firstRow.items[0].name, "Harness Item", "the first order kept its original item name");
    assert.equal(firstRow.items[0].price_cents, ITEM_PRICE_CENTS, "the first order kept its original item price");

    // The board reads the same snapshot.
    const board = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/orders`, { headers: { cookie } });
    assert.equal(board.status, 200);
    const boardBody = await board.json();
    const firstOnBoard = boardBody.orders.find((o) => o.id === order1.id);
    assert.ok(firstOnBoard, "the first order is on the board");
    assert.equal(firstOnBoard.items[0].name, "Harness Item", "the board shows the snapshot name for the old order");
    assert.equal(firstOnBoard.items[0].priceCents, ITEM_PRICE_CENTS, "the board shows the snapshot price for the old order");

    // And the guest order page too. The tracking token is signed with ORDER_TRACK_SECRET, which only
    // the batch harness carries, so the guest read is made against the harness that created the order.
    const guestOrder = await fetch(`${H}/api/cafes/${cafe.slug}/orders/${order1.id}`, {
      headers: { "x-order-token": trackToken },
    });
    assert.equal(guestOrder.status, 200);
    const guestBody = await guestOrder.json();
    assert.equal(guestBody.order.items[0].name, "Harness Item", "the guest order page shows the snapshot name");
    assert.equal(guestBody.order.items[0].priceCents, ITEM_PRICE_CENTS, "the guest order page shows the snapshot price");
    assert.equal(guestBody.order.totalCents, ITEM_PRICE_CENTS, "the guest order total is unchanged");
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 12. new orders use the updated price */

test("after an edit, new orders use the updated name and price", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);

    await adminPatch(cafe.slug, cafe.itemId, cookie, token, { name: "Espresso", priceCents: 9000 });

    const key = webcrypto.randomUUID();
    const res = await placeOrder(H, cafe, key, cart(cafe, cafe.itemId, 2, 9000));
    assert.equal(res.status, 201);
    const { order } = await res.json();
    assert.equal(order.totalCents, 9000 * 2, "two of the edited item at the edited price");
    assert.equal(order.items[0].name, "Espresso");
    assert.equal(order.items[0].priceCents, 9000);
    assert.equal(order.items[0].qty, 2);
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- 13. availability-only PATCH stays working */

test("availability-only PATCH still works after the edit path was added", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);

    const off = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { available: false });
    assert.equal(off.status, 200);
    assert.equal((await off.json()).item.available, false);

    const on = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { available: true });
    assert.equal(on.status, 200);
    assert.equal((await on.json()).item.available, true);

    // A combined edit that also flips availability is fine.
    const combined = await adminPatch(cafe.slug, cafe.itemId, cookie, token, { name: "Combo Latte", available: false });
    assert.equal(combined.status, 200);
    const payload = await combined.json();
    assert.equal(payload.item.name, "Combo Latte");
    assert.equal(payload.item.available, false);
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- guard: a stale/unknown item id is a 404, not a 500 */

test("editing a non-existent item is a 404", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);
    assert.equal((await adminPatch(cafe.slug, 999999, cookie, token, { name: "Ghost" })).status, 404);
  } finally {
    await clean(cafe);
  }
});

/* -------------------------------------------------------------------- guard: unknown fields are rejected */

test("unknown fields on an edit are rejected", { skip, timeout: 30_000 }, async () => {
  const cafe = await seed();
  const cookie = await login(cafe.slug);
  try {
    const token = await csrfFor(cafe.slug, cookie);
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { sort: 1 })).status,
      400,
      "an unknown field is refused"
    );
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { cafeId: 99 })).status,
      400,
      "an ownership field is refused"
    );
    assert.equal(
      (await adminPatch(cafe.slug, cafe.itemId, cookie, token, { id: 5 })).status,
      400,
      "an internal id field is refused"
    );

    const after = await adminMenu(cafe.slug, cookie);
    const item = after.find((row) => row.id === cafe.itemId);
    assert.equal(item.name, "Harness Item", "the refused edits changed nothing");
  } finally {
    await clean(cafe);
  }
});
