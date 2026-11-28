// Registers the Argon2id wasm hooks for `node --test`. Test scripts pass this with
// `--import ./tests/setup/register.mjs`; it is not referenced by any runtime or build path.
import { registerHooks } from "node:module";
import { createHash } from "node:crypto";

import * as argon2idWasm from "./argon2id-wasm-hooks.mjs";

registerHooks({
  load: argon2idWasm.load,
});

// One client address per test file, for requests to the local test Workers.
//
// The Worker allows 600 requests a minute per client address. Without this, every request in the whole
// suite that sets no address of its own arrives as the same client (127.0.0.1), so the suite as a
// whole sat right at that ceiling and CI failed with 429s whenever it ran fast enough. Each test file
// now arrives as its own client, the way separate guests would. The limits themselves are unchanged,
// and a test that sets cf-connecting-ip or x-forwarded-for itself (the rate-limit and lockout suites)
// keeps exactly the address it chose.
const HARNESS_PORTS = new Set(["8789", "8790"]);
const testFile = process.argv.find((arg) => /\.test\.mjs$/.test(arg)) || process.argv[1] || "unknown";
const digest = createHash("sha256").update(testFile).digest();
// 198.18.0.0/15 is reserved for benchmarking, so it can never be a real visitor.
const FILE_CLIENT_IP = `198.${18 + (digest[0] & 1)}.${digest[1]}.${digest[2]}`;

function isHarnessUrl(input) {
  try {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url);
    return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && HARNESS_PORTS.has(url.port);
  } catch {
    return false;
  }
}

if (typeof globalThis.fetch === "function") {
  const realFetch = globalThis.fetch;
  globalThis.fetch = function fetchWithFileClient(input, init) {
    if (!isHarnessUrl(input)) return realFetch(input, init);
    const headers = new Headers(init && init.headers ? init.headers : input instanceof Request ? input.headers : undefined);
    if (!headers.has("cf-connecting-ip") && !headers.has("x-forwarded-for")) {
      headers.set("cf-connecting-ip", FILE_CLIENT_IP);
    }
    return realFetch(input, { ...(init || {}), headers });
  };
}
