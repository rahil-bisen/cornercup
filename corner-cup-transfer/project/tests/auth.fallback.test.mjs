// F-01 regression suite: the deployment-wide OWNER_PASSWORD / ADMIN_PIN sign-in fallback.
//
// The vulnerability was in login(): for any café whose pass_hash was NULL it compared the entered
// password against `env.OWNER_PASSWORD || env.ADMIN_PIN` in plain text. One shared secret — often a
// 4-digit PIN — therefore opened every café that had never been given a password.
//
// The fix has two halves, both covered here:
//   * sign-in only ever verifies the café's own stored PBKDF2 hash, and refuses (503) without one;
//   * OWNER_PASSWORD may still seed the primary café's hash at startup, once, and only while that
//     hash is NULL, so an upgraded single-café install keeps the password its owner already knows.
//
// The HTTP tests need the auth-enabled harness (tests/harness/wrangler.auth.jsonc on port 8790) and
// skip without it, like the other harness suites. The bootstrap tests need no server: they run the
// production statement against real SQLite, so "a restart never overwrites a password" is always
// exercised. Password *reset* behaviour (old sessions die, new password works) is covered by
// tests/password.reset.test.mjs, which this change keeps green.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { webcrypto } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  SCHEMA,
  MIGRATIONS,
  POST_MIGRATIONS,
  primaryPasswordBootstrapStatement,
  bootstrapOwnerPassword,
  bootstrapPrimaryPassword,
} from "../worker/db.js";
import { hashPassword, verifyPassword } from "../worker/cafes.js";
import { HARNESS_OWNER_PASSWORD, HARNESS_BOOTSTRAP_PASSWORD } from "./harness/credentials.mjs";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const HARNESS = process.env.AUTH_HARNESS_URL || process.env.HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };

