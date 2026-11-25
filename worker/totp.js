// RFC 6238 TOTP for owner sign-in, plus the pieces around it that a second factor actually needs:
// an encrypted secret at rest, a replay counter, and hashed single-use recovery codes.
//
// Everything here is pure WebCrypto and pure functions, so the same code runs in workerd and in the
// Node test runner. No dependency is added: HMAC-SHA1 over `crypto.subtle` costs well under a
// millisecond, which is the one auth primitive this project can afford on a Free-plan Worker.
//
// Security rules encoded here, not merely documented:
//   * the secret is 20 random bytes from the platform CSPRNG, never derived from a password;
//   * it is stored only as AES-256-GCM ciphertext under a key separated from the session key;
//   * verification accepts the current step and ±1 step (bounded clock skew) and nothing wider;
//   * a code is accepted at most once: the caller must persist the returned `step` and refuse any
//     later code whose step is not greater (replay protection);
//   * comparison is constant time;
//   * recovery codes are stored as SHA-256 digests and are single-use in the caller's SQL.
//
// It deliberately performs no I/O and knows nothing about D1, so it is testable with RFC vectors.

export const TOTP_DIGITS = 6;
export const TOTP_PERIOD = 30;
export const TOTP_WINDOW = 1;
export const TOTP_SECRET_BYTES = 20;
export const TOTP_ISSUER = "Corner Cup";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const RECOVERY_GROUPS = 2;
const RECOVERY_GROUP_LENGTH = 4;
export const RECOVERY_CODE_COUNT = 10;

// ---------------------------------------------------------------- base32

export function base32Encode(bytes) {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text) {
  const clean = String(text == null ? "" : text)
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/=+$/, "");
  if (!clean) return null;
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Uint8Array.from(out);
}

// ---------------------------------------------------------------- HOTP / TOTP

export function generateSecret(bytes = TOTP_SECRET_BYTES) {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

function counterBytes(counter) {
  const buffer = new Uint8Array(8);
  let value = BigInt(counter);
  for (let i = 7; i >= 0; i -= 1) {
    buffer[i] = Number(value & 0xffn);
    value >>= 8n;
  }
  return buffer;
}

async function hmacSha1(keyBytes, messageBytes) {
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, messageBytes);
  return new Uint8Array(signature);
}

// RFC 4226 §5.2 dynamic truncation, rendered at the requested digit count.
export async function hotp(secret, counter, digits = TOTP_DIGITS) {
  const digest = await hmacSha1(secret, counterBytes(counter));
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  const modulo = 10 ** digits;
  return String(binary % modulo).padStart(digits, "0");
}

export function stepFor(now = Date.now(), period = TOTP_PERIOD) {
  return Math.floor(now / 1000 / period);
}

export async function totp(secret, { now = Date.now(), period = TOTP_PERIOD } = {}) {
  const step = stepFor(now, period);
  return { code: await hotp(secret, step), step };
}

function constantTimeEqual(a, b) {
  const left = String(a == null ? "" : a);
  const right = String(b == null ? "" : b);
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let i = 0; i < left.length; i += 1) mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
  return mismatch === 0;
}

// Accepts only the documented shape: exactly `digits` decimal characters after stripping spaces and
// dashes. Anything else is a refusal before any HMAC runs.
export function normaliseTotpCode(raw) {
  const text = String(raw == null ? "" : raw).replace(/[\s-]/g, "");
  if (!/^\d{6}$/.test(text)) return null;
  return text;
}

// Verifies a code against the current step and a bounded window. `lastStep` is the highest step this
// café has already spent; a code whose step is not greater is a replay and is refused. The returned
// `step` is the value the caller must persist, in a conditional UPDATE, before treating the login as
// successful.
export async function verifyTotp(
  secret,
  code,
  { now = Date.now(), period = TOTP_PERIOD, window = TOTP_WINDOW, lastStep = null } = {}
) {
  const candidate = normaliseTotpCode(code);
  if (!candidate) return { ok: false, reason: "shape" };
  if (!secret || secret.length < 10) return { ok: false, reason: "secret" };

  const current = stepFor(now, period);
  for (let offset = -window; offset <= window; offset += 1) {
    const step = current + offset;
    if (step < 0) continue;
    if (lastStep != null && step <= Number(lastStep)) continue; // already spent
    const expected = await hotp(secret, step);
    if (constantTimeEqual(candidate, expected)) return { ok: true, step };
  }
  return { ok: false, reason: "mismatch" };
}

