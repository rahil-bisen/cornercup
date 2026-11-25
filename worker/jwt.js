// F-07 phase 2B. Pure RS256 verification. Nothing here performs I/O, so every decision below is
// testable without a network and the same code is what runs in the Worker.
//
// Rules that are deliberate, not incidental:
//   * RS256 only. `alg` is compared to the literal string before the key is imported, so `none` and
//     the HS256-with-the-public-key confusion are both unreachable rather than merely unhandled.
//   * A missing `kid` is a rejection. Picking a key by guess would make rotation unsafe.
//   * `aud` is strict: an absent audience is a rejection, not "anything matches".
//   * `iss` is one pinned string, not a list and not a prefix match.
// Clock skew is bounded to 60 seconds, which is WorkOS's own published guidance for their JWTs.

const ALG = "RS256";
const SKEW_SECONDS = 60;

function b64urlToBytes(text) {
  const normalised = String(text).replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised + "=".repeat((4 - (normalised.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Splits a compact JWS into its three parts and parses the two JSON envelopes. Returns null for
// anything that is not exactly three non-empty segments of JSON objects.
export function decodeJwt(token) {
  if (typeof token !== "string" || token.length === 0 || token.length > 8192) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) return null;

  let header;
  let payload;
  try {
    header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0])));
    payload = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1])));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || Array.isArray(header)) return null;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;

  return {
    header,
    payload,
    signingInput: `${parts[0]}.${parts[1]}`,
    signature: b64urlToBytes(parts[2]),
  };
}

// The JWK is rebuilt from the fields we need instead of being passed through, so an unexpected
// `kty`, a symmetric `k` or an embedded certificate cannot influence the import.
function verificationKey(jwk) {
  if (!jwk || typeof jwk !== "object") return null;
  if (jwk.kty !== "RSA") return null;
  if (typeof jwk.n !== "string" || typeof jwk.e !== "string") return null;
  if (jwk.alg && jwk.alg !== ALG) return null;
  if (jwk.use && jwk.use !== "sig") return null;
  // Only the public components are carried over. The JOSE `alg` name is not a WebCrypto algorithm
  // identifier, and passing it through makes importKey reject the key.
  return { kty: "RSA", n: jwk.n, e: jwk.e, ext: true };
}

// Returns the matching key from a JWKS, or null. Exactly one key must match the `kid`.
export function selectKey(jwks, kid) {
  const keys = jwks && Array.isArray(jwks.keys) ? jwks.keys : null;
  if (!keys || typeof kid !== "string" || !kid) return null;
  const matches = keys.filter((key) => key && key.kid === kid);
  if (matches.length !== 1) return null;
  return verificationKey(matches[0]);
}

export async function verifySignature(jwt, jwk) {
  if (!jwt || !jwk) return false;
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    return await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      jwt.signature,
      new TextEncoder().encode(jwt.signingInput)
    );
  } catch {
    return false;
  }
}

// Claim validation. Every failure is a named reason so tests and logs can distinguish "expired"
// from "wrong issuer"; the reason never includes a claim value.
export function validateClaims(payload, { issuer, audience, now = Date.now(), expectedSubject } = {}) {
  const seconds = Math.floor(now / 1000);
  const value = payload || {};

  if (!issuer) return { ok: false, reason: "no-issuer-configured" };
  if (value.iss !== issuer) return { ok: false, reason: "issuer" };

  if (!audience) return { ok: false, reason: "no-audience-configured" };
  const aud = value.aud;
  const accepted = typeof aud === "string" ? [aud] : Array.isArray(aud) ? aud.filter((a) => typeof a === "string") : null;
  if (!accepted || accepted.length === 0) return { ok: false, reason: "audience-missing" };
  if (!accepted.includes(audience)) return { ok: false, reason: "audience" };

  if (typeof value.exp !== "number" || !Number.isFinite(value.exp)) return { ok: false, reason: "exp-missing" };
  if (value.exp + SKEW_SECONDS <= seconds) return { ok: false, reason: "expired" };

  if (typeof value.iat !== "number" || !Number.isFinite(value.iat)) return { ok: false, reason: "iat-missing" };
  if (value.iat - SKEW_SECONDS > seconds) return { ok: false, reason: "iat-future" };

  // `nbf` is only checked when it is present, but a present-and-invalid value is a rejection rather
  // than being ignored.
  if (value.nbf !== undefined) {
    if (typeof value.nbf !== "number" || !Number.isFinite(value.nbf)) return { ok: false, reason: "nbf-invalid" };
    if (value.nbf - SKEW_SECONDS > seconds) return { ok: false, reason: "not-yet-valid" };
  }

  if (typeof value.sub !== "string" || !/^user_[A-Za-z0-9_-]{1,128}$/.test(value.sub)) {
    return { ok: false, reason: "sub" };
  }
  if (expectedSubject && value.sub !== expectedSubject) return { ok: false, reason: "sub-mismatch" };

  // A provider session id is optional: it is reported separately and never required here, because
  // local session security must not depend on a claim the provider may omit.
  return { ok: true, claims: value };
}

// The provider session id, if the token carries a well-formed one. Anything else is null: never a
// hash, never the local session id, never a placeholder.
export function providerSessionId(payload) {
  const sid = payload ? payload.sid : undefined;
  if (typeof sid !== "string") return null;
  return /^session_[A-Za-z0-9_-]{1,128}$/.test(sid) ? sid : null;
}

// Full verification. `jwks` is the set to try; `refetch` is called once when the `kid` is unknown,
// which is how rotation is handled without a permanent failure until the cache expires.
export async function verifyToken(token, { jwks, refetch, issuer, audience, now, expectedSubject } = {}) {
  const jwt = decodeJwt(token);
  if (!jwt) return { ok: false, reason: "malformed" };
  if (jwt.header.alg !== ALG) return { ok: false, reason: "alg" };
  if (typeof jwt.header.kid !== "string" || !jwt.header.kid) return { ok: false, reason: "kid" };

  let key = selectKey(jwks, jwt.header.kid);
  if (!key && typeof refetch === "function") {
    const refreshed = await refetch();
    key = selectKey(refreshed, jwt.header.kid);
  }
  if (!key) return { ok: false, reason: "unknown-key" };

  if (!(await verifySignature(jwt, key))) return { ok: false, reason: "signature" };

  const claims = validateClaims(jwt.payload, { issuer, audience, now, expectedSubject });
  if (!claims.ok) return claims;

  return { ok: true, claims: claims.claims, sessionId: providerSessionId(claims.claims) };
}
