// Deep ordering integration: the properties the existing suites leave untested.
//
// Covered elsewhere already: dine-in store/replay (orders.integration T5), abandonment (T6), id order
// exhaustion (T7), tracking authority and cross-café tokens (order.tracking), 40-line and body caps
// (body.limit), status workflow (status.transitions). Covered here: pickup numbering (sequential, per
// café, and under concurrency), server-side price and quantity authority, cross-tenant menu items,
// table validation, and idempotency-key scoping between tenants.
//
// Every order is synthetic and lives in the harness's disposable D1 directory. Nothing here touches a
// deployed environment.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const H = process.env.HARNESS_URL || "http://127.0.0.1:8789";
const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };

const ITEM_PRICE_CENTS = 10000; // tests/harness/worker.mjs seeds one item at this price

async function reachable(base, path, body) {
  try {
    const res = await fetch(`${base}${path}`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(1500),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}

const alive = await reachable(H, "/read", { cafeId: -1, key: "probe" });
const authAlive = await reachable(AUTH, "/primary");
const skip = alive ? false : `harness not reachable at ${H}`;
const authSkip = authAlive ? false : `auth harness not reachable at ${AUTH}`;

async function seed(base = H, options = {}) {
  const res = await fetch(`${base}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ serviceMode: "counter", ...options }),
  });
  assert.equal(res.status, 200, `/seed answered ${res.status}`);
  return res.json();
}

async function seedFor(base, options) {
  const res = await fetch(`${base}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(options),
  });
  assert.equal(res.status, 200, `/seed answered ${res.status}`);
  return res.json();
}

async function clean(cafe, base = H) {
  await fetch(`${base}/clean`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId: cafe.cafeId }),
  });
}

async function stored(base, cafe, key) {
  const res = await fetch(`${base}/read`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId: cafe.cafeId, key }),
  });
  assert.equal(res.status, 200, `/read answered ${res.status}`);
  return res.json();
}

