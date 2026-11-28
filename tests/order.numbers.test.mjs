// Daily order numbers over the real Worker routes in the auth harness: simultaneous checkouts, a retry
// with the same idempotency key, a refused checkout, two cafés on the same day, and proof that the
// short, guessable number never opens an order — the tracking token still does.
import test from "node:test";
import assert from "node:assert/strict";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
// This file sends many writes (20 simultaneous checkouts alone), so it uses its own client address:
// the Worker's per-IP write ceiling is shared by every test that sends none, and CI runs the suite fast
// enough for this file to tip that shared bucket over into 429s for the tests after it.
const CLIENT = { "cf-connecting-ip": "203.0.113.11" };
const JSON_HEADERS = { "content-type": "application/json", ...CLIENT };

let alive = false;
try {
  alive = (await fetch(`${AUTH}/api/health`)).status < 600;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not reachable at ${AUTH}`;

async function seed(serviceMode = "tables") {
  const res = await fetch(`${AUTH}/seed`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ serviceMode }) });
  assert.equal(res.status, 200);
  return res.json();
}
const clean = (cafe) =>
  fetch(`${AUTH}/clean`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cafeId: cafe.cafeId }) });

function place(cafe, { key = crypto.randomUUID(), itemId = cafe.itemId } = {}) {
  return fetch(`${AUTH}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "Idempotency-Key": key },
    body: JSON.stringify({
      ...(cafe.tableId ? { tableId: 1 } : {}),
      note: "",
      paymentMethod: "counter",
      items: [{ itemId, qty: 1 }],
    }),
  });
}

test("20 simultaneous orders get #1 to #20: no duplicates, no gaps", { skip }, async () => {
  const cafe = await seed();
  try {
    const responses = await Promise.all(Array.from({ length: 20 }, () => place(cafe)));
    const bodies = await Promise.all(responses.map((r) => r.json()));
    assert.deepEqual(responses.map((r) => r.status), Array(20).fill(201));
    const numbers = bodies.map((b) => b.order.queueNo).sort((a, b) => a - b);
    assert.deepEqual(numbers, Array.from({ length: 20 }, (_, i) => i + 1));
    assert.equal(new Set(bodies.map((b) => b.order.id)).size, 20, "every order keeps its own random id");
  } finally {
    await clean(cafe);
  }
});

test("a retry with the same idempotency key returns the same order and number", { skip }, async () => {
  const cafe = await seed();
  try {
    const key = crypto.randomUUID();
    const first = await (await place(cafe, { key })).json();
    const again = await (await place(cafe, { key })).json();
    const parallel = await Promise.all([place(cafe, { key }), place(cafe, { key })]);
    assert.equal(again.order.id, first.order.id);
    assert.equal(again.order.queueNo, first.order.queueNo);
    for (const res of parallel) assert.equal((await res.json()).order.queueNo, first.order.queueNo);
    assert.equal((await (await place(cafe)).json()).order.queueNo, first.order.queueNo + 1, "retries took no number");
  } finally {
    await clean(cafe);
  }
});

test("a refused checkout uses up no number", { skip }, async () => {
  const cafe = await seed();
  try {
    assert.equal((await (await place(cafe)).json()).order.queueNo, 1);
    assert.equal((await place(cafe, { itemId: 999999 })).status, 400, "an item that isn't on the menu is refused");
    assert.equal((await (await place(cafe)).json()).order.queueNo, 2);
  } finally {
    await clean(cafe);
  }
});

test("two cafés each start at #1 on the same day, dine-in and counter alike", { skip }, async () => {
  const dineIn = await seed("tables");
  const counter = await seed("counter");
  try {
    assert.equal((await (await place(dineIn)).json()).order.queueNo, 1);
    assert.equal((await (await place(counter)).json()).order.queueNo, 1);
    assert.equal((await (await place(dineIn)).json()).order.queueNo, 2);
    assert.equal((await (await place(counter)).json()).order.queueNo, 2);
  } finally {
    await clean(dineIn);
    await clean(counter);
  }
});

test("the daily number never opens an order: lookups stay on the random id plus the token", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await (await place(cafe)).json();
    const read = (id, token) =>
      fetch(`${AUTH}/api/cafes/${cafe.slug}/orders/${encodeURIComponent(id)}`, {
        headers: token ? { ...CLIENT, "x-order-token": token } : CLIENT,
      });

    for (const guess of [String(order.queueNo), `#${order.queueNo}`, "1", "%231"]) {
      assert.equal((await read(guess)).status, 404, `no order at ${guess}`);
      assert.equal((await read(guess, trackToken)).status, 404, `even with a real token, ${guess} is not an order id`);
    }
    assert.equal((await read(order.id)).status, 404, "the random id alone is still not enough");
    const ok = await read(order.id, trackToken);
    assert.equal(ok.status, 200);
    assert.equal((await ok.json()).order.queueNo, order.queueNo);

    // Staff see the same number on the board.
    const login = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: HARNESS_OWNER_PASSWORD }),
    });
    const cookie = (login.headers.getSetCookie?.() || [])[0]?.split(";")[0] || "";
    const board = await (await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/orders`, { headers: { ...CLIENT, cookie } })).json();
    assert.equal(board.orders.find((o) => o.id === order.id).queueNo, order.queueNo);
  } finally {
    await clean(cafe);
  }
});
