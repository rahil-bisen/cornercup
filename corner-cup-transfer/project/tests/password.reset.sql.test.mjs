// The exact SQL that a password reset runs, executed against real SQLite. The production statement
// builder is imported rather than copied, so a change to the SQL or to the binding order fails here.
//
// Three properties are checked:
//   1. a reset on the version the caller expects updates the café and writes one audit row;
//   2. an update that matches nothing also writes no audit row (the insert is conditional);
//   3. if the audit insert fails, the password update is rolled back with it (one transaction).

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";
import { passwordResetBatch } from "../worker/api.js";

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
  db.exec(
    "INSERT INTO cafes (slug, name, service_mode) VALUES ('sql-cafe', 'SQL Café', 'counter')"
  );
  return db;
}

// The smallest stand-in for env.DB that the statement builder and batch need.
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
      all() {
        return { results: db.prepare(statement.sql).all(...statement.params) };
      },
      first() {
        const row = db.prepare(statement.sql).get(...statement.params);
        return row === undefined ? null : row;
      },
    };
    return statement;
  };

  return {
    DB: {
      prepare,
      // D1's batch is a transaction: every statement commits together or none does.
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

function cafeRow(db) {
  return db
    .prepare("SELECT id, pass_hash, auth_version, password_changed_at FROM cafes WHERE slug = 'sql-cafe'")
    .get();
}

function successRows(db) {
  return db.prepare("SELECT COUNT(*) AS value FROM password_resets WHERE outcome = 'success'").get();
}

test("reset batch: the audit row exists only when the café update landed", () => {
  const db = freshDatabase();
  const env = makeEnv(db);
  const now = 1_780_000_000_000;

  // Give the café a password and a version, exactly as a previous reset would have left it.
  db.prepare("UPDATE cafes SET pass_hash = 'old-hash', auth_version = 3 WHERE slug = 'sql-cafe'").run();

  const stale = env.DB.batch(
    passwordResetBatch(env, { cafeId: 1, fromVersion: 2, toVersion: 3, passHash: "new-hash", now })
  );
  assert.equal(Number(stale[0].meta.changes), 0, "an unexpected version updates nothing");
  assert.equal(Number(stale[1].meta.changes), 0, "and writes no audit row");
  assert.equal(cafeRow(db).pass_hash, "old-hash", "the password is untouched");
  assert.equal(Number(successRows(db).value), 0);

  const applied = env.DB.batch(
    passwordResetBatch(env, { cafeId: 1, fromVersion: 3, toVersion: 4, passHash: "new-hash", now })
  );
  assert.equal(Number(applied[0].meta.changes), 1, "the expected version updates the café");
  assert.equal(Number(applied[1].meta.changes), 1, "and writes exactly one audit row");

  const row = cafeRow(db);
  assert.equal(row.pass_hash, "new-hash");
  assert.equal(Number(row.auth_version), 4);
  assert.equal(Number(row.password_changed_at), now, "the change timestamp is the batch's own instant");

  const audit = db.prepare("SELECT cafe_id, operator_identity, action, outcome FROM password_resets").all();
  assert.equal(audit.length, 1);
  assert.equal(Number(audit[0].cafe_id), 1, "the audit row keeps the café association");
  assert.equal(audit[0].action, "reset_password");
  assert.equal(audit[0].outcome, "success");
  assert.ok(!("pass_hash" in audit[0]), "no credential is copied into the audit row");

  db.close();
});

test("reset batch: a failing audit insert rolls the password update back", () => {
  const db = freshDatabase();
  const env = makeEnv(db);
  const now = 1_780_000_000_100;

  db.prepare("UPDATE cafes SET pass_hash = 'keep-me', auth_version = 1 WHERE slug = 'sql-cafe'").run();
  // Forces the second statement of the pair to fail, which is the worst case for consistency.
  db.exec(
    "CREATE TRIGGER block_success_audit BEFORE INSERT ON password_resets " +
      "WHEN NEW.outcome = 'success' BEGIN SELECT RAISE(ABORT, 'audit blocked'); END"
  );

  assert.throws(() =>
    env.DB.batch(
      passwordResetBatch(env, { cafeId: 1, fromVersion: 1, toVersion: 2, passHash: "half-written", now })
    )
  );

  const row = cafeRow(db);
  assert.equal(row.pass_hash, "keep-me", "the password change was rolled back");
  assert.equal(Number(row.auth_version), 1, "the version bump was rolled back");
  assert.equal(Number(row.password_changed_at), 0, "the timestamp was rolled back");
  assert.equal(Number(successRows(db).value), 0, "no audit row survived");

  db.close();
});
