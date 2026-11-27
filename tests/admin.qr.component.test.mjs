// The staff panel's QR tab follows the café's service mode. A counter (pickup) café gets one counter QR
// code for /c/<slug>/menu with a printable card; its table codes are hidden, because scanning one in a
// pickup café used to end in "This café takes pickup orders — no table is needed." A table-service café
// keeps its per-table codes exactly as before.
//
// jsdom has no canvas, so the PNG itself is checked in a real browser; here the link the code encodes is
// read from the card's data-qr-url.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-admin-qr");
const bundlePath = path.join(workDir, "admin.bundle.mjs");

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><head><title>start</title></head><body></body></html>", {
  url: "http://localhost/c/warmup/owner",
  pretendToBeVisual: true,
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.MouseEvent = window.MouseEvent;
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
  entryPoints: [path.join(root, "src/pages/Admin.jsx")],
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
const { default: Admin } = await import(pathToFileURL(bundlePath).href);

test.after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function json(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

// `config` answers /api/config: a function may hold the reply; `signedIn` decides the session check.
async function mount(slug, { config, signedIn = true }) {
  const titles = [];
  globalThis.fetch = async (url) => {
    const match = String(url).match(/\/api\/cafes\/[^/]+\/(.*)$/);
    const rest = match ? match[1] : "";
    if (rest === "config") return config();
    if (rest === "admin/session") {
      return signedIn ? json({ ok: true, expiresIn: 3600, csrfToken: "csrf" }) : json({ error: "Sign in" }, 401);
    }
    if (rest === "admin/orders") return json({ orders: [], statistics: null });
    if (rest === "admin/tables") return json({ tables: [{ id: 1, label: "Table 1", seats: 2 }, { id: 2, label: "Table 2", seats: 4 }] });
    return json({});
  };
  window.history.replaceState({}, "", `/c/${slug}/owner`);
  window.localStorage.clear();

  // Every title the page sets is recorded, so a brief "Café" flash cannot hide between two assertions.
  const observer = new window.MutationObserver(() => titles.push(window.document.title));
  observer.observe(window.document.head, { subtree: true, childList: true, characterData: true });

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  const flush = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  };
  await act(async () => {
    reactRoot.render(
      React.createElement(
        BrowserRouter,
        null,
        React.createElement(Routes, null, React.createElement(Route, { path: "/c/:slug/owner", element: React.createElement(Admin) }))
      )
    );
  });
  await flush();
  return {
    container,
    titles,
    flush,
    text: () => container.textContent.replace(/\s+/g, " "),
    async unmount() {
      observer.disconnect();
      await act(async () => reactRoot.unmount());
      container.remove();
    },
  };
}

const configFor = (slug, mode) => ({
  currency: "INR",
  slug,
  cafe: { name: `CAFE-${slug}` },
  service: { mode },
  payments: { provider: "none", gateway: false, keyId: null },
});

async function openQrTab(page) {
  const tabs = [...page.container.querySelectorAll(".admin-tabs button")];
  const tab = tabs[2];
  assert.ok(tab, "the third staff tab exists");
  await act(async () => {
    tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await page.flush();
  await page.flush();
  return tab.textContent.trim();
}

test("a counter café gets one counter QR code for its menu, and no table codes", async () => {
  const page = await mount("pickup-cafe", { config: async () => json(configFor("pickup-cafe", "counter")) });
  try {
    await page.flush();
    const label = await openQrTab(page);
    assert.equal(label, "QR code");

    const cards = [...page.container.querySelectorAll(".qr-card")];
    assert.equal(cards.length, 1, "exactly one card");
    const card = cards[0];
    assert.equal(card.getAttribute("data-qr-url"), "http://localhost/c/pickup-cafe/menu");
    assert.match(card.textContent, /CAFE-pickup-cafe/);
    assert.match(card.textContent, /Scan to order/);

    const text = page.text();
    assert.doesNotMatch(text, /Table 1|Table 2|Add a table/, "no table codes and no way to add tables here");
    assert.match(text, /only used for table service/i, "a note says where table codes went");
    const buttons = [...page.container.querySelectorAll("button, a")].map((el) => el.textContent.trim());
    assert.ok(buttons.includes("Print sheet"));
    const download = [...page.container.querySelectorAll("a[download]")];
    assert.equal(download.length, 1, "one download link");
    assert.match(download[0].getAttribute("download"), /\.png$/);
  } finally {
    await page.unmount();
  }
});

test("a table-service café keeps its per-table QR codes exactly as before", async () => {
  const page = await mount("table-cafe", { config: async () => json(configFor("table-cafe", "tables")) });
  try {
    await page.flush();
    const label = await openQrTab(page);
    assert.equal(label, "Tables & QR");

    const text = page.text();
    assert.match(text, /Tables & QR codes/);
    assert.match(text, /Table 1/);
    assert.match(text, /Table 2/);
    assert.match(text, /Add a table/);
    assert.doesNotMatch(text, /Scan to order|only used for table service/i, "no counter card");
    assert.equal(page.container.querySelectorAll(".qr-card").length, 2, "one card per table");
    assert.equal(page.container.querySelector("[data-qr-url$='/menu']"), null);
  } finally {
    await page.unmount();
  }
});
