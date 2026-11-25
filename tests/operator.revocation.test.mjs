import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };
const OPERATOR_PASSWORD = "operator-test-password";
const SESSION_MAX_AGE = 12 * 60 * 60;

async function reachable() {
  try {
    const res = await fetch(`${BASE}/read`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ cafeId: -1, key: "probe" }),
    });
    return res.status === 200;
  } catch {
    return false;
  }
}
const alive = await reachable();
const skip = alive ? false : `auth-enabled harness not available at ${BASE}`;

function cookiePair(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (all[0] || res.headers.get("set-cookie") || "").split(";")[0];
}

async function opLogin() {
  const res = await fetch(`${BASE}/api/operator/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(res.status, 200, `operator login answered ${res.status}`);
  const pair = cookiePair(res);
  assert.ok(pair, "operator login issued a session cookie");
  const body = await res.json();
  return { cookie: pair, csrfToken: body && body.csrfToken ? body.csrfToken : "" };
}

async function opSession(cookie) {
  const res = await fetch(`${BASE}/api/operator/session`, { headers: { cookie } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function opLogout(cookie) {
  return fetch(`${BASE}/api/operator/logout`, { method: "POST", headers: { cookie } });
}

async function opLogoutAll(cookie, csrfToken, { origin = BASE } = {}) {
  const headers = { ...JSON_HEADERS, cookie };
  if (origin) headers.origin = origin;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  return fetch(`${BASE}/api/operator/logout-all`, { method: "POST", headers, body: "{}" });
}

/* --------------------------------------------------------------- ordinary logout */

test("operator ordinary logout clears the cookie and revokes the session", { skip }, async () => {
  const { cookie } = await opLogin();
  assert.equal((await opSession(cookie)).status, 200, "signed in before logout");

  const res = await opLogout(cookie);
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get("set-cookie") || ""), /Max-Age=0/, "browser copy expired");

  assert.equal((await opSession(cookie)).status, 401, "copied cookie rejected after logout");
});

test("operator ordinary logout leaves a copied cookie rejected", { skip }, async () => {
  const { cookie } = await opLogin();
  const copy = cookie;
  await opLogout(cookie);
  assert.equal((await opSession(copy)).status, 401, "copied cookie cannot replay");
});

/* --------------------------------------------------------------- logout-all */

test("operator logout-all invalidates sessions on multiple devices", { skip }, async () => {
  const first = await opLogin();
  const second = await opLogin();

  const csrfToken = (await opSession(first.cookie)).body.csrfToken;
  assert.ok(csrfToken, "session hands out a CSRF token");

  const res = await opLogoutAll(first.cookie, csrfToken);
  assert.equal(res.status, 200, "logout-all succeeded");

  assert.equal((await opSession(second.cookie)).status, 401, "other device signed out");
  assert.equal((await opSession(first.cookie)).status, 401, "asking token also revoked");
});

test("operator logout-all caller receives a fresh working session", { skip }, async () => {
  const { cookie, csrfToken } = await opLogin();
  const res = await opLogoutAll(cookie, csrfToken);
  assert.equal(res.status, 200);

  const replacement = cookiePair(res);
  assert.ok(replacement, "response carries a replacement cookie");
  assert.notEqual(replacement, cookie, "and it is a different token");

  assert.equal((await opSession(replacement)).status, 200, "the console keeps working");
});

test("operator logout-all needs a valid session", { skip }, async () => {
  const { cookie, csrfToken } = await opLogin();
  const before = (await opSession(cookie)).status;
  assert.equal(before, 200);

  const res = await opLogoutAll("", csrfToken);
  assert.equal(res.status, 401, "no session, no revocation");
  assert.equal((await opSession(cookie)).status, 200, "real session untouched");
});

test("operator logout-all needs Origin and a live CSRF token", { skip }, async () => {
  const { cookie, csrfToken } = await opLogin();

  assert.equal((await opLogoutAll(cookie, "")).status, 403, "no CSRF token refused");
  assert.equal(
    (await opLogoutAll(cookie, csrfToken, { origin: "https://evil.example" })).status,
    403,
    "another origin refused"
  );
  assert.equal(
    (await opLogoutAll(cookie, csrfToken, { origin: null })).status,
    403,
    "no Origin refused"
  );

  assert.equal((await opSession(cookie)).status, 200, "session survives refusals");
});

test("two consecutive operator logout-all actions work without reload", { skip }, async () => {
  const { cookie, csrfToken: t1 } = await opLogin();
  const res1 = await opLogoutAll(cookie, t1);
  assert.equal(res1.status, 200);
  const replacement = cookiePair(res1);

  const session2 = await opSession(replacement);
  assert.equal(session2.status, 200);
  const t2 = session2.body && session2.body.csrfToken;
  assert.ok(t2, "fresh CSRF token after first logout-all");

  const res2 = await opLogoutAll(replacement, t2);
  assert.equal(res2.status, 200, "second logout-all succeeds");
  assert.equal((await opSession(cookiePair(res2))).status, 200, "replacement still works");
});

/* --------------------------------------------------------------- fresh login */

test("fresh operator login works after revocation", { skip }, async () => {
  const { cookie, csrfToken } = await opLogin();
  await opLogoutAll(cookie, csrfToken);

  const fresh = await opLogin();
  assert.equal((await opSession(fresh.cookie)).status, 200, "fresh login restores access");
});

/* --------------------------------------------------------------- expiry/malformed */

test("operator malformed cookie is rejected", { skip }, async () => {
  const res = await fetch(`${BASE}/api/operator/session`, {
    headers: { cookie: "staff_operator=%" },
  });
  assert.equal(res.status, 401);
});

test("operator session status reports correct expiresIn", { skip }, async () => {
  const { cookie } = await opLogin();
  const s = await opSession(cookie);
  assert.equal(s.status, 200);
  const exp = Number(s.body.expiresIn);
  assert.ok(exp > SESSION_MAX_AGE - 60, `fresh session reports nearly full life (got ${exp})`);
  assert.ok(exp <= SESSION_MAX_AGE, `never more than max (got ${exp})`);
  assert.ok(s.body.csrfToken, "CSRF token present");

  await opLogout(cookie);
});

/* --------------------------------------------------------------- owner unaffected */

test("operator revocation does not touch owner sessions", { skip }, async () => {
  const seedRes = await fetch(`${BASE}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ serviceMode: "counter" }),
  });
  assert.equal(seedRes.status, 200);
  const { cafeId } = await seedRes.json();
  try {
    const before = await fetch(`${BASE}/version`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ cafeId }),
    }).then((r) => r.json()).then((b) => Number(b.authVersion));

    // Operator logout-all should not change the cafe's auth_version.
    const { cookie, csrfToken } = await opLogin();
    const res = await opLogoutAll(cookie, csrfToken);
    assert.equal(res.status, 200);

    const after = await fetch(`${BASE}/version`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ cafeId }),
    }).then((r) => r.json()).then((b) => Number(b.authVersion));
    assert.equal(after, before, "owner auth_version unchanged by operator revocation");
  } finally {
    await fetch(`${BASE}/clean`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ cafeId }),
    });
  }
});

