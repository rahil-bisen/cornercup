import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const HARNESS = process.env.HARNESS_URL || "http://127.0.0.1:8789";
const JSON_HEADERS = { "content-type": "application/json" };

async function call(path, body) {
  const res = await fetch(`${HARNESS}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? {} : JSON_HEADERS,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { res, json: await res.json().catch(() => null) };
}

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/read`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId: -1, key: "probe" }),
  });
  alive = probe.status === 200;
} catch {
  alive = false;
}
const skip = alive ? false : `harness not reachable at ${HARNESS}`;

function orderFetch(cafe, body, key, failMode, failKey) {
  const headers = { ...JSON_HEADERS };
  if (key) headers["Idempotency-Key"] = key;
  if (failMode) headers["x-harness-order-batch-fail-mode"] = failMode;
  if (failKey) headers["x-harness-order-batch-fail-key"] = failKey;
  return fetch(`${HARNESS}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function seed(serviceMode) {
  const { res, json } = await call("/seed", { serviceMode });
  assert.equal(res.status, 200);
  return json;
}

async function clean(cafeId) {
  await call("/clean", { cafeId });
}

test("F-14 retry: a single PK collision retries and succeeds with a valid token", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const body = { note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] };
    const key = crypto.randomUUID();
    const failKey = crypto.randomUUID();
    const res = await orderFetch(cafe, body, key, "pk-once", failKey);
    assert.equal(res.status, 201, `expected 201 got ${res.status}`);
    const { order, trackToken } = await res.json();
    assert.ok(order && order.id, "order id present");
    assert.ok(trackToken, "tracking token present");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-14 retry: two concurrent checkouts both succeed with distinct ids", { skip }, async () => {
  const cafe = await seed("tables");
  try {
    const body = { tableId: 1, note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] };
    const keyA = crypto.randomUUID();
    const keyB = crypto.randomUUID();
    const failKeyA = crypto.randomUUID();
    const failKeyB = crypto.randomUUID();
    const [resA, resB] = await Promise.all([
      orderFetch(cafe, body, keyA, "pk-once", failKeyA),
      orderFetch(cafe, body, keyB, "pk-once", failKeyB),
    ]);
    assert.equal(resA.status, 201, `A got ${resA.status}`);
    assert.equal(resB.status, 201, `B got ${resB.status}`);
    const a = await resA.json();
    const b = await resB.json();
    assert.notEqual(a.order.id, b.order.id, "distinct order ids");
    assert.ok(a.trackToken && b.trackToken);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-14 retry: exhausted collisions return 500 and release the claim", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const body = { note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] };
    const key = crypto.randomUUID();
    const failKey = crypto.randomUUID();
    const res = await orderFetch(cafe, body, key, "pk-always", failKey);
    assert.equal(res.status, 500, `expected 500 got ${res.status}`);

    // Claim should be released (deleted).
    const { json: read } = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(read.claim, null, "claim released after exhausted retries");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-14 retry: non-PK D1 errors are not retried and fail once", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const body = { note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] };
    const key = crypto.randomUUID();
    const failKey = crypto.randomUUID();
    const res = await orderFetch(cafe, body, key, "other", failKey);
    assert.equal(res.status, 500, `expected 500 got ${res.status}`);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-14 retry: dine-in path remains correct after retry", { skip }, async () => {
  const cafe = await seed("tables");
  try {
    const body = { tableId: 1, note: "hi", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 2 }] };
    const key = crypto.randomUUID();
    const failKey = crypto.randomUUID();
    const res = await orderFetch(cafe, body, key, "pk-once", failKey);
    assert.equal(res.status, 201);
    const { order } = await res.json();
    assert.equal(order.tableLabel, "Harness Table");
    assert.equal(order.queueNo, 1, "the retried attempt took exactly one daily number");
    assert.equal(order.items.length, 1);
    assert.equal(order.items[0].qty, 2);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-14 retry: counter path remains correct after retry", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const body = { note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] };
    const key = crypto.randomUUID();
    const failKey = crypto.randomUUID();
    const res = await orderFetch(cafe, body, key, "pk-once", failKey);
    assert.equal(res.status, 201);
    const { order } = await res.json();
    assert.ok(order.queueNo != null, "counter order gets a queue number");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-14 retry: idempotent replay behavior unchanged", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const body = { note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] };
    const key = crypto.randomUUID();
    const first = await orderFetch(cafe, body, key);
    assert.equal(first.status, 201);
    const { order: o1 } = await first.json();
    const second = await orderFetch(cafe, body, key);
    assert.equal(second.status, 200, "replay returns 200");
    const { order: o2 } = await second.json();
    assert.equal(o2.id, o1.id, "same order on replay");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("isOrderIdCollision unit", async () => {
  const { isOrderIdCollision } = await import("../worker/orderids.js");
  assert.equal(isOrderIdCollision(new Error("D1_ERROR: UNIQUE constraint failed: orders.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)")), true);
  assert.equal(isOrderIdCollision(new Error("UNIQUE constraint failed: orders.id")), true);
  assert.equal(isOrderIdCollision(new Error("D1_ERROR: UNIQUE constraint failed: orders.idempotency_key")), false);
  assert.equal(isOrderIdCollision(new Error("FOREIGN KEY constraint failed")), false);
  assert.equal(isOrderIdCollision(new Error("some unrelated failure")), false);
});
