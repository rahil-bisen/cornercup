// The exact SQL a café archive, restore and delete run, against real SQLite. The production
// statement builders are imported, so these prove the guards live inside the writes themselves:
// even a caller that skipped every check in the handler could not archive or delete the primary
// café, delete an active café, or reach another café's rows.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";
import {
  archiveStatements,
  deleteStatements,
  isRemovalGuardFailure,
  rateLimitPrefixes,
  restoreStatements,
} from "../worker/cafe-removal.js";

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
  for (const slug of ["primary", "second", "third"]) {
    db.prepare("INSERT INTO cafes (slug, name, service_mode) VALUES (?, ?, 'counter')").run(slug, slug);
  }
  return db;
}

function makeEnv(db) {
  const prepare = (sql) => {
    const statement = {
      sql,
      params: [],
      bind(...params) {
        statement.params = params;
        return statement;
      },
      run() {
        const info = db.prepare(statement.sql).run(...statement.params);
        return { meta: { changes: Number(info.changes || 0) } };
      },
    };
    return statement;
  };
  return {
    DB: {
      prepare,
      batch(statements) {
        db.exec("BEGIN");
        try {
          const results = statements.map((statement) => statement.run());
          db.exec("COMMIT");
          return results;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      },
    },
  };
}

const idOf = (db, slug) => db.prepare("SELECT id FROM cafes WHERE slug = ?").get(slug).id;
const cafe = (db, id) => db.prepare("SELECT id, archived_at, auth_version FROM cafes WHERE id = ?").get(id);
const count = (db, sql, ...binds) => Number(db.prepare(sql).get(...binds).n);
const base = { now: 1000, subject: "operator:abc", detail: "{}" };

function seedRows(db, cafeId) {
  db.prepare("INSERT INTO menu_items (cafe_id, category, name, description, price_cents, emoji, sort) VALUES (?, 'C', 'I', '', 1, '', 1)").run(cafeId);
  db.prepare("INSERT INTO orders (id, cafe_id, table_id, table_label, created_at, updated_at) VALUES (?, ?, 0, 'Counter', 'x', 'x')").run(`O${cafeId}`, cafeId);
  db.prepare("INSERT INTO order_items (order_id, name, price_cents, qty) VALUES (?, 'I', 1, 1)").run(`O${cafeId}`);
  db.prepare("INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, 1, 9999999999999)").run(`s${cafeId}`, cafeId);
  for (const prefix of rateLimitPrefixes(cafeId)) {
    db.prepare("INSERT INTO rate_limits (key, count, window_start, expires, updated_at) VALUES (?, 1, 1, 1, 1)").run(`${prefix}ip`);
  }
}

test("the primary café cannot be archived by the statement itself", () => {
  const db = freshDatabase();
  const env = makeEnv(db);
  const primary = idOf(db, "primary");
  const results = env.DB.batch(archiveStatements(env, { ...base, cafeId: primary }));
  assert.equal(results[0].meta.changes, 0);
  assert.equal(results[1].meta.changes, 0, "no audit row for an archive that did not happen");
  assert.equal(cafe(db, primary).archived_at, null);
  assert.equal(cafe(db, primary).auth_version, 1, "its sessions were not invalidated");
});

test("archive stamps the café, bumps its version and ends only its own sessions", () => {
  const db = freshDatabase();
  const env = makeEnv(db);
  const second = idOf(db, "second");
  const third = idOf(db, "third");
  seedRows(db, second);
  seedRows(db, third);

  env.DB.batch(archiveStatements(env, { ...base, cafeId: second }));
  assert.equal(cafe(db, second).archived_at, 1000);
  assert.equal(cafe(db, second).auth_version, 2);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM owner_sessions WHERE cafe_id = ?", second), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM owner_sessions WHERE cafe_id = ?", third), 1);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM menu_items WHERE cafe_id = ?", second), 1, "data kept");
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM operator_audit WHERE cafe_id = ? AND action = 'archive_cafe'", second), 1);
});

test("delete aborts as a whole for an active café and for the primary café", () => {
  const db = freshDatabase();
  const env = makeEnv(db);
  const primary = idOf(db, "primary");
  const second = idOf(db, "second");
  seedRows(db, primary);
  seedRows(db, second);
  // Even an archived primary (which the archive statement refuses to produce) cannot be deleted.
  db.prepare("UPDATE cafes SET archived_at = 5 WHERE id = ?").run(primary);

  for (const id of [primary, second]) {
    assert.throws(() => env.DB.batch(deleteStatements(env, { ...base, cafeId: id })), (err) => isRemovalGuardFailure(err));
    assert.ok(cafe(db, id), "the café row survived");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM orders WHERE cafe_id = ?", id), 1, "its orders survived");
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM operator_audit WHERE cafe_id = ?", id), 0, "no audit for a refused delete");
  }
});

test("delete of an archived café clears its rows and rate limits and nothing of its neighbours", () => {
  const db = freshDatabase();
  const env = makeEnv(db);
  const second = idOf(db, "second");
  const third = idOf(db, "third");
  seedRows(db, second);
  seedRows(db, third);
  // A key for a café whose id starts with the same digits must not match.
  db.prepare("INSERT INTO rate_limits (key, count, window_start, expires, updated_at) VALUES (?, 1, 1, 1, 1)").run(`login:${second}0:ip`);
  db.prepare("UPDATE cafes SET archived_at = 5 WHERE id = ?").run(second);

  env.DB.batch(deleteStatements(env, { ...base, cafeId: second }));
  assert.equal(cafe(db, second), undefined);
  for (const table of ["menu_items", "orders", "owner_sessions"]) {
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE cafe_id = ?`, second), 0, table);
    assert.equal(count(db, `SELECT COUNT(*) AS n FROM ${table} WHERE cafe_id = ?`, third), 1, `neighbour ${table}`);
  }
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?", `O${second}`), 0);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?", `O${third}`), 1);
  for (const prefix of rateLimitPrefixes(second)) {
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?", `${prefix}ip`), 0, prefix);
  }
  for (const prefix of rateLimitPrefixes(third)) {
    assert.equal(count(db, "SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?", `${prefix}ip`), 1, `neighbour ${prefix}`);
  }
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM rate_limits WHERE key = ?", `login:${second}0:ip`), 1, "prefix does not over-match");
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM operator_audit WHERE cafe_id = ? AND action = 'delete_cafe'", second), 1);
});

test("restore aborts for a café that is not archived and writes no audit row", () => {
  const db = freshDatabase();
  const env = makeEnv(db);
  const second = idOf(db, "second");
  assert.throws(() => env.DB.batch(restoreStatements(env, { ...base, cafeId: second })), (err) => isRemovalGuardFailure(err));
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM operator_audit"), 0);

  db.prepare("UPDATE cafes SET archived_at = 5 WHERE id = ?").run(second);
  env.DB.batch(restoreStatements(env, { ...base, cafeId: second }));
  assert.equal(cafe(db, second).archived_at, null);
  assert.equal(count(db, "SELECT COUNT(*) AS n FROM operator_audit WHERE action = 'restore_cafe'"), 1);
});
