// migrate() runs on every fresh Worker isolate before any request is served. On the live D1 database each
// statement is a network round trip, and the old loop made about 77 of them on an up-to-date schema (each
// ADD COLUMN failed as a duplicate and was then double-checked), which measured ~15 s of wall time on a
// cold isolate. These tests pin the cheaper behaviour without changing the outcome: the same schema, the
// same error rules, and a handful of round trips once the database is current.
//
// The D1 binding is modelled over node:sqlite: prepare/bind/run/all/first and a transactional batch, with
// every call to the database counted as one round trip.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, SCHEMA, addColumnTarget, migrate } from "../worker/db.js";

function fakeD1(db) {
  const log = { roundTrips: 0, statements: [] };
  const statement = (sql, args = []) => ({
    sql,
    bind: (...values) => statement(sql, values),
    exec() {
      log.statements.push(sql);
      const prepared = db.prepare(sql);
      return /^\s*(SELECT|PRAGMA)/i.test(sql) ? { results: prepared.all(...args) } : (prepared.run(...args), { results: [] });
    },
    async run() {
      log.roundTrips += 1;
      return this.exec();
    },
    async all() {
      log.roundTrips += 1;
      return this.exec();
    },
    async first() {
      log.roundTrips += 1;
      return (this.exec().results || [])[0] || null;
    },
  });
  return {
    log,
    DB: {
      prepare: (sql) => statement(sql),
      async batch(list) {
        log.roundTrips += 1;
        db.exec("BEGIN");
        try {
          const out = list.map((s) => s.exec());
          db.exec("COMMIT");
          return out;
        } catch (err) {
          db.exec("ROLLBACK");
          throw err;
        }
      },
    },
  };
}

function freshSchema() {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  return db;
}

function schemaOf(db) {
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()) {
    out[name] = db.prepare(`PRAGMA table_info('${name}')`).all().map((c) => `${c.name} ${c.type} ${c.notnull} ${c.dflt_value}`);
  }
  out.__triggers = db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name").all().map((r) => r.name);
  return out;
}

// The reference outcome: every statement applied one by one, duplicates of the column being added ignored.
function referenceSchema() {
  const db = freshSchema();
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!(addColumnTarget(sql) && /duplicate column/i.test(String(err.message)))) throw err;
    }
  }
  return schemaOf(db);
}

test("a fresh database ends with exactly the schema the statement-by-statement loop produced", async () => {
  const db = freshSchema();
  const env = fakeD1(db);
  await migrate(env);
  assert.deepEqual(schemaOf(db), referenceSchema());
});

test("an up-to-date database is checked in a few round trips and no ADD COLUMN is attempted", async () => {
  const db = freshSchema();
  await migrate(fakeD1(db));

  const env = fakeD1(db);
  await migrate(env);
  assert.ok(env.log.roundTrips <= 3, `round trips on a current schema: ${env.log.roundTrips}`);
  assert.equal(env.log.statements.filter((sql) => addColumnTarget(sql)).length, 0, "no ALTER was sent");
  assert.deepEqual(schemaOf(db), referenceSchema(), "and nothing changed");
});

test("a database missing one column gets exactly that column added", async () => {
  const db = freshSchema();
  await migrate(fakeD1(db));
  // Rebuild menu_items without image_updated_at, as a database from before that release would be.
  db.exec("ALTER TABLE menu_items DROP COLUMN image_updated_at");

  const env = fakeD1(db);
  await migrate(env);
  const alters = env.log.statements.filter((sql) => addColumnTarget(sql));
  assert.deepEqual(alters, ["ALTER TABLE menu_items ADD COLUMN image_updated_at TEXT"]);
  assert.deepEqual(schemaOf(db), referenceSchema());
});

test("a real migration failure still stops startup", async () => {
  const db = freshSchema();
  // orders missing entirely: its ADD COLUMN statements cannot be a harmless duplicate.
  db.exec("DROP TABLE orders");
  await assert.rejects(() => migrate(fakeD1(db)), /no such table/i);
});

test("if the column read fails, every statement is still applied the old, careful way", async () => {
  const db = freshSchema();
  const env = fakeD1(db);
  const batch = env.DB.batch;
  let first = true;
  env.DB.batch = async (list) => {
    // Fail only the first batch, which is the column read.
    if (first) {
      first = false;
      throw new Error("D1 batch unavailable");
    }
    return batch(list);
  };
  await migrate(env);
  assert.deepEqual(schemaOf(db), referenceSchema());
});
