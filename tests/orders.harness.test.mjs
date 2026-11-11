// Batch-harness tests. They run the production statements through a real env.DB.batch() inside the
// harness Worker in tests/harness, on their own persistence directory. Skipped when it is not
// running, so `npm test` stays green without it.

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

async function seed(serviceMode) {
  const cafe = await call("/seed", { serviceMode });
  return cafe;
}

async function cleanup(cafeId) {
  await call("/clean", { cafeId });
}

function item(menuItemId, qty = 1) {
  return { menuItemId, name: "Harness Item", emoji: "🧪", priceCents: 10000, qty };
}

test("T1: an abandoned key cannot insert an order, in a real batch", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const key = crypto.randomUUID();
    const fingerprint = "fp-t1";

    const claimed = await call("/claim", { cafeId: cafe.cafeId, key, fingerprint, lease: "lease-A" });
    assert.equal(claimed.changes, 1);
    assert.equal(claimed.claim.state, "claimed");

    const abandoned = await call("/abandon", { cafeId: cafe.cafeId, key, fingerprint });
    assert.equal(abandoned.claim.state, "abandoned");

    const run = await call("/batch", {
      cafeId: cafe.cafeId,
      key,
      fingerprint,
      lease: "lease-A",
      id: "T1ORD1",
      counter: true,
      tableId: 0,
      tableLabel: "Counter",
      note: "",
      totalCents: 10000,
      paymentMethod: "razorpay",
      dayStart: new Date(0).toISOString(),
      items: [item(cafe.itemId)],
    });

    assert.equal(run.ok, true, "the batch resolves; the guard simply writes nothing");
    assert.deepEqual(run.changes, [0, 0, 0], "order, item and commit were all suppressed");

    const after = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(after.orders.length, 0);
    assert.equal(after.itemCount, 0);
    assert.equal(after.claim.state, "abandoned");
  } finally {
    await cleanup(cafe.cafeId);
  }
});

test("T2: a claimed key commits the order, its items and the claim in one batch", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const key = crypto.randomUUID();
    const fingerprint = "fp-t2";
    await call("/claim", { cafeId: cafe.cafeId, key, fingerprint, lease: "lease-B" });

    const run = await call("/batch", {
      cafeId: cafe.cafeId,
      key,
      fingerprint,
      lease: "lease-B",
      id: "T2ORD1",
      counter: true,
      tableId: 0,
      tableLabel: "Counter",
      note: "",
      totalCents: 20000,
      paymentMethod: "razorpay",
      dayStart: new Date(0).toISOString(),
      items: [item(cafe.itemId, 1), item(cafe.itemId, 2)],
    });

    assert.equal(run.ok, true);
    assert.deepEqual(run.changes, [1, 1, 1, 1], "order, two items, commit marker");

    const after = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(after.orders.length, 1);
    assert.equal(after.itemCount, 2);
    assert.equal(after.claim.state, "committed");
    assert.equal(after.claim.order_id, "T2ORD1");
    assert.equal(after.orders[0].queue_no, 1, "pickup number allocated exactly once");
  } finally {
    await cleanup(cafe.cafeId);
  }
});

test("T3: a failing item insert rolls back the order and the commit", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const key = crypto.randomUUID();
    const fingerprint = "fp-t3";
    await call("/claim", { cafeId: cafe.cafeId, key, fingerprint, lease: "lease-C" });

    const run = await call("/batch", {
      cafeId: cafe.cafeId,
      key,
      fingerprint,
      lease: "lease-C",
      id: "T3ORD1",
      counter: true,
      tableId: 0,
      tableLabel: "Counter",
      note: "",
      totalCents: 10000,
      paymentMethod: "razorpay",
      dayStart: new Date(0).toISOString(),
      items: [item(cafe.itemId)],
      failItem: true,
    });

    assert.equal(run.ok, false, `the batch rejects: ${run.error}`);
    assert.match(String(run.error), /NOT NULL|constraint/i, "the failure is the forced item constraint");

    const after = await call("/read", { cafeId: cafe.cafeId, key });
    assert.equal(after.orders.length, 0, "the order insert rolled back");
    assert.equal(after.itemCount, 0, "no item rows survived");
    assert.equal(after.claim.state, "claimed", "S7 rolled back with S5 and S6");

    const released = await call("/release", { cafeId: cafe.cafeId, key, lease: "lease-C" });
    assert.equal(released.changes, 1, "the owner handed the key back");
    assert.equal(released.claim, null);

    const again = await call("/release", { cafeId: cafe.cafeId, key, lease: "lease-C" });
    assert.equal(again.changes, 0, "releasing twice is a no-op");
  } finally {
    await cleanup(cafe.cafeId);
  }
});

test("T3b: a colliding order id never receives another checkout's items", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const mine = "T3BORD1";
    const fingerprint = "fp-t3b";

    // An unrelated order that already owns this id, under a different key.
    await call("/claim", { cafeId: cafe.cafeId, key: "other-key", fingerprint: "fp-other", lease: "lease-other" });
    await call("/batch", {
      cafeId: cafe.cafeId,
      key: "other-key",
      fingerprint: "fp-other",
      lease: "lease-other",
      id: mine,
      counter: true,
      tableId: 0,
      tableLabel: "Counter",
      note: "",
      totalCents: 10000,
      paymentMethod: "razorpay",
      dayStart: new Date(0).toISOString(),
      items: [item(cafe.itemId)],
    });

    const key = crypto.randomUUID();
    await call("/claim", { cafeId: cafe.cafeId, key, fingerprint, lease: "lease-D" });
    await call("/abandon", { cafeId: cafe.cafeId, key, fingerprint });

    const run = await call("/batch", {
      cafeId: cafe.cafeId,
      key,
      fingerprint,
      lease: "lease-D",
      id: mine,
      counter: true,
      tableId: 0,
      tableLabel: "Counter",
      note: "",
      totalCents: 10000,
      paymentMethod: "razorpay",
      dayStart: new Date(0).toISOString(),
      items: [item(cafe.itemId)],
    });

    assert.deepEqual(run.changes, [0, 0, 0], "still suppressed even with a colliding id");

    const other = await call("/read", { cafeId: cafe.cafeId, key: "other-key" });
    assert.equal(other.itemCount, 1, "the unrelated order kept exactly its own item");
  } finally {
    await cleanup(cafe.cafeId);
  }
});
