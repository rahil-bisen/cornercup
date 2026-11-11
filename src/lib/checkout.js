// The key that makes a retry the same checkout, not a second order. It has to outlive a reload,
// because a reload is exactly the case where the browser may never have seen the server's answer,
// so the key travels with the exact body it belongs to.

function store() {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null; // storage blocked: the order still works, the retry just loses its key
  }
}

// Scoped like the cart, so two tables sharing one browser never share a checkout key.
export function checkoutStorageKey(slug, tableId) {
  return `checkout:${slug || "cafe"}:${tableId ? `table-${tableId}` : "takeaway"}`;
}

export function readCheckout(storageKey) {
  const box = store();
  if (!box) return null;
  try {
    const raw = box.getItem(storageKey);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed.key === "string" && typeof parsed.body === "string" ? parsed : null;
  } catch {
    return null;
  }
}

export function writeCheckout(storageKey, key, body) {
  const box = store();
  if (!box) return;
  try {
    box.setItem(storageKey, JSON.stringify({ key, body }));
  } catch {
    /* quota or blocked */
  }
}

export function clearCheckout(storageKey) {
  const box = store();
  if (!box) return;
  try {
    box.removeItem(storageKey);
  } catch {
    /* ignore */
  }
}

// A pending entry always wins: its request may already be an order on the server, so neither its key
// nor its body is ever replaced. Only clearCheckout() retires it.
export function openCheckout(storageKey, body, mint = () => crypto.randomUUID()) {
  const pending = readCheckout(storageKey);
  if (pending) return pending;

  const key = mint();
  writeCheckout(storageKey, key, body);
  return { key, body };
}

//   submit — nothing pending, this is a fresh checkout
//   replay — the cart is the pending checkout, so re-POST the stored key and body
//   verify — the cart changed; ask the server whether the pending key already became an order
export function checkoutAction(pending, body) {
  if (!pending) return "submit";
  return pending.body === body ? "replay" : "verify";
}

// Resolves a pending checkout that no longer matches the cart. Only a terminal answer from the
// server retires the key: a network or server failure keeps it, so a second order is never created
// on a guess.
export async function abandonPendingCheckout(storageKey, call) {
  const pending = readCheckout(storageKey);
  if (!pending) return { state: "none" };

  try {
    const result = await call(`/api/orders/idempotency/${encodeURIComponent(pending.key)}/abandon`, {
      method: "POST",
      body: pending.body, // the stored original cart, never the edited one
    });
    clearCheckout(storageKey);
    // A committed key always carries an order; never infer abandonment from a missing status field.
    const state = result && result.status ? result.status : result && result.order ? "committed" : "abandoned";
    return { state, order: result && result.order };
  } catch (err) {
    if (err && err.code === "idempotency_key_reused") {
      // The server proved this key belongs to a different payload; it can never be ours.
      clearCheckout(storageKey);
      return { state: "abandoned" };
    }
    if (err && err.code === "checkout_unverified") {
      clearCheckout(storageKey);
      return { state: "unverified" };
    }
    return { state: "unknown", error: err };
  }
}
