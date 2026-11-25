// F-07 phase 2B — the managed owner routes over the real Worker HTTP surface.
//
// Route table, body limits, rate limits, http.js responses and D1 all run as deployed. The provider is
// a deterministic loopback fixture; nothing here proves real WorkOS behaviour.
import test from "node:test";
import assert from "node:assert/strict";
import {
  CLIENT_ID,
  ISSUER,
  claimsFor,
  mintToken,
  startProvider,
} from "./fixtures/workos.mjs";

const BASE = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
// Provider session ids are a global primary key in the revocation queue, so a run must not reuse one
// that an earlier run left behind.
const RUN = Math.random().toString(36).slice(2, 8);
const sid = (name) => `session_${name}_${RUN}`;
const STATE_KEY = "state-encryption-key-for-http-tests-0123456789";

let provider;
let workos;

test.before(async () => {
  provider = await startProvider();
  workos = {
    clientId: CLIENT_ID,
    apiKey: "sk_test_phase2b_not_a_secret",
    redirectUri: `${BASE}/api/owner/callback`,
    issuer: ISSUER,
    audience: CLIENT_ID,
    stateKey: STATE_KEY,
    apiBase: provider.url,
  };
});

test.after(async () => {
  await provider.close();
});

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body ?? {}),
  });

// Failures on the harness itself (a 4xx/5xx HTML page, a dropped connection) must say which call,
// instead of surfacing as an opaque JSON parse error somewhere downstream.
async function readJson(response, label) {
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `${label} returned ${response.status} ${response.headers.get("content-type")}: ${text.slice(0, 200)}`
    );
  }
}

async function probe(path, { method = "GET", headers = {}, body = null } = {}) {
  const response = await fetch(`${BASE}/owner-probe`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ path, method, headers, body, workos }),
  });
  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(
      `probe ${path} returned ${response.status} ${response.headers.get("content-type")}: ${text.slice(0, 200)}`
    );
  }
  // The probe reports a thrown Worker exception instead of hiding it behind a 500 page.
  if (payload.status === 0) throw new Error(`probe ${path} threw: ${payload.probeError}`);
  return payload;
}

async function seedManaged(extra = {}) {
  const response = await post("/seed", {
    serviceMode: "counter",
    ownerAuth: "workos",
    workosUserId: "user_test_1",
    ...extra,
  });
  assert.equal(response.status, 200);
  return readJson(response, "POST /seed");
}

const snapshot = async (slug) => readJson(await post("/owner-snapshot", { slug }), "POST /owner-snapshot");
const clean = (slug) => post("/clean", { slug });

const stateFrom = (location) => new URL(location).searchParams.get("state");

async function begin(slug) {
  const started = await probe(`/api/cafes/${slug}/owner/start`);
  assert.equal(started.status, 302);
  return { state: stateFrom(started.location), location: new URL(started.location) };
}

const callback = (state, params = "code=auth_code_http") =>
  probe(`/api/owner/callback?${params}&state=${encodeURIComponent(state)}`);

test("the public config exposes the mode and nothing else", async () => {
  const managed = await seedManaged();
  const local = await post("/seed", { serviceMode: "counter" }).then((r) => r.json());

  const managedConfig = await (await fetch(`${BASE}/api/cafes/${managed.slug}/config`)).json();
  assert.equal(managedConfig.ownerAuth, "workos");
  const localConfig = await (await fetch(`${BASE}/api/cafes/${local.slug}/config`)).json();
  assert.equal(localConfig.ownerAuth, "local");

  // Nothing identity-shaped may ride along with the label.
  const text = JSON.stringify(managedConfig);
  for (const leak of ["workos_user", "session_", "access_token", "client_id", "secret", "@"]) {
    assert.equal(text.includes(leak), false, `config must not contain ${leak}`);
  }

  await clean(managed.slug);
  await clean(local.slug);
});

test("managed login returns 410 while local login still works", async () => {
  const managed = await seedManaged();
  const refused = await post(`/api/cafes/${managed.slug}/admin/login`, { password: "irrelevant-password" });
  assert.equal(refused.status, 410);
  assert.equal((await refused.json()).code, "auth_mode_managed");

  const local = await post("/seed", { serviceMode: "counter" }).then((r) => r.json());
  const ok = await post(`/api/cafes/${local.slug}/admin/login`, { password: "harness-owner-password-1" });
  assert.ok([200, 401].includes(ok.status), "local sign-in is not blocked by the managed guard");
  assert.notEqual(ok.status, 410);

  await clean(managed.slug);
  await clean(local.slug);
});

