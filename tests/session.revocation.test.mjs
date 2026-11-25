// F-10: owner session revocation and honest expiry reporting.
//
// A session is a signed cookie with no server-side record, so an ordinary sign-out can only clear the
// browser's copy: a token someone already holds keeps working until it expires. "Sign out everywhere"
// is the real revoke: it bumps the café's auth_version, which every previously issued token carries, so
// all of them stop matching at once — and the owner who asked is handed a fresh cookie so the screen in
// front of them keeps working. These tests pin that behaviour, the CSRF door in front of it, and the
// fact that a status reply reports the time actually left rather than the 12-hour maximum.
//
// They run against the auth harness because sessions are signed with ADMIN_SECRET, and that harness is
// the one configured with it (the batch harness deliberately has none, so the "503 without a secret"
// tests keep a deployment to point at).

import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };
const OWNER_PASSWORD = "harness-owner-password";
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

async function post(path, body) {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body || {}),
  });
}

async function seed() {
  const res = await post("/seed", { serviceMode: "counter" });
  assert.equal(res.status, 200, `/seed answered ${res.status}`);
  return res.json();
}

async function cleanup(cafeId) {
  await post("/clean", { cafeId });
}

function cookiePair(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (all[0] || res.headers.get("set-cookie") || "").split(";")[0];
}

