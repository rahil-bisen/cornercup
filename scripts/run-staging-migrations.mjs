import { SCHEMA, MIGRATIONS, POST_MIGRATIONS } from '../worker/db.js';

// Mirror of worker/db.js migrate() + init(): tolerate duplicate-column ALTERs
// only when the column already exists. All other errors abort.
export async function applyMigrations(db) {
  // SCHEMA (batch)
  for (const sql of SCHEMA) await db.prepare(sql).run();
  // MIGRATIONS (tolerant)
  for (const sql of MIGRATIONS) {
    try {
      await db.prepare(sql).run();
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      const m = sql.match(/ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/i);
      if (!m) throw err;
      const [, table, column] = m;
      // verify column exists
      const info = await db.prepare(`PRAGMA table_info(${table})`).all();
      const exists = (info.results || []).some((r) => r.name === column);
      if (!exists) throw err;
      // tolerate duplicate
      if (!/duplicate column/i.test(msg) && !/already exists/i.test(msg)) throw err;
    }
  }
  // POST_MIGRATIONS (batch)
  for (const sql of POST_MIGRATIONS) await db.prepare(sql).run();
}
