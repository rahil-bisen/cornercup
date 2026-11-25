// F-07 phase 2A. The auth-mode transition is a credential change, so it must be atomic: the mode,
// its generation, its transition record, its audit row, and the invalidation of every owner session
// and outstanding sign-in state commit together or not at all.
//
// D1's batch() commits every statement that does not itself fail, and a statement matching zero rows
// is not a failure — so atomicity is enforced in SQL (a per-attempt CAS token plus a CHECK-guarded
// abort) rather than by inspecting results. These tests run the production SCHEMA, MIGRATIONS and
// POST_MIGRATIONS and the production statement list, and prove that every failed transition leaves
// all six affected tables byte-identical.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";
import {
  AUTH_MODE_TRANSITION_SQL,
  authModeTransition,
  isAuthModeTransitionConflict,
  newCasToken,
} from "../worker/authmode.js";

function exec(db, sql) {
  try {
    db.exec(sql);
    return null;
  } catch (err) {
    const message = String(err && err.message ? err.message : err);
    if (/duplicate column name/i.test(message)) return "duplicate-column";
    throw err;
  }
}

const runAll = (db, list) => list.map((sql) => exec(db, sql));

// The whole production migration path, so the tables under test are the ones that ship.
function migratedDatabase() {
  const db = new DatabaseSync(":memory:");
  runAll(db, SCHEMA);
  runAll(db, MIGRATIONS);
  runAll(db, POST_MIGRATIONS);
  return db;
}

const CAFE = 1;
const OTHER = 2;

function seed(db) {
  db.prepare(
    "INSERT INTO cafes (id, slug, name, service_mode, owner_auth, auth_mode_generation) " +
      "VALUES (?, ?, ?, 'counter', 'local', 0)"
  ).run(CAFE, "atomic-one", "Atomic One");
  db.prepare(
    "INSERT INTO cafes (id, slug, name, service_mode, owner_auth, auth_mode_generation) " +
      "VALUES (?, ?, ?, 'counter', 'local', 0)"
  ).run(OTHER, "atomic-two", "Atomic Two");

  db.prepare(
    "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, 'user_p2a', 'owner', 1)"
  ).run(CAFE);

  db.prepare(
    "INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, 1, 9000000000000)"
  ).run("a".repeat(32), CAFE);
  db.prepare(
    "INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, 1, 9000000000000)"
  ).run("b".repeat(32), CAFE);
  db.prepare(
    "INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, 1, 9000000000000)"
  ).run("c".repeat(32), OTHER);

  for (const nonce of ["live-1", "live-2"]) {
    db.prepare(
      "INSERT INTO owner_login_states (nonce_hash, cafe_id, created, expires, used_at) VALUES (?, ?, 1, 9000000000000, NULL)"
    ).run(nonce, CAFE);
  }
  db.prepare(
    "INSERT INTO owner_login_states (nonce_hash, cafe_id, created, expires, used_at) VALUES ('spent', ?, 1, 9000000000000, 500)"
  ).run(CAFE);
  db.prepare(
    "INSERT INTO owner_login_states (nonce_hash, cafe_id, created, expires, used_at) VALUES ('other-live', ?, 1, 9000000000000, NULL)"
  ).run(OTHER);
}

// Every table the batch can touch, for both tenants, in a stable order. Comparing this before and
// after is the proof that a failed batch changed nothing.
function snapshot(db) {
  const rows = (sql, ...params) => db.prepare(sql).all(...params);
  return JSON.stringify({
    cafes: rows(
      "SELECT id, owner_auth, auth_mode_generation, auth_mode_cas_token FROM cafes ORDER BY id"
    ),
    owners: rows("SELECT cafe_id, workos_user_id, role FROM cafe_owners ORDER BY cafe_id"),
    sessions: rows("SELECT session_id, cafe_id FROM owner_sessions ORDER BY session_id"),
    states: rows("SELECT nonce_hash, cafe_id, used_at FROM owner_login_states ORDER BY nonce_hash"),
    transitions: rows(
      "SELECT cafe_id, generation, from_mode, to_mode FROM auth_mode_transitions ORDER BY cafe_id, generation"
    ),
    audit: rows("SELECT cafe_id, action, subject, detail FROM operator_audit ORDER BY id"),
    guard: rows("SELECT ok FROM tx_guard"),
  });
}

// Executes the production steps in one transaction, exactly as D1 would run them in one batch.
function runTransition(db, plan) {
  db.exec("BEGIN");
  try {
    for (const step of plan.steps) {
      db.prepare(step.sql).run(...step.params);
    }
    db.exec("COMMIT");
    return null;
  } catch (err) {
    db.exec("ROLLBACK");
    return String(err && err.message ? err.message : err);
  }
}

