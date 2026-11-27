// The owner-board half of menu editing: the Edit button, the prefilled form, the PATCH it sends, a
// refused invalid price, Cancel, and the guard that stops one click becoming two writes.
//
// Admin.jsx is bundled with esbuild into a throwaway module (tests/.tmp) and rendered in jsdom, the
// same technique the photo-control tests use. Nothing here reaches a network or a database.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp");
const bundlePath = path.join(workDir, "menu-edit.bundle.mjs");

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/c/review-cafe/owner",
  pretendToBeVisual: true,
});
const { window } = dom;

globalThis.window = window;
globalThis.document = window.document;
globalThis.HTMLElement = window.HTMLElement;
globalThis.HTMLInputElement = window.HTMLInputElement;
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

const SLUG = "review-cafe";
const ITEM = {
  id: 1,
  category: "Chai & Coffee",
  name: "Masala Chai",
  description: "House blend",
  priceCents: 5000,
  emoji: "🫖",
  available: true,
  imageUrl: null,
  hasCustomImage: false,
};

function json(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

async function mount() {
  const requests = [];
  let items = [{ ...ITEM }];

  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    requests.push({ url: href, method: init.method || "GET", headers: init.headers || {}, body: init.body });
    const match = href.match(/\/api\/cafes\/([^/]+)\/(.*)$/);
    const rest = match ? match[2] : href.replace(/^\/api\//, "");
    if (rest === "config") {
      return json({
        currency: "INR",
        slug: SLUG,
        cafe: { name: "REVIEW CAFÉ" },
        service: { mode: "counter" },
        payments: { provider: "none", gateway: false, keyId: null },
      });
    }
    if (rest === "admin/session") return json({ ok: true, expiresIn: 3600, csrfToken: "csrf-test-token" });
    if (rest === "admin/orders") return json({ orders: [], statistics: null });
    if (rest === "admin/menu") return json({ items });
    const patch = rest.match(/^admin\/menu\/(\d+)$/);
    if (patch && (init.method || "GET") === "PATCH") {
      const body = JSON.parse(String(init.body || "{}"));
      items = items.map((item) => (item.id === Number(patch[1]) ? { ...item, ...body } : item));
      return json({ ok: true, item: { id: Number(patch[1]), ...body } });
    }
    return json({});
  };
  window.confirm = () => true;
  window.history.replaceState({}, "", `/c/${SLUG}/owner`);
  window.localStorage.clear();
  window.sessionStorage.clear();

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
          React.createElement(Route, { path: "/c/:slug/owner", element: React.createElement(Admin) })
        )
      )
    );
  });
  await flush();

  const menuTab = [...container.querySelectorAll(".admin-tabs button")].find(
    (button) => button.textContent.trim() === "Menu"
  );
  assert.ok(menuTab, "the Menu tab must exist");
  await act(async () => {
    menuTab.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
  });
  await flush();

  return {
    container,
    requests,
    items: () => items,
    async click(element) {
      await act(async () => {
        element.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
      });
      await flush();
    },
    async unmount() {
      await act(async () => {
        reactRoot.unmount();
      });
      container.remove();
    },
  };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function editButton(container, name = "Masala Chai") {
  return [...container.querySelectorAll(".admin-item-actions button")].find(
    (button) => button.getAttribute("aria-label") === `Edit ${name}`
  );
}

function editForm(container) {
  return [...container.querySelectorAll("form")].find(
    (form) => (form.querySelector("h2") || {}).textContent === "Edit item"
  );
}

function field(container, label) {
  return [...container.querySelectorAll("label.field")].find(
    (node) => node.querySelector("span") && node.querySelector("span").textContent.trim() === label
  );
}

function setValue(input, value) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  setter.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

async function openEditor(page) {
  const button = editButton(page.container);
  assert.ok(button, "every item offers an Edit button");
  await page.click(button);
  const form = editForm(page.container);
  assert.ok(form, "the edit form opens");
  return form;
}

