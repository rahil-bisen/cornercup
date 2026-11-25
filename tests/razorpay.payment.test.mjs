// F-09: creating a Razorpay payment order is a guest action, so it must be gated by the same tracking
// capability as reading the order, must take amount and currency only from the stored row, must refuse
// ineligible tickets, and must be bounded so a repeated request cannot mint gateway orders in a loop.
//
// These run against the auth-enabled harness through a test-only /razorpay-probe route, which mounts
// the real handleApi with Razorpay credentials supplied for that one request and a stubbed gateway.
// The deployed harness env keeps online payments off, so no other suite sees a configured gateway and
// no request leaves the machine.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import http from "node:http";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const HARNESS = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const KEY_ID = "rzp_test_harness";
const KEY_SECRET = "harness-razorpay-secret";
const jsonHeaders = { "content-type": "application/json" };

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/read`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ cafeId: -1, key: "probe" }),
  });
  alive = probe.status === 200;
} catch {
  alive = false;
}

const skip = alive ? false : `auth harness not reachable at ${HARNESS}`;

async function seed(body = {}) {
  const res = await fetch(`${HARNESS}/seed`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ serviceMode: "counter", ...body }),
  });
  assert.equal(res.status, 200, "seed failed");
  return res.json();
}

const clean = (cafeId) =>
  fetch(`${HARNESS}/clean`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ cafeId }) });

// A real checkout, so the order and its tracking token come from the production path.
async function createOrder(cafe, overrides = {}) {
  const res = await fetch(`${HARNESS}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers: { ...jsonHeaders, origin: HARNESS, "idempotency-key": crypto.randomUUID() },
    body: JSON.stringify({ paymentMethod: "razorpay", items: [{ itemId: cafe.itemId, qty: 1 }], ...overrides }),
  });
  assert.equal(res.status, 201, "order creation should succeed");
  return res.json();
}

// Runs the real handler with Razorpay configured and the gateway stubbed.
async function probe(payload) {
  const res = await fetch(`${HARNESS}/razorpay-probe`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200, "probe route failed");
  return res.json();
}

const paymentPath = (slug, orderId, query = "") =>
  `/api/cafes/${slug}/orders/${orderId}/payment/razorpay${query}`;

const createPayment = (cafe, orderId, { token, query = "", extra = {} } = {}) =>
  probe({
    path: paymentPath(cafe.slug, orderId, query),
    method: "POST",
    headers: { ...(token === undefined ? {} : { "x-order-token": token }) },
    body: {},
    ...extra,
  });

const setOrderState = (cafeId, orderId, patch) =>
  fetch(`${HARNESS}/order-state`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ cafeId, orderId, ...patch }),
  }).then((res) => res.json());

function hex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function signature(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return hex(new Uint8Array(mac));
}

/* ------------------------------------------------------------------ capability */

test("F-09: an order id alone cannot create a payment order", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order } = await createOrder(cafe);

    const res = await createPayment(cafe, order.id);
    assert.equal(res.status, 404, "no token, no payment order");
    assert.equal(res.gateway.length, 0, "the gateway is never called");
    assert.deepEqual(res.body, { error: "We couldn't find that order." }, "one generic answer, no id confirmation");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: an invalid token is not a capability", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order } = await createOrder(cafe);

    const res = await createPayment(cafe, order.id, { token: "not-a-real-token" });
    assert.equal(res.status, 404);
    assert.equal(res.gateway.length, 0);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: a token is refused when placed in the query string instead of the header", { skip }, async () => {
  const cafe = await seed();
  try {
    const first = await createOrder(cafe);

    const res = await createPayment(cafe, first.order.id, { query: `?token=${encodeURIComponent(first.trackToken)}` });
    assert.equal(res.status, 404, "a URL is logged and shared; only the header is read");
    assert.equal(res.gateway.length, 0);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: another order's token does not authorise this order", { skip }, async () => {
  const cafe = await seed();
  try {
    const first = await createOrder(cafe);
    const second = await createOrder(cafe);

    const res = await createPayment(cafe, second.order.id, { token: first.trackToken });
    assert.equal(res.status, 404);
    assert.equal(res.gateway.length, 0);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: another café's token does not authorise this order", { skip }, async () => {
  const cafeA = await seed();
  const cafeB = await seed();
  try {
    const orderA = await createOrder(cafeA);
    const orderB = await createOrder(cafeB);

    const crossed = await createPayment(cafeB, orderB.order.id, { token: orderA.trackToken });
    assert.equal(crossed.status, 404, "tenant isolation holds");
    assert.equal(crossed.gateway.length, 0);

    // Even with its own valid token, an order is never reachable through another café's route.
    const wrongRoute = await createPayment(cafeA, orderB.order.id, { token: orderB.trackToken });
    assert.equal(wrongRoute.status, 404);
  } finally {
    await clean(cafeA.cafeId);
    await clean(cafeB.cafeId);
  }
});

