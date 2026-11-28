// Stage 3D regressions for the two Stage 3C findings on the owner Menu tab.
//
// A-1 was a layout defect (rows grew to 456 px inside a 374 px phone viewport because the photo
// controls sat in the same non-wrapping flex row as the name). jsdom has no layout engine, so the
// behavioural half is asserted here — the controls are grouped into one `.admin-item-actions` block
// that the stylesheet is allowed to wrap — and the pixel result is measured in a real browser and
// recorded in STAGE3D_MENU_MOBILE_ACCESSIBILITY_REPORT.md.
//
// A-2 was an accessibility defect (a `hidden` file input inside a non-focusable label, so the picker
// was unreachable by keyboard and absent from the accessibility tree). That half is tested properly
// here: the control is a real button, the input is out of the tab order, and Save/Cancel/Remove post
// with the CSRF token and announce their outcome.
//
// Admin.jsx is JSX, so it is bundled once with esbuild into a throwaway module; nothing is added to
// the build output.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp");
const bundlePath = path.join(workDir, "admin.bundle.mjs");

const { JSDOM } = await import("jsdom");
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/c/review-cafe/owner",
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

// jsdom has no object-URL implementation; the page only needs a stable string for the preview src.
let objectUrls = 0;
URL.createObjectURL = () => `blob:review/${(objectUrls += 1)}`;
URL.revokeObjectURL = () => {};

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

const ITEMS = [
  {
    id: 1,
    category: "Chai & Coffee",
    name: "Masala Chai",
    description: "",
    priceCents: 5000,
    emoji: "🫖",
    available: true,
    imageUrl: null,
    hasCustomImage: false,
  },
  {
    id: 2,
    category: "Chai & Coffee",
    name: "Filter Coffee",
    description: "",
    priceCents: 6000,
    emoji: "☕",
    available: true,
    imageUrl: `/api/cafes/${SLUG}/menu/2/image?v=1`,
    hasCustomImage: true,
  },
];

function json(body, status = 200) {
  return { ok: status < 400, status, text: async () => JSON.stringify(body) };
}

// Mirrors the scoped paths api() builds, so the assertions below see the URLs the browser would use.
function respond(url, init = {}) {
  const match = url.match(/\/api\/cafes\/([^/]+)\/(.*)$/);
  const rest = match ? match[2] : url.replace(/^\/api\//, "");
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
  if (rest === "admin/menu") return json({ items: ITEMS });
  if (/^admin\/menu\/\d+\/image$/.test(rest)) {
    if (init.method === "DELETE") return json({ ok: true, imageUrl: null, hasCustomImage: false });
    return json({ ok: true, imageUrl: `/api/cafes/${SLUG}/menu/1/image?v=2`, hasCustomImage: true });
  }
  return json({});
}

async function mount() {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method || "GET", headers: init.headers || {}, body: init.body });
    return respond(String(url), init);
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

  // The board opens on Orders; the menu and its photo controls live behind this tab.
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
    row(itemId) {
      return [...container.querySelectorAll(".admin-item")].find((li) =>
        li.querySelector(".admin-item-text strong").textContent.includes(itemId === 1 ? "Masala Chai" : "Filter Coffee")
      );
    },
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

function pickFile(row, name = "photo.png") {
  const input = row.querySelector('input[type="file"]');
  assert.ok(input, "the row must keep a file input");
  const file = new window.File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], name, { type: "image/png" });
  Object.defineProperty(input, "files", { value: [file], configurable: true });
  return input;
}

const liveRegion = (container) => container.querySelector('[role="status"]');

/* ------------------------------------------------------- A-2: keyboard access */

test("A-2: the photo picker is a real button and the file input stays out of the tab order", async () => {
  const page = await mount();
  try {
    const row = page.row(1);
    const upload = row.querySelector(".admin-item-photo button");
    assert.ok(upload, "the picker must be a button");
    assert.equal(upload.textContent.trim(), "Upload / Replace");
    assert.equal(upload.getAttribute("aria-label"), "Upload photo for Masala Chai");

    // The decorative input remains, hidden from both the tab order and the accessibility tree, so the
    // action is offered exactly once.
    const input = row.querySelector('input[type="file"]');
    assert.equal(input.hidden, true, "the input itself must stay hidden");
    assert.equal(input.getAttribute("tabindex"), "-1");
    assert.equal(input.getAttribute("aria-hidden"), "true");
    assert.equal(input.accept, "image/jpeg,image/png,image/webp");

    // The old non-focusable label wrapper must be gone.
    assert.equal(row.querySelector("label.file-pick"), null);
    assert.equal(row.querySelector("label"), null, "no label stands in for the button");

    // Pressing the button opens the picker.
    let opened = 0;
    input.click = () => {
      opened += 1;
    };
    await page.click(upload);
    assert.equal(opened, 1, "the button must open the hidden file picker");
  } finally {
    await page.unmount();
  }
});

