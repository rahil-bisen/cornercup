// F-19: changing the owner password must prove the current password.
//
// Before this, a valid owner session was enough to replace the credential, so an unlocked board (or a
// copied cookie) could take the café over and lock the owner out. Every case below asserts both the
// status and the stored state, because the point is that a refusal changes *nothing*.

import test from "node:test";
import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes, webcrypto } from "node:crypto";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };

// The seeded password from tests/harness/credentials.mjs, and the replacement these tests install.
const OLD = HARNESS_OWNER_PASSWORD;
const NEW = "reauth-brand-new-password";

let alive = false;
try {
  const probe = await fetch(`${AUTH}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not available at ${AUTH}`;

async function seed() {
  const res = await fetch(`${AUTH}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ serviceMode: "tables" }),
  });
  assert.equal(res.status, 200, `/seed answered ${res.status}`);
  const cafe = await res.json();
  // `/seed` reuses the highest id after a delete, so a stale counter from an earlier run could
  // otherwise make the first assertion of a test a 429. `rateRow` is hoisted.
  await rateRow(cafe.cafeId, true);
  return cafe;
}

async function clean(cafeId) {
  await fetch(`${AUTH}/clean`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId }),
  });
}

async function login(slug, password) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password }),
  });
  const cookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  const pair = (cookies[0] || res.headers.get("set-cookie") || "").split(";")[0];
  return { status: res.status, cookie: pair };
}

// Stage 17B: every owner mutation now proves CSRF (exact Origin + a live token bound to the session),
// so the fixture does what the board does: read the token from the session endpoint and send it.
async function csrfFor(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  const payload = await res.json().catch(() => ({}));
  return (payload && payload.csrfToken) || "";
}

async function patchSettings(slug, cookie, body, headers = {}) {
  const csrf = await csrfFor(slug, cookie);
  return fetch(`${AUTH}/api/cafes/${slug}/admin/settings`, {
    method: "PATCH",
    headers: { ...JSON_HEADERS, cookie, origin: AUTH, "x-csrf-token": csrf, ...headers },
    body: JSON.stringify(body),
  });
}

async function settingsOf(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/settings`, { headers: { cookie } });
  assert.equal(res.status, 200, `settings read answered ${res.status}`);
  return (await res.json()).settings;
}

async function sessionWith(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  return res.status;
}

async function versionOf(cafeId) {
  const res = await fetch(`${AUTH}/version`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId }),
  });
  assert.equal(res.status, 200);
  return Number((await res.json()).authVersion);
}

// Test-only: install a hash a normal sign-in could never leave behind.
async function setHash(cafeId, hash) {
  const res = await fetch(`${AUTH}/set-hash`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId, hash }),
  });
  assert.equal(res.status, 200);
}

function legacyHash(password, iterations) {
  const salt = randomBytes(16);
  const tag = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  return `pbkdf2$${iterations}$${salt.toString("base64")}$${tag.toString("base64")}`;
}

// The counter key embeds a hash of the client IP, which wrangler derives itself. Rather than
// duplicating that rule here, ask the harness which `settings:<cafeId>:` key actually exists.
async function rateKey(cafeId) {
  const res = await fetch(`${AUTH}/rate-limit/keys`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ prefix: `settings:${cafeId}:` }),
  });
  assert.equal(res.status, 200);
  const keys = (await res.json()).keys || [];
  return keys.length ? keys[0] : null;
}

async function rateRow(cafeId, clear = false) {
  const key = await rateKey(cafeId);
  if (!key) return null; // nothing was counted (or it was already cleared)
  const res = await fetch(`${AUTH}/rate-row`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ key, ...(clear ? { clear: true } : { read: true }) }),
  });
  assert.equal(res.status, 200);
  return (await res.json()).row;
}

