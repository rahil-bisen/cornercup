// Component tests for the café landing page: mounts the real Landing page with React and jsdom and lets
// it call the real api() layer against a stubbed fetch.
//
// It checks these guest-facing promises:
//   - a table café asks the guest to scan the QR code on their table (with a "Can't scan? Ask staff"
//     note) and never lists the tables to pick from; a counter café goes straight to the menu;
//   - online payment (UPI, cards, wallets) is only mentioned when the café has a live gateway;
//   - before the café config arrives the page shows a neutral loading state (never a generic "Café" /
//     "Dine-in" guess), and a failed config load offers a working "Try again".
//
// Landing.jsx is JSX, so it is bundled once with esbuild into a throwaway module, deleted afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-landing");
const bundlePath = path.join(workDir, "landing.bundle.mjs");

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
  entryPoints: [path.join(root, "src/pages/Landing.jsx")],
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
const { default: Landing } = await import(pathToFileURL(bundlePath).href);

test.after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });
const fail = (status, error) => ({ ok: false, status, text: async () => JSON.stringify({ error }) });

function configFor(slug, { mode = "tables", gateway = false } = {}) {
  return {
    currency: "INR",
    slug,
    cafe: { name: `CAFE-${slug}` },
    service: { mode },
    payments: { provider: gateway ? "razorpay" : "none", gateway, keyId: gateway ? "rzp_test_key" : null },
  };
}