test("a local café refuses managed sign-in at the route", async () => {
  const cafe = await post("/seed", { serviceMode: "counter" }).then((r) => r.json());
  const started = await probe(`/api/cafes/${cafe.slug}/owner/start`);
  assert.equal(started.status, 409);
  assert.equal(started.body.code, "auth_mode_local");
  await clean(cafe.slug);
});

test("the full sign-in completes over HTTP and sets the café cookie", async () => {
  const cafe = await seedManaged();
  provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sid: sid("http") }));

  const { state, location } = await begin(cafe.slug);
  assert.equal(location.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");

  const done = await callback(state);
  assert.equal(done.status, 303);
  assert.equal(done.location, `/c/${cafe.slug}/owner`);
  assert.match(done.setCookie, new RegExp(`^staff_session_${cafe.slug}=`));
  assert.match(done.setCookie, /HttpOnly/);
  assert.match(done.setCookie, /SameSite=Strict/);

  const snap = await snapshot(cafe.slug);
  assert.equal(snap.sessions.length, 1, `one session, got ${JSON.stringify(snap.sessions)}`);
  assert.equal(snap.sessions[0].workos_user_id, "user_test_1");
  assert.equal(snap.sessions[0].workos_session_id, sid("http"));
  // Identities are provider-wide and outlive a café, so this asks about this identity only.
  assert.equal(
    snap.identities.some((row) => row.workos_user_id === "user_test_1"),
    true,
    "the signed-in identity is recorded"
  );

  // Replay of the same state and code is refused, with no second session.
  const replay = await callback(state);
  assert.equal(replay.status, 400);
  assert.equal((await snapshot(cafe.slug)).sessions.length, 1);

  await clean(cafe.slug);
});

test("an identity with no membership is refused and writes nothing", async () => {
  const cafe = await seedManaged({ workosUserId: null });
  provider.identity = { id: "user_outsider", email: "outsider@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sub: "user_outsider", sid: "session_outsider" }));

  const { state } = await begin(cafe.slug);
  const refused = await callback(state);
  assert.equal(refused.status, 403);
  assert.equal(refused.setCookie, null);

  const snap = await snapshot(cafe.slug);
  assert.equal(snap.sessions.length, 0, "no session for a stranger");
  assert.equal(snap.owners.length, 0, "no membership for a stranger");
  // owner_identities is provider-wide, so assert about this identity rather than a table total.
  assert.equal(
    snap.identities.some((row) => row.workos_user_id === "user_outsider"),
    false,
    "a refused sign-in never records an identity"
  );

  await clean(cafe.slug);
});

test("an invalid JWT is refused before any session exists", async () => {
  const cafe = await seedManaged();
  provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };

  for (const token of [
    mintToken({ ...claimsFor(), aud: "someone_else" }),
    mintToken({ ...claimsFor(), iss: "https://api.workos.com/user_management/other" }),
    mintToken({ ...claimsFor(), exp: Math.floor(Date.now() / 1000) - 600 }),
    mintToken({ ...claimsFor(), sub: "user_somebody_else" }),
    "not.a.jwt",
  ]) {
    provider.accessToken = token;
    const { state } = await begin(cafe.slug);
    const refused = await callback(state);
    assert.ok(refused.status >= 400 && refused.status < 500, `token variant must be 4xx, got ${refused.status}`);
  }
  assert.equal((await snapshot(cafe.slug)).sessions.length, 0);
  await clean(cafe.slug);
});

test("cancellation burns the state, and an expired state is refused", async () => {
  const cafe = await seedManaged();

  const a = await begin(cafe.slug);
  const cancelled = await callback(a.state, "error=access_denied");
  assert.equal(cancelled.status, 400);
  const snap = await snapshot(cafe.slug);
  assert.ok(snap.states.find((row) => row.used_at), "the state is spent");
  assert.equal(snap.sessions.length, 0);

  const b = await begin(cafe.slug);
  await post("/owner-expire-states", { slug: cafe.slug });
  provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor());
  const expired = await callback(b.state);
  assert.equal(expired.status, 400);
  assert.equal((await snapshot(cafe.slug)).sessions.length, 0);

  await clean(cafe.slug);
});

