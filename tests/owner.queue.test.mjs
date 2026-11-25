// F-07 phase 2B — the provider revocation queue, exercised against the production module.
//
// The queue's contract is deliberately modest: local revocation is immediate and unconditional, the
// provider job is durable, bounded (5 attempts / 24 hours) and delivered at least once if traffic
// allows. Nothing here claims guaranteed delivery.
import test from "node:test";
import assert from "node:assert/strict";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";
import {
  REVOCATION_MAX_ATTEMPTS,
  REVOCATION_TTL_MS,
  drainProviderRevocations,
  pruneProviderRevocations,
  queueProviderRevocationsStatement,
} from "../worker/revocations.js";
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
  DB.raw.exec("INSERT INTO cafes (slug, name, pass_hash) VALUES ('demo', 'Demo', 'x')");
  return DB;
}

const env = (DB) => ({ DB });
const jobs = (DB) =>
  DB.raw.prepare("SELECT workos_session_id, attempts, next_attempt, lease_until, expires FROM provider_revocations ORDER BY workos_session_id").all();

function seedJob(DB, { sid = "session_a", attempts = 0, nextAttempt = Date.now() - 1, expires = Date.now() + REVOCATION_TTL_MS } = {}) {
  DB.raw
    .prepare(
      "INSERT OR REPLACE INTO provider_revocations (workos_session_id, cafe_id, created, attempts, next_attempt, lease_until, lease_owner, expires, last_error) VALUES (?, 1, ?, ?, ?, NULL, NULL, ?, '')"
    )
    .run(sid, Date.now(), attempts, nextAttempt, expires);
}

// A controllable provider. `revokeSession` uses the global fetch, so the test owns it.
function stubProvider(handler) {
  const real = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init && init.body ? JSON.parse(String(init.body)) : null });
    return handler(String(url), init);
  };
  return {
    calls,
    restore() {
      globalThis.fetch = real;
    },
  };
}

const okResponse = () => new Response(JSON.stringify({ ok: true }), { status: 200 });

test("a failed revoke is retried with backoff, then succeeds", async () => {
  const DB = freshDb();
  seedJob(DB, { attempts: 0 });

  let provider = stubProvider(() => new Response("{}", { status: 500 }));
  try {
    const first = await drainProviderRevocations(env(DB), { limit: 1 });
    assert.equal(first.failed, 1);
    assert.equal(first.revoked, 0);
  } finally {
    provider.restore();
  }

  const afterFailure = jobs(DB);
  assert.equal(afterFailure.length, 1, "the job is durable");
  assert.equal(afterFailure[0].attempts, 1);
  assert.equal(afterFailure[0].lease_until, null, "the lease is released");
  assert.ok(afterFailure[0].next_attempt > Date.now(), "the retry is in the future (backoff)");

  // Not due yet: a second drain makes no provider call.
  provider = stubProvider(() => okResponse());
  try {
    const second = await drainProviderRevocations(env(DB), { limit: 1 });
    assert.equal(second.revoked, 0);
    assert.equal(provider.calls.length, 0, "backoff is respected");
  } finally {
    provider.restore();
  }

  // Once due, it succeeds and the row is gone.
  DB.raw.exec(`UPDATE provider_revocations SET next_attempt = ${Date.now() - 1}`);
  provider = stubProvider(() => okResponse());
  try {
    const third = await drainProviderRevocations(env(DB), { limit: 1 });
    assert.equal(third.revoked, 1);
    assert.equal(jobs(DB).length, 0);
  } finally {
    provider.restore();
  }
});

test("an already-revoked provider session (404) is treated as success", async () => {
  const DB = freshDb();
  seedJob(DB);
  const provider = stubProvider(() => new Response("{}", { status: 404 }));
  try {
    const result = await drainProviderRevocations(env(DB), { limit: 1 });
    assert.equal(result.revoked, 1);
    assert.equal(jobs(DB).length, 0);
  } finally {
    provider.restore();
  }
});

test("a provider timeout keeps the job and records the attempt", async () => {
  const DB = freshDb();
  seedJob(DB);
  const provider = stubProvider(() => {
    throw new DOMException("timed out", "AbortError");
  });
  try {
    const result = await drainProviderRevocations(env(DB), { limit: 1 });
    assert.equal(result.failed, 1);
  } finally {
    provider.restore();
  }
  const rows = jobs(DB);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 1);
});