test("F-19: a settings save without a password needs no re-authentication", { skip }, async () => {
  const cafe = await seed();
  try {
    const owner = await login(cafe.slug, OLD);
    assert.equal(owner.status, 200);

    const saved = await patchSettings(cafe.slug, owner.cookie, { cafeName: "Reauth Test Café" });
    assert.equal(saved.status, 200, "preferences stay session-only");

    const settings = await settingsOf(cafe.slug, owner.cookie);
    assert.equal(settings.cafeName, "Reauth Test Café");
    assert.equal(await sessionWith(cafe.slug, owner.cookie), 200, "the session is untouched");

    // Sending a current password without a new one is a no-op field, not an error.
    const extra = await patchSettings(cafe.slug, owner.cookie, {
      cafeName: "Reauth Test Café",
      currentPassword: OLD,
    });
    assert.equal(extra.status, 200);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-19: a new password without the current one is 400 and writes nothing", { skip }, async () => {
  const cafe = await seed();
  try {
    const owner = await login(cafe.slug, OLD);
    const before = await settingsOf(cafe.slug, owner.cookie);
    const version = await versionOf(cafe.cafeId);

    const refused = await patchSettings(cafe.slug, owner.cookie, {
      password: NEW,
      cafeName: "Should Not Apply",
    });
    assert.equal(refused.status, 400);
    assert.match(String((await refused.json()).error), /current password/i);

    // No partial application: the name in the same request was abandoned too.
    const after = await settingsOf(cafe.slug, owner.cookie);
    assert.equal(after.cafeName, before.cafeName, "the café name was not written");
    assert.equal(await versionOf(cafe.cafeId), version, "the session version did not move");
    assert.equal((await login(cafe.slug, OLD)).status, 200, "the old password still works");
    assert.equal((await login(cafe.slug, NEW)).status, 401, "the new password was never installed");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-19: a wrong current password is 401 and writes nothing", { skip }, async () => {
  const cafe = await seed();
  try {
    const owner = await login(cafe.slug, OLD);
    const before = await settingsOf(cafe.slug, owner.cookie);
    const version = await versionOf(cafe.cafeId);

    const refused = await patchSettings(cafe.slug, owner.cookie, {
      password: NEW,
      cafeName: "Also Should Not Apply",
      contactPhone: "0000000000",
      currentPassword: "definitely-not-the-password",
    });
    assert.equal(refused.status, 401);
    // The code is what keeps the staff screen from treating this 401 as an ended session.
    assert.equal((await refused.clone().json()).code, "reauth_required");

    const after = await settingsOf(cafe.slug, owner.cookie);
    assert.deepEqual(after, before, "every field in the request was left alone");
    assert.equal(await versionOf(cafe.cafeId), version);
    assert.equal((await login(cafe.slug, OLD)).status, 200);
    assert.equal((await login(cafe.slug, NEW)).status, 401);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-19: the right current password changes it, bumps the version, and keeps this browser in", { skip }, async () => {
  const cafe = await seed();
  try {
    const first = await login(cafe.slug, OLD);
    assert.equal(first.status, 200);
    const version = await versionOf(cafe.cafeId);

    const changed = await patchSettings(cafe.slug, first.cookie, {
      password: NEW,
      currentPassword: OLD,
    });
    assert.equal(changed.status, 200, "a proven change is accepted");

    const cookies = typeof changed.headers.getSetCookie === "function" ? changed.headers.getSetCookie() : [];
    const fresh = (cookies[0] || changed.headers.get("set-cookie") || "").split(";")[0];
    assert.ok(fresh.startsWith("staff_session_"), "this browser is handed a fresh session");

    assert.equal(await versionOf(cafe.cafeId), version + 1, "auth_version moved exactly once");
    assert.equal(await sessionWith(cafe.slug, first.cookie), 401, "the pre-change session is dead");
    assert.equal(await sessionWith(cafe.slug, fresh), 200, "the replacement session works");

    assert.equal((await login(cafe.slug, OLD)).status, 401, "the old password stops working");
    assert.equal((await login(cafe.slug, NEW)).status, 200, "the new password works");
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-19: five failed re-authentications lock the path, even for the right password", { skip }, async () => {
  const cafe = await seed();
  try {
    const owner = await login(cafe.slug, OLD);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const refused = await patchSettings(cafe.slug, owner.cookie, {
        password: NEW,
        currentPassword: `wrong-attempt-${attempt}`,
      });
      assert.equal(refused.status, 401, `attempt ${attempt} is a 401`);
    }

    const row = await rateRow(cafe.cafeId);
    assert.ok(row && Number(row.count) >= 5, "the failures were counted against this café and IP");

    const locked = await patchSettings(cafe.slug, owner.cookie, {
      password: NEW,
      currentPassword: OLD,
    });
    assert.equal(locked.status, 429, "a correct password cannot bypass an active lockout");
    assert.equal((await login(cafe.slug, OLD)).status, 200, "and the credential was never changed");

    await rateRow(cafe.cafeId, true);
    const afterUnlock = await patchSettings(cafe.slug, owner.cookie, {
      password: NEW,
      currentPassword: OLD,
    });
    assert.equal(afterUnlock.status, 200, "once the counter is gone a proven change succeeds");
    assert.equal((await login(cafe.slug, NEW)).status, 200);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-19: a successful change clears the failure counter", { skip }, async () => {
  const cafe = await seed();
  try {
    const owner = await login(cafe.slug, OLD);

    for (const wrong of ["first-wrong-password", "second-wrong-password"]) {
      const refused = await patchSettings(cafe.slug, owner.cookie, {
        password: NEW,
        currentPassword: wrong,
      });
      assert.equal(refused.status, 401);
    }
    assert.ok(Number((await rateRow(cafe.cafeId)).count) >= 2);

    const changed = await patchSettings(cafe.slug, owner.cookie, {
      password: NEW,
      currentPassword: OLD,
    });
    assert.equal(changed.status, 200);
    assert.equal(await rateRow(cafe.cafeId), null, "the counter row is removed on success");

    // A fresh failure after a success must be a plain 401, not a carried-over lockout.
    const cookies = typeof changed.headers.getSetCookie === "function" ? changed.headers.getSetCookie() : [];
    const fresh = (cookies[0] || changed.headers.get("set-cookie") || "").split(";")[0];
    const afterChange = await patchSettings(cafe.slug, fresh, {
      password: "another-brand-new-password",
      currentPassword: "still-not-the-password",
    });
    assert.equal(afterChange.status, 401);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-19: legacy and unsupported hashes follow the sign-in policy", { skip }, async () => {
  const cafe = await seed();
  try {
    const owner = await login(cafe.slug, OLD);

    // A 100k PBKDF2 hash from before the Argon2id migration is still verified here…
    await setHash(cafe.cafeId, legacyHash("legacy-current-pass", 100_000));
    const upgraded = await patchSettings(cafe.slug, owner.cookie, {
      password: "legacy-upgraded-password",
      currentPassword: "legacy-current-pass",
    });
    assert.equal(upgraded.status, 200, "a legacy password proves itself the same way");
    assert.equal((await login(cafe.slug, "legacy-upgraded-password")).status, 200, "and is rehashed");
    assert.equal((await login(cafe.slug, "legacy-current-pass")).status, 401);

    // …while a work factor this runtime cannot compute is a controlled operator reset, never weaker.
    const fresh = await login(cafe.slug, "legacy-upgraded-password");
    await setHash(cafe.cafeId, legacyHash("too-strong-to-check", 600_000));
    const unsupported = await patchSettings(cafe.slug, fresh.cookie, {
      password: "yet-another-password",
      currentPassword: "too-strong-to-check",
    });
    assert.equal(unsupported.status, 409);
    assert.match(String((await unsupported.json()).error), /operator/i);
    // With an unsupported work factor sign-in answers 409 for every password, so that is the honest
    // expectation here — and it is also the proof that the new password was never installed.
    assert.equal((await login(cafe.slug, "yet-another-password")).status, 409, "nothing was installed");
    assert.equal((await login(cafe.slug, "too-strong-to-check")).status, 409, "sign-in agrees it is unusable");

    // A café with no hash at all cannot prove any current password either.
    await setHash(cafe.cafeId, null);
    const none = await patchSettings(cafe.slug, fresh.cookie, {
      password: "yet-another-password",
      currentPassword: "anything-at-all",
    });
    assert.equal(none.status, 409);
    // No stored hash is the F-01 "operator must set a password" state, which sign-in answers with 503.
    assert.equal((await login(cafe.slug, "yet-another-password")).status, 503);
  } finally {
    await clean(cafe.cafeId);
  }
});

test("F-19: a store failure during re-authentication fails closed", { skip }, async () => {
  const cafe = await seed();
  try {
    const owner = await login(cafe.slug, OLD);

    // The lockout counter cannot be read: refuse before verifying anything.
    const unreadable = await patchSettings(
      cafe.slug,
      owner.cookie,
      { password: NEW, currentPassword: OLD },
      { "x-harness-fail-rate-limit-read": "1" }
    );
    assert.equal(unreadable.status, 503);
    assert.equal((await login(cafe.slug, OLD)).status, 200, "the old password still works");
    assert.equal((await login(cafe.slug, NEW)).status, 401, "no change was installed");

    // A failed attempt whose counter cannot be written also refuses rather than proceeding unthrottled.
    const unwritable = await patchSettings(
      cafe.slug,
      owner.cookie,
      { password: NEW, currentPassword: "wrong-password-here" },
      { "x-harness-fail-rate-limit-write": "1" }
    );
    assert.equal(unwritable.status, 503);
    assert.equal((await login(cafe.slug, OLD)).status, 200);
    assert.equal((await login(cafe.slug, NEW)).status, 401);

    // A normal save still works when nothing is being changed.
    const saved = await patchSettings(cafe.slug, owner.cookie, { cafeName: "Store Failure Café" });
    assert.equal(saved.status, 200);
  } finally {
    await clean(cafe.cafeId);
  }
});
