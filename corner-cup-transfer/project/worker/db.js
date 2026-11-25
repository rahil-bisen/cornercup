import { hashPassword } from "./passwords.js";

export const SCHEMA = [
  // One row per café on this deployment. Everything a tenant can change about itself lives here,
  // so several clients can share one Worker and one database without sharing any of their data.
  `CREATE TABLE IF NOT EXISTS cafes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    service_mode TEXT NOT NULL DEFAULT 'tables',
    tz_offset_min INTEGER NOT NULL DEFAULT 330,
    contact_phone TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    contact_address TEXT NOT NULL DEFAULT '',
    pass_hash TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY,
    cafe_id INTEGER NOT NULL DEFAULT 1,
    number INTEGER,
    label TEXT NOT NULL,
    seats INTEGER NOT NULL DEFAULT 2
  )`,
  `CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id INTEGER NOT NULL DEFAULT 1,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🍽️',
    available INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    cafe_id INTEGER NOT NULL DEFAULT 1,
    table_id INTEGER NOT NULL,
    table_label TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'new',
    total_cents INTEGER NOT NULL DEFAULT 0,
    payment_method TEXT NOT NULL DEFAULT 'counter',
    payment_status TEXT NOT NULL DEFAULT 'unpaid',
    paid_at TEXT,
    payment_ref TEXT,
    payment_txn TEXT,
    queue_no INTEGER,
    idempotency_key TEXT,
    fingerprint TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    menu_item_id INTEGER,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    qty INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id)`,
  // One row per checkout attempt, so a retry after a lost reply is the same checkout and not a
  // second order. A key is either claimable or permanently dead, never both.
  `CREATE TABLE IF NOT EXISTS checkout_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'claimed',
    lease TEXT NOT NULL DEFAULT '',
    order_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_claims_key ON checkout_claims (cafe_id, idempotency_key)`,
  `CREATE INDEX IF NOT EXISTS idx_checkout_claims_order ON checkout_claims (order_id)`,
];

// Runs after the schema so databases created for the single-café build pick up the tenant columns.
export const MIGRATIONS = [
  "ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'counter'",
  "ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid'",
  "ALTER TABLE orders ADD COLUMN paid_at TEXT",
  "ALTER TABLE orders ADD COLUMN payment_ref TEXT",
  "ALTER TABLE orders ADD COLUMN payment_txn TEXT",
  // Counter-service cafés call guests by a pickup number instead of a table; table orders leave it null.
  "ALTER TABLE orders ADD COLUMN queue_no INTEGER",
  // Idempotency key so the same order isn't created twice if the client retries.
  "ALTER TABLE orders ADD COLUMN idempotency_key TEXT",
  // Canonical hash of the checkout body, so a reused key can be told from a replayed one.
  "ALTER TABLE orders ADD COLUMN fingerprint TEXT",
  // F-02 guest tracking. `track_nonce` is 192 random bits per order and `track_hash` is sha256 of the
  // token derived from it; the token itself is never stored, so a dump yields nothing replayable.
  // Rows written before this migration keep NULL and fail closed for guests.
  "ALTER TABLE orders ADD COLUMN track_nonce TEXT",
  "ALTER TABLE orders ADD COLUMN track_hash TEXT",
  // Every row now belongs to a café. Defaulting to 1 adopts the existing single-café data.
  "ALTER TABLE orders ADD COLUMN cafe_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE menu_items ADD COLUMN cafe_id INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE tables ADD COLUMN cafe_id INTEGER NOT NULL DEFAULT 1",
  // Table numbers restart at 1 per café; the internal `id` stays the join key for orders.
  "ALTER TABLE tables ADD COLUMN number INTEGER",
  "UPDATE tables SET number = id WHERE number IS NULL",
  // The reset-password columns ship only as migrations, so a fresh database and a legacy one
  // arrive at the same shape through the same statements. Re-running them is safe: a column that
  // already exists is caught below, and every CREATE is IF NOT EXISTS.
  "ALTER TABLE cafes ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1",
  "ALTER TABLE cafes ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0",
  "CREATE TABLE IF NOT EXISTS password_resets (id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id INTEGER, operator_identity TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, timestamp INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS csrf_tokens (token_hash TEXT PRIMARY KEY, operator_key_hash TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL, expires INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
];