// `handler(rest)` answers each /api/cafes/<slug>/<rest> request; it may return a promise to hold one.
async function mount(slug, handler) {
  const calls = [];
  globalThis.fetch = async (url) => {
    const target = String(url);
    calls.push(target);
    const match = target.match(/\/api\/cafes\/[^/]+\/(.*)$/);
    return handler(match ? match[1] : "");
  };
  window.history.replaceState({}, "", `/c/${slug}`);

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  await act(async () => {
    reactRoot.render(
      React.createElement(
        BrowserRouter,
        null,
        React.createElement(
          Routes,
          null,
          React.createElement(Route, { path: "/c/:slug", element: React.createElement(Landing) }),
          React.createElement(Route, { path: "/c/:slug/menu", element: React.createElement("p", null, "MENU-PAGE") }),
          React.createElement(Route, { path: "/c/:slug/t/:table", element: React.createElement("p", null, "TABLE-MENU") })
        )
      )
    );
  });
  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  await flush();
  return {
    calls,
    container,
    flush,
    text: () => container.textContent.replace(/\s+/g, " "),
    async click(el) {
      await act(async () => {
        el.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await flush();
    },
    async unmount() {
      await act(async () => reactRoot.unmount());
      container.remove();
    },
  };
}

const tables = () => ok({ tables: [{ id: 1, label: "T1", seats: 2 }] });
const ONLINE_WORDS = /UPI|card|wallet/i;

test("a table café asks the guest to scan their table's QR code instead of listing tables", async () => {
  const slug = "scan-me";
  const page = await mount(slug, (rest) => (rest.startsWith("config") ? ok(configFor(slug)) : tables()));
  try {
    assert.match(page.text(), /CAFE-scan-me/);
    assert.match(page.text(), /Scan the QR code on your table/);
    assert.match(page.text(), /Can.t scan\? Ask a staff member/);
    assert.doesNotMatch(page.text(), /Which table|T1|2 seats/, "no table list to pick from");
    assert.equal(page.calls.some((u) => u.endsWith("/tables")), false, "the table list is never fetched");
    assert.equal(page.container.querySelectorAll('a[href*="/t/"]').length, 0, "no table links");
  } finally {
    await page.unmount();
  }
});

test("a guest who already scanned a table in this tab can go back to it", async () => {
  const slug = "came-back";
  window.sessionStorage.setItem(`cafe_table:${slug}`, "4");
  const page = await mount(slug, (rest) => (rest.startsWith("config") ? ok(configFor(slug)) : tables()));
  try {
    const back = [...page.container.querySelectorAll("a")].find((a) => /Table 4/.test(a.textContent));
    assert.ok(back, "a link back to their table");
    assert.equal(back.getAttribute("href"), `/c/${slug}/t/4`);
  } finally {
    window.sessionStorage.removeItem(`cafe_table:${slug}`);
    await page.unmount();
  }
});

test("a counter café goes straight to the menu", async () => {
  const slug = "counter-straight";
  const page = await mount(slug, (rest) => (rest.startsWith("config") ? ok(configFor(slug, { mode: "counter" })) : tables()));
  try {
    assert.equal(window.location.pathname, `/c/${slug}/menu`);
    assert.match(page.text(), /MENU-PAGE/);
    assert.doesNotMatch(page.text(), /Scan the QR code on your table/);
  } finally {
    await page.unmount();
  }
});

test("a table café without a gateway never mentions online payment", async () => {
  const slug = "nogw-tables";
  const page = await mount(slug, (rest) => (rest.startsWith("config") ? ok(configFor(slug)) : tables()));
  try {
    assert.match(page.text(), /CAFE-nogw-tables/);
    assert.doesNotMatch(page.text(), ONLINE_WORDS);
    assert.match(page.text(), /pay at the counter/i);
  } finally {
    await page.unmount();
  }
});

test("a table café with a live gateway mentions online payment", async () => {
  const slug = "gw-tables";
  const page = await mount(slug, (rest) => (rest.startsWith("config") ? ok(configFor(slug, { gateway: true })) : tables()));
  try {
    assert.match(page.text(), /UPI, card/);
  } finally {
    await page.unmount();
  }
});

test("before the config arrives the page shows loading, not a generic café", async () => {
  const slug = "slow-config";
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const page = await mount(slug, async (rest) => {
    if (rest.startsWith("config")) {
      await held;
      return ok(configFor(slug));
    }
    return tables();
  });
  try {
    assert.match(page.text(), /Loading/);
    assert.doesNotMatch(page.text(), /Café|Dine-in|Pickup|table/i);
    assert.ok(page.container.querySelector('[aria-busy="true"]'));

    release();
    await page.flush();
    assert.match(page.text(), /CAFE-slow-config/);
    assert.match(page.text(), /Dine-in/);
  } finally {
    await page.unmount();
  }
});

test("an unknown café shows 'Café not found', never a generic café page", async () => {
  const slug = "demo-01";
  const page = await mount(slug, (rest) =>
    rest.startsWith("config") ? fail(404, "No café found at that web address.") : fail(404, "No café found at that web address.")
  );
  try {
    assert.match(page.text(), /Café not found/);
    assert.match(page.text(), /demo-01/, "the address the guest typed is shown back to them");
    assert.ok(page.container.querySelector('[role="alert"]'), "the message is announced");
    // A missing café will not appear on a retry, so no Try again button and no generic café copy.
    assert.equal(
      [...page.container.querySelectorAll("button")].filter((b) => /Try again/.test(b.textContent)).length,
      0
    );
    assert.doesNotMatch(page.text(), /Dine-in|Order without the wait|Which table|UPI|wallet/i);
  } finally {
    await page.unmount();
  }
});

test("a failed config load shows the error and Try again recovers", async () => {
  const slug = "flaky-config";
  let configCalls = 0;
  const page = await mount(slug, (rest) => {
    if (rest.startsWith("config")) {
      configCalls += 1;
      return configCalls === 1 ? fail(503, "Server is waking up") : ok(configFor(slug));
    }
    return tables();
  });
  try {
    assert.match(page.text(), /couldn.t open this café/i);
    assert.match(page.text(), /Server is waking up/);
    assert.doesNotMatch(page.text(), /Dine-in/);

    const retry = [...page.container.querySelectorAll("button")].find((b) => /Try again/.test(b.textContent));
    assert.ok(retry, "a Try again button is offered");
    await page.click(retry);

    assert.equal(configCalls, 2);
    assert.match(page.text(), /CAFE-flaky-config/);
    assert.match(page.text(), /Dine-in/);
    assert.match(page.text(), /Scan the QR code on your table/);
  } finally {
    await page.unmount();
  }
});