/* ------------------------------------------------------- amount and currency */

test("F-09: a valid token creates a gateway order for the stored amount", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe, { items: [{ itemId: cafe.itemId, qty: 2 }] });

    const res = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(res.status, 200);

    assert.equal(res.gateway.length, 1);
    assert.equal(res.gateway[0].method, "POST");
    assert.equal(res.gateway[0].hasAuth, true, "the gateway call is authenticated");
    assert.ok(res.gateway[0].url.endsWith("/v1/orders"), "the gateway order endpoint is used");

    const sent = JSON.parse(res.gateway[0].body);
    assert.equal(sent.amount, 20000, "the stored total, which is 2 x 10000");
    assert.equal(sent.currency, "INR");
    assert.equal(String(sent.receipt), String(order.id));

    assert.equal(res.body.payment.amount, 20000);
    assert.equal(res.body.payment.currency, "INR");
    assert.equal(res.body.payment.keyId, KEY_ID, "only the public key id is returned");
    assert.ok(res.body.payment.razorpayOrderId, "a gateway order id comes back");

    assert.ok(
      !JSON.stringify(res.body).includes(KEY_SECRET),
      "the key secret never reaches the client"
    );
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: client-supplied amount and currency are ignored", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);

    const res = await probe({
      path: paymentPath(cafe.slug, order.id, "?amount=1&currency=USD"),
      method: "POST",
      headers: { "x-order-token": trackToken },
      body: { amount: 1, currency: "USD", totalCents: 1 },
    });

    assert.equal(res.status, 200);
    const sent = JSON.parse(res.gateway[0].body);
    assert.equal(sent.amount, order.totalCents, "the charge comes from the row, not the request");
    assert.equal(sent.currency, "INR");
    assert.equal(res.body.payment.amount, order.totalCents);
    assert.equal(res.body.payment.currency, "INR");
  } finally {
    await clean(cafe.cafeId);
  }
});

/* ------------------------------------------------------------- retries, state */

test("F-09: a retry reuses the gateway order instead of creating a second one", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);

    const first = await createPayment(cafe, order.id, { token: trackToken });
    const second = await createPayment(cafe, order.id, { token: trackToken });

    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(
      second.body.payment.razorpayOrderId,
      first.body.payment.razorpayOrderId,
      "the same gateway order comes back"
    );
    assert.equal(first.gateway.length + second.gateway.length, 1, "the gateway was called once");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: an already-paid order is refused", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);
    await setOrderState(cafe.cafeId, order.id, { paymentStatus: "confirmed" });

    const res = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /already paid/i);
    assert.equal(res.gateway.length, 0, "no new payable artefact is created");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: a cancelled order is refused", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);
    await setOrderState(cafe.cafeId, order.id, { status: "cancelled" });

    const res = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(res.status, 409);
    assert.match(res.body.error, /cancelled/i);
    assert.equal(res.gateway.length, 0);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: repeated payment-order creation is bounded per order", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);

    let last;
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      last = await createPayment(cafe, order.id, { token: trackToken });
      assert.equal(last.status, 200, `attempt ${attempt} is allowed`);
    }

    const blocked = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(blocked.status, 429, "the eleventh attempt is refused");
    assert.match(blocked.body.error, /too many payment attempts/i);
    assert.equal(blocked.gateway.length, 0, "a throttled attempt never reaches the gateway");
    assert.equal(last.gateway.length, 0, "later attempts reuse the gateway order");

    // The budget is per order, so a different ticket from the same café is unaffected.
    const other = await createOrder(cafe);
    const unaffected = await createPayment(cafe, other.order.id, { token: other.trackToken });
    assert.equal(unaffected.status, 200);
  } finally {
    await clean(cafe.cafeId);
  }
});