function attempt(db, params) {
  return runTransition(
    db,
    authModeTransition({ operatorSubject: "operator-session-1", now: 1000, ...params })
  );
}

// A legitimate transition, used to build the states the stale cases need.
function advance(db, from, to, generation) {
  const error = attempt(db, { cafeId: CAFE, oldMode: from, newMode: to, generation });
  assert.equal(error, null, `seed transition ${from}->${to} must succeed`);
}

// node:sqlite returns rows with a null prototype; comparisons against object literals need plain
// objects, otherwise deepEqual fails on the prototype rather than on the data.
const plain = (row) => (row ? { ...row } : row);
const plainAll = (rows) => rows.map((row) => ({ ...row }));

function cafe(db) {
  return plain(
    db.prepare("SELECT owner_auth, auth_mode_generation, auth_mode_cas_token FROM cafes WHERE id = ?").get(CAFE)
  );
}

test("F-07 phase 2A: the production statement list is the nine statements, in order", () => {
  assert.deepEqual(
    AUTH_MODE_TRANSITION_SQL.map((step) => step.step),
    [
      "cas",
      "owner-precondition",
      "cas-witness",
      "transition",
      "audit",
      "sessions",
      "states",
      "clear-token",
      "guard-clear",
    ]
  );

  // The schema the tests rely on comes from the migrations, not from a local copy.
  const db = migratedDatabase();
  const columns = db
    .prepare("PRAGMA table_info('cafes')")
    .all()
    .map((row) => row.name);
  assert.ok(columns.includes("auth_mode_generation"));
  assert.ok(columns.includes("auth_mode_cas_token"));
  for (const table of ["auth_mode_transitions", "operator_audit", "tx_guard"]) {
    assert.ok(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
      `${table} exists after migration`
    );
  }
  assert.ok(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get("cafes_auth_mode_generation_step"),
    "the generation-step trigger exists after migration"
  );
  db.close();
});

test("F-07 phase 2A: a fresh CAS token is 128 bits, never repeated, and never supplied by a caller", () => {
  const tokens = new Set();
  for (let i = 0; i < 500; i += 1) {
    const token = newCasToken();
    assert.match(token, /^[0-9a-f]{32}$/);
    assert.equal(tokens.has(token), false, "tokens must not repeat");
    tokens.add(token);
  }

  const params = { cafeId: CAFE, oldMode: "local", newMode: "workos", generation: 0 };
  const first = authModeTransition({ ...params, operatorSubject: "op", now: 1 });
  const second = authModeTransition({ ...params, operatorSubject: "op", now: 1 });
  assert.notEqual(first.token, second.token, "two attempts never share a token");

  // A caller-supplied token cannot be smuggled in.
  const forced = authModeTransition({ ...params, operatorSubject: "op", now: 1, token: "0".repeat(32) });
  assert.notEqual(forced.token, "0".repeat(32));
});

test("F-07 phase 2A: a successful transition commits once and clears the CAS token", () => {
  const db = migratedDatabase();
  seed(db);

  const error = attempt(db, { cafeId: CAFE, oldMode: "local", newMode: "workos", generation: 0 });
  assert.equal(error, null);

  assert.deepEqual(cafe(db), { owner_auth: "workos", auth_mode_generation: 1, auth_mode_cas_token: null });

  const transitions = plainAll(
    db.prepare("SELECT cafe_id, generation, from_mode, to_mode FROM auth_mode_transitions").all()
  );
  assert.deepEqual(transitions, [{ cafe_id: CAFE, generation: 1, from_mode: "local", to_mode: "workos" }]);

  const audit = plainAll(db.prepare("SELECT cafe_id, action, subject, detail FROM operator_audit").all());
  assert.deepEqual(audit, [
    { cafe_id: CAFE, action: "switch_auth_mode", subject: "operator-session-1", detail: "local->workos" },
  ]);

  // This café's sessions and live states are gone; the already-used state and the other tenant stay.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM owner_sessions WHERE cafe_id = ?").get(CAFE).c, 0);
  const states = plainAll(
    db.prepare("SELECT nonce_hash, used_at FROM owner_login_states WHERE cafe_id = ? ORDER BY nonce_hash").all(CAFE)
  );
  assert.deepEqual(states, [{ nonce_hash: "spent", used_at: 500 }]);

  // The other tenant is untouched.
  assert.equal(db.prepare("SELECT owner_auth FROM cafes WHERE id = ?").get(OTHER).owner_auth, "local");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM owner_sessions WHERE cafe_id = ?").get(OTHER).c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM owner_login_states WHERE cafe_id = ?").get(OTHER).c, 1);

  // The guard table is empty, and stays empty.
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tx_guard").get().c, 0);

  db.close();
});

