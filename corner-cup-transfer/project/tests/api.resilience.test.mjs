// The API layer must never leave a caller waiting forever, and it must say *why* a call failed so the
// UI can offer the right thing: a retry for a deadline, silence for a request the caller withdrew,
// and an explanation for a broken network. These run against a stubbed fetch, so no server is needed.

import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const { api, DEFAULT_TIMEOUT_MS } = await import("../src/lib/api.js");
const { loadSiteConfig } = await import("../src/lib/config.js");
const { checkoutStorageKey } = await import("../src/lib/checkout.js");

const realFetch = globalThis.fetch;

// Every stub records the URL and init it was handed, so the tests can inspect the signal the API built.
function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return handler(url, init);
  };
  return calls;
}

function jsonResponse(body, { status = 200 } = {}) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) };
}

// A request that never answers on its own, but honours the signal it is given — the shape of a real
// stalled connection.
function hanging(_url, init) {
  return new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
}

// The config cache is keyed by café, so each test that touches it claims its own café and therefore
// its own cache bucket — no test can inherit another's cached promise.
function useCafe(slug) {
  globalThis.window = { location: { pathname: `/c/${slug}` } };
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.window;
});

test("a successful response is parsed and returned", async () => {
  const calls = stubFetch(() => jsonResponse({ cafe: { name: "Corner Cup Café" }, service: { mode: "tables" } }));

  const data = await api("/api/config");

  assert.equal(data.cafe.name, "Corner Cup Café");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/config");
  assert.equal(calls[0].init.credentials, "same-origin");
  assert.ok(calls[0].init.signal, "the call carries a signal so it can be abandoned");
});

test("a default deadline is applied, and 0 disables it", async () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 15000);

  stubFetch(() => jsonResponse({ ok: true }));
  await api("/api/menu");

  // No deadline means no signal is created at all for that call.
  const calls = stubFetch(() => jsonResponse({ ok: true }));
  await api("/api/menu", { timeoutMs: 0 });
  assert.equal(calls.length, 1);
});

test("a request that exceeds the timeout fails as a timeout, not a network error", async () => {
  stubFetch(hanging);

  const started = Date.now();
  const err = await api("/api/menu", { timeoutMs: 40 }).then(
    () => assert.fail("expected the call to time out"),
    (e) => e
  );

  assert.equal(err.code, "timeout");
  assert.equal(err.reason, "timeout");
  assert.equal(err.name, "TimeoutError");
  assert.equal(err.canceled, undefined);
  assert.equal(err.timeoutMs, 40);
  assert.match(err.message, /too long/i);
  assert.ok(Date.now() - started < 1000, "the deadline is the caller's, not the platform's");
});

test("the deadline timer is cleared, so a fast reply with a long deadline leaves nothing pending", async () => {
  const before = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  stubFetch(() => jsonResponse({ ok: true }));

  await api("/api/menu", { timeoutMs: 60_000 });

  const after = process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;
  assert.ok(after <= before, `a timer leaked (${before} -> ${after})`);
});

test("an ordinary network failure is reported as a network error", async () => {
  stubFetch(() => {
    throw new TypeError("fetch failed");
  });

  const err = await api("/api/menu").then(
    () => assert.fail("expected the call to fail"),
    (e) => e
  );

  assert.equal(err.code, "network");
  assert.equal(err.reason, "network");
  assert.equal(err.name, "NetworkError");
  assert.equal(err.canceled, undefined);
  assert.match(err.message, /connection/i);
  assert.ok(err.cause instanceof TypeError, "the original failure is kept as the cause");
});

test("an HTTP error keeps the server's message, status and code", async () => {
  stubFetch(() => jsonResponse({ error: "That table is closed.", code: "table_closed" }, { status: 409 }));

  const err = await api("/api/menu").then(
    () => assert.fail("expected the call to fail"),
    (e) => e
  );

  assert.equal(err.message, "That table is closed.");
  assert.equal(err.status, 409);
  assert.equal(err.code, "table_closed");
  // A reply the server did send is not a transport failure.
  assert.equal(err.reason, undefined);
});

test("a caller-initiated cancellation is distinguishable from a timeout", async () => {
  const controller = new AbortController();
  stubFetch(hanging);

  const pending = api("/api/menu", { signal: controller.signal, timeoutMs: 10_000 }).then(
    () => assert.fail("expected the call to be cancelled"),
    (e) => e
  );
  controller.abort();
  const err = await pending;

  assert.equal(err.code, "aborted");
  assert.equal(err.reason, "aborted");
  assert.equal(err.name, "AbortError");
  assert.equal(err.canceled, true);
  assert.notEqual(err.code, "timeout");
});

test("the caller's signal is preserved: the request is aborted through it", async () => {
  const controller = new AbortController();
  const calls = stubFetch(hanging);

  const pending = api("/api/menu", { signal: controller.signal, timeoutMs: 10_000 }).catch((e) => e);

  // The API builds its own signal for the deadline, but the caller's still reaches the request.
  assert.notEqual(calls[0].init.signal, controller.signal);
  assert.equal(calls[0].init.signal.aborted, false);
  controller.abort();
  assert.equal(calls[0].init.signal.aborted, true);

  await pending;
  assert.equal(calls[0].init.signal.aborted, true);
});

