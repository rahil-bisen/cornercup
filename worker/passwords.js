// Owner password hashing. It lives on its own because two producers need it: the café module (create,
// change, operator reset) and the database bootstrap that seeds the primary café's password from
// OWNER_PASSWORD. Having either import the other would be a circular import.
//
// F-07 remediation: new passwords are Argon2id at the OWASP baseline (m=19 MiB, t=2, p=1). The wasm
// module is statically imported, never compiled at runtime: workerd refuses compiling WebAssembly from
// bytes, which is why hash-wasm cannot run here and this library takes a pre-compiled module instead.
import setupWasm from "argon2id/lib/setup.js";
import simdWasm from "argon2id/dist/simd.wasm";
import noSimdWasm from "argon2id/dist/no-simd.wasm";

const ARGON2 = { m: 19456, t: 2, p: 1 };
const SALT_BYTES = 16;
const TAG_BYTES = 32;

// The Argon2id library refuses a password shorter than 8 bytes. Nothing this module hashes can be
// shorter (every caller enforces a 12-character floor), so such a value can never match a stored
// Argon2id hash: verification fails closed. This is reachable from sign-in, where a guess like
// "1234" arrives before any policy check — throwing there would answer 500 and skip the lockout
// counter instead of recording a failed attempt.
const PASSWORD_MIN_BYTES = 8;

// Anything longer than this is not a hash this code wrote, so it is rejected before any parsing work.
const STORED_MAX_LENGTH = 200;

// Cloudflare's WebCrypto implementation refuses PBKDF2 above 100,000 iterations ("iteration counts
// above 100000 are not supported"), and a pure-JS derivation at 600,000 does not fit the per-invocation
// CPU budget. Legacy hashes above this ceiling are therefore reported as needing a reset rather than
// being verified at a weaker cost.
const PBKDF2_MAX_SUPPORTED = 100_000;
const PBKDF2_MIN_SUPPORTED = 1_000;

// One hash at a time per isolate, plus a small bounded queue. Argon2id reserves roughly 65 MB of wasm
// memory and 19 MiB per derivation, so overlapping hashes inside one isolate exhaust the memory limit;
// the queue makes that impossible and refuses work rather than growing without bound.
const MAX_QUEUE = 3;

const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d{1,6}),t=(\d{1,3}),p=(\d{1,2})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;
const PBKDF2_PATTERN = /^pbkdf2\$(\d{1,7})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

export class PasswordQueueFullError extends Error {
  constructor() {
    super("password hashing queue is full");
    this.name = "PasswordQueueFullError";
  }
}

let wasm = null;
let running = false;
const waiters = [];
const encoder = new TextEncoder();

function b64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function unb64(text) {
  try {
    return Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i] ^ b[i];
  return mismatch === 0;
}

async function computer() {
  if (!wasm) {
    // setupWasm reads `.instance` from whatever the loader returns.
    wasm = await setupWasm(
      async (imports) => ({ instance: await WebAssembly.instantiate(simdWasm, imports) }),
      async (imports) => ({ instance: await WebAssembly.instantiate(noSimdWasm, imports) })
    );
  }
  return wasm;
}

async function derive(passwordBytes, salt) {
  const compute = await computer();
  // The library already returns a fresh Uint8Array for the tag; copying it again would only add work.
  return compute({
    password: passwordBytes,
    salt,
    passes: ARGON2.t,
    parallelism: ARGON2.p,
    memorySize: ARGON2.m,
    tagLength: TAG_BYTES,
  });
}

// Resolves once this request may hash, or rejects immediately when the queue is full. A rejection is
// the caller's cue to answer with a controlled "busy" response instead of waiting indefinitely.
function acquire() {
  if (!running) {
    running = true;
    return Promise.resolve();
  }
  if (waiters.length >= MAX_QUEUE) return Promise.reject(new PasswordQueueFullError());
  return new Promise((resolve) => waiters.push(resolve));
}

function release() {
  const next = waiters.shift();
  if (next) next();
  else running = false;
}

async function withSlot(work) {
  await acquire();
  try {
    return await work();
  } finally {
    release();
  }
}

function parseArgon2(stored) {
  if (typeof stored !== "string" || stored.length > STORED_MAX_LENGTH) return null;
  const match = PHC_PATTERN.exec(stored);
  if (!match) return null;
  // Exact parameter allowlist, checked before a single byte is allocated for the derivation.
  if (Number(match[1]) !== ARGON2.m || Number(match[2]) !== ARGON2.t || Number(match[3]) !== ARGON2.p) {
    return null;
  }
  const salt = unb64(match[4]);
  const tag = unb64(match[5]);
  if (!salt || !tag) return null;
  if (salt.length !== SALT_BYTES || tag.length !== TAG_BYTES) return null;
  return { salt, tag };
}

function parsePbkdf2(stored) {
  if (typeof stored !== "string" || stored.length > STORED_MAX_LENGTH) return null;
  const match = PBKDF2_PATTERN.exec(stored);
  if (!match) return null;
  const iterations = Number(match[1]);
  if (!Number.isSafeInteger(iterations) || iterations < PBKDF2_MIN_SUPPORTED) return null;
  const salt = unb64(match[2]);
  const tag = unb64(match[3]);
  if (!salt || !tag || salt.length === 0 || tag.length === 0) return null;
  return { iterations, salt, tag };
}

async function derivePbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
    "deriveBits",
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    TAG_BYTES * 8
  );
  return new Uint8Array(bits);
}

// Every café keeps its own owner password. Hashing it means a database dump does not hand over
// every client's staff board.
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  const passwordBytes = encoder.encode(password);
  const tag = await withSlot(() => derive(passwordBytes, salt));
  return `$argon2id$v=19$m=${ARGON2.m},t=${ARGON2.t},p=${ARGON2.p}$${b64(salt)}$${b64(tag)}`;
}

// True when a stored value uses the format this deployment now writes.
export function isArgon2Hash(stored) {
  return parseArgon2(stored) !== null;
}

// True when the stored value is a legacy PBKDF2 hash whose work factor this runtime cannot compute. The
// login route answers this with a controlled "ask the operator to reset it" instead of verifying at a
// lower iteration count.
export function passwordNeedsReset(stored) {
  const legacy = parsePbkdf2(stored);
  return Boolean(legacy && legacy.iterations > PBKDF2_MAX_SUPPORTED);
}

export async function verifyPassword(password, stored) {
  const argon2 = parseArgon2(stored);
  if (argon2) {
    // Encode once: the length check and the derivation use the same bytes.
    const passwordBytes = encoder.encode(String(password));
    if (passwordBytes.length < PASSWORD_MIN_BYTES) return false;
    const candidate = await withSlot(() => derive(passwordBytes, argon2.salt));
    return constantTimeEqual(candidate, argon2.tag);
  }

  const legacy = parsePbkdf2(stored);
  if (!legacy) return false;
  // Never silently downgrade: an unsupported work factor fails closed rather than being recomputed at
  // a cheaper count.
  if (legacy.iterations > PBKDF2_MAX_SUPPORTED) return false;

  const candidate = await withSlot(() => derivePbkdf2(password, legacy.salt, legacy.iterations));
  return constantTimeEqual(candidate, legacy.tag);
}
