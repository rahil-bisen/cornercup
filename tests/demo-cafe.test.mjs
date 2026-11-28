// The demo-café reset (scripts/demo-cafe.mjs) runs on the live database before every sales demo, so the
// one property that matters most is that it cannot touch any other café. These tests run the script's
// exact SQL against an in-memory SQLite database built from the Worker's own schema and migrations,
// next to a real-looking second café, and compare that café before and after.

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, POST_MIGRATIONS, SCHEMA } from "../worker/db.js";
import { resolveItemImage } from "../src/lib/menuImages.js";
import { DEMO_CAFE, DEMO_MENU, DEMO_SLUG, DEMO_TABLES, buildDemoStatements } from "../scripts/demo-cafe.mjs";

function freshDb() {
  const db = new DatabaseSync(":memory:");
  for (const sql of SCHEMA) db.exec(sql);
  for (const sql of MIGRATIONS) {
    try {
      db.exec(sql);
    } catch (err) {
      // The Worker skips an ADD COLUMN that already exists the same way; anything else is a real failure.
      if (!/duplicate column/i.test(String(err && err.message))) throw err;
    }
  }
  for (const sql of POST_MIGRATIONS) db.exec(sql);
  return db;
}

function runReset(db) {
  for (const sql of buildDemoStatements()) db.exec(sql);
}

// A second café with every kind of row the reset deletes for the demo café, plus sign-in state.
function seedOtherCafe(db) {
  db.exec(`INSERT INTO cafes (id, slug, name, service_mode, tz_offset_min, pass_hash) VALUES (1, 'corner-cup', 'Corner Cup', 'counter', 0, 'argon2id$keep-me')`);
  db.exec(`INSERT INTO tables (id, cafe_id, number, label, seats) VALUES (1, 1, 1, 'Table 1', 2), (2, 1, 2, 'Table 2', 4)`);
  db.exec(`INSERT INTO menu_items (cafe_id, category, name, price_cents, available, sort) VALUES (1, 'Coffee', 'Flat White', 15000, 1, 1), (1, 'Coffee', 'Mocha', 16000, 0, 2)`);
  db.exec(`INSERT INTO orders (id, cafe_id, table_id, table_label, status, total_cents, created_at, updated_at) VALUES ('CC-1', 1, 1, 'Table 1', 'new', 15000, '2026-11-27T10:00:00Z', '2026-11-27T10:00:00Z')`);
  db.exec(`INSERT INTO order_items (order_id, menu_item_id, name, price_cents, qty) VALUES ('CC-1', 1, 'Flat White', 15000, 1)`);
  db.exec(`INSERT INTO checkout_claims (cafe_id, idempotency_key, fingerprint, order_id, created_at, updated_at) VALUES (1, 'key-1', 'fp', 'CC-1', 'x', 'x')`);
  db.exec(`INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES ('sess-1', 1, 1, 2)`);
}

// Every row in every table, so "nothing else changed" is checked across the whole database.
function snapshot(db, { exceptDemo = false } = {}) {
  const demo = db.prepare("SELECT id FROM cafes WHERE slug = ?").get(DEMO_SLUG);
  const demoId = demo ? demo.id : -1;
  const demoOrders = new Set(db.prepare("SELECT id FROM orders WHERE cafe_id = ?").all(demoId).map((r) => r.id));
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const out = {};
  for (const { name } of tables) {
    let rows = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
    if (exceptDemo) {
      rows = rows.filter((row) => {
        if (name === "cafes") return row.slug !== DEMO_SLUG;
        if ("cafe_id" in row && row.cafe_id === demoId) return false;
        if (name === "order_items" && demoOrders.has(row.order_id)) return false;
        return true;
      });
    }
    out[name] = rows.map((row) => ({ ...row }));
  }
  return out;
}

test("every statement is scoped to the demo café's slug", () => {
  for (const sql of buildDemoStatements()) {
    assert.ok(sql.includes(`slug = '${DEMO_SLUG}'`), `unscoped statement: ${sql}`);
    assert.doesNotMatch(sql, /\bDROP\b|\bALTER\b|pass_hash|owner_sessions|auth_version/i, `out-of-bounds statement: ${sql}`);
  }
});