/* --------------------------------------------------------------- fault injection */

test("ordinary operator logout reports failure and keeps session on D1 delete error", { skip }, async () => {
  const { cookie } = await opLogin();
  const res = await fetch(`${BASE}/api/operator/logout`, {
    method: "POST",
    headers: { cookie, "x-harness-fail-operator-delete": "1" },
  });
  assert.equal(res.status, 500, "delete failure is not reported as success");
  assert.equal((await opSession(cookie)).status, 200, "session survives the failed delete");
});

test("operator login does not issue a cookie when session insert fails", { skip }, async () => {
  const res = await fetch(`${BASE}/api/operator/login`, {
    method: "POST",
    headers: { ...JSON_HEADERS, "x-harness-fail-operator-insert": "1" },
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(res.status, 503, "insert failure surfaces as 503");
  const cookie = cookiePair(res);
  assert.ok(!cookie || cookie === "", "no session cookie issued on insert failure");
});

test("operator logout-all reports failure on batch error and changes nothing", { skip }, async () => {
  const a = await opLogin();
  const b = await opLogin();
  const csrfToken = (await opSession(a.cookie)).body.csrfToken;

  const res = await fetch(`${BASE}/api/operator/logout-all`, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      cookie: a.cookie,
      "x-csrf-token": csrfToken,
      origin: BASE,
      "x-harness-fail-operator-batch": "1",
    },
    body: "{}",
  });
  assert.equal(res.status, 500, "batch failure is not reported as success");
  assert.equal((await opSession(a.cookie)).status, 200, "caller session survives");
  assert.equal((await opSession(b.cookie)).status, 200, "other sessions survive (no partial delete)");
});

test("operator logout-all batch failure leaves replacement uncreated", { skip }, async () => {
  const { cookie, csrfToken } = await opLogin();
  const before = await fetch(`${BASE}/api/operator/session`, { headers: { cookie } }).then((r) => r.status);
  assert.equal(before, 200);

  const res = await fetch(`${BASE}/api/operator/logout-all`, {
    method: "POST",
    headers: {
      ...JSON_HEADERS,
      cookie,
      "x-csrf-token": csrfToken,
      origin: BASE,
      "x-harness-fail-operator-batch": "1",
    },
    body: "{}",
  });
  assert.equal(res.status, 500);
  // No replacement cookie should be issued.
  const setCookie = String(res.headers.get("set-cookie") || "");
  assert.ok(!/Max-Age=(?!0)/i.test(setCookie) || setCookie === "", "no replacement cookie on failure");
  assert.equal((await opSession(cookie)).status, 200, "original session still valid");
});

