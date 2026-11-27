// ensureDb() runs the schema setup before the first API request of every Worker isolate. It used to keep
// that work in one module-level promise that every request awaited. On Cloudflare a promise belongs to
// the request that created it: when that request is cancelled (the guest's browser gives up, or the page
// is closed) the promise can never settle, and every other request waiting on it fails with "This promise
// was created by a request that has since ended" -> HTTP 500. That was captured on the live Worker on
// 2026-11-27.
//
// These tests model it directly: a first request whose database calls never settle must not block or fail
// the next request, and once setup has succeeded no request repeats it.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { ensureDb, resetEnsureDbForTests } from "../worker/db.js";

// D1-shaped binding over node:sqlite. Every call yields once before touching the database, so two
// concurrent setups interleave the way two requests on one isolate do.
function fakeD1(db, counter = { calls: 0 }) {
  const statement = (sql, args = []) => ({
    sql,
    bind: (...values) => statement(sql, values),
    exec() {
      const prepared = db.prepare(sql);
      return /^\s*(SELECT|PRAGMA)/i.test(sql)
        ? { results: prepared.all(...args) }
        : { results: [], meta: { changes: Number(prepared.run(...args).changes) } };
    },
    async run() {
      counter.calls += 1;
      await Promise.resolve();
      return this.exec();
    },
    async all() {
      counter.calls += 1;
      await Promise.resolve();
      return this.exec();
    },
    async first() {
      counter.calls += 1;
      await Promise.resolve();
      return (this.exec().results || [])[0] || null;
    },
  });
  return {
    prepare: (sql) => statement(sql),
    async batch(list) {
      counter.calls += 1;
      await Promise.resolve();
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
  };
}

// Every call returns a promise that never settles: what the waiting requests saw once the request that
// started the work had ended.
function hangingD1() {
  const never = () => new Promise(() => {});
  const statement = () => ({ bind: () => statement(), run: never, all: never, first: never });
  return { prepare: statement, batch: never };
}

const env = (DB, extra = {}) => ({ DB, CAFE_NAME: "Corner Cup", SERVICE_MODE: "tables", ...extra });

function within(promise, ms, label) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} did not finish within ${ms} ms`)), ms);
    }),
  ]);
}

test("a first request whose setup never finishes does not block the next request", async () => {
  resetEnsureDbForTests();
  ensureDb(env(hangingD1())); // the cancelled request: never settles, never awaited
  const db = new DatabaseSync(":memory:");
  await within(ensureDb(env(fakeD1(db))), 3000, "the second request's setup");
  assert.ok(db.prepare("SELECT 1 FROM cafes WHERE slug = 'corner-cup'").get(), "the second request set the database up");
});

test("once setup has succeeded, later requests do no database work at all", async () => {
  resetEnsureDbForTests();
  const db = new DatabaseSync(":memory:");
  await ensureDb(env(fakeD1(db)));
  const counter = { calls: 0 };
  await ensureDb(env(fakeD1(db, counter)));
  await ensureDb(env(fakeD1(db, counter)));
  assert.equal(counter.calls, 0);
});

test("a setup that fails only fails its own request; the next one succeeds", async () => {
  resetEnsureDbForTests();
  const broken = { prepare: () => ({ bind() { return this; }, run: async () => { throw new Error("D1 unavailable"); }, all: async () => { throw new Error("D1 unavailable"); }, first: async () => { throw new Error("D1 unavailable"); } }), batch: async () => { throw new Error("D1 unavailable"); } };
  await assert.rejects(() => ensureDb(env(broken)), /D1 unavailable/);
  const db = new DatabaseSync(":memory:");
  await ensureDb(env(fakeD1(db)));
});

test("two first requests on an empty database both succeed and create one primary café", async () => {
  resetEnsureDbForTests();
  const db = new DatabaseSync(":memory:");
  const results = await Promise.allSettled([ensureDb(env(fakeD1(db))), ensureDb(env(fakeD1(db)))]);
  assert.deepEqual(
    results.map((r) => (r.status === "fulfilled" ? "ok" : String(r.reason && r.reason.message))),
    ["ok", "ok"]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cafes").get().n, 1);
});

test("two requests creating the primary café at the same moment do not fail on its unique slug", async () => {
  const { SCHEMA, ensurePrimaryCafe } = await import("../worker/db.js");
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  const e = env(fakeD1(db));
  const results = await Promise.allSettled([ensurePrimaryCafe(e), ensurePrimaryCafe(e)]);
  assert.deepEqual(
    results.map((r) => (r.status === "fulfilled" ? "ok" : String(r.reason && r.reason.message))),
    ["ok", "ok"]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM cafes").get().n, 1);
  assert.equal(results[0].value.slug, "corner-cup");
  assert.equal(results[1].value.slug, "corner-cup");
});
