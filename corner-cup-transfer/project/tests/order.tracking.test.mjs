// F-02 / F-03 regression suite: the per-order guest tracking capability.
//
// Before this change an order id was the whole credential: `GET /api/cafes/:slug/orders/:id` answered
// anyone who could guess six characters, and the same id could flip an order to pay-at-counter. Now a
// guest must present a token issued once at checkout, carried in the URL fragment and sent as a header.
//
// The tests below cover the HTTP contract (id alone, missing, wrong, cross-café, cross-order, payment
// selection, no self-confirmation, staff responses, what D1 actually stores, replay and concurrency,
// legacy rows) plus two unit checks that need no server. They run against the local harnesses and skip
// without them.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { trackHash, trackToken, trackingConfigured } from "../worker/tracking.js";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const H = process.env.HARNESS_URL || "http://127.0.0.1:8789";
const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };
const NOT_FOUND = { error: "We couldn't find that order." };
const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

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

async function clean(cafe, base = H) {
  await fetch(`${base}/clean`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId: cafe.cafeId }),
  });
}

function place(cafe, key, base = H) {
  return fetch(`${base}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "Idempotency-Key": key },
    body: JSON.stringify({ note: "", paymentMethod: "counter", items: [{ itemId: cafe.itemId, qty: 1 }] }),
  });
}

async function created(cafe, key, base = H) {
  const res = await place(cafe, key, base);
  assert.equal(res.status, 201, `checkout answered ${res.status}`);
  return res.json();
}

// `token === undefined` sends no header at all, which is what a bare order id looks like.
function readOrder(cafe, orderId, token, base = H) {
  return fetch(`${base}/api/cafes/${cafe.slug}/orders/${encodeURIComponent(orderId)}`, {
    headers: token === undefined ? {} : { "x-order-token": token },
  });
}

function payFor(cafe, orderId, token, status, base = H) {
  return fetch(`${base}/api/cafes/${cafe.slug}/orders/${encodeURIComponent(orderId)}/payment`, {
    method: "POST",
    headers: token === undefined ? JSON_HEADERS : { ...JSON_HEADERS, "x-order-token": token },
    body: JSON.stringify({ status }),
  });
}

async function rawOrder(cafe, orderId) {
  const res = await fetch(`${H}/order-raw`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId: cafe.cafeId, orderId }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).order;
}

/* --------------------------------------------------------------- the token */

test("the token is derived, URL safe, and needs a configured key", async () => {
  assert.equal(trackingConfigured({}), false, "no secret means no tracking");
  assert.equal(trackingConfigured({ ADMIN_SECRET: "a" }), true);
  assert.equal(trackingConfigured({ ORDER_TRACK_SECRET: "b" }), true);

  const env = { ADMIN_SECRET: "unit-test-tracking-secret" };
  const one = await trackToken(env, { cafeId: 1, orderId: "ABCDEF", nonce: "nonce-one" });
  const same = await trackToken(env, { cafeId: 1, orderId: "ABCDEF", nonce: "nonce-one" });
  const otherOrder = await trackToken(env, { cafeId: 1, orderId: "ABCDFG", nonce: "nonce-one" });
  const otherCafe = await trackToken(env, { cafeId: 2, orderId: "ABCDEF", nonce: "nonce-one" });
  const otherNonce = await trackToken(env, { cafeId: 1, orderId: "ABCDEF", nonce: "nonce-two" });

  assert.match(one, TOKEN_SHAPE, "43 URL-safe characters, no padding");
  assert.equal(one, same, "replay derives the same token");
  assert.notEqual(one, otherOrder, "the order is part of the message");
  assert.notEqual(one, otherCafe, "the café is part of the message");
  assert.notEqual(one, otherNonce, "a different nonce gives a different token");
  assert.equal(await trackToken({}, { cafeId: 1, orderId: "ABCDEF", nonce: "n" }), null, "no key, no token");
  assert.equal(await trackToken(env, { cafeId: 1, orderId: "ABCDEF", nonce: "" }), null, "no nonce, no token");
});

/* ---------------------------------------------------------- reading an order */

test("an order id alone cannot read an order", { skip }, async (t) => {
  const cafe = await seed();
  try {
    const { order, trackToken: token } = await created(cafe, crypto.randomUUID());
    assert.match(token, TOKEN_SHAPE, "checkout hands the guest a token");

    await t.test("no token is a generic 404", async () => {
      const res = await readOrder(cafe, order.id);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), NOT_FOUND, "nothing says whether the id exists");
    });

    await t.test("an empty token is refused", async () => {
      const res = await readOrder(cafe, order.id, "");
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), NOT_FOUND);
    });

    await t.test("a wrong token is refused, with the same body", async () => {
      for (const wrong of ["x".repeat(43), token.slice(0, -1) + (token.endsWith("A") ? "B" : "A"), "not-a-token"]) {
        const res = await readOrder(cafe, order.id, wrong);
        assert.equal(res.status, 404);
        assert.deepEqual(await res.json(), NOT_FOUND);
      }
    });

    await t.test("an unknown id with a well-formed token answers identically", async () => {
      const res = await readOrder({ ...cafe, slug: cafe.slug }, "ZZZZZZ", token);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), NOT_FOUND, "a real token does not confirm a foreign id");
    });

    await t.test("the right token returns exactly that order", async () => {
      const res = await readOrder(cafe, order.id, token);
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.order.id, order.id);
      assert.equal(payload.order.totalCents, order.totalCents);
      assert.deepEqual(payload.order.items, order.items);
      assert.equal(payload.order.queueNo, order.queueNo);
      assert.ok(!("trackToken" in payload), "reading an order never re-echoes the token");
      assert.ok(!JSON.stringify(payload).includes("track_hash"));
    });
  } finally {
    await clean(cafe);
  }
});

test("a token is bound to its own café and its own order", { skip }, async (t) => {
  const cafeA = await seed();
  const cafeB = await seed();
  try {
    const first = await created(cafeA, crypto.randomUUID());
    const second = await created(cafeA, crypto.randomUUID());
    const other = await created(cafeB, crypto.randomUUID());

    await t.test("café A's token cannot read café B's order", async () => {
      const res = await readOrder(cafeB, other.order.id, first.trackToken);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), NOT_FOUND);
    });

    await t.test("a token cannot read a different order in the same café", async () => {
      const res = await readOrder(cafeA, second.order.id, first.trackToken);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), NOT_FOUND);
    });

    await t.test("each order received its own token", async () => {
      assert.notEqual(first.trackToken, second.trackToken);
      assert.notEqual(first.trackToken, other.trackToken);
      assert.equal((await readOrder(cafeB, other.order.id, other.trackToken)).status, 200);
    });
  } finally {
    await clean(cafeA);
    await clean(cafeB);
  }
});

/* --------------------------------------------------------------- the payment */

test("paying at the counter needs the token and can never mark an order paid", { skip }, async (t) => {
  const cafe = await seed();
  try {
    const first = await created(cafe, crypto.randomUUID());
    const second = await created(cafe, crypto.randomUUID());

    await t.test("the id alone cannot change payment state", async () => {
      const res = await payFor(cafe, first.order.id, undefined, "counter");
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), NOT_FOUND);
      assert.equal((await rawOrder(cafe, first.order.id)).payment_status, "unpaid", "nothing changed");
    });

    await t.test("a wrong token cannot change payment state", async () => {
      const res = await payFor(cafe, first.order.id, "y".repeat(43), "counter");
      assert.equal(res.status, 404);
      assert.equal((await rawOrder(cafe, first.order.id)).payment_status, "unpaid");
    });

    await t.test("the right token still allows pay-at-counter", async () => {
      const res = await payFor(cafe, first.order.id, first.trackToken, "counter");
      assert.equal(res.status, 200);
      assert.equal((await res.json()).paymentStatus, "counter");
      const stored = await rawOrder(cafe, first.order.id);
      assert.equal(stored.payment_status, "counter");
      assert.equal(stored.payment_method, "counter");
    });

    await t.test("a guest cannot confirm a payment", async () => {
      const res = await payFor(cafe, second.order.id, second.trackToken, "confirmed");
      assert.equal(res.status, 400, "only the counter choice is accepted");
      const stored = await rawOrder(cafe, second.order.id);
      assert.equal(stored.payment_status, "unpaid", "the order is not marked paid");
      assert.equal(stored.paid_at ?? null, null);
    });
  } finally {
    await clean(cafe);
  }
});

/* --------------------------------------------------------- what D1 keeps */

test("D1 stores the nonce and a hash, never the token itself", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken: token } = await created(cafe, crypto.randomUUID());
    const row = await rawOrder(cafe, order.id);

    assert.equal(row.track_hash, await trackHash(token), "the stored value is sha256(token)");
    assert.equal(String(row.track_hash).length, 64);
    assert.ok(row.track_nonce && row.track_nonce !== token, "the nonce is not the token");
    assert.ok(!JSON.stringify(row).includes(token), "no column contains the plaintext token");
  } finally {
    await clean(cafe);
  }
});

/* ------------------------------------------------------- replay/concurrency */

test("a checkout retry returns the same working token", { skip }, async (t) => {
  const cafe = await seed();
  try {
    const key = crypto.randomUUID();
    const first = await created(cafe, key);

    await t.test("the sequential replay is the same order and token", async () => {
      const res = await place(cafe, key);
      assert.equal(res.status, 200, "a committed key replays");
      const again = await res.json();
      assert.equal(again.order.id, first.order.id);
      assert.equal(again.trackToken, first.trackToken, "recomputed, not remembered");
      assert.equal((await readOrder(cafe, again.order.id, again.trackToken)).status, 200);
    });

    await t.test("concurrent retries agree on one order and one token", async () => {
      const raceKey = crypto.randomUUID();
      const results = await Promise.all([place(cafe, raceKey), place(cafe, raceKey), place(cafe, raceKey)]);
      const payloads = [];
      for (const res of results) {
        assert.ok([200, 201].includes(res.status), `race answered ${res.status}`);
        payloads.push(await res.json());
      }
      const ids = new Set(payloads.map((p) => p.order.id));
      assert.equal(ids.size, 1, "one order");
      const tokens = new Set(payloads.map((p) => p.trackToken));
      assert.equal(tokens.size, 1, "one token");
      assert.equal((await readOrder(cafe, [...ids][0], [...tokens][0])).status, 200, "and it works");
    });
  } finally {
    await clean(cafe);
  }
});

/* ---------------------------------------------------------- legacy orders */

test("an order created before tracking existed fails closed", { skip }, async (t) => {
  const cafe = await seed();
  const legacyId = `LEG${Date.now().toString(36).toUpperCase().slice(-7)}`;
  try {
    const res = await fetch(`${H}/legacy-order`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ cafeId: cafe.cafeId, orderId: legacyId }),
    });
    assert.equal(res.status, 200);
    assert.equal((await rawOrder(cafe, legacyId)).track_hash, null, "no tracking data");

    await t.test("the id alone reads nothing", async () => {
      const read = await readOrder(cafe, legacyId);
      assert.equal(read.status, 404);
      assert.deepEqual(await read.json(), NOT_FOUND);
    });

    await t.test("no token can be minted for it", async () => {
      // Derived with the harness's real key, so this is the strongest possible forgery attempt.
      const guessed = await trackToken(
        { ORDER_TRACK_SECRET: "test-order-track-secret-for-harness-only" },
        { cafeId: cafe.cafeId, orderId: legacyId, nonce: "anything" }
      );
      const read = await readOrder(cafe, legacyId, guessed);
      assert.equal(read.status, 404, "a derived token cannot stand in for one that was never issued");
    });

    await t.test("its payment state cannot be changed either", async () => {
      const res = await payFor(cafe, legacyId, "z".repeat(43), "counter");
      assert.equal(res.status, 404);
      assert.equal((await rawOrder(cafe, legacyId)).payment_status, "unpaid");
    });
  } finally {
    await clean(cafe);
  }
});

/* ---------------------------------------------------------- staff surfaces */

test("staff APIs never expose a tracking token", { skip: authSkip }, async (t) => {
  const cafe = await seed(AUTH);
  try {
    const { order, trackToken: token } = await created(cafe, crypto.randomUUID(), AUTH);

    const login = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: HARNESS_OWNER_PASSWORD }),
    });
    assert.equal(login.status, 200, "the owner signs in with the café's own password");
    const cookie = (login.headers.getSetCookie?.() || [])[0]?.split(";")[0] || "";

    await t.test("the order board carries no token and no tracking columns", async () => {
      const res = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/orders`, { headers: { cookie } });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes(token), "the token is absent from the board");
      assert.ok(!/track_?(token|hash|nonce)/i.test(text), "no tracking column is exposed");
      assert.ok(text.includes(order.id), "the order itself is there, as staff need it");
    });

    await t.test("a status change answers without one", async () => {
      const res = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/orders/${order.id}`, {
        method: "PATCH",
        headers: { ...JSON_HEADERS, cookie },
        body: JSON.stringify({ status: "preparing" }),
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(!text.includes(token) && !/track_?(token|hash|nonce)/i.test(text));
    });

    await t.test("the token was still the only way for the guest to read it", async () => {
      assert.equal((await readOrder(cafe, order.id, token, AUTH)).status, 200);
      assert.equal((await readOrder(cafe, order.id, undefined, AUTH)).status, 404);
    });
  } finally {
    await clean(cafe, AUTH);
  }
});
