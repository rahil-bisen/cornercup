// The staff board's header and tab title must never show the generic "Café" placeholder: while the café's
// config is on its way the header shows a neutral loading mark, and an address with no café behind it
// shows "Café not found" instead of a sign-in form for nobody.
//
// Admin.jsx is JSX, so it is bundled once with esbuild into a throwaway module, deleted afterwards.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-admin-header");
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

const configFor = (slug) => ({
  currency: "INR",
  slug,
  cafe: { name: `CAFE-${slug}` },
  service: { mode: "tables" },
  payments: { provider: "none", gateway: false, keyId: null },
});

test("while the config is loading the board header never shows the placeholder 'Café'", async () => {
  const slug = "slow-board";
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const page = await mount(slug, {
    config: async () => {
      await held;
      return json(configFor(slug));
    },
  });
  try {
    const brand = page.container.querySelector(".admin-brand");
    assert.ok(brand, "the signed-in board is showing");
    assert.doesNotMatch(brand.textContent, /Café/);
    assert.ok(brand.querySelector('[aria-busy="true"]'), "the name slot says it is loading");
    assert.ok(!page.titles.includes("Café") && !/Café/.test(window.document.title), "no placeholder tab title");

    release();
    await page.flush();
    await page.flush();
    assert.match(page.container.querySelector(".admin-brand").textContent, /CAFE-slow-board/);
    assert.match(window.document.title, /CAFE-slow-board/);
    assert.ok(!page.titles.some((t) => /(^|· )Café$/.test(t)), `titles seen: ${page.titles.join(" | ")}`);
  } finally {
    await page.unmount();
  }
});

test("the owner page of an unknown café shows 'Café not found', not a sign-in form", async () => {
  const page = await mount("demo-01", {
    config: async () => json({ error: "No café found at that web address." }, 404),
    signedIn: false,
  });
  try {
    await page.flush();
    assert.match(page.text(), /Café not found/);
    assert.equal(page.container.querySelector('input[type="password"]'), null);
  } finally {
    await page.unmount();
  }
});
