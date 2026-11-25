// The login / password-change race, deterministically.
//
// A session is only as good as the auth_version it was stamped with. login() captures that version
// from the café row it read, *before* verifying the password, so a password change that lands in the
// window between that read and the session being issued cannot produce a session that outlives the
// change. Without the fix the login would re-read (or read later) and stamp the *new* version onto a
// session that was authenticated with the *old* password.
//
// The harness pins the window instead of hoping for one: /race-login reads the café row, holds the
// login before the password is verified, changes the password (bumping auth_version), then resumes.
// Every step is sequenced, so this is not a timing-dependent flake.
//
// Runs against the auth-enabled harness (tests/harness/wrangler.auth.jsonc on port 8790).

import test from "node:test";
import assert from "node:assert/strict";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

const HARNESS = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const OLD_PASSWORD = HARNESS_OWNER_PASSWORD;
const NEW_PASSWORD = "race-window-password-1";

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
const prefix = (extra = {}) => ({ ...jsonHeaders, origin: HARNESS, ...extra });

const staffLogin = (slug, password) =>
  fetch(`${HARNESS}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: prefix(),
    body: JSON.stringify({ password }),
  });

const sessionWith = (slug, cookie) =>
  fetch(`${HARNESS}/api/cafes/${slug}/admin/session`, { headers: { cookie } });

// `staff_session_<slug>=<expires>.<subject>.<signature>`; the subject names the version.
function subjectOf(cookie) {
  const raw = decodeURIComponent(String(cookie).split("=").slice(1).join("="));
  const parts = raw.split(".");
  return parts.length === 3 ? parts[1] : "";
}

test("login that captures the old version cannot outlive a password change", { skip }, async () => {
  const seeded = await fetch(`${HARNESS}/seed`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ serviceMode: "counter", password: OLD_PASSWORD }),
  }).then((res) => res.json());

  try {
    const race = await fetch(`${HARNESS}/race-login`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ slug: seeded.slug, password: OLD_PASSWORD, newPassword: NEW_PASSWORD }),
    }).then((res) => res.json());

    assert.equal(race.paused, true, "the login was held inside the race window");
    assert.equal(race.passwordRowsChanged, 1, "the password change landed while login was paused");
    assert.equal(
      race.authVersionAfter,
      race.authVersionBefore + 1,
      "the password change moved auth_version forward"
    );

    // The paused login verified the password it had read and issued its session from the version it
    // had read, which is the whole point of capturing the version before verification.
    assert.equal(race.loginStatus, 200, "the in-flight login completed");
    assert.ok(race.cookie, "the in-flight login issued a session cookie");

    const [kind, cafeId, version, sessionId] = subjectOf(race.cookie).split(":");
    assert.equal(kind, "cafe");
    assert.equal(cafeId, String(race.cafeId));
    assert.equal(
      version,
      String(race.authVersionBefore),
      "the issued session is stamped with the version captured before the change"
    );
    assert.match(String(sessionId), /^[0-9a-f]{32}$/, "and it names the session row that was written for it");

    // ...and that session must be refused, because the café has moved past it.
    const stale = await sessionWith(seeded.slug, race.cookie);
    assert.equal(
      stale.status,
      401,
      "a session stamped with the pre-change version is rejected by the protected endpoint"
    );

    // The old password no longer opens anything: the stored hash is the new one.
    const oldLogin = await staffLogin(seeded.slug, OLD_PASSWORD);
    assert.equal(oldLogin.status, 401, "the old password stops working after the change");

    const newLogin = await staffLogin(seeded.slug, NEW_PASSWORD);
    assert.equal(newLogin.status, 200, "the new password works");

    const freshCookie = String(newLogin.headers.get("set-cookie") || "").split(";")[0];
    const fresh = await sessionWith(seeded.slug, freshCookie);
    assert.equal(fresh.status, 200, "a session minted after the change is accepted");

    const freshSubject = subjectOf(freshCookie).split(":");
    assert.equal(freshSubject[0], "cafe");
    assert.equal(freshSubject[1], String(race.cafeId));
    assert.equal(freshSubject[2], String(race.authVersionAfter), "the new session carries the new version");
    assert.match(freshSubject[3] || "", /^[0-9a-f]{32}$/, "and names its own session row");
  } finally {
    await fetch(`${HARNESS}/clean`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify({ cafeId: seeded.cafeId }),
    });
  }
});
