// F-07 phase 1. The owner-identity schema is additive: it adds three tables and three columns and
// changes no existing row. These tests run the production SCHEMA / MIGRATIONS / POST_MIGRATIONS
// arrays against real SQLite (node:sqlite, in memory) from three starting points — a fresh database,
// the schema as it is deployed today, and the pre-F-10 legacy schema — and then migrate a second time
// to prove a reboot is a no-op that cannot reset a mode an operator already chose.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";
import { cafeSettings, publicCafe } from "../worker/cafes.js";

function exec(db, sql) {
  try {
    db.exec(sql);
    return null;
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    // The same rule the Worker's migrate() applies: an existing column is the only benign failure.
    if (/duplicate column name/i.test(message)) return "duplicate-column";
    throw err;
  }
}

const runAll = (db, list) => list.map((sql) => exec(db, sql));
const isAlter = (sql) => /^\s*ALTER TABLE/i.test(sql);
const settle = (list) => list.map((sql) => (isAlter(sql) ? "duplicate-column" : null));

const columns = (db, table) =>
  db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => row.name);

const column = (db, table, name) =>
  db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .find((row) => row.name === name);

const tables = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);

const indexes = (db) =>
  db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
    .all()
    .map((row) => row.name);

const count = (db, sql, ...params) => Number(db.prepare(sql).get(...params).value);

// The phase-1 statements, selected out of the production arrays so the "deployed today" fixture can
// be built by running everything that came before them. Nothing in this file re-implements the SQL;
// it only splits the list the Worker actually runs.
const PHASE_1_PATTERNS = [
  /ADD COLUMN owner_auth/,
  /CREATE TABLE IF NOT EXISTS owner_identities/,
  /CREATE TABLE IF NOT EXISTS cafe_owners/,
  /CREATE TABLE IF NOT EXISTS owner_login_states/,
  /ADD COLUMN workos_user_id/,
  /ADD COLUMN workos_session_id/,
];

// Phase 2B adds to the same two arrays. Those statements assume the phase-1 tables already exist, so
// they must be excluded from the "deployed today" fixture as well, or the fixture would try to alter
// a table it has deliberately not created yet.
const PHASE_2B_PATTERNS = [
  /ADD COLUMN code_verifier_enc/,
  /ADD COLUMN claim_hash/,
  /ADD COLUMN return_to/,
  /CREATE TABLE IF NOT EXISTS owner_claims/,
  /CREATE TABLE IF NOT EXISTS provider_revocations/,
  /ADD COLUMN auth_version_cas_token/,
];
const PHASE_2B_MIGRATIONS = MIGRATIONS.filter((sql) =>
  PHASE_2B_PATTERNS.some((pattern) => pattern.test(sql))
);

const PHASE_1_MIGRATIONS = MIGRATIONS.filter((sql) =>
  PHASE_1_PATTERNS.some((pattern) => pattern.test(sql))
);
const PRE_PHASE_1_MIGRATIONS = MIGRATIONS.filter(
  (sql) => !PHASE_1_MIGRATIONS.includes(sql) && !PHASE_2B_MIGRATIONS.includes(sql)
);

const PHASE_1_POST_PATTERNS = [
  /idx_owner_identities_email/,
  /idx_cafe_owners_identity/,
  /idx_owner_login_states_expires/,
  /idx_owner_sessions_identity/,
];

const PHASE_2B_POST_PATTERNS = [/idx_owner_claims_/, /idx_provider_revocations_due/];
const PHASE_2B_POST = POST_MIGRATIONS.filter((sql) =>
  PHASE_2B_POST_PATTERNS.some((pattern) => pattern.test(sql))
);

const PHASE_1_POST = POST_MIGRATIONS.filter((sql) =>
  PHASE_1_POST_PATTERNS.some((pattern) => pattern.test(sql))
);
const PRE_PHASE_1_POST = POST_MIGRATIONS.filter(
  (sql) => !PHASE_1_POST.includes(sql) && !PHASE_2B_POST.includes(sql)
);

const NEW_TABLES = ["owner_identities", "cafe_owners", "owner_login_states"];
const NEW_INDEXES = [
  "idx_owner_identities_email",
  "idx_cafe_owners_identity",
  "idx_owner_login_states_expires",
  "idx_owner_sessions_identity",
];

