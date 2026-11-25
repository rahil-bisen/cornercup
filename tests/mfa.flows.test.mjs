// Owner two-factor sign-in, session inventory, membership revocation and the CSRF matrix, exercised
// over HTTP against the disposable auth harness (port 8790).
//
// Every assertion here is about something a stolen password or a stolen cookie must not be able to do:
// skip the second factor, replay a code, reuse a recovery code, keep a session after the factor
// changed, keep a session after membership was withdrawn, or mutate a café without a CSRF proof.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";
import { base32Decode, hotp, stepFor, totp } from "../worker/totp.js";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };
const OWNER_PASSWORD = HARNESS_OWNER_PASSWORD;

let alive = false;
try {
  const probe = await fetch(`${AUTH}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not available at ${AUTH}`;

async function seed(extra = {}) {
  const res = await fetch(`${AUTH}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ serviceMode: "tables", ...extra }),
  });
  assert.equal(res.status, 200, `/seed answered ${res.status}`);
  const cafe = await res.json();
  await clearLimits(cafe.cafeId);
  return cafe;
}

async function clean(cafeId) {
  await fetch(`${AUTH}/clean`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId }),
  });
}

// The rate-limit key embeds a hash of the client IP that wrangler derives itself, so ask the harness
// which keys exist rather than duplicating the rule.
async function clearLimits(cafeId) {
  for (const prefix of [`login:${cafeId}:`, `totp:${cafeId}:`, `settings:${cafeId}:`]) {
    const listed = await fetch(`${AUTH}/rate-limit/keys`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ prefix }),
    });
    if (listed.status !== 200) continue;
    for (const key of (await listed.json()).keys || []) {
      await fetch(`${AUTH}/rate-row`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ key, clear: true }),
      });
    }
  }
}

function cookiesOf(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (list[0] || res.headers.get("set-cookie") || "").split(";")[0];
}

async function login(slug, password = OWNER_PASSWORD) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, cookie: cookiesOf(res), setCookie: res.headers.get("set-cookie") };
}

async function csrfFor(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  const payload = await res.json().catch(() => ({}));
  return (payload && payload.csrfToken) || "";
}

function headersFor(cookie, token, extra = {}) {
  return { ...JSON_HEADERS, cookie, origin: AUTH, ...(token ? { "x-csrf-token": token } : {}), ...extra };
}

async function postJson(slug, path, cookie, token, body) {
  return fetch(`${AUTH}/api/cafes/${slug}/admin/${path}`, {
    method: "POST",
    headers: headersFor(cookie, token),
    body: JSON.stringify(body || {}),
  });
}

async function codeAt(secretB32, offsetMs = 0) {
  const secret = base32Decode(secretB32);
  assert.ok(secret, "the enrollment secret is valid base32");
  return (await totp(secret, { now: Date.now() + offsetMs })).code;
}

async function sessionStatus(slug, cookie) {
  return fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
}

/* ------------------------------------------------- enrollment needs the password and a CSRF proof */

test("enrollment refuses a session without CSRF, and a wrong password", { skip }, async () => {
  const cafe = await seed();
  try {
    const first = await login(cafe.slug);
    assert.equal(first.status, 200, "the café starts on its seeded password");
    const token = await csrfFor(cafe.slug, first.cookie);
    assert.ok(token, "the board is handed a CSRF token");

    const noCsrf = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/mfa/enroll`, {
      method: "POST",
      headers: headersFor(first.cookie, null),
      body: JSON.stringify({ currentPassword: OWNER_PASSWORD }),
    });
    assert.equal(noCsrf.status, 403, "a credential change is not a navigation");

    const wrongPassword = await postJson(cafe.slug, "mfa/enroll", first.cookie, token, {
      currentPassword: "not-the-owner-password",
    });
    assert.ok(wrongPassword.status === 401 || wrongPassword.status === 403, `answered ${wrongPassword.status}`);

    const status = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/mfa`, { headers: { cookie: first.cookie } });
    assert.equal(status.status, 200);
    const state = await status.json();
    assert.equal(state.enabled, false, "a refused enrollment leaves no active factor");
    assert.equal(state.pending, false, "and no half-enrolled secret either");
  } finally {
    await clean(cafe.cafeId);
  }
});

/* -------------------------------------- a deployment with no independent MFA key fails closed */

// The harness always has ADMIN_SECRET set. These requests therefore prove the security property that
// matters: no MFA_ENC_KEY means two-factor is unavailable, not silently derived from ADMIN_SECRET.
test("without a valid MFA_ENC_KEY, status is unavailable and enrollment is refused", { skip }, async () => {
  const cafe = await seed();
  try {
    const first = await login(cafe.slug);
    assert.equal(first.status, 200, "password sign-in is unaffected");
    const token = await csrfFor(cafe.slug, first.cookie);

    for (const mode of ["missing", "malformed"]) {
      const status = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/mfa`, {
        headers: { cookie: first.cookie, "x-harness-mfa-key": mode },
      });
      assert.equal(status.status, 200);
      assert.equal((await status.json()).available, false, `${mode} key reports unavailable`);

      const enroll = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/mfa/enroll`, {
        method: "POST",
        headers: headersFor(first.cookie, token, { "x-harness-mfa-key": mode }),
        body: JSON.stringify({ currentPassword: OWNER_PASSWORD }),
      });
      assert.equal(enroll.status, 503, `${mode} key refuses enrollment`);
    }
  } finally {
    await clean(cafe.cafeId);
  }
});

test("an enrolled café fails closed when the key is removed, and works again with it", { skip }, async () => {
  const cafe = await seed();
  try {
    const first = await login(cafe.slug);
    const token = await csrfFor(cafe.slug, first.cookie);
    const enrolled = await postJson(cafe.slug, "mfa/enroll", first.cookie, token, {
      currentPassword: OWNER_PASSWORD,
    });
    const enrollment = await enrolled.json();
    const confirmed = await postJson(cafe.slug, "mfa/confirm", first.cookie, token, {
      code: await codeAt(enrollment.secret),
    });
    assert.equal(confirmed.status, 200);

    await clearLimits(cafe.cafeId);
    const gated = await login(cafe.slug);
    assert.equal(gated.body.mfaRequired, true);
    // Confirmation spent the current step, so sign-in must use the next one; it is inside the ±1 window.
    const currentCode = await codeAt(enrollment.secret, 30_000);

    // The secret exists and the code is correct, but the deployment has no key: this must be a 503
    // (cannot decrypt), never a 401 "wrong code" and never a session.
    const locked = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-harness-mfa-key": "missing" },
      body: JSON.stringify({ challenge: gated.body.challenge, code: currentCode }),
    });
    assert.equal(locked.status, 503, "fail closed when the key is missing");
    assert.equal(cookiesOf(locked), "", "and issue no session");

    // Restore the key (same challenge is still unused) and the factor works again: the row was not
    // invalidated by the failed attempt.
    const recovered = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ challenge: gated.body.challenge, code: currentCode }),
    });
    assert.equal(recovered.status, 200, "the enrollment survives the missing-key window");
    assert.ok(cookiesOf(recovered).startsWith("staff_session_"));
  } finally {
    await clean(cafe.cafeId);
  }
});

/* ------------------------------------------------------ the full lifecycle over HTTP */

test("two-factor enrollment, sign-in, replay, recovery codes and removal", { skip }, async () => {
  const cafe = await seed();
  try {
    const first = await login(cafe.slug);
    assert.equal(first.status, 200);
    const token = await csrfFor(cafe.slug, first.cookie);

    const enrolled = await postJson(cafe.slug, "mfa/enroll", first.cookie, token, {
      currentPassword: OWNER_PASSWORD,
    });
    assert.equal(enrolled.status, 200, "enrollment starts");
    const enrollment = await enrolled.json();
    assert.match(enrollment.secret, /^[A-Z2-7]+$/, "the secret is base32");
    assert.equal(base32Decode(enrollment.secret).length, 20);
    assert.ok(enrollment.otpauth.startsWith("otpauth://totp/"));
    assert.ok(!JSON.stringify(enrollment).includes(OWNER_PASSWORD), "no password is echoed back");

    const confirmed = await postJson(cafe.slug, "mfa/confirm", first.cookie, token, {
      code: await codeAt(enrollment.secret),
    });
    assert.equal(confirmed.status, 200, "a generated code confirms the factor");
    const confirmation = await confirmed.json();
    assert.equal(confirmation.enabled, true);
    assert.equal(confirmation.signInRequired, true);
    assert.equal(confirmation.recoveryCodes.length, 10, "ten single-use recovery codes");
    assert.equal(cookiesOf(confirmed).split("=")[1], "", "the enrolment session cookie is cleared");

    assert.equal(
      (await sessionStatus(cafe.slug, first.cookie)).status,
      401,
      "the session that existed before the factor is dead"
    );

    await clearLimits(cafe.cafeId);
    const gated = await login(cafe.slug);
    assert.equal(gated.status, 200, "the password is still accepted");
    assert.equal(gated.body.mfaRequired, true);
    assert.equal(gated.cookie, "", "but it earns no session");
    assert.ok(gated.body.challenge, "only a single-use challenge");

    // A code ten steps ahead can never fall inside the ±1 window, so this is deterministically wrong.
    const farCode = await hotp(base32Decode(enrollment.secret), stepFor(Date.now()) + 10);
    const wrong = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ challenge: gated.body.challenge, code: farCode }),
    });
    assert.equal(wrong.status, 401, "a wrong code is refused");

    await clearLimits(cafe.cafeId);
    const second = await login(cafe.slug);
    assert.equal(second.body.mfaRequired, true);

    const code = await codeAt(enrollment.secret, 30_000);
    const accepted = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ challenge: second.body.challenge, code }),
    });
    assert.equal(accepted.status, 200, "the second step completes the sign-in");
    const cookie = cookiesOf(accepted);
    assert.ok(cookie.startsWith("staff_session_"));
    assert.equal((await sessionStatus(cafe.slug, cookie)).status, 200);

    // The challenge that just succeeded is spent: presenting another valid code with it is refused.
    const spentChallenge = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ challenge: second.body.challenge, code: await codeAt(enrollment.secret, 60_000) }),
    });
    assert.equal(spentChallenge.status, 401, "a completed challenge cannot be replayed");

    // Replay: the same code, presented with a fresh challenge, is spent.
    await clearLimits(cafe.cafeId);
    const third = await login(cafe.slug);
    const replay = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ challenge: third.body.challenge, code }),
    });
    assert.equal(replay.status, 401, "a used code cannot authenticate twice");
    assert.equal(cookiesOf(replay), "");

    // Recovery codes: accepted once, then spent.
    await clearLimits(cafe.cafeId);
    const fourth = await login(cafe.slug);
    const recovery = confirmation.recoveryCodes[0];
    const withRecovery = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ challenge: fourth.body.challenge, code: recovery }),
    });
    assert.equal(withRecovery.status, 200, "a recovery code stands in for the authenticator");
    const recoveryCookie = cookiesOf(withRecovery);
    assert.equal((await sessionStatus(cafe.slug, recoveryCookie)).status, 200);

    await clearLimits(cafe.cafeId);
    const fifth = await login(cafe.slug);
    const reused = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ challenge: fifth.body.challenge, code: recovery }),
    });
    assert.equal(reused.status, 401, "a recovery code works exactly once");

    /* ---------------------------------------------------------------- session inventory */

    const list = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/sessions`, { headers: { cookie: recoveryCookie } });
    assert.equal(list.status, 200);
    const inventory = await list.json();
    assert.ok(inventory.sessions.length >= 2, "both live sessions are listed");
    assert.ok(
      inventory.sessions.every((entry) => /^[0-9a-f]{8}$/.test(entry.id)),
      "the inventory names a session by an eight-character prefix, never by a token"
    );
    assert.equal(inventory.sessions.filter((entry) => entry.current).length, 1, "exactly one is this device");

    const other = inventory.sessions.find((entry) => !entry.current);
    assert.ok(other, "the earlier device is listed");

    const noCsrf = await postJson(cafe.slug, `sessions/${other.id}/revoke`, recoveryCookie, null, {});
    assert.equal(noCsrf.status, 403, "revoking a device needs a CSRF proof");

    const revokeToken = await csrfFor(cafe.slug, recoveryCookie);
    const revoked = await postJson(cafe.slug, `sessions/${other.id}/revoke`, recoveryCookie, revokeToken, {});
    assert.equal(revoked.status, 200, `revoke answered ${revoked.status}`);
    assert.equal((await sessionStatus(cafe.slug, cookie)).status, 401, "the revoked device is signed out");
    assert.equal((await sessionStatus(cafe.slug, recoveryCookie)).status, 200, "this device stays signed in");

    /* ---------------------------------------------------------------- disabling the factor */

    const disableToken = await csrfFor(cafe.slug, recoveryCookie);
    const disabled = await postJson(cafe.slug, "mfa/disable", recoveryCookie, disableToken, {
      currentPassword: OWNER_PASSWORD,
      code: confirmation.recoveryCodes[1],
    });
    assert.equal(disabled.status, 200, `removal needs the password and a live factor (${disabled.status})`);
    assert.equal(cookiesOf(disabled).split("=")[1], "", "and signs this device out");

    await clearLimits(cafe.cafeId);
    const plain = await login(cafe.slug);
    assert.equal(plain.status, 200);
    assert.equal(plain.body.mfaRequired, undefined, "with the factor off, a password is enough again");
    assert.ok(plain.cookie.startsWith("staff_session_"));
  } finally {
    await clean(cafe.cafeId);
  }
});

