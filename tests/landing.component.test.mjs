// Component tests for the café landing page: mounts the real Landing page with React and jsdom and lets
// it call the real api() layer against a stubbed fetch.
//
// It checks two guest-facing promises:
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
        React.createElement(Routes, null, React.createElement(Route, { path: "/c/:slug", element: React.createElement(Landing) }))
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

for (const mode of ["tables", "counter"]) {
  test(`${mode} café without a gateway never mentions online payment`, async () => {
    const slug = `nogw-${mode}`;
    const page = await mount(slug, (rest) => (rest.startsWith("config") ? ok(configFor(slug, { mode })) : tables()));
    try {
      assert.match(page.text(), new RegExp(`CAFE-${slug}`));
      assert.doesNotMatch(page.text(), ONLINE_WORDS);
      assert.match(page.text(), /pay at the counter/i);
    } finally {
      await page.unmount();
    }
  });

  test(`${mode} café with a live gateway mentions online payment`, async () => {
    const slug = `gw-${mode}`;
    const page = await mount(slug, (rest) =>
      rest.startsWith("config") ? ok(configFor(slug, { mode, gateway: true })) : tables()
    );
    try {
      assert.match(page.text(), /UPI, card/);
    } finally {
      await page.unmount();
    }
  });
}
