// The tracking heading used to be hardcoded to "Order confirmed", which is only true while the ticket
// is new: a served or cancelled order that still claims to be confirmed is simply wrong. This test pins
// the wording to the status the server actually reported, and pins the queue number to the element the
// layout treats as the headline.
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
const workDir = path.join(here, ".tmp-status-heading");
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

// A table order: no queue number, delivered to the table.
const TABLE_ORDER = {
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

// A counter order: collected at the counter with a pickup number.
const PICKUP_ORDER = { ...TABLE_ORDER, tableId: null, tableLabel: "Pickup", queueNo: 12 };

async function mount(order) {
  globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ order }) });

  window.history.replaceState({}, "", `http://localhost/c/cafe-a/order/ABC123#t=${TOKEN}`);

  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const reactRoot = createRoot(container);

  const element = React.createElement(
    BrowserRouter,
    null,
    React.createElement(
      Routes,
      null,
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
    heading: () => container.querySelector("h1")?.textContent || "",
    queue: () => container.querySelector(".order-ticket-number")?.textContent || "",
    eyebrow: () => container.querySelector(".order-ticket .eyebrow")?.textContent || "",
    steps: () => [...container.querySelectorAll(".timeline-step")].map((el) => el.className),
    stepTitles: () => [...container.querySelectorAll(".timeline-step strong")].map((el) => el.textContent),
    current: () => container.querySelector('.timeline-step[aria-current="step"] strong')?.textContent || "",
    wait: () => container.querySelector(".wait-estimate")?.textContent || "",
    text: () => container.textContent.replace(/\s+/g, " "),
    unmount: async () => {
      await act(async () => {
        reactRoot.unmount();
      });
      container.remove();
    },
  };
}

test("a new order thanks the guest, and a table order's big number is its order code", async () => {
  const page = await mount(TABLE_ORDER);
  try {
    assert.equal(page.heading(), "Thanks — your order is in!");
    assert.equal(page.eyebrow(), "Your order number");
    assert.equal(page.queue(), "#ABC123", "the code staff can look up, shown large");
    assert.match(page.text(), /Table 1/);
    assert.deepEqual(page.stepTitles(), ["Received", "Preparing", "Ready", "Served"]);
    assert.equal(page.current(), "Received", "the current step is marked for assistive tech");
  } finally {
    await page.unmount();
  }
});

test("headings follow every intermediate status of a table order", async () => {
  const cases = [
    ["preparing", "Being prepared"],
    ["ready", "Your order is ready"],
    ["served", "Served"],
  ];
  for (const [status, expected] of cases) {
    const page = await mount({ ...TABLE_ORDER, status });
    try {
      assert.equal(page.heading(), expected, `status ${status} shows its own heading`);
    } finally {
      await page.unmount();
    }
  }
});

test("a pickup order is told to collect, and its queue number is the headline", async () => {
  const ready = await mount({ ...PICKUP_ORDER, status: "ready" });
  try {
    assert.equal(ready.heading(), "Ready to collect");
    assert.equal(ready.eyebrow(), "Your pickup number");
    assert.equal(ready.queue(), "12", "the pickup number, not a table label");
  } finally {
    await ready.unmount();
  }

  const collected = await mount({ ...PICKUP_ORDER, status: "served" });
  try {
    assert.equal(collected.heading(), "Collected");
  } finally {
    await collected.unmount();
  }
});

test("a cancelled order says so and shows no progress timeline", async () => {
  const page = await mount({ ...PICKUP_ORDER, status: "cancelled" });
  try {
    assert.equal(page.heading(), "Order cancelled");
    assert.equal(page.steps().length, 0, "no step is claimed for a cancelled order");
  } finally {
    await page.unmount();
  }
});

test("the usual wait shows only while the order is on its way, and only when the café set one", async () => {
  const waiting = await mount({ ...TABLE_ORDER, typicalWaitMin: 15 });
  try {
    assert.match(waiting.wait(), /Usually ready in about 15 min \(around /);
  } finally {
    await waiting.unmount();
  }
  for (const order of [{ ...TABLE_ORDER, typicalWaitMin: 0 }, TABLE_ORDER, { ...TABLE_ORDER, typicalWaitMin: 15, status: "ready" }]) {
    const page = await mount(order);
    try {
      assert.equal(page.wait(), "", `no estimate for ${JSON.stringify({ wait: order.typicalWaitMin, status: order.status })}`);
    } finally {
      await page.unmount();
    }
  }
});

test("a dish's note is shown under it on the receipt", async () => {
  const page = await mount({
    ...TABLE_ORDER,
    items: [{ name: "Masala Chai", emoji: "", priceCents: 5000, qty: 2, note: "less sugar" }],
  });
  try {
    assert.match(page.text(), /2× Masala Chai“less sugar”/);
  } finally {
    await page.unmount();
  }
});