test("the attempt cap is five and an exhausted job is pruned without a provider call", async () => {
  assert.equal(REVOCATION_MAX_ATTEMPTS, 5);
  const DB = freshDb();
  seedJob(DB, { attempts: REVOCATION_MAX_ATTEMPTS });

  const provider = stubProvider(() => okResponse());
  try {
    const result = await drainProviderRevocations(env(DB), { limit: 3 });
    assert.equal(result.revoked, 0);
    assert.equal(provider.calls.length, 0, "an exhausted job is never retried");
  } finally {
    provider.restore();
  }
  assert.equal(jobs(DB).length, 0, "pruning removed it");
});

test("a job older than 24 hours is pruned rather than delivered late", async () => {
  const DB = freshDb();
  seedJob(DB, { expires: Date.now() - 1000 });
  const provider = stubProvider(() => okResponse());
  try {
    await drainProviderRevocations(env(DB), { limit: 3 });
    assert.equal(provider.calls.length, 0);
  } finally {
    provider.restore();
  }
  assert.equal(jobs(DB).length, 0);
});

test("the same provider session is queued once, however many rows name it", async () => {
  const DB = freshDb();
  for (const id of ["a".repeat(32), "b".repeat(32)]) {
    DB.raw
      .prepare(
        "INSERT INTO owner_sessions (session_id, cafe_id, created, expires, workos_session_id) VALUES (?, 1, ?, ?, 'session_shared')"
      )
      .run(id, Date.now(), Date.now() + 3600_000);
  }
  await queueProviderRevocationsStatement(env(DB), { cafeId: 1, now: Date.now() }).run();
  await queueProviderRevocationsStatement(env(DB), { cafeId: 1, now: Date.now() }).run();
  assert.equal(jobs(DB).length, 1);
});

test("pruning runs before the drain and only removes dead rows", async () => {
  const DB = freshDb();
  seedJob(DB, { sid: "session_dead", expires: Date.now() - 1 });
  seedJob(DB, { sid: "session_live" });

  const provider = stubProvider(() => okResponse());
  try {
    await drainProviderRevocations(env(DB), { limit: 3 });
    assert.equal(provider.calls.length, 1);
    assert.equal(provider.calls[0].body.session_id, "session_live");
  } finally {
    provider.restore();
  }
  assert.equal(jobs(DB).length, 0);
});

test("two concurrent drains deliver the job exactly once", async () => {
  const DB = freshDb();
  seedJob(DB);

  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const provider = stubProvider(async () => {
    await gate;
    return okResponse();
  });

  try {
    const first = drainProviderRevocations(env(DB), { limit: 1 });
    // Give the first drain time to take the lease before the second starts.
    await new Promise((resolve) => setTimeout(resolve, 30));
    const second = drainProviderRevocations(env(DB), { limit: 1 });
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.revoked + b.revoked, 1, "one delivery, not two");
    assert.equal(provider.calls.length, 1);
  } finally {
    provider.restore();
  }
  assert.equal(jobs(DB).length, 0);
});

test("a D1 failure while leasing never throws into the caller", async () => {
  const DB = freshDb();
  seedJob(DB);
  const broken = {
    DB: {
      prepare(sql) {
        if (/UPDATE provider_revocations SET lease_owner/i.test(sql)) throw new Error("injected D1 failure");
        return DB.prepare(sql);
      },
      batch: (statements) => DB.batch(statements),
      exec: (sql) => DB.exec(sql),
    },
  };
  const provider = stubProvider(() => okResponse());
  try {
    const result = await drainProviderRevocations(broken, { limit: 1 });
    assert.equal(result.revoked, 0);
    assert.equal(provider.calls.length, 0);
  } finally {
    provider.restore();
  }
  assert.equal(jobs(DB).length, 1, "the job survives a store failure");
});

test("pruneProviderRevocations is idempotent and bounded to dead rows", async () => {
  const DB = freshDb();
  seedJob(DB, { sid: "session_expired", expires: Date.now() - 1 });
  seedJob(DB, { sid: "session_ok" });
  await pruneProviderRevocations(env(DB));
  await pruneProviderRevocations(env(DB));
  assert.deepEqual(jobs(DB).map((row) => row.workos_session_id), ["session_ok"]);
});
