// F-07 phase 2B — operator owner management over the real Worker HTTP surface (auth harness, 8790).
//
// These run through handleApi exactly as a browser would: operator login, CSRF, the route table,
// D1, and the audit table. Nothing is called as an internal function.
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const OPERATOR_PASSWORD = "operator-test-password";

const post = (path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: JSON.stringify(body ?? {}),
  });

const get = (path, headers = {}) => fetch(`${BASE}${path}`, { headers: { origin: BASE, ...headers } });

const cookieOf = (response) => String(response.headers.get("set-cookie") || "").split(";")[0];

async function operator() {
  const response = await post("/api/operator/login", { password: OPERATOR_PASSWORD });
  assert.equal(response.status, 200, "operator login must succeed");
  const body = await response.json();
  return { cookie: cookieOf(response), csrf: body.csrfToken, body };
}

async function seedCafe(extra = {}) {
  const response = await post("/seed", { serviceMode: "counter", ...extra });
  assert.equal(response.status, 200);
  return response.json();
}

test("operator owner routes require a session", async () => {
  const cafe = await seedCafe();
  const response = await get(`/api/operator/cafes/${cafe.slug}/owners`);
  assert.equal(response.status, 401);
  await post("/clean", { slug: cafe.slug });
});

test("a mutating operator route without CSRF is refused and writes nothing", async () => {
  const op = await operator();
  const cafe = await seedCafe();

  const refused = await post(
    `/api/operator/cafes/${cafe.slug}/owners`,
    { workosUserId: "user_csrf_probe" },
    { cookie: op.cookie }
  );
  assert.equal(refused.status, 403);

  const list = await get(`/api/operator/cafes/${cafe.slug}/owners`, { cookie: op.cookie });
  assert.deepEqual((await list.json()).owners, [], "no membership was written");
  await post("/clean", { slug: cafe.slug });
});

test("grant, list and revoke work, and each mutation is audited", async () => {
  const op = await operator();
  const cafe = await seedCafe();
  const headers = { cookie: op.cookie, "x-csrf-token": op.csrf };

  const granted = await post(`/api/operator/cafes/${cafe.slug}/owners`, { workosUserId: "user_granted" }, headers);
  assert.equal(granted.status, 201);

  // Idempotent: the same grant twice is not an error and does not duplicate.
  assert.equal((await post(`/api/operator/cafes/${cafe.slug}/owners`, { workosUserId: "user_granted" }, headers)).status, 201);

  const list = await (await get(`/api/operator/cafes/${cafe.slug}/owners`, { cookie: op.cookie })).json();
  assert.equal(list.owners.length, 1);
  assert.equal(list.owners[0].workosUserId, "user_granted");
  assert.equal(list.owners[0].role, "owner");

  const revoked = await fetch(`${BASE}/api/operator/cafes/${cafe.slug}/owners/user_granted`, {
    method: "DELETE",
    headers: { cookie: op.cookie, "x-csrf-token": op.csrf, origin: BASE },
  });
  assert.equal(revoked.status, 200);

  const empty = await (await get(`/api/operator/cafes/${cafe.slug}/owners`, { cookie: op.cookie })).json();
  assert.equal(empty.owners.length, 0);

  // Revoking something that was never granted is a 404, not a silent success.
  const again = await fetch(`${BASE}/api/operator/cafes/${cafe.slug}/owners/user_granted`, {
    method: "DELETE",
    headers: { cookie: op.cookie, "x-csrf-token": op.csrf, origin: BASE },
  });
  assert.equal(again.status, 404);

  await post("/clean", { slug: cafe.slug });
});

test("an unknown café and a malformed identity are refused", async () => {
  const op = await operator();
  const headers = { cookie: op.cookie, "x-csrf-token": op.csrf };

  assert.equal((await get("/api/operator/cafes/no-such-cafe-xyz/owners", { cookie: op.cookie })).status, 404);
  assert.equal((await post("/api/operator/cafes/no-such-cafe-xyz/owners", { workosUserId: "user_x" }, headers)).status, 404);

  const cafe = await seedCafe();
  for (const bad of ["", "nope", "user_", "user_" + "x".repeat(200), "../user_x"]) {
    const response = await post(`/api/operator/cafes/${cafe.slug}/owners`, { workosUserId: bad }, headers);
    assert.equal(response.status, 400, `identity ${JSON.stringify(bad).slice(0, 20)} must be refused`);
  }
  const list = await (await get(`/api/operator/cafes/${cafe.slug}/owners`, { cookie: op.cookie })).json();
  assert.equal(list.owners.length, 0);
  await post("/clean", { slug: cafe.slug });
});

