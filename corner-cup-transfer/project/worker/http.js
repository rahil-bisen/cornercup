// Security headers applied to every response: JSON (via json()) and static assets
// (via withSecurityHeaders around env.ASSETS.fetch in worker/index.js).
//
// CSP notes:
// - 'self' is the only script/style/font/img/connect origin by default.
// - Google Fonts: style-src allows https://fonts.googleapis.com (the stylesheet) and
//   font-src allows https://fonts.gstatic.com (the font files).
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
  "style-src 'self' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com data:",
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

export async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return null;
  }
}