test("F-07 phase 2A: a stale generation aborts and changes nothing", () => {
  const db = migratedDatabase();
  seed(db);
  advance(db, "local", "workos", 0);
  const before = snapshot(db);

  const error = attempt(db, { cafeId: CAFE, oldMode: "local", newMode: "workos", generation: 0 });
  assert.ok(error, "the batch must fail");
  assert.match(error, /constraint failed/i);
  assert.ok(isAuthModeTransitionConflict({ message: error }));

  assert.equal(snapshot(db), before, "every table is unchanged");
  db.close();
});

test("F-07 phase 2A: A to B to A, then a stale retry, aborts and changes nothing", () => {
  const db = migratedDatabase();
  seed(db);
  advance(db, "local", "workos", 0);
  advance(db, "workos", "local", 1);
  const before = snapshot(db);

  // The generation key (1) is already spent, even though the mode is back to what the caller expects.
  const error = attempt(db, { cafeId: CAFE, oldMode: "local", newMode: "workos", generation: 0 });
  assert.ok(error);
  assert.equal(snapshot(db), before);
  db.close();
});

test("F-07 phase 2A: a wrong expected mode with a current generation aborts and changes nothing", () => {
  const db = migratedDatabase();
  seed(db);
  const before = snapshot(db);

  // Generation is current (0) but the café is in `local`, not the `workos` this caller expects. The
  // generation witness alone could not see this; the per-attempt CAS token does.
  const error = attempt(db, { cafeId: CAFE, oldMode: "workos", newMode: "local", generation: 0 });
  assert.ok(error, "the batch must fail");
  assert.match(error, /constraint failed/i);

  assert.equal(snapshot(db), before);
  assert.deepEqual(cafe(db), { owner_auth: "local", auth_mode_generation: 0, auth_mode_cas_token: null });
  db.close();
});

test("F-07 phase 2A: switching a zero-owner café to managed aborts and changes nothing", () => {
  const db = migratedDatabase();
  seed(db);
  db.prepare("DELETE FROM cafe_owners WHERE cafe_id = ?").run(CAFE);
  const before = snapshot(db);

  const error = attempt(db, { cafeId: CAFE, oldMode: "local", newMode: "workos", generation: 0 });
  assert.ok(error, "the batch must fail");
  assert.match(error, /constraint failed/i);

  assert.equal(snapshot(db), before, "sessions and states survive a refused transition");
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM owner_sessions WHERE cafe_id = ?").get(CAFE).c, 2);
  assert.equal(
    db.prepare("SELECT COUNT(*) AS c FROM owner_login_states WHERE cafe_id = ? AND used_at IS NULL").get(CAFE).c,
    2
  );
  db.close();
});

test("F-07 phase 2A: zero owners and a stale generation at once aborts and changes nothing", () => {
  const db = migratedDatabase();
  seed(db);
  advance(db, "local", "workos", 0);
  db.prepare("DELETE FROM cafe_owners WHERE cafe_id = ?").run(CAFE);
  const before = snapshot(db);

  const error = attempt(db, { cafeId: CAFE, oldMode: "local", newMode: "workos", generation: 0 });
  assert.ok(error);
  assert.equal(snapshot(db), before);
  db.close();
});

test("F-07 phase 2A: a no-op transition is refused in SQL", () => {
  const db = migratedDatabase();
  seed(db);
  const before = snapshot(db);

  const error = attempt(db, { cafeId: CAFE, oldMode: "local", newMode: "local", generation: 0 });
  assert.ok(error, "local -> local must not bump the generation");
  assert.equal(snapshot(db), before);
  db.close();
});

