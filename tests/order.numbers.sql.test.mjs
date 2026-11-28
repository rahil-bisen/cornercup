// Daily order numbers, at the SQL level: the production statements (claim, then the order batch) run
// against real SQLite built from the production schema and migrations. Concurrency over HTTP is covered
// in tests/order.numbers.test.mjs; this file pins the arithmetic, the café-local midnight, the unique
// index and the day the feature ships.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from "../worker/db.js";
import { cafeDay, claimStatement, isDailyNumberCollision, orderBatch } from "../worker/orders.js";

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
  db.exec("INSERT INTO cafes (slug, name, service_mode, tz_offset_min) VALUES ('ist', 'IST Café', 'tables', 330)");
  db.exec("INSERT INTO cafes (slug, name, service_mode, tz_offset_min) VALUES ('nyc', 'NYC Café', 'counter', -300)");
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

const idOf = (db, slug) => db.prepare("SELECT id, tz_offset_min FROM cafes WHERE slug = ?").get(slug);
let serial = 0;

// Places one order the way createOrder does: claim the key, then the order batch, at instant `whenMs`.
function place(db, slug, whenMs, { claim = true, counter = false } = {}) {
  const env = makeEnv(db);
  const cafe = idOf(db, slug);
  serial += 1;
  const key = `key-${serial}`;
  const now = new Date(whenMs).toISOString();
  if (claim) env.DB.batch([claimStatement(env, { cafeId: cafe.id, key, fingerprint: "fp", lease: "L", now })]);
  const results = env.DB.batch(
    orderBatch(env, {
      id: `ORD${serial}`,
      cafeId: cafe.id,
      counter,
      tableId: 1,
      tableLabel: "Table 1",
      note: "",
      totalCents: 100,
      paymentMethod: "counter",
      key,
      fingerprint: "fp",
      lease: "L",
      now,
      ...cafeDay(whenMs, cafe.tz_offset_min),
      items: [],
    })
  );
  const row = db.prepare("SELECT queue_no, business_date FROM orders WHERE id = ?").get(`ORD${serial}`);
  return { inserted: results[0].meta.changes, number: row ? row.queue_no : null, date: row ? row.business_date : null };
}

// 2026-11-28 12:00 IST is 06:30 UTC.
const IST_NOON = Date.UTC(2026, 10, 28, 6, 30);

test("a café's orders are numbered 1, 2, 3 within a day, dine-in and counter alike", () => {
  const db = freshDatabase();
  assert.deepEqual([1, 2, 3].map(() => place(db, "ist", IST_NOON).number), [1, 2, 3]);
  const counter = freshDatabase();
  assert.deepEqual([1, 2].map(() => place(counter, "nyc", IST_NOON, { counter: true }).number), [1, 2]);
});

test("two cafés can both have Order #1 on the same day", () => {
  const db = freshDatabase();
  assert.equal(place(db, "ist", IST_NOON).number, 1);
  assert.equal(place(db, "nyc", IST_NOON).number, 1);
  assert.equal(place(db, "ist", IST_NOON).number, 2);
  assert.equal(place(db, "nyc", IST_NOON).number, 2);
});

test("numbers restart at the café's own local midnight, not UTC midnight", () => {
  const db = freshDatabase();
  // 23:59 IST on the 28th is 18:29 UTC; 00:01 IST on the 29th is 18:31 UTC — the same UTC date.
  const lateIst = Date.UTC(2026, 10, 28, 18, 29);
  const earlyIst = Date.UTC(2026, 10, 28, 18, 31);
  assert.deepEqual(place(db, "ist", lateIst), { inserted: 1, number: 1, date: "2026-11-28" });
  assert.equal(place(db, "ist", lateIst).number, 2);
  assert.deepEqual(place(db, "ist", earlyIst), { inserted: 1, number: 1, date: "2026-11-29" });

  // New York (UTC−5) is still on the 28th at both instants, so its count carries on.
  assert.deepEqual(place(db, "nyc", lateIst), { inserted: 1, number: 1, date: "2026-11-28" });
  assert.deepEqual(place(db, "nyc", earlyIst), { inserted: 1, number: 2, date: "2026-11-28" });
  // …until its own midnight: 05:01 UTC on the 29th is 00:01 in New York.
  assert.deepEqual(place(db, "nyc", Date.UTC(2026, 10, 29, 5, 1)), { inserted: 1, number: 1, date: "2026-11-29" });
});

