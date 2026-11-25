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
function respond(url, modes) {
  const match = url.match(/\/api\/cafes\/([^/]+)\/(.*)$/);
  const slug = match ? decodeURIComponent(match[1]) : "none";
  const rest = match ? match[2] : "";
  const mode = (modes && modes[slug]) || "tables";

  if (rest.startsWith("config")) {
    return json({ currency: "INR", slug, cafe: { name: `CAFE-${slug}` }, service: { mode } });
  }
  if (rest.startsWith("menu")) {
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

  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const gate = gates.get(target);
    if (gate) await gate.promise;
    return respond(target, modes);
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
    container,
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
