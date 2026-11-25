-- Corner Cup staging FRESH-INSTALL SQL (initial empty D1 only)
-- Target: D1 "corner-cup-staging" (ID 39a7899c-0130-4536-9570-f07b6c29b2d4)
-- Contains final-state SCHEMA + POST_MIGRATIONS. MIGRATIONS omitted because SCHEMA already reflects final columns.
-- Safe to run verbatim on an empty database. Idempotent on re-run (IF NOT EXISTS).

PRAGMA foreign_keys = ON;

-- ========== SCHEMA ==========
-- SCHEMA 1
CREATE TABLE IF NOT EXISTS cafes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    service_mode TEXT NOT NULL DEFAULT 'tables',
    tz_offset_min INTEGER NOT NULL DEFAULT 330,
    contact_phone TEXT NOT NULL DEFAULT '',
    contact_email TEXT NOT NULL DEFAULT '',
    contact_address TEXT NOT NULL DEFAULT '',
    pass_hash TEXT
  );

-- SCHEMA 2
CREATE TABLE IF NOT EXISTS tables (
    id INTEGER PRIMARY KEY,
    cafe_id INTEGER NOT NULL DEFAULT 1,
    number INTEGER,
    label TEXT NOT NULL,
    seats INTEGER NOT NULL DEFAULT 2
  );

-- SCHEMA 3
CREATE TABLE IF NOT EXISTS menu_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id INTEGER NOT NULL DEFAULT 1,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    emoji TEXT NOT NULL DEFAULT '🍽️',
    available INTEGER NOT NULL DEFAULT 1,
    sort INTEGER NOT NULL DEFAULT 0
  );

-- SCHEMA 4
CREATE TABLE IF NOT EXISTS orders (
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
  );

-- SCHEMA 5
CREATE TABLE IF NOT EXISTS order_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL,
    menu_item_id INTEGER,
    name TEXT NOT NULL,
    emoji TEXT NOT NULL DEFAULT '',
    price_cents INTEGER NOT NULL,
    qty INTEGER NOT NULL
  );

-- SCHEMA 6
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders (created_at);

-- SCHEMA 7
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items (order_id);

-- SCHEMA 8
CREATE TABLE IF NOT EXISTS checkout_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cafe_id INTEGER NOT NULL,
    idempotency_key TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'claimed',
    lease TEXT NOT NULL DEFAULT '',
    order_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

-- SCHEMA 9
CREATE UNIQUE INDEX IF NOT EXISTS idx_checkout_claims_key ON checkout_claims (cafe_id, idempotency_key);

-- SCHEMA 10
CREATE INDEX IF NOT EXISTS idx_checkout_claims_order ON checkout_claims (order_id);

-- ========== POST_MIGRATIONS (indexes) ==========
-- POST_MIGRATION 1
CREATE INDEX IF NOT EXISTS idx_menu_cafe ON menu_items (cafe_id, sort);

-- POST_MIGRATION 2
CREATE INDEX IF NOT EXISTS idx_orders_cafe ON orders (cafe_id, created_at);

-- POST_MIGRATION 3
CREATE UNIQUE INDEX IF NOT EXISTS idx_tables_cafe_number ON tables (cafe_id, number);

-- POST_MIGRATION 4
CREATE INDEX IF NOT EXISTS idx_rate_limits_expires ON rate_limits (expires);

-- POST_MIGRATION 5
CREATE INDEX IF NOT EXISTS idx_operator_sessions_expires ON operator_sessions (expires);

-- POST_MIGRATION 6
CREATE INDEX IF NOT EXISTS idx_owner_sessions_expires ON owner_sessions (expires);

-- POST_MIGRATION 7
CREATE INDEX IF NOT EXISTS idx_owner_sessions_cafe ON owner_sessions (cafe_id);

-- POST_MIGRATION 8
CREATE INDEX IF NOT EXISTS idx_owner_identities_email ON owner_identities (email);

-- POST_MIGRATION 9
CREATE INDEX IF NOT EXISTS idx_cafe_owners_identity ON cafe_owners (workos_user_id);

-- POST_MIGRATION 10
CREATE INDEX IF NOT EXISTS idx_owner_login_states_expires ON owner_login_states (expires);

-- POST_MIGRATION 11
CREATE INDEX IF NOT EXISTS idx_owner_sessions_identity ON owner_sessions (workos_user_id) WHERE workos_user_id IS NOT NULL;

-- POST_MIGRATION 12
CREATE INDEX IF NOT EXISTS idx_auth_mode_transitions_created ON auth_mode_transitions (created);

-- POST_MIGRATION 13
CREATE INDEX IF NOT EXISTS idx_operator_audit_cafe ON operator_audit (cafe_id, created);

-- POST_MIGRATION 14
CREATE INDEX IF NOT EXISTS idx_owner_claims_expires ON owner_claims (expires);

-- POST_MIGRATION 15
CREATE INDEX IF NOT EXISTS idx_owner_claims_cafe ON owner_claims (cafe_id);

-- POST_MIGRATION 16
CREATE INDEX IF NOT EXISTS idx_provider_revocations_due ON provider_revocations (next_attempt, lease_until);
