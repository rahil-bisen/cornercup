import assert from "node:assert/strict";
import test from "node:test";
import { createCafe } from "../worker/cafes.js";
import { ensurePrimaryCafe } from "../worker/db.js";

function cafeDb() {
  const statements = [];
  const batches = [];
  const cafes = new Map();
  return {
    statements,
    batches,
    DB: {
      prepare(sql) {
        statements.push(sql);
        return {
          bind(...values) {
            return {
              sql,
              values,
              first: async () => {
                // The slug check includes archived cafés; the lookup after the insert does not.
                if (sql === "SELECT * FROM cafes WHERE slug = ?") return cafes.get(values[0]) || null;
                if (sql === "SELECT * FROM cafes WHERE slug = ? AND archived_at IS NULL") {
                  return cafes.get(values[0]) || null;
                }
                throw new Error(`Unexpected query: ${sql}`);
              },
            };
          },
        };
      },
      batch: async (boundStatements) => {
        batches.push(boundStatements);
        for (const statement of boundStatements) {
          if (statement.sql.startsWith("INSERT INTO cafes")) {
            const values = statement.values;
            cafes.set(values[0], {
              id: cafes.size + 1,
              slug: values[0],
              name: values[1],
              service_mode: values[2],
              pass_hash: values[3],
            });
          } else if (!statement.sql.startsWith("INSERT INTO tables")) {
            throw new Error(`Unexpected query: ${statement.sql}`);
          }
        }
        return [];
      },
    },
  };
}

test("production café creation does not seed a demo menu or default tables", async () => {
  const db = cafeDb();
  const cafe = await createCafe(
    { DB: db.DB },
    { name: "Real Café", password: "a-secure-owner-password", serviceMode: "tables" }
  );

  assert.equal(cafe.slug, "real-cafe");
  assert.deepEqual(
    db.statements,
    [
      "SELECT * FROM cafes WHERE slug = ?",
      "INSERT INTO cafes (slug, name, service_mode, pass_hash) VALUES (?, ?, ?, ?)",
      "SELECT * FROM cafes WHERE slug = ? AND archived_at IS NULL",
    ]
  );
  assert.equal(db.batches[0].length, 1);
});

test("café creation rejects invalid service modes and table counts", async () => {
  const db = cafeDb();
  const env = { DB: db.DB };

  await assert.rejects(
    createCafe(env, { name: "Real Café", password: "a-secure-owner-password", serviceMode: "unknown" }),
    /Choose table service or counter service/
  );
  await assert.rejects(
    createCafe(env, { name: "Real Café", password: "a-secure-owner-password", tables: 41 }),
    /between 0 and 40/
  );

  assert.equal(db.statements.some((sql) => sql.startsWith("INSERT INTO cafes")), false);
});

test("requested starting tables are created in the café's atomic batch", async () => {
  const db = cafeDb();
  await createCafe(
    { DB: db.DB },
    { name: "Real Café", password: "a-secure-owner-password", serviceMode: "tables", tables: 2 }
  );

  assert.equal(db.batches[0].length, 3);
  assert.equal(db.batches[0][1].sql.startsWith("INSERT INTO tables"), true);
  assert.equal(db.batches[0][2].sql.startsWith("INSERT INTO tables"), true);
});

test("primary café bootstrap requires an explicitly configured real name", async () => {
  const statements = [];
  const env = {
    DB: {
      prepare(sql) {
        statements.push(sql);
        return { first: async () => null };
      },
    },
  };

  assert.equal(await ensurePrimaryCafe(env), null);
  assert.deepEqual(statements, ["SELECT * FROM cafes ORDER BY id ASC LIMIT 1"]);
});
