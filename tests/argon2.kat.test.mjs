// RFC 9106 §5.3 Argon2id known-answer test for the exact wasm implementation the Worker uses.
//
// The production wrapper fixes its own parameters (m=19456, t=2, p=1), so this vector runs the same
// library and binaries with the RFC's parameters (m=32 KiB, t=3, p=4, secret and associated data).
// It proves the primitive is Argon2id v1.3 and matches the standard byte-for-byte; the HTTP suite
// separately proves the wrapper writes and verifies the production parameter set.

import test from "node:test";
import assert from "node:assert/strict";
import setupWasm from "argon2id/lib/setup.js";
import simdWasm from "argon2id/dist/simd.wasm";
import noSimdWasm from "argon2id/dist/no-simd.wasm";

const compute = await setupWasm(
  async (imports) => ({ instance: await WebAssembly.instantiate(simdWasm, imports) }),
  async (imports) => ({ instance: await WebAssembly.instantiate(noSimdWasm, imports) })
);

test("RFC 9106 section 5.3 Argon2id known-answer vector", async () => {
  const tag = await compute({
    password: new Uint8Array(32).fill(0x01),
    salt: new Uint8Array(16).fill(0x02),
    secret: new Uint8Array(8).fill(0x03),
    ad: new Uint8Array(12).fill(0x04),
    parallelism: 4,
    passes: 3,
    memorySize: 32,
    tagLength: 32,
  });

  assert.equal(
    Buffer.from(tag).toString("hex"),
    "0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659",
    "Argon2id v1.3 output matches RFC 9106"
  );
});
