import test from "node:test";
import assert from "node:assert/strict";

const HARNESS = process.env.HARNESS_URL || "http://127.0.0.1:8789";

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `harness not available at ${HARNESS}`;

test("F-15: healthy database answers 200", { skip }, async () => {
  const res = await fetch(`${HARNESS}/api/health`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.database, "ok");
});

test("F-15: response contains status, database, and time", { skip }, async () => {
  const res = await fetch(`${HARNESS}/api/health`);
  const body = await res.json();
  assert.ok(Object.prototype.hasOwnProperty.call(body, "status"));
  assert.ok(Object.prototype.hasOwnProperty.call(body, "database"));
  assert.ok(Object.prototype.hasOwnProperty.call(body, "time"));
  assert.match(body.time, /^\d{4}-\d{2}-\d{2}T/);
});

test("F-15: response does not contain payments", { skip }, async () => {
  const res = await fetch(`${HARNESS}/api/health`);
  const body = await res.json();
  assert.equal(Object.prototype.hasOwnProperty.call(body, "payments"), false);
});

test("F-15: no payment configuration is needed to call the endpoint", { skip }, async () => {
  // The batch harness has no RAZORPAY_* vars; the endpoint must still answer 200.
  const res = await fetch(`${HARNESS}/api/health`);
  assert.equal(res.status, 200);
});
