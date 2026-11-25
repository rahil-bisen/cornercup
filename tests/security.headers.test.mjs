// F-04 security headers. The unit half imports worker/http.js directly (no wasm, no database); the
// harness half proves the headers survive the real Worker response path.

import test from "node:test";
import assert from "node:assert/strict";
import { json, withSecurityHeaders } from "../worker/http.js";

const HARNESS = process.env.HARNESS_URL || "http://127.0.0.1:8789";

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `harness not available at ${HARNESS}`;

const REQUIRED = {
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function assertSecurityHeaders(headers, where) {
  for (const [name, value] of Object.entries(REQUIRED)) {
    assert.equal(headers.get(name), value, `${name} on ${where}`);
  }

  assert.equal(
    headers.get("strict-transport-security"),
    "max-age=31536000; includeSubDomains",
    `HSTS on ${where}`
  );

  const permissions = headers.get("permissions-policy") || "";
  for (const feature of ["geolocation=()", "camera=()", "microphone=()", "usb=()"]) {
    assert.ok(permissions.includes(feature), `${feature} on ${where}`);
  }

  const csp = headers.get("content-security-policy") || "";
  assert.ok(csp.length > 0, `CSP on ${where}`);
  assert.ok(csp.includes("default-src 'self'"), "no default third-party origin");
  assert.ok(csp.includes("frame-ancestors 'none'"), "framing refused by CSP as well as XFO");
  assert.ok(csp.includes("object-src 'none'"), "plugins refused");
  assert.ok(csp.includes("base-uri 'self'"), "base tag cannot be retargeted");
  assert.ok(csp.includes("form-action 'self'"), "forms cannot post off-origin");
  assert.equal(csp.includes("unsafe-inline"), false, "no inline script/style allowance");
  assert.equal(csp.includes("unsafe-eval"), false, "no eval allowance");
  assert.equal(csp.includes("*"), false, "no wildcard origin");
  assert.equal(/(^|[;\s])http:/.test(csp), false, "no plaintext scheme in CSP");
}

test("F-04: API JSON carries the full header set and is never cached", () => {
  const response = json({ ok: true });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store", "personalised data is not cacheable");
  assertSecurityHeaders(response.headers, "API JSON");
  assert.equal(response.headers.get("access-control-allow-origin"), null, "no CORS opening");
});

test("F-04: wrapped static responses gain the headers and keep their own", async () => {
  const original = new Response("body{}", {
    status: 206,
    headers: { "content-type": "text/css", "cache-control": "public, max-age=3600" },
  });
  const wrapped = withSecurityHeaders(original);

  assert.equal(wrapped.status, 206, "status preserved");
  assert.equal(wrapped.headers.get("content-type"), "text/css", "content type preserved");
  assert.equal(wrapped.headers.get("cache-control"), "public, max-age=3600", "static caching preserved");
  assertSecurityHeaders(wrapped.headers, "static asset");
  assert.equal(await wrapped.text(), "body{}", "body preserved");
});

test("F-04: a response that already sets a security header cannot weaken it", () => {
  const wrapped = withSecurityHeaders(
    new Response("x", { headers: { "x-frame-options": "SAMEORIGIN", "content-security-policy": "" } })
  );
  assert.equal(wrapped.headers.get("x-frame-options"), "DENY");
  assert.ok(wrapped.headers.get("content-security-policy").includes("frame-ancestors 'none'"));
});

test("F-04: the live Worker sends the headers on /api/health", { skip }, async () => {
  const response = await fetch(`${HARNESS}/api/health`);
  assertSecurityHeaders(response.headers, "/api/health");
  assert.equal(response.headers.get("cache-control"), "no-store");
});
