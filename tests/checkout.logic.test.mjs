import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const { normalizeCheckoutBody, orderFingerprint } = await import("../worker/orders.js");
const { checkoutAction, checkoutStorageKey, clearCheckout, openCheckout, readCheckout } = await import(
  "../src/lib/checkout.js"
);

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
  };
}

test("normalise aggregates duplicate item ids and caps a line at 20", () => {
  const out = normalizeCheckoutBody(
    { tableId: "3", note: "  no sugar  ", paymentMethod: "razorpay", items: [{ itemId: 7, qty: 2 }, { itemId: 7, qty: 3 }, { itemId: 4, qty: 40 }] },
    { counter: false }
  );

  assert.equal(out.error, undefined);
  assert.equal(out.note, "no sugar");
  assert.equal(out.tableId, 3);
  assert.deepEqual([...out.wanted.entries()].sort((a, b) => a[0] - b[0]), [[4, 20], [7, 5]]);
});

test("normalise rejects empty, oversized and malformed carts", () => {
  assert.equal(normalizeCheckoutBody({ items: [] }, { counter: false }).error, "empty");
  assert.equal(
    normalizeCheckoutBody({ items: Array.from({ length: 41 }, () => ({ itemId: 1, qty: 1 })) }, { counter: false }).error,
    "too_many"
  );
  assert.equal(normalizeCheckoutBody({ items: [{ itemId: 1, qty: 0 }] }, { counter: false }).error, "item");
  assert.equal(normalizeCheckoutBody({ items: [{ itemId: "x", qty: 1 }] }, { counter: false }).error, "item");
});

test("payment method defaults to counter and rejects unsupported values", () => {
  const items = [{ itemId: 7, qty: 1 }];
  assert.equal(normalizeCheckoutBody({ items }, { counter: false }).paymentMethod, "counter");
  assert.equal(
    normalizeCheckoutBody({ items, paymentMethod: "gift-card" }, { counter: false }).error,
    "payment_method"
  );
});

test("counter mode ignores a table, dine-in keeps its number", () => {
  const items = [{ itemId: 7, qty: 1 }];
  const counter = normalizeCheckoutBody({ tableId: 3, items }, { counter: true });
  const dineIn = normalizeCheckoutBody({ tableId: "3", items }, { counter: false });

  assert.equal(counter.tableId, null);
  assert.equal(dineIn.tableId, 3);
});

test("the fingerprint ignores line order but not cart contents", async () => {
  const a = normalizeCheckoutBody({ tableId: 1, note: "", paymentMethod: "razorpay", items: [{ itemId: 7, qty: 2 }, { itemId: 4, qty: 1 }] }, { counter: false });
  const b = normalizeCheckoutBody({ tableId: 1, note: "", paymentMethod: "razorpay", items: [{ itemId: 4, qty: 1 }, { itemId: 7, qty: 2 }] }, { counter: false });
  const c = normalizeCheckoutBody({ tableId: 1, note: "", paymentMethod: "razorpay", items: [{ itemId: 7, qty: 3 }] }, { counter: false });

  const base = { cafeId: 1, counter: false, tableId: 1, note: "", paymentMethod: "razorpay" };
  assert.equal(await orderFingerprint({ ...base, wanted: a.wanted }), await orderFingerprint({ ...base, wanted: b.wanted }));
  assert.notEqual(await orderFingerprint({ ...base, wanted: a.wanted }), await orderFingerprint({ ...base, wanted: c.wanted }));
});

test("the fingerprint covers café, table, note and payment method", async () => {
  const wanted = new Map([[7, 1]]);
  const base = { cafeId: 1, counter: false, tableId: 1, note: "", paymentMethod: "razorpay" };
  const root = await orderFingerprint({ ...base, wanted });

  assert.notEqual(root, await orderFingerprint({ ...base, cafeId: 2, wanted }), "café identity");
  assert.notEqual(root, await orderFingerprint({ ...base, tableId: 2, wanted }), "dine-in table");
  assert.notEqual(root, await orderFingerprint({ ...base, note: "x", wanted }), "note");
  assert.notEqual(root, await orderFingerprint({ ...base, paymentMethod: "counter", wanted }), "payment method");
  assert.notEqual(root, await orderFingerprint({ ...base, counter: true, tableId: null, wanted }), "service mode");
});

test("a pending key survives a changed cart and is retired only by a terminal answer", () => {
  globalThis.sessionStorage = fakeStorage();
  const storageKey = checkoutStorageKey("corner-cup", "1");
  const original = JSON.stringify({ tableId: 1, items: [{ itemId: 7, qty: 2 }] });
  const changed = JSON.stringify({ tableId: 1, items: [{ itemId: 7, qty: 3 }] });

  const first = openCheckout(storageKey, original);
  assert.equal(openCheckout(storageKey, original).key, first.key, "a reload reuses the key");

  const afterEdit = openCheckout(storageKey, changed);
  assert.equal(afterEdit.key, first.key, "a changed cart does not overwrite the key");
  assert.equal(afterEdit.body, original, "a changed cart does not overwrite the body");
  assert.equal(readCheckout(storageKey).body, original);

  assert.equal(checkoutAction(null, original), "submit");
  assert.equal(checkoutAction({ key: first.key, body: original }, original), "replay");
  assert.equal(checkoutAction({ key: first.key, body: original }, changed), "verify");

  clearCheckout(storageKey);
  assert.equal(readCheckout(storageKey), null);
  assert.notEqual(openCheckout(storageKey, changed).key, first.key, "a new checkout gets a fresh key");
});
