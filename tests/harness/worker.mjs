// A test-only Worker. It imports the production statements and the production boot, so the batch
// tests exercise the same SQL inside a real env.DB.batch() transaction on their own persistence
// directory. Nothing here is loaded by worker/index.js.

import { ensureDb } from "../../worker/db.js";
import { json, readJson } from "../../worker/http.js";
import { handleApi, issueToken } from "../../worker/api.js";
import {
  hashPassword,
  verifyPassword,
  isArgon2Hash,
  passwordNeedsReset,
  PasswordQueueFullError,
} from "../../worker/cafes.js";
import { HARNESS_OWNER_PASSWORD } from "./credentials.mjs";
import {
  authModeTransition,
  authModeTransitionStatements,
  isAuthModeTransitionConflict,
} from "../../worker/authmode.js";
import {
  claimStatement,
  claimReadStatement,
  releaseStatement,
  tombstoneStatement,
  abandonClaimStatement,
  counterPaymentStatement,
  orderBatch,
  paymentStatusSets,
  staffOrderUpdateStatement,
} from "../../worker/orders.js";

// Test-only: a gate lets a test hold a request inside the stubbed gateway, so two requests for the
// same order can be made to overlap deterministically. The stall is real I/O — a fetch to a release
// server the test runs — because the Workers runtime cancels a promise handed between two requests.
const razorpayGates = new Map();

function gateFor(name) {
  if (!razorpayGates.has(name)) razorpayGates.set(name, { entered: 0 });
  return razorpayGates.get(name);
}

// Test-only: when a request carries x-harness-exhaust-order-ids, every order-id existence probe
// reports "taken", so the real createOrder path runs out of bounded attempts. Nothing else about the
// environment is replaced, so the 503, the claim release and the retry are all the production code.
const ID_PROBE_SQL = "SELECT 1 AS found FROM orders WHERE id = ?";

// Test-only: per-key counters for order-batch fault injection, so each test can fail a batch a
// controlled number of times without leaking state across tests.
const orderBatchFailCounts = new Map();

function withExhaustedOrderIds(env, request) {
  if (request.headers.get("x-harness-exhaust-order-ids") !== "1") return env;
  const DB = {
    prepare(sql) {
      if (sql === ID_PROBE_SQL) {
        return { bind: () => ({ first: async () => ({ found: 1 }) }) };
      }
      return env.DB.prepare(sql);
    },
    batch: (statements) => env.DB.batch(statements),
    exec: (sql) => env.DB.exec(sql),
  };
  return { ...env, DB };
}

// Test-only fault injection for operator session D1 operations. Activated only by headers, so normal
// tests are unaffected. Lets D1 failure paths be exercised deterministically.
function withOperatorFault(env, request) {
  const h = request.headers;
  const failRead = h.get("x-harness-fail-operator-read") === "1";
  const failDelete = h.get("x-harness-fail-operator-delete") === "1";
  const failInsert = h.get("x-harness-fail-operator-insert") === "1";
  const failBatch = h.get("x-harness-fail-operator-batch") === "1";
  if (!failRead && !failDelete && !failInsert && !failBatch) return env;

  const throwErr = (label) => new Error(`harness injected ${label} failure`);
  const fakeBound = (label) => ({
    first: async () => { throw throwErr(label); },
    all: async () => { throw throwErr(label); },
    run: async () => { throw throwErr(label); },
  });
  const fakeStmt = (label) => ({
    bind: (..._args) => fakeBound(label),
    first: async () => { throw throwErr(label); },
    all: async () => { throw throwErr(label); },
    run: async () => { throw throwErr(label); },
  });

  const DB = {
    prepare(sql) {
      const s = String(sql || "");
      const isOp = /operator_sessions/i.test(s);
      if (isOp && failRead && /SELECT/i.test(s)) return fakeStmt("read");
      if (isOp && failDelete && /DELETE/i.test(s)) return fakeStmt("delete");
      if (isOp && failInsert && /INSERT/i.test(s)) return fakeStmt("insert");
      const stmt = env.DB.prepare(sql);
      return {
        bind: (...args) => stmt.bind(...args),
        first: () => stmt.first(),
        all: () => stmt.all(),
        run: () => stmt.run(),
      };
    },
    batch(statements) {
      if (failBatch) throw throwErr("batch");
      return env.DB.batch(statements);
    },
    exec: (sql) => env.DB.exec(sql),
  };
  return { ...env, DB };
}

// Test-only fault injection for the settings re-authentication counter. Scoped to `settings:` keys so
// the general API limiter — which runs first on every request — keeps working and the test really does
// reach the handler it is aiming at.
// Test-only fault injection for owner-session D1 operations, so every failure path (read, insert,
// delete, update) can be reached deterministically. Activated only by headers, so ordinary requests
// see the untouched database. Pruning swallows its own errors by design, so a delete fault at login
// does not fail the login — only the paths that must report the failure do.
function withOwnerSessionFault(env, request) {
  const h = request.headers;
  const failRead = h.get("x-harness-fail-owner-session-read") === "1";
  const failInsert = h.get("x-harness-fail-owner-session-insert") === "1";
  const failDelete = h.get("x-harness-fail-owner-session-delete") === "1";
  const failUpdate = h.get("x-harness-fail-owner-session-update") === "1";
  if (!failRead && !failInsert && !failDelete && !failUpdate) return env;

  const throwErr = (label) => new Error(`harness injected ${label} failure`);
  const fakeStmt = (label) => ({
    bind: () => ({
      first: async () => {
        throw throwErr(label);
      },
      all: async () => {
        throw throwErr(label);
      },
      run: async () => {
        throw throwErr(label);
      },
    }),
    first: async () => {
      throw throwErr(label);
    },
    all: async () => {
      throw throwErr(label);
    },
    run: async () => {
      throw throwErr(label);
    },
  });

  const DB = {
    prepare(sql) {
      const s = String(sql || "");
      if (/owner_sessions/i.test(s)) {
        if (failRead && /SELECT/i.test(s)) return fakeStmt("owner session read");
        if (failInsert && /INSERT/i.test(s)) return fakeStmt("owner session insert");
        if (failDelete && /DELETE/i.test(s)) return fakeStmt("owner session delete");
        if (failUpdate && /UPDATE/i.test(s)) return fakeStmt("owner session update");
      }
      return env.DB.prepare(sql);
    },
    batch: (statements) => env.DB.batch(statements),
    exec: (sql) => env.DB.exec(sql),
  };
  return { ...env, DB };
}

function withRateLimitFault(env, request) {
  const failRead = request.headers.get("x-harness-fail-rate-limit-read") === "1";
  const failWrite = request.headers.get("x-harness-fail-rate-limit-write") === "1";
  if (!failRead && !failWrite) return env;

  const boom = (label) => async () => {
    throw new Error(`harness injected ${label} failure`);
  };
  const fakeBound = (label) => ({ first: boom(label), all: boom(label), run: boom(label) });

  const DB = {
    prepare(sql) {
      const s = String(sql || "");
      const isRateLimit = /rate_limits/i.test(s);
      const stmt = env.DB.prepare(sql);
      return {
        bind(...args) {
          const key = String(args[0] == null ? "" : args[0]);
          if (isRateLimit && key.startsWith("settings:")) {
            if (failRead && /^\s*SELECT/i.test(s)) return fakeBound("rate-limit read");
            if (failWrite && /^\s*(INSERT|UPDATE|DELETE)/i.test(s)) return fakeBound("rate-limit write");
          }
          return stmt.bind(...args);
        },
        first: () => stmt.first(),
        all: () => stmt.all(),
        run: () => stmt.run(),
      };
    },
    batch: (statements) => env.DB.batch(statements),
    exec: (sql) => env.DB.exec(sql),
  };
  return { ...env, DB };
}