/* ------------------------------------------------- verification and settlement */

test("F-09: verification still refuses a bad signature and a foreign gateway order", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);
    const created = await createPayment(cafe, order.id, { token: trackToken });
    const razorpayOrderId = created.body.payment.razorpayOrderId;
    const paymentId = "pay_harness_1";

    const forged = await probe({
      path: `/api/cafes/${cafe.slug}/orders/${order.id}/payment/razorpay/verify`,
      body: {
        razorpay_order_id: razorpayOrderId,
        razorpay_payment_id: paymentId,
        razorpay_signature: await signature("wrong-secret", `${razorpayOrderId}|${paymentId}`),
      },
      gateway: { response: { id: paymentId, order_id: razorpayOrderId, status: "captured", amount: order.totalCents, currency: "INR" } },
    });
    assert.equal(forged.status, 400, "a signature from another secret is refused");

    const foreign = await probe({
      path: `/api/cafes/${cafe.slug}/orders/${order.id}/payment/razorpay/verify`,
      body: {
        razorpay_order_id: "order_someone_else",
        razorpay_payment_id: paymentId,
        razorpay_signature: await signature(KEY_SECRET, `order_someone_else|${paymentId}`),
      },
    });
    assert.equal(foreign.status, 409, "a payment for another gateway order is refused");

  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: an amount or currency mismatch leaves the order unpaid", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);
    const created = await createPayment(cafe, order.id, { token: trackToken });
    const razorpayOrderId = created.body.payment.razorpayOrderId;

    const verify = async (paymentId, payment) =>
      probe({
        path: `/api/cafes/${cafe.slug}/orders/${order.id}/payment/razorpay/verify`,
        body: {
          razorpay_order_id: razorpayOrderId,
          razorpay_payment_id: paymentId,
          razorpay_signature: await signature(KEY_SECRET, `${razorpayOrderId}|${paymentId}`),
        },
        gateway: { response: payment },
      });

    const short = await verify("pay_short", {
      id: "pay_short",
      order_id: razorpayOrderId,
      status: "captured",
      amount: order.totalCents - 100,
      currency: "INR",
    });
    assert.equal(short.status, 200);
    assert.equal(short.body.paymentStatus, "unpaid", "a short payment does not settle the ticket");
    assert.equal(short.body.reason, "amount-mismatch");

    const wrongCurrency = await verify("pay_usd", {
      id: "pay_usd",
      order_id: razorpayOrderId,
      status: "captured",
      amount: order.totalCents,
      currency: "USD",
    });
    assert.equal(wrongCurrency.status, 200);
    assert.equal(wrongCurrency.body.paymentStatus, "unpaid");
    assert.equal(wrongCurrency.body.reason, "currency-mismatch");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: a verified, captured payment still settles the order exactly once", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);
    const created = await createPayment(cafe, order.id, { token: trackToken });
    const razorpayOrderId = created.body.payment.razorpayOrderId;
    const paymentId = "pay_good";

    // The signature has to be computed after the ids are known; build it once.
    const goodSignature = await signature(KEY_SECRET, `${razorpayOrderId}|${paymentId}`);
    const once = await probe({
      path: `/api/cafes/${cafe.slug}/orders/${order.id}/payment/razorpay/verify`,
      body: { razorpay_order_id: razorpayOrderId, razorpay_payment_id: paymentId, razorpay_signature: goodSignature },
      gateway: { response: { id: paymentId, order_id: razorpayOrderId, status: "captured", amount: order.totalCents, currency: "INR" } },
    });
    assert.equal(once.status, 200);
    assert.equal(once.body.paymentStatus, "confirmed");

    const state = await setOrderState(cafe.cafeId, order.id, {});
    assert.equal(state.order.payment_status, "confirmed", "the ticket is paid");
    assert.equal(state.order.payment_ref, razorpayOrderId);
    assert.equal(state.order.payment_method, "razorpay");

    // A second confirmation is a no-op that still answers confirmed; it cannot settle twice.
    const again = await probe({
      path: `/api/cafes/${cafe.slug}/orders/${order.id}/payment/razorpay/verify`,
      body: { razorpay_order_id: razorpayOrderId, razorpay_payment_id: paymentId, razorpay_signature: goodSignature },
    });
    assert.equal(again.status, 200);
    assert.equal(again.body.paymentStatus, "confirmed");
    assert.equal(again.gateway.length, 0, "no gateway call is needed once paid");
  } finally {
    await clean(cafe.cafeId);
  }
});

