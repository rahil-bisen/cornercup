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

async function patchStatus(slug, cookie, orderId, status) {
  return fetch(`${HARNESS}/api/cafes/${slug}/admin/orders/${orderId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", cookie },
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
