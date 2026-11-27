// The table-management routes behind the owner dashboard. A counter café's dashboard no longer shows a
// Tables & QR tab, but the routes still exist and must stay owner-only in both service modes; and
// switching the service style must never delete or renumber a café's tables, so switching back to table
// service brings the same tables and QR links back. Runs against the auth harness Worker, which mounts the
// production handleApi with its own local D1.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };

let alive = false;
try {
  const probe = await fetch(`${AUTH}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not available at ${AUTH}`;

async function harness(path, body) {
  const res = await fetch(`${AUTH}${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return res.json();
}

async function login(slug) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: HARNESS_OWNER_PASSWORD }),
  });
  assert.equal(res.status, 200, `sign-in answered ${res.status}`);
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (cookies[0] || res.headers.get("set-cookie") || "").split(";")[0];
}

async function csrfFor(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  return ((await res.json().catch(() => ({}))) || {}).csrfToken || "";
}

const tablesUrl = (slug) => `${AUTH}/api/cafes/${slug}/admin/tables`;

async function listTables(slug, cookie) {
  const res = await fetch(tablesUrl(slug), { headers: { cookie } });
  assert.equal(res.status, 200, `table list answered ${res.status}`);
  return (await res.json()).tables;
}

async function saveServiceMode(slug, cookie, serviceMode) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/settings`, {
    method: "PATCH",
    headers: { ...JSON_HEADERS, cookie, origin: AUTH, "x-csrf-token": await csrfFor(slug, cookie) },
    body: JSON.stringify({ serviceMode }),
  });
  assert.equal(res.status, 200, `settings save answered ${res.status}`);
  assert.equal((await res.json()).settings.serviceMode, serviceMode);
}

for (const mode of ["tables", "counter"]) {
  test(`${mode} café: the table routes refuse anyone who is not signed in as its owner`, { skip }, async () => {
    const cafe = await harness("/seed", { serviceMode: mode });
    try {
      // The forged cookie uses this café's real session cookie name, so it is the session check that
      // refuses it, not a name mismatch.
      const cookie = await login(cafe.slug);
      const cookieName = cookie.split("=")[0];
      for (const [label, headers] of [
        ["no cookie", {}],
        ["a forged session cookie", { cookie: `${cookieName}=not-a-real-session` }],
      ]) {
        const list = await fetch(tablesUrl(cafe.slug), { headers });
        assert.equal(list.status, 401, `GET with ${label}`);
        const add = await fetch(tablesUrl(cafe.slug), {
          method: "POST",
          headers: { ...JSON_HEADERS, origin: AUTH, ...headers },
          body: "{}",
        });
        assert.equal(add.status, 401, `POST with ${label}`);
      }

      // Signed in, but without the CSRF proof every owner write carries: still refused, nothing added.
      const before = await listTables(cafe.slug, cookie);
      const forged = await fetch(tablesUrl(cafe.slug), {
        method: "POST",
        headers: { ...JSON_HEADERS, origin: AUTH, cookie },
        body: "{}",
      });
      assert.equal(forged.status, 403, "a signed-in POST without the CSRF token");
      assert.deepEqual(await listTables(cafe.slug, cookie), before, "no table was added");
    } finally {
      await harness("/clean", { cafeId: cafe.cafeId });
    }
  });
}

test("switching to counter service and back keeps every table and its number", { skip }, async () => {
  const cafe = await harness("/seed", { serviceMode: "tables" });
  try {
    const cookie = await login(cafe.slug);
    const csrf = await csrfFor(cafe.slug, cookie);
    const added = await fetch(tablesUrl(cafe.slug), {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: AUTH, cookie, "x-csrf-token": csrf },
      body: "{}",
    });
    assert.equal(added.status, 201, `adding a table answered ${added.status}`);
    const before = await listTables(cafe.slug, cookie);
    assert.equal(before.length, 2, "the seeded table plus the one just added");

    await saveServiceMode(cafe.slug, cookie, "counter");
    assert.deepEqual(await listTables(cafe.slug, cookie), before, "counter service deletes nothing");

    await saveServiceMode(cafe.slug, cookie, "tables");
    assert.deepEqual(await listTables(cafe.slug, cookie), before, "the same tables, numbers and labels come back");
  } finally {
    await harness("/clean", { cafeId: cafe.cafeId });
  }
});
