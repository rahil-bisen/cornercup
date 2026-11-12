// Regression tests for the operator "Reset owner password" feature.
//
// They run against the auth-enabled harness (tests/harness/wrangler.auth.jsonc), which carries a known
// ADMIN_SECRET, ADMIN_PIN and OPERATOR_PASSWORD. Tokens are minted in the test with that same secret so
// a legacy two-part session can be presented exactly as an old browser would send it.

import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const HARNESS = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const ADMIN_SECRET = "test-admin-secret-for-harness-only";
const OPERATOR_PASSWORD = "operator-test-password";
const STAFF_LEGACY_PASSWORD = "1234";

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/read`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cafeId: -1, key: "probe" }),
  });
  alive = probe.status === 200;
} catch {
  alive = false;
}

const skip = alive ? false : `auth-enabled harness not available at ${HARNESS}`;

const jsonHeaders = { "content-type": "application/json" };

function prefix(extra = {}) {
  return { ...jsonHeaders, origin: HARNESS, ...extra };
}

// The Worker signs `expires.subject` with HMAC-SHA256(ADMIN_SECRET), base64url, unpadded.
function mintToken(subject, expires = Date.now() + 60 * 60 * 1000) {
  const payload = `${expires}.${subject}`;
  const signature = createHmac("sha256", ADMIN_SECRET)
    .update(payload)
    .digest("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `${payload}.${signature}`;
}

function staffCookie(cafe, token) {
  return { cookie: `staff_session_${cafe.slug}=${encodeURIComponent(token)}` };
}

async function seed(serviceMode = "counter") {
  const res = await fetch(`${HARNESS}/seed`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ serviceMode }),
  });
  assert.equal(res.ok, true, `/seed answered ${res.status}`);
  return res.json();
}

async function clean(cafeId) {
  await fetch(`${HARNESS}/clean`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ cafeId }),
  });
}

async function cleanSlug(slug) {
  await fetch(`${HARNESS}/clean`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ slug }),
  });
}

async function setVersion(cafeId, value) {
  const res = await fetch(`${HARNESS}/version`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ cafeId, value }),
  });
  assert.equal(res.ok, true, `/version answered ${res.status}`);
  return res.json();
}

async function audit(cafeId) {
  const res = await fetch(`${HARNESS}/audit`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ cafeId }),
  });
  assert.equal(res.ok, true, `/audit answered ${res.status}`);
  return res.json();
}

async function operatorSignIn() {
  const res = await fetch(`${HARNESS}/api/operator/login`, {
    method: "POST",
    headers: prefix(),
    body: JSON.stringify({ password: OPERATOR_PASSWORD }),
  });
  assert.equal(res.status, 200, `operator login answered ${res.status}`);
  const payload = await res.json();
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const raw = cookies[0] || res.headers.get("set-cookie") || "";
  const pair = raw.split(";")[0];
  assert.ok(pair.startsWith("staff_operator="), `unexpected operator cookie: ${pair}`);
  assert.ok(payload.csrfToken, "operator login must return a CSRF token");
  return { cookie: pair, csrfToken: payload.csrfToken, payload };
}

function resetRequest(cafeSlug, { cookie, csrf, origin = HARNESS, password } = {}) {
  const headers = prefix();
  if (origin !== null) headers.origin = origin;
  if (cookie) headers.cookie = cookie;
  if (csrf) headers["x-csrf-token"] = csrf;
  const body = password === undefined ? {} : { password };
  return fetch(`${HARNESS}/api/operator/cafes/${encodeURIComponent(cafeSlug)}/reset-password`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

async function staffSession(cafe, token) {
  return fetch(`${HARNESS}/api/cafes/${cafe.slug}/admin/session`, { headers: staffCookie(cafe, token) });
}

async function staffLogin(cafe, password) {
  return fetch(`${HARNESS}/api/cafes/${cafe.slug}/admin/login`, {
    method: "POST",
    headers: prefix(),
    body: JSON.stringify({ password }),
  });
}

test("reset owner password: end-to-end behaviour", { skip }, async (t) => {
  const cafeA = await seed("counter");
  const cafeB = await seed("counter");
  const sessionA = mintToken(`cafe:${cafeA.cafeId}`);
  const sessionB = mintToken(`cafe:${cafeB.cafeId}`);

  let operator = null;
  let newPassword = "";
  let rotatedCsrf = "";

  try {
    await t.test("legacy two-part tokens authenticate before any reset", async () => {
      const res = await staffSession(cafeA, sessionA);
      assert.equal(res.status, 200, "a version-less legacy token is accepted as version 1");

      const wrongVersion = await staffSession(cafeA, mintToken(`cafe:${cafeA.cafeId}:99`));
      assert.equal(wrongVersion.status, 401, "a token for another version is rejected");

      const otherCafe = await staffSession(cafeA, sessionB);
      assert.equal(otherCafe.status, 401, "another cafe's token is rejected");
    });

    await t.test("operator login returns a CSRF token", async () => {
      operator = await operatorSignIn();
      assert.equal(typeof operator.csrfToken, "string");
      assert.ok(operator.csrfToken.length >= 32, "the CSRF token must be a long random value");

      const session = await fetch(`${HARNESS}/api/operator/session`, {
        headers: prefix({ cookie: operator.cookie }),
      });
      assert.equal(session.status, 200);
      const payload = await session.json();
      assert.ok(payload.csrfToken, "the session endpoint also hands out a CSRF token");
    });

    await t.test("a reset without a CSRF token is refused", async () => {
      const res = await resetRequest(cafeA.slug, { cookie: operator.cookie });
      assert.equal(res.status, 403);
      const state = await audit(cafeA.cafeId);
      assert.equal(Number(state.cafe.auth_version), 1, "a refused reset must not bump the version");
      assert.equal(Number(state.cafe.has_password), 0, "a refused reset must not set a password");
      assert.ok(
        state.resets.some((row) => row.outcome === "csrf_rejected"),
        "a refused attempt is audited"
      );
    });

    await t.test("a reset from another origin is refused", async () => {
      const res = await resetRequest(cafeA.slug, {
        cookie: operator.cookie,
        csrf: operator.csrfToken,
        origin: "https://evil.example",
      });
      assert.equal(res.status, 403);
      const state = await audit(cafeA.cafeId);
      assert.equal(Number(state.cafe.auth_version), 1);
      assert.equal(Number(state.cafe.has_password), 0);
    });

    await t.test("an unknown cafe is refused and still recorded", async () => {
      const res = await resetRequest("no-such-cafe", { cookie: operator.cookie, csrf: operator.csrfToken });
      assert.equal(res.status, 404);
      const state = await audit(null);
      const rejected = state.resets.filter((row) => row.outcome === "unknown_cafe");
      assert.ok(rejected.length >= 1, "the unknown cafe is recorded");
      assert.equal(rejected[rejected.length - 1].cafe_id, null, "no cafe id is invented for it");
      assert.equal(rejected[rejected.length - 1].operator_identity, "operator");
      assert.ok(!("password" in rejected[rejected.length - 1]), "audit rows carry no credentials");
    });

    await t.test("a short password is refused without touching the cafe", async () => {
      const res = await resetRequest(cafeA.slug, {
        cookie: operator.cookie,
        csrf: operator.csrfToken,
        password: "shortpass",
      });
      assert.equal(res.status, 400);
      const state = await audit(cafeA.cafeId);
      assert.equal(Number(state.cafe.auth_version), 1, "no version bump on a rejected password");
      assert.equal(Number(state.cafe.password_changed_at), 0, "no change timestamp on a rejected password");
      assert.equal(Number(state.cafe.has_password), 0, "no password written on a rejected attempt");
      assert.ok(state.resets.every((row) => row.outcome !== "success"), "no success row was written");
      assert.ok(state.resets.some((row) => row.outcome === "short_password"));
    });

    await t.test("the operator can reset the password", async () => {
      const res = await resetRequest(cafeA.slug, { cookie: operator.cookie, csrf: operator.csrfToken });
      assert.equal(res.status, 200);
      const payload = await res.json();
      newPassword = payload.password;
      rotatedCsrf = payload.csrfToken;
      assert.equal(payload.slug, cafeA.slug);
      assert.equal(typeof newPassword, "string");
      assert.ok(newPassword.length >= 12, "the generated password meets the minimum length");
      assert.ok(rotatedCsrf && rotatedCsrf !== operator.csrfToken, "the response rotates the CSRF token");
      assert.equal(payload.authVersion, 2);

      const state = await audit(cafeA.cafeId);
      assert.equal(Number(state.cafe.auth_version), 2, "the version moved forward by one");
      assert.ok(Number(state.cafe.password_changed_at) > 0, "the change timestamp is a real instant");
      assert.equal(Number(state.cafe.has_password), 1);
      const success = state.resets.filter((row) => row.outcome === "success");
      assert.equal(success.length, 1, "exactly one success row is written");
      assert.equal(Number(success[0].cafe_id), cafeA.cafeId, "the success row keeps the cafe id");
      assert.equal(success[0].action, "reset_password");
      assert.ok(!("password" in success[0]), "the audit row never stores the password");
      assert.ok(!("pass_hash" in success[0]), "the audit row never stores the hash");
    });

    await t.test("every old session for the reset cafe fails immediately", async () => {
      const res = await staffSession(cafeA, sessionA);
      assert.equal(res.status, 401, "the pre-reset session is dead");
      const fresh = await staffSession(cafeA, mintToken(`cafe:${cafeA.cafeId}:1`));
      assert.equal(fresh.status, 401, "a token still on version 1 is dead");
    });

    await t.test("the new password signs in and the old one does not", async () => {
      const ok = await staffLogin(cafeA, newPassword);
      assert.equal(ok.status, 200, "the new password is accepted");
      const cookies = typeof ok.headers.getSetCookie === "function" ? ok.headers.getSetCookie() : [];
      const pair = (cookies[0] || ok.headers.get("set-cookie") || "").split(";")[0];
      assert.ok(pair.startsWith("staff_session_"), "a staff session is issued");

      const session = await fetch(`${HARNESS}/api/cafes/${cafeA.slug}/admin/session`, {
        headers: prefix({ cookie: pair }),
      });
      assert.equal(session.status, 200, "the newly issued session works");

      const old = await staffLogin(cafeA, STAFF_LEGACY_PASSWORD);
      assert.equal(old.status, 401, "the previous password no longer signs in");
    });

    await t.test("other cafes are unaffected", async () => {
      const res = await staffSession(cafeB, sessionB);
      assert.equal(res.status, 200, "cafe B's session still works");
      const state = await audit(cafeB.cafeId);
      assert.equal(Number(state.cafe.auth_version), 1, "cafe B keeps its version");
      assert.equal(state.resets.length, 0, "nothing was written for cafe B");
    });

    await t.test("the operator session survives the reset", async () => {
      const res = await fetch(`${HARNESS}/api/operator/session`, {
        headers: prefix({ cookie: operator.cookie }),
      });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.ok(payload.csrfToken, "a fresh CSRF token is issued");
    });

    await t.test("the rotated CSRF token authorises the next reset", async () => {
      const res = await resetRequest(cafeA.slug, { cookie: operator.cookie, csrf: rotatedCsrf });
      assert.equal(res.status, 200);
      const payload = await res.json();
      assert.equal(payload.authVersion, 3);
      assert.notEqual(payload.password, newPassword, "a second reset generates a different password");

      const state = await audit(cafeA.cafeId);
      assert.equal(Number(state.cafe.auth_version), 3);
      assert.equal(state.resets.filter((row) => row.outcome === "success").length, 2);

      const stale = await staffSession(cafeA, sessionA);
      assert.equal(stale.status, 401, "the first reset's session is still dead");
    });

    await t.test("a failed attempt leaves nothing half-written", async () => {
      const before = await audit(cafeA.cafeId);
      const res = await resetRequest(cafeA.slug, {
        cookie: operator.cookie,
        csrf: rotatedCsrf,
        password: "tooshort",
      });
      assert.equal(res.status, 400);
      const after = await audit(cafeA.cafeId);
      assert.equal(Number(after.cafe.auth_version), Number(before.cafe.auth_version));
      assert.equal(Number(after.cafe.password_changed_at), Number(before.cafe.password_changed_at));
      assert.equal(
        after.resets.filter((row) => row.outcome === "success").length,
        before.resets.filter((row) => row.outcome === "success").length,
        "no success row accompanies a rejected attempt"
      );
    });
    await t.test("an owner password change signs out that cafe's other sessions", async () => {
      const login = await staffLogin(cafeB, STAFF_LEGACY_PASSWORD);
      assert.equal(login.status, 200, "cafe B starts on its legacy password");
      const cookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [];
      const pair = (cookies[0] || login.headers.get("set-cookie") || "").split(";")[0];

      const changed = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/settings`, {
        method: "PATCH",
        headers: prefix({ cookie: pair }),
        body: JSON.stringify({ password: "a-brand-new-owner-pass" }),
      });
      assert.equal(changed.status, 200, "the owner may set their own password");

      const fresh = typeof changed.headers.getSetCookie === "function" ? changed.headers.getSetCookie() : [];
      const freshPair = (fresh[0] || changed.headers.get("set-cookie") || "").split(";")[0];
      assert.ok(freshPair.startsWith("staff_session_"), "the owner is handed a fresh session");

      const stale = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/session`, {
        headers: prefix({ cookie: pair }),
      });
      assert.equal(stale.status, 401, "the pre-change session is invalidated");

      const current = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/session`, {
        headers: prefix({ cookie: freshPair }),
      });
      assert.equal(current.status, 200, "the owner who made the change stays signed in");

      const relogin = await staffLogin(cafeB, "a-brand-new-owner-pass");
      assert.equal(relogin.status, 200, "the new password works on a fresh sign-in");
      const oldLogin = await staffLogin(cafeB, STAFF_LEGACY_PASSWORD);
      assert.equal(oldLogin.status, 401, "the old password no longer works");

      const state = await audit(cafeB.cafeId);
      assert.equal(Number(state.cafe.auth_version), 2, "the version moved so old tokens die");
      assert.ok(Number(state.cafe.password_changed_at) > 0, "the change is timestamped");
      assert.equal(state.resets.length, 0, "an owner change is not logged as an operator reset");

      const otherCafe = await staffSession(cafeA, sessionA);
      assert.equal(otherCafe.status, 401, "cafe A stays on its own (already invalidated) version");
    });

    await t.test("the owner board enforces the same 12-character minimum", async () => {
      const login = await staffLogin(cafeB, "a-brand-new-owner-pass");
      assert.equal(login.status, 200);
      const cookies = typeof login.headers.getSetCookie === "function" ? login.headers.getSetCookie() : [];
      const pair = (cookies[0] || login.headers.get("set-cookie") || "").split(";")[0];
      const before = await audit(cafeB.cafeId);

      for (const short of ["sixchr", "elevenchars"]) {
        const res = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/settings`, {
          method: "PATCH",
          headers: prefix({ cookie: pair }),
          body: JSON.stringify({ password: short }),
        });
        assert.equal(res.status, 400, `a ${short.length}-character password is refused`);
      }

      const after = await audit(cafeB.cafeId);
      assert.equal(
        Number(after.cafe.auth_version),
        Number(before.cafe.auth_version),
        "a refused password never bumps the version"
      );
      const session = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/session`, {
        headers: prefix({ cookie: pair }),
      });
      assert.equal(session.status, 200, "the session survives a refused change");

      const accepted = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/settings`, {
        method: "PATCH",
        headers: prefix({ cookie: pair }),
        body: JSON.stringify({ password: "twelvechars!" }),
      });
      assert.equal(accepted.status, 200, "exactly 12 characters is accepted");
      const state = await audit(cafeB.cafeId);
      assert.equal(Number(state.cafe.auth_version), Number(before.cafe.auth_version) + 1);
    });

    await t.test("an invalid stored version fails closed for tokens and sign-in", async () => {
      // café B's current password, set by the previous subtest.
      const CURRENT = "twelvechars!";
      const legacy = mintToken(`cafe:${cafeB.cafeId}`); // a version-1 token, valid before corruption

      const realVersion = Number((await audit(cafeB.cafeId)).cafe.auth_version);
      assert.ok(realVersion >= 2, "café B is already past version 1 when this test starts");

      // With a genuinely valid version of 1 the very same legacy token authenticates, which is what
      // makes the rejections below about the stored value and not about the token.
      await setVersion(cafeB.cafeId, 1);
      const validOne = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/session`, {
        headers: prefix({ cookie: staffCookie(cafeB, legacy).cookie }),
      });
      assert.equal(validOne.status, 200, "a stored version of 1 accepts a version-1 token");

      const op = await operatorSignIn();

      for (const value of [0, -1, 1.5, "abc"]) {
        await setVersion(cafeB.cafeId, value);

        const session = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/session`, {
          headers: prefix({ cookie: staffCookie(cafeB, legacy).cookie }),
        });
        assert.equal(
          session.status,
          401,
          `stored version ${JSON.stringify(value)} must not accept a version-1 token`
        );

        const login = await staffLogin(cafeB, CURRENT);
        assert.equal(
          login.status,
          503,
          `stored version ${JSON.stringify(value)} must refuse to issue a session`
        );

        const reset = await resetRequest(cafeB.slug, { cookie: op.cookie, csrf: op.csrfToken });
        assert.equal(
          reset.status,
          409,
          `stored version ${JSON.stringify(value)} must refuse a reset rather than coerce it`
        );
      }

      // Restoring the café's real version brings it back, with the token that matches it.
      await setVersion(cafeB.cafeId, realVersion);
      const restored = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/session`, {
        headers: prefix({ cookie: staffCookie(cafeB, mintToken(`cafe:${cafeB.cafeId}:${realVersion}`)).cookie }),
      });
      assert.equal(restored.status, 200, "a valid version authenticates again");
      const stillLegacy = await fetch(`${HARNESS}/api/cafes/${cafeB.slug}/admin/session`, {
        headers: prefix({ cookie: staffCookie(cafeB, legacy).cookie }),
      });
      assert.equal(stillLegacy.status, 401, "and the version-1 token is still refused");
    });

    await t.test("two operator logins never receive the same session token", async () => {
      const a = await operatorSignIn();
      const b = await operatorSignIn();
      assert.notEqual(a.cookie, b.cookie, "each sign-in carries its own nonce, even in the same millisecond");
      assert.notEqual(a.csrfToken, b.csrfToken, "and its own CSRF token");

      const crossed = await resetRequest(cafeB.slug, { cookie: b.cookie, csrf: a.csrfToken });
      assert.equal(crossed.status, 403, "one session's CSRF token cannot drive another session");
    });

    await t.test("creating a cafe enforces the same 12-character minimum", async () => {
      const op = await operatorSignIn();
      const create = (password, slug) =>
        fetch(`${HARNESS}/api/operator/cafes`, {
          method: "POST",
          headers: prefix({ cookie: op.cookie }),
          body: JSON.stringify({ name: "Policy Cafe", slug, password, serviceMode: "counter" }),
        });

      const short = await create("elevenchars", "policy-short");
      assert.equal(short.status, 400, "an 11-character owner password is refused");

      const accepted = await create("twelvechars!", "policy-ok");
      assert.equal(accepted.status, 201, "exactly 12 characters is accepted");
      await cleanSlug("policy-ok");

      const list = await fetch(`${HARNESS}/api/operator/cafes`, { headers: prefix({ cookie: op.cookie }) }).then(
        (res) => res.json()
      );
      assert.ok(
        !(list.cafes || []).some((cafe) => cafe.slug === "policy-short"),
        "the refused cafe was never created"
      );
    });

    await t.test("a CSRF token dies with the operator session it was issued for", async () => {
      const first = await operatorSignIn();
      await fetch(`${HARNESS}/api/operator/logout`, {
        method: "POST",
        headers: prefix({ cookie: first.cookie }),
      });

      // A later sign-in mints its own nonce, so the previous session's CSRF row cannot match it.
      const second = await operatorSignIn();
      const reused = await resetRequest(cafeB.slug, { cookie: second.cookie, csrf: first.csrfToken });
      assert.equal(reused.status, 403, "the previous session's CSRF token is refused");

      // Without the session cookie the operator gate answers first, so the token never even gets
      // looked at — a CSRF token alone is worth nothing.
      const withoutCookie = await resetRequest(cafeB.slug, { csrf: second.csrfToken });
      assert.equal(withoutCookie.status, 401, "a CSRF token without its session cookie is refused");

      const fresh = await resetRequest(cafeB.slug, { cookie: second.cookie, csrf: second.csrfToken });
      assert.equal(fresh.status, 200, "the current session's own token still works");
    });
  } finally {
    await clean(cafeA.cafeId);
    await clean(cafeB.cafeId);
  }
});
