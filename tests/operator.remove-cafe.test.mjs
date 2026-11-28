// Removing a café from the operator console: archive, restore and permanent delete, over the real
// Worker HTTP surface (auth harness, 8790). Operator login, CSRF, Origin, the route table, D1, the
// audit table and the fake R2 are all exercised as a browser would reach them.
import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const OPERATOR_PASSWORD = "operator-test-password";
import { HARNESS_OWNER_PASSWORD as OWNER_PASSWORD } from "./harness/credentials.mjs";

const send = (method, path, body, headers = {}) =>
  fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: BASE, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const post = (path, body, headers) => send("POST", path, body ?? {}, headers);
const get = (path, headers = {}) => fetch(`${BASE}${path}`, { headers: { origin: BASE, ...headers } });
const cookieOf = (response) => String(response.headers.get("set-cookie") || "").split(";")[0];

async function operator() {
  const response = await post("/api/operator/login", { password: OPERATOR_PASSWORD });
  assert.equal(response.status, 200, "operator login must succeed");
  const body = await response.json();
  return { cookie: cookieOf(response), csrf: body.csrfToken, headers: { cookie: cookieOf(response), "x-csrf-token": body.csrfToken } };
}

async function seedCafe(extra = {}) {
  const response = await post("/seed", { serviceMode: "counter", ...extra });
  assert.equal(response.status, 200);
  return response.json();
}

const footprint = async (cafe, extra = {}) =>
  (await post("/footprint", { cafeId: cafe.cafeId, tag: cafe.tag, ...extra })).json();

const archive = (op, slug, confirmSlug = slug, headers = op.headers) =>
  post(`/api/operator/cafes/${slug}/archive`, { confirmSlug }, headers);
const restore = (op, slug, confirmSlug = slug) =>
  post(`/api/operator/cafes/${slug}/restore`, { confirmSlug }, op.headers);
const destroy = (op, slug, body = { confirmSlug: slug, confirmDelete: `delete ${slug}` }, headers = op.headers) =>
  send("DELETE", `/api/operator/cafes/${slug}`, body, headers);

async function ownerLogin(slug) {
  return post(`/api/cafes/${slug}/admin/login`, { password: OWNER_PASSWORD });
}

async function placeOrder(cafe) {
  return fetch(`${BASE}/api/cafes/${cafe.slug}/orders`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE, "Idempotency-Key": crypto.randomUUID() },
    body: JSON.stringify({ items: [{ itemId: cafe.itemId, qty: 1 }], paymentMethod: "counter" }),
  });
}

test("archive, restore and delete need an operator session", async () => {
  const cafe = await seedCafe();
  for (const response of [
    await post(`/api/operator/cafes/${cafe.slug}/archive`, { confirmSlug: cafe.slug }),
    await post(`/api/operator/cafes/${cafe.slug}/restore`, { confirmSlug: cafe.slug }),
    await send("DELETE", `/api/operator/cafes/${cafe.slug}`, { confirmSlug: cafe.slug, confirmDelete: `delete ${cafe.slug}` }),
  ]) {
    assert.equal(response.status, 401);
  }
  const state = await footprint(cafe);
  assert.equal(state.cafe.archived_at, null, "nothing was archived");
  await post("/clean", { slug: cafe.slug });
});

test("archive without a CSRF token, or from another origin, is refused and changes nothing", async () => {
  const op = await operator();
  const cafe = await seedCafe();

  assert.equal((await archive(op, cafe.slug, cafe.slug, { cookie: op.cookie })).status, 403, "no CSRF token");
  assert.equal(
    (await archive(op, cafe.slug, cafe.slug, { ...op.headers, origin: "https://evil.example" })).status,
    403,
    "wrong Origin"
  );
  const state = await footprint(cafe);
  assert.equal(state.cafe.archived_at, null);
  assert.deepEqual(state.audit, []);
  await post("/clean", { slug: cafe.slug });
});

test("archive needs the exact typed slug, and an unknown slug is a 404", async () => {
  const op = await operator();
  const cafe = await seedCafe();

  const wrong = await archive(op, cafe.slug, "not-the-slug");
  assert.equal(wrong.status, 400);
  assert.equal((await wrong.json()).code, "confirm_slug");
  assert.equal((await archive(op, cafe.slug, "")).status, 400);
  assert.equal((await archive(op, "no-such-cafe-here", "no-such-cafe-here")).status, 404);

  assert.equal((await footprint(cafe)).cafe.archived_at, null);
  await post("/clean", { slug: cafe.slug });
});