test("cafeDay gives the café-local date and its UTC bounds", () => {
  assert.deepEqual(cafeDay(Date.UTC(2026, 10, 28, 18, 29), 330), {
    businessDate: "2026-11-28",
    dayStart: "2026-11-27T18:30:00.000Z",
    dayEnd: "2026-11-28T18:30:00.000Z",
  });
  assert.equal(cafeDay(Date.UTC(2026, 10, 28, 18, 30), 330).businessDate, "2026-11-29", "exactly midnight is the new day");
  assert.equal(cafeDay(Date.UTC(2026, 10, 29, 4, 59), -300).businessDate, "2026-11-28");
  assert.equal(cafeDay(Date.UTC(2026, 10, 29, 5, 0), -300).businessDate, "2026-11-29");
});

test("a checkout whose claim is gone writes no order and uses up no number", () => {
  const db = freshDatabase();
  assert.equal(place(db, "ist", IST_NOON).number, 1);
  assert.deepEqual(place(db, "ist", IST_NOON, { claim: false }), { inserted: 0, number: null, date: null });
  assert.equal(place(db, "ist", IST_NOON).number, 2, "no gap left by the suppressed insert");
});

test("the unique index refuses a duplicate daily number, and the error is recognised as retryable", () => {
  const db = freshDatabase();
  place(db, "ist", IST_NOON);
  const cafe = idOf(db, "ist");
  assert.throws(
    () =>
      db
        .prepare(
          "INSERT INTO orders (id, cafe_id, table_id, table_label, created_at, updated_at, queue_no, business_date) " +
            "VALUES ('DUP', ?, 1, 'Table 1', 'x', 'x', 1, '2026-11-28')"
        )
        .run(cafe.id),
    (err) => isDailyNumberCollision(err)
  );
  assert.equal(isDailyNumberCollision(new Error("UNIQUE constraint failed: orders.id")), false);
});

test("on the day this ships, numbering continues after that day's older counter numbers", () => {
  const db = freshDatabase();
  const cafe = idOf(db, "nyc");
  // Two counter orders numbered the old way earlier today (no business_date), and one from yesterday.
  const today = new Date(Date.UTC(2026, 10, 28, 15, 0)).toISOString(); // 10:00 in New York
  const yesterday = new Date(Date.UTC(2026, 10, 27, 15, 0)).toISOString();
  const legacy = db.prepare(
    "INSERT INTO orders (id, cafe_id, table_id, table_label, created_at, updated_at, queue_no) VALUES (?, ?, 0, 'Counter', ?, ?, ?)"
  );
  legacy.run("OLD1", cafe.id, today, today, 4);
  legacy.run("OLD2", cafe.id, today, today, 5);
  legacy.run("OLD0", cafe.id, yesterday, yesterday, 9);

  assert.equal(place(db, "nyc", Date.UTC(2026, 10, 28, 16, 0)).number, 6, "carries on from #5, ignores yesterday's #9");
  assert.equal(db.prepare("SELECT business_date FROM orders WHERE id = 'OLD1'").get().business_date, null, "old rows are untouched");
});

test("existing orders keep their values through the migration, even duplicate old counter numbers", () => {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  // An old database: two counter orders that somehow share #3 on the same day.
  db.exec("INSERT INTO cafes (slug, name) VALUES ('old', 'Old')");
  db.exec(
    "INSERT INTO orders (id, cafe_id, table_id, table_label, created_at, updated_at) VALUES ('A', 1, 0, 'Counter', 'x', 'x'), ('B', 1, 0, 'Counter', 'x', 'x')"
  );
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      if (!/duplicate column name/i.test(String(err.message || err))) throw err;
    }
  }
  db.exec("UPDATE orders SET queue_no = 3");
  for (const sql of POST_MIGRATIONS) db.exec(sql); // must not throw: old rows are outside the partial index
  const rows = db.prepare("SELECT id, queue_no, business_date FROM orders ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { id: "A", queue_no: 3, business_date: null },
    { id: "B", queue_no: 3, business_date: null },
  ]);
});