// ---------------------------------------------------------------- otpauth URI

export function otpauthUri({ secret, account, issuer = TOTP_ISSUER, digits = TOTP_DIGITS, period = TOTP_PERIOD }) {
  const label = encodeURIComponent(`${issuer}:${account || "owner"}`);
  const params = new URLSearchParams({
    secret: typeof secret === "string" ? secret : base32Encode(secret),
    issuer,
    algorithm: "SHA1",
    digits: String(digits),
    period: String(period),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ---------------------------------------------------------------- secret at rest

// The secret is never stored in the clear. The AES-256-GCM key is derived with HKDF-SHA256 from a
// dedicated `MFA_ENC_KEY`, never from `ADMIN_SECRET`. There is no fallback: a deployment without a
// valid key cannot use TOTP at all, enrollment answers 503, and existing enrollments fail closed
// with a 503 rather than being decrypted under the session-signing secret.
//
// Key shape is strict: exactly 32 CSPRNG bytes encoded as unpadded base64url (43 characters). A
// passphrase, a hex string, a padded base64 string or a short value is rejected before any HKDF
// runs, so a typo cannot silently become a weaker key.
//
// Rotation is supported without invalidating enrollments: `MFA_ENC_KEY_PREVIOUS` is decrypt-only.
// New ciphertext always uses `MFA_ENC_KEY`; decryption tries the current key and then the previous
// one. A previous key is never used to encrypt, and a missing current key is a hard failure even if
// a previous key is present.
const HKDF_SALT = new TextEncoder().encode("corner-cup/mfa/salt/v1");
const HKDF_INFO = new TextEncoder().encode("corner-cup/mfa/secret/v1");
const GCM_AAD = new TextEncoder().encode("corner-cup/mfa/v1");

export const MFA_KEY_BYTES = 32;
export const MFA_KEY_LENGTH = 43;
export const MFA_ENVELOPE_PREFIX = "v2";

// Unpadded base64url for exactly 32 bytes. The length check is part of the shape, not a suggestion.
const MFA_KEY_PATTERN = new RegExp(`^[A-Za-z0-9_-]{${MFA_KEY_LENGTH}}$`);

function b64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(text) {
  try {
    const normalised = String(text).replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
    return Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  } catch {
    return null;
  }
}

// Returns the canonical key material, or null. Canonical means the decoded 32 bytes re-encode to the
// exact input, which also rejects non-canonical trailing bits that some encoders emit.
function decodeMfaKey(raw) {
  const material = String(raw == null ? "" : raw);
  // No trimming: a key with surrounding whitespace is a configuration mistake, not a valid key.
  if (material !== material.trim()) return null;
  if (!MFA_KEY_PATTERN.test(material)) return null;
  const bytes = unb64url(material);
  if (!bytes || bytes.length !== MFA_KEY_BYTES) return null;
  if (b64url(bytes) !== material) return null;
  return material;
}

// HKDF input is the canonical text (not the decoded bytes) on purpose: the local pilot's existing
// ciphertext was produced from this exact material, so changing it would make every enrolled secret
// undecryptable for no security gain.
async function deriveKey(material, usages) {
  try {
    const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(material), "HKDF", false, [
      "deriveKey",
    ]);
    return await crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt: HKDF_SALT, info: HKDF_INFO },
      base,
      { name: "AES-GCM", length: 256 },
      false,
      usages
    );
  } catch {
    return null;
  }
}

async function encryptionKey(env) {
  const material = decodeMfaKey(env && env.MFA_ENC_KEY);
  if (!material) return null;
  return deriveKey(material, ["encrypt", "decrypt"]);
}

