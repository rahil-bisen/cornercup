// RFC 6238 / RFC 4226 vectors and the properties the owner second factor depends on.
//
// These run against worker/totp.js directly, with no database and no harness: if a vector fails here,
// no amount of HTTP testing can make the sign-in correct. The reference vectors come from RFC 6238
// Appendix B (SHA-1 seed "12345678901234567890"), rendered at 8 digits as the RFC states; this
// project uses 6, so the last six digits of each vector are the expected value.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  hotp,
  looksLikeRecoveryCode,
  mfaConfigured,
  mfaKeyState,
  normaliseRecoveryCode,
  normaliseTotpCode,
  otpauthUri,
  stepFor,
  totp,
  verifyTotp,
} from "../worker/totp.js";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const RFC_SECRET = new TextEncoder().encode("12345678901234567890");
const RFC_VECTORS = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

test("RFC 6238 SHA-1 vectors match at eight digits", async () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    const counter = Math.floor(seconds / 30);
    assert.equal(await hotp(RFC_SECRET, counter, 8), expected, `t=${seconds}`);
  }
});

test("the six-digit code is the low six digits of the reference value", async () => {
  for (const [seconds, expected] of RFC_VECTORS) {
    const counter = Math.floor(seconds / 30);
    assert.equal(await hotp(RFC_SECRET, counter), expected.slice(-6), `t=${seconds}`);
  }
});