/* ------------------------------------------------------ concurrency and claims */

// Polls the harness until the named gate has a request waiting inside the stubbed gateway.
async function waitForGate(name) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const res = await fetch(`${HARNESS}/gate`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ name }),
    });
    const { entered } = await res.json();
    if (entered > 0) return entered;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`gate ${name} was never entered`);
}

// The harness gateway stub parks on this local server, so a request can be held between the gateway
// call and the write that follows it. The stall is real I/O, which is what keeps the Workers runtime
// from cancelling the request, and the test decides exactly when it continues.
const heldRequests = new Map();
let holdServer = null;
let holdBase = "";

async function startHoldServer() {
  if (holdServer) return holdBase;
  holdServer = http.createServer((req, res) => {
    const name = new URL(req.url, "http://127.0.0.1").searchParams.get("name") || "default";
    heldRequests.set(name, () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("released");
    });
  });
  await new Promise((resolve) => holdServer.listen(0, "127.0.0.1", resolve));
  holdBase = `http://127.0.0.1:${holdServer.address().port}/hold`;
  return holdBase;
}

function releaseHold(name) {
  const release = heldRequests.get(name);
  assert.ok(release, `nothing is held at ${name}`);
  heldRequests.delete(name);
  release();
}

async function stopHoldServer() {
  if (!holdServer) return;
  const server = holdServer;
  holdServer = null;
  await new Promise((resolve) => server.close(resolve));
}

async function rateRow(payload) {
  const res = await fetch(`${HARNESS}/rate-row`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify(payload),
  });
  assert.equal(res.status, 200, "rate-row route failed");
  return res.json();
}

test("F-09: two simultaneous requests cannot create two gateway orders", { skip }, async () => {
  const base = await startHoldServer();
  const cafe = await seed();
  const gate = `race-${crypto.randomUUID()}`;
  try {
    const { order, trackToken } = await createOrder(cafe);

    // The first request is held inside the gateway call, before it can persist payment_ref.
    const first = createPayment(cafe, order.id, {
      token: trackToken,
      extra: { gateUrl: `${base}?name=${gate}`, gateName: gate },
    });
    await waitForGate(gate);

    // The second request is a fully valid duplicate: same token, same order, same moment.
    const second = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(second.status, 409, "the overlapping request is told to retry, not given a second order");
    assert.equal(second.gateway.length, 0, "it never reaches the gateway");
    assert.match(second.body.error, /already being prepared/i);

    releaseHold(gate);
    const firstResult = await first;
    assert.equal(firstResult.status, 200);
    assert.equal(firstResult.gateway.length, 1, "exactly one gateway order was created");
    const createdId = firstResult.body.payment.razorpayOrderId;
    assert.ok(createdId);

    // Once the winner has persisted its id, a later duplicate is a replay of that same order.
    const retry = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.payment.razorpayOrderId, createdId, "the persisted gateway order is reused");
    assert.equal(retry.gateway.length, 0, "no additional gateway order is created");
  } finally {
    if (heldRequests.has(gate)) releaseHold(gate);
    await clean(cafe.cafeId);
    await stopHoldServer();
  }
});