// Test-only fault injection for the order insertion batch. Activated only by header, so normal
// tests are unaffected. Supports pk-once (throw once then succeed), pk-always (always throw), and
// other (throw a non-PK error once). Per-key counters keep tests isolated.
function withOrderBatchFault(env, request) {
  const mode = request.headers.get("x-harness-order-batch-fail-mode");
  if (!mode) return env;
  const key = request.headers.get("x-harness-order-batch-fail-key") || "global";

  const DB = {
    prepare(sql) {
      const stmt = env.DB.prepare(sql);
      return {
        bind: (...args) => stmt.bind(...args),
        first: () => stmt.first(),
        all: () => stmt.all(),
        run: () => stmt.run(),
      };
    },
    batch(statements) {
      const count = (orderBatchFailCounts.get(key) || 0) + 1;
      orderBatchFailCounts.set(key, count);
      if (mode === "pk-once" && count === 1) {
        throw new Error("D1_ERROR: UNIQUE constraint failed: orders.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)");
      }
      if (mode === "pk-always") {
        throw new Error("D1_ERROR: UNIQUE constraint failed: orders.id: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_PRIMARYKEY)");
      }
      if (mode === "other" && count === 1) {
        throw new Error("D1_ERROR: some unrelated failure");
      }
      return env.DB.batch(statements);
    },
    exec: (sql) => env.DB.exec(sql),
  };
  return { ...env, DB };
}

// In-memory R2-compatible binding for local image tests. Isolated per worker process; no real bucket.
function createFakeR2() {
  const store = new Map();
  const failPut = { value: false };
  return {
    _store: store,
    async put(key, value, opts) {
      if (failPut.value) throw new Error("harness injected R2 put failure");
      let bytes;
      if (value instanceof Uint8Array) bytes = value;
      else if (value instanceof ArrayBuffer) bytes = new Uint8Array(value);
      else if (value && typeof value.arrayBuffer === "function") bytes = new Uint8Array(await value.arrayBuffer());
      else if (typeof value === "string") bytes = new TextEncoder().encode(value);
      else bytes = new Uint8Array(value || []);
      store.set(key, { bytes, httpMetadata: (opts && opts.httpMetadata) || {} });
      return { key, etag: "etag-" + key };
    },
    async get(key) {
      const v = store.get(key);
      if (!v) return null;
      return {
        body: new Response(v.bytes).body,
        httpMetadata: v.httpMetadata,
        etag: "etag-" + key,
        size: v.bytes.length,
        async arrayBuffer() { return v.bytes.buffer.slice(v.bytes.byteOffset, v.bytes.byteOffset + v.bytes.byteLength); },
      };
    },
    async delete(key) {
      if (failPut.value) { /* keep delete working */ }
      store.delete(key);
    },
    async head(key) {
      const v = store.get(key);
      return v ? { key, size: v.bytes.length } : null;
    },
    _setFailPut(v) { failPut.value = v; },
  };
}

// Singleton fake R2 per worker process so it persists across requests.
let fakeR2Instance = null;
function getFakeR2() {
  if (!fakeR2Instance) fakeR2Instance = createFakeR2();
  return fakeR2Instance;
}

// Test-only fault injection for menu_items D1 operations, so upload/remove failure paths can be
// exercised deterministically. Activated only by headers.
function withMenuD1Fault(env, request) {
  const failRead = request.headers.get("x-harness-fail-menu-d1-read") === "1";
  const failWrite = request.headers.get("x-harness-fail-menu-d1-write") === "1";
  if (!failRead && !failWrite) return env;
  const throwErr = (label) => new Error(`harness injected ${label} failure`);
  const DB = {
    prepare(sql) {
      const s = String(sql || "");
      const isMenu = /menu_items/i.test(s);
      if (isMenu) {
        if (failRead && /^\s*SELECT/i.test(s)) {
          const stmt = env.DB.prepare(sql);
          return { bind: () => ({ first: async () => { throw throwErr("menu d1 read"); }, all: async () => { throw throwErr("menu d1 read"); }, run: async () => { throw throwErr("menu d1 read"); } }), first: async () => { throw throwErr("menu d1 read"); }, all: async () => { throw throwErr("menu d1 read"); }, run: async () => { throw throwErr("menu d1 read"); } };
        }
        if (failWrite && /^\s*(INSERT|UPDATE|DELETE)/i.test(s)) {
          const stmt = env.DB.prepare(sql);
          return { bind: () => ({ first: async () => { throw throwErr("menu d1 write"); }, all: async () => { throw throwErr("menu d1 write"); }, run: async () => { throw throwErr("menu d1 write"); } }), first: async () => { throw throwErr("menu d1 write"); }, all: async () => { throw throwErr("menu d1 write"); }, run: async () => { throw throwErr("menu d1 write"); } };
        }
      }
      return env.DB.prepare(sql);
    },
    batch: (statements) => env.DB.batch(statements),
    exec: (sql) => env.DB.exec(sql),
  };
  return { ...env, DB };
}

function withImageBinding(env, request) {
  const h = request.headers;
  const failPut = h.get("x-harness-fail-image-put") === "1";
  const failGet = h.get("x-harness-fail-image-get") === "1";
  const failDelete = h.get("x-harness-fail-image-delete") === "1";
  const r2 = getFakeR2();
  r2._setFailPut(failPut);

  // Wrap to inject get/delete failures.
  const IMAGES = {
    async put(key, value, opts) {
      if (failPut) throw new Error("harness injected R2 put failure");
      return r2.put(key, value, opts);
    },
    async get(key) {
      if (failGet) throw new Error("harness injected R2 get failure");
      return r2.get(key);
    },
    async delete(key) {
      if (failDelete) throw new Error("harness injected R2 delete failure");
      return r2.delete(key);
    },
    async head(key) { return r2.head(key); },
  };

  // Allow tests to disable the binding entirely.
  if (h.get("x-harness-no-image") === "1") {
    const { IMAGES: _omit, ...rest } = env;
    return rest;
  }
  return { ...env, IMAGES };
}

// Test-only: simulate a deployment whose MFA_ENC_KEY is missing or malformed, without editing the
// harness configuration. ADMIN_SECRET stays present, so a request that succeeds would prove a silent
// fallback still exists — which is exactly what these tests must catch.
function withMfaKeyOverride(env, request) {
  const mode = request.headers.get("x-harness-mfa-key");
  if (mode === "missing") return { ...env, MFA_ENC_KEY: undefined };
  if (mode === "malformed") return { ...env, MFA_ENC_KEY: "definitely-not-32-base64url-bytes" };
  return env;
}

