// F-07 phase 2B: managed sign-in end to end, against a deterministic provider.
//
// The real handlers run against the production schema in a real SQLite database. The provider is a
// loopback fixture, so these tests prove our own logic and the SQL's own guards. They do not prove
// anything about WorkOS's real issuer, audience, sid format or revocation semantics.
import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";
import { ownerStart, ownerClaimStart, ownerCallback, ownerLogout } from "../worker/owner.js";
import { claimDigest } from "../worker/pkce.js";
import { clearJwksCache } from "../worker/workos.js";
import {
  CLIENT_ID,
  claimsFor,
  mintToken,
  sqliteDb,
  startProvider,
  testEnv,
} from "./fixtures/workos.mjs";

let provider;

test.before(async () => {
  provider = await startProvider();
});

test.after(async () => {
  await provider.close();
});

async function freshEnv(overrides = {}) {
  clearJwksCache();
  const DB = sqliteDb();
  for (const sql of SCHEMA) DB.raw.exec(sql);
  for (const sql of MIGRATIONS) {
    try {
      DB.raw.exec(sql);
    } catch (err) {
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  for (const sql of POST_MIGRATIONS) DB.raw.exec(sql);
  DB.raw.exec(
    "INSERT INTO cafes (slug, name, pass_hash, owner_auth, auth_version) VALUES ('demo', 'Demo Café', 'x', 'workos', 1)"
  );
  const cafe = DB.raw.prepare("SELECT * FROM cafes WHERE slug = 'demo'").get();
  return { env: { ...testEnv(provider, overrides), DB }, cafe: { ...cafe } };
}

function member(db, cafeId, userId = "user_test_1") {
  db.raw
    .prepare("INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, ?, 'owner', ?)")
    .run(cafeId, userId, Date.now());
}

const count = (db, sql, ...params) => Number(db.raw.prepare(sql).get(...params).value);

// Runs GET /owner/start and returns the state and PKCE challenge the provider would receive.
async function begin(env, cafe) {
  const response = await ownerStart(
    new Request(`http://127.0.0.1/api/cafes/${cafe.slug}/owner/start`),
    env,
    cafe
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location"));
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
  return {
    response,
    state: location.searchParams.get("state"),
    challenge: location.searchParams.get("code_challenge"),
    location,
  };
}

function callback(env, state, params = "code=auth_code_1") {
  const url = new URL(`http://127.0.0.1/api/owner/callback?${params}&state=${encodeURIComponent(state)}`);
  return ownerCallback(new Request(url), env, url);
}

const cookieOf = (response) => response.headers.get("set-cookie") || "";

test("an existing owner completes sign-in and gets a live session with the provider sid", async () => {
  const { env, cafe } = await freshEnv();
  member(env.DB, cafe.id);
  provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sid: "session_real_1" }));

  const started = await begin(env, cafe);
  assert.equal(started.location.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(started.location.searchParams.get("response_type"), "code");

  const response = await callback(env, started.state);
  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/c/demo/owner");

  const cookie = cookieOf(response);
  assert.match(cookie, /^staff_session_demo=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  const subject = decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("=")).split(".")[1];
  assert.match(subject, /^cafe:\d+:1:[0-9a-f]{32}$/, "the four-part owner subject is unchanged");

  const row = env.DB.raw.prepare("SELECT * FROM owner_sessions").get();
  assert.equal(row.workos_user_id, "user_test_1");
  assert.equal(row.workos_session_id, "session_real_1");
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_identities"), 1);

  // The verifier the provider received really is the one behind the challenge it was given.
  const exchange = provider.requests.filter((r) => r.path === "/user_management/authenticate").at(-1);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.body.code_verifier));
  const challenge = Buffer.from(new Uint8Array(digest)).toString("base64url");
  assert.equal(challenge, started.challenge, "PKCE S256 matches");

  // Replaying the same state and code cannot mint a second session.
  const replay = await callback(env, started.state);
  assert.equal(replay.status, 400);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 1);
});

test("a signed-in identity with no membership creates no identity and no session", async () => {
  const { env, cafe } = await freshEnv();
  provider.identity = { id: "user_stranger", email: "stranger@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sub: "user_stranger", sid: "session_s" }));

  const started = await begin(env, cafe);
  const response = await callback(env, started.state);

  assert.equal(response.status, 403);
  assert.equal(cookieOf(response), "");
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_identities"), 0);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM cafe_owners"), 0);
});

test("a missing sid authenticates with NULL and never fabricates one", async () => {
  const { env, cafe } = await freshEnv();
  member(env.DB, cafe.id);
  const claims = claimsFor();
  delete claims.sid;
  provider.accessToken = mintToken(claims);
  provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };

  const started = await begin(env, cafe);
  const response = await callback(env, started.state);
  assert.equal(response.status, 303);

  const row = env.DB.raw.prepare("SELECT * FROM owner_sessions").get();
  assert.equal(row.workos_user_id, "user_test_1");
  assert.equal(row.workos_session_id, null);
  assert.notEqual(row.workos_session_id, row.session_id);
});

