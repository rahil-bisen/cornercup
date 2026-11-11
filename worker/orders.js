// Checkout claims: one row per browser checkout, so a retry after a lost reply is the same checkout
// and not a second order. Every statement here is static SQL with positional binds; no statement
// splices a SELECT result into a later statement of the same batch. No imports, so nothing in
// worker/api.js becomes circular.

// How long a claim may sit in 'claimed' before another attempt may take it over. Long enough for a
// normal order round trip, short enough that a Worker killed mid-request does not strand a guest.
export const CLAIM_LEASE_MS = 30_000;

// Mirrors createOrder's rules so both handlers derive the same fingerprint from the same body.
// Checks that need the database (menu ownership, sold out, table ownership) stay in api.js.
export function normalizeCheckoutBody(body, { counter }) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) return { error: "empty" };
  if (rawItems.length > 40) return { error: "too_many" };

  const wanted = new Map();
  for (const item of rawItems) {
    const itemId = Number(item && item.itemId);
    const qty = Math.floor(Number(item && item.qty));
    if (!Number.isFinite(itemId) || !Number.isFinite(qty) || qty < 1) return { error: "item" };
    wanted.set(itemId, Math.min(20, qty + (wanted.get(itemId) || 0)));
  }

  return {
    wanted,
    note: String(body.note || "").trim().slice(0, 300),
    paymentMethod: body.paymentMethod === "counter" ? "counter" : "razorpay",
    tableId: counter ? null : Number(body.tableId),
  };
}

async function digestHex(message) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The canonical form of a checkout: café identity, the café-facing table number (dine-in only), the
// note, the payment method, and every item id with its aggregated quantity in id order. Same cart
// means the same string means the same hash, whatever order the browser listed the lines in.
// Prices are deliberately absent: they belong to the server and a price change must not turn a
// retry into a different checkout.
export async function orderFingerprint({ cafeId, counter, tableId, note, paymentMethod, wanted }) {
  const items = [...wanted.entries()]
    .map(([itemId, qty]) => ({ itemId, qty }))
    .sort((a, b) => a.itemId - b.itemId);

  return digestHex(
    JSON.stringify({
      v: 1,
      cafeId: Number(cafeId),
      tableId: counter ? null : Number(tableId),
      note,
      paymentMethod,
      items,
    })
  );
}

/* --------------------------------------------------------------- statements */

// S1 — reserve the key. changes === 1 means this request owns it.
export function claimStatement(env, { cafeId, key, fingerprint, lease, now }) {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO checkout_claims " +
      "(cafe_id, idempotency_key, fingerprint, state, lease, order_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'claimed', ?, NULL, ?, ?)"
  ).bind(cafeId, key, fingerprint, lease, now, now);
}

// S2
export function claimReadStatement(env, { cafeId, key }) {
  return env.DB.prepare(
    "SELECT state, order_id, fingerprint, lease, updated_at FROM checkout_claims " +
      "WHERE cafe_id = ? AND idempotency_key = ?"
  ).bind(cafeId, key);
}

// S3 — take over a claim whose owner died before committing.
export function takeoverStatement(env, { cafeId, key, fingerprint, lease, now, staleBefore }) {
  return env.DB.prepare(
    "UPDATE checkout_claims SET lease = ?, updated_at = ? " +
      "WHERE cafe_id = ? AND idempotency_key = ? AND state = 'claimed' " +
      "AND fingerprint = ? AND updated_at < ?"
  ).bind(lease, now, cafeId, key, fingerprint, staleBefore);
}

// S4 — give a key back when nothing was written.
export function releaseStatement(env, { cafeId, key, lease }) {
  return env.DB.prepare(
    "DELETE FROM checkout_claims WHERE cafe_id = ? AND idempotency_key = ? " +
      "AND state = 'claimed' AND lease = ?"
  ).bind(cafeId, key, lease);
}