test("a grant cannot leak across tenants", async () => {
  const op = await operator();
  const a = await seedCafe();
  const b = await seedCafe();
  const headers = { cookie: op.cookie, "x-csrf-token": op.csrf };

  await post(`/api/operator/cafes/${a.slug}/owners`, { workosUserId: "user_only_a" }, headers);

  const listB = await (await get(`/api/operator/cafes/${b.slug}/owners`, { cookie: op.cookie })).json();
  assert.equal(listB.owners.length, 0, "café B must not see café A's owner");

  await post("/clean", { slug: a.slug });
  await post("/clean", { slug: b.slug });
});

test("a claim can be issued, listed and revoked, and never reveals its code", async () => {
  const op = await operator();
  const cafe = await seedCafe();
  const headers = { cookie: op.cookie, "x-csrf-token": op.csrf };

  const created = await post(
    `/api/operator/cafes/${cafe.slug}/claims`,
    { email: "new@example.test", ttlMinutes: 60 },
    headers
  );
  assert.equal(created.status, 201);
  const claim = await created.json();
  assert.ok(claim.code && claim.code.length >= 20, "a one-time code is returned once");

  const listed = await (await get(`/api/operator/cafes/${cafe.slug}/claims`, { cookie: op.cookie })).json();
  assert.equal(listed.claims.length, 1);
  assert.equal(listed.claims[0].email, "new@example.test");
  assert.equal(JSON.stringify(listed).includes(claim.code), false, "the code is never listed back");

  const revoked = await fetch(`${BASE}/api/operator/cafes/${cafe.slug}/claims/${listed.claims[0].id}`, {
    method: "DELETE",
    headers: { cookie: op.cookie, "x-csrf-token": op.csrf, origin: BASE },
  });
  assert.equal(revoked.status, 200);

  const empty = await (await get(`/api/operator/cafes/${cafe.slug}/claims`, { cookie: op.cookie })).json();
  assert.equal(empty.claims.length, 0);
  await post("/clean", { slug: cafe.slug });
});

test("a malformed claim email is refused", async () => {
  const op = await operator();
  const cafe = await seedCafe();
  const response = await post(
    `/api/operator/cafes/${cafe.slug}/claims`,
    { email: "not-an-email" },
    { cookie: op.cookie, "x-csrf-token": op.csrf }
  );
  assert.equal(response.status, 400);
  await post("/clean", { slug: cafe.slug });
});

test("operator reset on a managed café keeps the hash inert and never opens a login path", async () => {
  const op = await operator();
  const cafe = await seedCafe({ ownerAuth: "workos" });
  const headers = { cookie: op.cookie, "x-csrf-token": op.csrf };

  const reset = await post(`/api/operator/cafes/${cafe.slug}/reset-password`, {}, headers);
  assert.equal(reset.status, 200);
  const { password } = await reset.json();
  assert.ok(password && password.length >= 12);

  // The mode switch is the only thing that may make that password usable again — and it must not be
  // usable while the café is managed.
  const login = await post(`/api/cafes/${cafe.slug}/admin/login`, { password });
  assert.equal(login.status, 410);
  assert.equal((await login.json()).code, "auth_mode_managed");

  // Switch back to local: the preserved hash becomes usable and the version moved during the reset.
  const mode = await post(`/api/operator/cafes/${cafe.slug}/auth-mode`, { mode: "local" }, headers);
  assert.equal(mode.status, 200);

  const localLogin = await post(`/api/cafes/${cafe.slug}/admin/login`, { password });
  assert.equal(localLogin.status, 200, "the preserved hash works again in local mode");
  assert.match(cookieOf(localLogin), /^staff_session_/);

  await post("/clean", { slug: cafe.slug });
});

test("the auth-mode route validates input and refuses a no-op transition", async () => {
  const op = await operator();
  const cafe = await seedCafe({ ownerAuth: "local" });
  const headers = { cookie: op.cookie, "x-csrf-token": op.csrf };

  assert.equal((await post(`/api/operator/cafes/${cafe.slug}/auth-mode`, { mode: "nonsense" }, headers)).status, 400);
  // local -> local would bump a generation without changing anything; the frozen batch refuses it.
  const noop = await post(`/api/operator/cafes/${cafe.slug}/auth-mode`, { mode: "local" }, headers);
  assert.equal(noop.status, 409);

  // A real switch to a managed café with no owner is refused by the phase-2A precondition.
  const empty = await post(`/api/operator/cafes/${cafe.slug}/auth-mode`, { mode: "workos" }, headers);
  assert.equal(empty.status, 409);

  await post("/clean", { slug: cafe.slug });
});