test("an invite grants membership over HTTP and a mismatched email does not", async () => {
  const cafe = await seedManaged({ workosUserId: null });
  await post("/owner-claim", { slug: cafe.slug, code: "http-invite-code", email: "invited@example.test" });

  provider.identity = { id: "user_wrong", email: "wrong@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sub: "user_wrong", sid: "session_wrong" }));

  const mismatched = await probe(`/api/cafes/${cafe.slug}/owner/claim/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.7" },
    body: { code: "http-invite-code" },
  });
  assert.equal(mismatched.status, 200);
  const refused = await callback(stateFrom(mismatched.body.authorizeUrl));
  assert.equal(refused.status, 403);
  let snap = await snapshot(cafe.slug);
  assert.equal(snap.sessions.length, 0, "a mismatched email mints no session");
  assert.equal(snap.owners.length, 0, "a mismatched email grants no membership");
  assert.equal(snap.claims[0].used_at, null, "the claim is not consumed");

  provider.identity = { id: "user_invited", email: "INVITED@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sub: "user_invited", sid: "session_invited" }));
  const accepted = await probe(`/api/cafes/${cafe.slug}/owner/claim/start`, {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "198.51.100.8" },
    body: { code: "http-invite-code" },
  });
  assert.equal(accepted.status, 200);
  const granted = await callback(stateFrom(accepted.body.authorizeUrl));
  assert.equal(granted.status, 303);

  snap = await snapshot(cafe.slug);
  assert.equal(snap.owners.length, 1, "the invited email now owns the café");
  assert.equal(snap.owners[0].workos_user_id, "user_invited");
  assert.equal(snap.sessions.length, 1);
  assert.ok(snap.claims[0].used_at, "the claim is consumed");

  await clean(cafe.slug);
});

// ---------------------------------------------------------------- logout-all

async function seedSession(slug, sessionId, sid, workosUserId = "user_test_1") {
  const response = await post("/owner-session", { slug, sessionId, workosSessionId: sid, workosUserId });
  assert.equal(response.status, 200);
  const payload = await readJson(response, "POST /owner-session");
  assert.match(String(payload.cookie), /^staff_session_/, "the harness must mint a cookie");
  return payload;
}

// Logout-all queues the provider jobs and then drains them inline, so the durable row may already be
// gone by the time the next request runs. What must hold either way is which provider sessions were
// asked to revoke — and, above all, that the acting browser's session was not.
// The inline drain after the batch is deliberately not awaited by the route, so it may be cancelled
// once the response is sent and the job stays queued for the next drain. The durable row is therefore
// the assertion; what the provider was asked for is asserted separately, as a never-happens check.
const revokes = () => provider.requests.filter((row) => row.path.endsWith("/sessions/revoke"));
const revokedSids = () => revokes().map((row) => (row.body && row.body.session_id) || null);
const queuedSids = (snap) => snap.revocations.map((row) => row.workos_session_id);

const logoutAll = (slug, cookie, csrf) =>
  probe(`/api/cafes/${slug}/admin/logout-all`, {
    method: "POST",
    headers: { cookie, "x-csrf-token": csrf, origin: BASE },
  });

test("logout-all keeps the acting session and never revokes its provider session", async () => {
  const cafe = await seedManaged();
  const acting = await seedSession(cafe.slug, "1".repeat(32), sid("shared"));
  // A second local row minted from the same provider session.
  await seedSession(cafe.slug, "2".repeat(32), sid("shared"));
  await seedSession(cafe.slug, "3".repeat(32), sid("other"));
  await seedSession(cafe.slug, "4".repeat(32), null);

  const { token: csrf } = await readJson(await post("/owner-csrf", { sessionId: "1".repeat(32) }), "POST /owner-csrf");
  const response = await logoutAll(cafe.slug, acting.cookie, csrf);

  assert.equal(response.status, 200);
  assert.match(response.setCookie, new RegExp(`^staff_session_${cafe.slug}=`));

  const snap = await snapshot(cafe.slug);
  assert.equal(snap.sessions.length, 1, "exactly one live session remains");
  assert.equal(snap.sessions[0].workos_session_id, sid("shared"), "it inherited the provider sid");
  assert.notEqual(snap.sessions[0].session_id, "1".repeat(32), "the acting session was replaced");

  assert.ok(
    queuedSids(snap).includes(sid("other")),
    `the other device's provider session is queued for revocation, got ${JSON.stringify(queuedSids(snap))}`
  );
  assert.equal(
    queuedSids(snap).includes(sid("shared")),
    false,
    "the retained provider session is never queued, even though two local rows shared it"
  );
  assert.equal(revokedSids().includes(sid("shared")), false, "and it is never sent to the provider");

  await clean(cafe.slug);
});

test("logout-all loses the compare-and-swap and leaves no jobs behind", async () => {
  const cafe = await seedManaged();
  const acting = await seedSession(cafe.slug, "5".repeat(32), sid("keep_b"));
  await seedSession(cafe.slug, "6".repeat(32), sid("drop_b"));
  const { token: csrf } = await readJson(await post("/owner-csrf", { sessionId: "5".repeat(32) }), "POST /owner-csrf");

  // The harness holds the request after it reads the café row, bumps auth_version, then releases it —
  // the exact window a concurrent password change or mode switch opens.
  const raced = await readJson(
    await post("/owner/race", { slug: cafe.slug, action: "logout-all", cookie: acting.cookie, csrf, body: {} }),
    "POST /owner/race"
  );
  assert.equal(raced.paused, true);
  assert.equal(raced.status, 409, "the stale version is refused");
  assert.deepEqual(raced.sessionIds.sort(), ["5".repeat(32), "6".repeat(32)], "no session was removed");

  const snap = await snapshot(cafe.slug);
  assert.deepEqual(snap.revocations, [], "no provider job survives a rolled-back transition");
  assert.deepEqual(
    revokedSids().filter((row) => row === sid("keep_b") || row === sid("drop_b")),
    [],
    "a rolled-back logout-all asks the provider for nothing"
  );

  await clean(cafe.slug);
});

test("logout-all without CSRF is refused and changes nothing", async () => {
  const cafe = await seedManaged();
  const acting = await seedSession(cafe.slug, "7".repeat(32), sid("keep_c"));

  const response = await logoutAll(cafe.slug, acting.cookie, "");
  assert.equal(response.status, 403);

  const snap = await snapshot(cafe.slug);
  assert.equal(snap.sessions.length, 1);
  assert.deepEqual(snap.revocations, []);
  assert.deepEqual(revokedSids().filter((row) => row === sid("keep_c")), []);

  await clean(cafe.slug);
});

test("two concurrent logout-all attempts leave exactly one live session", async () => {
  const cafe = await seedManaged();
  const acting = await seedSession(cafe.slug, "8".repeat(32), sid("keep_d"));
  await seedSession(cafe.slug, "9".repeat(32), sid("other_d"));
  const { token: csrf } = await readJson(await post("/owner-csrf", { sessionId: "8".repeat(32) }), "POST /owner-csrf");

  const [a, b] = await Promise.all([
    logoutAll(cafe.slug, acting.cookie, csrf),
    logoutAll(cafe.slug, acting.cookie, csrf),
  ]);

  const statuses = [a.status, b.status].sort();
  assert.equal(statuses[0], 200, "exactly one attempt succeeds");
  // The loser is refused either because the version moved (409) or because the winner already spent
  // the CSRF row (403). Both are correct; what matters is that it changed nothing.
  // Refused because the version moved (409), because the winner spent the CSRF row (403), or because
  // the winner's session replacement already invalidated the cookie (401). All three change nothing.
  assert.ok([401, 403, 409].includes(statuses[1]), `loser must be refused, got ${statuses[1]}`);

  const snap = await snapshot(cafe.slug);
  assert.equal(snap.sessions.length, 1);
  assert.equal(
    revokedSids().includes(sid("keep_d")),
    false,
    "the surviving session's provider session is never revoked"
  );
  assert.equal(queuedSids(snap).includes(sid("keep_d")), false, "it is never queued either");
  assert.ok(queuedSids(snap).includes(sid("other_d")), "the other device is queued");

  await clean(cafe.slug);
});
