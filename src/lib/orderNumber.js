// What an order is called on screen. A new order has the café's daily number ("#23"); an order placed
// before daily numbers existed has none, so it keeps showing its random code ("#MPK7AL"). The random
// id stays the order's identity in URLs and lookups either way — this is only a label.
export function hasDailyNumber(order) {
  return Boolean(order) && order.queueNo != null && Number.isFinite(Number(order.queueNo));
}

export function orderLabel(order) {
  if (!order) return "";
  return hasDailyNumber(order) ? `#${order.queueNo}` : `#${order.id}`;
}

// Board search: "23" or "#23" finds daily number 23 exactly (not 123 or 230), and any part of the
// random code still finds that order, so a guest reading out either one is found.
export function orderMatchesTerm(order, rawTerm) {
  const term = String(rawTerm || "").trim().toLowerCase();
  if (!term) return true;
  const bare = term.replace(/^#/, "");
  if (hasDailyNumber(order) && /^\d+$/.test(bare) && Number(bare) === Number(order.queueNo)) return true;
  return Boolean(bare) && String(order.id).toLowerCase().includes(bare);
}