test("a malformed sid authenticates with NULL", async () => {
  for (const sid of ["abc", "", 7, { nested: true }]) {
    const { env, cafe } = await freshEnv();
    member(env.DB, cafe.id);
    provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };
    provider.accessToken = mintToken(claimsFor({ sid }));

    const started = await begin(env, cafe);
    const response = await callback(env, started.state);
    assert.equal(response.status, 303, `sid ${JSON.stringify(sid)} must not block sign-in`);
    assert.equal(env.DB.raw.prepare("SELECT workos_session_id FROM owner_sessions").get().workos_session_id, null);
  }
});

test("a cancelled sign-in burns its state, exchanges nothing and creates nothing", async () => {
  const { env, cafe } = await freshEnv();
  member(env.DB, cafe.id);

  const started = await begin(env, cafe);
  const before = provider.requests.length;
  const response = await callback(env, started.state, "error=access_denied&error_description=user_cancelled");

  assert.equal(response.status, 400);
  const stateRow = env.DB.raw.prepare("SELECT used_at FROM owner_login_states").get();
  assert.ok(stateRow.used_at, "the state is burned");
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_identities"), 0);
  assert.equal(
    provider.requests.slice(before).some((r) => r.path === "/user_management/authenticate"),
    false,
    "no code exchange happens"
  );

  // The burned state cannot be reused even with a valid-looking code.
  const retry = await callback(env, started.state);
  assert.equal(retry.status, 400);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
});

test("an unknown state is refused without touching the database", async () => {
  const { env, cafe } = await freshEnv();
  member(env.DB, cafe.id);
  await begin(env, cafe);

  const response = await callback(env, "state_that_never_existed");
  assert.equal(response.status, 400);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
});

test("token failures are refused: wrong issuer, wrong audience, expiry, unverified email", async () => {
  const cases = [
    mintToken({ ...claimsFor(), iss: "https://api.workos.com/user_management/other" }),
    mintToken({ ...claimsFor(), aud: "someone_else" }),
    mintToken({ ...claimsFor(), exp: Math.floor(Date.now() / 1000) - 600 }),
    mintToken({ ...claimsFor(), sub: "user_somebody_else" }),
  ];

  for (const token of cases) {
    const { env, cafe } = await freshEnv();
    member(env.DB, cafe.id);
    provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };
    provider.accessToken = token;
    const started = await begin(env, cafe);
    const response = await callback(env, started.state);
    assert.ok(response.status >= 400 && response.status < 500, `expected a 4xx, got ${response.status}`);
    assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
  }

  // An unverified provider email cannot open a managed café.
  const { env, cafe } = await freshEnv();
  member(env.DB, cafe.id);
  provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: false };
  provider.accessToken = mintToken(claimsFor());
  const started = await begin(env, cafe);
  assert.equal((await callback(env, started.state)).status, 403);
});

test("a local café refuses managed sign-in and a managed café refuses to start unconfigured", async () => {
  const { env, cafe } = await freshEnv();
  const local = { ...cafe, owner_auth: "local" };
  const refused = await ownerStart(new Request("http://127.0.0.1/api/cafes/demo/owner/start"), env, local);
  assert.equal(refused.status, 409);
  assert.equal((await refused.json()).code, "auth_mode_local");

  const unconfigured = { ...env, WORKOS_STATE_ENCRYPTION_KEY: "" };
  const managed = await ownerStart(
    new Request("http://127.0.0.1/api/cafes/demo/owner/start"),
    unconfigured,
    cafe
  );
  assert.equal(managed.status, 503, "no key means no sign-in, never a plaintext fallback");
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_login_states"), 0);
});

test("sign-out deletes the local session, queues the provider job and revokes it", async () => {
  const { env, cafe } = await freshEnv();
  member(env.DB, cafe.id);
  provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sid: "session_to_revoke" }));
  provider.revokeStatus = 200;

  const started = await begin(env, cafe);
  const signedIn = await callback(env, started.state);
  const cookie = cookieOf(signedIn).split(";")[0];

  const response = await ownerLogout(
    new Request("http://127.0.0.1/api/cafes/demo/owner/logout", {
      method: "POST",
      headers: { cookie, origin: "http://127.0.0.1" },
    }),
    env,
    cafe
  );

  assert.equal(response.status, 303);
  assert.equal(response.headers.get("location"), "/c/demo/owner?signed_out=1");
  assert.match(cookieOf(response), /Max-Age=0/);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM csrf_tokens"), 0);

  // The drain is deliberately not awaited by the handler; give it a moment to finish.
  for (let i = 0; i < 50 && count(env.DB, "SELECT COUNT(*) AS value FROM provider_revocations") > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const revoke = provider.requests.filter((r) => r.path === "/user_management/sessions/revoke").at(-1);
  assert.ok(revoke, "the provider session was revoked");
  assert.equal(revoke.body.session_id, "session_to_revoke");
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM provider_revocations"), 0);
});

