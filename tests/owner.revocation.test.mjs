// F-07 phase 2B: sign-out hygiene and the composed mode-switch batch.
//
// These run the production functions against a real SQLite database through a D1-shaped shim, so the
// SQL, the bindings and the transaction ordering are the ones that ship. The provider is absent: a
// queue insert is a database fact, and whether a revoke call succeeds is a separate, mock-tested path.
import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";
import { authModeTransition, authModeTransitionStatements, isAuthModeTransitionConflict } from "../worker/authmode.js";
import { queueProviderRevocationsStatement } from "../worker/revocations.js";
import { issueToken, ownerSubject, sha256Hex } from "../worker/session.js";
import { ownerLogout } from "../worker/owner.js";
import { sqliteDb } from "./fixtures/workos.mjs";

function freshDb() {
  const DB = sqliteDb();
  for (const sql of SCHEMA) DB.raw.exec(sql);
  for (const sql of MIGRATIONS) {
    try {
      DB.raw.exec(sql);
    } catch (err) {
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  for (const sql of POST_MIGRATIONS) DB.raw.exec(sql);
  DB.raw.exec("INSERT INTO cafes (slug, name, pass_hash, owner_auth, auth_version) VALUES ('demo', 'Demo', 'x', 'workos', 1)");
  return DB;
}

const env = (DB) => ({ DB, ADMIN_SECRET: "test-admin-secret-phase2b" });
const count = (DB, sql, ...params) => Number(DB.raw.prepare(sql).get(...params).value);
const cafe = (DB) => ({ ...DB.raw.prepare("SELECT * FROM cafes WHERE slug = 'demo'").get() });

function session(DB, { id = "a".repeat(32), cafeId = 1, sid = null } = {}) {
  const now = Date.now();
  // A managed session only authenticates while its membership row exists (Stage 17B), so the fixture
  // models a real managed café: membership first, then the session.
  DB.raw
    .prepare(
      "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, 'user_test_1', 'owner', 1) ON CONFLICT(cafe_id, workos_user_id) DO NOTHING"
    )
    .run(cafeId);
  DB.raw
    .prepare(
      "INSERT INTO owner_sessions (session_id, cafe_id, created, expires, workos_user_id, workos_session_id) VALUES (?, ?, ?, ?, 'user_test_1', ?)"
    )
    .run(id, cafeId, now, now + 12 * 60 * 60 * 1000, sid);
  return id;
}

test("sign-out deletes both CSRF bindings and leaves other sessions' rows alone", async () => {
  const DB = freshDb();
  const e = env(DB);
  const cafeRow = cafe(DB);
  const mine = session(DB, { sid: "session_mine" });
  const other = session(DB, { id: "b".repeat(32), sid: "session_other" });

  const now = Date.now();
  const insert = DB.raw.prepare(
    "INSERT INTO csrf_tokens (token_hash, operator_key_hash, expires, created) VALUES (?, ?, ?, ?)"
  );
  const cookie = await issueToken(e, ownerSubject(cafeRow, 1, mine));
  // Current binding (session id) and the legacy binding (cookie value) for this session.
  insert.run("t1", await sha256Hex(mine), now + 1000, now);
  insert.run("t2", await sha256Hex(cookie), now + 1000, now);
  // Another session's row, which must survive.
  insert.run("t3", await sha256Hex(other), now + 1000, now);

  const response = await ownerLogout(
    new Request("http://127.0.0.1/api/cafes/demo/owner/logout", {
      method: "POST",
      headers: { cookie: `staff_session_demo=${encodeURIComponent(cookie)}`, origin: "http://127.0.0.1" },
    }),
    e,
    cafeRow
  );

  assert.equal(response.status, 303);
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM csrf_tokens WHERE operator_key_hash = ?", await sha256Hex(mine)), 0);
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM csrf_tokens WHERE operator_key_hash = ?", await sha256Hex(cookie)), 0);
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM csrf_tokens WHERE operator_key_hash = ?", await sha256Hex(other)), 1);

  // The other session is untouched, and a second sign-out of the same cookie is still a success.
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 1);
  const again = await ownerLogout(
    new Request("http://127.0.0.1/api/cafes/demo/owner/logout", {
      method: "POST",
      headers: { cookie: `staff_session_demo=${encodeURIComponent(cookie)}`, origin: "http://127.0.0.1" },
    }),
    e,
    cafeRow
  );
  assert.equal(again.status, 303);
});

test("the queue holds one job per provider session and skips NULL sids", async () => {
  const DB = freshDb();
  session(DB, { id: "1".repeat(32), sid: "session_shared" });
  session(DB, { id: "2".repeat(32), sid: "session_shared" });
  session(DB, { id: "3".repeat(32), sid: null });
  session(DB, { id: "4".repeat(32), sid: "session_only" });

  await queueProviderRevocationsStatement({ DB }, { cafeId: 1, now: Date.now() }).run();
  await queueProviderRevocationsStatement({ DB }, { cafeId: 1, now: Date.now() }).run();

  const rows = DB.raw.prepare("SELECT workos_session_id FROM provider_revocations ORDER BY workos_session_id").all();
  assert.deepEqual(
    rows.map((row) => row.workos_session_id),
    ["session_only", "session_shared"]
  );
});

test("the retained provider session is excluded, including when two local rows share it", async () => {
  const DB = freshDb();
  const kept = session(DB, { id: "1".repeat(32), sid: "session_kept" });
  session(DB, { id: "2".repeat(32), sid: "session_kept" });
  session(DB, { id: "3".repeat(32), sid: "session_gone" });
  session(DB, { id: "4".repeat(32), sid: null });

  await queueProviderRevocationsStatement({ DB }, {
    cafeId: 1,
    now: Date.now(),
    excludeSessionId: kept,
    excludeProviderSid: "session_kept",
  }).run();

  const rows = DB.raw.prepare("SELECT workos_session_id FROM provider_revocations").all();
  assert.deepEqual(
    rows.map((row) => row.workos_session_id),
    ["session_gone"],
    "a shared provider session must not be revoked while one local row still uses it"
  );
});

test("the mode switch queues inside the same transaction as the invalidation", async () => {
  const DB = freshDb();
  session(DB, { id: "1".repeat(32), sid: "session_a" });
  session(DB, { id: "2".repeat(32), sid: "session_b" });

  const plan = authModeTransition({
    cafeId: 1,
    oldMode: "workos",
    newMode: "local",
    generation: 0,
    operatorSubject: "operator:test",
  });

  // The same composition the route performs: the queue insert lands before the session delete.
  const composed = (p) => {
    const steps = p.steps;
    const at = steps.findIndex((step) => step.step === "sessions");
    return [
      ...authModeTransitionStatements({ DB }, { steps: steps.slice(0, at) }),
      queueProviderRevocationsStatement({ DB }, { cafeId: 1, now: p.now }),
      ...authModeTransitionStatements({ DB }, { steps: steps.slice(at) }),
    ];
  };

  await DB.batch(composed(plan));

  assert.equal(cafe(DB).owner_auth, "local");
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 0);
  const jobs = DB.raw.prepare("SELECT workos_session_id FROM provider_revocations ORDER BY workos_session_id").all();
  assert.deepEqual(jobs.map((row) => row.workos_session_id), ["session_a", "session_b"]);
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM auth_mode_transitions"), 1);
});