test("a signal that is already aborted never reaches the network", async () => {
  const controller = new AbortController();
  controller.abort();
  const calls = stubFetch(() => jsonResponse({ ok: true }));

  const err = await api("/api/menu", { signal: controller.signal }).then(
    () => assert.fail("expected the call to be cancelled"),
    (e) => e
  );

  assert.equal(err.code, "aborted");
  assert.equal(calls.length, 0, "an already-cancelled call never reaches the network");
});

test("the config cache evicts a failed request and a retry starts a fresh one", async () => {
  useCafe("evict-cafe");
  let attempt = 0;
  const calls = stubFetch(() => {
    attempt += 1;
    if (attempt === 1) throw new TypeError("fetch failed");
    return jsonResponse({ cafe: { name: "Recovered Café" }, service: { mode: "tables" } });
  });

  const err = await loadSiteConfig().then(
    () => assert.fail("expected the first attempt to fail"),
    (e) => e
  );
  assert.equal(err.code, "network");
  assert.equal(calls.length, 1);

  // The dead promise must be gone from the cache, or the retry would re-await it forever.
  await Promise.resolve();
  const data = await loadSiteConfig();

  assert.equal(calls.length, 2, "the retry issued its own request");
  assert.equal(data.cafe.name, "Recovered Café");
});

test("a timed-out config request is evicted too, so the next call recovers", async () => {
  useCafe("timeout-cafe");
  let attempt = 0;
  const calls = stubFetch((_url, init) => {
    attempt += 1;
    if (attempt === 1) return hanging(_url, init);
    return jsonResponse({ cafe: { name: "Back Online" } });
  });

  const err = await loadSiteConfig({ timeoutMs: 30 }).then(
    () => assert.fail("expected a timeout"),
    (e) => e
  );
  assert.equal(err.code, "timeout");

  const data = await loadSiteConfig();
  assert.equal(data.cafe.name, "Back Online");
  assert.equal(calls.length, 2, "the hung promise was dropped, so the retry refetched");
});

test("concurrent config callers share one request instead of stampeding", async () => {
  useCafe("shared-cafe");
  const calls = stubFetch(() => jsonResponse({ cafe: { name: "Shared" } }));

  const [a, b, c] = await Promise.all([loadSiteConfig(), loadSiteConfig(), loadSiteConfig()]);

  assert.equal(calls.length, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(b, c);
});

test("a café's table and cart keys never collide with another table's or café's", () => {
  const cafeA = "corner-cup-cafe";
  const cafeB = "other-cafe";

  const keys = new Set([
    checkoutStorageKey(cafeA, "2"),
    checkoutStorageKey(cafeA, "3"),
    checkoutStorageKey(cafeB, "2"),
    checkoutStorageKey(cafeA, null),
  ]);
  assert.equal(keys.size, 4, "each café/table pair gets its own key");

  assert.equal(checkoutStorageKey(cafeA, "2"), "checkout:corner-cup-cafe:table-2");
  assert.equal(checkoutStorageKey(cafeA, null), "checkout:corner-cup-cafe:takeaway");
  assert.notEqual(checkoutStorageKey(cafeA, "2"), checkoutStorageKey(cafeA, "22"));
});

test("the cart key stays scoped to both the café and the table", async () => {
  // The cart key is built inside the component, so its shape is guarded here: dropping either the café
  // or the table would let one table's basket appear in another's.
  const source = await readFile(new URL("../src/pages/Menu.jsx", import.meta.url), "utf8");

  assert.match(source, /`cart:\$\{cafeKey\}/, "the cart key is scoped by café");
  assert.match(source, /table-\$\{tableId\}/, "the cart key is scoped by table");
  assert.match(source, /takeaway/, "a table-less order keeps its own basket");
});

test("switching café never reuses another café's cached config", async () => {
  const calls = stubFetch((url) => {
    const slug = String(url).split("/cafes/")[1]?.split("/")[0] || "none";
    return jsonResponse({
      cafe: { name: `Café ${slug}` },
      service: { mode: slug === "counter-cafe" ? "counter" : "tables" },
    });
  });

  useCafe("dine-cafe");
  const first = await loadSiteConfig();

  useCafe("counter-cafe");
  const second = await loadSiteConfig();

  assert.equal(calls.length, 2, "each café issues its own request");
  assert.equal(first.cafe.name, "Café dine-cafe");
  assert.equal(first.service.mode, "tables");
  assert.equal(second.cafe.name, "Café counter-cafe");
  assert.equal(second.service.mode, "counter", "a counter café must not inherit dine-in settings");

  // Going back is served from that café's own entry, not from whichever café was fetched last.
  useCafe("dine-cafe");
  const again = await loadSiteConfig();
  assert.equal(again.cafe.name, "Café dine-cafe");
  assert.equal(again.service.mode, "tables");
  assert.equal(calls.length, 2, "the unchanged café is served from its own cache");
});

test("one caller's cancellation cannot cancel the shared config request", async () => {
  useCafe("shared-signal-cafe");
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const calls = stubFetch(async () => {
    await gate;
    return jsonResponse({ cafe: { name: "Still Here" } });
  });

  const controller = new AbortController();
  const first = loadSiteConfig({ signal: controller.signal });
  const second = loadSiteConfig();

  controller.abort();
  // The shared request belongs to the cache, not to the caller that joined it, so the abort must not
  // have reached the network.
  assert.equal(calls[0].init.signal.aborted, false);
  release();

  const [a, b] = await Promise.all([first, second]);
  assert.equal(calls.length, 1, "one shared request");
  assert.equal(a.cafe.name, "Still Here");
  assert.equal(b.cafe.name, "Still Here");
});