test("an archived café is hidden: guest pages 404, no orders, no owner sign-in, sessions end", async () => {
  const op = await operator();
  const cafe = await seedCafe();

  const login = await ownerLogin(cafe.slug);
  assert.equal(login.status, 200, "owner can sign in before the archive");
  const ownerCookie = cookieOf(login);
  assert.equal((await get(`/api/cafes/${cafe.slug}/admin/session`, { cookie: ownerCookie })).status, 200);

  const archived = await archive(op, cafe.slug);
  assert.equal(archived.status, 200);

  assert.equal((await get(`/api/cafes/${cafe.slug}/menu`)).status, 404, "menu");
  assert.equal((await get(`/api/cafes/${cafe.slug}/config`)).status, 404, "config");
  assert.equal((await placeOrder(cafe)).status, 404, "a guest cannot order");
  assert.equal((await ownerLogin(cafe.slug)).status, 404, "the owner cannot sign in");
  assert.equal((await get(`/api/cafes/${cafe.slug}/admin/session`, { cookie: ownerCookie })).status, 404, "old session is dead");

  const state = await footprint(cafe);
  assert.ok(state.cafe.archived_at > 0, "archived_at is set");
  assert.equal(state.byCafe.owner_sessions, 0, "session rows are gone");
  assert.equal(state.byCafe.menu_items, 1, "data is kept");

  // Hidden from the operator's main list, shown under archived.
  const list = await (await get("/api/operator/cafes", { cookie: op.cookie })).json();
  assert.ok(!list.cafes.some((c) => c.slug === cafe.slug));
  assert.ok(list.archived.some((c) => c.slug === cafe.slug));

  // Archiving twice is a clear conflict, not a second record.
  const again = await archive(op, cafe.slug);
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, "already_archived");

  const audit = (await footprint(cafe)).audit;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].action, "archive_cafe");
  assert.match(audit[0].subject, /^operator:[0-9a-f]{12}$/);
  const detail = JSON.parse(audit[0].detail);
  assert.equal(detail.slug, cafe.slug);
  assert.ok(!audit[0].detail.includes(op.csrf) && !audit[0].detail.includes(op.cookie.split("=")[1]), "no secrets");
  await post("/clean", { slug: cafe.slug });
});

test("an old owner session cannot reach an archived café even after restore", async () => {
  const op = await operator();
  const cafe = await seedCafe();
  const ownerCookie = cookieOf(await ownerLogin(cafe.slug));

  assert.equal((await archive(op, cafe.slug)).status, 200);
  assert.equal((await restore(op, cafe.slug)).status, 200);
  assert.equal((await get(`/api/cafes/${cafe.slug}/admin/session`, { cookie: ownerCookie })).status, 401);
  await post("/clean", { slug: cafe.slug });
});

test("restore brings the café back with its data, and is audited", async () => {
  const op = await operator();
  const cafe = await seedCafe();

  const notArchived = await restore(op, cafe.slug);
  assert.equal(notArchived.status, 409, "an active café cannot be restored");

  assert.equal((await archive(op, cafe.slug)).status, 200);
  assert.equal((await restore(op, cafe.slug, "wrong")).status, 400, "typed slug required");
  assert.equal((await restore(op, cafe.slug)).status, 200);

  assert.equal((await get(`/api/cafes/${cafe.slug}/menu`)).status, 200);
  assert.equal((await placeOrder(cafe)).status, 201, "guests can order again");
  assert.equal((await ownerLogin(cafe.slug)).status, 200, "the owner can sign in again");

  const list = await (await get("/api/operator/cafes", { cookie: op.cookie })).json();
  assert.ok(list.cafes.some((c) => c.slug === cafe.slug));
  assert.ok(!list.archived.some((c) => c.slug === cafe.slug));

  const actions = (await footprint(cafe)).audit.map((row) => row.action);
  assert.deepEqual(actions, ["archive_cafe", "restore_cafe"]);
  await post("/clean", { slug: cafe.slug });
});