async function submit(page, form) {
  await act(async () => {
    form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();
}

const patches = (requests) => requests.filter((r) => r.method === "PATCH" && /\/admin\/menu\/\d+$/.test(r.url));

/* ------------------------------------------------------------------ the form is prefilled */

test("the Edit button opens a form filled with the item's current values", async () => {
  const page = await mount();
  try {
    const form = await openEditor(page);

    assert.equal(field(form, "Name").querySelector("input").value, "Masala Chai");
    assert.equal(field(form, "Category").querySelector("input").value, "Chai & Coffee");
    assert.equal(field(form, "Price").querySelector("input").value, "50.00");
    assert.equal(field(form, "Icon").querySelector("input").value, "🫖");
    assert.equal(field(form, "Description").querySelector("input").value, "House blend");

    const available = field(form, "Availability").querySelector('input[type="checkbox"]');
    assert.ok(available, "availability is editable in the form");
    assert.equal(available.checked, true, "the current availability is reflected");

    // The row still offers its sold-out switch; the edit form did not replace it.
    const row = [...page.container.querySelectorAll(".admin-item")][0];
    assert.ok(row.querySelector(".switch"), "the sold-out control stays in the row");
    assert.ok(row.querySelector(".admin-item-photo"), "the photo control stays in the row");
  } finally {
    await page.unmount();
  }
});

test("opening the editor brings it into view and puts the cursor in the Name field", async () => {
  // The editor sits below the whole menu; without this, pressing Edit on a long menu looked like nothing
  // happened because the form opened far below the screen.
  const scrolled = [];
  const original = window.HTMLElement.prototype.scrollIntoView;
  window.HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    scrolled.push(this);
  };
  const page = await mount();
  try {
    const form = await openEditor(page);
    await flush();
    assert.ok(scrolled.includes(form), "the edit form is scrolled into view");
    assert.equal(window.document.activeElement, field(form, "Name").querySelector("input"));
  } finally {
    window.HTMLElement.prototype.scrollIntoView = original;
    await page.unmount();
  }
});

/* ------------------------------------------------------------------ saving sends the edit */

test("saving sends one CSRF-protected PATCH with every edited field", async () => {
  const page = await mount();
  try {
    const form = await openEditor(page);
    setValue(field(form, "Name").querySelector("input"), "Masala Chai (Large)");
    setValue(field(form, "Category").querySelector("input"), "Signature Chai");
    setValue(field(form, "Price").querySelector("input"), "55.50");
    setValue(field(form, "Icon").querySelector("input"), "☕");
    setValue(field(form, "Description").querySelector("input"), "Extra strong");
    await page.click(field(form, "Availability").querySelector('input[type="checkbox"]'));

    await submit(page, form);

    const sent = patches(page.requests);
    assert.equal(sent.length, 1, "exactly one PATCH");
    assert.equal(sent[0].url, `/api/cafes/${SLUG}/admin/menu/1`);
    assert.equal(sent[0].headers["x-csrf-token"], "csrf-test-token");
    assert.deepEqual(JSON.parse(sent[0].body), {
      name: "Masala Chai (Large)",
      category: "Signature Chai",
      description: "Extra strong",
      emoji: "☕",
      priceCents: 5550,
      available: false,
    });

    assert.equal(editForm(page.container), undefined, "the form closes after a successful save");
    assert.match(page.container.textContent, /Saved Masala Chai \(Large\)/, "a visible success message");
    assert.equal(page.items()[0].name, "Masala Chai (Large)", "the row reloads from the server");
    assert.equal(patches(page.requests).length, 1, "no second write followed the reload");
  } finally {
    await page.unmount();
  }
});

/* ------------------------------------------------------------------ cancel and validation */

test("Cancel sends nothing and leaves the item as it was", async () => {
  const page = await mount();
  try {
    const form = await openEditor(page);
    setValue(field(form, "Name").querySelector("input"), "Should Not Save");
    const cancel = [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "Cancel");
    await page.click(cancel);

    assert.equal(patches(page.requests).length, 0, "Cancel issued no write");
    assert.equal(editForm(page.container), undefined, "the form closes");
    assert.match(
      [...page.container.querySelectorAll(".admin-item")][0].textContent,
      /Masala Chai/,
      "the row still shows the original name"
    );
  } finally {
    await page.unmount();
  }
});

test("an invalid price is refused before any request is sent", async () => {
  const page = await mount();
  try {
    const form = await openEditor(page);
    setValue(field(form, "Price").querySelector("input"), "");
    await submit(page, form);

    assert.equal(patches(page.requests).length, 0, "no invalid price reached the server");
    const alert = page.container.querySelector('[role="alert"]');
    assert.ok(alert, "the refusal is announced");
    assert.match(alert.textContent, /price/i);
    assert.ok(editForm(page.container), "the form stays open so the value can be corrected");
  } finally {
    await page.unmount();
  }
});

test("a repeated submit sends only one PATCH", async () => {
  const page = await mount();
  try {
    const form = await openEditor(page);
    setValue(field(form, "Price").querySelector("input"), "60.00");

    await act(async () => {
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
    });
    await flush();

    assert.equal(patches(page.requests).length, 1, "one click cannot become two writes");
    assert.equal(JSON.parse(patches(page.requests)[0].body).priceCents, 6000);
  } finally {
    await page.unmount();
  }
});
