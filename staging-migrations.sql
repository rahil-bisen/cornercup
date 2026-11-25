-- Corner Cup staging migration SQL
-- Target: D1 database "corner-cup-staging" (ID 39a7899c-0130-4536-9570-f07b6c29b2d4)
-- Generated from worker/db.js: SCHEMA, MIGRATIONS, POST_MIGRATIONS
-- Do NOT run against production. For initial staging setup only.
-- Idempotency: CREATE ... IF NOT EXISTS and tolerated duplicate-column ALTERs are handled by ensureDb() at runtime; raw re-execution of ALTER on existing columns will error.

PRAGMA foreign_keys = ON;

-- ========== SCHEMA (base tables) ==========
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

-- ========== MIGRATIONS (additive) ==========
-- MIGRATION 1
ALTER TABLE orders ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'counter';

-- MIGRATION 2
ALTER TABLE orders ADD COLUMN payment_status TEXT NOT NULL DEFAULT 'unpaid';

-- MIGRATION 3
ALTER TABLE orders ADD COLUMN paid_at TEXT;

-- MIGRATION 4
ALTER TABLE orders ADD COLUMN payment_ref TEXT;

-- MIGRATION 5
ALTER TABLE orders ADD COLUMN payment_txn TEXT;

-- MIGRATION 6
ALTER TABLE orders ADD COLUMN queue_no INTEGER;

-- MIGRATION 7
ALTER TABLE orders ADD COLUMN idempotency_key TEXT;

-- MIGRATION 8
ALTER TABLE orders ADD COLUMN fingerprint TEXT;

-- MIGRATION 9
ALTER TABLE orders ADD COLUMN track_nonce TEXT;

-- MIGRATION 10
ALTER TABLE orders ADD COLUMN track_hash TEXT;

-- MIGRATION 11
ALTER TABLE orders ADD COLUMN cafe_id INTEGER NOT NULL DEFAULT 1;

-- MIGRATION 12
ALTER TABLE menu_items ADD COLUMN cafe_id INTEGER NOT NULL DEFAULT 1;

-- MIGRATION 13
ALTER TABLE tables ADD COLUMN cafe_id INTEGER NOT NULL DEFAULT 1;

-- MIGRATION 14
ALTER TABLE tables ADD COLUMN number INTEGER;

-- MIGRATION 15
UPDATE tables SET number = id WHERE number IS NULL;

-- MIGRATION 16
ALTER TABLE cafes ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 1;

-- MIGRATION 17
ALTER TABLE cafes ADD COLUMN password_changed_at INTEGER NOT NULL DEFAULT 0;

-- MIGRATION 18
CREATE TABLE IF NOT EXISTS password_resets (id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id INTEGER, operator_identity TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL, timestamp INTEGER NOT NULL);

-- MIGRATION 19
CREATE TABLE IF NOT EXISTS csrf_tokens (token_hash TEXT PRIMARY KEY, operator_key_hash TEXT NOT NULL, expires INTEGER NOT NULL, created INTEGER NOT NULL);

-- MIGRATION 20
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, count INTEGER NOT NULL, window_start INTEGER NOT NULL, expires INTEGER NOT NULL, updated_at INTEGER NOT NULL);

-- MIGRATION 21
CREATE TABLE IF NOT EXISTS operator_sessions (session_id TEXT PRIMARY KEY, created INTEGER NOT NULL, expires INTEGER NOT NULL);

-- MIGRATION 22
ALTER TABLE rate_limits ADD COLUMN owner TEXT;

-- MIGRATION 23
CREATE TABLE IF NOT EXISTS owner_sessions (session_id TEXT PRIMARY KEY, cafe_id INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL);

-- MIGRATION 24
ALTER TABLE cafes ADD COLUMN owner_auth TEXT NOT NULL DEFAULT 'local';

-- MIGRATION 25
CREATE TABLE IF NOT EXISTS owner_identities (workos_user_id TEXT PRIMARY KEY, email TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL, last_seen INTEGER NOT NULL);

-- MIGRATION 26
CREATE TABLE IF NOT EXISTS cafe_owners (cafe_id INTEGER NOT NULL, workos_user_id TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'owner', created INTEGER NOT NULL, PRIMARY KEY (cafe_id, workos_user_id));

-- MIGRATION 27
CREATE TABLE IF NOT EXISTS owner_login_states (nonce_hash TEXT PRIMARY KEY, cafe_id INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, used_at INTEGER);

-- MIGRATION 28
ALTER TABLE owner_sessions ADD COLUMN workos_user_id TEXT;

-- MIGRATION 29
ALTER TABLE owner_sessions ADD COLUMN workos_session_id TEXT;

-- MIGRATION 30
ALTER TABLE cafes ADD COLUMN auth_mode_generation INTEGER NOT NULL DEFAULT 0;

-- MIGRATION 31
ALTER TABLE cafes ADD COLUMN auth_mode_cas_token TEXT;

-- MIGRATION 32
CREATE TABLE IF NOT EXISTS auth_mode_transitions (cafe_id INTEGER NOT NULL, generation INTEGER NOT NULL, from_mode TEXT NOT NULL, to_mode TEXT NOT NULL, operator_subject TEXT NOT NULL, created INTEGER NOT NULL, PRIMARY KEY (cafe_id, generation));

-- MIGRATION 33
CREATE TABLE IF NOT EXISTS operator_audit (id INTEGER PRIMARY KEY AUTOINCREMENT, cafe_id INTEGER, action TEXT NOT NULL, subject TEXT NOT NULL DEFAULT '', detail TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL);

-- MIGRATION 34
CREATE TABLE IF NOT EXISTS tx_guard (ok INTEGER NOT NULL CHECK (ok = 1));

-- MIGRATION 35
CREATE TRIGGER IF NOT EXISTS cafes_auth_mode_generation_step BEFORE UPDATE OF auth_mode_generation ON cafes WHEN NEW.auth_mode_generation <> OLD.auth_mode_generation + 1 BEGIN SELECT RAISE(ABORT, 'auth_mode_generation_must_step_by_one'); END;

-- MIGRATION 36
ALTER TABLE owner_login_states ADD COLUMN code_verifier_enc TEXT;

-- MIGRATION 37
ALTER TABLE owner_login_states ADD COLUMN claim_hash TEXT;

-- MIGRATION 38
ALTER TABLE owner_login_states ADD COLUMN return_to TEXT;

-- MIGRATION 39
CREATE TABLE IF NOT EXISTS owner_claims (claim_hash TEXT PRIMARY KEY, cafe_id INTEGER NOT NULL, email TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'owner', issued_by TEXT NOT NULL, redeem_token TEXT, created INTEGER NOT NULL, expires INTEGER NOT NULL, used_at INTEGER);

-- MIGRATION 40
CREATE TABLE IF NOT EXISTS provider_revocations (workos_session_id TEXT PRIMARY KEY, cafe_id INTEGER, created INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL, lease_until INTEGER, lease_owner TEXT, expires INTEGER NOT NULL, last_error TEXT NOT NULL DEFAULT '');

-- MIGRATION 41
ALTER TABLE cafes ADD COLUMN auth_version_cas_token TEXT;

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