test("F-09: a failed gateway call releases the claim so a retry succeeds", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);

    const failed = await probe({
      path: paymentPath(cafe.slug, order.id),
      headers: { "x-order-token": trackToken },
      body: {},
      gateway: { status: 500, response: { error: "gateway down" } },
    });
    assert.equal(failed.status, 502, "a rejected gateway call is reported as a gateway failure");
    assert.equal(failed.gateway.length, 1);

    // The claim must be gone: nothing should be stuck in a "creating" state after a failure.
    const retry = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(retry.status, 200, "the retry is not blocked by the failed attempt");
    assert.equal(retry.gateway.length, 1, "the retry creates the gateway order the failure never produced");

    // The successful retry persisted its id, so the next duplicate is a replay, not a new order.
    const replay = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.payment.razorpayOrderId, retry.body.payment.razorpayOrderId);
    assert.equal(replay.gateway.length, 0);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: a live claim blocks a duplicate and an expired claim is taken over", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);
    const key = `payclaim:razorpay:${cafe.cafeId}:${order.id}`;

    // A claim another request is still holding (as if its Worker were in the middle of the call).
    await rateRow({ key, expires: Date.now() + 30_000 });
    const blocked = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(blocked.status, 409);
    assert.equal(blocked.gateway.length, 0, "a held claim stops the gateway call");

    // A claim whose holder died: expired, so the next request takes it over instead of hanging.
    await rateRow({ key, expires: Date.now() - 1000 });
    const recovered = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(recovered.status, 200, "an expired claim is reclaimed, not left stuck");
    assert.equal(recovered.gateway.length, 1);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: a stale owner cannot release the claim that replaced it", { skip }, async () => {
  const base = await startHoldServer();
  const cafe = await seed();
  const gate = `stale-${crypto.randomUUID()}`;
  try {
    const { order, trackToken } = await createOrder(cafe);
    const key = `payclaim:razorpay:${cafe.cafeId}:${order.id}`;

    // Request A takes the claim and parks inside the gateway call — past what its 30 s TTL would be.
    const first = createPayment(cafe, order.id, {
      token: trackToken,
      extra: { gateUrl: `${base}?name=${gate}`, gateName: gate },
    });
    await waitForGate(gate);

    const held = await rateRow({ key, read: true });
    assert.ok(held.row, "A holds the claim");
    const ownerA = held.row.owner;

    // Request B reclaims the expired claim with its own token, exactly as the atomic takeover does.
    await rateRow({ key, owner: "owner-b", expires: Date.now() + 30_000 });

    releaseHold(gate);
    const stale = await first;
    assert.equal(stale.status, 409, "the stale request does not finish as if it still owned the ticket");
    assert.equal(stale.gateway.length, 1, "its orphaned gateway order is not handed to the guest");

    const after = await rateRow({ key, read: true });
    assert.ok(after.row, "B's claim still exists after A's finally block ran");
    assert.equal(after.row.owner, "owner-b", "A's conditional delete could not remove the newer claim");
    assert.ok(Number(after.row.expires) > Date.now(), "B's claim was not shortened by A");

    const state = await setOrderState(cafe.cafeId, order.id, {});
    assert.equal(state.order.payment_ref, null, "A did not persist the gateway order it no longer owns");

    // The mechanism behind the above: A's acquisition carried a token of its own, so its later writes
    // could only ever match its own row.
    assert.ok(ownerA && ownerA !== "owner-b", "A's claim carried a distinct owner token");
  } finally {
    if (heldRequests.has(gate)) releaseHold(gate);
    await clean(cafe.cafeId);
    await stopHoldServer();
  }
});