async function login(slug) {
  const res = await fetch(`${BASE}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password: OWNER_PASSWORD }),
  });
  assert.equal(res.status, 200, `owner login answered ${res.status}`);
  const pair = cookiePair(res);
  assert.ok(pair, "owner login issued a session cookie");
  return pair;
}

async function session(slug, cookie) {
  const res = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function settingsStatus(slug, cookie) {
  const res = await fetch(`${BASE}/api/cafes/${slug}/admin/settings`, { headers: { cookie } });
  return res.status;
}

async function authVersion(cafeId) {
  const res = await post("/version", { cafeId });
  const body = await res.json();
  return Number(body.authVersion);
}

// The server proves the request came from its own origin and that the header token hashes to a row
// bound to this very session cookie.
async function logoutEverywhere(slug, cookie, csrfToken, { origin = BASE } = {}) {
  const headers = { ...JSON_HEADERS, cookie };
  if (origin) headers.origin = origin;
  if (csrfToken) headers["x-csrf-token"] = csrfToken;
  return fetch(`${BASE}/api/cafes/${slug}/admin/logout-all`, {
    method: "POST",
    headers,
    body: "{}",
  });
}

// --- owner session rows -------------------------------------------------------

function ownerCookieName(slug) {
  return `staff_session_${slug}`;
}

function cookieValue(pair) {
  return pair.slice(pair.indexOf("=") + 1);
}

// The session id is the last part of the signed subject: <expires>.cafe:<id>:<version>:<sid>.<sig>.
function sidOf(cookiePair) {
  const token = decodeURIComponent(cookieValue(cookiePair));
  const subject = token.split(".")[1] || "";
  return subject.split(":")[3];
}

function ordinaryLogout(slug, cookie, extra = {}) {
  return fetch(`${BASE}/api/cafes/${slug}/admin/logout`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), ...extra },
  });
}

async function ownerSessions(cafeId) {
  const res = await post("/owner-sessions", { cafeId });
  assert.equal(res.status, 200, `/owner-sessions answered ${res.status}`);
  return res.json();
}

async function expireSessions(cafeId, expiresInMs, createdAgoMs) {
  const payload = { cafeId };
  if (expiresInMs !== undefined) payload.expiresInMs = expiresInMs;
  if (createdAgoMs !== undefined) payload.createdAgoMs = createdAgoMs;
  const res = await post("/owner-sessions/expire", payload);
  assert.equal(res.status, 200, `/owner-sessions/expire answered ${res.status}`);
  return res.json();
}

/* --------------------------------------------------------------- revocation */

test("sign out everywhere bumps auth_version and the old cookie stops working", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const before = await authVersion(cafeId);

    const status = await session(slug, cookie);
    assert.equal(status.status, 200, "the owner is signed in before revoking");
    const csrfToken = status.body && status.body.csrfToken;
    assert.ok(csrfToken, "session status hands the board a CSRF token");

    const res = await logoutEverywhere(slug, cookie, csrfToken);
    assert.equal(res.status, 200, "sign out everywhere succeeded");

    assert.equal(await authVersion(cafeId), before + 1, "exactly one version bump");
    assert.equal(await settingsStatus(slug, cookie), 401, "the old cookie can no longer read settings");
    assert.equal((await session(slug, cookie)).status, 401, "and it is no longer a session at all");
  } finally {
    await cleanup(cafeId);
  }
});

test("sign out everywhere leaves password_changed_at alone", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const csrfToken = (await session(slug, cookie)).body.csrfToken;

    assert.equal((await logoutEverywhere(slug, cookie, csrfToken)).status, 200);

    const res = await post("/password-changed-at", { cafeId });
    const body = await res.json();
    assert.equal(Number(body.passwordChangedAt), 0, "a session decision never dates a credential change");
  } finally {
    await cleanup(cafeId);
  }
});

test("the owner who signed out everywhere keeps a working session", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const csrfToken = (await session(slug, cookie)).body.csrfToken;

    const res = await logoutEverywhere(slug, cookie, csrfToken);
    assert.equal(res.status, 200);

    const replacement = cookiePair(res);
    assert.ok(replacement, "the response carries a replacement cookie");
    assert.notEqual(replacement, cookie, "and it is a different token, stamped with the new version");

    assert.equal((await session(slug, replacement)).status, 200, "the board in front of the owner still works");
    assert.equal(await settingsStatus(slug, replacement), 200, "including its data routes");
  } finally {
    await cleanup(cafeId);
  }
});

test("a second device signed into the same café is signed out too", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const first = await login(slug);
    const second = await login(slug);

    const csrfToken = (await session(slug, first)).body.csrfToken;
    assert.equal((await logoutEverywhere(slug, first, csrfToken)).status, 200);

    assert.equal((await session(slug, second)).status, 401, "the other device is signed out");
    assert.equal((await session(slug, first)).status, 401, "and so is the token that asked");
  } finally {
    await cleanup(cafeId);
  }
});

test("an unauthenticated request cannot sign anyone out", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const csrfToken = (await session(slug, cookie)).body.csrfToken;
    const before = await authVersion(cafeId);

    const res = await logoutEverywhere(slug, "", csrfToken);
    assert.equal(res.status, 401, "no session, no revocation");
    assert.equal(await authVersion(cafeId), before, "and no version bump");
    assert.equal((await session(slug, cookie)).status, 200, "the real session is untouched");
  } finally {
    await cleanup(cafeId);
  }
});

test("one café's cookie cannot sign another café out", { skip }, async () => {
  const mine = await seed();
  const theirs = await seed();
  try {
    const cookie = await login(mine.slug);
    const csrfToken = (await session(mine.slug, cookie)).body.csrfToken;
    const before = await authVersion(theirs.cafeId);

    const res = await logoutEverywhere(theirs.slug, cookie, csrfToken);
    assert.equal(res.status, 401, "the token belongs to a different café");
    assert.equal(await authVersion(theirs.cafeId), before, "the other café keeps its sessions");
  } finally {
    await cleanup(mine.cafeId);
    await cleanup(theirs.cafeId);
  }
});

test("sign out everywhere needs the board's own origin and a live CSRF token", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const csrfToken = (await session(slug, cookie)).body.csrfToken;
    const before = await authVersion(cafeId);

    assert.equal((await logoutEverywhere(slug, cookie, "")).status, 403, "no CSRF token is refused");
    assert.equal(
      (await logoutEverywhere(slug, cookie, csrfToken, { origin: "https://evil.example" })).status,
      403,
      "another origin is refused"
    );
    assert.equal(
      (await logoutEverywhere(slug, cookie, csrfToken, { origin: null })).status,
      403,
      "a request with no Origin at all is refused"
    );

    assert.equal(await authVersion(cafeId), before, "no refusal bumped the version");
    assert.equal((await session(slug, cookie)).status, 200, "and no refusal ended the session");
  } finally {
    await cleanup(cafeId);
  }
});

// The CSRF token is stored against a hash of the session cookie that asked for it, so it is not a
// deployment-wide key: one café's token cannot drive another café's revocation, in either direction.
test("a CSRF token is bound to its own café and its own session", { skip }, async () => {
  const first = await seed();
  const second = await seed();
  try {
    const cookieA = await login(first.slug);
    const cookieB = await login(second.slug);
    const csrfA = (await session(first.slug, cookieA)).body.csrfToken;
    const csrfB = (await session(second.slug, cookieB)).body.csrfToken;
    assert.ok(csrfA && csrfB, "both boards hold a CSRF token");

    const versionA = await authVersion(first.cafeId);
    const versionB = await authVersion(second.cafeId);

    assert.equal((await logoutEverywhere(second.slug, cookieB, csrfA)).status, 403, "A's token cannot sign B out");
    assert.equal((await logoutEverywhere(first.slug, cookieA, csrfB)).status, 403, "B's token cannot sign A out");

    assert.equal(await authVersion(first.cafeId), versionA, "no refusal bumped A");
    assert.equal(await authVersion(second.cafeId), versionB, "no refusal bumped B");
    assert.equal((await session(first.slug, cookieA)).status, 200, "A is still signed in");
    assert.equal((await session(second.slug, cookieB)).status, 200, "B is still signed in");
  } finally {
    await cleanup(first.cafeId);
    await cleanup(second.cafeId);
  }
});

test("ordinary sign-out revokes that session and nothing else", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const first = await login(slug);
    const second = await login(slug);
    const before = await authVersion(cafeId);
    assert.equal((await ownerSessions(cafeId)).count, 2, "each sign-in has its own row");

    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/logout`, {
      method: "POST",
      headers: { cookie: first },
    });
    assert.equal(res.status, 200);
    assert.match(String(res.headers.get("set-cookie") || ""), /Max-Age=0/, "the browser's copy is expired");

    assert.equal(await authVersion(cafeId), before, "no version bump: the other device is untouched");
    assert.equal((await session(slug, second)).status, 200, "the other device keeps its session");
    assert.equal((await session(slug, first)).status, 401, "a copy of the signed-out cookie is refused");
    assert.equal((await ownerSessions(cafeId)).count, 1, "exactly one row was removed");
  } finally {
    await cleanup(cafeId);
  }
});