// Columns added by MIGRATIONS cannot be indexed before they exist, so these run afterwards.
export const POST_MIGRATIONS = [
  "CREATE INDEX IF NOT EXISTS idx_menu_cafe ON menu_items (cafe_id, sort)",
  "CREATE INDEX IF NOT EXISTS idx_orders_cafe ON orders (cafe_id, created_at)",
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_cafe_number ON tables (cafe_id, number)",
  "CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires)",
];

// [category, name, description, priceCents, emoji, sort] — prices in paise (INR).
export const SEED_MENU = [
  ["Chai & Coffee", "Masala Chai", "Kadak, house masala, served in a kulhad.", 5000, "🫖", 10],
  ["Chai & Coffee", "Filter Coffee", "Degree coffee, frothed and poured tall.", 6000, "☕", 20],
  ["Chai & Coffee", "Espresso", "Single origin, pulled short.", 9000, "☕", 30],
  ["Chai & Coffee", "Cappuccino", "Double shot with soft milk foam.", 13000, "☕", 40],
  ["Chai & Coffee", "Café Latte", "Smooth, milky, easy drinking.", 14000, "☕", 50],
  ["Chai & Coffee", "Hot Chocolate", "Dark cocoa, topped with whipped cream.", 14000, "🍫", 60],

  ["Cold Drinks", "Cold Coffee", "Blended with ice cream, chocolate on top.", 15000, "🥤", 110],
  ["Cold Drinks", "Iced Americano", "Long black over ice.", 13000, "🧊", 120],
  ["Cold Drinks", "Fresh Lime Soda", "Sweet or salted, your call.", 8000, "🍋", 130],
  ["Cold Drinks", "Blue Lagoon Mocktail", "Lime, soda and a lot of ice.", 14000, "🍹", 140],
  ["Cold Drinks", "Buttermilk", "Chilled, with curry leaf and ginger.", 6000, "🥛", 150],
  ["Cold Drinks", "Mineral Water", "One litre, chilled.", 2000, "💧", 160],

  ["Snacks", "Veg Grilled Sandwich", "Mint chutney, cheese, pressed on the grill.", 12000, "🥪", 210],
  ["Snacks", "Paneer Tikka Sandwich", "Tandoori paneer, onion, capsicum.", 16000, "🥪", 220],
  ["Snacks", "Peri Peri Fries", "Crisp fries tossed in peri peri.", 13000, "🍟", 230],
  ["Snacks", "Veg Momos (6)", "Steamed, with fiery red chutney.", 9000, "🥟", 240],
  ["Snacks", "Chicken Momos (6)", "Steamed, minced filling, red chutney.", 12000, "🥟", 250],
  ["Snacks", "Cheese Garlic Bread", "Molten cheese on toasted bread.", 14000, "🧄", 260],

  ["Mains", "Veg Biryani", "Dum-cooked, with raita and mirchi ka salan.", 22000, "🍚", 310],
  ["Mains", "Chicken Biryani", "Long grain rice, tender thigh, raita.", 28000, "🍗", 320],
  ["Mains", "Paneer Butter Masala", "Served with two butter rotis.", 24000, "🍛", 330],
  ["Mains", "White Sauce Pasta", "Creamy béchamel, herbs, parmesan.", 23000, "🍝", 340],
  ["Mains", "Arrabbiata Pasta", "Spicy tomato, garlic, chilli flakes.", 22000, "🍝", 350],
  ["Mains", "Masala Maggi", "Onion, tomato and a lot of butter.", 7000, "🍜", 360],

  ["Desserts", "Chocolate Brownie", "Warm, fudgy, dark chocolate.", 12000, "🍫", 410],
  ["Desserts", "Choco Lava Cake", "Molten centre, vanilla on the side.", 14000, "🍫", 420],
  ["Desserts", "Brownie with Ice Cream", "The full works.", 18000, "🍨", 430],
];

let ready;

// Ordering is gated on this. The claim table's unique index is what stops two simultaneous retries
// from both writing an order, so a database that cannot enforce it must not accept orders at all.
let idempotencyIndexReady = false;

