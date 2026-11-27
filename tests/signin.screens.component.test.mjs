// Both sign-in screens (owner and operator) show what the server said: a wrong password, a lockout with
// its wait, "not set up", a real server error, and the connection message when the request never got an
// answer. A failed sign-in always stays on the form.
//
// Admin.jsx and Operator.jsx are JSX, so they are bundled once with esbuild into throwaway modules.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const workDir = path.join(here, ".tmp-signin-screens");


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
  entryPoints: { admin: path.join(root, "src/pages/Admin.jsx"), operator: path.join(root, "src/pages/Operator.jsx") },
  outdir: workDir,
  outExtension: { ".js": ".mjs" },
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
const { default: Admin } = await import(pathToFileURL(path.join(workDir, "admin.mjs")).href);
const { default: Operator } = await import(pathToFileURL(path.join(workDir, "operator.mjs")).href);

test.after(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function json(body, status = 200, headers = {}) {
  return {
    ok: status < 400,
    status,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => JSON.stringify(body),
  };
}

// What the sign-in POST answers in each case, exactly as the Worker sends it.
const CASES = {
  "wrong password": () => json({ error: "Incorrect password. Please try again.", code: "wrong_password" }, 401),
  lockout: () =>
    json(
      { error: "Too many attempts. Please try again in 7 minutes.", code: "signin_locked", retryAfter: 420 },
      429,
      { "retry-after": "420" }
    ),
  "not set up": () =>
    json({ error: "Sign-in isn't set up yet. Please contact support.", code: "signin_not_configured" }, 503),
  "server error": () => json({ error: "Something went wrong. Please try again." }, 500),
  "network failure": () => Promise.reject(new TypeError("Failed to fetch")),
};

const EXPECTED = {
  "wrong password": "Incorrect password. Please try again.",
  lockout: "Too many attempts. Please try again in 7 minutes.",
  "not set up": "Sign-in isn't set up yet. Please contact support.",
  "server error": "Something went wrong. Please try again.",
  "network failure": "Couldn't connect. Check your internet connection and try again.",
};

const PAGES = {
  owner: {
    path: "/c/cafe-a/owner",
    route: "/c/:slug/owner",
    Component: () => Admin,
    loginUrl: /\/api\/cafes\/cafe-a\/admin\/login$/,
    sessionUrl: /\/api\/cafes\/cafe-a\/admin\/session$/,
  },
  operator: {
    path: "/operator",
    route: "/operator",
    Component: () => Operator,
    loginUrl: /\/api\/operator\/login$/,
    sessionUrl: /\/api\/operator\/session$/,
  },
};

async function signInOn(pageName, answer) {
  const page = PAGES[pageName];
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (page.sessionUrl.test(target)) return json({ error: "Not signed in." }, 401);
    if (page.loginUrl.test(target)) return answer();
    if (target.endsWith("/config")) {
      return json({
        currency: "INR",
        slug: "cafe-a",
        cafe: { name: "Cafe A" },
        service: { mode: "tables" },
        ownerAuth: "local",
        payments: { provider: "none", gateway: false, keyId: null },
      });
    }
    return json({});
  };
  window.history.replaceState({}, "", page.path);
  const container = window.document.createElement("div");
  window.document.body.appendChild(container);
  const reactRoot = createRoot(container);
  const flush = async () => {
    for (let i = 0; i < 3; i += 1) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
  };
  await act(async () => {
    reactRoot.render(
      React.createElement(
        BrowserRouter,
        null,
        React.createElement(Routes, null, React.createElement(Route, { path: page.route, element: React.createElement(page.Component()) }))
      )
    );
  });
  await flush();

  const input = container.querySelector('input[type="password"]');
  assert.ok(input, `${pageName}: the password form is showing`);
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(input, "a-password");
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  });
  await act(async () => {
    input.closest("form").dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true }));
  });
  await flush();

  const alert = container.querySelector('[role="alert"]');
  const result = { alert: alert ? alert.textContent.trim() : null, stillOnSignIn: Boolean(container.querySelector('input[type="password"]')) };
  await act(async () => reactRoot.unmount());
  container.remove();
  return result;
}

for (const pageName of Object.keys(PAGES)) {
  for (const caseName of Object.keys(CASES)) {
    test(`${pageName} sign-in, ${caseName}: the screen shows "${EXPECTED[caseName]}"`, async () => {
      const result = await signInOn(pageName, CASES[caseName]);
      assert.equal(result.alert, EXPECTED[caseName]);
      assert.ok(result.stillOnSignIn, "a failed sign-in stays on the sign-in form");
    });
  }
}