function checkout(base, cafe, key, body) {
  return fetch(`${base}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers: { ...JSON_HEADERS, ...(key ? { "Idempotency-Key": key } : {}) },
    body: JSON.stringify(body),
  });
}

// One line at the seeded item's price, so totals are predictable.
function cart(cafe, qty = 1, extra = {}) {
  return { note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty }], ...extra };
}

test("counter orders receive sequential pickup numbers and no table", { skip }, async () => {
  const cafe = await seed();
  try {
    const numbers = [];
    for (let i = 0; i < 3; i += 1) {
      const key = crypto.randomUUID();
      const res = await checkout(H, cafe, key, cart(cafe));
      assert.equal(res.status, 201, `checkout ${i + 1} answered ${res.status}`);
      const { order, trackToken } = await res.json();

      assert.equal(order.tableId, null, "a counter order names no table");
      assert.equal(order.tableLabel, "Counter");
      assert.equal(order.totalCents, ITEM_PRICE_CENTS);
      assert.equal(order.paymentMethod, "counter");
      assert.equal(order.status, "new");
      assert.match(trackToken, /^[A-Za-z0-9_-]{43}$/);
      numbers.push(order.queueNo);

      const row = await stored(H, cafe, key);
      assert.equal(row.orders.length, 1);
      assert.equal(row.orders[0].table_id, 0, "counter orders use table_id 0");
    }

    assert.deepEqual(numbers, [1, 2, 3], "pickup numbers count up within the café");
    assert.equal(new Set(numbers).size, 3, "no number is handed out twice");
  } finally {
    await clean(cafe);
  }
});

test("pickup numbering is per café and absent for dine-in", { skip }, async () => {
  const cafeA = await seed();
  const cafeB = await seed();
  const dineIn = await seed(H, { serviceMode: "tables" });
  try {
    const a1 = (await checkout(H, cafeA, crypto.randomUUID(), cart(cafeA))).json();
    const a2 = (await checkout(H, cafeA, crypto.randomUUID(), cart(cafeA))).json();
    const b1 = (await checkout(H, cafeB, crypto.randomUUID(), cart(cafeB))).json();
    assert.equal((await a1).order.queueNo, 1);
    assert.equal((await a2).order.queueNo, 2);
    assert.equal((await b1).order.queueNo, 1, "café B starts its own run at 1");

    const tableOrder = await checkout(H, dineIn, crypto.randomUUID(), cart(dineIn, 1, { tableId: 1 }));
    assert.equal(tableOrder.status, 201);
    const { order } = await tableOrder.json();
    assert.equal(order.queueNo, null, "dine-in tickets never take a pickup number");
    assert.equal(order.tableId, 1, "the café-facing table number");
    assert.equal(order.tableLabel, "Harness Table");
  } finally {
    await clean(cafeA);
    await clean(cafeB);
    await clean(dineIn);
  }
});

test("pickup numbers stay unique under simultaneous checkouts", { skip }, async () => {
  const cafe = await seed();
  try {
    // Distinct idempotency keys, so these are five genuinely different orders racing for a number.
    const responses = await Promise.all(
      Array.from({ length: 5 }, () => checkout(H, cafe, crypto.randomUUID(), cart(cafe)))
    );

    const numbers = [];
    for (const res of responses) {
      assert.equal(res.status, 201, `concurrent checkout answered ${res.status}`);
      numbers.push((await res.json()).order.queueNo);
    }

    assert.equal(numbers.filter((n) => Number.isInteger(n)).length, 5, "every order got a number");
    assert.equal(new Set(numbers).size, 5, `no duplicate pickup number: ${numbers.join(",")}`);
    assert.deepEqual([...numbers].sort((a, b) => a - b), [1, 2, 3, 4, 5]);
  } finally {
    await clean(cafe);
  }
});

test("the server prices the cart and ignores client-supplied money", { skip }, async () => {
  const cafe = await seed();
  try {
    const key = crypto.randomUUID();
    const tampered = {
      note: "",
      paymentMethod: "counter",
      totalCents: 1,
      total_cents: 1,
      items: [{ itemId: cafe.itemId, qty: 2, priceCents: 1, price_cents: 1, name: "Free Lunch" }],
    };

    const res = await checkout(H, cafe, key, tampered);
    assert.equal(res.status, 201);
    const { order } = await res.json();

    assert.equal(order.totalCents, ITEM_PRICE_CENTS * 2, "2 × the stored menu price");
    assert.equal(order.paymentMethod, "counter");
    const line = order.items[0];
    assert.equal(line.priceCents, ITEM_PRICE_CENTS, "the stored price, not the client's");
    assert.equal(line.name, "Harness Item", "the stored name, not the client's");
    assert.equal(line.qty, 2);
  } finally {
    await clean(cafe);
  }
});

test("quantities are validated and bounded", { skip }, async () => {
  const cafe = await seed();
  try {
    for (const qty of [0, -1, -5]) {
      const res = await checkout(H, cafe, crypto.randomUUID(), cart(cafe, qty));
      assert.equal(res.status, 400, `qty ${qty} is refused`);
      assert.match(String((await res.json()).error), /valid|empty/i);
    }

    const nonsense = await checkout(H, cafe, crypto.randomUUID(), {
      note: "",
      paymentMethod: "counter",
      items: [{ itemId: cafe.itemId, qty: "two" }],
    });
    assert.equal(nonsense.status, 400);

    // The aggregator caps one line at 20, so an outsized quantity cannot inflate a ticket.
    const capped = await checkout(H, cafe, crypto.randomUUID(), cart(cafe, 50));
    assert.equal(capped.status, 201);
    const { order } = await capped.json();
    assert.equal(order.items[0].qty, 20, "the line is clamped to 20");
    assert.equal(order.totalCents, ITEM_PRICE_CENTS * 20);

    // Repeated lines for one item are aggregated before the same cap applies.
    const repeated = await checkout(H, cafe, crypto.randomUUID(), {
      note: "",
      paymentMethod: "counter",
      items: [
        { itemId: cafe.itemId, qty: 15 },
        { itemId: cafe.itemId, qty: 15 },
      ],
    });
    assert.equal(repeated.status, 201);
    const aggregate = (await repeated.json()).order;
    assert.equal(aggregate.items.length, 1, "one line for one item");
    assert.equal(aggregate.items[0].qty, 20);
  } finally {
    await clean(cafe);
  }
});

test("a cart cannot borrow another tenant's menu item", { skip }, async () => {
  const cafeA = await seed();
  const cafeB = await seed();
  try {
    const key = crypto.randomUUID();
    const res = await checkout(H, cafeA, key, {
      note: "",
      paymentMethod: "counter",
      items: [{ itemId: cafeB.itemId, qty: 1 }],
    });

    assert.equal(res.status, 400, "café B's item is not on café A's menu");
    assert.match(String((await res.json()).error), /no longer on the menu/i);

    const after = await stored(H, cafeA, key);
    assert.equal(after.orders.length, 0, "nothing was written");
    assert.equal(after.itemCount, 0);
    assert.equal(after.claim, null, "the claim was released for a clean retry");
  } finally {
    await clean(cafeA);
    await clean(cafeB);
  }
});

test("table and mode rules are enforced before anything is written", { skip }, async () => {
  const counter = await seed();
  const dineIn = await seed(H, { serviceMode: "tables" });
  try {
    const counterKey = crypto.randomUUID();
    const withTable = await checkout(H, counter, counterKey, cart(counter, 1, { tableId: 1 }));
    assert.equal(withTable.status, 400, "a counter café takes no table");
    assert.equal((await stored(H, counter, counterKey)).claim, null, "no claim was taken");

    const dineKey = crypto.randomUUID();
    const badTable = await checkout(H, dineIn, dineKey, cart(dineIn, 1, { tableId: 99 }));
    assert.equal(badTable.status, 400, "an unknown table number is refused");
    const after = await stored(H, dineIn, dineKey);
    assert.equal(after.orders.length, 0, "no order for a table that does not exist");
    assert.equal(after.claim, null, "the claim is handed back");
  } finally {
    await clean(counter);
    await clean(dineIn);
  }
});

test("idempotency keys are scoped to one café", { skip }, async () => {
  const cafeA = await seed();
  const cafeB = await seed();
  try {
    const sharedKey = crypto.randomUUID();
    const [a, b] = await Promise.all([
      checkout(H, cafeA, sharedKey, cart(cafeA)),
      checkout(H, cafeB, sharedKey, cart(cafeB)),
    ]);

    assert.equal(a.status, 201, "café A created its own order");
    assert.equal(b.status, 201, "the same key in another café is a different checkout");

    const [aBody, bBody] = [await a.json(), await b.json()];
    assert.notEqual(aBody.order.id, bBody.order.id);
    assert.equal((await stored(H, cafeA, sharedKey)).orders.length, 1);
    assert.equal((await stored(H, cafeB, sharedKey)).orders.length, 1);

    // A replay in the wrong café must not return the other tenant's order.
    const replayInB = await checkout(H, cafeB, sharedKey, cart(cafeB));
    assert.equal(replayInB.status, 200);
    assert.equal((await replayInB.json()).order.id, bBody.order.id);
  } finally {
    await clean(cafeA);
    await clean(cafeB);
  }
});

test("an order id cannot be used to mutate staff-only state", { skip: authSkip }, async () => {
  const cafe = await seedFor(AUTH, { serviceMode: "counter", password: "deep-suite-owner-password" });
  try {
    const created = await checkout(AUTH, cafe, crypto.randomUUID(), cart(cafe));
    assert.equal(created.status, 201);
    const { order, trackToken } = await created.json();

    const path = `${AUTH}/api/cafes/${cafe.slug}/admin/orders/${order.id}`;

    const anonymous = await fetch(path, {
      method: "PATCH",
      headers: JSON_HEADERS,
      body: JSON.stringify({ status: "preparing" }),
    });
    assert.equal(anonymous.status, 401, "no staff session, no status change");

    const forged = await fetch(path, {
      method: "PATCH",
      headers: { ...JSON_HEADERS, cookie: `staff_session_${cafe.slug}=1.cafe%3A${cafe.cafeId}.forged` },
      body: JSON.stringify({ status: "preparing" }),
    });
    assert.equal(forged.status, 401, "a forged cookie does not authorise a mutation");

    // Even holding the guest's own token must not reach the staff surface.
    const guestToken = await fetch(path, {
      method: "PATCH",
      headers: { ...JSON_HEADERS, "x-order-token": trackToken },
      body: JSON.stringify({ status: "preparing" }),
    });
    assert.equal(guestToken.status, 401, "a tracking token is not a staff session");

    const guestRead = await fetch(`${AUTH}/api/cafes/${cafe.slug}/orders/${order.id}`, {
      headers: { "x-order-token": trackToken },
    });
    assert.equal(guestRead.status, 200);
    assert.equal((await guestRead.json()).order.status, "new", "the order never moved");
  } finally {
    await clean(cafe, AUTH);
  }
});