// S5 — the arbitration. The order exists only while this request still owns the claim under its own
// lease, so an abandonment that committed first suppresses the insert entirely (changes === 0,
// nothing thrown) and the counter subquery is never evaluated.
export function orderInsertStatement(env, p) {
  const guard =
    " WHERE EXISTS (SELECT 1 FROM checkout_claims WHERE cafe_id = ? AND idempotency_key = ? " +
    "AND state = 'claimed' AND lease = ? AND fingerprint = ?)";

  if (p.counter) {
    return env.DB.prepare(
      "INSERT INTO orders (id, cafe_id, table_id, table_label, note, status, total_cents, " +
        "payment_method, payment_status, queue_no, idempotency_key, fingerprint, created_at, updated_at) " +
        "SELECT ?, ?, 0, 'Counter', ?, 'new', ?, ?, 'unpaid', " +
        "(SELECT COALESCE(MAX(queue_no), 0) + 1 FROM orders " +
        "WHERE cafe_id = ? AND queue_no IS NOT NULL AND created_at >= ?), ?, ?, ?, ?" +
        guard
    ).bind(
      p.id,
      p.cafeId,
      p.note,
      p.totalCents,
      p.paymentMethod,
      p.cafeId,
      p.dayStart,
      p.key,
      p.fingerprint,
      p.now,
      p.now,
      p.cafeId,
      p.key,
      p.lease,
      p.fingerprint
    );
  }

  return env.DB.prepare(
    "INSERT INTO orders (id, cafe_id, table_id, table_label, note, status, total_cents, " +
      "payment_method, payment_status, queue_no, idempotency_key, fingerprint, created_at, updated_at) " +
      "SELECT ?, ?, ?, ?, ?, 'new', ?, ?, 'unpaid', NULL, ?, ?, ?, ?" +
      guard
  ).bind(
    p.id,
    p.cafeId,
    p.tableId,
    p.tableLabel,
    p.note,
    p.totalCents,
    p.paymentMethod,
    p.key,
    p.fingerprint,
    p.now,
    p.now,
    p.cafeId,
    p.key,
    p.lease,
    p.fingerprint
  );
}

// S6 — attach an item only to the order this batch just wrote. The guard repeats café, key and
// fingerprint because freshOrderId() is a SELECT followed by an INSERT: if S5 were suppressed and the
// generated id happened to collide with an unrelated order, an id-only guard would attach these rows
// to somebody else's ticket.
export function itemInsertStatement(env, p, fail = false) {
  return env.DB.prepare(
    "INSERT INTO order_items (order_id, menu_item_id, name, emoji, price_cents, qty) " +
      "SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (" +
      "SELECT 1 FROM orders WHERE id = ? AND cafe_id = ? AND idempotency_key = ? AND fingerprint = ?)"
  ).bind(
    p.orderId,
    p.menuItemId,
    fail ? null : p.name,
    p.emoji,
    p.priceCents,
    p.qty,
    p.orderId,
    p.cafeId,
    p.key,
    p.fingerprint
  );
}

// S7 — the commit marker, last in the batch, in the same transaction.
export function commitClaimStatement(env, { cafeId, key, lease, orderId, now }) {
  return env.DB.prepare(
    "UPDATE checkout_claims SET state = 'committed', order_id = ?, updated_at = ? " +
      "WHERE cafe_id = ? AND idempotency_key = ? AND state = 'claimed' AND lease = ?"
  ).bind(orderId, now, cafeId, key, lease);
}

// The whole order write, as one transaction: order, every item, then the commit marker.
export function orderBatch(env, p, { failItem = false } = {}) {
  return [
    orderInsertStatement(env, p),
    ...p.items.map((item) =>
      itemInsertStatement(
        env,
        {
          ...item,
          orderId: p.id,
          cafeId: p.cafeId,
          key: p.key,
          fingerprint: p.fingerprint,
        },
        failItem
      )
    ),
    commitClaimStatement(env, { cafeId: p.cafeId, key: p.key, lease: p.lease, orderId: p.id, now: p.now }),
  ];
}

// A1 — the tombstone. Only ever reached when no claim and no order exist for the key, and it makes
// the key permanently unusable for order creation.
export function tombstoneStatement(env, { cafeId, key, fingerprint, now }) {
  return env.DB.prepare(
    "INSERT OR IGNORE INTO checkout_claims " +
      "(cafe_id, idempotency_key, fingerprint, state, lease, order_id, created_at, updated_at) " +
      "VALUES (?, ?, ?, 'abandoned', '', NULL, ?, ?)"
  ).bind(cafeId, key, fingerprint, now, now);
}

// A2 — abandon a live claim. The state guard means a claim that already committed is never touched.
export function abandonClaimStatement(env, { cafeId, key, fingerprint, now }) {
  return env.DB.prepare(
    "UPDATE checkout_claims SET state = 'abandoned', updated_at = ? " +
      "WHERE cafe_id = ? AND idempotency_key = ? AND state = 'claimed' AND fingerprint = ?"
  ).bind(now, cafeId, key, fingerprint);
}
