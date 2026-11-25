// A deployment with no ADMIN_SECRET must answer 503 on every auth surface — never an unhandled
// throw from sign(), never a 500, and never a 200. Runs against the harness Worker in tests/harness,
// which deliberately defines no ADMIN_SECRET, so this is the misconfigured-deployment case.

import test from "node:test";
import assert from "node:assert/strict";

const HARNESS = process.env.HARNESS_URL || "http://127.0.0.1:8789";

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

async function seed() {
  const res = await fetch(`${HARNESS}/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceMode: "counter" }),
  });
  assert.equal(res.ok, true, `/seed answered ${res.status}`);
  return res.json();
}

test("T7: missing ADMIN_SECRET answers 503, not 500, on every auth surface", { skip }, async () => {
  const cafe = await seed();
  const base = `${HARNESS}/api/cafes/${cafe.slug}`;
  const json = { "content-type": "application/json" };
  // A well-formed looking staff token: only the secret is missing, so verification must not throw.
  const cookie = { cookie: "staff_session=9999999999999.cafe%3A1.forged-signature" };

  try {
    const cases = [
      ["staff login", () => fetch(`${base}/admin/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "1234" }) })],
      ["staff session check", () => fetch(`${base}/admin/session`, { headers: cookie })],
      ["staff board data", () => fetch(`${base}/admin/orders`, { headers: cookie })],
      ["operator login", () => fetch(`${HARNESS}/api/operator/login`, { method: "POST", headers: json, body: JSON.stringify({ password: "1234" }) })],
      ["operator session check", () => fetch(`${HARNESS}/api/operator/session`, { headers: cookie })],
      ["operator café list", () => fetch(`${HARNESS}/api/operator/cafes`, { headers: cookie })],
    ];

    for (const [name, send] of cases) {
      const res = await send();
      const body = await res.json().catch(() => null);
      assert.notEqual(res.status, 500, `${name} threw a 500`);
      assert.equal(res.status, 503, `${name} answered ${res.status}, expected 503`);
      assert.equal(typeof body?.error, "string", `${name} returned no error message`);
    }
  } finally {
    await fetch(`${HARNESS}/clean`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ cafeId: cafe.cafeId }),
    });
  }
});