test("a first run creates the demo café exactly as specified, with no password", () => {
  const db = freshDb();
  runReset(db);
  const cafe = db.prepare("SELECT * FROM cafes WHERE slug = ?").get(DEMO_SLUG);
  assert.equal(cafe.name, DEMO_CAFE.name);
  assert.equal(cafe.service_mode, "tables");
  assert.equal(cafe.tz_offset_min, 330, "IST");
  assert.equal(cafe.pass_hash, null, "the script never sets a password");
  for (const field of ["contact_phone", "contact_email", "contact_address"]) {
    assert.ok(cafe[field].trim().length > 0, `${field} is filled so policy pages show no [placeholder]`);
  }

  const tables = db.prepare("SELECT number, label, seats FROM tables WHERE cafe_id = ? ORDER BY number").all(cafe.id);
  assert.deepEqual(tables.map((t) => t.number), [1, 2, 3, 4, 5, 6]);
  assert.equal(tables.length, DEMO_TABLES.length);

  const items = db.prepare("SELECT * FROM menu_items WHERE cafe_id = ? ORDER BY sort").all(cafe.id);
  assert.equal(items.length, DEMO_MENU.length);
  assert.equal(items.filter((i) => i.available === 0).length, 1, "exactly one sold-out item");
  assert.ok(items.every((i) => Number.isInteger(i.price_cents) && i.price_cents > 0));
  const categories = [...new Set(items.map((i) => i.category))];
  assert.ok(categories.length >= 4, "the menu has categories");
  // No item borrows a stock photograph: until the café uploads its own, every item shows the placeholder.
  assert.equal(items.filter((i) => resolveItemImage({ name: i.name }, i.category)).length, 0);
});

test("a reset clears the demo's orders and edits but keeps its password and other cafés untouched", () => {
  const db = freshDb();
  seedOtherCafe(db);
  runReset(db);
  const demo = db.prepare("SELECT id FROM cafes WHERE slug = ?").get(DEMO_SLUG);

  // A demo happens: the owner sets a password, renames the café, edits the menu and takes orders.
  db.exec(`UPDATE cafes SET pass_hash = 'argon2id$owner-set', name = 'Renamed in demo' WHERE id = ${demo.id}`);
  db.exec(`UPDATE menu_items SET price_cents = 1, available = 0 WHERE cafe_id = ${demo.id}`);
  db.exec(`INSERT INTO menu_items (cafe_id, category, name, price_cents) VALUES (${demo.id}, 'Snacks', 'Added in demo', 100)`);
  db.exec(`INSERT INTO orders (id, cafe_id, table_id, table_label, created_at, updated_at) VALUES ('CK-1', ${demo.id}, 3, 'Table 3', 'x', 'x')`);
  db.exec(`INSERT INTO order_items (order_id, name, price_cents, qty) VALUES ('CK-1', 'Masala Chai', 4000, 2)`);
  db.exec(`INSERT INTO checkout_claims (cafe_id, idempotency_key, fingerprint, order_id, created_at, updated_at) VALUES (${demo.id}, 'key-1', 'fp', 'CK-1', 'x', 'x')`);

  const before = snapshot(db, { exceptDemo: true });
  runReset(db);
  const after = snapshot(db, { exceptDemo: true });
  assert.deepEqual(after, before, "no row outside the demo café changed");

  const cafe = db.prepare("SELECT * FROM cafes WHERE slug = ?").get(DEMO_SLUG);
  assert.equal(cafe.id, demo.id, "the café row is kept, not recreated");
  assert.equal(cafe.pass_hash, "argon2id$owner-set", "the owner's password survives a reset");
  assert.equal(cafe.name, DEMO_CAFE.name, "settings go back to the demo values");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM orders WHERE cafe_id = ?").get(demo.id).n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM order_items WHERE order_id = 'CK-1'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM checkout_claims WHERE cafe_id = ?").get(demo.id).n, 0);
  const items = db.prepare("SELECT * FROM menu_items WHERE cafe_id = ?").all(demo.id);
  assert.equal(items.length, DEMO_MENU.length);
  assert.equal(items.filter((i) => i.available === 0).length, 1);
  assert.ok(!items.some((i) => i.name === "Added in demo"));
});

test("running the reset twice in a row gives the same demo café", () => {
  const db = freshDb();
  seedOtherCafe(db);
  runReset(db);
  const once = snapshot(db);
  runReset(db);
  const twice = snapshot(db);
  // Row ids of rebuilt tables and items move on; what a guest or the board sees must not.
  const visible = (snap) => ({
    cafes: snap.cafes,
    tables: snap.tables.map(({ id, ...rest }) => rest),
    menu_items: snap.menu_items.map(({ id, ...rest }) => rest),
    orders: snap.orders,
  });
  assert.deepEqual(visible(twice), visible(once));
});
