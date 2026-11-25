import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

// F-07 source contracts. The behavioural tests live in tests/argon2.passwords.test.mjs because
// worker/passwords.js imports an Argon2id wasm binary that only workerd can load.

const passwordsSource = fs.readFileSync("./worker/passwords.js", "utf-8");
const apiSource = fs.readFileSync("./worker/api.js", "utf-8");

test("F-07: new hashes are Argon2id at the OWASP baseline", () => {
  assert.match(passwordsSource, /const ARGON2 = \{ m: 19456, t: 2, p: 1 \}/, "baseline parameters");
  assert.match(passwordsSource, /const SALT_BYTES = 16/, "16-byte salt");
  assert.match(passwordsSource, /const TAG_BYTES = 32/, "32-byte tag");
  assert.ok(
    passwordsSource.includes("$argon2id$v=19$m=${ARGON2.m},t=${ARGON2.t},p=${ARGON2.p}$"),
    "writes a standard PHC string"
  );
});

test("F-07: the Argon2id wasm module is imported, never compiled from bytes", () => {
  assert.match(passwordsSource, /import simdWasm from "argon2id\/dist\/simd\.wasm"/);
  assert.match(passwordsSource, /WebAssembly\.instantiate\(simdWasm, imports\)/);
  assert.ok(!/WebAssembly\.compile/.test(passwordsSource), "runtime compilation is what workerd forbids");
});

test("F-07: PHC parsing is strict and allocates nothing until the allowlist passes", () => {
  const parse = passwordsSource.slice(
    passwordsSource.indexOf("function parseArgon2"),
    passwordsSource.indexOf("function parsePbkdf2")
  );
  assert.match(parse, /STORED_MAX_LENGTH/, "length bound first");
  assert.match(parse, /PHC_PATTERN\.exec/, "exact pattern");
  assert.match(parse, /Number\(match\[1\]\) !== ARGON2\.m/, "memory allowlisted");
  assert.match(parse, /Number\(match\[2\]\) !== ARGON2\.t/, "iterations allowlisted");
  assert.match(parse, /Number\(match\[3\]\) !== ARGON2\.p/, "parallelism allowlisted");
  assert.match(parse, /salt\.length !== SALT_BYTES/, "salt length checked");
  assert.match(parse, /tag\.length !== TAG_BYTES/, "tag length checked");
});

test("F-07: digests are compared in constant time", () => {
  assert.match(passwordsSource, /function constantTimeEqual/);
  assert.match(passwordsSource, /mismatch \|= a\[i\] \^ b\[i\]/);
  assert.match(passwordsSource, /constantTimeEqual\(candidate, argon2\.tag\)/);
  assert.match(passwordsSource, /constantTimeEqual\(candidate, legacy\.tag\)/);
});

test("F-07: legacy PBKDF2 is verifiable only up to the platform ceiling", () => {
  assert.match(passwordsSource, /const PBKDF2_MAX_SUPPORTED = 100_000/);
  assert.match(
    passwordsSource,
    /if \(legacy\.iterations > PBKDF2_MAX_SUPPORTED\) return false/,
    "an unsupported work factor fails closed instead of being recomputed weaker"
  );
  assert.match(passwordsSource, /export function passwordNeedsReset/, "a reset-required signal exists");
});

test("F-07: hashing is serialised per isolate with a bounded queue", () => {
  assert.match(passwordsSource, /const MAX_QUEUE = 3/);
  assert.match(passwordsSource, /if \(waiters\.length >= MAX_QUEUE\) return Promise\.reject\(new PasswordQueueFullError\(\)\)/);
  assert.match(passwordsSource, /async function withSlot/);
  assert.match(passwordsSource, /hashPassword[\s\S]*withSlot/s, "both hash and verify take a slot");
});

test("F-07: login answers a queue-full hash with a controlled 429", () => {
  assert.match(apiSource, /err instanceof PasswordQueueFullError/);
  assert.match(apiSource, /Too many sign-in attempts right now/);
});

test("F-07: a legacy 600k hash produces a reset-required response, not a 401", () => {
  assert.match(apiSource, /if \(passwordNeedsReset\(cafe\.pass_hash\)\)/);
  assert.match(apiSource, /can't verify\. Ask the operator to reset it/);
  assert.ok(apiSource.indexOf("passwordNeedsReset(cafe.pass_hash)") < apiSource.indexOf("verifyPassword(attempt"), "checked before verification");
});

test("F-07: rehash uses compare-and-swap and never bumps auth_version", () => {
  const rehash = apiSource.match(
    /UPDATE cafes SET pass_hash = \? WHERE id = \? AND pass_hash = \?/
  );
  assert.ok(rehash, "CAS statement present");
  const context = apiSource.slice(rehash.index - 400, rehash.index + 200);
  assert.ok(!/auth_version/.test(context), "the migration does not touch the session version");
});

test("F-07: explicit password changes still bump auth_version", () => {
  assert.match(apiSource, /columns\.push\("auth_version = auth_version \+ 1"\)/);
  assert.match(apiSource, /auth_version = auth_version \+ 1, password_changed_at = \?/);
});

test("F-07: login still captures the session version before verification", () => {
  const versionAt = apiSource.indexOf("const version = currentAuthVersion(cafe)");
  const verifyAt = apiSource.indexOf("await verifyPassword(attempt, cafe.pass_hash)");
  assert.ok(versionAt !== -1 && verifyAt !== -1 && versionAt < verifyAt, "race fix preserved");
});