// A database exactly as the single-café build left it: no tenant columns, no auth_version, no
// sessions, one café whose owner signs in with the legacy PBKDF2 hash, and one order.
const LEGACY_SCHEMA = [
  "CREATE TABLE cafes (id INTEGER PRIMARY KEY AUTOINCREMENT, slug TEXT NOT NULL UNIQUE, name TEXT NOT NULL, service_mode TEXT NOT NULL DEFAULT 'tables', tz_offset_min INTEGER NOT NULL DEFAULT 330, contact_phone TEXT NOT NULL DEFAULT '', contact_email TEXT NOT NULL DEFAULT '', contact_address TEXT NOT NULL DEFAULT '', pass_hash TEXT)",
  "CREATE TABLE tables (id INTEGER PRIMARY KEY, label TEXT NOT NULL, seats INTEGER NOT NULL DEFAULT 2)",
  "CREATE TABLE menu_items (id INTEGER PRIMARY KEY AUTOINCREMENT, category TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL, emoji TEXT NOT NULL DEFAULT '🍽️', available INTEGER NOT NULL DEFAULT 1, sort INTEGER NOT NULL DEFAULT 0)",
  "CREATE TABLE orders (id TEXT PRIMARY KEY, table_id INTEGER NOT NULL, table_label TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'new', total_cents INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "CREATE TABLE order_items (id INTEGER PRIMARY KEY AUTOINCREMENT, order_id TEXT NOT NULL, menu_item_id INTEGER, name TEXT NOT NULL, emoji TEXT NOT NULL DEFAULT '', price_cents INTEGER NOT NULL, qty INTEGER NOT NULL)",
  "CREATE TABLE checkout_claims (id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id INTEGER NOT NULL, idempotency_key TEXT NOT NULL, fingerprint TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'claimed', lease TEXT NOT NULL DEFAULT '', order_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)",
  "INSERT INTO cafes (slug, name, pass_hash) VALUES ('legacy-cafe', 'Legacy Café', 'pbkdf2$100000$c2FsdA==$aGFzaA==')",
  "INSERT INTO orders (id, table_id, table_label, created_at, updated_at) VALUES ('LEGACY', 1, 'Table 1', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')",
];

// A realistic stored credential, so "the hash is byte-identical afterwards" is a meaningful claim.
const ARGON2_HASH =
  "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA==$dGFndGFndGFndGFndGFndGFndGFndGFndGFn";

// Everything up to and including F-10, i.e. the schema this deploy actually meets in production.
function deployedDatabase() {
  const db = new DatabaseSync(":memory:");
  runAll(db, SCHEMA);
  runAll(db, PRE_PHASE_1_MIGRATIONS);
  runAll(db, PRE_PHASE_1_POST);
  return db;
}

test("F-07 phase 1: the fixture split really contains the six additive statements", () => {
  assert.ok(
    PHASE_1_MIGRATIONS.length >= 6,
    `expected at least 6 phase-1 migrations, found ${PHASE_1_MIGRATIONS.length}`
  );
  for (const pattern of PHASE_1_PATTERNS) {
    assert.ok(
      PHASE_1_MIGRATIONS.some((sql) => pattern.test(sql)),
      `${pattern} must ship as a migration, not in the base schema`
    );
  }
  assert.equal(PHASE_1_POST.length, NEW_INDEXES.length, "every proposed index ships as a migration");

  // The columns live only in the migrations, so a fresh and a legacy database take the same path.
  assert.equal(
    SCHEMA.some((sql) => /owner_auth|owner_identities|cafe_owners|owner_login_states/.test(sql)),
    false,
    "the base schema must not declare the identity tables or columns"
  );
});