test("signing out twice, or with no session, is harmless", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    assert.equal((await ordinaryLogout(slug, cookie)).status, 200);
    assert.equal((await ordinaryLogout(slug, cookie)).status, 200, "a second sign-out is not an error");
    assert.equal((await ordinaryLogout(slug, "")).status, 200, "no cookie has nothing to revoke");
    assert.equal((await ownerSessions(cafeId)).count, 0);
  } finally {
    await cleanup(cafeId);
  }
});

test("concurrent sign-outs of one session both succeed and end consistently", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const [a, b] = await Promise.all([ordinaryLogout(slug, cookie), ordinaryLogout(slug, cookie)]);
    assert.equal(a.status, 200);
    assert.equal(b.status, 200, "the second delete removes nothing and still reports success");
    assert.equal((await session(slug, cookie)).status, 401);
    assert.equal((await ownerSessions(cafeId)).count, 0);
  } finally {
    await cleanup(cafeId);
  }
});

test("an expired session row is refused while the token itself is still valid", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    assert.equal((await session(slug, cookie)).status, 200);
    assert.ok((await expireSessions(cafeId)).changes >= 1);
    assert.equal((await session(slug, cookie)).status, 401, "the row's expiry decides, not the token");
  } finally {
    await cleanup(cafeId);
  }
});

test("a correctly signed pre-session token is refused", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const legacy = await post("/owner/legacy-token", { slug });
    assert.equal(legacy.status, 200);
    const token = (await legacy.json()).token;
    assert.equal(String(token).split(".")[1].split(":").length, 3, "the fixture really is the old shape");
    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/settings`, {
      headers: { cookie: `${ownerCookieName(slug)}=${encodeURIComponent(token)}` },
    });
    assert.equal(res.status, 401, "tokens that name no session row are not sessions");
  } finally {
    await cleanup(cafeId);
  }
});

test("a session value issued for one café cannot authenticate at another", { skip }, async () => {
  const first = await seed();
  const second = await seed();
  try {
    const cookie = await login(first.slug);
    const value = cookie.slice(cookie.indexOf("=") + 1);
    const res = await fetch(`${BASE}/api/cafes/${second.slug}/admin/settings`, {
      headers: { cookie: `${ownerCookieName(second.slug)}=${value}` },
    });
    assert.equal(res.status, 401, "the subject names another café");
    assert.equal((await session(first.slug, cookie)).status, 200, "and its own café still works");
  } finally {
    await cleanup(first.cafeId);
    await cleanup(second.cafeId);
  }
});

/* ------------------------------------------------- failure paths (D1 down) */

test("sign-in fails closed when the session row cannot be stored", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/login`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-harness-fail-owner-session-insert": "1" },
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    assert.equal(res.status, 503, "no session, no sign-in");
    assert.equal(res.headers.get("set-cookie"), null, "and above all no cookie");
    assert.equal((await ownerSessions(cafeId)).count, 0, "no orphan row was left behind");
  } finally {
    await cleanup(cafeId);
  }
});

