// Component tests for the policy pages (About, Terms, Privacy, Refunds): mounts the real Legal page
// with React and jsdom against a stubbed fetch, and checks that a café with no live payment gateway is
// never described as taking payments through one.
//
// Legal.jsx is JSX, so it is bundled once with esbuild into a throwaway module, deleted afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-legal");
const bundlePath = path.join(workDir, "legal.bundle.mjs");

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
  entryPoints: [path.join(root, "src/pages/Legal.jsx")],
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
const { default: Legal } = await import(pathToFileURL(bundlePath).href);

test.after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

const ok = (body) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) });

function configFor(slug, gateway) {
  return {
    currency: "INR",
    slug,
    cafe: { name: `CAFE-${slug}`, address: "1 Test Road", phone: "000", email: "cafe@example.test" },
    service: { mode: "counter" },
    ordering: { available: true },
    payments: { provider: gateway ? "razorpay" : "none", gateway, keyId: gateway ? "rzp_test_key" : null },
  };
}

// `hold` keeps /api/config unanswered until the returned release() is called.
async function mount(slug, page, { gateway = false, hold = false } = {}) {
  let release = () => {};
  const held = hold
    ? new Promise((resolve) => {
        release = resolve;
      })
    : null;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/config")) {
      if (held) await held;
      return ok(configFor(slug, gateway));
    }
    return ok({});
  };
  window.history.replaceState({}, "", `/c/${slug}/${page}`);

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
          React.createElement(Route, { path: "/c/:slug/:legal", element: React.createElement(Legal) }),
          React.createElement(Route, { path: "/c/:slug", element: React.createElement("p", null, "LANDING") })
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
    container,
    flush,
    release,
    text: () => container.textContent.replace(/\s+/g, " "),
    async unmount() {
      await act(async () => reactRoot.unmount());
      container.remove();
    },
  };
}

// "pay without waiting" was the About page's promise of paying from the phone.
const GATEWAY_WORDS = /payment gateway|pay online|payment reference|pay without waiting/i;

for (const page of ["about", "terms", "privacy", "refund"]) {
  test(`${page}: a café without a gateway never describes one`, async () => {
    const slug = `legal-off-${page}`;
    const view = await mount(slug, page);
    try {
      assert.match(view.text(), new RegExp(`CAFE-${slug}`));
      assert.doesNotMatch(view.text(), GATEWAY_WORDS);
    } finally {
      await view.unmount();
    }
  });
}

test("terms, privacy and refunds describe the gateway when the café has one", async () => {
  for (const page of ["terms", "privacy", "refund"]) {
    const view = await mount(`legal-on-${page}`, page, { gateway: true });
    try {
      assert.match(view.text(), /payment gateway/i, `${page} names the gateway`);
    } finally {
      await view.unmount();
    }
  }
});

test("counter-only terms say payment is taken at the counter", async () => {
  const view = await mount("legal-off-counter", "terms");
  try {
    assert.match(view.text(), /taken in person at the counter/);
  } finally {
    await view.unmount();
  }
});
