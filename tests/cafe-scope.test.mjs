// Switching café inside the app keeps the Menu component mounted, so a stale café can leak in three
// ways: the menu is never refetched, the table list is never refetched, or a reply that was already in
// flight lands under the new café's header. These cover the four transitions, using the same scope
// value the Menu page derives its requests and tags its responses with.

import test from "node:test";
import assert from "node:assert/strict";

const { menuScope, isCurrentScope } = await import("../src/lib/menuScope.js");
const { loadSiteConfig } = await import("../src/lib/config.js");

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.window;
});

// Each café answers with its own name and service mode, so a test can prove which one was fetched.
function stubConfig({ modes }) {
  const slugs = [];
  globalThis.fetch = async (url) => {
    const slug = String(url).split("/cafes/")[1]?.split("/")[0] || "none";
    slugs.push(slug);
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ cafe: { name: `Café ${slug}` }, service: { mode: modes[slug] || "tables" } }),
    };
  };
  return slugs;
}

function useCafe(slug) {
  globalThis.window = { location: { pathname: `/c/${slug}` } };
}

// Walks the page from one café to the next exactly as the component does: the slug changes, the config
// is loaded for the new café, and a new menu scope is derived.
async function switchCafes(from, to, modes) {
  const slugs = stubConfig({ modes });

  useCafe(from.cafeKey);
  const fromConfig = await loadSiteConfig();
  const fromScope = menuScope(from);

  useCafe(to.cafeKey);
  const toConfig = await loadSiteConfig();
  const toScope = menuScope(to);

  return { fromConfig, toConfig, fromScope, toScope, slugs };
}

// What the page would render: a response is only shown while its scope still matches the current one.
function displayed(response, currentScope) {
  return isCurrentScope(response.scope, currentScope) ? response.data : null;
}

test("café A → café B, both table service, no table selected: the menu is refetched", async () => {
  const from = { cafeKey: "cafe-a", tableId: "", counterService: false };
  const to = { cafeKey: "cafe-b", tableId: "", counterService: false };
  const { fromScope, toScope, toConfig, slugs } = await switchCafes(from, to, {});

  assert.notEqual(fromScope, toScope, "the request identity changes with the café");
  assert.equal(fromScope, "cafe-a|table:none");
  assert.equal(toScope, "cafe-b|table:none");
  assert.deepEqual(slugs, ["cafe-a", "cafe-b"], "the new café's config was fetched");
  assert.equal(toConfig.cafe.name, "Café cafe-b");
});

test("café A → café B, both table service, same table number: still refetched", async () => {
  // Its own cafés, because the config cache is module-level and would otherwise serve these.
  const from = { cafeKey: "same-table-a", tableId: "2", counterService: false };
  const to = { cafeKey: "same-table-b", tableId: "2", counterService: false };
  const { fromScope, toScope, toConfig, slugs } = await switchCafes(from, to, {});

  // This is the case a table-id-only dependency would miss.
  assert.notEqual(fromScope, toScope);
  assert.equal(fromScope, "same-table-a|table:2");
  assert.equal(toScope, "same-table-b|table:2");
  assert.deepEqual(slugs, ["same-table-a", "same-table-b"]);
  assert.equal(toConfig.cafe.name, "Café same-table-b");
});

test("café A table service → café B counter service: refetched, no table carried over", async () => {
  const from = { cafeKey: "to-counter-a", tableId: "2", counterService: false };
  const to = { cafeKey: "to-counter-b", tableId: "2", counterService: true };
  const { fromScope, toScope, toConfig, slugs } = await switchCafes(from, to, { "to-counter-b": "counter" });

  assert.notEqual(fromScope, toScope);
  assert.equal(fromScope, "to-counter-a|table:2");
  assert.equal(toScope, "to-counter-b|counter", "a counter café's menu is never a table's menu");
  assert.deepEqual(slugs, ["to-counter-a", "to-counter-b"]);
  assert.equal(toConfig.service.mode, "counter");
  // A stale table number cannot make a counter café ask for a table menu.
  assert.equal(menuScope({ cafeKey: "to-counter-b", tableId: "7", counterService: true }), toScope);
});

test("café A counter service → café B table service: refetched with the table menu", async () => {
  const from = { cafeKey: "from-counter-a", tableId: "", counterService: true };
  const to = { cafeKey: "from-counter-b", tableId: "2", counterService: false };
  const { fromScope, toScope, toConfig, slugs } = await switchCafes(from, to, { "from-counter-a": "counter" });

  assert.notEqual(fromScope, toScope);
  assert.equal(fromScope, "from-counter-a|counter");
  assert.equal(toScope, "from-counter-b|table:2");
  assert.deepEqual(slugs, ["from-counter-a", "from-counter-b"]);
  assert.equal(toConfig.service.mode, "tables");
});

test("an in-flight reply from the previous café is never displayed under the new one", () => {
  const cases = [
    [{ cafeKey: "cafe-a", tableId: "", counterService: false }, { cafeKey: "cafe-b", tableId: "", counterService: false }],
    [{ cafeKey: "cafe-a", tableId: "2", counterService: false }, { cafeKey: "cafe-b", tableId: "2", counterService: false }],
    [{ cafeKey: "cafe-a", tableId: "2", counterService: false }, { cafeKey: "cafe-b", tableId: "", counterService: true }],
    [{ cafeKey: "cafe-a", tableId: "", counterService: true }, { cafeKey: "cafe-b", tableId: "2", counterService: false }],
  ];

  for (const [from, to] of cases) {
    const fromScope = menuScope(from);
    const toScope = menuScope(to);
    const lateReply = { scope: fromScope, data: { categories: [{ name: "A's menu" }] } };

    assert.equal(displayed(lateReply, toScope), null, `leaked ${fromScope} into ${toScope}`);
    // The new café's own reply is accepted.
    const freshReply = { scope: toScope, data: { categories: [{ name: "B's menu" }] } };
    assert.deepEqual(displayed(freshReply, toScope), freshReply.data);
  }
});

test("the table picker's list is scoped by café too", () => {
  // Menu tags its table list with the café key, so A's tables cannot be tapped under B.
  assert.equal(isCurrentScope("cafe-a", "cafe-b"), false);
  assert.equal(isCurrentScope("cafe-b", "cafe-b"), true);
});
