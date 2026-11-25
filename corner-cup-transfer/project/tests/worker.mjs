// A test-only Worker. It imports the production statements and the production boot, so the batch
// tests exercise the same SQL inside a real env.DB.batch() transaction on their own persistence
// directory. Nothing here is loaded by worker/index.js.

import { ensureDb } from "../../worker/db.js";
import { json, readJson } from "../../worker/http.js";
import { handleApi } from "../../worker/api.js";
import { hashPassword } from "../../worker/cafes.js";
import { HARNESS_OWNER_PASSWORD } from "./credentials.mjs";
import {
  claimStatement,
  claimReadStatement,
  releaseStatement,
  tombstoneStatement,
  abandonClaimStatement,
  orderBatch,
} from "../../worker/orders.js";

export default {
  async fetch(request, env) {
    await ensureDb(env);

    const url = new URL(request.url);

    // The real API, mounted in this process so integration tests share this Worker's D1 and the
    // cafés that /seed creates. It has to run before the body is consumed.
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url, { waitUntil() {} });
    }

    const body = (await readJson(request)) || {};
    const now = new Date().toISOString();

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

      await env.DB.prepare(
        "INSERT INTO cafes (id, slug, name, service_mode, tz_offset_min, pass_hash) VALUES (?, ?, ?, ?, 330, ?)"
      )
        .bind(cafeId, slug, slug, counter ? "counter" : "tables", passHash)
        .run();

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
      await env.DB.prepare("DELETE FROM csrf_tokens").run();
      await env.DB.prepare("DELETE FROM cafes WHERE id = ?").bind(cafeId).run();
      return json({ ok: true });
    }

    // Test-only: corrupt the stored version so the fail-closed path can be exercised. SQLite keeps
    // whatever is written here, including a fraction or text, which is the point.
    if (url.pathname === "/version") {
      await env.DB.prepare("UPDATE cafes SET auth_version = ? WHERE id = ?")
        .bind(body.value, body.cafeId)
        .run();
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
      return json({
        orders: orders.results || [],
        itemCount: Number(items.count),
        claim: await claimReadStatement(env, body).first(),
      });
    }

    return json({ error: "not found" }, 404);
  },
};