let alive = false;
try {
  const probe = await fetch(`${HARNESS}/primary`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: "{}",
    signal: AbortSignal.timeout(1500),
  });
  alive = probe.ok;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not running at ${HARNESS}`;

/* ------------------------------------------------------------------ helpers */

async function post(path, body) {
  return fetch(`${HARNESS}${path}`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(body || {}),
  });
}

async function seed(options = {}) {
  const res = await post("/seed", options);
  assert.equal(res.status, 200, `seed answered ${res.status}`);
  return res.json();
}

async function login(slug, password) {
  return post(`/api/cafes/${slug}/admin/login`, { password });
}

function cookiePair(res) {
  const all = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (all[0] || res.headers.get("set-cookie") || "").split(";")[0];
}

async function sessionStatus(slug, pair) {
  const res = await fetch(`${HARNESS}/api/cafes/${slug}/admin/session`, { headers: { cookie: pair } });
  return res.status;
}

async function cleanup(cafeId) {
  await post("/clean", { cafeId });
}

async function primary() {
  const res = await post("/primary", {});
  assert.equal(res.status, 200, `/primary answered ${res.status}`);
  const { cafe } = await res.json();
  assert.ok(cafe && cafe.slug, "the harness reports its primary café");
  return cafe;
}

/* ------------------------------------------------------- HTTP: the fallback */

// The harness database is disposable. This test asserts the primary café is still on the password its
// bootstrap hash was derived from, so delete the harness persistence directory (or re-seed the
// password) if a manual check ever changed it.
test("the primary café signs in with its bootstrapped hash, and not with ADMIN_PIN", { skip }, async () => {
  const cafe = await primary();
  assert.equal(Number(cafe.has_password), 1, "startup stored a hash for the primary café");

  // ADMIN_PIN is still configured in the harness; it must open nothing (F-01).
  const pin = await login(cafe.slug, "1234");
  assert.equal(pin.status, 401, "a configured ADMIN_PIN no longer signs an owner in");
  assert.equal(cookiePair(pin), "", "and it issues no session");

  // The password the owner already knew before the upgrade still works, because the bootstrap stored
  // a hash of it rather than changing anything about it.
  const ok = await login(cafe.slug, HARNESS_BOOTSTRAP_PASSWORD);
  assert.equal(ok.status, 200, "OWNER_PASSWORD still signs in the primary café, via its own hash");
  const pair = cookiePair(ok);
  assert.match(pair, /^staff_session_/, "a staff session cookie is issued");
  assert.equal(await sessionStatus(cafe.slug, pair), 200, "the session is usable");
});

test("ADMIN_PIN cannot authenticate any café", { skip }, async () => {
  const hashed = await seed();
  const none = await seed({ noPassword: true });
  try {
    const withHash = await login(hashed.slug, "1234");
    assert.equal(withHash.status, 401, "a café with its own hash rejects the PIN");

    const withoutHash = await login(none.slug, "1234");
    assert.equal(withoutHash.status, 503, "a café with no hash fails closed instead of accepting a PIN");
    assert.equal(cookiePair(withoutHash), "", "no session is issued for a passwordless café");
  } finally {
    await cleanup(hashed.cafeId);
    await cleanup(none.cafeId);
  }
});

test("OWNER_PASSWORD cannot authenticate a café with a different or missing hash", { skip }, async () => {
  const other = await seed(); // hashed from HARNESS_OWNER_PASSWORD
  const none = await seed({ noPassword: true });
  try {
    const unrelated = await login(other.slug, HARNESS_BOOTSTRAP_PASSWORD);
    assert.equal(unrelated.status, 401, "the deployment secret is not this café's password");

    const missing = await login(none.slug, HARNESS_BOOTSTRAP_PASSWORD);
    assert.equal(missing.status, 503, "a missing hash fails closed rather than falling back");
    const body = await missing.json();
    assert.match(body.error, /operator/i, "the refusal names the action an operator has to take");
  } finally {
    await cleanup(other.cafeId);
    await cleanup(none.cafeId);
  }
});

test("each café signs in with its own hash, and one café's credentials open no other", { skip }, async () => {
  const a = await seed();
  const b = await seed({ password: "second-cafe-owner-pass" });
  try {
    const aLogin = await login(a.slug, HARNESS_OWNER_PASSWORD);
    assert.equal(aLogin.status, 200, "café A keeps the password it was created with");
    assert.equal(
      await sessionStatus(b.slug, cookiePair(aLogin)),
      401,
      "a café A session is refused by café B"
    );

    const bLogin = await login(b.slug, "second-cafe-owner-pass");
    assert.equal(bLogin.status, 200, "café B keeps its own, different password");

    assert.equal((await login(b.slug, HARNESS_OWNER_PASSWORD)).status, 401, "A's password does not open B");
    assert.equal(
      (await login(a.slug, "second-cafe-owner-pass")).status,
      401,
      "B's password does not open A"
    );
  } finally {
    await cleanup(a.cafeId);
    await cleanup(b.cafeId);
  }
});

test("an unusable stored hash fails closed", { skip }, async () => {
  const broken = await seed({ rawHash: "not-a-pbkdf2-hash" });
  try {
    for (const password of ["1234", "", HARNESS_BOOTSTRAP_PASSWORD]) {
      const res = await login(broken.slug, password);
      assert.equal(res.status, 401, `a corrupt hash rejects ${JSON.stringify(password)}`);
      assert.equal(cookiePair(res), "", "and issues no session");
    }
  } finally {
    await cleanup(broken.cafeId);
  }
});

test("an owner password change still works and revives no fallback", { skip }, async () => {
  const cafe = await seed();
  try {
    const first = await login(cafe.slug, HARNESS_OWNER_PASSWORD);
    assert.equal(first.status, 200, "the café starts on its seeded password");

    const changed = await fetch(`${HARNESS}/api/cafes/${cafe.slug}/admin/settings`, {
      method: "PATCH",
      headers: { ...JSON_HEADERS, cookie: cookiePair(first) },
      body: JSON.stringify({ password: "a-brand-new-owner-pass" }),
    });
    assert.equal(changed.status, 200, "the owner may set their own password");

    assert.equal((await login(cafe.slug, HARNESS_OWNER_PASSWORD)).status, 401, "the old password stops working");
    assert.equal(
      (await login(cafe.slug, HARNESS_BOOTSTRAP_PASSWORD)).status,
      401,
      "the deployment secret still cannot sign in"
    );
    assert.equal((await login(cafe.slug, "a-brand-new-owner-pass")).status, 200, "the new password works");
  } finally {
    await cleanup(cafe.cafeId);
  }
});

/* -------------------------------------------------- static: no fallback left */

test("no sign-in path reads ADMIN_PIN or OWNER_PASSWORD", async () => {
  const api = await readFile(new URL("../worker/api.js", import.meta.url), "utf8");
  assert.ok(!/ADMIN_PIN/.test(api), "the API does not mention ADMIN_PIN at all");
  assert.ok(!/OWNER_PASSWORD/.test(api), "login() never compares against OWNER_PASSWORD");

  const db = await readFile(new URL("../worker/db.js", import.meta.url), "utf8");
  assert.match(db, /env\.OWNER_PASSWORD/, "the bootstrap is the one place that reads it");
  const bootstrap = db.slice(
    db.indexOf("primaryPasswordBootstrapStatement"),
    db.indexOf("async function bootstrapPrimaryPassword")
  );
  assert.match(bootstrap, /AND pass_hash IS NULL/, "the seed can only ever fill an empty hash");
});

/* ------------------------------------------------- SQL: the guarded bootstrap */

function freshDatabase() {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err.message || err))) throw err;
    }
  }
  for (const sql of POST_MIGRATIONS) db.exec(sql);
  return db;
}

// The production statement, executed through the smallest stand-in for env.DB it needs.
function seedHash(db, passHash, cafeId = 1) {
  const env = {
    DB: {
      prepare(sql) {
        return {
          bind: (...params) => ({
            run: () => ({
              meta: { changes: Number(db.prepare(sql).run(...params).changes || 0) },
            }),
          }),
        };
      },
    },
  };
  return Number(primaryPasswordBootstrapStatement(env, { cafeId, passHash }).run().meta.changes);
}

test("the bootstrap fills only a NULL hash and never overwrites one", async () => {
  const db = freshDatabase();
  db.exec("INSERT INTO cafes (id, slug, name, pass_hash) VALUES (1, 'primary', 'Primary', NULL)");
  const stored = () => db.prepare("SELECT pass_hash FROM cafes WHERE id = 1").get().pass_hash;

  const first = await hashPassword(HARNESS_BOOTSTRAP_PASSWORD);
  assert.equal(seedHash(db, first), 1, "a café with no hash is seeded");
  assert.equal(stored(), first, "the derived hash is stored");
  assert.ok(await verifyPassword(HARNESS_BOOTSTRAP_PASSWORD, stored()), "and it verifies");

  // A Worker restart re-derives the same password with a fresh salt: different string, no write.
  const again = await hashPassword(HARNESS_BOOTSTRAP_PASSWORD);
  assert.notEqual(again, first, "a second derivation produces a different hash string");
  assert.equal(seedHash(db, again), 0, "an existing hash is left alone");
  assert.equal(stored(), first, "the stored hash survives the restart unchanged");

  // An owner who has since chosen their own password keeps it too, even if OWNER_PASSWORD changes.
  assert.equal(seedHash(db, await hashPassword("a-rotated-shared-secret")), 0, "no overwrite after a change");
  assert.equal(stored(), first, "still the first hash");
  assert.ok(!(await verifyPassword("a-rotated-shared-secret", stored())), "the new secret was not applied");
});

test("the bootstrap seeds only the café it names, never another tenant", async () => {
  const db = freshDatabase();
  db.exec("INSERT INTO cafes (id, slug, name, pass_hash) VALUES (1, 'primary', 'Primary', NULL)");
  db.exec("INSERT INTO cafes (id, slug, name, pass_hash) VALUES (2, 'second', 'Second', NULL)");

  assert.equal(seedHash(db, await hashPassword(HARNESS_BOOTSTRAP_PASSWORD), 1), 1);
  const second = db.prepare("SELECT pass_hash FROM cafes WHERE id = 2").get().pass_hash;
  assert.equal(second, null, "another passwordless café is not handed the shared secret");
});

/* --------------------------------------- the bootstrap password policy gate */

// Records every statement the bootstrap tries to run, so a test can prove that a value the app
// would reject never reaches the database at all.
function recordingEnv(ownerPassword) {
  const writes = [];
  const env = {
    OWNER_PASSWORD: ownerPassword,
    DB: {
      prepare(sql) {
        return {
          bind: (...params) => ({
            run: () => {
              writes.push({ sql, params });
              return { meta: { changes: 1 } };
            },
          }),
        };
      },
    },
  };
  return { env, writes };
}

const VALID_BOOTSTRAP = "harness-bootstrap-password";

test("a missing, short or oversized OWNER_PASSWORD seeds no hash", async () => {
  for (const ownerPassword of [undefined, "", "   ", "12345678901", "x".repeat(101)]) {
    const { env, writes } = recordingEnv(ownerPassword);
    await bootstrapPrimaryPassword(env, { id: 1, pass_hash: null });
    assert.equal(
      writes.length,
      0,
      `no hash is written for ${JSON.stringify(ownerPassword)?.slice(0, 20)}`
    );
  }

  // The same 12–100 window as createCafe, an owner change and an operator reset.
  assert.equal(bootstrapOwnerPassword({}), null, "missing");
  assert.equal(bootstrapOwnerPassword({ OWNER_PASSWORD: "" }), null, "empty");
  assert.equal(bootstrapOwnerPassword({ OWNER_PASSWORD: "   " }), null, "whitespace only");
  assert.equal(bootstrapOwnerPassword({ OWNER_PASSWORD: "12345678901" }), null, "11 characters");
  assert.equal(bootstrapOwnerPassword({ OWNER_PASSWORD: "  short  " }), null, "trimmed first");
  assert.equal(bootstrapOwnerPassword({ OWNER_PASSWORD: "x".repeat(101) }), null, "over the maximum");
  assert.equal(bootstrapOwnerPassword({ OWNER_PASSWORD: "twelve-chars" }), "twelve-chars", "12 is allowed");
  assert.equal(
    bootstrapOwnerPassword({ OWNER_PASSWORD: `  ${"a".repeat(12)}  ` }),
    "a".repeat(12),
    "surrounding whitespace is trimmed, as sign-in trims the typed value"
  );
});

test("a valid OWNER_PASSWORD is hashed once, through the guarded statement", async () => {
  const { env, writes } = recordingEnv(VALID_BOOTSTRAP);
  await bootstrapPrimaryPassword(env, { id: 1, pass_hash: null });

  assert.equal(writes.length, 1, "exactly one write");
  assert.match(writes[0].sql, /AND pass_hash IS NULL/, "the overwrite guard travels with the write");
  assert.equal(writes[0].params[1], 1, "it targets the primary café");
  assert.match(writes[0].params[0], /^pbkdf2\$/, "stored in the normal hash format");
  assert.ok(await verifyPassword(VALID_BOOTSTRAP, writes[0].params[0]), "the hash verifies the password");
  assert.ok(!(await verifyPassword("something-else", writes[0].params[0])), "and nothing else");
});

test("an existing hash blocks the bootstrap even with a valid OWNER_PASSWORD", async () => {
  const { env, writes } = recordingEnv(VALID_BOOTSTRAP);
  await bootstrapPrimaryPassword(env, { id: 1, pass_hash: "pbkdf2$100000$c2FsdA==$aGFzaA==" });
  assert.equal(writes.length, 0, "the owner's own hash is never touched");
});