export function isIdempotencyIndexReady() {
  return idempotencyIndexReady;
}

export function ensureDb(env) {
  if (!ready) {
    ready = init(env).catch((err) => {
      ready = undefined;
      throw err;
    });
  }
  return ready;
}

export function slugify(value) {
  return (
    String(value || "")
      .normalize("NFD")
      // Accents are folded rather than dropped, so "Café" becomes "cafe" and not "caf".
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "cafe"
  );
}

async function init(env) {
  idempotencyIndexReady = false;
  await env.DB.batch(SCHEMA.map((sql) => env.DB.prepare(sql)));
  await migrate(env);
  await env.DB.batch(POST_MIGRATIONS.map((sql) => env.DB.prepare(sql)));
  idempotencyIndexReady = await ensureIdempotencyIndex(env);
  const primary = await ensurePrimaryCafe(env);
  await bootstrapPrimaryPassword(env, primary);
  await seedMenu(env, primary.id);
  await seedTables(env, primary.id);
}

// The first café inherits the environment variables, which keeps a single-café deployment behaving
// exactly as it did before multi-tenancy existed.
async function ensurePrimaryCafe(env) {
  const existing = await env.DB.prepare("SELECT * FROM cafes ORDER BY id ASC LIMIT 1").first();
  if (existing) return existing;

  const name = env.CAFE_NAME || "Corner Cup Café";
  const mode = String(env.SERVICE_MODE || "").trim().toLowerCase() === "counter" ? "counter" : "tables";
  const tz = Number(env.CAFE_TZ_OFFSET_MIN);
  const slug = slugify(env.CAFE_SLUG || name);

  await env.DB.prepare(
    "INSERT INTO cafes (slug, name, service_mode, tz_offset_min) VALUES (?, ?, ?, ?)"
  )
    .bind(slug, name, mode, Number.isFinite(tz) ? tz : 330)
    .run();

  const created = await env.DB.prepare("SELECT * FROM cafes WHERE slug = ?").bind(slug).first();
  await adoptLegacySettings(env, created.id);
  return created;
}

// The first café used to sign its owner in with the deployment's OWNER_PASSWORD compared in plain
// text. That one shared secret could also open any café whose password was missing, so the only
// thing it may still do is seed the primary café's own hash — and only while that hash is genuinely
// absent. The UPDATE is guarded on `pass_hash IS NULL`, so a restart can never overwrite a password
// an owner has since set (or been handed by an operator reset).
export function primaryPasswordBootstrapStatement(env, { cafeId, passHash }) {
  return env.DB.prepare("UPDATE cafes SET pass_hash = ? WHERE id = ? AND pass_hash IS NULL").bind(
    passHash,
    cafeId
  );
}

// The bootstrap value has to satisfy the same policy as any other owner password: 12 to 100
// characters, exactly what createCafe, an owner password change and an operator reset enforce. A
// weaker value is refused rather than installed — a credential the app would reject everywhere else
// must not sneak in through startup.
export function bootstrapOwnerPassword(env) {
  const configured = env.OWNER_PASSWORD ? String(env.OWNER_PASSWORD).trim() : "";
  if (configured.length < 12 || configured.length > 100) return null;
  return configured;
}

export async function bootstrapPrimaryPassword(env, primary) {
  if (!primary || primary.pass_hash) return;

  // Nothing valid to seed from: leave the hash NULL so sign-in fails closed with an explanation. No
  // shared fallback is applied, here or to any other café.
  const configured = bootstrapOwnerPassword(env);
  if (!configured) {
    if (env.OWNER_PASSWORD) {
      console.warn(
        "OWNER_PASSWORD does not meet the 12-character owner password policy; the primary café stays " +
          "closed until an operator sets a password.",
        { cafeId: primary.id }
      );
    }
    return;
  }

  const result = await primaryPasswordBootstrapStatement(env, {
    cafeId: primary.id,
    passHash: await hashPassword(configured),
  }).run();

  // auth_version is deliberately left alone: the password the owner already types keeps working, and
  // any session that was valid before this deploy stays valid.
  if (Number((result.meta && result.meta.changes) || 0) === 1) {
    console.log("Seeded the primary café's owner password from OWNER_PASSWORD", { cafeId: primary.id });
  }
}