test("base32 round-trips the RFC seed and refuses foreign characters", () => {
  assert.equal(base32Encode(RFC_SECRET), "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
  assert.deepEqual([...base32Decode("GEZD GNBV-GY3TQOJQGEZDGNBVGY3TQOJQ")], [...RFC_SECRET]);
  assert.equal(base32Decode("GEZDGNBV1"), null, "1 is not in the RFC 4648 alphabet");
  assert.equal(base32Decode(""), null);
});

test("a generated secret is 20 bytes of platform randomness", () => {
  const first = generateSecret();
  const second = generateSecret();
  assert.equal(first.length, 20);
  assert.notDeepEqual([...first], [...second]);
});

test("verification accepts the current step and one step of skew either way", async () => {
  const now = 1_700_000_000_000;
  const current = stepFor(now);
  const codeAt = async (step) => hotp(RFC_SECRET, step);

  for (const offset of [-1, 0, 1]) {
    const result = await verifyTotp(RFC_SECRET, await codeAt(current + offset), { now });
    assert.equal(result.ok, true, `offset ${offset} is inside the window`);
    assert.equal(result.step, current + offset);
  }
  for (const offset of [-2, 2, 5]) {
    const result = await verifyTotp(RFC_SECRET, await codeAt(current + offset), { now });
    assert.equal(result.ok, false, `offset ${offset} is outside the window`);
  }
});

test("a code is refused once its step has been spent", async () => {
  const now = 1_700_000_000_000;
  const step = stepFor(now);
  const code = await hotp(RFC_SECRET, step);

  assert.equal((await verifyTotp(RFC_SECRET, code, { now })).ok, true);
  assert.equal((await verifyTotp(RFC_SECRET, code, { now, lastStep: step })).ok, false, "replay");
  // A later step is still usable even though the previous one is burned.
  assert.equal((await verifyTotp(RFC_SECRET, await hotp(RFC_SECRET, step + 1), { now, lastStep: step })).ok, true);
});

test("only six decimal digits are even considered", async () => {
  assert.equal(normaliseTotpCode("123 456"), "123456");
  assert.equal(normaliseTotpCode("123-456"), "123456");
  for (const bad of ["", "12345", "1234567", "abcdef", "12345a", null, undefined, "１２３４５６"]) {
    assert.equal(normaliseTotpCode(bad), null, String(bad));
  }
  assert.equal((await verifyTotp(RFC_SECRET, "abcdef")).ok, false);
  assert.equal((await verifyTotp(RFC_SECRET, "123456", { now: 59_000 })).ok, false, "wrong code");
  assert.equal((await verifyTotp(new Uint8Array(4), "123456")).ok, false, "secret too short");
});

test("the otpauth URI names the issuer, account and parameters authenticators expect", () => {
  const uri = otpauthUri({ secret: base32Encode(RFC_SECRET), account: "corner-cup" });
  assert.ok(uri.startsWith("otpauth://totp/Corner%20Cup%3Acorner-cup?"));
  const params = new URL(uri.replace("otpauth://", "https://")).searchParams;
  assert.equal(params.get("secret"), base32Encode(RFC_SECRET));
  assert.equal(params.get("issuer"), "Corner Cup");
  assert.equal(params.get("algorithm"), "SHA1");
  assert.equal(params.get("digits"), "6");
  assert.equal(params.get("period"), "30");
});

test("totp() and stepFor() agree on the current step", async () => {
  const now = 1_700_000_000_000;
  const { code, step } = await totp(RFC_SECRET, { now });
  assert.equal(step, stepFor(now));
  assert.equal(code, await hotp(RFC_SECRET, step));
});

/* ------------------------------------------------------------------ secret at rest */

// Two independent, canonical 32-byte base64url keys (bytes 0..31 and 32..63). Test-only constants:
// they are not deployment secrets and are never written to any environment file.
const KEY_A = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8";
const KEY_B = "ICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj8";

// The pre-rotation storage format was `iv.ciphertext`; the current one is `v2.iv.ciphertext`.
const withoutEnvelope = (sealed) => sealed.split(".").slice(1).join(".");

test("the secret is stored as a versioned AES-256-GCM envelope under MFA_ENC_KEY", async () => {
  const env = { MFA_ENC_KEY: KEY_A };
  const secret = generateSecret();
  const sealed = await encryptSecret(env, secret);
  assert.ok(sealed && sealed.startsWith("v2."), "the envelope is versioned");
  assert.equal(sealed.split(".").length, 3, "v2.iv.ciphertext");
  assert.ok(!sealed.includes(base32Encode(secret)), "the plaintext never appears");

  const opened = await decryptSecret(env, sealed);
  assert.deepEqual([...opened], [...secret]);

  const again = await encryptSecret(env, secret);
  assert.notEqual(again, sealed, "a fresh 12-byte IV per encryption");

  assert.equal(await decryptSecret({ MFA_ENC_KEY: KEY_B }, sealed), null, "a different key cannot open it");
  const [prefix, iv, data] = sealed.split(".");
  const tampered = `${prefix}.${iv}.${data.slice(0, -2)}${data.slice(-2) === "AA" ? "BB" : "AA"}`;
  assert.equal(await decryptSecret(env, tampered), null, "GCM refuses a modified ciphertext");
  assert.equal(await decryptSecret(env, "nonsense"), null);
  assert.equal(await decryptSecret(env, "v2.garbage"), null);
});

test("ADMIN_SECRET alone is not an MFA key — there is no fallback", async () => {
  const secret = generateSecret();
  const sealed = await encryptSecret({ MFA_ENC_KEY: KEY_A }, secret);
  // Long enough to have satisfied the old >=16-character fallback, and still rejected.
  const adminOnly = { ADMIN_SECRET: "test-admin-secret-for-harness-only-but-long" };
  assert.equal(await mfaConfigured(adminOnly), false);
  assert.equal(await encryptSecret(adminOnly, secret), null, "an ADMIN_SECRET-only deployment cannot enroll");
  assert.equal(await decryptSecret(adminOnly, sealed), null, "and cannot decrypt an existing secret");

  // Independence in the other direction: the same string used as MFA_ENC_KEY does not make
  // ADMIN_SECRET a key, and nothing derives from ADMIN_SECRET.
  assert.equal(await mfaConfigured({ ADMIN_SECRET: KEY_A }), false);
});

test("malformed MFA_ENC_KEY values fail closed before any derivation", async () => {
  const secret = generateSecret();
  // An absent or blank value is reported as `missing`; a non-empty wrong value as `malformed`.
  for (const blank of ["", "   ", undefined, null]) {
    assert.equal(mfaKeyState({ MFA_ENC_KEY: blank }), "missing");
    assert.equal(await mfaConfigured({ MFA_ENC_KEY: blank }), false);
    assert.equal(await encryptSecret({ MFA_ENC_KEY: blank }, secret), null);
  }
  const malformed = [
    "short",
    KEY_A.slice(0, 42), // one character short
    `${KEY_A}=`, // padded base64, not the documented shape
    "0".repeat(64), // hex, not base64url
    KEY_A.slice(0, 42) + "=", // padding in the 43rd position
    KEY_A.slice(0, 42) + "!", // outside the base64url alphabet
    `${KEY_A.slice(0, 20)}.${KEY_A.slice(21)}`, // dot is outside the alphabet
  ];
  for (const value of malformed) {
    assert.equal(mfaKeyState({ MFA_ENC_KEY: value }), "malformed", `rejected: ${JSON.stringify(value)}`);
    assert.equal(await mfaConfigured({ MFA_ENC_KEY: value }), false);
    assert.equal(await encryptSecret({ MFA_ENC_KEY: value }, secret), null);
  }
  // Surrounding whitespace is a configuration error: no trimming, no silent acceptance.
  assert.equal(mfaKeyState({ MFA_ENC_KEY: ` ${KEY_A}` }), "malformed");
  assert.equal(mfaKeyState({ MFA_ENC_KEY: `${KEY_A} ` }), "malformed");
  assert.equal(await mfaConfigured({ MFA_ENC_KEY: ` ${KEY_A} ` }), false);

  // Non-canonical trailing bits: the same 32 bytes, a different 43rd character. Re-encoding rejects it.
  const noncanonical = `${KEY_A.slice(0, 42)}9`;
  assert.notEqual(noncanonical, KEY_A);
  assert.equal(mfaKeyState({ MFA_ENC_KEY: noncanonical }), "malformed");
  assert.equal(await mfaConfigured({ MFA_ENC_KEY: noncanonical }), false);
  assert.equal(mfaKeyState({}), "missing");
  assert.equal(mfaKeyState({ MFA_ENC_KEY: "" }), "missing");
});

test("a pre-rotation iv.ciphertext row still opens under the same key", async () => {
  const env = { MFA_ENC_KEY: KEY_A };
  const secret = generateSecret();
  const sealed = await encryptSecret(env, secret);
  const legacy = withoutEnvelope(sealed);
  assert.equal(legacy.split(".").length, 2);
  const opened = await decryptSecret(env, legacy);
  assert.deepEqual([...opened], [...secret], "existing enrollments survive the format change");

  // And a legacy row sealed under a different key still refuses to open.
  assert.equal(await decryptSecret({ MFA_ENC_KEY: KEY_B }, legacy), null);
});

test("rotation: MFA_ENC_KEY_PREVIOUS decrypts but never encrypts", async () => {
  const secret = generateSecret();
  const sealedUnderA = await encryptSecret({ MFA_ENC_KEY: KEY_A }, secret);

  const rotating = { MFA_ENC_KEY: KEY_B, MFA_ENC_KEY_PREVIOUS: KEY_A };
  assert.deepEqual([...await decryptSecret(rotating, sealedUnderA)], [...secret], "old rows stay readable");

  // New writes use only the current key.
  const sealedUnderB = await encryptSecret(rotating, secret);
  assert.ok(await decryptSecret({ MFA_ENC_KEY: KEY_B }, sealedUnderB), "opened by the current key alone");
  assert.equal(
    await decryptSecret({ MFA_ENC_KEY: KEY_A }, sealedUnderB),
    null,
    "the retired key cannot open new rows"
  );

  // Once the previous key is removed, old rows fail closed rather than opening with something else.
  assert.equal(await decryptSecret({ MFA_ENC_KEY: KEY_B }, sealedUnderA), null);
});

test("a missing current key is fatal even when a previous key is configured", async () => {
  const secret = generateSecret();
  const sealed = await encryptSecret({ MFA_ENC_KEY: KEY_A }, secret);
  const previousOnly = { MFA_ENC_KEY_PREVIOUS: KEY_A };
  assert.equal(mfaKeyState(previousOnly), "missing");
  assert.equal(await mfaConfigured(previousOnly), false);
  assert.equal(await encryptSecret(previousOnly, secret), null);
  assert.equal(await decryptSecret(previousOnly, sealed), null, "decrypt-only rotation cannot become a fallback");
});

test("an invalid previous key is ignored, and a valid current key still works", async () => {
  const secret = generateSecret();
  const env = { MFA_ENC_KEY: KEY_A, MFA_ENC_KEY_PREVIOUS: "too-short" };
  assert.equal(await mfaConfigured(env), true);
  const sealed = await encryptSecret(env, secret);
  assert.deepEqual([...await decryptSecret(env, sealed)], [...secret]);
  assert.equal(mfaKeyState({ MFA_ENC_KEY: KEY_A, MFA_ENC_KEY_PREVIOUS: "too-short" }), "ok");
});

test("an unsupported envelope version fails closed", async () => {
  const env = { MFA_ENC_KEY: KEY_A };
  const sealed = await encryptSecret(env, generateSecret());
  const [, iv, data] = sealed.split(".");
  assert.equal(await decryptSecret(env, `v3.${iv}.${data}`), null, "unknown versions are refused");
  assert.equal(await decryptSecret(env, `v1.${iv}.${data}`), null);
  assert.equal(await decryptSecret(env, `v2.${iv}`), null, "truncated envelopes are refused");
});

test("a previous key can open a legacy two-part row, only while the current key is valid", async () => {
  const secret = generateSecret();
  const legacy = withoutEnvelope(await encryptSecret({ MFA_ENC_KEY: KEY_A }, secret));
  const rotating = { MFA_ENC_KEY: KEY_B, MFA_ENC_KEY_PREVIOUS: KEY_A };
  assert.deepEqual([...await decryptSecret(rotating, legacy)], [...secret]);
  assert.equal(
    await decryptSecret({ MFA_ENC_KEY_PREVIOUS: KEY_A }, legacy),
    null,
    "previous key alone is not enough"
  );
});

test("an existing enrollment verifies a real TOTP code after decryption", async () => {
  const env = { MFA_ENC_KEY: KEY_A };
  const secret = generateSecret();
  const sealed = await encryptSecret(env, secret);
  const opened = await decryptSecret(env, withoutEnvelope(sealed));
  const now = 1_700_000_000_000;
  const { code } = await totp(opened, { now });
  const verified = await verifyTotp(opened, code, { now, lastStep: null });
  assert.equal(verified.ok, true, "the decrypted seed is the enrolled seed");
});

test("a deployment with no usable key cannot store a factor at all", async () => {
  assert.equal(await mfaConfigured({}), false);
  assert.equal(await encryptSecret({}, generateSecret()), null);
  assert.equal(await decryptSecret({}, "v2.a.b"), null);
});

/* ------------------------------------------------------------------ recovery codes */

test("recovery codes are single-use, hashed and unambiguous", async () => {
  const codes = await generateRecoveryCodes(10);
  assert.equal(codes.length, 10);
  const plain = codes.map((entry) => entry.code);
  assert.equal(new Set(plain).size, 10, "no duplicates");
  for (const code of plain) {
    assert.match(code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    assert.equal(looksLikeRecoveryCode(code), true);
    assert.equal(looksLikeRecoveryCode(code.replace("-", "")), true);
    assert.equal(looksLikeRecoveryCode(code.toLowerCase()), true);
  }
  for (const entry of codes) {
    assert.match(entry.hash, /^[0-9a-f]{64}$/);
    assert.equal(await hashRecoveryCode(entry.code), entry.hash);
    assert.equal(await hashRecoveryCode(entry.code.toLowerCase().replace("-", " ")), entry.hash);
  }
  assert.equal(normaliseRecoveryCode("abcd-efgh"), "ABCDEFGH");
  assert.equal(await hashRecoveryCode("abc"), null, "too short");
  assert.equal(await hashRecoveryCode("abcdefghijkl"), null, "too long");
  assert.match(await hashRecoveryCode("abcdefgh"), /^[0-9a-f]{64}$/, "eight characters is a valid length");
  assert.equal(looksLikeRecoveryCode("123456"), false, "a six-digit TOTP is not a recovery code");
  assert.equal(looksLikeRecoveryCode(""), false);
});
