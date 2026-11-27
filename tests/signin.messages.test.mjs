// What the owner and operator sign-ins answer, end to end against the real handlers:
//   - a wrong password is 401 "Incorrect password. Please try again." on both pages;
//   - a lockout is 429, says how many minutes to wait, and sends Retry-After; the lockout still holds;
//   - a deployment without the sign-in secrets is 503 "Sign-in isn't set up yet. Please contact support."
// The auth harness (8790) has ADMIN_SECRET and OPERATOR_PASSWORD; the batch harness (8789) has neither,
// which is exactly the "not set up" case.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const BATCH = process.env.HARNESS_URL || "http://127.0.0.1:8789";
const JSON_HEADERS = { "content-type": "application/json" };

const WRONG = "Incorrect password. Please try again.";
const NOT_SET_UP = "Sign-in isn't set up yet. Please contact support.";
const LOCKED = /^Too many attempts\. Please try again in (\d+) minutes?\.$/;

async function reachable(base) {
  try {
    const res = await fetch(`${base}/api/health`);
    return res.ok || res.status === 503;
  } catch {
    return false;
  }
}
const authSkip = (await reachable(AUTH)) ? false : `auth harness not available at ${AUTH}`;
const batchSkip = (await reachable(BATCH)) ? false : `batch harness not available at ${BATCH}`;

async function harness(base, path, body) {
  const res = await fetch(`${base}${path}`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify(body) });
  assert.equal(res.status, 200, `${path} answered ${res.status}`);
  return res.json();
}

function signIn(base, path, password) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { ...JSON_HEADERS, origin: base },
    body: JSON.stringify({ password }),
  });
}

// Other suites leave operator lockout rows for other simulated client addresses, so this finds the row
// that `act` itself counted: the one whose count went up (or appeared) across the call.
async function lockoutKeyTouchedBy(base, prefix, act) {
  const counts = async () => {
    const { keys } = await harness(base, "/rate-limit/keys", { prefix });
    const entries = await Promise.all(
      keys.map(async (key) => [key, Number(((await harness(base, "/rate-limit/row", { key })).row || {}).count || 0)])
    );
    return new Map(entries);
  };
  const before = await counts();
  await act();
  const after = await counts();
  const touched = [...after].filter(([key, count]) => count > (before.get(key) || 0)).map(([key]) => key);
  assert.equal(touched.length, 1, `exactly one ${prefix} row was counted`);
  return touched[0];
}

function assertLocked(res, body) {
  assert.equal(res.status, 429);
  const match = LOCKED.exec(body.error);
  assert.ok(match, `lockout message says when: ${body.error}`);
  const retryAfter = Number(res.headers.get("retry-after"));
  assert.ok(retryAfter > 0 && retryAfter <= 600, `Retry-After within the 10-minute window: ${retryAfter}`);
  assert.equal(Number(match[1]), Math.ceil(retryAfter / 60), "the minutes match Retry-After");
}

test("owner: a wrong password is 401 Incorrect password", { skip: authSkip }, async () => {
  const cafe = await harness(AUTH, "/seed", { serviceMode: "tables" });
  try {
    const res = await signIn(AUTH, `/api/cafes/${cafe.slug}/admin/login`, "not-the-owner-password");
    assert.equal(res.status, 401);
    assert.equal((await res.json()).error, WRONG);
  } finally {
    await harness(AUTH, "/clean", { cafeId: cafe.cafeId });
  }
});

test("owner: 8 wrong passwords lock sign-in, the 429 says when, and the right password waits too", { skip: authSkip }, async () => {
  const cafe = await harness(AUTH, "/seed", { serviceMode: "tables" });
  const path = `/api/cafes/${cafe.slug}/admin/login`;
  try {
    for (let attempt = 1; attempt <= 8; attempt += 1) {
      const res = await signIn(AUTH, path, `wrong-${attempt}`);
      assert.equal(res.status, 401, `attempt ${attempt} is a plain wrong password`);
      assert.equal((await res.json()).error, WRONG);
    }
    const locked = await signIn(AUTH, path, "wrong-9");
    assertLocked(locked, await locked.json());

    // The lockout is not weakened: the correct password is refused the same way until it expires.
    const correct = await signIn(AUTH, path, HARNESS_OWNER_PASSWORD);
    assertLocked(correct, await correct.json());
  } finally {
    await harness(AUTH, "/clean", { cafeId: cafe.cafeId });
  }
});

test("operator: a wrong password is 401, and a lockout says when and still holds", { skip: authSkip }, async () => {
  const path = "/api/operator/login";
  let wrong;
  const key = await lockoutKeyTouchedBy(AUTH, "login:operator:", async () => {
    wrong = await signIn(AUTH, path, "not-the-operator-password");
  });
  assert.equal(wrong.status, 401);
  assert.equal((await wrong.json()).error, WRONG);

  // Lock the operator console for this IP for five minutes through its real lockout row, rather than
  // spending eight attempts, and put it back afterwards so no other suite is locked out.
  try {
    await harness(AUTH, "/rate-limit/seed", { key, count: 8, expires: Date.now() + 5 * 60 * 1000 });
    const locked = await signIn(AUTH, path, "not-the-operator-password");
    const body = await locked.json();
    assertLocked(locked, body);
    assert.match(body.error, /in 5 minutes\./);
  } finally {
    await harness(AUTH, "/rate-limit/seed", { key, count: 0, expires: Date.now() - 1000 });
  }
});

test("owner and operator: without the sign-in secrets the answer is 503 Sign-in isn't set up yet", { skip: batchSkip }, async () => {
  const cafe = await harness(BATCH, "/seed", { serviceMode: "tables" });
  try {
    for (const path of [`/api/cafes/${cafe.slug}/admin/login`, "/api/operator/login"]) {
      const res = await signIn(BATCH, path, "any-password-at-all");
      assert.equal(res.status, 503, path);
      const body = await res.json();
      assert.equal(body.error, NOT_SET_UP, path);
      assert.equal(body.code, "signin_not_configured", path);
    }
  } finally {
    await harness(BATCH, "/clean", { cafeId: cafe.cafeId });
  }
});

test("owner: a café with no owner password set says sign-in isn't set up, not that the password is wrong", { skip: authSkip }, async () => {
  const cafe = await harness(AUTH, "/seed", { serviceMode: "tables", noPassword: true });
  try {
    const res = await signIn(AUTH, `/api/cafes/${cafe.slug}/admin/login`, "anything");
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error, /^Sign-in isn't set up yet for this café\. Please contact support/);
    assert.match(body.error, /operator/, "it says what has to happen");
    assert.equal(body.code, "signin_not_configured");
  } finally {
    await harness(AUTH, "/clean", { cafeId: cafe.cafeId });
  }
});