// A café configured in the single-tenant build stored its name and contacts in `settings`. Carry
// those across once so an existing outlet does not revert to env defaults.
async function adoptLegacySettings(env, cafeId) {
  let rows = [];
  try {
    const result = await env.DB.prepare("SELECT key, value FROM settings").all();
    rows = result.results || [];
  } catch {
    return; // no legacy table
  }

  const stored = new Map(rows.map((row) => [row.key, row.value]));
  if (stored.size === 0) return;

  const name = String(stored.get("cafe_name") || "").trim();
  const mode = String(stored.get("service_mode") || "").trim().toLowerCase();
  const tz = Number(stored.get("tz_offset_min"));

  await env.DB.prepare(
    "UPDATE cafes SET name = ?, service_mode = ?, tz_offset_min = ?, contact_phone = ?, contact_email = ?, contact_address = ? WHERE id = ?"
  )
    .bind(
      name || env.CAFE_NAME || "Corner Cup Café",
      mode === "counter" || mode === "tables" ? mode : "tables",
      Number.isFinite(tz) ? tz : 330,
      String(stored.get("contact_phone") || ""),
      String(stored.get("contact_email") || ""),
      String(stored.get("contact_address") || ""),
      cafeId
    )
    .run();
}

export async function seedMenu(env, cafeId) {
  const menu = await env.DB.prepare("SELECT COUNT(*) AS count FROM menu_items WHERE cafe_id = ?")
    .bind(cafeId)
    .first();
  if (menu && menu.count > 0) return;

  await env.DB.batch(
    SEED_MENU.map(([category, name, description, priceCents, emoji, sort]) =>
      env.DB.prepare(
        "INSERT INTO menu_items (cafe_id, category, name, description, price_cents, emoji, sort) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).bind(cafeId, category, name, description, priceCents, emoji, sort)
    )
  );
}

export async function seedTables(env, cafeId, count = 8) {
  const tables = await env.DB.prepare("SELECT COUNT(*) AS count FROM tables WHERE cafe_id = ?")
    .bind(cafeId)
    .first();
  if (tables && tables.count > 0) return;

  // Ids stay globally unique so orders can point at one, while `number` is the table a guest sees
  // and restarting at 1 keeps every café's QR codes short.
  const next = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM tables").first();
  const startId = Number(next && next.id ? next.id : 0);

  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push(
      env.DB.prepare("INSERT INTO tables (id, cafe_id, number, label, seats) VALUES (?, ?, ?, ?, ?)").bind(
        startId + i,
        cafeId,
        i,
        `Table ${i}`,
        i <= 2 ? 2 : 4
      )
    );
  }
  await env.DB.batch(rows);
}

// The unique index for orders is created here, after the columns exist, because init() awaits the
// POST_MIGRATIONS batch: one failing statement there would reject ensureDb() and take every route
// down. A duplicate key that already exists therefore disables ordering instead of crashing.
async function ensureIdempotencyIndex(env) {
  const clashes = await env.DB.prepare(
    "SELECT cafe_id, idempotency_key, COUNT(*) AS count, MIN(created_at) AS first_seen " +
      "FROM orders WHERE idempotency_key IS NOT NULL " +
      "GROUP BY cafe_id, idempotency_key HAVING COUNT(*) > 1 LIMIT 5"
  ).all();

  const clash = (clashes.results || [])[0];
  if (clash) {
    console.error("Ordering disabled: duplicate idempotency keys already stored", {
      cafeId: clash.cafe_id,
      key: clash.idempotency_key,
      count: clash.count,
      firstSeen: clash.first_seen,
    });
    return false;
  }

  try {
    await env.DB.prepare(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency_key " +
        "ON orders (cafe_id, idempotency_key) WHERE idempotency_key IS NOT NULL"
    ).run();
  } catch (err) {
    console.error("Ordering disabled: the idempotency index could not be created", {
      error: err && err.message ? err.message : String(err),
    });
    return false;
  }

  const reason = await readCheckoutConstraints(env);
  if (reason) {
    console.error("Ordering disabled: a checkout constraint is not enforced", { reason });
    return false;
  }
  return true;
}