/* ---------------------------------------------------------------------- CSRF matrix */

test("every owner mutation refuses a request without a CSRF proof", { skip }, async () => {
  const cafe = await seed();
  try {
    const signedIn = await login(cafe.slug);
    assert.equal(signedIn.status, 200);
    const cookie = signedIn.cookie;
    const token = await csrfFor(cafe.slug, cookie);
    assert.ok(token);

    const mutations = [
      ["PATCH", "settings", { cafeName: "Should not save" }],
      ["POST", "menu", { name: "Ghost item", category: "Ghost", priceCents: 100 }],
      ["PATCH", `menu/${cafe.itemId}`, { name: "Renamed without proof" }],
      ["DELETE", `menu/${cafe.itemId}`, null],
      ["POST", "menu/reseed", {}],
      ["POST", "tables", {}],
      ["PATCH", "orders/999999", { status: "preparing" }],
      ["POST", "mfa/enroll", { currentPassword: OWNER_PASSWORD }],
      ["POST", "mfa/recovery-regenerate", { currentPassword: OWNER_PASSWORD, code: "123456" }],
      ["POST", "sessions/aaaaaaaa/revoke", {}],
      ["POST", "logout-all", {}],
    ];

    for (const [method, path, body] of mutations) {
      const res = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/${path}`, {
        method,
        headers: headersFor(cookie, null),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      assert.equal(res.status, 403, `${method} ${path} without CSRF`);
    }

    // The mutations really did not happen: same name, same item, and the same session.
    const settings = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/settings`, { headers: { cookie } });
    assert.equal(settings.status, 200);
    assert.notEqual((await settings.json()).settings.cafeName, "Should not save");

    const menu = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/menu`, { headers: { cookie } });
    const items = (await menu.json()).items || [];
    assert.equal(items.length, 1, "no ghost item was created");
    assert.ok(items.every((item) => item.name !== "Renamed without proof"));
    assert.equal((await sessionStatus(cafe.slug, cookie)).status, 200, "logout-all did not run either");

    // The same request with a valid token is accepted, so the 403s above were CSRF, not routing.
    const withToken = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/settings`, {
      method: "PATCH",
      headers: headersFor(cookie, token),
      body: JSON.stringify({ cafeName: "Saved with a token" }),
    });
    assert.equal(withToken.status, 200, `the token makes the same call work (${withToken.status})`);
    const saved = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/settings`, { headers: { cookie } });
    assert.equal((await saved.json()).settings.cafeName, "Saved with a token", "the write really landed");
  } finally {
    await clean(cafe.cafeId);
  }
});

/* ------------------------------------------------------------- membership revocation */

test("a managed session dies when its membership is withdrawn", { skip }, async () => {
  const cafe = await seed({ ownerAuth: "workos", workosUserId: "user_mfa_member_1" });
  try {
    const minted = await fetch(`${AUTH}/owner-session`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({
        slug: cafe.slug,
        sessionId: "abcdef0123456789abcdef0123456789",
        workosUserId: "user_mfa_member_1",
      }),
    });
    assert.equal(minted.status, 200);
    const { cookie } = await minted.json();
    assert.equal(
      (await sessionStatus(cafe.slug, cookie)).status,
      200,
      "a member with a live session is signed in"
    );

    const removed = await fetch(`${AUTH}/owner-membership`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ slug: cafe.slug, workosUserId: "user_mfa_member_1", remove: true }),
    });
    assert.equal(removed.status, 200);

    assert.equal(
      (await sessionStatus(cafe.slug, cookie)).status,
      401,
      "the session row still exists, but membership no longer does"
    );
    const settings = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/settings`, { headers: { cookie } });
    assert.equal(settings.status, 401, "and no owner route accepts it");
  } finally {
    await clean(cafe.cafeId);
  }
});
