// Component-level regression tests: these mount the real Menu page with React and jsdom and let the
// real effects issue requests through the real api() layer, so what is asserted is the URL the browser
// would have asked for — not a scope string computed beside it.
//
// Menu.jsx is JSX, so it is bundled once with esbuild into a throwaway module before importing. The
// bundle is deleted afterwards; nothing is added to the build output.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp");
const bundlePath = path.join(workDir, "menu.bundle.mjs");

// The DOM has to exist before react-dom is loaded, because it captures document at import time.
const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/c/warmup",
  pretendToBeVisual: true,
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.PopStateEvent = window.PopStateEvent;
globalThis.localStorage = window.localStorage;
globalThis.sessionStorage = window.sessionStorage;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
try {
  Object.defineProperty(globalThis, "navigator", { value: window.navigator, configurable: true });
} catch {
  /* Node's own navigator is fine for rendering */
}

const { build } = await import("esbuild");
await mkdir(workDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src/pages/Menu.jsx")],
  outfile: bundlePath,
  bundle: true,
  format: "esm",
  platform: "browser",
  jsx: "automatic",
  external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime", "react-router-dom"],
  logLevel: "silent",
});

const React = (await import("react")).default;
const { createRoot } = await import("react-dom/client");
const { act } = await import("react-dom/test-utils");
const { BrowserRouter, Routes, Route } = await import("react-router-dom");
const { default: Menu } = await import(pathToFileURL(bundlePath).href);

// Whether a café switch remounts the page or keeps it mounted is exactly what makes the stale-state
// bugs possible, so it is measured rather than assumed. Every route renders this same wrapper, and it
// counts its mounts: if React ever tore the page down and built a new one, the count would go up and
// the assertion would fail instead of quietly passing a test that proves nothing about persistence.
let mountCount = 0;
const counts = { mounts: 0, unmounts: 0 };
function Page() {
  React.useEffect(() => {
    countMount();
    return () => {
      counts.unmounts += 1;
    };
  }, []);
  return React.createElement(Menu);
}
function countMount() {
  mountCount += 1;
  counts.mounts = mountCount;
}

test.after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function json(body) {
  return { ok: true, status: 200, text: async () => JSON.stringify(body) };
}

// Mirrors the server's scoped paths, and makes each café's payload identifiable in the DOM.
function respond(url, modes, init = {}) {
  const match = url.match(/\/api\/cafes\/([^/]+)\/(.*)$/);
  const slug = match ? decodeURIComponent(match[1]) : "none";
  const rest = match ? match[2] : "";
  // A mode is either the service mode alone ("counter"/"tables") or an object that also says whether
  // this café has a live payment gateway, because the checkout rail follows the gateway, not the mode.
  const entry = modes && modes[slug];
  const mode = typeof entry === "string" ? entry : (entry && entry.mode) || "tables";
  const gateway = Boolean(entry && typeof entry === "object" && entry.gateway === true);
  // `ordering: false` mimics a Worker with no tracking key, which reports that it cannot take orders;
  // `ordering: "omit"` mimics an older Worker that never sent the field at all.
  const ordering = entry && typeof entry === "object" ? entry.ordering : undefined;

  // `"missing"` mimics a slug with no café behind it: the Worker answers every scoped route with 404.
  if (entry === "missing") {
    return { ok: false, status: 404, text: async () => JSON.stringify({ error: "No café found at that web address." }) };
  }

  if (rest.startsWith("config")) {
    return json({
      currency: "INR",
      slug,
      cafe: { name: `CAFE-${slug}` },
      service: { mode },
      ...(ordering === "omit" ? {} : { ordering: { available: ordering !== false } }),
      payments: { provider: gateway ? "razorpay" : "none", gateway, keyId: gateway ? "rzp_test_key" : null },
    });
  }
  if (rest === "orders" && init && init.method === "POST") {
    const body = JSON.parse(init.body || "{}");
    return json({
      status: "committed",
      order: {
        id: "ord-1",
        queueNo: 7,
        tableLabel: "Pickup",
        status: "new",
        later: true,
        paymentMethod: body.paymentMethod,
        paymentStatus: "unpaid",
        totalCents: 5000,
        createdAt: "2026-01-01T00:00:00.000Z",
        items: [{ name: "MENU", emoji: "*", priceCents: 5000, qty: 1 }],
      },
      trackToken: "ord-1-token",
    });
  }
  if (rest.startsWith("menu")) {
    // `menu: "empty"` mimics a café that exists but has not added any items yet.
    if (entry && typeof entry === "object" && entry.menu === "empty") {
      return json({ table: { label: "Table 1" }, categories: [] });
    }
    return json({
      table: { label: "Table" },
      categories: [
        {
          name: "Drinks",
          items: [{ id: 1, name: `MENU-FROM-${slug}`, priceCents: 5000, available: true, emoji: "*", description: "" }],
        },
      ],
    });
  }
  if (rest.startsWith("tables")) {
    return json({ tables: [{ id: 1, label: `TABLES-FROM-${slug}`, seats: 2 }] });
  }
  return json({});
}