// Reads the index definitions from SQLite's own catalogue. A name is not proof: an index that is not
// unique, not partial, or covering the columns in the wrong order would let two concurrent checkouts
// through.
async function readCheckoutConstraints(env) {
  const check = async (table, index, partial) => {
    const list = await env.DB.prepare(`PRAGMA index_list('${table}')`).all();
    const entry = (list.results || []).find((row) => row.name === index);
    if (!entry) return `${table}.${index} is missing`;
    if (Number(entry.unique) !== 1) return `${table}.${index} is not unique`;
    if (Number(entry.partial) !== (partial ? 1 : 0)) return `${table}.${index} has the wrong partial flag`;

    const info = await env.DB.prepare(`PRAGMA index_info('${index}')`).all();
    const columns = (info.results || [])
      .slice()
      .sort((a, b) => Number(a.seqno) - Number(b.seqno))
      .map((row) => row.name);
    if (columns.length !== 2 || columns[0] !== "cafe_id" || columns[1] !== "idempotency_key") {
      return `${table}.${index} covers (${columns.join(", ")})`;
    }
    return null;
  };

  // Required columns come first: an index cannot protect a checkout whose arbitration columns
  // are absent, so a half-applied migration must gate rather than reach the claim write.
  const columnsOf = async (table) => {
    const info = await env.DB.prepare(`PRAGMA table_info('${table}')`).all();
    return (info.results || []).map((row) => row.name);
  };

  try {
    const orderColumns = await columnsOf("orders");
    for (const column of ["cafe_id", "idempotency_key", "fingerprint"]) {
      if (!orderColumns.includes(column)) return `orders.${column} is missing`;
    }
    const claimColumns = await columnsOf("checkout_claims");
    for (const column of ["cafe_id", "idempotency_key", "fingerprint", "state", "lease", "order_id"]) {
      if (!claimColumns.includes(column)) return `checkout_claims.${column} is missing`;
    }
    return (
      (await check("checkout_claims", "idx_checkout_claims_key", false)) ||
      (await check("orders", "idx_orders_idempotency_key", true))
    );
  } catch (err) {
    return `metadata unreadable: ${err && err.message ? err.message : String(err)}`;
  }
}

// The target of an `ALTER TABLE ... ADD COLUMN`, or null for any other statement. Only this shape
// has a benign failure, so only this shape may ever be skipped.
export function addColumnTarget(sql) {
  const match = /^[ \t]*ALTER[ \t]+TABLE[ \t]+([A-Za-z_][A-Za-z0-9_]*)[ \t]+ADD[ \t]+COLUMN[ \t]+([A-Za-z_][A-Za-z0-9_]*)/i.exec(
    String(sql || "")
  );
  return match ? { table: match[1], column: match[2] } : null;
}

// A failed migration is forgiven only when the exact column that statement adds already exists. A
// duplicate for some other column, or any unrelated error, is a real failure and must surface.
export function isDuplicateAddColumn(sql, message) {
  const target = addColumnTarget(sql);
  if (!target) return false;
  const duplicate = /duplicate column name(?::[ \t]*([A-Za-z_][A-Za-z0-9_]*))?/i.exec(String(message || ""));
  if (!duplicate) return false;
  return !duplicate[1] || duplicate[1].toLowerCase() === target.column.toLowerCase();
}

async function columnExists(env, table, column) {
  const info = await env.DB.prepare(`PRAGMA table_info('${table}')`).all();
  return (info.results || []).some((row) => String(row.name).toLowerCase() === column.toLowerCase());
}

async function migrate(env) {
  for (const sql of MIGRATIONS) {
    try {
      await env.DB.prepare(sql).run();
    } catch (err) {
      const message = String(err && err.message ? err.message : err);
      const target = addColumnTarget(sql);
      // Only an ADD COLUMN whose own column is already there may be skipped...
      if (!target || !isDuplicateAddColumn(sql, message)) throw err;
      // ...and the catalogue has to agree before the failure is treated as a no-op.
      if (!(await columnExists(env, target.table, target.column))) throw err;
    }
  }
}
