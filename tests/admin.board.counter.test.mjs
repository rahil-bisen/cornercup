// The staff board for a café that takes payment at the counter: every order is unpaid when it arrives,
// so the board must show it, alert on it and let staff walk it New -> Preparing -> Ready -> Served.
// A café with a live Razorpay gateway keeps its paid-first board.
//
// Admin.jsx is JSX, so it is bundled once with esbuild into a throwaway module, deleted afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-admin-board");
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
async function mount(slug, { config, signedIn = true, orders = [] }) {
  const titles = [];
  globalThis.fetch = async (url) => {
    const match = String(url).match(/\/api\/cafes\/[^/]+\/(.*)$/);
    const rest = match ? match[1] : "";
    if (rest === "config") return config();
    if (rest === "admin/session") {
      return signedIn ? json({ ok: true, expiresIn: 3600, csrfToken: "csrf" }) : json({ error: "Sign in" }, 401);
    }
    if (rest === "admin/orders") return json({ orders: typeof orders === "function" ? orders() : orders, statistics: null });
    return json({});
  };
  window.history.replaceState({}, "", `/c/${slug}/owner`);
  window.localStorage.clear();

  // Every title the page sets is recorded, so a brief "CafÃ©" flash cannot hide between two assertions.
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

const configFor = (slug, gateway) => ({
  currency: "INR",
  slug,
  cafe: { name: `CAFE-${slug}` },
  service: { mode: "tables" },
  payments: { provider: gateway ? "razorpay" : "none", gateway, keyId: gateway ? "rzp_test_key" : null },
});

const order = (id, extra = {}) => ({
  id,
  tableLabel: "Table 3",
  queueNo: null,
  status: "new",
  paymentStatus: "unpaid",
  paymentMethod: "counter",
  totalCents: 29000,
  createdAt: new Date().toISOString(),
  note: "Less sugar",
  items: [{ name: "Masala Chai", qty: 2 }],
  ...extra,
});

const cardTexts = (page) => [...page.container.querySelectorAll(".order-card")].map((card) => card.textContent);

test("a pay-at-counter café sees a new unpaid order on its board straight away", async () => {
  const page = await mount("counter-board", {
    config: async () => json(configFor("counter-board", false)),
    orders: [order("A1")],
  });
  try {
    await page.flush();
    const cards = cardTexts(page);
    assert.equal(cards.length, 1, "the unpaid order is on the board, not behind a filter");
    assert.match(cards[0], /Table 3/);
    assert.match(cards[0], /Less sugar/);
    assert.equal(
      [...page.container.querySelectorAll('[role="tab"]')].filter((t) => /Paid|Unpaid/.test(t.textContent)).length,
      0,
      "no Paid / Unpaid split when every order is paid at the counter"
    );
    const header = page.container.querySelector(".admin-brand").textContent;
    assert.doesNotMatch(header, /keys missing/i, "no alarming gateway wording");
    assert.match(header, /counter/i);
  } finally {
    await page.unmount();
  }
});

test("a pay-at-counter café gets the new-order alert for an unpaid order", async () => {
  let current = [];
  const page = await mount("counter-alert", {
    config: async () => json(configFor("counter-alert", false)),
    orders: () => current,
  });
  try {
    await page.flush();
    current = [order("B1")];
    // The board refreshes when it becomes visible again; that is the same load the poll runs.
    await act(async () => {
      window.document.dispatchEvent(new window.Event("visibilitychange"));
    });
    await page.flush();
    assert.match(page.text(), /1 new order/);
    assert.ok(page.container.querySelector(".order-card.is-new"), "the new card is highlighted");
  } finally {
    await page.unmount();
  }
});

test("a café with a live gateway keeps its paid-first board", async () => {
  const page = await mount("gateway-board", {
    config: async () => json(configFor("gateway-board", true)),
    orders: [order("C1"), order("C2", { paymentStatus: "confirmed" })],
  });
  try {
    await page.flush();
    const cards = cardTexts(page);
    assert.equal(cards.length, 1, "only the paid order shows by default");
    assert.match(cards[0], /C2/);
    assert.ok([...page.container.querySelectorAll('[role="tab"]')].some((t) => /Unpaid/.test(t.textContent)));
  } finally {
    await page.unmount();
  }
});

test("board wording: Served as the last step, honest payment labels and refresh interval", async () => {
  const page = await mount("counter-words", {
    config: async () => json(configFor("counter-words", false)),
    orders: [order("D1", { status: "ready" }), order("D2", { paymentStatus: "counter", paidAt: new Date().toISOString() })],
  });
  try {
    await page.flush();
    const buttons = [...page.container.querySelectorAll("button")].map((b) => b.textContent.trim());
    assert.ok(buttons.includes("Served"), `a ready order is moved on with "Served": ${buttons.join(", ")}`);
    assert.ok(!buttons.includes("Done"));
    assert.ok(buttons.includes("Payment received"), "staff mark card, cash or UPI the same way");
    assert.ok(!buttons.includes("Cash received"));
    assert.match(page.text(), /Paid at counter/, "a counter-paid order no longer reads as still to pay");
    assert.match(page.text(), /refreshes every 10s/);
  } finally {
    await page.unmount();
  }
});
