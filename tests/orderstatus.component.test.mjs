// Component regression tests for the guest tracking page: the real OrderStatus component is mounted with
// React and jsdom at a real URL, so what is asserted is the request the browser would actually make —
// including the header the token travels in — not a helper called beside it.
//
// Covered:
//   1. a URL with #t=<token> sends the token as `x-order-token` and never in the path or query;
//   2. a URL with no fragment renders the not-found card immediately and makes no request at all
//      (before this was fixed it spun on "Finding your order…" forever);
//   3. a 404 from the server shows the same card and no order details.
//
// OrderStatus.jsx is JSX, so it is bundled once with esbuild into a throwaway module before importing.
// The bundle is deleted afterwards; nothing is added to the build output.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-status");
const bundlePath = path.join(workDir, "orderstatus.bundle.mjs");

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/c/cafe-a/order/ABC123",
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

const { build } = await import("esbuild");
await mkdir(workDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src/pages/OrderStatus.jsx")],
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
const { default: OrderStatus } = await import(pathToFileURL(bundlePath).href);

test.after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const TOKEN = "Ye5lqWPc95rcOVDsXdrLsTV5ioQzOTR_g2Ga5Yt3aLc";
const ORDER = {
  id: "ABC123",
  tableId: 1,
  tableLabel: "Table 1",
  queueNo: null,
  note: "",
  status: "new",
  totalCents: 5000,
  paymentMethod: "counter",
  paymentStatus: "counter",
  createdAt: "2026-01-01T00:00:00.000Z",
  items: [{ name: "Masala Chai", emoji: "", priceCents: 5000, qty: 1 }],
};

function reply(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

// Mounts the page at `href` and records every fetch with the options it was given.
async function mount(href, respond) {
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers || {}, method: options.method || "GET" });
    return respond(String(url));
  };

  window.history.replaceState({}, "", href);

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const reactRoot = createRoot(container);

  const element = React.createElement(
    BrowserRouter,
    null,
    React.createElement(
      Routes,
      null,
      React.createElement(Route, { path: "/c/:slug/t/:tableId/order/:orderId", element: React.createElement(OrderStatus) }),
      React.createElement(Route, { path: "/c/:slug/order/:orderId", element: React.createElement(OrderStatus) })
    )
  );

  await act(async () => {
    reactRoot.render(element);
  });
  await act(async () => {
    await Promise.resolve();
  });

  return {
    calls,
    text: () => container.textContent.replace(/\s+/g, " ").trim(),
    unmount: async () => {
      await act(async () => {
        reactRoot.unmount();
      });
      container.remove();
    },
  };
}

test("the token is sent as a header, never in the path or query", async () => {
  const page = await mount(`http://localhost/c/cafe-a/t/1/order/ABC123#t=${TOKEN}`, () => reply({ order: ORDER }));
  try {
    assert.equal(page.calls.length >= 1, true, "the page asked for its order");
    const call = page.calls[0];
    assert.equal(call.url, "/api/cafes/cafe-a/orders/ABC123", "a scoped path with no token in it");
    assert.ok(!call.url.includes(TOKEN), "the token never appears in a URL");
    assert.equal(call.headers["x-order-token"], TOKEN, "the token travels in the header");
    assert.match(page.text(), /your order is in/);
    assert.match(page.text(), /ABC123/);
  } finally {
    await page.unmount();
  }
});

test("a link with no fragment shows the not-found card and sends no request", async () => {
  const page = await mount("http://localhost/c/cafe-a/t/1/order/ABC123", () => reply({ order: ORDER }));
  try {
    assert.equal(page.calls.length, 0, "no request is made without a token");
    assert.match(page.text(), /Order not found/, "it does not spin forever");
    assert.match(page.text(), /missing its tracking code/);
    assert.ok(!page.text().includes("Masala Chai"), "no order detail is shown");
    assert.ok(!page.text().includes("₹50.00"));
  } finally {
    await page.unmount();
  }
});