test("verification reports 503, not 401, when the session store is unavailable", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/settings`, {
      headers: { cookie, "x-harness-fail-owner-session-read": "1" },
    });
    assert.equal(res.status, 503, "a broken store must not look like an expired session");
    assert.equal((await session(slug, cookie)).status, 200, "the session itself is still valid");
  } finally {
    await cleanup(cafeId);
  }
});

test("logout reports failure and still clears the cookie when the row cannot be deleted", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/logout`, {
      method: "POST",
      headers: { cookie, "x-harness-fail-owner-session-delete": "1" },
    });
    assert.equal(res.status, 500, "it must not claim the session was ended");
    assert.match(String(res.headers.get("set-cookie") || ""), /Max-Age=0/);
    assert.equal((await session(slug, cookie)).status, 200, "and the server still accepts it, which is what it said");
  } finally {
    await cleanup(cafeId);
  }
});

test("logout-all changes nothing and leaves no replacement when its insert fails", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const csrfToken = (await session(slug, cookie)).body.csrfToken;
    const before = await authVersion(cafeId);
    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/logout-all`, {
      method: "POST",
      headers: {
        ...JSON_HEADERS,
        cookie,
        origin: BASE,
        "x-csrf-token": csrfToken,
        "x-harness-fail-owner-session-insert": "1",
      },
      body: "{}",
    });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("set-cookie"), null, "nothing was signed out, so no new cookie");
    assert.equal(await authVersion(cafeId), before, "the version did not move");
    assert.equal((await ownerSessions(cafeId)).count, 1, "no orphaned replacement");
    assert.equal((await session(slug, cookie)).status, 200);
  } finally {
    await cleanup(cafeId);
  }
});

test("logout-all under a lost CAS race refuses and leaves no orphan row", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const csrfToken = (await session(slug, cookie)).body.csrfToken;

    const raced = await post("/owner/race", {
      slug,
      action: "logout-all",
      cookie,
      csrf: csrfToken,
    });
    assert.equal(raced.status, 200);
    const result = await raced.json();
    assert.equal(result.paused, true, "the request really was parked on its stale read");
    assert.equal(result.bumped, 1, "the version moved underneath it");
    assert.equal(result.status, 409, "the stale compare-and-swap is refused");
    assert.deepEqual(result.sessionIds, [sidOf(cookie)], "only the original row remains");
  } finally {
    await cleanup(cafeId);
  }
});

test("a password change under a lost CAS race refuses and leaves no orphan row", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    // Stage 17B: the settings mutation now requires CSRF, so the fixture supplies the token the
    // board would hold. The harness forwards it as `x-csrf-token`.
    const csrf = (await session(slug, cookie)).body.csrfToken;
    const raced = await post("/owner/race", {
      slug,
      action: "settings",
      cookie,
      csrf,
      body: { password: "harness-owner-password-2", currentPassword: OWNER_PASSWORD },
    });
    assert.equal(raced.status, 200);
    const result = await raced.json();
    assert.equal(result.paused, true);
    assert.equal(result.status, 409);
    assert.deepEqual(result.sessionIds, [sidOf(cookie)], "the replacement was removed again");

    // And the credential really did not move: the old password still signs in.
    const relogin = await fetch(`${BASE}/api/cafes/${slug}/admin/login`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ password: OWNER_PASSWORD }),
    });
    assert.equal(relogin.status, 200, "the old password was never replaced");
  } finally {
    await cleanup(cafeId);
  }
});

test("expired rows are pruned at the next sign-in", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    await expireSessions(cafeId);
    assert.equal((await ownerSessions(cafeId)).count, 1, "the dead row is still there");

    const fresh = await login(slug);
    assert.ok(fresh);
    const after = await ownerSessions(cafeId);
    assert.equal(after.count, 1, "the expired row was pruned, the new one kept");
    assert.equal((await session(slug, cookie)).status, 401);
    assert.equal((await session(slug, fresh)).status, 200);
  } finally {
    await cleanup(cafeId);
  }
});

test("concurrent logout-all actions end with exactly one live session", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const other = await login(slug);
    // Both CSRF tokens are collected before either revocation fires: the first bump would otherwise
    // invalidate the second device's session before it could even ask for one.
    const csrfToken = (await session(slug, cookie)).body.csrfToken;
    const otherCsrf = (await session(slug, other)).body.csrfToken;

    const [a, b] = await Promise.all([
      logoutEverywhere(slug, cookie, csrfToken),
      logoutEverywhere(slug, other, otherCsrf),
    ]);
    // 200: this request won the race. 409: it had already read the old version and its swap lost.
    // 401: the winner's bump had landed before this request even authenticated, so its own session
    // was already gone. 500 or a second 200 would both be wrong.
    assert.ok([200, 401, 409].includes(a.status), `unexpected ${a.status}`);
    assert.ok([200, 401, 409].includes(b.status), `unexpected ${b.status}`);
    assert.ok(a.status === 200 || b.status === 200, "exactly one revocation must land");
    assert.ok(!(a.status === 200 && b.status === 200), "a lost swap must never report success");
    assert.equal((await ownerSessions(cafeId)).count, 1, "the replacement row is the only one left");
  } finally {
    await cleanup(cafeId);
  }
});

/* ------------------------------------------------------------------- expiry */

/* ------------------------------------------------------ sliding renewal */

test("session status renews the same session and reports the renewed time", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const first = await session(slug, cookie);
    assert.equal(first.status, 200);
    const firstExpiry = Number(first.body.expiresIn);
    assert.ok(firstExpiry > SESSION_MAX_AGE - 60, `a fresh session reports nearly its full life (got ${firstExpiry})`);
    assert.ok(firstExpiry <= SESSION_MAX_AGE, `and never more than the maximum (got ${firstExpiry})`);

    // Wind the session down to a minute without touching the browser's cookie.
    await expireSessions(cafeId, 60_000);
    const before = (await ownerSessions(cafeId)).sessions[0];
    assert.ok(Number(before.expires) < Date.now() + 61_000, "the row really is nearly spent");

    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.equal(res.status, 200);
    assert.ok(res.headers.get("set-cookie"), "a renewal reissues the cookie so both sides move together");
    const body = await res.json();
    assert.ok(Number(body.expiresIn) > SESSION_MAX_AGE - 60, `it is back to a full window (got ${body.expiresIn})`);
    assert.ok(Number(body.expiresIn) <= SESSION_MAX_AGE);

    const after = (await ownerSessions(cafeId)).sessions[0];
    assert.equal(after.session_id, before.session_id, "the same session, not a new one");
    assert.ok(
      Number(after.expires) > Number(before.expires) + 11 * 60 * 60 * 1000,
      "the row moved a full window forward"
    );

    const renewedCookie = cookiePair(res);
    assert.equal(sidOf(renewedCookie), sidOf(cookie), "and the cookie still names the same session id");
    assert.equal((await session(slug, renewedCookie)).status, 200);
    assert.equal((await session(slug, cookie)).status, 200, "the previous cookie is the same live session");
  } finally {
    await cleanup(cafeId);
  }
});

test("a failed renewal never extends the browser past the server's session", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    await expireSessions(cafeId, 60_000);
    const before = (await ownerSessions(cafeId)).sessions[0];

    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, {
      headers: { cookie, "x-harness-fail-owner-session-update": "1" },
    });
    assert.equal(res.status, 200, "the session itself is still valid, so this is not a sign-out");
    assert.equal(res.headers.get("set-cookie"), null, "no cookie may be issued on a failed renewal");
    const body = await res.json();
    assert.ok(Number(body.expiresIn) <= 120, `it reports the unextended life (got ${body.expiresIn})`);
    assert.ok(body.csrfToken, "and the board still gets a usable CSRF token");

    const after = (await ownerSessions(cafeId)).sessions[0];
    assert.equal(Number(after.expires), Number(before.expires), "the row did not move either");
    assert.equal((await session(slug, cookie)).status, 200, "the untouched cookie still works");
  } finally {
    await cleanup(cafeId);
  }
});

test("renewal cannot revive an expired session, and the boundary is the row's expiry", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);

    // Two seconds left: still a session, so the heartbeat renews it.
    await expireSessions(cafeId, 2_000);
    const near = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.equal(near.status, 200, "a session with two seconds left is still renewable");
    assert.ok(near.headers.get("set-cookie"));
    const renewed = (await ownerSessions(cafeId)).sessions[0];
    assert.ok(Number(renewed.expires) > Date.now() + 11 * 60 * 60 * 1000, "and it is renewed in full");

    // Exactly at zero: not a session, so nothing is renewed and the cookie is dropped.
    const wiped = await expireSessions(cafeId, 0);
    const row = (await ownerSessions(cafeId)).sessions[0];
    assert.equal(Number(row.expires), Number(wiped.expires));
    const dead = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.equal(dead.status, 401, "an expired row cannot be renewed back to life");
    assert.match(String(dead.headers.get("set-cookie") || ""), /Max-Age=0/);
    assert.equal(
      Number((await ownerSessions(cafeId)).sessions[0].expires),
      Number(wiped.expires),
      "the refused renewal did not touch the row"
    );
  } finally {
    await cleanup(cafeId);
  }
});

test("concurrent renewals converge on one session row", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    await expireSessions(cafeId, 60_000);

    const answers = await Promise.all(
      Array.from({ length: 3 }, () => fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } }))
    );
    for (const res of answers) {
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("set-cookie"), "each renewal reissues the cookie it verified against");
    }
    const sessions = await ownerSessions(cafeId);
    assert.equal(sessions.count, 1, "renewal never creates a second row");
    const ids = new Set(answers.map((res) => sidOf(cookiePair(res))));
    ids.add(sidOf(cookie));
    assert.equal(ids.size, 1, "every answer names the same session id");
    assert.ok(
      Number(sessions.sessions[0].expires) > Date.now() + 11 * 60 * 60 * 1000,
      "and the surviving expiry is the renewed one"
    );
  } finally {
    await cleanup(cafeId);
  }
});

test("a renewed cookie keeps the CSRF token it was handed", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.ok(res.headers.get("set-cookie"), "this call renewed the session");
    const csrfToken = (await res.json()).csrfToken;
    const renewedCookie = cookiePair(res);
    assert.notEqual(renewedCookie, cookie, "the cookie really was reissued");

    const out = await logoutEverywhere(slug, renewedCookie, csrfToken);
    assert.equal(
      out.status,
      200,
      "the token survives renewal because it is bound to the session id, not the cookie value"
    );
    assert.equal((await session(slug, renewedCookie)).status, 401, "and the revocation landed");
  } finally {
    await cleanup(cafeId);
  }
});

/* ------------------------------------------------------ absolute 24-hour cap */

const HOUR_MS = 60 * 60 * 1000;
const CAP_MS = 24 * HOUR_MS;

function maxAgeOf(res) {
  const match = String(res.headers.get("set-cookie") || "").match(/Max-Age=(\d+)/);
  return match ? Number(match[1]) : null;
}

test("just before the cap, renewal stops at the cap and the cookie fits the remainder", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    // A minute of absolute lifetime left, with the idle window still wide open.
    await expireSessions(cafeId, 12 * HOUR_MS, CAP_MS - 60_000);

    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.equal(res.status, 200, "a session with a minute of absolute life left is still renewable");
    const body = await res.json();
    const maxAge = maxAgeOf(res);
    assert.ok(maxAge >= 55 && maxAge <= 61, `the cookie fits the remainder, not the idle window (got ${maxAge})`);
    assert.ok(
      Number(body.expiresIn) >= 55 && Number(body.expiresIn) <= 61,
      `the reported life matches the remainder (got ${body.expiresIn})`
    );
    assert.ok(Math.abs(maxAge - Number(body.expiresIn)) <= 2, "cookie and body agree");

    const row = (await ownerSessions(cafeId)).sessions[0];
    assert.equal(
      Number(row.expires),
      Number(row.created) + CAP_MS,
      "the row was extended to the cap, not twelve hours past it"
    );
  } finally {
    await cleanup(cafeId);
  }
});

test("exactly at the cap, the session is refused and the cookie cleared", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    // The idle expiry is still twelve hours away; only the absolute cap has arrived.
    const shaped = await expireSessions(cafeId, 12 * HOUR_MS, CAP_MS);

    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.equal(res.status, 401, "the cap alone ends the session");
    assert.equal(maxAgeOf(res), 0, "and the dead cookie is cleared");
    const row = (await ownerSessions(cafeId)).sessions[0];
    assert.equal(Number(row.expires), Number(shaped.expires), "no renewal touched the row");
  } finally {
    await cleanup(cafeId);
  }
});

test("past the cap, an unexpired row is refused on every owner path", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const shaped = await expireSessions(cafeId, 12 * HOUR_MS, CAP_MS + 5 * 60_000);

    const status = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.equal(status.status, 401);
    assert.equal(maxAgeOf(status), 0, "the session endpoint clears the cookie");

    // The same check gates every other authenticated route, not just the status endpoint.
    const settings = await fetch(`${BASE}/api/cafes/${slug}/admin/settings`, { headers: { cookie } });
    assert.equal(settings.status, 401, "a settings read is refused too");
    const orders = await fetch(`${BASE}/api/cafes/${slug}/admin/orders`, { headers: { cookie } });
    assert.equal(orders.status, 401, "and so is the order board");

    assert.equal(
      Number((await ownerSessions(cafeId)).sessions[0].expires),
      Number(shaped.expires),
      "nothing was renewed along the way"
    );
  } finally {
    await cleanup(cafeId);
  }
});

test("concurrent renewals cannot push a session past the cap", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    // Four seconds of absolute life: every renewal computes the same capped expiry from `created`.
    await expireSessions(cafeId, 12 * HOUR_MS, CAP_MS - 4000);

    const answers = await Promise.all(
      Array.from({ length: 3 }, () => fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } }))
    );
    for (const res of answers) {
      assert.equal(res.status, 200);
      const maxAge = maxAgeOf(res);
      assert.ok(maxAge <= 4, `no reissued cookie outlives the cap (got ${maxAge})`);
      assert.ok(maxAge >= 0);
    }

    const row = (await ownerSessions(cafeId)).sessions[0];
    assert.equal(
      Number(row.expires),
      Number(row.created) + CAP_MS,
      "the strongest renewal set exactly the cap and no more"
    );

    await new Promise((resolve) => setTimeout(resolve, 5000));
    const late = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.equal(late.status, 401, "once the cap passes, renewal is refused");
  } finally {
    await cleanup(cafeId);
  }
});

test("a renewed cookie's Max-Age matches the life the server reports", { skip }, async () => {
  const { cafeId, slug } = await seed();
  try {
    const cookie = await login(slug);
    const res = await fetch(`${BASE}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
    assert.equal(res.status, 200);
    const body = await res.json();
    const maxAge = maxAgeOf(res);
    assert.ok(maxAge >= 43_198 && maxAge <= 43_200, `a fresh renewal gets the full idle window (got ${maxAge})`);
    assert.ok(
      Number(body.expiresIn) >= 43_198 && Number(body.expiresIn) <= 43_200,
      `and reports the same (got ${body.expiresIn})`
    );
    assert.ok(Math.abs(maxAge - Number(body.expiresIn)) <= 2, "the two never disagree by more than clock skew");
  } finally {
    await cleanup(cafeId);
  }
});

test("operator session status reports the time actually left too", { skip }, async () => {
  const res = await post("/api/operator/login", { password: OPERATOR_PASSWORD });
  assert.equal(res.status, 200, `operator login answered ${res.status}`);
  const cookie = cookiePair(res);

  const status = await fetch(`${BASE}/api/operator/session`, { headers: { cookie } });
  assert.equal(status.status, 200);
  const body = await status.json();
  assert.ok(Number(body.expiresIn) > SESSION_MAX_AGE - 60, "a fresh operator session reports nearly its full life");
  assert.ok(Number(body.expiresIn) <= SESSION_MAX_AGE, "and never more than the maximum");
  assert.ok(body.csrfToken, "the console still receives its CSRF token");

  await fetch(`${BASE}/api/operator/logout`, { method: "POST", headers: { cookie } });
});