test("F-07 phase 2A: workos to local succeeds and revokes this café's sessions", () => {
  const db = migratedDatabase();
  seed(db);
  advance(db, "local", "workos", 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM owner_sessions WHERE cafe_id = ?").get(CAFE).c, 0);

  const error = attempt(db, { cafeId: CAFE, oldMode: "workos", newMode: "local", generation: 1 });
  assert.equal(error, null);
  assert.deepEqual(cafe(db), { owner_auth: "local", auth_mode_generation: 2, auth_mode_cas_token: null });
  assert.deepEqual(
    plainAll(db.prepare("SELECT generation, from_mode, to_mode FROM auth_mode_transitions ORDER BY generation").all()),
    [
      { generation: 1, from_mode: "local", to_mode: "workos" },
      { generation: 2, from_mode: "workos", to_mode: "local" },
    ]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM operator_audit").get().c, 2);
  db.close();
});

test("F-07 phase 2A: the generation trigger refuses a jump that would skip a transition", () => {
  const db = migratedDatabase();
  seed(db);

  assert.throws(
    () => db.prepare("UPDATE cafes SET auth_mode_generation = 5 WHERE id = ?").run(CAFE),
    /generation_must_step_by_one/
  );

  // A same-value write is also a step of zero, which the trigger refuses.
  db.prepare("UPDATE cafes SET auth_mode_generation = 1, auth_mode_cas_token = 'x' WHERE id = ?").run(CAFE);
  assert.throws(
    () => db.prepare("UPDATE cafes SET auth_mode_generation = 1 WHERE id = ?").run(CAFE),
    /generation_must_step_by_one/
  );
  db.close();
});

test("F-07 phase 2A: a database that predates the change upgrades in place, and re-applying is a no-op", () => {
  const PHASE_2A_SQL = /auth_mode_generation|auth_mode_cas_token|auth_mode_transitions|operator_audit|tx_guard|cafes_auth_mode_generation_step/;
  const PHASE_2A_INDEXES = /idx_auth_mode_transitions_created|idx_operator_audit_cafe/;

  const older = MIGRATIONS.filter((sql) => !PHASE_2A_SQL.test(sql));
  const added = MIGRATIONS.filter((sql) => PHASE_2A_SQL.test(sql));
  const olderIndexes = POST_MIGRATIONS.filter((sql) => !PHASE_2A_INDEXES.test(sql));
  const addedIndexes = POST_MIGRATIONS.filter((sql) => PHASE_2A_INDEXES.test(sql));

  assert.equal(added.length, 6, "the phase-2A statements are selected out of the production array");
  assert.equal(addedIndexes.length, 2);

  // Exactly the shape that is deployed today: everything before this change, plus live data.
  const db = new DatabaseSync(":memory:");
  runAll(db, SCHEMA);
  runAll(db, older);
  runAll(db, olderIndexes);

  db.prepare("INSERT INTO cafes (id, slug, name, service_mode) VALUES (?, 'older', 'Older', 'counter')").run(CAFE);
  db.prepare("INSERT INTO cafes (id, slug, name, service_mode) VALUES (?, 'older-2', 'Older Two', 'counter')").run(OTHER);
  db.prepare("INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, 'user_p2a', 'owner', 1)").run(CAFE);
  db.prepare("INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, 1, 9000000000000)").run("d".repeat(32), CAFE);
  db.prepare("INSERT INTO owner_login_states (nonce_hash, cafe_id, created, expires, used_at) VALUES ('live', ?, 1, 9000000000000, NULL)").run(CAFE);

  assert.equal(
    db.prepare("PRAGMA table_info('cafes')").all().some((row) => row.name === "auth_mode_generation"),
    false,
    "the fixture genuinely predates the change"
  );

  assert.deepEqual(runAll(db, added), added.map(() => null), "every phase-2A statement applies to an existing database");
  assert.deepEqual(runAll(db, addedIndexes), addedIndexes.map(() => null));

  // Existing data is preserved, and every café starts on the password flow at generation zero.
  assert.deepEqual(cafe(db), { owner_auth: "local", auth_mode_generation: 0, auth_mode_cas_token: null });
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM owner_sessions").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM owner_login_states").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM cafe_owners").get().c, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM auth_mode_transitions").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM operator_audit").get().c, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS c FROM tx_guard").get().c, 0);

  // A second boot only meets columns it added; the CREATEs and the trigger are IF NOT EXISTS.
  const before = snapshot(db);
  const again = runAll(db, added);
  assert.equal(again.filter((result) => result === "duplicate-column").length, 2);
  assert.equal(again.filter((result) => result === null).length, 4);
  assert.deepEqual(runAll(db, addedIndexes), addedIndexes.map(() => null));
  assert.equal(snapshot(db), before, "re-applying changes nothing");

  db.close();
});

test("F-07 phase 2A: validation refuses unknown modes and malformed identifiers before any SQL", () => {
  const good = { cafeId: 1, oldMode: "local", newMode: "workos", generation: 0, operatorSubject: "op" };
  assert.throws(() => authModeTransition({ ...good, newMode: "WorkOS" }), /newMode must be one of/);
  assert.throws(() => authModeTransition({ ...good, newMode: "saml" }), /newMode must be one of/);
  assert.throws(() => authModeTransition({ ...good, oldMode: "" }), /oldMode must be one of/);
  assert.throws(() => authModeTransition({ ...good, cafeId: 0 }), /cafeId must be an integer/);
  assert.throws(() => authModeTransition({ ...good, generation: -1 }), /generation must be an integer/);
  assert.throws(() => authModeTransition({ ...good, operatorSubject: "" }), /operatorSubject is required/);
});