test("delete refuses an active café, a missing confirmation and a wrong phrase", async () => {
  const op = await operator();
  const cafe = await seedCafe();

  const active = await destroy(op, cafe.slug);
  assert.equal(active.status, 409);
  assert.equal((await active.json()).code, "not_archived");

  assert.equal((await archive(op, cafe.slug)).status, 200);
  const noPhrase = await destroy(op, cafe.slug, { confirmSlug: cafe.slug });
  assert.equal(noPhrase.status, 400);
  assert.equal((await noPhrase.json()).code, "confirm_delete");
  assert.equal((await destroy(op, cafe.slug, { confirmSlug: cafe.slug, confirmDelete: "delete" })).status, 400);
  assert.equal((await destroy(op, cafe.slug, { confirmSlug: "x", confirmDelete: `delete ${cafe.slug}` })).status, 400);
  assert.equal((await destroy(op, cafe.slug, undefined, { cookie: op.cookie })).status, 403, "CSRF required");

  assert.ok((await footprint(cafe)).cafe, "the café is still there");
  await post("/clean", { slug: cafe.slug });
});

test("delete removes only that café's data and photos, and keeps the audit record", async () => {
  const op = await operator();
  const target = await seedCafe({ serviceMode: "tables" });
  const bystander = await seedCafe({ serviceMode: "tables" });
  target.tag = `t${Date.now().toString(36)}`;
  bystander.tag = `b${Date.now().toString(36)}`;
  const targetSeed = await (await post("/footprint/seed", { cafeId: target.cafeId, tag: target.tag })).json();
  const bystanderSeed = await (await post("/footprint/seed", { cafeId: bystander.cafeId, tag: bystander.tag })).json();

  const before = await footprint(target, { imageKey: targetSeed.imageKey });
  for (const [table, n] of Object.entries(before.byCafe)) {
    assert.ok(n > 0, `the seed put a row in ${table}`);
  }

  assert.equal((await archive(op, target.slug)).status, 200);
  const deleted = await destroy(op, target.slug);
  assert.equal(deleted.status, 200);
  assert.equal((await deleted.json()).photosLeft, 0);

  const after = await footprint(target, { imageKey: targetSeed.imageKey });
  assert.equal(after.cafe, null, "the café row is gone");
  for (const [table, n] of Object.entries(after.byCafe)) {
    assert.equal(n, 0, `${table} was cleared`);
  }
  assert.equal(after.image, false, "the photo is gone from R2");
  assert.equal(after.identities.only, 0, "an identity used only here is removed");
  assert.equal(after.identities.shared, 1, "an identity that owns another café stays");
  assert.deepEqual(after.audit.map((row) => row.action), ["archive_cafe", "delete_cafe"], "the record outlives the café");
  assert.equal(JSON.parse(after.audit[1].detail).slug, target.slug);

  const other = await footprint(bystander, { imageKey: bystanderSeed.imageKey });
  assert.ok(other.cafe, "the other café is untouched");
  for (const [table, n] of Object.entries(other.byCafe)) {
    assert.equal(n, before.byCafe[table], `the other café still has its ${table}`);
  }
  assert.equal(other.image, true, "the other café's photo stays");
  assert.equal(other.identities.only, 1);
  assert.equal((await get(`/api/cafes/${bystander.slug}/menu`)).status, 200);

  const list = await (await get("/api/operator/cafes", { cookie: op.cookie })).json();
  assert.ok(![...list.cafes, ...list.archived].some((c) => c.slug === target.slug));

  await post("/clean", { slug: bystander.slug });
  await post("/clean", { cafeId: target.cafeId });
});

test("the primary café cannot be archived or deleted, and is flagged in the list", async () => {
  const op = await operator();
  const { cafe: primary } = await (await post("/primary", {})).json();
  assert.ok(primary, "the harness has a primary café");

  const archived = await archive(op, primary.slug);
  assert.equal(archived.status, 409);
  assert.equal((await archived.json()).code, "primary_cafe");
  const deleted = await destroy(op, primary.slug);
  assert.equal(deleted.status, 409);
  assert.equal((await deleted.json()).code, "primary_cafe");

  assert.equal((await get(`/api/cafes/${primary.slug}/menu`)).status, 200, "still open");
  const list = await (await get("/api/operator/cafes", { cookie: op.cookie })).json();
  assert.equal(list.cafes.find((c) => c.slug === primary.slug).primary, true);
  assert.ok(list.cafes.filter((c) => c.primary).length === 1);
});

test("an archived café keeps its web address: a new café cannot take the slug", async () => {
  const op = await operator();
  const cafe = await seedCafe();
  assert.equal((await archive(op, cafe.slug)).status, 200);

  const created = await post(
    "/api/operator/cafes",
    { name: "Slug Thief", slug: cafe.slug, password: "a-long-enough-password", serviceMode: "counter" },
    op.headers
  );
  assert.equal(created.status, 400);
  await post("/clean", { slug: cafe.slug });
});