test("a session with no provider sid signs out locally and queues nothing", async () => {
  const { env, cafe } = await freshEnv();
  member(env.DB, cafe.id);
  const claims = claimsFor();
  delete claims.sid;
  provider.accessToken = mintToken(claims);
  provider.identity = { id: "user_test_1", email: "owner@example.test", email_verified: true };

  const started = await begin(env, cafe);
  const cookie = cookieOf(await callback(env, started.state)).split(";")[0];

  const response = await ownerLogout(
    new Request("http://127.0.0.1/api/cafes/demo/owner/logout", {
      method: "POST",
      headers: { cookie, origin: "http://127.0.0.1" },
    }),
    env,
    cafe
  );

  assert.equal(response.status, 303);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM provider_revocations"), 0);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
});

// ------------------------------------------------------------------ claims

async function invite(env, cafe, { email = "new@example.test", code = "invite-code-123" } = {}) {
  await env.DB.prepare(
    "INSERT INTO owner_claims (claim_hash, cafe_id, email, role, issued_by, created, expires) VALUES (?, ?, ?, 'owner', 'operator', ?, ?)"
  )
    .bind(await claimDigest(code), cafe.id, email, Date.now(), Date.now() + 60 * 60 * 1000)
    .run();
  return code;
}

const startClaim = (env, cafe, code) =>
  ownerClaimStart(
    new Request(`http://127.0.0.1/api/cafes/${cafe.slug}/owner/claim/start`, {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.9" },
      body: JSON.stringify({ code }),
    }),
    env,
    cafe
  );

const stateOf = (payload) => new URL(payload.authorizeUrl).searchParams.get("state");

test("a valid invite grants membership, creates the identity and signs the owner in", async () => {
  const { env, cafe } = await freshEnv();
  const code = await invite(env, cafe);
  provider.identity = { id: "user_new_owner", email: "New@Example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sub: "user_new_owner", sid: "session_new" }));

  const started = await startClaim(env, cafe, code);
  assert.equal(started.status, 200);
  const state = stateOf(await started.json());
  assert.ok(state, "the claim flow returns an authorization URL");

  const response = await callback(env, state);
  assert.equal(response.status, 303);
  assert.match(cookieOf(response), /^staff_session_demo=/);

  const membership = env.DB.raw.prepare("SELECT * FROM cafe_owners").all();
  assert.equal(membership.length, 1);
  assert.equal(membership[0].workos_user_id, "user_new_owner");
  assert.equal(membership[0].role, "owner");

  const identity = env.DB.raw.prepare("SELECT * FROM owner_identities").get();
  assert.equal(identity.workos_user_id, "user_new_owner");
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 1);
  assert.ok(env.DB.raw.prepare("SELECT used_at FROM owner_claims").get().used_at, "the claim is consumed");

  // The same code cannot be redeemed twice: the state is spent and the claim is used.
  const replay = await startClaim(env, cafe, code);
  assert.equal(replay.status, 404);
});

test("an email mismatch is refused and leaves the claim usable", async () => {
  const { env, cafe } = await freshEnv();
  const code = await invite(env, cafe, { email: "right@example.test" });
  provider.identity = { id: "user_wrong", email: "wrong@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sub: "user_wrong", sid: "session_wrong" }));

  const started = await startClaim(env, cafe, code);
  const state = stateOf(await started.json());
  const response = await callback(env, state);

  assert.equal(response.status, 403);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM cafe_owners"), 0);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_identities"), 0);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
  assert.equal(env.DB.raw.prepare("SELECT used_at FROM owner_claims").get().used_at, null, "the claim is not consumed");

  // And the person it was issued to can still use it.
  provider.identity = { id: "user_right", email: "RIGHT@example.test", email_verified: true };
  provider.accessToken = mintToken(claimsFor({ sub: "user_right", sid: "session_right" }));
  const retry = await startClaim(env, cafe, code);
  assert.equal(retry.status, 200);
  assert.equal((await callback(env, stateOf(await retry.json()))).status, 303);
});

test("an unknown or expired invite code is refused before any state exists", async () => {
  const { env, cafe } = await freshEnv();
  const unknown = await startClaim(env, cafe, "no-such-code");
  assert.equal(unknown.status, 404);
  assert.equal(count(env.DB, "SELECT COUNT(*) AS value FROM owner_login_states"), 0);

  await invite(env, cafe, { code: "expired-code" });
  env.DB.raw.exec("UPDATE owner_claims SET expires = 1");
  assert.equal((await startClaim(env, cafe, "expired-code")).status, 404);
});

test("a cross-origin sign-out is refused", async () => {
  const { env, cafe } = await freshEnv();
  const response = await ownerLogout(
    new Request("http://127.0.0.1/api/cafes/demo/owner/logout", {
      method: "POST",
      headers: { origin: "https://evil.test" },
    }),
    env,
    cafe
  );
  assert.equal(response.status, 403);
});