test("a rejected token shows the same card without leaking the order", async () => {
  const page = await mount(`http://localhost/c/cafe-a/t/1/order/ABC123#t=${"x".repeat(43)}`, () =>
    reply({ error: "We couldn't find that order." }, 404)
  );
  try {
    assert.equal(page.calls.length >= 1, true, "it did ask, with the wrong token");
    assert.equal(page.calls[0].headers["x-order-token"], "x".repeat(43));
    assert.match(page.text(), /Order not found/);
    assert.match(page.text(), /We couldn't find that order/);
    assert.ok(!page.text().includes("Masala Chai"), "the order is not rendered");
  } finally {
    await page.unmount();
  }
});

// --- Stage 9A: a counter order never opens an online payment panel ---------------------------

async function settle() {
  for (let i = 0; i < 4; i += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const CONFIG = {
  currency: "INR",
  cafe: { name: "Corner Cup" },
  service: { mode: "counter" },
  payments: { provider: "razorpay", gateway: true, keyId: "rzp_test_key" },
};

test("an unpaid counter order shows no online payment panel and calls no payment endpoint", async () => {
  const order = { ...ORDER, paymentMethod: "counter", paymentStatus: "unpaid" };
  const page = await mount(`http://localhost/c/counter-cafe/t/1/order/ABC123#t=${TOKEN}`, () => reply({ order }));
  try {
    await settle();
    assert.match(page.text(), /Pay at the counter/);
    assert.doesNotMatch(page.text(), /Pay now/, "no Razorpay panel");
    assert.doesNotMatch(page.text(), /Pay ₹/);
    assert.equal(page.calls.some((c) => c.url.includes("/payment")), false, "no payment endpoint was called");
    assert.equal(page.calls.some((c) => c.url.includes("/config")), false, "the payment config was never fetched");
  } finally {
    await page.unmount();
  }
});

test("an unpaid razorpay order still offers the gateway, and charges nothing until asked", async () => {
  const order = { ...ORDER, paymentMethod: "razorpay", paymentStatus: "unpaid", tableId: null, queueNo: 7 };
  const page = await mount(`http://localhost/c/gateway-cafe/order/ABC123#t=${TOKEN}`, (url) =>
    url.includes("/config") ? reply(CONFIG) : reply({ order })
  );
  try {
    await settle();
    assert.match(page.text(), /Pay now/, "the gateway panel is shown");
    assert.match(page.text(), /Pay ₹50\.00/);
    assert.match(page.text(), /I'll pay at the counter instead/);
    assert.equal(
      page.calls.some((c) => c.url.includes("/payment/razorpay")),
      false,
      "opening the page never starts a payment"
    );
  } finally {
    await page.unmount();
  }
});

test("once staff take payment at the counter the guest sees it as paid", async () => {
  // Staff "Payment received" sets payment_status 'counter' AND paid_at; a guest who only chose to pay at
  // the counter gets 'counter' without paid_at and still owes the bill.
  const paid = { ...ORDER, paymentMethod: "counter", paymentStatus: "counter", paidAt: "2026-11-27T10:30:00.000Z" };
  const page = await mount(`http://localhost/c/counter-cafe/t/1/order/ABC123#t=${TOKEN}`, () => reply({ order: paid }));
  try {
    await settle();
    assert.match(page.text(), /Paid at the counter/);
    assert.match(page.text(), /Payment received/);
    assert.doesNotMatch(page.text(), /Pay at the counter/);
  } finally {
    await page.unmount();
  }

  const owed = { ...ORDER, paymentMethod: "counter", paymentStatus: "counter", paidAt: null };
  const second = await mount(`http://localhost/c/counter-cafe/t/1/order/ABC123#t=${TOKEN}`, () => reply({ order: owed }));
  try {
    await settle();
    assert.match(second.text(), /Pay at the counter/, "choosing the counter is not the same as having paid");
    assert.doesNotMatch(second.text(), /Payment received/);
  } finally {
    await second.unmount();
  }
});
