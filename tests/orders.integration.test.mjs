// Integration tests for the parts the batch harness cannot reach: the real POST /api/orders handler
// on a tables-mode café, and abandonment of a key that already committed. They run against the
// harness Worker, which mounts the production handleApi and owns its own D1 persistence directory.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const HARNESS = process.env.HARNESS_URL || "http://127.0.0.1:8789";

async function call(path, body) {
  const res = await fetch(`${HARNESS}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  assert.equal(res.ok, true, `${path} answered ${res.status}`);
  return res.json();
}

function order(cafe, path, body, key) {
  return fetch(`${HARNESS}/api/cafes/${cafe.slug}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { "Idempotency-Key": key } : {}) },
    body,
  });
}

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cafeId: -1, key: "probe" }),
  });
  alive = probe.status === 200;
} catch {
  alive = false;
}

const skip = alive ? false : `harness not reachable at ${HARNESS}`;

test("T5: a dine-in order stores the internal table id, no pickup number, and replays", { skip }, async () => {
  const cafe = await call("/seed", { serviceMode: "tables" });
  assert.ok(cafe.tableId, "the seed created a table");
  assert.ok(cafe.slug, "the seed created a slug");

  const body = JSON.stringify({
    tableId: 1,
    note: "",
    paymentMethod: "counter",
    items: [{ itemId: cafe.itemId, qty: 2 }],
  });
  const key = crypto.randomUUID();

  try {
    const first = await order(cafe, "/orders", body, key);
    assert.equal(first.status, 201);
    const { order: created } = await first.json();

    assert.equal(created.tableId, 1, "the café-facing table number comes back");
    assert.equal(created.tableLabel, "Harness Table");
    assert.equal(created.queueNo, null, "a table order has no pickup number");
    assert.equal(created.items.length, 1);
    assert.equal(created.items[0].qty, 2);
    assert.equal(created.totalCents, 20000, "the server price, never the client's");

    const stored = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(stored.orders.length, 1);
    assert.equal(stored.orders[0].table_id, cafe.tableId, "internal tables.id, not 0 and not the number");
    assert.equal(stored.orders[0].queue_no, null);
    assert.equal(stored.itemCount, 1);
    assert.equal(stored.claim.state, "committed");

    const replay = await order(cafe, "/orders", body, key);
    assert.equal(replay.status, 200);
    const { order: again } = await replay.json();
    assert.equal(again.id, created.id, "the retry is the same order");
    assert.equal(again.queueNo, null);
    assert.equal(again.tableId, created.tableId);
    assert.deepEqual(again.items, created.items);
    assert.equal(stored.orders.length, 1, "the retry created no second order");
  } finally {
    await call("/clean", { cafeId: cafe.cafeId });
  }
});

test("T6: abandoning a committed checkout returns the order and leaves the claim committed", { skip }, async () => {
  const cafe = await call("/seed", { serviceMode: "counter" });
  const body = JSON.stringify({ note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] });
  const key = crypto.randomUUID();

  try {
    const createdRes = await order(cafe, "/orders", body, key);
    assert.equal(createdRes.status, 201);
    const { order: created } = await createdRes.json();

    const abandoned = await order(cafe, `/orders/idempotency/${key}/abandon`, body);
    assert.equal(abandoned.status, 200);
    const payload = await abandoned.json();
    assert.equal(payload.status, "committed", "a committed key reports the order, not an abandonment");
    assert.equal(payload.order.id, created.id);
    assert.deepEqual(payload.order.items, created.items);

    const stored = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(stored.claim.state, "committed", "abandonment never rewrites a committed claim");
    assert.equal(stored.claim.order_id, created.id);
    assert.equal(stored.orders.length, 1);
    assert.equal(stored.itemCount, 1);

    // The key is still a working replay, so the guest's retry cannot create a second order.
    const replay = await order(cafe, "/orders", body, key);
    assert.equal(replay.status, 200);
    assert.equal((await replay.json()).order.id, created.id);
  } finally {
    await call("/clean", { cafeId: cafe.cafeId });
  }
});

// F-14: when no free order id can be minted, the guest gets a controlled 503 rather than a 500, the
// idempotency claim is handed back, and the same key succeeds on the next attempt.
test("T7: order-id exhaustion answers 503, releases the claim, and the retry succeeds", { skip }, async () => {
  const cafe = await call("/seed", { serviceMode: "counter" });
  const body = JSON.stringify({ note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] });
  const key = crypto.randomUUID();

  try {
    const exhausted = await fetch(`${HARNESS}/api/cafes/${cafe.slug}/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": key,
        "x-harness-exhaust-order-ids": "1",
      },
      body,
    });

    assert.equal(exhausted.status, 503, "capacity is a 503, not a 500 and not a bogus id");
    const failure = await exhausted.json();
    assert.match(String(failure.error), /try again/i);

    const after = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(after.orders.length, 0, "no order was written");
    assert.equal(after.itemCount, 0, "no item rows were written");
    assert.equal(after.claim, null, "the claim was released so the guest is not locked out");

    // The same key, without the forced exhaustion, now succeeds.
    const retry = await order(cafe, "/orders", body, key);
    assert.equal(retry.status, 201, "the retry is accepted with the same idempotency key");
    const { order: created } = await retry.json();
    assert.equal(created.id.length, 6, "the normal path still mints a readable short code");

    const stored = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(stored.orders.length, 1, "exactly one order exists after the retry");
    assert.equal(stored.claim.state, "committed");
  } finally {
    await call("/clean", { cafeId: cafe.cafeId });
  }
});

test("T8: a counter café still rejects a tableId, and takes the same order as a pickup", { skip }, async () => {
  // The menu no longer sends a table for a counter café opened through an old table link, but the server
  // check stays: a table id for a pickup café is a mistake, never a hint.
  const cafe = await call("/seed", { serviceMode: "counter" });
  const items = [{ itemId: cafe.itemId, qty: 1 }];
  try {
    const key = crypto.randomUUID();
    const rejected = await order(cafe, "/orders", JSON.stringify({ tableId: 1, note: "", paymentMethod: "counter", items }), key);
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, /pickup orders/);
    const stored = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(stored.orders.length, 0, "nothing was written for the rejected checkout");

    const accepted = await order(cafe, "/orders", JSON.stringify({ note: "", paymentMethod: "counter", items }), crypto.randomUUID());
    assert.equal(accepted.status, 201);
    const { order: created } = await accepted.json();
    assert.ok(created.queueNo != null, "a pickup order gets a pickup number");
    assert.equal(created.tableId, null);
  } finally {
    await call("/clean", { cafeId: cafe.cafeId });
  }
});