/* --------------------------------------------------------------- legacy / expired */

test("legacy bare operator token is rejected", { skip }, async () => {
  const mint = await fetch(`${BASE}/operator/legacy-token`, { method: "POST" });
  assert.equal(mint.status, 200);
  const { token } = await mint.json();
  assert.ok(token, "legacy token minted");
  const cookie = `staff_operator=${encodeURIComponent(token)}`;
  assert.equal((await opSession(cookie)).status, 401, "legacy bare operator token rejected");
});

test("expired operator session is rejected", { skip }, async () => {
  const { cookie } = await opLogin();
  assert.equal((await opSession(cookie)).status, 200);
  await fetch(`${BASE}/operator/expire-sessions`, { method: "POST" });
  assert.equal((await opSession(cookie)).status, 401, "expired session rejected");
});

/* --------------------------------------------------------------- concurrency */

test("concurrent overlapping logout-all: final state consistent, no false success", { skip }, async () => {
  const a = await opLogin();
  const b = await opLogin();
  const csrfA = (await opSession(a.cookie)).body.csrfToken;
  const csrfB = (await opSession(b.cookie)).body.csrfToken;

  // Fire both; one may invalidate the other's session row.
  const [resA, resB] = await Promise.all([
    opLogoutAll(a.cookie, csrfA),
    opLogoutAll(b.cookie, csrfB),
  ]);

  // Both must be either 200 or 401/500 — never a false success on failure.
  for (const r of [resA, resB]) {
    assert.ok(r.status === 200 || r.status === 401 || r.status === 403 || r.status === 500, `unexpected status ${r.status}`);
  }

  // A successful logout-all bumps the shared operator auth version, so when both callers succeed the
  // later bump legitimately supersedes the earlier caller's replacement cookie. What must hold is
  // that a success leaves its caller a usable session and that a superseded replacement is refused
  // — not that both replacements survive, which concurrency makes impossible by design.
  const cookies = [];
  if (resA.status === 200) cookies.push(cookiePair(resA));
  if (resB.status === 200) cookies.push(cookiePair(resB));

  let valid = 0;
  for (const c of cookies) {
    if (c && (await opSession(c)).status === 200) valid += 1;
  }

  if (cookies.length) {
    assert.ok(valid >= 1, "a successful logout-all leaves its caller a usable session");
    assert.ok(valid <= 1, "a later logout-all supersedes an earlier caller's replacement");
    // Whichever order the two succeeded in, neither original cookie survives the sweep.
    assert.equal((await opSession(a.cookie)).status, 401, "the first original cookie is revoked");
    assert.equal((await opSession(b.cookie)).status, 401, "the second original cookie is revoked");
  }
});

test("sequential logout-all after first success revokes the earlier caller's old token", { skip }, async () => {
  const a = await opLogin();
  const b = await opLogin();
  const csrfA = (await opSession(a.cookie)).body.csrfToken;

  const resA = await opLogoutAll(a.cookie, csrfA);
  assert.equal(resA.status, 200);

  // b's session was revoked by a's logout-all.
  assert.equal((await opSession(b.cookie)).status, 401, "b signed out by a's logout-all");

  // b's stale logout-all attempt is refused.
  const csrfB = (await opSession(b.cookie)).body; // likely null body on 401
  const resB = await fetch(`${BASE}/api/operator/logout-all`, {
    method: "POST",
    headers: { ...JSON_HEADERS, cookie: b.cookie, "x-csrf-token": csrfB && csrfB.csrfToken ? csrfB.csrfToken : "x", origin: BASE },
    body: "{}",
  });
  assert.ok(resB.status === 401 || resB.status === 403, `stale caller refused (${resB.status})`);
});

/* --------------------------------------------------------------- owner unaffected */

test("operator logout-all does not invalidate owner sessions", { skip }, async () => {
  // Re-assert via auth_version, as in the existing owner test, after the atomic change.
  const seedRes = await fetch(`${BASE}/seed`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ serviceMode: "counter" }) });
  assert.equal(seedRes.status, 200);
  const { cafeId } = await seedRes.json();
  try {
    const before = await fetch(`${BASE}/version`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cafeId }) }).then((r) => r.json()).then((b) => Number(b.authVersion));
    const { cookie, csrfToken } = await opLogin();
    const res = await opLogoutAll(cookie, csrfToken);
    assert.equal(res.status, 200);
    const after = await fetch(`${BASE}/version`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cafeId }) }).then((r) => r.json()).then((b) => Number(b.authVersion));
    assert.equal(after, before);
  } finally {
    await fetch(`${BASE}/clean`, { method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ cafeId }) });
  }
});