// Mounts the page at `pathname`, recording every request the component makes.
async function mount(pathname, modes = {}, holdUrls = []) {
  const calls = [];
  const gates = new Map();
  mountCount = 0;
  counts.mounts = 0;
  counts.unmounts = 0;
  // Gates installed before the first render, so a request can be held from the moment it is made.
  for (const url of holdUrls) {
    let release;
    const promise = new Promise((resolve) => {
      release = resolve;
    });
    gates.set(url, { promise, release });
  }

  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    calls.push(target);
    requests.push({ url: target, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const gate = gates.get(target);
    if (gate) await gate.promise;
    return respond(target, modes, init);
  };

  window.history.replaceState({}, "", pathname);
  window.localStorage.clear();
  window.sessionStorage.clear();

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const reactRoot = createRoot(container);

  const element = React.createElement(
    BrowserRouter,
    null,
    React.createElement(
      Routes,
      null,
      React.createElement(Route, { path: "/c/:slug", element: React.createElement(Page) }),
      React.createElement(Route, { path: "/c/:slug/t/:tableId", element: React.createElement(Page) })
    )
  );

  await act(async () => {
    reactRoot.render(element);
  });

  return {
    calls,
    requests,
    container,
    // One click, committed. React 18 listens on the root, so the event must bubble.
    async click(element) {
      await act(async () => {
        element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    // How many times the page was actually mounted, and torn down, so far.
    mounts: () => counts.mounts,
    unmounts: () => counts.unmounts,
    text: () => container.textContent.replace(/\s+/g, " "),
    hold: (url) => {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      gates.set(url, { promise });
      return release;
    },
    release: (url) => {
      const gate = gates.get(url);
      if (gate && gate.release) gate.release();
    },
    // Navigates without unmounting, exactly like an in-app café switch.
    async go(nextPath) {
      window.history.pushState({}, "", nextPath);
      await act(async () => {
        window.dispatchEvent(new window.PopStateEvent("popstate"));
      });
    },
    async flush() {
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
    },
    async unmount() {
      await act(async () => {
        reactRoot.unmount();
      });
      container.remove();
    },
  };
}

const menuCallsFor = (calls, slug) => calls.filter((url) => url === `/api/cafes/${slug}/menu` || url.startsWith(`/api/cafes/${slug}/menu?`));
const tableCallsFor = (calls, slug) => calls.filter((url) => url === `/api/cafes/${slug}/tables`);
// Every menu request, table or not, so a duplicate cannot hide behind a query string.
const allMenuCalls = (calls) => calls.filter((url) => /\/menu(\?|$)/.test(url));

test("switching café refetches the menu even when the table number is unchanged", async () => {
  const page = await mount("/c/switch-a1/t/2");
  try {
    assert.deepEqual(menuCallsFor(page.calls, "switch-a1"), ["/api/cafes/switch-a1/menu?table=2"]);
    assert.match(page.text(), /MENU-FROM-switch-a1/);
    assert.equal(page.mounts(), 1);

    await page.go("/c/switch-b1/t/2");

    // The whole test is about one page persisting across a café change; a remount would reset the state
    // and hide the bug, so this is asserted, not assumed.
    assert.equal(page.mounts(), 1, "the page was remounted instead of staying mounted");
    assert.equal(page.unmounts(), 0);

    // Same table number, same service mode — only the café changed.
    assert.deepEqual(menuCallsFor(page.calls, "switch-b1"), ["/api/cafes/switch-b1/menu?table=2"]);
    assert.equal(menuCallsFor(page.calls, "switch-a1").length, 1, "café A's menu was fetched once");
    assert.equal(page.calls.filter((u) => /\/menu\?table=2$/.test(u)).length, 2, "one menu request per café");
    assert.match(page.text(), /MENU-FROM-switch-b1/);
    assert.doesNotMatch(page.text(), /MENU-FROM-switch-a1/);
    assert.match(page.text(), /CAFE-switch-b1/);
  } finally {
    await page.unmount();
  }
});

test("switching café refetches the table list when no table is selected", async () => {
  const page = await mount("/c/switch-a2");
  try {
    assert.deepEqual(tableCallsFor(page.calls, "switch-a2"), ["/api/cafes/switch-a2/tables"]);
    assert.match(page.text(), /TABLES-FROM-switch-a2/);

    await page.go("/c/switch-b2");

    assert.equal(page.mounts(), 1, "the page was remounted instead of staying mounted");
    assert.deepEqual(tableCallsFor(page.calls, "switch-b2"), ["/api/cafes/switch-b2/tables"]);
    assert.equal(page.calls.filter((u) => u.endsWith("/tables")).length, 2, "one table request per café");
    assert.match(page.text(), /TABLES-FROM-switch-b2/);
    assert.doesNotMatch(page.text(), /TABLES-FROM-switch-a2/);
  } finally {
    await page.unmount();
  }
});

test("a late menu reply from the previous café cannot replace the new café's menu", async () => {
  const heldUrl = "/api/cafes/switch-a3/menu?table=2";
  const page = await mount("/c/switch-a3/t/2", {}, [heldUrl]);
  try {
    await page.flush();
    // Café A's menu is still in flight, so only its header is up.
    assert.match(page.text(), /CAFE-switch-a3/);
    assert.doesNotMatch(page.text(), /MENU-FROM-switch-a3/);

    await page.go("/c/switch-b3/t/2");
    await page.flush();
    assert.match(page.text(), /MENU-FROM-switch-b3/, "café B's menu rendered");

    // Now café A's request finally answers — it must be dropped, not painted.
    page.release(heldUrl);
    await page.flush();
    assert.match(page.text(), /MENU-FROM-switch-b3/);
    assert.doesNotMatch(page.text(), /MENU-FROM-switch-a3/, "a stale reply from café A was displayed");
    assert.equal(menuCallsFor(page.calls, "switch-a3").length, 1);
    assert.equal(menuCallsFor(page.calls, "switch-b3").length, 1);
  } finally {
    page.release(heldUrl);
    await page.unmount();
  }
});

test("a late table-list reply from the previous café cannot replace the new café's list", async () => {
  const heldUrl = "/api/cafes/switch-t1/tables";
  const page = await mount("/c/switch-t1", {}, [heldUrl]);
  try {
    await page.flush();
    // Café A's table list is still in flight, so the picker has nothing to show yet.
    assert.doesNotMatch(page.text(), /TABLES-FROM-switch-t1/);

    await page.go("/c/switch-t2");
    await page.flush();
    assert.equal(page.mounts(), 1, "the page was remounted instead of staying mounted");
    assert.match(page.text(), /TABLES-FROM-switch-t2/, "café B's table list rendered");

    // Now café A's list finally answers — it must be dropped, not painted.
    page.release(heldUrl);
    await page.flush();
    assert.match(page.text(), /TABLES-FROM-switch-t2/);
    assert.doesNotMatch(page.text(), /TABLES-FROM-switch-t1/, "a stale table list from café A was displayed");
    assert.equal(page.calls.filter((u) => u.endsWith("/tables")).length, 2, "one table request per café");
  } finally {
    page.release(heldUrl);
    await page.unmount();
  }
});

test("table service → counter service: exactly one menu request, never with a table", async () => {
  const page = await mount("/c/switch-a4/t/2", { "switch-b4": "counter" });
  try {
    assert.deepEqual(menuCallsFor(page.calls, "switch-a4"), ["/api/cafes/switch-a4/menu?table=2"]);

    await page.go("/c/switch-b4");
    await page.flush();

    assert.equal(page.mounts(), 1, "the page was remounted instead of staying mounted");
    // Exactly one, not two. The page deliberately waits for café B's settings before choosing a menu
    // URL: an unknown service mode used to mean "table service", which fired one request with café A's
    // table and a second one once the counter mode was known. Both would have been for the same menu.
    assert.deepEqual(menuCallsFor(page.calls, "switch-b4"), ["/api/cafes/switch-b4/menu"], "no table on a counter menu");
    assert.equal(allMenuCalls(page.calls).length, 2, "exactly one menu request per café, none duplicated");
    // The previous café's table must never be sent here: the server answers an unknown table with 404,
    // so a stale table would flash "we couldn't find that table" before the counter menu loads.
    assert.equal(page.calls.filter((u) => u.includes("switch-b4/menu?")).length, 0);
    // Nor is café B asked for a table list it does not have, now that the list waits for the mode.
    assert.equal(tableCallsFor(page.calls, "switch-b4").length, 0);
    assert.match(page.text(), /MENU-FROM-switch-b4/);
    assert.doesNotMatch(page.text(), /MENU-FROM-switch-a4/);
    assert.doesNotMatch(page.text(), /couldn't find that table/i);
  } finally {
    await page.unmount();
  }
});

test("counter service → table service: the new café's table menu is requested", async () => {
  const page = await mount("/c/switch-a5", { "switch-a5": "counter" });
  try {
    assert.deepEqual(menuCallsFor(page.calls, "switch-a5"), ["/api/cafes/switch-a5/menu"]);

    await page.go("/c/switch-b5/t/2");
    await page.flush();

    assert.equal(page.mounts(), 1, "the page was remounted instead of staying mounted");
    assert.deepEqual(menuCallsFor(page.calls, "switch-b5"), ["/api/cafes/switch-b5/menu?table=2"]);
    assert.equal(allMenuCalls(page.calls).length, 2, "one menu request per café");
    // A counter café is never asked for tables, and café B has a table so it needs no picker either.
    assert.equal(page.calls.filter((u) => u.endsWith("/tables")).length, 0);
    assert.match(page.text(), /MENU-FROM-switch-b5/);
    assert.doesNotMatch(page.text(), /MENU-FROM-switch-a5/);
  } finally {
    await page.unmount();
  }
});

for (const pathname of ["/c/slow-m1/t/2", "/c/slow-m2"]) {
  test(`${pathname}: before the config arrives the menu shows loading, not a generic café`, async () => {
    const slug = pathname.split("/")[2];
    const heldUrl = `/api/cafes/${slug}/config`;
    const page = await mount(pathname, { [slug]: "counter" }, [heldUrl]);
    try {
      await page.flush();
      assert.match(page.text(), /Loading/);
      // Neither the "Café" fallback nor a service-mode guess may show while the mode is unknown.
      assert.doesNotMatch(page.text(), /Café|Dine-in|Pickup|Which table/i);
      assert.ok(page.container.querySelector('[aria-busy="true"]'));

      page.release(heldUrl);
      await page.flush();
      await page.flush();
      assert.match(page.text(), new RegExp(`CAFE-${slug}`));
      assert.match(page.text(), /Pickup/);
      assert.doesNotMatch(page.text(), /Dine-in|Which table/);
    } finally {
      page.release(heldUrl);
      await page.unmount();
    }
  });
}

// --- Stage 9A: the declared payment rail comes from the cafe's own config ---------------------

async function openCheckout(page, slug) {
  const add = page.container.querySelector(`[aria-label="Add MENU-FROM-${slug} to your order"]`);
  assert.ok(add, "the add button rendered");
  await page.click(add);
  const bar = page.container.querySelector(".cart-bar");
  assert.ok(bar, "the cart bar rendered");
  await page.click(bar);
  const place = page.container.querySelector(".sheet-foot button");
  assert.ok(place, "the checkout sheet rendered");
  return place;
}

test("a counter cafe with no gateway submits paymentMethod 'counter' and offers no online payment", async () => {
  const page = await mount("/c/pay-c1", { "pay-c1": "counter" });
  try {
    const place = await openCheckout(page, "pay-c1");
    assert.match(page.text(), /Pay at the counter when you collect/);
    assert.doesNotMatch(page.text(), /Send order & pay/);
    assert.doesNotMatch(page.text(), /Pay on the next screen/);

    await page.click(place);

    const post = page.requests.find((r) => r.method === "POST");
    assert.ok(post, "the checkout was submitted");
    assert.equal(post.url, "/api/cafes/pay-c1/orders");
    const body = JSON.parse(post.body);
    assert.equal(body.paymentMethod, "counter");
    assert.deepEqual(body.items, [{ itemId: 1, qty: 1 }], "the cart is sent unchanged");
    assert.equal(body.note, "");
    assert.equal("tableId" in body, false, "a counter order carries no table");
    assert.equal(
      page.requests.filter((r) => /\/payment/.test(r.url)).length,
      0,
      "no payment request was opened"
    );
  } finally {
    await page.unmount();
  }
});

test("a table cafe with no gateway submits 'counter' and keeps its table", async () => {
  const page = await mount("/c/pay-c3/t/2");
  try {
    const place = await openCheckout(page, "pay-c3");
    await page.click(place);

    const post = page.requests.find((r) => r.method === "POST");
    assert.ok(post, "the checkout was submitted");
    assert.equal(post.url, "/api/cafes/pay-c3/orders");
    const body = JSON.parse(post.body);
    assert.equal(body.paymentMethod, "counter", "table service without a gateway pays at the counter");
    assert.equal(body.tableId, 2, "the table is still sent");
    assert.deepEqual(body.items, [{ itemId: 1, qty: 1 }]);
  } finally {
    await page.unmount();
  }
});

test("a deployment that cannot take orders says so in the cart and never sends a doomed checkout", async () => {
  const page = await mount("/c/closed-c1", { "closed-c1": { mode: "counter", ordering: false } });
  try {
    const place = await openCheckout(page, "closed-c1");
    assert.match(page.text(), /Ordering from your phone isn't available right now/);
    assert.equal(place.disabled, true, "the send button is disabled");

    await page.click(place);
    assert.equal(page.requests.filter((r) => r.method === "POST").length, 0, "no order was submitted");
  } finally {
    await page.unmount();
  }
});

test("a config without the ordering field keeps checkout open", async () => {
  // An older Worker never sends `ordering`; only an explicit `available: false` may close checkout.
  const page = await mount("/c/legacy-c1", { "legacy-c1": { mode: "counter", ordering: "omit" } });
  try {
    const place = await openCheckout(page, "legacy-c1");
    assert.doesNotMatch(page.text(), /isn't available right now/);
    assert.equal(place.disabled, false);
  } finally {
    await page.unmount();
  }
});

test("a cafe with a live gateway keeps the Razorpay checkout", async () => {
  const page = await mount("/c/pay-c2", { "pay-c2": { mode: "counter", gateway: true } });
  try {
    const place = await openCheckout(page, "pay-c2");
    assert.match(page.text(), /Send order & pay/);
    assert.match(page.text(), /Pay on the next screen/);

    await page.click(place);

    const post = page.requests.find((r) => r.method === "POST");
    assert.ok(post, "the checkout was submitted");
    assert.equal(post.url, "/api/cafes/pay-c2/orders");
    const body = JSON.parse(post.body);
    assert.equal(body.paymentMethod, "razorpay", "a gateway cafe is unchanged");
    assert.deepEqual(body.items, [{ itemId: 1, qty: 1 }]);
    // The panel is on the order page, not here: nothing may be charged from the cart.
    assert.equal(page.requests.filter((r) => /\/payment/.test(r.url)).length, 0);
  } finally {
    await page.unmount();
  }
});

test("an unknown café shows 'Café not found' instead of a menu or a retry loop", async () => {
  const page = await mount("/c/demo-01/t/1", { "demo-01": "missing" });
  try {
    await page.flush();
    await page.flush();
    assert.match(page.text(), /Café not found/);
    assert.match(page.text(), /demo-01/);
    assert.ok(page.container.querySelector('[role="alert"]'));
    assert.equal(
      [...page.container.querySelectorAll("button")].filter((b) => /Try again/.test(b.textContent)).length,
      0,
      "a missing café will not appear on a retry"
    );
    assert.doesNotMatch(page.text(), /Dine-in|Which table|Table 1/);
  } finally {
    await page.unmount();
  }
});