export default {
  async fetch(request, env) {
    await ensureDb(env);

    const url = new URL(request.url);

    // The real API, mounted in this process so integration tests share this Worker's D1 and the
    // cafés that /seed creates. It has to run before the body is consumed.
    if (url.pathname.startsWith("/api/")) {
      const env1 = withExhaustedOrderIds(env, request);
      const env2 = withOperatorFault(env1, request);
      const env3 = withOrderBatchFault(env2, request);
      const env4 = withRateLimitFault(env3, request);
      const env5 = withOwnerSessionFault(env4, request);
      const env5b = withMenuD1Fault(env5, request);
      const env6 = withImageBinding(env5b, request);
      const env7 = withMfaKeyOverride(env6, request);
      return handleApi(request, env7, url, { waitUntil() {} });
    }

    const body = (await readJson(request)) || {};
    const now = new Date().toISOString();

    // Test-only: F-07 phase 2A. These mount the production auth-mode statement list against real D1
    // so the batch's atomicity is proven in workerd, not only in an embedded SQLite. Nothing here is
    // reachable from worker/index.js, and no production route uses these SQL statements yet.
    if (url.pathname === "/phase2a/seed") {
      const next = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM cafes").first();
      const cafeId = Number(next.id);
      const mode = body.mode === "workos" ? "workos" : "local";
      const generation = Number.isFinite(Number(body.generation)) ? Number(body.generation) : 0;

      await env.DB.prepare(
        "INSERT INTO cafes (id, slug, name, service_mode, tz_offset_min, pass_hash, owner_auth, auth_mode_generation) " +
          "VALUES (?, ?, ?, 'counter', 330, NULL, ?, ?)"
      )
        .bind(cafeId, `p2a-${cafeId}`, `P2A ${cafeId}`, mode, generation)
        .run();

      if (body.owner !== false) {
        await env.DB.prepare(
          "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, 'user_p2a', 'owner', 1)"
        )
          .bind(cafeId)
          .run();
      }

      const sessions = Number.isFinite(Number(body.sessions)) ? Number(body.sessions) : 2;
      for (let i = 0; i < sessions; i += 1) {
        await env.DB.prepare(
          "INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, 1, 9000000000000)"
        )
          .bind(`p2a-${cafeId}-s${i}`, cafeId)
          .run();
      }

      const live = Number.isFinite(Number(body.liveStates)) ? Number(body.liveStates) : 2;
      for (let i = 0; i < live; i += 1) {
        await env.DB.prepare(
          "INSERT INTO owner_login_states (nonce_hash, cafe_id, created, expires, used_at) VALUES (?, ?, 1, 9000000000000, NULL)"
        )
          .bind(`p2a-${cafeId}-live-${i}`, cafeId)
          .run();
      }
      await env.DB.prepare(
        "INSERT INTO owner_login_states (nonce_hash, cafe_id, created, expires, used_at) VALUES (?, ?, 1, 9000000000000, 500)"
      )
        .bind(`p2a-${cafeId}-spent`, cafeId)
        .run();

      return json({ cafeId });
    }

    if (url.pathname === "/phase2a/transition") {
      let plan;
      try {
        plan = authModeTransition({
          cafeId: body.cafeId,
          oldMode: body.oldMode,
          newMode: body.newMode,
          generation: body.generation,
          operatorSubject: "p2a-operator",
          now: Date.now(),
        });
      } catch (err) {
        return json({ ok: false, error: String((err && err.message) || err), validation: true });
      }

      try {
        await env.DB.batch(authModeTransitionStatements(env, plan));
        return json({ ok: true });
      } catch (err) {
        return json({
          ok: false,
          error: String((err && err.message) || err),
          constraint: isAuthModeTransitionConflict(err),
        });
      }
    }

    // Test-only: everything the transition batch can touch, for one café, in a stable order.
    if (url.pathname === "/phase2a/snapshot") {
      const cafeId = Number(body.cafeId);
      const all = async (sql) => (await env.DB.prepare(sql).bind(cafeId).all()).results || [];

      return json({
        cafe: await env.DB.prepare(
          "SELECT id, owner_auth, auth_mode_generation, auth_mode_cas_token FROM cafes WHERE id = ?"
        )
          .bind(cafeId)
          .first(),
        owners: await all("SELECT cafe_id, workos_user_id, role FROM cafe_owners WHERE cafe_id = ?"),
        sessions: await all("SELECT session_id FROM owner_sessions WHERE cafe_id = ? ORDER BY session_id"),
        states: await all(
          "SELECT nonce_hash, used_at FROM owner_login_states WHERE cafe_id = ? ORDER BY nonce_hash"
        ),
        transitions: await all(
          "SELECT cafe_id, generation, from_mode, to_mode FROM auth_mode_transitions WHERE cafe_id = ? ORDER BY generation"
        ),
        audit: await all(
          "SELECT cafe_id, action, subject, detail FROM operator_audit WHERE cafe_id = ? ORDER BY id"
        ),
        guard: Number(
          (await env.DB.prepare("SELECT COUNT(*) AS value FROM tx_guard").first()).value || 0
        ),
      });
    }

    if (url.pathname === "/seed") {
      const counter = body.serviceMode !== "tables";
      const id = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM cafes").first();
      const cafeId = Number(id.id);
      const slug = `harness-${cafeId}-${Date.now().toString(36)}`;

      // A seeded café carries a real PBKDF2 hash, so the auth suites sign in the way production
      // does. `noPassword` leaves the hash NULL (a café that was never given one) and `rawHash`
      // stores a deliberately unusable value; both prove that sign-in fails closed.
      const passHash = body.noPassword
        ? null
        : body.rawHash != null
          ? String(body.rawHash)
          : await hashPassword(String(body.password || HARNESS_OWNER_PASSWORD));

      const ownerAuth = body.ownerAuth === "workos" ? "workos" : "local";
      await env.DB.prepare(
        "INSERT INTO cafes (id, slug, name, service_mode, tz_offset_min, pass_hash, owner_auth) VALUES (?, ?, ?, ?, 330, ?, ?)"
      )
        .bind(cafeId, slug, slug, counter ? "counter" : "tables", passHash, ownerAuth)
        .run();

      if (body.workosUserId) {
        await env.DB.prepare(
          "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, ?, 'owner', ?) ON CONFLICT(cafe_id, workos_user_id) DO NOTHING"
        )
          .bind(cafeId, String(body.workosUserId), Date.now())
          .run();
      }

      await env.DB.prepare(
        "INSERT INTO menu_items (cafe_id, category, name, description, price_cents, emoji, available, sort) " +
          "VALUES (?, 'Harness', 'Harness Item', '', 10000, '🧪', 1, 10)"
      )
        .bind(cafeId)
        .run();

      const menu = await env.DB.prepare(
        "SELECT id FROM menu_items WHERE cafe_id = ? ORDER BY id ASC LIMIT 1"
      )
        .bind(cafeId)
        .first();

      let tableId = null;
      if (!counter) {
        const next = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM tables").first();
        tableId = Number(next.id);
        await env.DB.prepare(
          "INSERT INTO tables (id, cafe_id, number, label, seats) VALUES (?, ?, 1, 'Harness Table', 4)"
        )
          .bind(tableId, cafeId)
          .run();
      }

      return json({ cafeId, slug, itemId: Number(menu.id), tableId });
    }

    // Test-only: expire every pending TOTP challenge for a café, so challenge-expiry behaviour can be
    // asserted without sleeping five minutes. No production route calls this.
    if (url.pathname === "/totp-challenge/expire") {
      const cafeId = Number(body.cafeId);
      if (!Number.isFinite(cafeId)) return json({ error: "cafeId is required" }, 400);
      const run = await env.DB.prepare(
        "UPDATE owner_totp_challenges SET expires = ? WHERE cafe_id = ?"
      )
        .bind(Date.now() - 1000, cafeId)
        .run();
      return json({ expired: Number(run.meta && run.meta.changes) || 0 });
    }

    if (url.pathname === "/clean") {
      // A café created through the real API has no id in its response, so allow cleaning by slug.
      let cafeId = body.cafeId;
      if ((cafeId === undefined || cafeId === null) && body.slug) {
        const row = await env.DB.prepare("SELECT id FROM cafes WHERE slug = ?").bind(body.slug).first();
        cafeId = row ? row.id : null;
      }
      if (cafeId === undefined || cafeId === null) return json({ ok: true });

      await env.DB.prepare("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE cafe_id = ?)")
        .bind(cafeId)
        .run();
      await env.DB.prepare("DELETE FROM orders WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM checkout_claims WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM menu_items WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM tables WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM password_resets WHERE cafe_id = ?").bind(cafeId).run();
      // Same reused-id problem as the rate-limit counters: a deleted café's session rows would
      // otherwise be inherited by the next /seed that reuses its id.
      await env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ?").bind(cafeId).run();
      // F-07 2B tables. /seed reuses the highest id after a delete, so every per-café row must go or
      // the next café born with that id inherits an owner, a login state, a claim or a provider job.
      await env.DB.prepare("DELETE FROM cafe_owners WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM owner_login_states WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM owner_claims WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM provider_revocations WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM auth_mode_transitions WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM operator_audit WHERE cafe_id = ?").bind(cafeId).run();
      // The second factor lives in three per-café tables, and /seed reuses ids, so a later café must
      // not inherit an enrollment, its spent recovery codes or a pending sign-in challenge.
      await env.DB.prepare("DROP TRIGGER IF EXISTS harness_fail_recovery_insert").run();
      await env.DB.prepare("DELETE FROM owner_totp WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM owner_totp_recovery WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM owner_totp_challenges WHERE cafe_id = ?").bind(cafeId).run();
      await env.DB.prepare("DELETE FROM auth_events WHERE cafe_id = ?").bind(cafeId).run();
      // Rate-limit keys embed the café id, and /seed reuses the highest id after a delete. Without this,
      // a later test could inherit an exhausted login or re-authentication counter from an earlier one.
      await env.DB.prepare("DELETE FROM rate_limits WHERE key LIKE ? OR key LIKE ?")
        .bind(`login:${cafeId}:%`, `settings:${cafeId}:%`)
        .run();
      await env.DB.prepare("DELETE FROM csrf_tokens").run();
      await env.DB.prepare("DELETE FROM cafes WHERE id = ?").bind(cafeId).run();
      return json({ ok: true });
    }

    // Read-only: lets a test prove that a session decision left the credential timestamp alone.
    if (url.pathname === "/password-changed-at") {
      const row = await env.DB.prepare("SELECT password_changed_at FROM cafes WHERE id = ?")
        .bind(body.cafeId)
        .first();
      return json({ passwordChangedAt: row ? Number(row.password_changed_at) : null });
    }

    // Test-only: corrupt the stored version so the fail-closed path can be exercised. SQLite keeps
    // whatever is written here, including a fraction or text, which is the point.
    // Omitting `value` leaves the row alone and only reads it back, so a test can assert a bump that
    // the API performed without writing one itself.
    // Test-only: replace a café's stored hash with an arbitrary value (or NULL). Lets the
    // re-authentication tests exercise the legacy and unsupported-work-factor branches that a normal
    // sign-in can never reach, because sign-in itself refuses those states.
    if (url.pathname === "/set-hash") {
      if (body.cafeId == null) return json({ error: "cafeId is required" }, 400);
      await env.DB.prepare("UPDATE cafes SET pass_hash = ? WHERE id = ?")
        .bind(body.hash == null ? null : String(body.hash), Number(body.cafeId))
        .run();
      return json({ ok: true });
    }

    if (url.pathname === "/version") {
      if (body.value !== undefined) {
        await env.DB.prepare("UPDATE cafes SET auth_version = ? WHERE id = ?")
          .bind(body.value, body.cafeId)
          .run();
      }
      const row = await env.DB.prepare("SELECT auth_version FROM cafes WHERE id = ?").bind(body.cafeId).first();
      return json({ authVersion: row ? row.auth_version : null });
    }

    // Test-only view of what a password reset wrote. The hash is never returned, so a test can check
    // that the password changed without ever holding the stored credential.
    if (url.pathname === "/audit") {
      // A cafe id shows only that cafe's rows; no id shows the rejections that had no cafe to name.
      const resets = await env.DB.prepare(
        "SELECT cafe_id, operator_identity, action, outcome, timestamp FROM password_resets " +
          (body.cafeId == null ? "WHERE cafe_id IS NULL " : "WHERE cafe_id = ? ") +
          "ORDER BY id ASC"
      )
        .bind(...(body.cafeId == null ? [] : [body.cafeId]))
        .all();
      const cafe = body.cafeId == null
        ? null
        : await env.DB.prepare(
            "SELECT id, slug, auth_version, password_changed_at, (pass_hash IS NOT NULL) AS has_password FROM cafes WHERE id = ?"
          )
            .bind(body.cafeId)
            .first();
      const tokens = await env.DB.prepare("SELECT COUNT(*) AS value FROM csrf_tokens").first();
      return json({ resets: resets.results || [], cafe, csrfTokens: Number(tokens && tokens.value) || 0 });
    }

    // The café this Worker bootstrapped from its environment, so a test never has to guess a slug.
    if (url.pathname === "/primary") {
      const row = await env.DB.prepare(
        "SELECT id, slug, name, auth_version, (pass_hash IS NOT NULL) AS has_password " +
          "FROM cafes ORDER BY id ASC LIMIT 1"
      ).first();
      return json({ cafe: row || null });
    }

    // The raw order row, so the tracking tests can prove what is and is not stored.
    // Test-only: run the production counter-payment statement on its own, so the guard can be
    // exercised against a row confirmed after the guest's request read it, deterministically.
    if (url.pathname === "/counter-payment") {
      const result = await counterPaymentStatement(env, {
        cafeId: Number(body.cafeId),
        orderId: String(body.orderId),
        now: new Date().toISOString(),
      }).run();
      const row = await env.DB.prepare(
        "SELECT payment_status, payment_method, paid_at FROM orders WHERE id = ? AND cafe_id = ?"
      )
        .bind(String(body.orderId), Number(body.cafeId))
        .first();
      return json({ changes: Number(result.meta && result.meta.changes) || 0, order: row || null });
    }

    // Test-only: apply the production staff order-update statement with no prior SELECT, which is
    // exactly the write a request that read the row before a confirmation would issue.
    if (url.pathname === "/staff-order-update") {
      const now = new Date().toISOString();
      const parts = paymentStatusSets(String(body.paymentStatus), now);
      const result = await staffOrderUpdateStatement(env, {
        cafeId: Number(body.cafeId),
        orderId: String(body.orderId),
        sets: [...parts.sets, "updated_at = ?"],
        params: [...parts.params, now],
        guardPaid: parts.guardPaid,
      }).run();
      const row = await env.DB.prepare(
        "SELECT payment_status, payment_method, paid_at FROM orders WHERE id = ? AND cafe_id = ?"
      )
        .bind(String(body.orderId), Number(body.cafeId))
        .first();
      return json({ changes: Number(result.meta && result.meta.changes) || 0, order: row || null });
    }

    // Test-only: move a café's session rows to a chosen idle expiry and/or creation instant, without
    // waiting twelve or twenty-four hours. `expiresInMs` places the idle expiry that far ahead (0 =
    // already expired); `createdAgoMs` backdates `created` so the absolute cap can be approached.
    if (url.pathname === "/owner-sessions/expire") {
      const now = Date.now();
      const expires = body.expiresInMs === undefined ? 0 : now + Number(body.expiresInMs);
      const created = body.createdAgoMs === undefined ? null : now - Number(body.createdAgoMs);
      const result =
        created === null
          ? await env.DB.prepare("UPDATE owner_sessions SET expires = ? WHERE cafe_id = ?")
              .bind(expires, Number(body.cafeId))
              .run()
          : await env.DB.prepare("UPDATE owner_sessions SET expires = ?, created = ? WHERE cafe_id = ?")
              .bind(expires, created, Number(body.cafeId))
              .run();
      return json({ changes: Number((result && result.meta && result.meta.changes) || 0), expires, created });
    }

    // Test-only: a correctly signed token in the pre-session (three-part) subject format. It is not a
    // forgery, so its rejection proves the parser itself refuses tokens that name no session row.
    if (url.pathname === "/owner/legacy-token") {
      const cafe = await env.DB.prepare("SELECT id, auth_version FROM cafes WHERE slug = ?")
        .bind(String(body.slug || ""))
        .first();
      if (!cafe) return json({ error: "no such cafe" }, 404);
      return json({ token: await issueToken(env, `cafe:${cafe.id}:${cafe.auth_version}`) });
    }

    // Test-only: what the session store actually holds for one café.
    if (url.pathname === "/owner-sessions") {
      const { results } = await env.DB.prepare(
        "SELECT session_id, cafe_id, created, expires FROM owner_sessions WHERE cafe_id = ? ORDER BY created ASC"
      )
        .bind(Number(body.cafeId))
        .all();
      return json({ sessions: results || [], count: (results || []).length });
    }

    // Test-only CAS race. The café row is read through a gated DB wrapper: the real SELECT runs, the
    // request is held, the café's auth_version is bumped, and only then does the stale read return.
    // The in-flight request therefore performs its compare-and-swap against a version that has already
    // moved — the exact window sign-out-everywhere and password change guard against — and the route
    // reports the resulting rows so a test can prove no replacement session was orphaned.
    if (url.pathname === "/owner/race") {
      const slug = String(body.slug || "").toLowerCase();
      const action = String(body.action || "");
      if (!slug || !action) return json({ error: "slug and action are required" }, 400);

      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let reachedResolve;
      const reached = new Promise((resolve) => {
        reachedResolve = resolve;
      });

      const gatedDb = {
        prepare(sql) {
          const stmt = env.DB.prepare(sql);
          if (!/FROM cafes WHERE slug = \?/i.test(sql)) return stmt;
          return {
            bind(...args) {
              const bound = stmt.bind(...args);
              return {
                async first() {
                  const row = await bound.first();
                  reachedResolve();
                  await gate;
                  return row;
                },
                all: () => bound.all(),
                run: () => bound.run(),
              };
            },
            first: () => stmt.first(),
            all: () => stmt.all(),
            run: () => stmt.run(),
          };
        },
        batch: (statements) => env.DB.batch(statements),
        exec: (sql) => env.DB.exec(sql),
      };

      const method = action === "settings" ? "PATCH" : "POST";
      const path = `/api/cafes/${slug}/admin/${action}`;
      const headers = { "content-type": "application/json", origin: "http://harness" };
      if (body.cookie) headers.cookie = String(body.cookie);
      if (body.csrf) headers["x-csrf-token"] = String(body.csrf);

      const inFlight = handleApi(
        new Request(`http://harness${path}`, {
          method,
          headers,
          body: JSON.stringify(body.body || {}),
        }),
        { ...env, DB: gatedDb },
        new URL(`http://harness${path}`),
        { waitUntil() {} }
      );

      const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000));
      const paused = await Promise.race([reached.then(() => "paused"), timeout]);

      const bump = await env.DB.prepare("UPDATE cafes SET auth_version = auth_version + 1 WHERE slug = ?")
        .bind(slug)
        .run();

      release();
      const response = await Promise.race([inFlight, timeout]);
      if (response === "timeout") return json({ error: "request never completed" }, 500);

      const cafe = await env.DB.prepare("SELECT id, auth_version FROM cafes WHERE slug = ?").bind(slug).first();
      const { results } = await env.DB.prepare(
        "SELECT session_id FROM owner_sessions WHERE cafe_id = ? ORDER BY created ASC"
      )
        .bind(cafe.id)
        .all();

      return json({
        paused: paused === "paused",
        status: response.status,
        body: await response.clone().json().catch(() => null),
        cookie: String(response.headers.get("set-cookie") || "").split(";")[0],
        bumped: Number((bump && bump.meta && bump.meta.changes) || 0),
        authVersion: Number(cafe.auth_version),
        sessionIds: (results || []).map((row) => row.session_id),
      });
    }

    if (url.pathname === "/order-raw") {
      const row = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND cafe_id = ?")
        .bind(String(body.orderId || ""), Number(body.cafeId))
        .first();
      return json({ order: row || null });
    }

    // A row shaped exactly as the code wrote it before tracking existed, so "legacy orders fail closed"
    // can be tested instead of assumed.
    if (url.pathname === "/legacy-order") {
      const id = String(body.orderId || "LEGACY0001");
      await env.DB.prepare(
        "INSERT INTO orders (id, cafe_id, table_id, table_label, note, status, total_cents, created_at, updated_at) " +
          "VALUES (?, ?, 0, 'Counter', '', 'new', 10000, ?, ?)"
      )
        .bind(id, Number(body.cafeId), now, now)
        .run();
      return json({ id });
    }

    if (url.pathname === "/claim") {
      const claimed = await claimStatement(env, { ...body, now }).run();
      return json({
        changes: Number((claimed.meta && claimed.meta.changes) || 0),
        claim: await claimReadStatement(env, body).first(),
      });
    }

    if (url.pathname === "/abandon") {
      // Two real statements, each its own transaction — exactly what the endpoint does.
      const stamped = await tombstoneStatement(env, { ...body, now }).run();
      if (Number((stamped.meta && stamped.meta.changes) || 0) === 1) {
        return json({ via: "tombstone", claim: await claimReadStatement(env, body).first() });
      }
      const moved = await abandonClaimStatement(env, { ...body, now }).run();
      return json({
        via: "update",
        changes: Number((moved.meta && moved.meta.changes) || 0),
        claim: await claimReadStatement(env, body).first(),
      });
    }

    if (url.pathname === "/release") {
      const released = await releaseStatement(env, body).run();
      return json({
        changes: Number((released.meta && released.meta.changes) || 0),
        claim: await claimReadStatement(env, body).first(),
      });
    }

    if (url.pathname === "/batch") {
      try {
        const results = await env.DB.batch(orderBatch(env, { ...body, now }, { failItem: Boolean(body.failItem) }));
        return json({ ok: true, changes: results.map((r) => Number((r && r.meta && r.meta.changes) || 0)) });
      } catch (err) {
        return json({ ok: false, error: String((err && err.message) || err) });
      }
    }

    // Test-only: seed a rate_limits row with an explicit expiry so cleanup behavior can be exercised.
    if (url.pathname === "/rate-limit/seed") {
      const key = String(body.key || "");
      const count = Number.isFinite(Number(body.count)) ? Number(body.count) : 1;
      const expires = Number.isFinite(Number(body.expires)) ? Number(body.expires) : Date.now() - 1000;
      await env.DB.prepare(
        "INSERT OR REPLACE INTO rate_limits (key, count, window_start, expires, updated_at) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(key, count, expires - 1000, expires, Date.now())
        .run();
      return json({ ok: true });
    }

    // Test-only: read one rate_limits row back.
    if (url.pathname === "/rate-limit/row") {
      const row = await env.DB.prepare("SELECT key, count, expires FROM rate_limits WHERE key = ?")
        .bind(String(body.key || ""))
        .first();
      return json({ row: row || null });
    }

    // Test-only: count rows whose key starts with a prefix.
    if (url.pathname === "/rate-limit/count") {
      const prefix = String(body.prefix || "");
      const result = await env.DB.prepare(
        "SELECT COUNT(*) AS value FROM rate_limits WHERE key LIKE ?"
      )
        .bind(`${prefix}%`)
        .first();
      return json({ count: Number((result && result.value) || 0) });
    }

    // Test-only: list rate-limit keys by prefix. A test can find the counter the app actually wrote
    // without duplicating the app's client-IP derivation (wrangler supplies its own cf-connecting-ip).
    if (url.pathname === "/rate-limit/keys") {
      const prefix = String(body.prefix || "");
      const { results } = await env.DB.prepare(
        "SELECT key FROM rate_limits WHERE key LIKE ? ORDER BY key"
      )
        .bind(`${prefix}%`)
        .all();
      return json({ keys: (results || []).map((row) => row.key) });
    }

    if (url.pathname === "/read") {
      const orders = await env.DB.prepare(
        "SELECT id, queue_no, table_id, total_cents FROM orders WHERE cafe_id = ? AND idempotency_key = ?"
      )
        .bind(body.cafeId, body.key)
        .all();
      const items = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE cafe_id = ? AND idempotency_key = ?)"
      )
        .bind(body.cafeId, body.key)
        .first();
      // Each stored snapshot line, so a test can prove that editing the menu changed neither the name
      // nor the price a past order was placed with.
      const rows = orders.results || [];
      for (const row of rows) {
        const lines = await env.DB.prepare(
          "SELECT name, emoji, price_cents, qty FROM order_items WHERE order_id = ? ORDER BY id ASC"
        )
          .bind(row.id)
          .all();
        row.items = lines.results || [];
      }
      return json({
        orders: rows,
        itemCount: Number(items.count),
        claim: await claimReadStatement(env, body).first(),
      });
    }

    // Deterministic login/password-change race. The café row is read through a gated DB wrapper:
    // the real SELECT runs, the login is then held, the password is changed and its auth_version
    // bumped, and only afterwards does the read return. The in-flight login therefore verifies the
    // password it read and stamps its session from the version it read — the exact window the
    // F-07 "capture the version before verification" fix exists for. The test then proves that
    // session is refused by a protected endpoint.
    if (url.pathname === "/race-login") {
      const slug = String(body.slug || "").toLowerCase();
      const password = String(body.password || "");
      const newPassword = String(body.newPassword || "");
      if (!slug || !password || !newPassword) {
        return json({ error: "slug, password and newPassword are required" }, 400);
      }

      const before = await env.DB.prepare("SELECT id, auth_version FROM cafes WHERE slug = ?")
        .bind(slug)
        .first();
      if (!before) return json({ error: "no such cafe" }, 404);

      let release;
      const gate = new Promise((resolve) => {
        release = resolve;
      });
      let reachedResolve;
      const reached = new Promise((resolve) => {
        reachedResolve = resolve;
      });

      const gatedDb = {
        prepare(sql) {
          const stmt = env.DB.prepare(sql);
          // Only the café lookup the login performs is gated; every other statement runs untouched.
          if (!/FROM cafes WHERE slug = \?/i.test(sql)) return stmt;
          return {
            bind(...args) {
              const bound = stmt.bind(...args);
              return {
                async first() {
                  const row = await bound.first();
                  reachedResolve();
                  await gate;
                  return row;
                },
                all: () => bound.all(),
                run: () => bound.run(),
              };
            },
            first: () => stmt.first(),
            all: () => stmt.all(),
            run: () => stmt.run(),
          };
        },
        batch: (statements) => env.DB.batch(statements),
        exec: (sql) => env.DB.exec(sql),
      };

      const url = new Request(`http://harness/api/cafes/${slug}/admin/login`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://harness" },
        body: JSON.stringify({ password }),
      });

      const loginPromise = handleApi(
        url,
        { ...env, DB: gatedDb },
        new URL(`http://harness/api/cafes/${slug}/admin/login`),
        { waitUntil() {} }
      );

      const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), 5000));
      const reachedOrTimeout = await Promise.race([reached.then(() => "paused"), timeout]);

      // The password changes while the login is paused, bumping auth_version as the real reset does.
      const now = Date.now();
      const newHash = await hashPassword(newPassword);
      const changed = await env.DB.prepare(
        "UPDATE cafes SET pass_hash = ?, auth_version = auth_version + 1, password_changed_at = ? WHERE slug = ?"
      )
        .bind(newHash, now, slug)
        .run();

      release();
      const loginResponse = await Promise.race([loginPromise, timeout]);
      if (loginResponse === "timeout") return json({ error: "login never completed" }, 500);

      const after = await env.DB.prepare("SELECT id, auth_version FROM cafes WHERE slug = ?")
        .bind(slug)
        .first();

      return json({
        paused: reachedOrTimeout === "paused",
        loginStatus: loginResponse.status,
        cookie: String(loginResponse.headers.get("set-cookie") || "").split(";")[0],
        cafeId: before.id,
        authVersionBefore: Number(before.auth_version),
        authVersionAfter: after ? Number(after.auth_version) : null,
        passwordRowsChanged: Number((changed && changed.meta && changed.meta.changes) || 0),
      });
    }

    // Test-only: force an order's stored state so eligibility branches can be exercised without
    // pretending a payment happened. Only the columns a test names are written.
    if (url.pathname === "/order-state") {
      if (!body.cafeId || !body.orderId) return json({ error: "cafeId and orderId are required" }, 400);
      const sets = [];
      const binds = [];
      if (body.status != null) {
        sets.push("status = ?");
        binds.push(String(body.status));
      }
      if (body.paymentStatus != null) {
        sets.push("payment_status = ?");
        binds.push(String(body.paymentStatus));
      }
      if (body.paymentMethod != null) {
        sets.push("payment_method = ?");
        binds.push(String(body.paymentMethod));
      }
      if (body.paymentRef != null) {
        sets.push("payment_ref = ?");
        binds.push(String(body.paymentRef));
      }
      // No fields means read-only, which lets a test assert stored state without another route.
      if (sets.length) {
        await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ? AND cafe_id = ?`)
          .bind(...binds, body.orderId, body.cafeId)
          .run();
      }
      const row = await env.DB.prepare(
        "SELECT id, status, payment_status, payment_method, payment_ref, total_cents FROM orders WHERE id = ? AND cafe_id = ?"
      )
        .bind(body.orderId, body.cafeId)
        .first();
      return json({ order: row || null });
    }

    // Test-only: password primitives, exercised in workerd because the Argon2id module imports wasm
    // binaries that Node cannot load. Nothing here is reachable from worker/index.js.
    if (url.pathname === "/passwords/hash") {
      try {
        return json({ stored: await hashPassword(String(body.password || "")) });
      } catch (err) {
        if (err instanceof PasswordQueueFullError) return json({ error: "queue full" }, 429);
        throw err;
      }
    }

    if (url.pathname === "/passwords/verify") {
      try {
        const ok = await verifyPassword(String(body.password || ""), String(body.stored || ""));
        return json({ ok, needsReset: passwordNeedsReset(body.stored), argon2: isArgon2Hash(body.stored) });
      } catch (err) {
        if (err instanceof PasswordQueueFullError) return json({ error: "queue full" }, 429);
        throw err;
      }
    }

    if (url.pathname === "/passwords/burst") {
      // Overlapping hashes inside one invocation: the bounded queue must accept the running hash plus
      // a fixed number of waiters and reject the rest instead of queueing without limit.
      const results = await Promise.all(
        Array.from({ length: Math.min(Number(body.n || 6), 10) }, async () => {
          try {
            await hashPassword("burst-password");
            return "ok";
          } catch (err) {
            if (err instanceof PasswordQueueFullError) return "full";
            return "error";
          }
        })
      );
      return json({
        ok: results.filter((r) => r === "ok").length,
        full: results.filter((r) => r === "full").length,
        error: results.filter((r) => r === "error").length,
      });
    }

    // Test-only: mount the real handleApi with Razorpay credentials added to this one request's env,
    // and a stubbed gateway so no network call leaves the process. The production env is untouched, so
    // every other harness test keeps running with online payments switched off.
    if (url.pathname === "/razorpay-probe") {
      if (!body.path) return json({ error: "path is required" }, 400);

      const calls = [];
      const realFetch = globalThis.fetch;
      const stub = body.gateway || {};
      globalThis.fetch = async (target, init) => {
        calls.push({
          url: String(target),
          method: (init && init.method) || "GET",
          // The credential itself is never returned to a test, only whether one was sent.
          hasAuth: Boolean(init && init.headers && init.headers.authorization),
          body: init && init.body ? String(init.body) : null,
        });
        if (body.gateUrl) {
          gateFor(body.gateName || "default").entered += 1;
          // The signal is forwarded so an aborted caller aborts this wait too, exactly as it would
          // abort a real gateway request.
          await realFetch(body.gateUrl, init && init.signal ? { signal: init.signal } : undefined);
        }
        if (stub.delayMs) {
          await new Promise((resolve) => setTimeout(resolve, Number(stub.delayMs)));
        }
        return new Response(JSON.stringify(stub.response === undefined ? { id: `rzp_harness_${calls.length}` } : stub.response), {
          status: stub.status === undefined ? 200 : stub.status,
          headers: { "content-type": "application/json" },
        });
      };

      try {
        const target = new URL(body.path, url.origin);
        const headers = { ...(body.headers || {}) };
        if (body.body !== undefined && body.body !== null && !headers["content-type"]) {
          headers["content-type"] = "application/json";
        }
        const request2 = new Request(target, {
          method: body.method || "POST",
          headers,
          body: body.body === undefined || body.body === null ? undefined : JSON.stringify(body.body),
        });
        const response = await handleApi(request2, { ...env, RAZORPAY_KEY_ID: "rzp_test_harness", RAZORPAY_KEY_SECRET: "harness-razorpay-secret" }, target, {
          waitUntil() {},
        });
        return json({ status: response.status, body: await response.json().catch(() => null), gateway: calls });
      } finally {
        globalThis.fetch = realFetch;
      }
    }

    // Test-only: how many gateway calls are currently waiting behind a named gate, so a test can
    // know the first request has definitely reached the gateway before sending the second.
    if (url.pathname === "/gate") {
      const gate = razorpayGates.get(body.name);
      return json({ entered: gate ? gate.entered : 0 });
    }

    // Test-only: write or clear an arbitrary rate_limits row, so an expired payment claim (a Worker
    // that died mid-call) can be simulated without waiting for its 30-second lifetime.
    if (url.pathname === "/rate-row") {
      if (!body.key) return json({ error: "key is required" }, 400);
      if (body.read) {
        const row = await env.DB.prepare(
          "SELECT key, count, window_start, expires, updated_at, owner FROM rate_limits WHERE key = ?"
        )
          .bind(body.key)
          .first();
        return json({ row: row || null });
      }
      if (body.clear) {
        await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(body.key).run();
        return json({ ok: true });
      }
      const now = Date.now();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO rate_limits (key, count, window_start, expires, updated_at, owner) VALUES (?, 1, ?, ?, ?, ?)"
      )
        .bind(body.key, now, Number(body.expires), now, body.owner == null ? null : String(body.owner))
        .run();
      return json({ ok: true });
    }

    // Test-only: mint a signed token whose subject is the legacy bare "operator" string, so the
    // F-10 rejection of pre-session tokens can be exercised. Uses the production signer.
    if (url.pathname === "/operator/legacy-token") {
      const token = await issueToken(env, "operator");
      return json({ token });
    }

    // Test-only: expire every operator session row, so an expired-session rejection can be tested.
    if (url.pathname === "/operator/expire-sessions") {
      await env.DB.prepare("UPDATE operator_sessions SET expires = ?").bind(Date.now() - 1000).run();
      return json({ ok: true });
    }

    // ---------------------------------------------------------------- F-07 2B probes
    // Test-only. Everything below is unreachable from worker/index.js.

    // Mount the real API with WorkOS configuration for this one request, so the owner routes can be
    // driven over HTTP without putting a provider secret in the harness environment.
    if (url.pathname === "/owner-probe") {
      if (!body.path) return json({ error: "path is required" }, 400);
      const workos = body.workos || {};
      const target = new URL(body.path, url.origin);
      const request2 = new Request(target, {
        method: body.method || "GET",
        headers: { ...(body.headers || {}) },
        body: body.body === undefined || body.body === null ? undefined : JSON.stringify(body.body),
      });
      let response;
      try {
        response = await handleApi(
        request2,
        {
          ...env,
          WORKOS_CLIENT_ID: workos.clientId,
          WORKOS_API_KEY: workos.apiKey,
          WORKOS_REDIRECT_URI: workos.redirectUri,
          WORKOS_ISSUER: workos.issuer,
          WORKOS_AUDIENCE: workos.audience,
          WORKOS_STATE_ENCRYPTION_KEY: workos.stateKey,
          WORKOS_API_BASE: workos.apiBase,
        },
        target,
        { waitUntil() {} }
        );
      } catch (err) {
        return json({ status: 0, probeError: String((err && err.stack) || err) }, 500);
      }
      return json({
        status: response.status,
        sentCookie: request2.headers.get("cookie"),
        location: response.headers.get("location"),
        setCookie: response.headers.get("set-cookie"),
        body: await response.clone().json().catch(() => null),
      });
    }

    if (url.pathname === "/owner-mode") {
      await env.DB.prepare("UPDATE cafes SET owner_auth = ? WHERE slug = ?")
        .bind(body.mode === "workos" ? "workos" : "local", String(body.slug || ""))
        .run();
      return json({ ok: true });
    }

    if (url.pathname === "/owner-membership") {
      const cafe = await env.DB.prepare("SELECT id FROM cafes WHERE slug = ?").bind(String(body.slug || "")).first();
      if (!cafe) return json({ error: "no such cafe" }, 404);
      if (body.remove) {
        await env.DB.prepare("DELETE FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?")
          .bind(cafe.id, String(body.workosUserId || ""))
          .run();
        return json({ ok: true });
      }
      await env.DB.prepare(
        "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, ?, 'owner', ?) ON CONFLICT(cafe_id, workos_user_id) DO NOTHING"
      )
        .bind(cafe.id, String(body.workosUserId || ""), Date.now())
        .run();
      return json({ cafeId: cafe.id });
    }

    // Inserts a session row (optionally carrying a provider sid) and mints the matching cookie, so the
    // sign-out paths can be driven without a provider round trip.
    if (url.pathname === "/owner-session") {
      const cafe = await env.DB.prepare("SELECT id, slug, auth_version FROM cafes WHERE slug = ?")
        .bind(String(body.slug || ""))
        .first();
      if (!cafe) return json({ error: "no such cafe" }, 404);
      const sessionId = String(body.sessionId || "").padEnd(32, "0").slice(0, 32);
      if (!/^[0-9a-f]{32}$/.test(sessionId)) return json({ error: "sessionId must be 32 hex" }, 400);
      const now = Date.now();
      await env.DB.prepare(
        "INSERT OR REPLACE INTO owner_sessions (session_id, cafe_id, created, expires, workos_user_id, workos_session_id) VALUES (?, ?, ?, ?, ?, ?)"
      )
        .bind(sessionId, cafe.id, now, now + 12 * 60 * 60 * 1000, body.workosUserId || null, body.workosSessionId || null)
        .run();
      const cookie = await issueToken(env, `cafe:${cafe.id}:${cafe.auth_version}:${sessionId}`);
      return json({ ok: true, sessionId, cookie: `staff_session_${cafe.slug}=${cookie}` });
    }

    // Issue a CSRF token bound to an existing owner session, without going through the board.
    if (url.pathname === "/owner-csrf") {
      const { issueCsrfToken } = await import("../../worker/session.js");
      const token = await issueCsrfToken(env, String(body.sessionId || ""));
      return json({ token });
    }

    if (url.pathname === "/owner-expire-states") {
      const cafe = await env.DB.prepare("SELECT id FROM cafes WHERE slug = ?")
        .bind(String(body.slug || ""))
        .first();
      if (!cafe) return json({ error: "no such cafe" }, 404);
      const result = await env.DB.prepare("UPDATE owner_login_states SET expires = ? WHERE cafe_id = ?")
        .bind(Date.now() - 1000, cafe.id)
        .run();
      return json({ ok: true, changes: Number((result && result.meta && result.meta.changes) || 0) });
    }

    if (url.pathname === "/owner-snapshot") {
      const cafe = await env.DB.prepare("SELECT id FROM cafes WHERE slug = ?").bind(String(body.slug || "")).first();
      if (!cafe) return json({ error: "no such cafe" }, 404);
      // `owner_identities` is provider-wide and has no cafe_id, so it takes no bindings.
      const rows = async (sql, ...args) =>
        (args.length ? await env.DB.prepare(sql).bind(...args).all() : await env.DB.prepare(sql).all()).results || [];
      return json({
        sessions: await rows("SELECT session_id, workos_user_id, workos_session_id FROM owner_sessions WHERE cafe_id = ? ORDER BY session_id", cafe.id),
        identities: await rows("SELECT workos_user_id, email FROM owner_identities"),
        owners: await rows("SELECT workos_user_id, role FROM cafe_owners WHERE cafe_id = ?", cafe.id),
        states: await rows("SELECT nonce_hash, used_at, (code_verifier_enc IS NOT NULL) AS encrypted, claim_hash FROM owner_login_states WHERE cafe_id = ?", cafe.id),
        claims: await rows("SELECT claim_hash, email, used_at FROM owner_claims WHERE cafe_id = ?", cafe.id),
        revocations: await rows("SELECT workos_session_id, attempts, next_attempt FROM provider_revocations WHERE cafe_id = ?", cafe.id),
      });
    }

    // A claim row, for the claim-redemption path (the code is returned so the test can present it).
    if (url.pathname === "/owner-claim") {
      const cafe = await env.DB.prepare("SELECT id FROM cafes WHERE slug = ?").bind(String(body.slug || "")).first();
      if (!cafe) return json({ error: "no such cafe" }, 404);
      const { claimDigest } = await import("../../worker/pkce.js");
      const code = String(body.code || "harness-claim-code");
      await env.DB.prepare(
        "INSERT OR REPLACE INTO owner_claims (claim_hash, cafe_id, email, role, issued_by, created, expires) VALUES (?, ?, ?, 'owner', 'harness', ?, ?)"
      )
        .bind(await claimDigest(code), cafe.id, String(body.email || ""), Date.now(), Date.now() + 3600_000)
        .run();
      return json({ ok: true, code });
    }

    // Test-only: the stored second-factor state, hashes only. A recovery code's plaintext is never in
    // the database, and this returns every row so a test can prove exactly that. `events` exposes the
    // audit trail for the same reason: no code may have been written there either.
    if (url.pathname === "/mfa-state") {
      const cafe = await env.DB.prepare("SELECT id FROM cafes WHERE slug = ?")
        .bind(String(body.slug || ""))
        .first();
      if (!cafe) return json({ error: "no such cafe" }, 404);
      const totp = await env.DB.prepare(
        "SELECT confirmed_at, last_used_step FROM owner_totp WHERE cafe_id = ?"
      )
        .bind(cafe.id)
        .first();
      const codes = await env.DB.prepare(
        "SELECT code_hash, created, used_at FROM owner_totp_recovery WHERE cafe_id = ? ORDER BY code_hash"
      )
        .bind(cafe.id)
        .all();
      const events = await env.DB.prepare(
        "SELECT kind, detail FROM auth_events WHERE cafe_id = ? ORDER BY id"
      )
        .bind(cafe.id)
        .all();
      return json({
        totp: totp
          ? { confirmed: Boolean(totp.confirmed_at), lastUsedStep: totp.last_used_step }
          : null,
        codes: (codes.results || []).map((row) => ({
          hash: row.code_hash,
          created: Number(row.created),
          used: row.used_at != null,
        })),
        events: (events.results || []).map((row) => ({ kind: row.kind, detail: row.detail })),
      });
    }

    // Test-only: arm a trigger that aborts every insert into owner_totp_recovery, so the production
    // replacement batch fails inside D1 and its rollback can be observed. `off` disarms it.
    if (url.pathname === "/mfa-break") {
      await env.DB.prepare("DROP TRIGGER IF EXISTS harness_fail_recovery_insert").run();
      if (body.off) return json({ ok: true, armed: false });
      await env.DB.prepare(
        "CREATE TRIGGER harness_fail_recovery_insert BEFORE INSERT ON owner_totp_recovery " +
          "BEGIN SELECT RAISE(ABORT, 'harness induced recovery insert failure'); END"
      ).run();
      return json({ ok: true, armed: true });
    }

    // Force a queued revocation due now / expired, so retry and expiry can be exercised quickly.
    if (url.pathname === "/owner-revocation") {
      if (body.slug) {
        const cafe = await env.DB.prepare("SELECT id FROM cafes WHERE slug = ?").bind(String(body.slug)).first();
        if (!cafe) return json({ error: "no such cafe" }, 404);
        if (body.seed) {
          await env.DB.prepare(
            "INSERT OR REPLACE INTO provider_revocations (workos_session_id, cafe_id, created, attempts, next_attempt, lease_until, lease_owner, expires, last_error) VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, '')"
          )
            .bind(String(body.seed), cafe.id, Date.now(), Number(body.attempts || 0), Number(body.nextAttempt || Date.now()), Number(body.expires || Date.now() + 86400000))
            .run();
        }
        if (body.clear) await env.DB.prepare("DELETE FROM provider_revocations WHERE cafe_id = ?").bind(cafe.id).run();
        if (body.dueNow) {
          await env.DB.prepare("UPDATE provider_revocations SET next_attempt = ?, lease_until = NULL WHERE cafe_id = ?")
            .bind(Number(body.dueNow), cafe.id)
            .run();
        }
        const { results } = await env.DB.prepare(
          "SELECT workos_session_id, attempts, next_attempt, lease_until, expires FROM provider_revocations WHERE cafe_id = ? ORDER BY workos_session_id"
        )
          .bind(cafe.id)
          .all();
        return json({ jobs: results || [] });
      }
      const { results } = await env.DB.prepare(
        "SELECT workos_session_id, attempts, next_attempt, lease_until, expires FROM provider_revocations ORDER BY workos_session_id"
      ).all();
      return json({ jobs: results || [] });
    }

    return json({ error: "not found" }, 404);
  },
};
