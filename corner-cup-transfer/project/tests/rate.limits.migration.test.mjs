import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";

function runAll(db, list) {
  return list.map((sql) => {
    try {
      db.exec(sql);
      return null;
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      if (/duplicate column name/i.test(message)) return "duplicate-column";
      throw err;
    }
  });
}

function tables(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
}

function columns(db, table) {
  return db.prepare(`PRAGMA table_info('${table}')`).all().map((row) => row.name);
}

test("rate_limits table is created additively and is idempotent", () => {
  const db = new DatabaseSync(":memory:");
  assert.deepEqual(runAll(db, SCHEMA), SCHEMA.map(() => null));

  const first = runAll(db, MIGRATIONS);
  first.forEach((result, index) => {
    assert.ok(
      result === null || result === "duplicate-column",
      `migration ${index} reported ${result}`
    );
  });
  assert.deepEqual(runAll(db, POST_MIGRATIONS), POST_MIGRATIONS.map(() => null));

  assert.ok(tables(db).includes("rate_limits"), "rate_limits table exists");
  const cols = columns(db, "rate_limits");
  for (const col of ["key", "count", "window_start", "expires", "updated_at"]) {
    assert.ok(cols.includes(col), `rate_limits has ${col}`);
  }

  assert.deepEqual(runAll(db, POST_MIGRATIONS), POST_MIGRATIONS.map(() => null));

  db.close();
});
