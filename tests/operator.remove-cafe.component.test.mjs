// The operator console's "Remove café" flow: the main café has no remove button, archive and
// permanent delete stay disabled until the exact phrase is typed, and each sends the confirmation
// the server checks, with the console's CSRF token.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-operator-remove");
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

// jsdom does not implement scrolling; the console calls it from its header action, so stub it.
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

const ACTIVE = [
  { slug: "corner-cup", name: "Corner Cup", serviceMode: "tables", menuCount: 4, openCount: 1, primary: true },
  { slug: "second-outlet", name: "Second Outlet", serviceMode: "counter", menuCount: 2, openCount: 0, primary: false },
];
const ARCHIVED = [
  { slug: "old-kiosk", name: "Old Kiosk", serviceMode: "counter", menuCount: 3, orderCount: 9, openCount: 0, primary: false, archivedAt: 1 },
];

async function mount() {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    calls.push({ path, method: init.method || "GET", headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
    if (path.endsWith("/api/operator/session")) return json({ ok: true, expiresIn: 3600, csrfToken: "csrf-1" });
    if (path.endsWith("/api/operator/cafes")) return json({ cafes: ACTIVE, archived: ARCHIVED });
    return json({ ok: true, slug: "x", photosLeft: 0 });
  };
  window.history.replaceState({}, "", "/operator");
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
  await flush();
  const chip = (name) => [...container.querySelectorAll(".table-chip")].find((el) => el.textContent.includes(name));
  const buttonIn = (el, text) => [...el.querySelectorAll("button")].find((b) => b.textContent.trim() === text) || null;
  return {
    container,
    calls,
    chip,
    buttonIn,
    mutations: () => calls.filter((c) => c.method !== "GET" && !c.path.endsWith("/session")),
    async click(element) {
      await act(async () => {
        element.dispatchEvent(new window.MouseEvent("click", { bubbles: true, cancelable: true }));
      });
      await flush();
    },
    async type(value) {
      const input = container.querySelector("form.reset-reveal input");
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
      await flush();
    },
    async unmount() {
      await act(async () => reactRoot.unmount());
      container.remove();
    },
  };
}

test("the main café has no remove button; other cafés do", async () => {
  const ui = await mount();
  assert.equal(ui.buttonIn(ui.chip("Corner Cup"), "Remove café"), null);
  assert.ok(ui.chip("Corner Cup").textContent.includes("Main café"));
  assert.ok(ui.buttonIn(ui.chip("Second Outlet"), "Remove café"));
  await ui.unmount();
});

test("archive stays disabled until the exact slug is typed, then sends it with the CSRF token", async () => {
  const ui = await mount();
  await ui.click(ui.buttonIn(ui.chip("Second Outlet"), "Remove café"));
  const form = ui.container.querySelector("form.reset-reveal");
  assert.ok(form, "the confirmation opens");
  const submit = ui.buttonIn(form, "Archive café");
  assert.equal(submit.disabled, true);

  await ui.type("second-outle");
  assert.equal(ui.buttonIn(form, "Archive café").disabled, true, "a near miss is not enough");
  assert.deepEqual(ui.mutations(), []);

  await ui.type("second-outlet");
  assert.equal(ui.buttonIn(form, "Archive café").disabled, false);
  await ui.click(ui.buttonIn(form, "Archive café"));

  const [call] = ui.mutations();
  assert.equal(call.method, "POST");
  assert.ok(call.path.endsWith("/api/operator/cafes/second-outlet/archive"));
  assert.deepEqual(call.body, { confirmSlug: "second-outlet" });
  assert.equal(call.headers["x-csrf-token"], "csrf-1");
  await ui.unmount();
});

test("cancel closes the confirmation without sending anything", async () => {
  const ui = await mount();
  await ui.click(ui.buttonIn(ui.chip("Second Outlet"), "Remove café"));
  await ui.type("second-outlet");
  await ui.click(ui.buttonIn(ui.container.querySelector("form.reset-reveal"), "Cancel"));
  assert.equal(ui.container.querySelector("form.reset-reveal"), null);
  assert.deepEqual(ui.mutations(), []);
  await ui.unmount();
});

test("archived cafés are listed with restore and a second typed confirmation for delete", async () => {
  const ui = await mount();
  const section = ui.container.querySelector('[aria-label="Archived cafés"]');
  assert.ok(section && section.textContent.includes("Old Kiosk"));
  assert.ok(!ui.chip("Second Outlet").closest('[aria-label="Archived cafés"]'), "active cafés are not in it");

  await ui.click(ui.buttonIn(ui.chip("Old Kiosk"), "Delete permanently"));
  const form = ui.container.querySelector("form.reset-reveal");
  assert.ok(form.textContent.includes("can't be undone"));
  await ui.type("old-kiosk");
  assert.equal(ui.buttonIn(form, "Delete permanently").disabled, true, "the slug alone is not the delete phrase");
  await ui.type("delete old-kiosk");
  await ui.click(ui.buttonIn(form, "Delete permanently"));

  const [call] = ui.mutations();
  assert.equal(call.method, "DELETE");
  assert.ok(call.path.endsWith("/api/operator/cafes/old-kiosk"));
  assert.deepEqual(call.body, { confirmSlug: "old-kiosk", confirmDelete: "delete old-kiosk" });
  assert.equal(call.headers["x-csrf-token"], "csrf-1");
  await ui.unmount();
});

test("restore sends the archived café's slug", async () => {
  const ui = await mount();
  await ui.click(ui.buttonIn(ui.chip("Old Kiosk"), "Restore"));
  const [call] = ui.mutations();
  assert.equal(call.method, "POST");
  assert.ok(call.path.endsWith("/api/operator/cafes/old-kiosk/restore"));
  assert.deepEqual(call.body, { confirmSlug: "old-kiosk" });
  await ui.unmount();
});
