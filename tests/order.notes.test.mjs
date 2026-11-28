// A guest's note for one dish, and the owner's usual wait, over the real Worker routes in the auth
// harness: the note is stored with its order line, shown back to the guest and to staff, and the usual
// wait reaches the tracking page only once the owner sets it.
import test from "node:test";
import assert from "node:assert/strict";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
// This file sends many writes , so it uses its own client address:
// the Worker's per-IP write ceiling is shared by every test that sends none, and CI runs the suite fast
// enough for this file to tip that shared bucket over into 429s for the tests after it.
const CLIENT = { "cf-connecting-ip": "203.0.113.12" };
const JSON_HEADERS = { "content-type": "application/json", ...CLIENT };

let alive = false;
try {
  alive = (await fetch(`${AUTH}/api/health`)).status < 600;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not reachable at ${AUTH}`;

async function seed() {
  const res = await fetch(`${AUTH}/seed`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ serviceMode: "counter" }) });
  assert.equal(res.status, 200);
  return res.json();
}

const clean = (cafe) =>
  fetch(`${AUTH}/clean`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cafeId: cafe.cafeId }) });

async function owner(cafe) {
  const login = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: HARNESS_OWNER_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const cookie = (login.headers.getSetCookie?.() || [])[0]?.split(";")[0] || "";
  const session = await (await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/session`, { headers: { ...CLIENT, cookie } })).json();
  return { cookie, headers: { ...JSON_HEADERS, cookie, origin: AUTH, "x-csrf-token": session.csrfToken } };
}

function place(cafe, items, key = crypto.randomUUID()) {
  return fetch(`${AUTH}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "Idempotency-Key": key },
    body: JSON.stringify({ note: "", paymentMethod: "counter", items }),
  });
}

test("a dish's note is stored with its line and shown to the guest and to staff", { skip }, async () => {
  const cafe = await seed();
  try {
    const res = await place(cafe, [{ itemId: cafe.itemId, qty: 2, note: "  less   sugar " }]);
    assert.equal(res.status, 201);
    const { order, trackToken } = await res.json();
    assert.equal(order.items[0].note, "less sugar", "the confirmation shows it, tidied");
    assert.equal(order.cafeName, cafe.slug, "the café's public name rides along for the tab title");

    const guest = await (
      await fetch(`${AUTH}/api/cafes/${cafe.slug}/orders/${order.id}`, { headers: { ...CLIENT, "x-order-token": trackToken } })
    ).json();
    assert.equal(guest.order.items[0].note, "less sugar");

    const { cookie } = await owner(cafe);
    const board = await (await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/orders`, { headers: { ...CLIENT, cookie } })).json();
    const line = board.orders.find((o) => o.id === order.id).items[0];
    assert.equal(line.note, "less sugar", "the kitchen sees it on the board");
  } finally {
    await clean(cafe);
  }
});

test("a line without a note stores an empty one, and a non-text note is refused", { skip }, async () => {
  const cafe = await seed();
  try {
    const res = await place(cafe, [{ itemId: cafe.itemId, qty: 1 }]);
    assert.equal(res.status, 201);
    assert.equal((await res.json()).order.items[0].note, "");
    assert.equal((await place(cafe, [{ itemId: cafe.itemId, qty: 1, note: { evil: true } }])).status, 400);
  } finally {
    await clean(cafe);
  }
});

test("the usual wait is the owner's to set, validated, and reaches the tracking page", { skip }, async () => {
  const cafe = await seed();
  try {
    const { headers } = await owner(cafe);
    const placed = await (await place(cafe, [{ itemId: cafe.itemId, qty: 1 }])).json();
    assert.equal(placed.order.typicalWaitMin, 0, "not stated until the owner sets it");

    for (const bad of [-1, 121, 2.5, "soon"]) {
      const refused = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/settings`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ typicalWaitMin: bad }),
      });
      assert.equal(refused.status, 400, `refuses ${JSON.stringify(bad)}`);
    }

    const saved = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/settings`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ typicalWaitMin: 15 }),
    });
    assert.equal(saved.status, 200);
    assert.equal((await saved.json()).settings.typicalWaitMin, 15);

    const config = await (await fetch(`${AUTH}/api/cafes/${cafe.slug}/config`, { headers: CLIENT })).json();
    assert.equal(config.service.typicalWaitMin, 15);
    const guest = await (
      await fetch(`${AUTH}/api/cafes/${cafe.slug}/orders/${placed.order.id}`, { headers: { ...CLIENT, "x-order-token": placed.trackToken } })
    ).json();
    assert.equal(guest.order.typicalWaitMin, 15);
  } finally {
    await clean(cafe);
  }
});
