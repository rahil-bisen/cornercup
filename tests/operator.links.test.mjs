// The operator console is the only screen that lists every café, and it stays behind sign-in. Both of
// its old "café list" links pointed at "/", which DefaultCafe resolves to the primary café's customer
// menu — so the header item opened a menu, and the sign-in link promised a public list that does not
// and must not exist. These tests hold the corrected behaviour in place.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-operator-links");
const bundlePath = path.join(workDir, "operator.bundle.mjs");

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><head><title>start</title></head><body></body></html>", {
  url: "http://localhost/operator",
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

// jsdom does not implement scrolling; recording the calls is what proves the header action stays on
// this page instead of navigating.
const scrolledTo = [];
window.Element.prototype.scrollIntoView = function scrollIntoView(options) {
  scrolledTo.push({ element: this, options });
};

const { build } = await import("esbuild");
await mkdir(workDir, { recursive: true });
await build({
  entryPoints: [path.join(root, "src/pages/Operator.jsx")],
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
const { default: Operator } = await import(pathToFileURL(bundlePath).href);

test.after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function json(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

const CAFES = [
  { slug: "corner-cup", name: "Corner Cup", serviceMode: "tables", menuCount: 4, openCount: 1 },
  { slug: "second-outlet", name: "Second Outlet", serviceMode: "counter", menuCount: 2, openCount: 0 },
];

async function mount({ signedIn = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    calls.push({ path, method: (init && init.method) || "GET" });
    if (path.endsWith("/api/operator/session")) {
      return signedIn ? json({ ok: true, expiresIn: 3600, csrfToken: "csrf" }) : json({ error: "Sign in" }, 401);
    }
    if (path.endsWith("/api/operator/cafes")) return json({ cafes: CAFES });
    return json({});
  };

  window.history.replaceState({}, "", "/operator");
  window.localStorage.clear();
  scrolledTo.length = 0;

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
        React.createElement(Routes, null, React.createElement(Route, { path: "/operator", element: React.createElement(Operator) }))
      )
    );
  });
  await flush();

  return {
    container,
    calls,
    flush,
    text: () => container.textContent.replace(/\s+/g, " "),
    cafeListCalls: () => calls.filter((call) => call.path.endsWith("/api/operator/cafes")).length,
    buttonByText(text) {
      return [...container.querySelectorAll("button")].find((button) => button.textContent.trim() === text) || null;
    },
    linkByHref(href) {
      return [...container.querySelectorAll("a")].filter((a) => a.getAttribute("href") === href);
    },
    async click(element) {
      await act(async () => {
        element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flush();
    },
    async unmount() {
      await act(async () => reactRoot.unmount());
      container.remove();
    },
  };
}

test("the signed-in console never links to '/' — the only café list is the section below", async () => {
  const page = await mount({ signedIn: true });
  try {
    assert.match(page.text(), /Cafés/, "the console lists its cafés");
    assert.match(page.text(), /Corner Cup/);

    const toRoot = page.linkByHref("/");
    assert.equal(toRoot.length, 0, `no link on the signed-in console may open "/": ${toRoot.map((a) => a.textContent).join(",")}`);

    const header = page.buttonByText("Café list");
    assert.ok(header, "the header café-list action is a button, not a navigation");
  } finally {
    await page.unmount();
  }
});

test("the header café-list action refreshes the list and brings it into view without navigating", async () => {
  const page = await mount({ signedIn: true });
  try {
    const before = page.cafeListCalls();
    const header = page.buttonByText("Café list");
    await page.click(header);

    assert.equal(page.cafeListCalls(), before + 1, "the action refetches the café list");

    assert.equal(scrolledTo.length, 1, "the action scrolls the café section into view");
    const section = scrolledTo[0].element;
    assert.equal(section.tagName, "SECTION");
    assert.match(section.textContent, /Cafés/);
    assert.match(section.textContent, /Corner Cup/, "the scrolled-to element is the café list itself");
    assert.equal(page.linkByHref("/").length, 0, "clicking it does not turn into a navigation");
    // The only anchors left are the per-café chips that open that café's owner board.
    const hrefs = [...page.container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    assert.ok(hrefs.length > 0, "the café chips are still links");
    assert.ok(hrefs.every((href) => href.startsWith("/c/")), `unexpected link targets: ${hrefs.join(",")}`);
  } finally {
    await page.unmount();
  }
});

test("the sign-in screen names the customer site honestly instead of promising a public café list", async () => {
  const page = await mount({ signedIn: false });
  try {
    assert.match(page.text(), /Operator console/);
    const root = page.linkByHref("/");
    assert.equal(root.length, 1, "exactly one link leaves the console for the main site");
    assert.equal(root[0].textContent.trim(), "Go to main café site", "the label says where it goes");
    assert.doesNotMatch(page.text(), /Back to the café list/, "the old, inaccurate label is gone");
    assert.doesNotMatch(page.text(), /Cafés/, "the café list is not visible before sign-in");
  } finally {
    await page.unmount();
  }
});
