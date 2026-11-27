// The owner dashboard follows the café's service mode. A counter (pickup) café has no Tables & QR tab at
// all; in its place a Counter QR code tab holds one code for /c/<slug>/menu, with a printable card and a PNG
// download. A table-service café keeps its Tables & QR tab exactly as before. Saving a new service style
// in Café setup updates both straight away, without a reload, and never touches the café's tables.
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


// A tiny café server: the service mode lives in `state`, so saving Café setup really changes what the next
// /config answers, the way the Worker does. Every request is recorded.
function server(slug, initialMode) {
  const state = { mode: initialMode };
  const requests = [];
  const tables = [
    { id: 1, label: "Table 1", seats: 2 },
    { id: 2, label: "Table 2", seats: 4 },
  ];
  const settings = () => ({
    cafeName: `CAFE-${slug}`,
    serviceMode: state.mode,
    tzOffsetMin: 330,
    contactPhone: "",
    contactEmail: "",
    contactAddress: "",
  });
  const handle = async (url, init = {}) => {
    const method = (init.method || "GET").toUpperCase();
    const match = String(url).match(/\/api\/cafes\/[^/]+\/(.*)$/);
    const rest = match ? match[1] : "";
    requests.push({ method, rest, body: init.body });
    if (rest === "config") {
      return json({
        currency: "INR",
        slug,
        cafe: { name: `CAFE-${slug}` },
        service: { mode: state.mode },
        payments: { provider: "none", gateway: false, keyId: null },
      });
    }
    if (rest === "admin/session") return json({ ok: true, expiresIn: 3600, csrfToken: "csrf" });
    if (rest === "admin/orders") return json({ orders: [], statistics: null });
    if (rest === "admin/tables" && method === "GET") return json({ tables });
    if (rest === "admin/settings" && method === "GET") return json({ slug, settings: settings() });
    if (rest === "admin/settings" && method === "PATCH") {
      const body = JSON.parse(init.body || "{}");
      if (body.serviceMode) state.mode = body.serviceMode;
      return json({ slug, settings: settings() });
    }
    return json({});
  };
  return { state, requests, handle };
}

async function mount(slug, mode) {
  const srv = server(slug, mode);
  globalThis.fetch = srv.handle;
  window.history.replaceState({}, "", `/c/${slug}/owner`);
  window.localStorage.clear();

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  const flush = async () => {
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
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
  const page = {
    srv,
    container,
    flush,
    text: () => container.textContent.replace(/\s+/g, " "),
    tabs: () => [...container.querySelectorAll(".admin-tabs button")].map((b) => b.textContent.trim()),
    async open(label) {
      const tab = [...container.querySelectorAll(".admin-tabs button")].find((b) => b.textContent.trim() === label);
      assert.ok(tab, `the "${label}" tab exists`);
      await act(async () => {
        tab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await flush();
    },
    counterCard: () => container.querySelector(".counter-qr-card"),
    async saveServiceMode(value) {
      const select = [...container.querySelectorAll("label.field")]
        .find((label) => label.querySelector("span") && label.querySelector("span").textContent.trim() === "Service style")
        .querySelector("select");
      await act(async () => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, "value").set;
        setter.call(select, value);
        select.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
      const form = select.closest("form");
      await act(async () => {
        form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      });
      await flush();
    },
    async unmount() {
      await act(async () => reactRoot.unmount());
      container.remove();
    },
  };
  return page;
}

const TABLES_TABS = ["Orders", "Menu", "Tables & QR", "Café setup", "Security"];
// A counter café's Counter QR code tab sits where Tables & QR was.
const COUNTER_TABS = ["Orders", "Menu", "Counter QR code", "Café setup", "Security"];

function assertCounterCard(page, slug) {
  const card = page.counterCard();
  assert.ok(card, "the Counter QR code tab shows the card");
  assert.equal(card.getAttribute("data-qr-url"), `http://localhost/c/${slug}/menu`);
  assert.match(card.textContent, new RegExp(`CAFE-${slug}`));
  assert.match(card.textContent, /Scan to order/);
  const section = card.closest("section");
  const controls = [...section.querySelectorAll("button, a")].map((el) => el.textContent.trim());
  assert.ok(controls.includes("Print sheet"), "a print button");
  const download = [...section.querySelectorAll("a[download]")];
  assert.equal(download.length, 1, "one download link");
  assert.match(download[0].getAttribute("download"), /\.png$/);
}

test("a counter café has a Counter QR code tab instead of Tables & QR", async () => {
  const page = await mount("pickup-cafe", "counter");
  try {
    assert.deepEqual(page.tabs(), COUNTER_TABS);
    assert.doesNotMatch(page.text(), /Tables & QR|Add a table/);
    await page.open("Counter QR code");
    assertCounterCard(page, "pickup-cafe");
    assert.doesNotMatch(page.text(), /Table \d|Add a table/, "no table list, add table or table codes");
    await page.open("Café setup");
    assert.equal(page.counterCard(), null, "the card lives in its own tab, not in Café setup");
    assert.equal(
      page.srv.requests.filter((r) => r.rest === "admin/tables").length,
      0,
      "a counter café's dashboard never loads the table list"
    );
  } finally {
    await page.unmount();
  }
});

test("a table-service café keeps its Tables & QR tab exactly as before, and has no counter card", async () => {
  const page = await mount("table-cafe", "tables");
  try {
    assert.deepEqual(page.tabs(), TABLES_TABS);
    await page.open("Tables & QR");
    const text = page.text();
    assert.match(text, /Tables & QR codes/);
    assert.match(text, /Table 1/);
    assert.match(text, /Table 2/);
    assert.match(text, /Add a table/);
    assert.equal(page.container.querySelectorAll(".qr-card").length, 2, "one card per table");
    assert.equal(page.counterCard(), null);

    await page.open("Café setup");
    assert.equal(page.counterCard(), null, "no counter card in a table café's setup");
  } finally {
    await page.unmount();
  }
});

test("switching service style in Café setup updates the tabs and the card straight away", async () => {
  const page = await mount("switch-cafe", "tables");
  try {
    await page.open("Café setup");
    assert.equal(page.counterCard(), null);

    await page.saveServiceMode("counter");
    assert.deepEqual(page.tabs(), COUNTER_TABS, "Tables & QR is replaced by Counter QR code without a reload");
    await page.open("Counter QR code");
    assertCounterCard(page, "switch-cafe");

    await page.open("Café setup");
    await page.saveServiceMode("tables");
    assert.deepEqual(page.tabs(), TABLES_TABS, "Tables & QR is back and Counter QR code is gone");
    assert.equal(page.counterCard(), null, "the counter card is gone");
    await page.open("Tables & QR");
    assert.match(page.text(), /Table 1/, "the same tables are listed again");

    const writes = page.srv.requests.filter((r) => r.method !== "GET");
    assert.ok(writes.every((r) => r.rest === "admin/settings"), "switching only saves settings; no table is touched");
  } finally {
    await page.unmount();
  }
});
