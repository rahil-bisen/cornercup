// Security headers applied to every response: JSON (via json()) and static assets
// (via withSecurityHeaders around env.ASSETS.fetch in worker/index.js).
//
// CSP notes:
// - 'self' is the only script/style/font/img/connect origin by default.
// - Fonts are self-hosted under /fonts (WOFF2); no third-party font origins are allowed.
// - Razorpay Checkout is loaded dynamically only when online payments are configured:
//   script-src + frame-src + connect-src allow https://checkout.razorpay.com (and the
//   Razorpay API for client calls made by its SDK).
// - QR codes are generated as data: image URLs, so img-src allows data:.
// - The order token travels only in the URL fragment and an x-order-token header;
//   CSP does not touch fragments, and 'self' covers the same-origin API calls.
// - No 'unsafe-inline' / 'unsafe-eval': the app has no inline scripts, no eval and no
//   dangerouslySetInnerHTML. React applies no inline style attributes, so style-src
//   does not need 'unsafe-inline'.
const CSP = [
  "default-src 'self'",
  "script-src 'self' https://checkout.razorpay.com",
  "style-src 'self'",
  "font-src 'self' data:",
  "img-src 'self' data:",
  "connect-src 'self' https://api.razorpay.com https://checkout.razorpay.com",
  "frame-src https://checkout.razorpay.com",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
  "media-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "upgrade-insecure-requests",
].join("; ");

const SECURITY_HEADERS = {
  "content-security-policy": CSP,
  // Browsers only honour this over https; it is ignored by the plain-http local dev server, so it
  // does not change local behaviour. `preload` is deliberately absent: it is a one-way commitment.
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy":
    "geolocation=(), camera=(), microphone=(), payment=(self), usb=(), magnetometer=(), gyroscope=(), accelerometer=()",
};

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...SECURITY_HEADERS,
      ...headers,
    },
  });
}

// Wrap an arbitrary Response (e.g. a static asset from env.ASSETS.fetch) so the
// security headers are present without changing its body, status or other headers.
export function withSecurityHeaders(response) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// ---------------------------------------------------------------- body limits
//
// Every request body is read once, as a stream, and the byte count is enforced while it arrives.
// Content-Length is only an early hint: a client can omit it, or understate it, so the streamed
// count is the check that decides. Reading one chunk past the limit cancels the stream rather than
// buffering the rest of an oversized body.
export const BODY_LIMITS = {
  login: 1024, // a password and nothing else
  loginTotp: 1024, // a challenge id and a six-digit code
  mfa: 2048, // current password, TOTP code or recovery code
  ownerClaim: 512, // one invite code and nothing else
  operatorLogin: 1024,
  operatorCafe: 2048, // name, slug, password, service mode, table count
  operatorReset: 1024, // optional replacement password
  settings: 4096, // cafe name, contacts, address, timezone, optional password
  adminOrder: 1024, // status and payment status
  menuItem: 2048, // name, category, description, emoji, price
  adminItem: 2048, // { available } or full edit: name, category, description, emoji, priceCents
  table: 1024, // label and seats
  checkout: 16384, // up to 40 lines plus a note
  abandon: 1024, // an idempotency key and nothing else
  payment: 2048, // method and reference
  paymentVerify: 4096, // gateway signature and identifiers
  webhook: 65536, // gateway event envelopes are the largest legitimate bodies
};

// Thrown while a body is still arriving; handleApi turns it into one 413 that names no limit and no
// part of the payload.
export class BodyTooLargeError extends Error {
  constructor(limit) {
    super("request body exceeds limit");
    this.name = "BodyTooLargeError";
    this.limit = limit;
  }
}

// Reads the body as text, counting bytes as they stream in. Returns null when the body cannot be
// read at all (an interrupted stream, a client that vanished), which callers already treat as a bad
// request. A body that is exactly at the limit is accepted; one byte more is refused.
export async function readText(request, limit) {
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const claimed = Number(declared);
    if (Number.isFinite(claimed) && claimed > limit) throw new BodyTooLargeError(limit);
  }

  if (!request.body) return "";

  // A body can only be read once. A handler that asks twice, or a body already consumed upstream,
  // gets null here rather than a thrown stream error.
  let reader;
  try {
    reader = request.body.getReader();
  } catch {
    return null;
  }
  const chunks = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > limit) {
        try {
          await reader.cancel();
        } catch {
          // The stream is already gone; nothing left to release.
        }
        throw new BodyTooLargeError(limit);
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof BodyTooLargeError) throw error;
    try {
      await reader.cancel();
    } catch {
      // Already closed.
    }
    return null;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

export async function readJson(request, limit = BODY_LIMITS.settings) {
  const text = await readText(request, limit);
  if (text === null || text === "") return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