async function previousEncryptionKey(env) {
  const material = decodeMfaKey(env && env.MFA_ENC_KEY_PREVIOUS);
  if (!material) return null;
  return deriveKey(material, ["decrypt"]);
}

// "ok" | "missing" | "malformed" — safe to log: it never contains or derives from the value.
export function mfaKeyState(env) {
  const raw = env && env.MFA_ENC_KEY;
  if (raw == null || String(raw).trim() === "") return "missing";
  return decodeMfaKey(raw) ? "ok" : "malformed";
}

export async function mfaConfigured(env) {
  return (await encryptionKey(env)) !== null;
}

// Returns `v2.iv.ciphertext` in base64url, or null when the deployment has no valid current key.
export async function encryptSecret(env, secret) {
  const key = await encryptionKey(env);
  if (!key) return null;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: GCM_AAD },
      key,
      secret
    );
    return `${MFA_ENVELOPE_PREFIX}.${b64url(iv)}.${b64url(new Uint8Array(ciphertext))}`;
  } catch {
    return null;
  }
}

function envelopeOf(payload) {
  const parts = String(payload || "").split(".");
  // Current format is `v2.<iv>.<data>`; the pre-rotation format is `<iv>.<data>`, and it is still
  // accepted under the same key so an existing enrollment survives this change.
  if (parts.length === 3 && parts[0] === MFA_ENVELOPE_PREFIX) return { ivPart: parts[1], dataPart: parts[2] };
  if (parts.length === 2) return { ivPart: parts[0], dataPart: parts[1] };
  return null;
}

export async function decryptSecret(env, payload) {
  const envelope = envelopeOf(payload);
  if (!envelope) return null;
  const iv = unb64url(envelope.ivPart);
  const data = unb64url(envelope.dataPart);
  if (!iv || !data || iv.length !== 12) return null;

  // Current key first, then the decrypt-only previous key. A missing or invalid current key returns
  // null before this loop, so a rotation mistake cannot silently fall back to a retired key.
  const key = await encryptionKey(env);
  if (!key) return null;
  const keys = [key];
  const previous = await previousEncryptionKey(env);
  if (previous) keys.push(previous);

  for (const candidate of keys) {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: "AES-GCM", iv, additionalData: GCM_AAD },
        candidate,
        data
      );
      const bytes = new Uint8Array(plain);
      if (bytes.length >= 10) return bytes;
    } catch {
      // Try the next key; a wrong key is indistinguishable from tampering and both fail closed.
    }
  }
  return null;
}

// ---------------------------------------------------------------- recovery codes

async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// `XXXX-XXXX` from an alphabet without look-alike characters, so a code read off a screen is typed
// correctly. The plaintext exists only in the response that creates it.
function randomRecoveryCode() {
  const groups = [];
  for (let g = 0; g < RECOVERY_GROUPS; g += 1) {
    const bytes = crypto.getRandomValues(new Uint8Array(RECOVERY_GROUP_LENGTH));
    let group = "";
    for (const byte of bytes) group += RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length];
    groups.push(group);
  }
  return groups.join("-");
}

export async function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i += 1) {
    const code = randomRecoveryCode();
    codes.push({ code, hash: await sha256Hex(normaliseRecoveryCode(code)) });
  }
  return codes;
}

// Uppercase, strip separators: `abcd-efgh` and `ABCDEFGH` are the same code.
export function normaliseRecoveryCode(raw) {
  return String(raw == null ? "" : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function looksLikeRecoveryCode(raw) {
  const text = String(raw == null ? "" : raw).trim();
  if (/^\d{6}$/.test(text)) return false;
  return normaliseRecoveryCode(text).length === RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH;
}

export async function hashRecoveryCode(raw) {
  const normalised = normaliseRecoveryCode(raw);
  if (normalised.length !== RECOVERY_GROUPS * RECOVERY_GROUP_LENGTH) return null;
  return sha256Hex(normalised);
}