test("F-07 phase 1: a fresh database gets the identity schema and nothing else changes", () => {
  const db = new DatabaseSync(":memory:");

  assert.deepEqual(runAll(db, SCHEMA), SCHEMA.map(() => null), "the base schema must apply cleanly");
  const migrated = runAll(db, MIGRATIONS);
  migrated.forEach((result, index) => {
    assert.ok(
      result === null || result === "duplicate-column",
      `migration ${index} reported ${result}: ${MIGRATIONS[index]}`
    );
  });
  assert.deepEqual(runAll(db, POST_MIGRATIONS), POST_MIGRATIONS.map(() => null));

  for (const table of NEW_TABLES) {
    assert.ok(tables(db).includes(table), `${table} exists after migration`);
  }
  for (const index of NEW_INDEXES) {
    assert.ok(indexes(db).includes(index), `${index} exists after migration`);
  }

  // `owner_auth` must default to the password flow rather than to the managed one.
  const ownerAuth = column(db, "cafes", "owner_auth");
  assert.ok(ownerAuth, "cafes.owner_auth exists");
  assert.equal(Number(ownerAuth.notnull), 1, "owner_auth is NOT NULL");
  assert.match(String(ownerAuth.dflt_value), /local/, "owner_auth defaults to local");

  // The two identity columns are appended and nullable, so every existing INSERT still works.
  assert.deepEqual(columns(db, "owner_sessions"), [
    "session_id",
    "cafe_id",
    "created",
    "expires",
    "workos_user_id",
    "workos_session_id",
  ]);
  for (const name of ["workos_user_id", "workos_session_id"]) {
    assert.equal(Number(column(db, "owner_sessions", name).notnull), 0, `${name} is nullable`);
  }

  assert.deepEqual(columns(db, "owner_identities"), [
    "workos_user_id",
    "email",
    "created",
    "last_seen",
  ]);
  assert.deepEqual(columns(db, "cafe_owners"), [
    "cafe_id",
    "workos_user_id",
    "role",
    "created",
  ]);
  // The four phase-1 columns, plus the three phase-2B additions. Every addition is nullable, so the
  // phase-1 INSERTs continue to work unchanged.
  assert.deepEqual(columns(db, "owner_login_states"), [
    "nonce_hash",
    "cafe_id",
    "created",
    "expires",
    "used_at",
    "code_verifier_enc",
    "claim_hash",
    "return_to",
  ]);
  for (const name of ["code_verifier_enc", "claim_hash", "return_to"]) {
    assert.equal(Number(column(db, "owner_login_states", name).notnull), 0, `${name} is nullable`);
  }
  assert.equal(
    String(column(db, "cafe_owners", "role").dflt_value),
    "'owner'",
    "a membership defaults to the owner role"
  );

  // No foreign keys: the rest of the schema has none, and no café is ever deleted by this code.
  for (const table of NEW_TABLES) {
    assert.deepEqual(
      db.prepare(`PRAGMA foreign_key_list('${table}')`).all(),
      [],
      `${table} must not introduce a foreign key`
    );
  }

  // The composite primary key is the duplicate rule, so it has to be a real unique index.
  const identityUnique = db
    .prepare("PRAGMA index_list('cafe_owners')")
    .all()
    .filter((row) => Number(row.unique) === 1);
  assert.ok(identityUnique.length >= 1, "cafe_owners is uniquely keyed");
  const keyed = db
    .prepare(`PRAGMA index_info('${identityUnique[0].name}')`)
    .all()
    .map((row) => row.name);
  assert.deepEqual(keyed, ["cafe_id", "workos_user_id"], "membership is keyed by café and identity");

  db.close();
});

