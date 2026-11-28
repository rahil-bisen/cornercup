// Checkout claims: one row per browser checkout, so a retry after a lost reply is the same checkout
// and not a second order. Every statement here is static SQL with positional binds; no statement
// splices a SELECT result into a later statement of the same batch. No imports, so nothing in
// worker/api.js becomes circular.

// How long a claim may sit in 'claimed' before another attempt may take it over. Long enough for a
// normal order round trip, short enough that a Worker killed mid-request does not strand a guest.
export const CLAIM_LEASE_MS = 30_000;

// Mirrors createOrder's rules so both handlers derive the same fingerprint from the same body.
// Checks that need the database (menu ownership, sold out, table ownership) stay in api.js.
// The longest note a guest may attach to one dish.
export const ITEM_NOTE_MAX = 120;

export function normalizeCheckoutBody(body, { counter }) {
  const rawItems = Array.isArray(body.items) ? body.items : [];
  if (rawItems.length === 0) return { error: "empty" };
  if (rawItems.length > 40) return { error: "too_many" };
  const paymentMethod = body.paymentMethod === undefined ? "counter" : body.paymentMethod;
  if (paymentMethod !== "counter" && paymentMethod !== "razorpay") return { error: "payment_method" };

  const wanted = new Map();
  // A guest's note for one dish ("less sugar"), kept per item id. Two lines for the same item keep both
  // notes, in the order sent, so the kitchen never loses one.
  const notes = new Map();
  for (const item of rawItems) {
    const itemId = Number(item && item.itemId);
    const qty = Math.floor(Number(item && item.qty));
    if (!Number.isFinite(itemId) || !Number.isFinite(qty) || qty < 1) return { error: "item" };
    if (item.note !== undefined && item.note !== null && typeof item.note !== "string") return { error: "item" };
    wanted.set(itemId, Math.min(20, qty + (wanted.get(itemId) || 0)));
    const note = String(item.note || "").replace(/\s+/g, " ").trim().slice(0, ITEM_NOTE_MAX);
    if (note) notes.set(itemId, notes.has(itemId) ? `${notes.get(itemId)}; ${note}`.slice(0, ITEM_NOTE_MAX) : note);
  }

  return {
    wanted,
    notes,
    note: String(body.note || "").trim().slice(0, 300),
    paymentMethod,
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
// A per-item note is part of the checkout, so it is part of the fingerprint, but only when there is
// one: a cart without item notes hashes exactly as it did before notes existed.
export async function orderFingerprint({ cafeId, counter, tableId, note, paymentMethod, wanted, notes = new Map() }) {
  const items = [...wanted.entries()]
    .map(([itemId, qty]) => (notes.get(itemId) ? { itemId, qty, note: notes.get(itemId) } : { itemId, qty }))
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

/* ------------------------------------------------------------- daily numbers */

// The café's own calendar day for a moment in time: its date ("2026-11-28") and the UTC instants
// where that day starts and ends. A café's order numbers restart at 1 when this date changes, which is
// local midnight for that café, not UTC midnight.
export function cafeDay(nowMs, tzOffsetMinutes) {
  const offset = Number.isFinite(Number(tzOffsetMinutes)) ? Number(tzOffsetMinutes) : 330;
  const local = nowMs + offset * 60_000;
  const midnight = Math.floor(local / 86_400_000) * 86_400_000;
  return {
    businessDate: new Date(midnight).toISOString().slice(0, 10),
    dayStart: new Date(midnight - offset * 60_000).toISOString(),
    dayEnd: new Date(midnight + 86_400_000 - offset * 60_000).toISOString(),
  };
}

// The next daily number, computed inside the INSERT itself, so no other statement can run between
// reading the highest number and writing the next one. It counts this café's orders for this business
// date, plus (on the day this feature ships) the café's orders from earlier the same day that were
// numbered before business_date existed, so today's numbering carries on instead of restarting at 1.
// The partial unique index idx_orders_daily_number backs this up: a duplicate can never be stored.
const DAILY_NUMBER =
  "(SELECT COALESCE(MAX(queue_no), 0) + 1 FROM orders WHERE cafe_id = ? AND queue_no IS NOT NULL " +
  "AND (business_date = ? OR (business_date IS NULL AND created_at >= ? AND created_at < ?)))";

// S5 — the arbitration. The order exists only while this request still owns the claim under its own
// lease, so an abandonment that committed first suppresses the insert entirely (changes === 0,
// nothing thrown) and the number subquery is never evaluated. Every order, dine-in or counter, gets
// the café's next daily number.
export function orderInsertStatement(env, p) {
  const day = p.businessDate
    ? { businessDate: p.businessDate, dayStart: p.dayStart, dayEnd: p.dayEnd }
    : cafeDay(Number.isFinite(Date.parse(p.now)) ? Date.parse(p.now) : Date.now(), p.tzOffsetMin);
  const guard =
    " WHERE EXISTS (SELECT 1 FROM checkout_claims WHERE cafe_id = ? AND idempotency_key = ? " +
    "AND state = 'claimed' AND lease = ? AND fingerprint = ?)";

  return env.DB.prepare(
    "INSERT INTO orders (id, cafe_id, table_id, table_label, note, status, total_cents, " +
      "payment_method, payment_status, queue_no, business_date, idempotency_key, fingerprint, track_nonce, " +
      "track_hash, created_at, updated_at) " +
      "SELECT ?, ?, ?, ?, ?, 'new', ?, ?, 'unpaid', " +
      DAILY_NUMBER +
      ", ?, ?, ?, ?, ?, ?, ?" +
      guard
  ).bind(
    p.id,
    p.cafeId,
    p.counter ? 0 : p.tableId,
    p.counter ? "Counter" : p.tableLabel,
    p.note,
    p.totalCents,
    p.paymentMethod,
    p.cafeId,
    day.businessDate,
    day.dayStart,
    day.dayEnd,
    day.businessDate,
    p.key,
    p.fingerprint,
    p.trackNonce == null ? null : p.trackNonce,
    p.trackHash == null ? null : p.trackHash,
    p.now,
    p.now,
    p.cafeId,
    p.key,
    p.lease,
    p.fingerprint
  );
}

// True when a write failed only because another order took the same daily number at the same moment.
// The insert computes the number itself, so this should never happen; if it ever does, the unique
// index has refused the duplicate and the caller may simply try again, which reads the new maximum.
export function isDailyNumberCollision(err) {
  const message = String((err && err.message) || err || "");
  return /UNIQUE constraint failed:\s*orders\.cafe_id,\s*orders\.business_date,\s*orders\.queue_no/i.test(message);
}

// S6 — attach an item only to the order this batch just wrote. The guard repeats café, key and
// fingerprint because freshOrderId() is a SELECT followed by an INSERT: if S5 were suppressed and the
// generated id happened to collide with an unrelated order, an id-only guard would attach these rows
// to somebody else's ticket.
export function itemInsertStatement(env, p, fail = false) {
  return env.DB.prepare(
    "INSERT INTO order_items (order_id, menu_item_id, name, emoji, price_cents, qty, note) " +
      "SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (" +
      "SELECT 1 FROM orders WHERE id = ? AND cafe_id = ? AND idempotency_key = ? AND fingerprint = ?)"
  ).bind(
    p.orderId,
    p.menuItemId,
    fail ? null : p.name,
    p.emoji,
    p.priceCents,
    p.qty,
    p.note || "",
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

// A staff payment-status change, split into the SET fragments it always uses so the handler and the
// test harness apply exactly the same statement. `guardPaid` is true for the values that assert the
// ticket is not paid: "unpaid", "submitted" and "failed" must never undo a confirmed payment.
// "counter" and "confirmed" both mean money was taken, so they stay unguarded — correcting the rail is
// not a downgrade.
export function paymentStatusSets(paymentStatus, now) {
  if (paymentStatus === "counter") {
    return {
      sets: ["payment_status = ?", "payment_method = 'counter'", "paid_at = ?"],
      params: [paymentStatus, now],
      guardPaid: false,
    };
  }
  if (paymentStatus === "confirmed") {
    return { sets: ["payment_status = ?", "paid_at = ?"], params: [paymentStatus, now], guardPaid: false };
  }
  return { sets: ["payment_status = ?", "paid_at = NULL"], params: [paymentStatus], guardPaid: true };
}

// The staff order update as one statement. When the new payment status would un-pay a ticket, the
// guard is part of the WHERE clause, so a payment confirmed between the request's read and this write
// cannot be overwritten: zero changed rows means "already paid", never "try again".
export function staffOrderUpdateStatement(env, { cafeId, orderId, sets, params, guardPaid }) {
  const guard = guardPaid ? " AND payment_status != 'confirmed'" : "";
  return env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ? AND cafe_id = ?${guard}`).bind(
    ...params,
    orderId,
    cafeId
  );
}

// The guest's pay-at-counter choice, as one guarded statement. `payment_status != 'confirmed'` is
// evaluated inside the write, not by a read before it, so a payment the gateway or staff confirmed
// concurrently is never replaced. Zero changed rows is therefore "already paid", never "retry".
export function counterPaymentStatement(env, { cafeId, orderId, now }) {
  return env.DB.prepare(
    "UPDATE orders SET payment_method = 'counter', payment_status = 'counter', updated_at = ? " +
      "WHERE id = ? AND cafe_id = ? AND payment_status != 'confirmed'"
  ).bind(now, orderId, cafeId);
}
