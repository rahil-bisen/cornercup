// A menu request is identified by everything it depends on: the café, the service mode, and the table.
// Two cafés asking for "table 2" are different requests even though the table number matches, so the
// scope carries the café too. The Menu page uses this as an effect dependency, and tags each response
// with it, so switching café always refetches and an answer fetched for one café can never be shown
// under another.
export function menuScope({ cafeKey, tableId, counterService }) {
  const where = counterService ? "counter" : `table:${tableId || "none"}`;
  return `${cafeKey || "cafe"}|${where}`;
}

// A response is only usable while the page is still asking for what it was fetched for. An older
// in-flight reply resolves with its own scope, which no longer matches, so it is dropped.
export function isCurrentScope(scope, current) {
  return Boolean(scope) && scope === current;
}