test("a stale generation rolls back the mode change and queues nothing", async () => {
  const DB = freshDb();
  session(DB, { id: "1".repeat(32), sid: "session_a" });
  // Advance the generation, then attempt a transition built from the old value.
  DB.raw.exec("UPDATE cafes SET auth_mode_generation = 1 WHERE id = 1");

  const plan = authModeTransition({
    cafeId: 1,
    oldMode: "workos",
    newMode: "local",
    generation: 0,
    operatorSubject: "operator:test",
  });

  const steps = plan.steps;
  const at = steps.findIndex((step) => step.step === "sessions");
  const composed = [
    ...authModeTransitionStatements({ DB }, { steps: steps.slice(0, at) }),
    queueProviderRevocationsStatement({ DB }, { cafeId: 1, now: plan.now }),
    ...authModeTransitionStatements({ DB }, { steps: steps.slice(at) }),
  ];

  let error = null;
  try {
    await DB.batch(composed);
  } catch (err) {
    error = err;
  }

  assert.ok(error, "the batch must fail");
  assert.equal(isAuthModeTransitionConflict(error), true);
  assert.equal(cafe(DB).owner_auth, "workos", "the mode did not change");
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM provider_revocations"), 0, "no job for a transition that did not happen");
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM owner_sessions"), 1, "the session survived");
  assert.equal(count(DB, "SELECT COUNT(*) AS value FROM auth_mode_transitions"), 0);
});
