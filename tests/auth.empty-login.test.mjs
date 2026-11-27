// F-07 regression: empty / missing / whitespace-only login attempts must return 401 and update
// the login lockout counter.
//
// Before the fix an empty password reached the Argon2id queue, which rejected a zero-length
// password with an unhandled "password size should be between 8 … bytes" validation error (500),
// and the attempt never touched the lockout counter. The fix rejects a blank `attempt` before the
// queue, answers 401, and increments the same counter a wrong password does. Nothing about
// valid-password verification or the Argon2id hash format changes.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };

let alive = false;
try {
  const probe = await fetch(`${AUTH}/read`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId: -1, key: "probe" }),
  });
  alive = probe.ok;
} catch {
  alive = false;
}
const skip = alive ? false : `auth-enabled harness not available at ${AUTH}`;

async function seed() {
  const res = await fetch(`${AUTH}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ serviceMode: "counter" }),
  });
  assert.equal(res.ok, true, `/seed answered ${res.status}`);
  return res.json();
}

async function cleanup(cafeId) {
  await fetch(`${AUTH}/clean`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId }),
  });
}

function login(slug, bodyText, ip) {
  return fetch(`${AUTH}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: { "cf-connecting-ip": ip, ...JSON_HEADERS },
    origin: AUTH,
    body: bodyText,
  });
}

// The app keys the login lockout on a SHA-256 of the client IP, so the harness is queried the same way.
async function rateKeyCount(cafeId, ip) {
  const key = `login:${cafeId}:${createHash("sha256").update(ip).digest("hex")}`;
  const res = await fetch(`${AUTH}/rate-limit/row`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ key }),
  });
  assert.equal(res.status, 200, `/rate-limit/row answered ${res.status}`);
  const { row } = await res.json();
  return row ? Number(row.count) : 0;
}

function ip() {
  return `198.51.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;
}

test("F-07: missing password returns 401 and updates the lockout counter", { skip }, async (t) => {
  const cafe = await seed();
  t.after(() => cleanup(cafe.cafeId));
  const address = ip();
  const cases = [
    { name: "undefined", body: "{}" },
    { name: "null", body: JSON.stringify({ password: null }) },
    { name: "empty string", body: JSON.stringify({ password: "" }) },
  ];
  let expected = 0;
  for (const { name, body } of cases) {
    expected += 1;
    const res = await login(cafe.slug, body, address);
    assert.equal(res.status, 401, `missing password (${name}) must be 401, got ${res.status}`);
    assert.equal(
      (await res.json()).error,
      "Incorrect password. Please try again.",
      `missing password (${name}) must return the standard 401 message`
    );
    assert.equal(
      await rateKeyCount(cafe.cafeId, address),
      expected,
      `missing password (${name}) incremented the lockout counter`
    );
  }
});

test("F-07: whitespace-only password returns 401 and updates the lockout counter", { skip }, async (t) => {
  const cafe = await seed();
  t.after(() => cleanup(cafe.cafeId));
  const address = ip();
  const res = await login(cafe.slug, JSON.stringify({ password: "   " }), address);
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error, "Incorrect password. Please try again.");
  assert.equal(await rateKeyCount(cafe.cafeId, address), 1, "a whitespace-only attempt increments the counter");
});

test("F-07: bad passwords still count toward lockout, valid password still works", { skip }, async (t) => {
  const cafe = await seed();
  t.after(() => cleanup(cafe.cafeId));
  const address = ip();

  const wrongs = ["", "   ", "short", "wrong-password"];
  let expected = 0;
  for (const wrong of wrongs) {
    expected += 1;
    const res = await login(cafe.slug, JSON.stringify({ password: wrong }), address);
    assert.equal(res.status, 401, `wrong password "${wrong}" must be 401`);
    assert.equal((await res.json()).error, "Incorrect password. Please try again.");
    assert.equal(await rateKeyCount(cafe.cafeId, address), expected, `"${wrong}" counted toward lockout`);
  }

  const ok = await login(cafe.slug, JSON.stringify({ password: "harness-owner-password" }), address);
  assert.equal(ok.status, 200, "the real password still signs in after the lockout test");

  // A real session, not just a 200: the cookie the sign-in set must open a protected endpoint.
  const pair = (ok.headers.get("set-cookie") || "").split(";")[0];
  assert.ok(pair, "sign-in set a session cookie");
  const session = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/session`, { headers: { cookie: pair } });
  assert.equal(session.status, 200, "the session cookie from the successful sign-in is accepted");
});

test("F-07: source-level guard is present at the right point", async () => {
  const { readFileSync } = await import("node:fs");
  const api = readFileSync(new URL("../worker/api.js", import.meta.url), "utf8");
  assert.ok(/if\s*\(!attempt\)\s*\{/.test(api), "the source carries an explicit empty-attempt guard");
  assert.ok(
    /touchRateLimit\(env,\s*lockoutKey,\s*LOGIN_MAX_FAILURES/.test(api) &&
      api.includes('const SIGNIN_WRONG_PASSWORD = "Incorrect password. Please try again.";') &&
      /if\s*\(!attempt\)\s*\{[\s\S]*?return json\(\{ error: SIGNIN_WRONG_PASSWORD/.test(api),
    "the guard updates the lockout counter and returns the standard 401 message"
  );
});