test("F-07 phase 1: a deployed database upgrades in place without touching a hash, version or session", () => {
  const db = deployedDatabase();

  // The fixture must genuinely be the deployed shape, or the test proves nothing.
  assert.ok(!columns(db, "cafes").includes("owner_auth"), "the fixture starts without owner_auth");
  assert.deepEqual(columns(db, "owner_sessions"), ["session_id", "cafe_id", "created", "expires"]);
  assert.equal(tables(db).includes("cafe_owners"), false);

  db.prepare(
    "INSERT INTO cafes (slug, name, pass_hash, auth_version, password_changed_at) VALUES (?, ?, ?, ?, ?)"
  ).run("live-cafe", "Live Café", ARGON2_HASH, 7, 1700000000000);
  const cafeId = Number(db.prepare("SELECT id FROM cafes WHERE slug = ?").get("live-cafe").id);

  const now = Date.now();
  const firstSession = "a".repeat(32);
  const secondSession = "b".repeat(32);
  db.prepare("INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, ?, ?)").run(
    firstSession,
    cafeId,
    now,
    now + 12 * 60 * 60 * 1000
  );
  db.prepare("INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, ?, ?)").run(
    secondSession,
    cafeId,
    now - 1000,
    now + 1000
  );
  db.prepare(
    "INSERT INTO rate_limits (key, count, window_start, expires, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(`login:${cafeId}:deadbeef`, 3, now, now + 60000, now);

  // Only the phase-1 statements run, against a database that already holds live rows.
  assert.deepEqual(
    runAll(db, PHASE_1_MIGRATIONS),
    PHASE_1_MIGRATIONS.map(() => null),
    "every phase-1 statement applies to the deployed schema"
  );
  assert.deepEqual(runAll(db, PHASE_1_POST), PHASE_1_POST.map(() => null));

  const cafe = db.prepare("SELECT * FROM cafes WHERE id = ?").get(cafeId);
  assert.equal(cafe.pass_hash, ARGON2_HASH, "the stored hash is byte-identical afterwards");
  assert.equal(Number(cafe.auth_version), 7, "auth_version is not reset by the migration");
  assert.equal(Number(cafe.password_changed_at), 1700000000000, "the change timestamp is untouched");
  assert.equal(cafe.owner_auth, "local", "an existing café keeps password sign-in");

  const sessions = db
    .prepare(
      "SELECT session_id, created, expires, workos_user_id, workos_session_id FROM owner_sessions WHERE cafe_id = ? ORDER BY session_id"
    )
    .all(cafeId);
  assert.equal(sessions.length, 2, "both live sessions survive");
  assert.deepEqual(
    sessions.map((row) => row.session_id),
    [firstSession, secondSession]
  );
  assert.equal(Number(sessions[0].created), now);
  assert.equal(Number(sessions[0].expires), now + 12 * 60 * 60 * 1000);
  assert.equal(Number(sessions[1].created), now - 1000);
  assert.equal(Number(sessions[1].expires), now + 1000);
  for (const session of sessions) {
    assert.equal(session.workos_user_id, null, "a password session has no identity");
    assert.equal(session.workos_session_id, null);
  }

  // Nothing is backfilled: migration is a schema change, not an identity import.
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM owner_identities"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM cafe_owners"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM owner_login_states"), 0);

  db.close();
});

test("F-07 phase 1: the legacy schema upgrades in place and keeps its password", () => {
  const db = new DatabaseSync(":memory:");
  runAll(db, LEGACY_SCHEMA);

  assert.deepEqual(runAll(db, MIGRATIONS), MIGRATIONS.map(() => null), "every migration applies");
  assert.deepEqual(runAll(db, POST_MIGRATIONS), POST_MIGRATIONS.map(() => null));

  const cafe = db.prepare("SELECT id, slug, pass_hash, auth_version, password_changed_at, owner_auth FROM cafes").get();
  assert.equal(cafe.slug, "legacy-cafe");
  assert.equal(cafe.pass_hash, "pbkdf2$100000$c2FsdA==$aGFzaA==", "the legacy hash is preserved");
  assert.equal(Number(cafe.auth_version), 1, "existing cafés are adopted as version 1");
  assert.equal(Number(cafe.password_changed_at), 0, "no password change is invented");
  assert.equal(cafe.owner_auth, "local", "the legacy café stays on the password flow");

  for (const table of NEW_TABLES) {
    assert.ok(tables(db).includes(table), `${table} is created for a legacy database`);
  }
  assert.deepEqual(columns(db, "owner_sessions"), [
    "session_id",
    "cafe_id",
    "created",
    "expires",
    "workos_user_id",
    "workos_session_id",
  ]);

  assert.equal(db.prepare("SELECT id FROM orders").get().id, "LEGACY", "existing orders survive");
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM owner_identities"), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM cafes"), 1, "no café is added or removed");

  db.close();
});

