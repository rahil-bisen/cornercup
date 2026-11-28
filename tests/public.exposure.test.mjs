// F-18 public surface. Menu, table and config data are intentionally readable by guests, so the
// security property is not "hidden" — it is that nothing private ever rides along with them, and that
// an unknown slug is a 404 rather than a fallback to another tenant.

import test from "node:test";
import assert from "node:assert/strict";

const HARNESS = process.env.HARNESS_URL || "http://127.0.0.1:8789";
const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `harness not available at ${HARNESS}`;

// Anything that would turn a public response into a credential disclosure or a tenant leak.
const PRIVATE_MARKERS = [
  "pass_hash",
  "passHash",
  "$argon2id",
  "pbkdf2$",
  "auth_version",
  "authVersion",
  "track_hash",
  "trackHash",
  "track_nonce",
  "trackNonce",
  "operator_sessions",
  "csrfToken",
  "session_id",
  // F-07 phase 1. Identity and membership are authorization data: no guest or staff response may
  // carry the column, the table name or the provider id. `ownerAuth` is deliberately absent from this
  // list because the sign-in screen is meant to learn which mode a café uses.
  "owner_auth",
  "workos_user_id",
  "workosUserId",
  "workos_session_id",
  "owner_identities",
  "cafe_owners",
  "owner_login_states",
];

function assertNoPrivateData(payload, where) {
  const serialised = JSON.stringify(payload);
  for (const marker of PRIVATE_MARKERS) {
    assert.equal(
      serialised.includes(marker),
      false,
      `${where} must not contain ${marker}`
    );
  }
}

async function seed(serviceMode) {
  const res = await fetch(`${HARNESS}/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceMode }),
  });
  assert.equal(res.ok, true, `/seed answered ${res.status}`);
  return res.json();
}

test("F-18: /api/config exposes café-facing settings and no credentials", { skip }, async () => {
  const cafe = await seed("counter");
  try {
    const res = await fetch(`${HARNESS}/api/cafes/${cafe.slug}/config`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.slug, cafe.slug);
    assert.equal(body.currency, "INR");
    assert.deepEqual(Object.keys(body.cafe).sort(), ["address", "email", "name", "phone"]);
    assert.deepEqual(Object.keys(body.service), ["mode"]);
    // The harness configures ADMIN_SECRET, so orders can be tracked. Only a boolean is exposed,
    // never which secret backs it.
    assert.deepEqual(body.ordering, { available: true });
    // The harness has no Razorpay credentials, so the public half of the pair must be absent.
    assert.equal(body.payments.provider, "none");
    assert.equal(body.payments.gateway, false);
    assert.equal(body.payments.keyId, null);

    assertNoPrivateData(body, "/api/config");
  } finally {
    await fetch(`${HARNESS}/clean`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cafeId: cafe.cafeId }),
    });
  }
});

test("F-18: the public menu carries only what a guest orders from", { skip }, async () => {
  const cafe = await seed("tables");
  try {
    const res = await fetch(`${HARNESS}/api/cafes/${cafe.slug}/menu?table=1`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.equal(body.table.id, 1, "the café-facing table number, not the row id");
    assert.equal(body.table.label, "Harness Table");
    for (const category of body.categories) {
      for (const item of category.items) {
        assert.deepEqual(
          Object.keys(item).sort(),
          ["available", "description", "diet", "emoji", "hasCustomImage", "id", "imageUrl", "name", "priceCents"],
          `item shape in ${category.name}`
        );
      }
    }

    assertNoPrivateData(body, "/api/menu");
  } finally {
    await fetch(`${HARNESS}/clean`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cafeId: cafe.cafeId }),
    });
  }
});

test("F-18: the public table list is number, label and seats only", { skip }, async () => {
  const cafe = await seed("tables");
  try {
    const res = await fetch(`${HARNESS}/api/cafes/${cafe.slug}/tables`);
    assert.equal(res.status, 200);
    const body = await res.json();

    assert.ok(body.tables.length >= 1);
    for (const table of body.tables) {
      assert.deepEqual(Object.keys(table).sort(), ["id", "label", "seats"]);
    }

    assertNoPrivateData(body, "/api/tables");
  } finally {
    await fetch(`${HARNESS}/clean`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cafeId: cafe.cafeId }),
    });
  }
});

test("F-18: the bare-domain café is a public summary only", { skip }, async () => {
  const res = await fetch(`${HARNESS}/api/cafe`);
  assert.ok(res.status === 200 || res.status === 404, `answered ${res.status}`);
  if (res.status !== 200) return;

  const body = await res.json();
  assert.deepEqual(Object.keys(body).sort(), ["name", "serviceMode", "slug"]);
  assertNoPrivateData(body, "/api/cafe");
});

test("F-18: an unknown slug is a 404, never another tenant's data", { skip }, async () => {
  const [first, second] = [await seed("counter"), await seed("counter")];
  try {
    assert.notEqual(first.slug, second.slug);

    const firstConfig = await (await fetch(`${HARNESS}/api/cafes/${first.slug}/config`)).json();
    const secondConfig = await (await fetch(`${HARNESS}/api/cafes/${second.slug}/config`)).json();
    assert.equal(firstConfig.slug, first.slug);
    assert.equal(secondConfig.slug, second.slug, "each slug resolves to its own café");

    const missing = await fetch(`${HARNESS}/api/cafes/no-such-cafe-${Date.now()}/config`);
    assert.equal(missing.status, 404);
    const missingBody = await missing.text();
    assert.equal(missingBody.includes(first.slug), false);
    assert.equal(missingBody.includes(second.slug), false);
  } finally {
    for (const cafe of [first, second]) {
      await fetch(`${HARNESS}/clean`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cafeId: cafe.cafeId }),
      });
    }
  }
});

test("F-18: the staff settings view is never readable without a session", { skip }, async () => {
  // The auth harness has ADMIN_SECRET, so the correct refusal here is 401 (not a data response).
  const cafe = await fetch(`${AUTH}/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceMode: "tables" }),
  }).then((res) => res.json());

  try {
    const res = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/settings`);
    assert.equal(res.status, 401);
    assertNoPrivateData(await res.json().catch(() => ({})), "anonymous settings refusal");
  } finally {
    await fetch(`${AUTH}/clean`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cafeId: cafe.cafeId }),
    });
  }
});
