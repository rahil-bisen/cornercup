// Migration tests for the reset-password schema. They run the production SCHEMA / MIGRATIONS /
// POST_MIGRATIONS against real SQLite (node:sqlite, in memory) rather than a mock, so a fresh
// database and a genuinely legacy one are both exercised, and both are migrated twice to prove the
// statements are safe to re-run.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS, addColumnTarget, isDuplicateAddColumn } from "../worker/db.js";

function exec(db, sql) {
  try {
    db.exec(sql);
    return null;
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    // Same rule the Worker's migrate() applies: an existing column is the only benign failure.
    if (/duplicate column name/i.test(message)) return "duplicate-column";
    throw err;
  }
}

function runAll(db, list) {
  return list.map((sql) => exec(db, sql));
}

const isAlter = (sql) => /^\s*ALTER TABLE/i.test(sql);
const settle = (list) => list.map((sql) => (isAlter(sql) ? "duplicate-column" : null));

function columns(db, table) {
  return db
    .prepare(`PRAGMA table_info('${table}')`)
    .all()
    .map((row) => row.name);
}

function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

// A database exactly as the single-café build left it: no version column, no change timestamp, no
// reset audit table, and one café plus one order already stored.
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

test("fresh database: reset-password migrations apply, then re-apply cleanly", () => {
  const db = new DatabaseSync(":memory:");

  const first = runAll(db, SCHEMA);
  assert.deepEqual(first, SCHEMA.map(() => null), "the base schema must apply without errors");

  // Some tenant columns already live in the base schema, so their ALTERs are skipped as duplicates;
  // the point of this pass is that nothing throws and the reset columns appear.
  const firstMigrations = runAll(db, MIGRATIONS);
  firstMigrations.forEach((result, index) => {
    assert.ok(
      result === null || result === "duplicate-column",
      `migration ${index} reported ${result}: ${MIGRATIONS[index]}`
    );
  });
  assert.deepEqual(runAll(db, POST_MIGRATIONS), POST_MIGRATIONS.map(() => null));

  const cafeColumns = columns(db, "cafes");
  assert.ok(cafeColumns.includes("auth_version"), "auth_version exists after migration");
  assert.ok(cafeColumns.includes("password_changed_at"), "password_changed_at exists after migration");
  assert.ok(tables(db).includes("password_resets"), "the audit table exists");
  assert.ok(tables(db).includes("csrf_tokens"), "the CSRF table exists");

  // The reset columns live only in the migrations, never in the base schema, so there is one path.
  assert.ok(
    !SCHEMA.some((sql) => sql.includes("auth_version")),
    "the base cafés schema must not declare auth_version too"
  );
  assert.ok(
    !SCHEMA.some((sql) => sql.includes("password_changed_at")),
    "the base cafés schema must not declare password_changed_at too"
  );
  assert.ok(
    MIGRATIONS.some((sql) => sql.includes("ADD COLUMN auth_version")),
    "auth_version ships as a migration"
  );
  assert.ok(
    MIGRATIONS.some((sql) => sql.includes("ADD COLUMN password_changed_at")),
    "password_changed_at ships as a migration"
  );

  // Second pass: every ALTER now meets its column, and every CREATE is a no-op.
  assert.deepEqual(runAll(db, MIGRATIONS), settle(MIGRATIONS), "a second run only skips existing columns");
  assert.deepEqual(runAll(db, POST_MIGRATIONS), POST_MIGRATIONS.map(() => null), "post-migrations are idempotent");

  db.close();
});