test("A-2: picking a photo previews it, Cancel restores the default, and the change is announced", async () => {
  const page = await mount();
  try {
    const row = page.row(1);
    const input = pickFile(row);
    await act(async () => {
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await flush();

    assert.match(row.textContent, /Preview \(not saved\)/);
    const save = [...row.querySelectorAll(".admin-item-photo button")].find((b) => b.textContent.trim() === "Save photo");
    const cancel = [...row.querySelectorAll(".admin-item-photo button")].find((b) => b.textContent.trim() === "Cancel");
    assert.ok(save, "Save photo must appear");
    assert.ok(cancel, "Cancel must appear");
    assert.equal(save.disabled, false);
    assert.equal(cancel.disabled, false);
    assert.match(liveRegion(page.container).textContent, /Photo ready to save for Masala Chai/);

    await page.click(cancel);
    assert.doesNotMatch(row.textContent, /Preview \(not saved\)/);
    assert.match(row.textContent, /No photo yet/);
    assert.match(row.querySelector(".admin-item-photo button").textContent, /Upload \/ Replace/);
    assert.match(liveRegion(page.container).textContent, /Preview cancelled for Masala Chai/);
  } finally {
    await page.unmount();
  }
});

test("A-2: Save photo posts multipart with the CSRF token and announces the result", async () => {
  const page = await mount();
  try {
    const row = page.row(1);
    const input = pickFile(row);
    await act(async () => {
      input.dispatchEvent(new window.Event("change", { bubbles: true }));
    });
    await flush();

    const save = [...row.querySelectorAll(".admin-item-photo button")].find((b) => b.textContent.trim() === "Save photo");
    await page.click(save);

    const posted = page.requests.filter((r) => r.url.endsWith("/admin/menu/1/image") && r.method === "POST");
    assert.equal(posted.length, 1, "one upload per Save");
    assert.equal(posted[0].url, `/api/cafes/${SLUG}/admin/menu/1/image`);
    assert.equal(posted[0].headers["x-csrf-token"], "csrf-test-token", "the mutation must carry the CSRF token");
    assert.ok(posted[0].body instanceof FormData, "the upload must be multipart");
    assert.match(liveRegion(page.container).textContent, /Photo saved for Masala Chai/);

    const after = page.row(1);
    assert.match(after.querySelector(".admin-item-photo button").textContent, /Upload \/ Replace/);
  } finally {
    await page.unmount();
  }
});

test("A-2: Remove photo deletes with the CSRF token and announces the default is back", async () => {
  const page = await mount();
  try {
    const row = page.row(2);
    const remove = [...row.querySelectorAll(".admin-item-photo button")].find((b) =>
      b.textContent.trim() === "Remove photo"
    );
    assert.ok(remove, "an item with a custom photo offers Remove");
    assert.equal(remove.getAttribute("aria-label"), "Remove photo from Filter Coffee");

    await page.click(remove);

    const deleted = page.requests.filter((r) => r.url.endsWith("/admin/menu/2/image") && r.method === "DELETE");
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].headers["x-csrf-token"], "csrf-test-token");
    assert.match(liveRegion(page.container).textContent, /Custom photo removed from Filter Coffee/);
  } finally {
    await page.unmount();
  }
});

/* ------------------------------------------------------------ A-1: row layout */

test("A-1: row controls are grouped so a narrow screen can wrap them, and the stylesheet does", async () => {
  const page = await mount();
  try {
    const row = page.row(1);
    const actions = row.querySelector(".admin-item-actions");
    assert.ok(actions, "the row controls must share one group");
    assert.ok(actions.querySelector(".admin-item-photo"), "the photo control belongs to that group");
    assert.ok(actions.querySelector(".switch"), "the availability toggle belongs to that group");
    assert.ok(actions.querySelector(".icon-btn.danger"), "the delete button belongs to that group");

    // The name column must not carry a fixed width that could starve it on a phone.
    const text = row.querySelector(".admin-item-text");
    assert.equal(text.style.width, "", "no inline width is allowed on the name column");

    const css = await readFile(path.join(root, "src/styles.css"), "utf8");
    const base = cssBlock(css, ".admin-item-actions");
    assert.ok(base, ".admin-item-actions must be styled");
    assert.match(base, /display:\s*flex/);
    assert.match(cssBlock(css, ".admin-item-photo") || "", /flex-wrap:\s*wrap/, "the photo row may wrap");

    const phone = cssMedia(css, "max-width: 640px");
    assert.ok(phone, "a phone breakpoint must exist for the menu rows");
    assert.match(cssBlock(phone, ".admin-item") || "", /flex-wrap:\s*wrap/, "the row itself must be allowed to wrap");
    assert.match(
      cssBlock(phone, ".admin-item-actions") || "",
      /flex:\s*1 1 100%/,
      "the controls must take their own line instead of squeezing the name"
    );
  } finally {
    await page.unmount();
  }
});

// Returns the body of a rule whose selector starts `selector`, or null.
function cssBlock(css, selector) {
  const start = css.indexOf(selector + " {");
  if (start === -1) return null;
  const open = css.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

// Returns the body of the first @media query whose condition contains `condition`.
function cssMedia(css, condition) {
  const at = css.indexOf(`@media (${condition})`);
  if (at === -1) return null;
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
}

test("each sold-out switch names the item it controls and reports its state", async () => {
  const page = await mount();
  try {
    for (const [itemId, name] of [[1, "Masala Chai"], [2, "Filter Coffee"]]) {
      const toggle = page.row(itemId).querySelector(".switch");
      assert.equal(toggle.getAttribute("aria-label"), `${name} available`);
      assert.equal(toggle.getAttribute("aria-pressed"), "true");
    }
  } finally {
    await page.unmount();
  }
});
