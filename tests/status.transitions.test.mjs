// Regression tests for the café order status workflow.
//   NEW → PREPARING → READY → SERVED (terminal), with cancellation always allowed.
// Runs against an auth-enabled harness (ADMIN_SECRET set, and /seed gives every café its own password
// hash), because status updates require a staff session. Point AUTH_HARNESS_URL at one (default
// http://127.0.0.1:8790);
// otherwise every test here is skipped, same as the other harness suites.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const HARNESS = process.env.AUTH_HARNESS_URL || process.env.HARNESS_URL || "http://127.0.0.1:8790";
const STAFF_PASSWORD = HARNESS_OWNER_PASSWORD;

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

// Status updates need a staff session, which only an auth-enabled harness can issue. Probe for it
// so this suite skips cleanly against a secret-less harness instead of failing at login.
let authAlive = false;
if (alive) {
  try {
    const seeded = await fetch(`${HARNESS}/seed`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ serviceMode: "counter" }),
    });
    if (seeded.ok) {
      const cafe = await seeded.json();
      const login = await fetch(`${HARNESS}/api/cafes/${cafe.slug}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: STAFF_PASSWORD }),
      });
      authAlive = login.status === 200;
      await fetch(`${HARNESS}/clean`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cafeId: cafe.cafeId }),
      });
    }
  } catch {
    authAlive = false;
  }
}

const skip = authAlive ? false : `auth-enabled harness not available at ${HARNESS}`;

async function seed() {
  const res = await fetch(`${HARNESS}/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceMode: "counter" }),
  });
  assert.equal(res.ok, true, `/seed answered ${res.status}`);
  return res.json();
}

async function clean(cafeId) {
  await fetch(`${HARNESS}/clean`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cafeId }),
  });
}

async function staffLogin(slug) {
  const res = await fetch(`${HARNESS}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: STAFF_PASSWORD }),
  });
  assert.equal(res.status, 200, `staff login answered ${res.status}`);
  const cookieHeader = res.headers.get("set-cookie") || "";
  const match = cookieHeader.match(/^([^;]+)/);
  assert.ok(match, "login set a session cookie");
  return match[1];
}

async function createOrder(cafe) {
  const body = JSON.stringify({ note: "", paymentMethod: "razorpay", items: [{ itemId: cafe.itemId, qty: 1 }] });
  const key = crypto.randomUUID();
  const res = await fetch(`${HARNESS}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", "Idempotency-Key": key },
    body,
  });
  assert.equal(res.status, 201, `create order answered ${res.status}`);
  const { order } = await res.json();
  return order.id;
}

// Stage 17B: owner mutations require CSRF, so the fixture obtains a token the way the board does.
async function csrfFor(slug, cookie) {
  const res = await fetch(`${HARNESS}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  const payload = await res.json().catch(() => ({}));
  return (payload && payload.csrfToken) || "";
}

async function patchPayment(slug, cookie, orderId, paymentStatus) {
  const csrf = await csrfFor(slug, cookie);
  return fetch(`${HARNESS}/api/cafes/${slug}/admin/orders/${orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie, origin: HARNESS, "x-csrf-token": csrf },
    body: JSON.stringify({ paymentStatus }),
  });
}

async function rawOrder(cafeId, orderId) {
  const res = await fetch(`${HARNESS}/order-raw`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cafeId, orderId }),
  });
  assert.equal(res.status, 200, `/order-raw answered ${res.status}`);
  return (await res.json()).order;
}

// Runs the production staff update statement with no SELECT before it: the write a request that read
// the row before a concurrent confirmation would issue.
async function runStatementWithoutRead(cafeId, orderId, paymentStatus) {
  const res = await fetch(`${HARNESS}/staff-order-update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cafeId, orderId, paymentStatus }),
  });
  assert.equal(res.status, 200, `/staff-order-update answered ${res.status}`);
  return res.json();
}

async function patchStatus(slug, cookie, orderId, status) {
  const csrf = await csrfFor(slug, cookie);
  return fetch(`${HARNESS}/api/cafes/${slug}/admin/orders/${orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie, origin: HARNESS, "x-csrf-token": csrf },
    body: JSON.stringify({ status }),
  });
}