test("F-09: a cancelled order is refused even when it already has a gateway order", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);
    const created = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(created.status, 200);

    await setOrderState(cafe.cafeId, order.id, { status: "cancelled" });

    const res = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(res.status, 409, "cancellation wins over reuse of the stored gateway order");
    assert.match(res.body.error, /cancelled/i);
    assert.equal(res.gateway.length, 0, "nothing reaches the gateway for a cancelled ticket");
  } finally {
    await clean(cafe.cafeId);
  }
});

/* ------------------------------------------------- M-1 timeout and L-1 atomic write */

test("F-09: a gateway answer inside the timeout creates the order", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);

    // The stub answers after 300ms: comfortably inside the 15s bound.
    const res = await probe({
      path: paymentPath(cafe.slug, order.id),
      headers: { "x-order-token": trackToken },
      body: {},
      gateway: { delayMs: 300 },
    });

    assert.equal(res.status, 200);
    assert.equal(res.gateway.length, 1);
    assert.ok(res.body.payment.razorpayOrderId);
    assert.equal(res.body.payment.amount, order.totalCents);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-09: a gateway that stalls past the timeout fails safely and does not retry", { skip }, async () => {
  const base = await startHoldServer();
  const cafe = await seed();
  const gate = `timeout-${crypto.randomUUID()}`;
  try {
    const { order, trackToken } = await createOrder(cafe);
    const key = `payclaim:razorpay:${cafe.cafeId}:${order.id}`;

    const started = Date.now();
    const stalled = createPayment(cafe, order.id, {
      token: trackToken,
      extra: { gateUrl: `${base}?name=${gate}`, gateName: gate },
    });
    await waitForGate(gate);

    const res = await stalled;
    const elapsed = Date.now() - started;

    assert.equal(res.status, 504, "a timeout is its own controlled answer, not a generic failure");
    assert.match(res.body.error, /took too long/i);
    assert.ok(!/razorpay/i.test(JSON.stringify(res.body)), "no gateway or internal detail leaks");
    assert.equal(res.gateway.length, 1, "the aborted request does not retry the gateway itself");
    assert.ok(elapsed >= 14_000, `the call was allowed to run to its bound (${elapsed}ms)`);

    const claim = await rateRow({ key, read: true });
    assert.equal(claim.row, null, "the claim was released after the timeout");

    // A later, explicit request is what creates the order — nothing happens automatically.
    const retry = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(retry.status, 200, "a later request can still create the gateway order");
    assert.equal(retry.gateway.length, 1, "exactly one gateway order on that retry");
  } finally {
    if (heldRequests.has(gate)) releaseHold(gate);
    await clean(cafe.cafeId);
    await stopHoldServer();
  }
});

test("F-09: losing the claim before persistence blocks the write", { skip }, async () => {
  const base = await startHoldServer();
  const cafe = await seed();
  const gate = `lost-${crypto.randomUUID()}`;
  try {
    const { order, trackToken } = await createOrder(cafe);
    const key = `payclaim:razorpay:${cafe.cafeId}:${order.id}`;

    const first = createPayment(cafe, order.id, {
      token: trackToken,
      extra: { gateUrl: `${base}?name=${gate}`, gateName: gate },
    });
    await waitForGate(gate);

    const held = await rateRow({ key, read: true });
    assert.ok(held.row && held.row.owner, "the creator held the claim while it called the gateway");

    // The claim changes hands while the gateway call is still open. Nothing else about the order
    // changes, so only the ownership condition inside the UPDATE can stop the write.
    await rateRow({ key, owner: "owner-b", expires: Date.now() + 30_000 });

    releaseHold(gate);
    const res = await first;

    assert.equal(res.status, 409, "a creator that lost the claim is told to retry");
    assert.equal(res.gateway.length, 1, "its gateway order was created before the loss");

    const state = await setOrderState(cafe.cafeId, order.id, {});
    assert.equal(state.order.payment_ref, null, "the lost owner persisted nothing");
  } finally {
    if (heldRequests.has(gate)) releaseHold(gate);
    await clean(cafe.cafeId);
    await stopHoldServer();
  }
});

