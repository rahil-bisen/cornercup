// Guest order tracking capability (F-02 / F-03).
//
// A guest proves ownership of an order with a bearer token. The token itself is never stored: D1 keeps
// only its SHA-256 hash. It is *derived* rather than saved, which is what lets an idempotent checkout
// replay hand the same token back even though the database holds no usable credential.
//
//   token = base64url( HMAC-SHA256( key, "v1:<cafe_id>:<order_id>:<nonce>" ) )    43 chars, 256 bits
//   key   = SHA-256( "corner-cup/order-track/v1|" + (ORDER_TRACK_SECRET || ADMIN_SECRET) )
//   nonce = 24 random bytes from crypto.getRandomValues, stored with the order
//
// Neither stored value is a credential on its own: the nonce cannot be turned into a token without the
// key, and the key cannot reproduce a token without the nonce. A database dump therefore yields
// nothing replayable, and the plaintext token never touches D1, a log line, or a staff response.

const VERSION = "v1";
const NONCE_BYTES = 24;
const HEADER = "x-order-token";

// The header a guest client uses to present its token. Headers rather than query strings keep the
// capability out of access logs and Referer values.
export const TRACK_HEADER = HEADER;

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function toHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Guest tracking needs a signing key. Without one no token can be issued or verified, so checkout
// refuses rather than creating an order nobody can ever track.
export function trackingConfigured(env) {
  return Boolean(env.ORDER_TRACK_SECRET || env.ADMIN_SECRET);
}

// A dedicated subkey, so the session signer is never used directly as the tracking key and rotating
// one does not silently weaken the other.
async function trackingKey(env) {
  const secret = env.ORDER_TRACK_SECRET || env.ADMIN_SECRET;
  if (!secret) return null;
  const derived = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`corner-cup/order-track/v1|${secret}`)
  );
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
}

// 192 bits of CSPRNG output per order, so two orders never share token material.
export function newTrackNonce() {
  return base64url(crypto.getRandomValues(new Uint8Array(NONCE_BYTES)));
}

export async function trackToken(env, { cafeId, orderId, nonce }) {
  if (!nonce) return null;
  const key = await trackingKey(env);
  if (!key) return null;
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${VERSION}:${Number(cafeId)}:${orderId}:${nonce}`)
  );
  return base64url(new Uint8Array(signature));
}

// What goes into D1. Comparing this against the stored value is a constant-time comparison in the API,
// and the café + order are part of the derived message, so a hash can only ever match its own order.
export async function trackHash(token) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(token || "")));
  return toHex(new Uint8Array(digest));
}

export function readTrackToken(request) {
  const value = request.headers.get(HEADER);
  return value ? String(value).trim() : "";
}
