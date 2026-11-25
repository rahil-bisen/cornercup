import test from "node:test";
import assert from "node:assert/strict";

import { readCookie } from "../worker/api.js";

function req(cookieHeader) {
  return {
    headers: {
      get(name) {
        return name.toLowerCase() === "cookie" ? cookieHeader : null;
      },
    },
  };
}

const NAME = "staff_session_corner-cup-cafe";

test("F-12: malformed percent-encodings return empty instead of throwing", () => {
  for (const raw of ["%", "%ZZ", "%A", "%C0%AF", "%FE%FF", "%G1", "abc%"]) {
    assert.equal(readCookie(req(`${NAME}=${raw}`), NAME), "", raw);
  }
});

test("F-12: valid percent-encoded values decode normally", () => {
  assert.equal(readCookie(req(`${NAME}=abc%20def`), NAME), "abc def");
  assert.equal(readCookie(req(`${NAME}=%2F`), NAME), "/");
  assert.equal(readCookie(req(`${NAME}=plain.token.value`), NAME), "plain.token.value");
});

test("F-12: empty values and missing equals signs are handled", () => {
  assert.equal(readCookie(req(`${NAME}=`), NAME), "");
  assert.equal(readCookie(req(`${NAME}`), NAME), "");
  assert.equal(readCookie(req(`other=foo`), NAME), "");
  assert.equal(readCookie(req(""), NAME), "");
});

test("F-12: a malformed first entry is skipped for a valid duplicate", () => {
  const header = `${NAME}=%ZZ; ${NAME}=valid.token.signature`;
  assert.equal(readCookie(req(header), NAME), "valid.token.signature");
});

test("F-12: duplicate valid cookies keep first-value behavior", () => {
  const header = `${NAME}=first.value; ${NAME}=second.value`;
  assert.equal(readCookie(req(header), NAME), "first.value");
});

test("F-12: a malformed entry alone never authenticates", () => {
  // readCookie must not throw; the decoded result is "" which can never be a valid token.
  let thrown = null;
  try {
    readCookie(req(`${NAME}=%`), NAME);
  } catch (e) {
    thrown = e;
  }
  assert.equal(thrown, null);
  assert.equal(readCookie(req(`${NAME}=%`), NAME), "");
});

// --- integration coverage (requires the auth-enabled harness) ---

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const BASE = `${AUTH}/api/cafes/corner-cup-cafe/admin/session`;
const OP_BASE = `${AUTH}/api/operator/session`;

let alive = false;
try {
  const probe = await fetch(`${AUTH}/api/cafe`);
  alive = probe.ok;
} catch {
  alive = false;
}
const skip = alive ? false : `auth-enabled harness not available at ${AUTH}`;

const malformed = ["%", "%ZZ", "%A", "%C0%AF", "%FE%FF"];

for (const raw of malformed) {
  test(`F-12: malformed owner cookie '${raw}' returns 401 not 500`, { skip }, async () => {
    const res = await fetch(BASE, { headers: { cookie: `staff_session_corner-cup-cafe=${raw}` } });
    assert.equal(res.status, 401, `expected 401, got ${res.status}`);
    const body = await res.json();
    assert.deepEqual(body, { error: "Not signed in." });
  });
}

for (const raw of malformed) {
  test(`F-12: malformed operator cookie '${raw}' returns 401 not 500`, { skip }, async () => {
    const res = await fetch(OP_BASE, { headers: { cookie: `staff_operator=${raw}` } });
    assert.equal(res.status, 401, `expected 401, got ${res.status}`);
    const body = await res.json();
    assert.deepEqual(body, { error: "Not signed in." });
  });
}

test("F-12: no malformed cookie can authenticate", { skip }, async () => {
  for (const raw of malformed) {
    const res = await fetch(BASE, { headers: { cookie: `staff_session_corner-cup-cafe=${raw}` } });
    assert.notEqual(res.status, 200, `malformed '${raw}' must not authenticate`);
    assert.equal(res.status, 401);
  }
});