test("F-07 phase 1: a second boot is a no-op and never resets a chosen mode", () => {
  const db = new DatabaseSync(":memory:");
  runAll(db, SCHEMA);
  runAll(db, MIGRATIONS);
  runAll(db, POST_MIGRATIONS);

  db.prepare("INSERT INTO cafes (slug, name) VALUES (?, ?)").run("pilot-cafe", "Pilot Café");
  const cafeId = Number(db.prepare("SELECT id FROM cafes WHERE slug = ?").get("pilot-cafe").id);
  db.prepare("UPDATE cafes SET owner_auth = ? WHERE id = ?").run("workos", cafeId);
  db.prepare(
    "INSERT INTO owner_identities (workos_user_id, email, created, last_seen) VALUES (?, ?, ?, ?)"
  ).run("user_01ABC", "owner@example.com", 1, 1);
  db.prepare(
    "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, ?, ?, ?)"
  ).run(cafeId, "user_01ABC", "owner", 1);
  db.prepare(
    "INSERT INTO owner_sessions (session_id, cafe_id, created, expires, workos_user_id, workos_session_id) VALUES (?, ?, ?, ?, ?, ?)"
  ).run("c".repeat(32), cafeId, 1, 2, "user_01ABC", "session_01XYZ");

  // The exact arrays a restart runs.
  assert.deepEqual(runAll(db, MIGRATIONS), settle(MIGRATIONS), "a re-run only meets columns it added");
  assert.deepEqual(
    runAll(db, POST_MIGRATIONS),
    POST_MIGRATIONS.map(() => null),
    "post-migrations are idempotent"
  );

  assert.equal(
    db.prepare("SELECT owner_auth FROM cafes WHERE id = ?").get(cafeId).owner_auth,
    "workos",
    "re-running the migration must not reset the chosen mode to the column default"
  );
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM owner_identities"), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM cafe_owners"), 1);
  assert.equal(
    db.prepare("SELECT workos_user_id FROM owner_sessions WHERE session_id = ?").get("c".repeat(32))
      .workos_user_id,
    "user_01ABC",
    "a managed session keeps its identity across a reboot"
  );

  // A third pass must behave identically; nothing is accumulating.
  assert.deepEqual(runAll(db, MIGRATIONS), settle(MIGRATIONS));
  assert.deepEqual(runAll(db, POST_MIGRATIONS), POST_MIGRATIONS.map(() => null));

  db.close();
});