test("F-09: a stale owner cannot overwrite the newer owner's payment_ref", { skip }, async () => {
  const base = await startHoldServer();
  const cafe = await seed();
  const gate = `overwrite-${crypto.randomUUID()}`;
  try {
    const { order, trackToken } = await createOrder(cafe);
    const key = `payclaim:razorpay:${cafe.cafeId}:${order.id}`;

    const first = createPayment(cafe, order.id, {
      token: trackToken,
      extra: { gateUrl: `${base}?name=${gate}`, gateName: gate },
    });
    await waitForGate(gate);

    // The newer owner claims the ticket and persists its own gateway order while the old request is
    // still waiting on Razorpay.
    await rateRow({ key, owner: "owner-b", expires: Date.now() + 30_000 });
    await setOrderState(cafe.cafeId, order.id, { paymentMethod: "razorpay", paymentRef: "rzp_new_owner" });

    releaseHold(gate);
    const res = await first;

    assert.equal(res.status, 409);

    const state = await setOrderState(cafe.cafeId, order.id, {});
    assert.equal(state.order.payment_ref, "rzp_new_owner", "the newer owner's ref survived");
    assert.equal(state.order.payment_method, "razorpay");
  } finally {
    if (heldRequests.has(gate)) releaseHold(gate);
    await clean(cafe.cafeId);
    await stopHoldServer();
  }
});

test("F-09: a confirmed payment is not overwritten by an in-flight creator", { skip }, async () => {
  const base = await startHoldServer();
  const cafe = await seed();
  const gate = `confirmed-${crypto.randomUUID()}`;
  try {
    const { order, trackToken } = await createOrder(cafe);

    const first = createPayment(cafe, order.id, {
      token: trackToken,
      extra: { gateUrl: `${base}?name=${gate}`, gateName: gate },
    });
    await waitForGate(gate);

    // The ticket is paid while the creator is still waiting for its own gateway answer.
    await setOrderState(cafe.cafeId, order.id, {
      paymentStatus: "confirmed",
      paymentMethod: "razorpay",
      paymentRef: "rzp_confirmed",
    });

    releaseHold(gate);
    const res = await first;

    assert.equal(res.status, 409, "a confirmed ticket refuses the late write");

    const state = await setOrderState(cafe.cafeId, order.id, {});
    assert.equal(state.order.payment_status, "confirmed");
    assert.equal(state.order.payment_ref, "rzp_confirmed", "the paying order's ref is untouched");
  } finally {
    if (heldRequests.has(gate)) releaseHold(gate);
    await clean(cafe.cafeId);
    await stopHoldServer();
  }
});

test("F-09: a later request recovers safely after an expired claim", { skip }, async () => {
  const cafe = await seed();
  try {
    const { order, trackToken } = await createOrder(cafe);
    const key = `payclaim:razorpay:${cafe.cafeId}:${order.id}`;

    // A claim whose holder died: expired, with an owner nobody will authenticate as.
    await rateRow({ key, owner: "dead-owner", expires: Date.now() - 1000 });

    const res = await createPayment(cafe, order.id, { token: trackToken });
    assert.equal(res.status, 200, "the expired claim is taken over, not left stuck");
    assert.equal(res.gateway.length, 1);

    const state = await setOrderState(cafe.cafeId, order.id, {});
    assert.equal(state.order.payment_ref, res.body.payment.razorpayOrderId, "the new ref is stored");

    const claim = await rateRow({ key, read: true });
    assert.equal(claim.row, null, "the claim is released once the request finishes");
  } finally {
    await clean(cafe.cafeId);
  }
});
