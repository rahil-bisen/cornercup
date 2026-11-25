// F-07 behavioural suite. worker/passwords.js imports two wasm binaries, so Node cannot load it
// directly; every assertion here runs the production hasher inside workerd through the harness
// /passwords/* routes. tests/f07-regression.test.mjs covers the source contracts.

import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";

const HARNESS = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/passwords/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "probe", stored: "probe" }),
  });
  alive = probe.status === 200;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not available at ${HARNESS}`;

async function post(path, body) {
  const res = await fetch(`${HARNESS}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function hash(password) {
  const result = await post("/passwords/hash", { password });
  assert.equal(result.status, 200, `/passwords/hash answered ${result.status}`);
  return result.body.stored;
}

function verify(password, stored) {
  return post("/passwords/verify", { password, stored });
}

// A hash in the exact legacy format the migration reads: pbkdf2$<iterations>$<salt>$<tag>.
function legacyHash(password, iterations) {
  const salt = randomBytes(16);
  const tag = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2$${iterations}$${salt.toString("base64")}$${tag.toString("base64")}`;
}

test("F-07: hashing runs in workerd and writes Argon2id at the OWASP baseline", { skip }, async () => {
  const stored = await hash("correct horse battery staple");

  assert.match(
    stored,
    /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]+={0,2}\$[A-Za-z0-9+/]+={0,2}$/,
    "a standard PHC string with m=19456, t=2, p=1"
  );

  const [, algorithm, version, params, salt, tag] = stored.split("$");
  assert.equal(algorithm, "argon2id");
  assert.equal(version, "v=19");
  assert.equal(params, "m=19456,t=2,p=1");
  assert.equal(Buffer.from(salt, "base64").length, 16, "16-byte salt");
  assert.equal(Buffer.from(tag, "base64").length, 32, "32-byte tag");
});

// Written by the wrapper before its encode-once/tag-copy cleanup. Existing rows must keep verifying.
const PRE_OPTIMIZATION_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$JdAZc89p/fdBGo5z2ncEGg==$uVO3K7SKT6tw7nKhene9azNWlGQYnXxAsMmy3wodsrk=";

test("F-07: a hash written before the wrapper optimization still verifies", { skip }, async () => {
  const result = await verify("corner-cup-argon2-compat", PRE_OPTIMIZATION_HASH);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true, "the stored hash was not invalidated");
  assert.equal(result.body.argon2, true);
  assert.equal((await verify("corner-cup-argon2-compat!", PRE_OPTIMIZATION_HASH)).body.ok, false);
});

test("F-07: the correct password verifies and a wrong one does not", { skip }, async () => {
  const stored = await hash("harness-argon2-password");

  const good = await verify("harness-argon2-password", stored);
  assert.equal(good.status, 200);
  assert.equal(good.body.ok, true);
  assert.equal(good.body.argon2, true);
  assert.equal(good.body.needsReset, false);

  const bad = await verify("harness-argon2-passwore", stored);
  assert.equal(bad.status, 200);
  assert.equal(bad.body.ok, false);

  const empty = await verify("", stored);
  assert.equal(empty.status, 200, "an empty guess is a failed verification, never a 500");
  assert.equal(empty.body.ok, false);
});

test("F-07: a guess shorter than the hasher's minimum fails closed", { skip }, async () => {
  // The library rejects passwords under 8 bytes, so a short guess must be refused as a wrong
  // password rather than throwing out of verifyPassword.
  const stored = await hash("12345678");
  assert.equal((await verify("12345678", stored)).body.ok, true, "8 bytes is inside the range");

  for (const guess of ["1", "1234", "1234567"]) {
    const short = await verify(guess, stored);
    assert.equal(short.status, 200, `"${guess}" must not produce a 500`);
    assert.equal(short.body.ok, false, `"${guess}" is not the stored password`);
  }
});

test("F-07: a short sign-in guess is a counted 401, not a 500", { skip }, async () => {
  const seeded = await fetch(`${HARNESS}/seed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: "harness-long-enough-password" }),
  }).then((res) => res.json());

  try {
    const res = await fetch(`${HARNESS}/api/cafes/${seeded.slug}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: HARNESS },
      body: JSON.stringify({ password: "1234" }),
    });
    assert.equal(res.status, 401, "a four-digit guess is a failed sign-in");
  } finally {
    await fetch(`${HARNESS}/clean`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cafeId: seeded.cafeId }),
    });
  }
});

test("F-07: two hashes of one password carry different salts", { skip }, async () => {
  const first = await hash("same-password-twice");
  const second = await hash("same-password-twice");
  assert.notEqual(first, second, "a fresh random salt per hash");
  assert.equal((await verify("same-password-twice", first)).body.ok, true);
  assert.equal((await verify("same-password-twice", second)).body.ok, true);
});

test("F-07: a legacy 100k PBKDF2 hash still verifies and is not flagged for reset", { skip }, async () => {
  const stored = legacyHash("legacy-100k-password", 100_000);

  const result = await verify("legacy-100k-password", stored);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true, "existing passwords keep working");
  assert.equal(result.body.argon2, false);
  assert.equal(result.body.needsReset, false, "100k is still computable here");

  assert.equal((await verify("wrong-password", stored)).body.ok, false);
});

test("F-07: a legacy hash above the platform ceiling fails closed and asks for a reset", { skip }, async () => {
  const stored = legacyHash("legacy-600k-password", 600_000);

  const result = await verify("legacy-600k-password", stored);
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, false, "never silently re-derived at a weaker work factor");
  assert.equal(result.body.needsReset, true);
  assert.equal(result.body.argon2, false);
});

test("F-07: malformed stored values are rejected without throwing", { skip }, async () => {
  const salt = randomBytes(16).toString("base64");
  const tag = randomBytes(32).toString("base64");
  const cases = [
    "",
    "not-a-hash",
    `pbkdf2$0$${salt}$${tag}`,
    `pbkdf2$9999999$${salt}$${tag}`,
    // A valid-looking Argon2id string whose parameters are outside the allowlist: it must be
    // refused before any memory is allocated for the derivation.
    `$argon2id$v=19$m=65536,t=3,p=4$${salt}$${tag}`,
    `$argon2id$v=19$m=19456,t=2,p=1$${salt}`,
    "$" + "A".repeat(300) + "$" + "B".repeat(300),
  ];

  for (const stored of cases) {
    const result = await verify("any-password", stored);
    assert.equal(result.status, 200, `no throw for ${JSON.stringify(stored.slice(0, 24))}`);
    assert.equal(result.body.ok, false);
  }
});

test("F-07: the hashing queue is bounded and refuses work instead of growing", { skip }, async () => {
  // One running hash plus MAX_QUEUE (3) waiters is the ceiling per isolate.
  const three = await post("/passwords/burst", { n: 3 });
  assert.equal(three.status, 200);
  assert.equal(three.body.ok, 3, "three concurrent hashes all complete");
  assert.equal(three.body.full, 0);
  assert.equal(three.body.error, 0);

  const six = await post("/passwords/burst", { n: 6 });
  assert.equal(six.status, 200);
  assert.equal(six.body.error, 0, "a full queue is a controlled refusal, not a crash");
  assert.equal(six.body.ok + six.body.full, 6);
  assert.ok(six.body.full >= 1, "excess work is refused");
  assert.ok(six.body.ok <= 4, "never more than the running hash plus the bounded waiters");
});