test("legacy database: migrations upgrade existing rows in place and are re-runnable", () => {
  const db = new DatabaseSync(":memory:");
  runAll(db, LEGACY_SCHEMA);

  assert.ok(!columns(db, "cafes").includes("auth_version"), "the legacy database starts unversioned");

  const first = runAll(db, MIGRATIONS);
  assert.deepEqual(first, MIGRATIONS.map(() => null), "every migration must apply to the legacy schema");
  runAll(db, POST_MIGRATIONS);

  const cafe = db.prepare("SELECT id, slug, auth_version, password_changed_at FROM cafes").get();
  assert.equal(cafe.slug, "legacy-cafe");
  assert.equal(Number(cafe.auth_version), 1, "existing cafés are adopted as version 1");
  assert.equal(Number(cafe.password_changed_at), 0, "no password change is invented by the migration");

  const order = db.prepare("SELECT id, payment_method, payment_status FROM orders").get();
  assert.equal(order.id, "LEGACY", "existing orders survive the migration");
  assert.equal(order.payment_method, "counter");
  assert.equal(order.payment_status, "unpaid");

  assert.ok(tables(db).includes("password_resets"));
  assert.ok(tables(db).includes("csrf_tokens"));

  assert.deepEqual(runAll(db, MIGRATIONS), settle(MIGRATIONS), "a second run only meets columns it added");
  assert.deepEqual(runAll(db, POST_MIGRATIONS), POST_MIGRATIONS.map(() => null));

  const after = db.prepare("SELECT auth_version, password_changed_at FROM cafes").get();
  assert.equal(Number(after.auth_version), 1, "re-running the migrations changes no row");
  assert.equal(Number(after.password_changed_at), 0);

  // The audit insert an unknown-café rejection needs, with no foreign key to the cafés table.
  db.exec(
    "INSERT INTO password_resets (cafe_id, operator_identity, action, outcome, timestamp) VALUES (NULL, 'operator', 'reset_password', 'unknown_cafe', 1)"
  );
  const audit = db.prepare("SELECT COUNT(*) AS value FROM password_resets WHERE cafe_id IS NULL").get();
  assert.equal(Number(audit.value), 1, "an unknown café can be recorded with no matching café row");

  db.close();
});

test("migration errors: only a duplicate of the very column being added is skipped", () => {
  const sql = "ALTER TABLE cafes ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1";
  assert.deepEqual(addColumnTarget(sql), { table: "cafes", column: "auth_version" });
  assert.equal(addColumnTarget("CREATE INDEX idx ON orders (created_at)"), null);
  assert.equal(addColumnTarget("UPDATE tables SET number = id WHERE number IS NULL"), null);

  // What the driver actually says when the same ALTER runs a second time.
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE cafes (id INTEGER PRIMARY KEY)");
  db.exec(sql);
  let driverMessage = "";
  try {
    db.exec(sql);
  } catch (err) {
    driverMessage = String(err && err.message ? err.message : err);
  }
  db.close();
  assert.match(driverMessage, /duplicate column/i, "the real driver reports a duplicate column");
  assert.equal(isDuplicateAddColumn(sql, driverMessage), true, "the genuine re-run is a skip");
  assert.equal(isDuplicateAddColumn(sql, "duplicate column name"), true, "a name-less duplicate still skips");

  // Everything below is a real failure and must be re-thrown rather than swallowed.
  assert.equal(
    isDuplicateAddColumn(sql, "duplicate column name: password_changed_at"),
    false,
    "a duplicate for a different column is not this statement's skip"
  );
  assert.equal(isDuplicateAddColumn(sql, "no such table: cafes"), false);
  assert.equal(isDuplicateAddColumn(sql, "syntax error near FROM"), false);
  assert.equal(
    isDuplicateAddColumn("UPDATE tables SET number = id WHERE number IS NULL", "duplicate column name: number"),
    false,
    "a non-ALTER statement is never excused"
  );
  assert.equal(
    isDuplicateAddColumn("CREATE TABLE t (a TEXT)", "duplicate column name: a"),
    false,
    "a CREATE is never excused"
  );
  assert.equal(
    isDuplicateAddColumn("ALTER TABLE cafes ADD COLUMN auth_version INTEGER", "duplicate column name: other"),
    false
  );
});
