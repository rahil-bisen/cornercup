// F-20 browser-observable credentials. Static contracts over the client bundle: no credential may be
// written to storage a script can read, no staff session may be readable by page JavaScript, and the
// guest tracking capability may only be taken from the URL fragment.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

function walk(directory) {
  const out = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

const files = walk("./src").filter((file) => /\.(js|jsx)$/.test(file));
const sources = new Map(files.map((file) => [file, fs.readFileSync(file, "utf-8")]));
const all = [...sources.values()].join("\n");

test("F-20: no credential is written to localStorage or sessionStorage", () => {
  const forbidden = /token|secret|password|pass_hash|passHash|bearer|authorization/i;
  for (const [file, source] of sources) {
    source.split("\n").forEach((line, index) => {
      if (!/(?:local|session)Storage\.setItem\(/.test(line)) return;
      assert.equal(
        forbidden.test(line),
        false,
        `${file}:${index + 1} stores credential-shaped data: ${line.trim()}`
      );
    });
  }
});

test("F-20: the legacy localStorage admin token is removed and never read", () => {
  const admin = sources.get(path.join("src", "pages", "Admin.jsx"));
  assert.ok(admin, "Admin.jsx exists");
  assert.match(admin, /localStorage\.removeItem\("admin_token"\)/, "upgrade cleanup present");
  assert.equal(/localStorage\.getItem\("admin_token"\)/.test(all), false, "never read back");
  assert.equal(/localStorage\.setItem\("admin_token"/.test(all), false, "never written");
  assert.equal(/sessionStorage\.setItem\("admin_token"/.test(all), false, "never written");
});

test("F-20: the staff session is an HttpOnly, SameSite=Strict cookie", () => {
  // The cookie is built in the session module (extracted from worker/api.js in phase 2B stage 0).
  const api = fs.readFileSync("./worker/session.js", "utf-8");
  const cookie = api.match(/function sessionCookie[\s\S]*?\n}/);
  assert.ok(cookie, "sessionCookie present");

  assert.match(cookie[0], /HttpOnly/, "page JavaScript cannot read the session");
  assert.match(cookie[0], /SameSite=Strict/, "another site cannot ride the cookie");
  assert.match(cookie[0], /Path=\//);
  assert.match(cookie[0], /protocol === "https:"/, "Secure is added over https");
  assert.equal(/document\.cookie/.test(all), false, "the client never touches cookies");
});

test("F-20: the guest tracking token is read from the URL fragment only", () => {
  const status = sources.get(path.join("src", "pages", "OrderStatus.jsx"));
  assert.ok(status, "OrderStatus.jsx exists");
  assert.match(status, /location\.hash/, "the capability travels in the fragment");
  assert.equal(
    /searchParams\.get\(["']t["']\)/.test(status),
    false,
    "never read from the query string, which would reach access logs"
  );

  // A fragment is not sent to the server by the browser, so it cannot appear in a request line.
  for (const [file, source] of sources) {
    assert.equal(
      /\?t=|\&t=/.test(source),
      false,
      `${file} must not put the tracking token in a query string`
    );
  }
});

test("F-20: the client has no HTML-injection or eval sinks", () => {
  assert.equal(/dangerouslySetInnerHTML/.test(all), false, "React escapes every value");
  assert.equal(/\beval\s*\(/.test(all), false, "no eval");
  assert.equal(/new Function\s*\(/.test(all), false, "no Function constructor");
  assert.equal(/document\.write/.test(all), false, "no document.write");
});