test("F-07 phase 1: duplicates are refused, and an idempotent grant is harmless", () => {
  const db = new DatabaseSync(":memory:");
  runAll(db, SCHEMA);
  runAll(db, MIGRATIONS);
  runAll(db, POST_MIGRATIONS);

  db.prepare("INSERT INTO cafes (slug, name) VALUES (?, ?), (?, ?)").run("a", "A", "b", "B");
  const [a, b] = db
    .prepare("SELECT id FROM cafes ORDER BY id")
    .all()
    .map((row) => Number(row.id));

  const grant = db.prepare(
    "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING"
  );
  assert.equal(grant.run(a, "user_01ABC", "owner", 1).changes, 1);
  assert.equal(grant.run(a, "user_01ABC", "owner", 2).changes, 0, "a repeated grant is a no-op");
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM cafe_owners"), 1);

  // Without the clause the composite primary key is what refuses it.
  assert.throws(
    () =>
      db
        .prepare("INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, ?, ?, ?)")
        .run(a, "user_01ABC", "owner", 3),
    /UNIQUE constraint failed/i
  );

  // One identity, several cafés: the same key is unique only within a café.
  assert.equal(grant.run(b, "user_01ABC", "owner", 4).changes, 1);
  // Several identities, one café.
  assert.equal(grant.run(a, "user_02DEF", "owner", 5).changes, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM cafe_owners"), 3);

  // Revoking is a plain delete, and re-granting afterwards works.
  db.prepare("DELETE FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?").run(a, "user_02DEF");
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM cafe_owners"), 2);
  assert.equal(grant.run(a, "user_02DEF", "owner", 6).changes, 1);

  // Identity upsert: keyed by the provider id, so a changed email updates the cache rather than
  // creating a second person.
  const upsert = db.prepare(
    "INSERT INTO owner_identities (workos_user_id, email, created, last_seen) VALUES (?, ?, ?, ?) " +
      "ON CONFLICT(workos_user_id) DO UPDATE SET email = excluded.email, last_seen = excluded.last_seen"
  );
  assert.equal(upsert.run("user_01ABC", "old@example.com", 1, 1).changes, 1);
  assert.equal(upsert.run("user_01ABC", "new@example.com", 2, 2).changes, 1);
  assert.equal(count(db, "SELECT COUNT(*) AS value FROM owner_identities"), 1);
  assert.equal(
    db.prepare("SELECT email FROM owner_identities WHERE workos_user_id = ?").get("user_01ABC").email,
    "new@example.com"
  );

  // A membership grant carries no foreign key, so a café id that does not exist is storable. That is
  // the documented trade-off; the gate resolves the café first and treats the row as unreachable.
  assert.equal(grant.run(9999, "user_03GHI", "owner", 7).changes, 1);
  assert.deepEqual(db.prepare("PRAGMA foreign_key_list('cafe_owners')").all(), []);

  db.close();
});

test("F-07 phase 1: a login state can be redeemed exactly once", () => {
  const db = new DatabaseSync(":memory:");
  runAll(db, SCHEMA);
  runAll(db, MIGRATIONS);
  runAll(db, POST_MIGRATIONS);

  db.prepare("INSERT INTO cafes (slug, name) VALUES (?, ?)").run("state-cafe", "State Café");
  const cafeId = Number(db.prepare("SELECT id FROM cafes WHERE slug = ?").get("state-cafe").id);
  const now = Date.now();

  // One conditional UPDATE is the whole single-use mechanism: no read-then-write window.
  const consume = db.prepare(
    "UPDATE owner_login_states SET used_at = ? " +
      "WHERE nonce_hash = ? AND cafe_id = ? AND used_at IS NULL AND expires > ?"
  );
  const insert = db.prepare(
    "INSERT INTO owner_login_states (nonce_hash, cafe_id, created, expires, used_at) VALUES (?, ?, ?, ?, NULL)"
  );

  insert.run("hash-live", cafeId, now, now + 10 * 60 * 1000);
  assert.equal(consume.run(now, "hash-live", cafeId, now).changes, 1, "the first redemption wins");
  assert.equal(consume.run(now, "hash-live", cafeId, now).changes, 0, "a replay wins nothing");

  insert.run("hash-expired", cafeId, now - 700000, now - 1000);
  assert.equal(consume.run(now, "hash-expired", cafeId, now).changes, 0, "an expired state is refused");

  // A state for one café cannot be redeemed against another.
  insert.run("hash-scoped", cafeId, now, now + 60000);
  assert.equal(consume.run(now, "hash-scoped", cafeId + 1, now).changes, 0);
  assert.equal(consume.run(now, "hash-scoped", cafeId, now).changes, 1);

  db.close();
});

test("F-07 phase 1: no serializer emits an identity, membership or mode field", () => {
  // A café row as the code now reads it: every column, including the new one and the credential.
  const row = {
    id: 4,
    slug: "cafe-x",
    name: "Café X",
    service_mode: "counter",
    tz_offset_min: 330,
    contact_phone: "+91 90000 00000",
    contact_email: "owner@example.com",
    contact_address: "12 Main Road",
    pass_hash: ARGON2_HASH,
    auth_version: 3,
    password_changed_at: 1700000000000,
    owner_auth: "workos",
  };

  const pub = publicCafe(row);
  assert.deepEqual(Object.keys(pub).sort(), ["name", "serviceMode", "slug"]);

  const settings = cafeSettings(row);
  assert.deepEqual(Object.keys(settings).sort(), [
    "cafeName",
    "contactAddress",
    "contactEmail",
    "contactPhone",
    "serviceMode",
    "typicalWaitMin",
    "tzOffsetMin",
  ]);

  const FORBIDDEN = [
    "owner_auth",
    "ownerAuth",
    "workos",
    "pass_hash",
    "passHash",
    "auth_version",
    "authVersion",
    "password_changed_at",
  ];

  for (const [name, payload] of [
    ["publicCafe", pub],
    ["cafeSettings", settings],
  ]) {
    const text = JSON.stringify(payload);
    for (const marker of FORBIDDEN) {
      assert.equal(text.includes(marker), false, `${name} must not contain ${marker}`);
    }
  }

  // A missing mode on an old row must not turn into a field either.
  const legacy = publicCafe({ slug: "old", name: "Old", service_mode: "tables" });
  assert.deepEqual(Object.keys(legacy).sort(), ["name", "serviceMode", "slug"]);
});