test("T8: new → preparing succeeds", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    const res = await patchStatus(cafe.slug, cookie, orderId, "preparing");
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("T9: preparing → ready succeeds", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    assert.equal((await patchStatus(cafe.slug, cookie, orderId, "preparing")).status, 200);
    const res = await patchStatus(cafe.slug, cookie, orderId, "ready");
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("T10: ready → served succeeds", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    assert.equal((await patchStatus(cafe.slug, cookie, orderId, "preparing")).status, 200);
    assert.equal((await patchStatus(cafe.slug, cookie, orderId, "ready")).status, 200);
    const res = await patchStatus(cafe.slug, cookie, orderId, "served");
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("T11: preparing → served is rejected", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    assert.equal((await patchStatus(cafe.slug, cookie, orderId, "preparing")).status, 200);
    const res = await patchStatus(cafe.slug, cookie, orderId, "served");
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("T12: new → served is rejected", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    const res = await patchStatus(cafe.slug, cookie, orderId, "served");
    assert.equal(res.status, 409, `expected 409, got ${res.status}`);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("T13: valid cancellation remains supported", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    assert.equal((await patchStatus(cafe.slug, cookie, orderId, "preparing")).status, 200);
    const res = await patchStatus(cafe.slug, cookie, orderId, "cancelled");
    assert.equal(res.status, 200, `expected 200, got ${res.status}`);
  } finally {
    await clean(cafe.cafeId);
  }
});

/* --------------------------------------------- paid tickets stay paid (F-03) */

test("T14: a confirmed payment cannot be marked unpaid", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    assert.equal((await patchPayment(cafe.slug, cookie, orderId, "confirmed")).status, 200);
    const paid = await rawOrder(cafe.cafeId, orderId);
    assert.equal(paid.payment_status, "confirmed");

    const res = await patchPayment(cafe.slug, cookie, orderId, "unpaid");
    assert.equal(res.status, 409, `expected a conflict, got ${res.status}`);
    const body = await res.json();
    assert.equal(body.code, "payment_already_confirmed");
    assert.match(body.error, /already confirmed/i);

    const after = await rawOrder(cafe.cafeId, orderId);
    assert.equal(after.payment_status, "confirmed", "the payment survives");
    assert.equal(after.payment_method, paid.payment_method, "the rail is untouched");
    assert.equal(after.paid_at, paid.paid_at, "the payment timestamp is untouched");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("T15: a confirmed payment cannot be marked failed", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    assert.equal((await patchPayment(cafe.slug, cookie, orderId, "confirmed")).status, 200);
    const paid = await rawOrder(cafe.cafeId, orderId);

    const res = await patchPayment(cafe.slug, cookie, orderId, "failed");
    assert.equal(res.status, 409, `expected a conflict, got ${res.status}`);
    assert.equal((await res.json()).code, "payment_already_confirmed");

    const after = await rawOrder(cafe.cafeId, orderId);
    assert.equal(after.payment_status, "confirmed");
    assert.equal(after.paid_at, paid.paid_at);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("T16: an unpaid ticket can still be confirmed at the counter", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    const res = await patchPayment(cafe.slug, cookie, orderId, "counter");
    assert.equal(res.status, 200, "taking cash is not a downgrade");

    const row = await rawOrder(cafe.cafeId, orderId);
    assert.equal(row.payment_status, "counter");
    assert.equal(row.payment_method, "counter", "the rail follows the cash payment");
    assert.ok(row.paid_at, "the payment is timestamped");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("T17: order status transitions are unaffected by a confirmed payment", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    assert.equal((await patchPayment(cafe.slug, cookie, orderId, "confirmed")).status, 200);
    const paid = await rawOrder(cafe.cafeId, orderId);

    assert.equal((await patchStatus(cafe.slug, cookie, orderId, "preparing")).status, 200);
    assert.equal((await patchStatus(cafe.slug, cookie, orderId, "ready")).status, 200);
    assert.equal((await patchStatus(cafe.slug, cookie, orderId, "served")).status, 200);

    const after = await rawOrder(cafe.cafeId, orderId);
    assert.equal(after.status, "served", "the kitchen flow still works");
    assert.equal(after.payment_status, "confirmed", "and the payment is untouched");
    assert.equal(after.paid_at, paid.paid_at);
  } finally {
    await clean(cafe.cafeId);
  }
});

// The rule must hold in the statement, not in a check before it: a request that read the row while it
// was unpaid and writes after a confirmation must change nothing.
test("T18: a downgrade that read the row before a confirmation changes nothing", { skip }, async () => {
  const cafe = await seed();
  const cookie = await staffLogin(cafe.slug);
  try {
    const orderId = await createOrder(cafe);
    assert.equal((await patchPayment(cafe.slug, cookie, orderId, "confirmed")).status, 200);
    const paid = await rawOrder(cafe.cafeId, orderId);

    const stale = await runStatementWithoutRead(cafe.cafeId, orderId, "unpaid");
    assert.equal(stale.changes, 0, "the guard refuses the write with no prior SELECT");
    assert.equal(stale.order.payment_status, "confirmed");
    assert.equal(stale.order.payment_method, paid.payment_method);
    assert.equal(stale.order.paid_at, paid.paid_at);

    // The same statement still writes when the ticket is not paid.
    const fresh = await createOrder(cafe);
    const allowed = await runStatementWithoutRead(cafe.cafeId, fresh, "failed");
    assert.equal(allowed.changes, 1);
    assert.equal(allowed.order.payment_status, "failed");
  } finally {
    await clean(cafe.cafeId);
  }
});
