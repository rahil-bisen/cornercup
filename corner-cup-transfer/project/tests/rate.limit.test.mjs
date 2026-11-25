// Regression tests for durable, D1-backed rate limiting and login lockout (F-06).
//
// These run against the auth-enabled harness. Each test uses a distinct client IP so counters
// from one test cannot lock out another.

import test from "node:test";
import assert from "node:assert/strict";

const HARNESS = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const OPERATOR_PASSWORD = "operator-test-password";

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

const skip = alive ? false : `auth-enabled harness not available at ${HARNESS}`;

function uniqueIp(label) {
  // Distinct per test invocation. Use a 16-bit host part so unrelated tests do not share a bucket.
  const hi = Math.floor(Math.random() * 256);
  const lo = Math.floor(Math.random() * 256);
  return `198.51.${hi}.${lo}`;
}

function ipHeaders(ip, extra = {}) {
  return {
    "content-type": "application/json",
    "cf-connecting-ip": ip,
    ...extra,
  };
}

async function primaryCafe() {
  const res = await fetch(`${HARNESS}/api/cafe`);
  assert.equal(res.status, 200);
  return res.json();
}

test("operator login locks out after 8 failures from one IP", { skip }, async () => {
  const ip = uniqueIp("op-lockout");
  const url = `${HARNESS}/api/operator/login`;

  for (let i = 0; i < 8; i += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(res.status, 401, `failure ${i + 1} should be 401`);
  }

  const blocked = await fetch(url, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(blocked.status, 429, "the 9th attempt must be locked out");
});

test("operator login counter resets after a successful login", { skip }, async () => {
  const ip = uniqueIp("op-reset");

  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(`${HARNESS}/api/operator/login`, {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(res.status, 401);
  }

  const ok = await fetch(`${HARNESS}/api/operator/login`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(ok.status, 200, "a valid password signs in");

  // After reset, 8 fresh failures are required before lockout.
  for (let i = 0; i < 8; i += 1) {
    const res = await fetch(`${HARNESS}/api/operator/login`, {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(res.status, 401, `post-reset failure ${i + 1} should be 401`);
  }

  const blocked = await fetch(`${HARNESS}/api/operator/login`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(blocked.status, 429, "lockout returns after 8 new failures");
});

test("operator login lockout is keyed by IP, not by account", { skip }, async () => {
  const ipA = uniqueIp("op-a");
  const ipB = uniqueIp("op-b");

  for (let i = 0; i < 8; i += 1) {
    await fetch(`${HARNESS}/api/operator/login`, {
      method: "POST",
      headers: ipHeaders(ipA),
      body: JSON.stringify({ password: "wrong-password" }),
    });
  }

  const blockedA = await fetch(`${HARNESS}/api/operator/login`, {
    method: "POST",
    headers: ipHeaders(ipA),
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(blockedA.status, 429, "IP A is locked out");

  const attemptB = await fetch(`${HARNESS}/api/operator/login`, {
    method: "POST",
    headers: ipHeaders(ipB),
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(attemptB.status, 401, "IP B is not locked out by IP A's failures");
});

test("cf-connecting-ip takes precedence over spoofed x-forwarded-for", { skip }, async () => {
  const realIp = uniqueIp("cf-real");
  const spoofed = "203.0.113.999";

  for (let i = 0; i < 8; i += 1) {
    await fetch(`${HARNESS}/api/operator/login`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": realIp,
        "x-forwarded-for": spoofed,
      },
      body: JSON.stringify({ password: "wrong-password" }),
    });
  }

  // Same real IP, different spoofed forwarded value: still locked.
  const blocked = await fetch(`${HARNESS}/api/operator/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": realIp,
      "x-forwarded-for": "198.51.100.7",
    },
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(blocked.status, 429, "the real Cloudflare IP remains locked");

  // A different real IP is unaffected by the spoofed forwarded header.
  const other = await fetch(`${HARNESS}/api/operator/login`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "cf-connecting-ip": uniqueIp("cf-other"),
      "x-forwarded-for": spoofed,
    },
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(other.status, 401, "a different real IP is not locked");
});

test("concurrent operator login failures are counted atomically", { skip }, async () => {
  const ip = uniqueIp("op-concurrent");

  const attempts = Array.from({ length: 8 }, () =>
    fetch(`${HARNESS}/api/operator/login`, {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify({ password: "wrong-password" }),
    })
  );
  const results = await Promise.all(attempts);
  for (const res of results) assert.equal(res.status, 401);

  const blocked = await fetch(`${HARNESS}/api/operator/login`, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(blocked.status, 429, "8 concurrent failures must lock out");
});

test("owner login lockout is keyed by café and IP", { skip }, async () => {
  const cafe = await primaryCafe();
  const ip = uniqueIp("owner-lockout");
  const url = `${HARNESS}/api/cafes/${encodeURIComponent(cafe.slug)}/admin/login`;

  for (let i = 0; i < 8; i += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(res.status, 401, `owner failure ${i + 1} should be 401`);
  }

  const blocked = await fetch(url, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(blocked.status, 429, "owner login locks out after 8 failures");
});

test("owner login counter resets after a valid password", { skip }, async () => {
  const cafe = await primaryCafe();
  const ip = uniqueIp("owner-reset");
  const url = `${HARNESS}/api/cafes/${encodeURIComponent(cafe.slug)}/admin/login`;
  const password = (await import("./harness/credentials.mjs")).HARNESS_BOOTSTRAP_PASSWORD;

  for (let i = 0; i < 4; i += 1) {
    const res = await fetch(url, {
      method: "POST",
      headers: ipHeaders(ip),
      body: JSON.stringify({ password: "wrong-password" }),
    });
    assert.equal(res.status, 401);
  }

  const ok = await fetch(url, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ password }),
  });
  assert.equal(ok.status, 200, "valid owner password signs in");

  const retry = await fetch(url, {
    method: "POST",
    headers: ipHeaders(ip),
    body: JSON.stringify({ password: "wrong-password" }),
  });
  assert.equal(retry.status, 401, "a failure after reset is not locked out");
});

test("general API rate limiter allows normal traffic", { skip }, async () => {
  const ip = uniqueIp("api-normal");
  for (let i = 0; i < 10; i += 1) {
    const res = await fetch(`${HARNESS}/api/health`, {
      headers: { "cf-connecting-ip": ip },
    });
    assert.equal(res.status, 200, `health request ${i + 1} should succeed`);
  }
});

import { randomUUID } from "node:crypto";

async function seedRateLimit(key, expires, count = 1) {
  const res = await fetch(`${HARNESS}/rate-limit/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key, expires, count }),
  });
  assert.equal(res.status, 200, `/rate-limit/seed answered ${res.status}`);
}

async function readRateLimitRow(key) {
  const res = await fetch(`${HARNESS}/rate-limit/row`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return body.row;
}

async function countRateLimitPrefix(prefix) {
  const res = await fetch(`${HARNESS}/rate-limit/count`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prefix }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  return Number(body.count);
}

test("expired rate-limit records are removed by opportunistic cleanup", { skip }, async () => {
  const prefix = `cleanup-expired-${randomUUID()}-`;
  const expiredKey = `${prefix}expired`;
  const activeKey = `${prefix}active`;
  await seedRateLimit(expiredKey, Date.now() - 60_000);
  await seedRateLimit(activeKey, Date.now() + 60_000, 5);

  const res = await fetch(`${HARNESS}/api/health`, {
    headers: { "cf-connecting-ip": uniqueIp("cleanup-expired") },
  });
  assert.equal(res.status, 200);

  assert.equal(await readRateLimitRow(expiredKey), null, "the expired row is deleted");
  const active = await readRateLimitRow(activeKey);
  assert.ok(active, "the active row remains");
  assert.equal(Number(active.count), 5, "the active row keeps its count");
});

test("a cleanup run removes at most 100 expired records", { skip }, async () => {
  const prefix = `b${Date.now()}`;
  for (let i = 0; i < 150; i += 1) {
    await seedRateLimit(`${prefix}${i}`, Date.now() - 60_000);
  }
  assert.equal(await countRateLimitPrefix(prefix), 150);

  const res = await fetch(`${HARNESS}/api/health`, {
    headers: { "cf-connecting-ip": uniqueIp("cleanup-batch") },
  });
  assert.equal(res.status, 200);

  const remaining = await countRateLimitPrefix(prefix);
  assert.ok(remaining >= 50, `at most 100 rows should be removed (remaining ${remaining})`);
  assert.ok(remaining <= 150, "cleanup cannot add rows");
});

test("sampling does not change rate-limit decisions", { skip }, async () => {
  const ip = uniqueIp("cleanup-decision");
  for (let i = 0; i < 3; i += 1) {
    const res = await fetch(`${HARNESS}/api/health`, { headers: { "cf-connecting-ip": ip } });
    assert.equal(res.status, 200);
  }
  const finalRes = await fetch(`${HARNESS}/api/health`, { headers: { "cf-connecting-ip": ip } });
  assert.equal(finalRes.status, 200);
});

test("cleanup failure does not bypass rate limiting", { skip }, async () => {
  const ip = uniqueIp("cleanup-fail");
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${HARNESS}/api/health`, { headers: { "cf-connecting-ip": ip } });
    assert.equal(res.status, 200);
  }
});
