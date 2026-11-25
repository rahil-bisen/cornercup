#!/usr/bin/env node
// End-to-end verification of the disposable local pilot, over the real HTTP surface of the Worker.
// It never prints a password, a TOTP secret or a recovery code, and it only touches the pilot
// database under .local-pilot/state.
//
//   node scripts/pilot-verify.mjs
//
// Exit code 0 means every check passed. Any failure is reported with the status and response body so
// it can be diagnosed, and the process exits 1.

import crypto from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".local-pilot", "pilot.env");
const BASE = "http://127.0.0.1:8788";
const ORIGIN = BASE;
const SLUG = "corner-cup-local-pilot";
const CAFE = `/api/cafes/${SLUG}`;

if (!existsSync(ENV_FILE)) {
  console.error("Missing .local-pilot/pilot.env. Run `node scripts/local-pilot.mjs start` first.");
  process.exit(1);
}

function readEnv(file) {
  const out = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const index = line.indexOf("=");
    out[line.slice(0, index).trim()] = line.slice(index + 1).trim();
  }
  return out;
}

const env = readEnv(ENV_FILE);
const OWNER_PASSWORD = env.OWNER_PASSWORD;
if (!OWNER_PASSWORD) {
  console.error("OWNER_PASSWORD is missing from .local-pilot/pilot.env.");
  process.exit(1);
}

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const json = async (res) => {
  try {
    return await res.json();
  } catch {
    return null;
  }
};
const brief = (status, body) => `${status} ${JSON.stringify(body).slice(0, 220)}`;

function session() {
  return { cookie: "" };
}

async function call(method, pathName, { body, form, token, csrf, jar, headers = {} } = {}) {
  const h = { origin: ORIGIN, ...headers };
  if (jar && jar.cookie) h.cookie = jar.cookie;
  if (token) h["x-order-token"] = token;
  if (csrf) h["x-csrf-token"] = csrf;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${BASE}${pathName}`, {
    method,
    headers: h,
    body: form ? form : body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  if (jar) {
    const setCookies = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const raw of setCookies) {
      const pair = raw.split(";")[0];
      const index = pair.indexOf("=");
      if (index === -1) continue;
      const name = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      if (!value) jar.cookie = "";
      else jar.cookie = `${name}=${value}`;
    }
  }
  const parsed = method === "HEAD" ? null : await json(res);
  return { status: res.status, body: parsed, headers: res.headers };
}

/* ------------------------------------------------------------------ TOTP */

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function base32Decode(text) {
  const clean = String(text).toUpperCase().replace(/[\s-]/g, "").replace(/=+$/, "");
  let bits = 0;
  let value = 0;
  const out = [];
  for (const char of clean) {
    const index = B32.indexOf(char);
    if (index === -1) return null;
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function totpCode(secretBase32, step = currentStep()) {
  const key = base32Decode(secretBase32);
  if (!key) return null;
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const digest = crypto.createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(binary % 1_000_000).padStart(6, "0");
}

function currentStep() {
  return Math.floor(Date.now() / 1000 / 30);
}

async function waitForNextStep(usedStep) {
  const target = (usedStep + 1) * 30_000 + 1200;
  const wait = Math.max(0, target - Date.now());
  console.log(`INFO  waiting ${Math.ceil(wait / 1000)}s for a fresh TOTP time step...`);
  await sleep(wait);
}

async function loginPassword(jar = session()) {
  const res = await call("POST", `${CAFE}/admin/login`, { body: { password: OWNER_PASSWORD }, jar });
  return { ...res, jar };
}

async function sessionInfo(jar) {
  const res = await call("GET", `${CAFE}/admin/session`, { jar });
  return { ...res, csrf: res.body && res.body.csrfToken };
}

async function totpLogin(challenge, code, jar = session()) {
  return { ...(await call("POST", `${CAFE}/admin/login/totp`, { body: { challenge, code }, jar })), jar };
}

/* ------------------------------------------------------------------ run */

let firstItemId = null;
let mfaSecret = null;
let recoveryCodes = [];
let lastUsedStep = null;

// 1. Guest surface.
{
  const res = await call("GET", "/api/health");
  check("health endpoint answers", res.status === 200, brief(res.status, res.body));

  const config = await call("GET", `${CAFE}/config`);
  check(
    "config reports counter-free online payments (Razorpay absent)",
    config.status === 200 && config.body && config.body.payments && config.body.payments.provider === "none",
    brief(config.status, config.body && config.body.payments)
  );
  check(
    "config names the pilot café",
    config.body && config.body.cafe && config.body.cafe.name === "Corner Cup Local Pilot",
    config.body && config.body.cafe && config.body.cafe.name
  );

  const menu = await call("GET", `${CAFE}/menu`);
  const categories = (menu.body && menu.body.categories) || [];
  const items = categories.flatMap((category) => category.items || []);
  check("guest menu browses with 200", menu.status === 200);
  check("menu has the 27 seeded items", items.length === 27, `${items.length} items in ${categories.length} categories`);
  check("every seeded item falls back to a default image (imageUrl null)", items.every((item) => item.imageUrl === null));
  check("every item carries an emoji fallback", items.every((item) => typeof item.emoji === "string" && item.emoji.length > 0));
  firstItemId = items[0] ? items[0].id : null;

  for (const image of ["coffee.jpg", "cold-drink.jpg", "snack.jpg", "main.jpg", "dessert.jpg"]) {
    const res = await fetch(`${BASE}/defaults/${image}`);
    check(
      `default photograph /defaults/${image} is served`,
      res.status === 200 && String(res.headers.get("content-type") || "").startsWith("image/"),
      `${res.status} ${res.headers.get("content-type")}`
    );
  }

  const tableMenu = await call("GET", `${CAFE}/menu?table=1`);
  check(
    "dine-in table link resolves to table 1",
    tableMenu.status === 200 && tableMenu.body && tableMenu.body.table && tableMenu.body.table.id === 1,
    brief(tableMenu.status, tableMenu.body && tableMenu.body.table)
  );

  const unknown = await call("GET", "/api/cafes/not-a-real-cafe/menu");
  check("unknown café slug is a 404", unknown.status === 404, brief(unknown.status, unknown.body));
}

// 2. Owner sign-in and CSRF.
const owner = session();
{
  const wrong = await call("POST", `${CAFE}/admin/login`, { body: { password: "definitely-not-it" }, jar: session() });
  check("wrong owner password is refused with 401", wrong.status === 401, brief(wrong.status, wrong.body));

  const login = await loginPassword(owner);
  check("owner password sign-in succeeds before MFA enrollment", login.status === 200 && Boolean(owner.cookie), brief(login.status, login.body));

  const info = await sessionInfo(owner);
  check("owner session endpoint issues a CSRF token", info.status === 200 && Boolean(info.csrf), brief(info.status, info.body));

  const noCsrf = await call("PATCH", `${CAFE}/admin/settings`, { body: { serviceMode: "tables" }, jar: owner, csrf: "" });
  check("settings write without a CSRF token is refused with 403", noCsrf.status === 403, brief(noCsrf.status, noCsrf.body));

  const saved = await call("PATCH", `${CAFE}/admin/settings`, { body: { serviceMode: "tables" }, jar: owner, csrf: info.csrf });
  check("settings write with a valid CSRF token succeeds", saved.status === 200, brief(saved.status, saved.body));

  const mfa = await call("GET", `${CAFE}/admin/mfa`, { jar: owner });
  check(
    "MFA reports available (independent local MFA_ENC_KEY) and not yet enabled",
    mfa.status === 200 && mfa.body && mfa.body.available === true && mfa.body.enabled === false,
    brief(mfa.status, mfa.body)
  );

  const enroll = await call("POST", `${CAFE}/admin/mfa/enroll`, {
    body: { currentPassword: OWNER_PASSWORD },
    jar: owner,
    csrf: info.csrf,
  });
  mfaSecret = enroll.body && enroll.body.secret;
  check(
    "TOTP enrollment returns a secret and otpauth URI",
    enroll.status === 200 && Boolean(mfaSecret) && String(enroll.body.otpauth || "").startsWith("otpauth://totp/"),
    brief(enroll.status, { issuer: enroll.body && enroll.body.issuer, digits: enroll.body && enroll.body.digits })
  );

  const upload = new FormData();
  upload.append("image", new Blob([Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")], { type: "image/png" }), "pilot.png");
  const noR2 = await call("POST", `${CAFE}/admin/menu/${firstItemId}/image`, { form: upload, jar: owner, csrf: info.csrf });
  check(
    "image upload is a clear 503 with R2 unconfigured",
    noR2.status === 503 && /storage/i.test(String((noR2.body && noR2.body.error) || "")),
    brief(noR2.status, noR2.body)
  );

  const off = await call("PATCH", `${CAFE}/admin/menu/${firstItemId}`, { body: { available: false }, jar: owner, csrf: info.csrf });
  check("owner can mark an item sold out", off.status === 200, brief(off.status, off.body));

  const menuAfterOff = await call("GET", `${CAFE}/menu`);
  const soldOut = ((menuAfterOff.body && menuAfterOff.body.categories) || [])
    .flatMap((category) => category.items || [])
    .find((item) => item.id === firstItemId);
  check("guest menu reflects the sold-out flag", soldOut && soldOut.available === false);

  const refusedOrder = await call("POST", `${CAFE}/orders`, {
    // The café is still in table mode here, so a dine-in order needs its table number.
    body: { items: [{ itemId: firstItemId, qty: 1 }], tableId: 1, paymentMethod: "counter" },
    headers: { "idempotency-key": `pilot-soldout-${Date.now()}` },
    jar: session(),
  });
  check(
    "ordering a sold-out item is refused with 409",
    refusedOrder.status === 409 && /sold out/i.test(String((refusedOrder.body && refusedOrder.body.error) || "")),
    brief(refusedOrder.status, refusedOrder.body)
  );

  const restored = await call("PATCH", `${CAFE}/admin/menu/${firstItemId}`, { body: { available: true }, jar: owner, csrf: info.csrf });
  check("owner can restore the item", restored.status === 200, brief(restored.status, restored.body));

  const created = await call("POST", `${CAFE}/admin/menu`, {
    body: { name: "Pilot Test Item", category: "Pilot", priceCents: 1234, emoji: "🧪", description: "Disposable verification item" },
    jar: owner,
    csrf: info.csrf,
  });
  const createdId = created.body && created.body.id;
  check("owner can create a menu item", created.status === 201 && Boolean(createdId), brief(created.status, created.body));
  if (createdId) {
    const menuAfterCreate = await call("GET", `${CAFE}/menu`);
    const count = ((menuAfterCreate.body && menuAfterCreate.body.categories) || []).flatMap((c) => c.items || []).length;
    check("created item appears on the guest menu (28)", count === 28, String(count));

    const deleted = await call("DELETE", `${CAFE}/admin/menu/${createdId}`, { jar: owner, csrf: info.csrf });
    check("owner can delete a menu item", deleted.status === 200, brief(deleted.status, deleted.body));
    const menuAfterDelete = await call("GET", `${CAFE}/menu`);
    const back = ((menuAfterDelete.body && menuAfterDelete.body.categories) || []).flatMap((c) => c.items || []).length;
    check("deleted item leaves the guest menu (27)", back === 27, String(back));
  }

  // 3. Confirm the second factor. This must invalidate the current password-only session.
  const confirmStep = currentStep();
  lastUsedStep = confirmStep;
  const confirm = await call("POST", `${CAFE}/admin/mfa/confirm`, {
    body: { code: totpCode(mfaSecret, confirmStep) },
    jar: owner,
    csrf: info.csrf,
  });
  recoveryCodes = (confirm.body && confirm.body.recoveryCodes) || [];
  check(
    "TOTP confirmation enables MFA and returns 10 recovery codes",
    confirm.status === 200 && confirm.body && confirm.body.enabled === true && recoveryCodes.length === 10,
    brief(confirm.status, { enabled: confirm.body && confirm.body.enabled, codes: recoveryCodes.length })
  );

  const deadSession = await call("GET", `${CAFE}/admin/session`, { jar: owner });
  check("enabling MFA invalidates the pre-existing session (401)", deadSession.status === 401, brief(deadSession.status, deadSession.body));

  // 4. Password alone now earns only a challenge; the spent code is a replay and is refused.
  const stepOne = await loginPassword(session());
  check(
    "password sign-in now returns an MFA challenge instead of a session",
    stepOne.status === 200 && stepOne.body && stepOne.body.mfaRequired === true && Boolean(stepOne.body.challenge),
    brief(stepOne.status, { mfaRequired: stepOne.body && stepOne.body.mfaRequired })
  );
  if (stepOne.body && stepOne.body.challenge) {
    const replay = await totpLogin(stepOne.body.challenge, totpCode(mfaSecret, confirmStep), stepOne.jar);
    check(
      "a spent TOTP code is refused as a replay (401)",
      replay.status === 401 && !replay.jar.cookie,
      brief(replay.status, replay.body)
    );
  }
}

// 5. Fresh TOTP sign-in, then the admin workflow.
const admin = session();
let adminCsrf = "";
{
  await waitForNextStep(lastUsedStep);
  const stepTwo = await loginPassword(admin);
  check("password step repeats after MFA is enabled", stepTwo.status === 200 && stepTwo.body && stepTwo.body.mfaRequired === true, brief(stepTwo.status, { mfaRequired: stepTwo.body && stepTwo.body.mfaRequired }));
  if (stepTwo.body && stepTwo.body.challenge) {
    const done = await totpLogin(stepTwo.body.challenge, totpCode(mfaSecret), admin);
    check("a fresh TOTP code completes sign-in", done.status === 200 && Boolean(done.jar.cookie), brief(done.status, done.body));
  }
  const info = await sessionInfo(admin);
  adminCsrf = info.csrf || "";
  check("MFA session issues a CSRF token", info.status === 200 && Boolean(adminCsrf), brief(info.status, info.body));

  const status = await call("GET", `${CAFE}/admin/mfa`, { jar: admin });
  check(
    "MFA status now reports enabled with 10 recovery codes remaining",
    status.status === 200 && status.body && status.body.enabled === true && status.body.recoveryCodesRemaining === 10,
    brief(status.status, status.body)
  );
}

// 6. Counter ordering, tracking and status transitions.
let counterOrder = null;
{
  const mode = await call("PATCH", `${CAFE}/admin/settings`, { body: { serviceMode: "counter" }, jar: admin, csrf: adminCsrf });
  check("owner can switch the café to counter service", mode.status === 200, brief(mode.status, mode.body));

  const created = await call("POST", `${CAFE}/orders`, {
    body: { items: [{ itemId: firstItemId, qty: 2 }], note: "pilot counter order", paymentMethod: "counter" },
    headers: { "idempotency-key": `pilot-counter-${Date.now()}` },
    jar: session(),
  });
  counterOrder = created.body && created.body.order;
  check(
    "counter checkout creates an order with a pickup queue number",
    created.status === 201 && counterOrder && typeof counterOrder.queueNo === "number" && counterOrder.tableId === null,
    brief(created.status, counterOrder && { id: counterOrder.id, queueNo: counterOrder.queueNo, total: counterOrder.totalCents })
  );

  const token = created.body && created.body.trackToken;
  const tracked = await call("GET", `${CAFE}/orders/${counterOrder.id}`, { token });
  check(
    "guest tracking reads the order with its token",
    tracked.status === 200 && tracked.body && tracked.body.order && tracked.body.order.status === "new",
    brief(tracked.status, tracked.body && tracked.body.order && tracked.body.order.status)
  );

  const badToken = await call("GET", `${CAFE}/orders/${counterOrder.id}`, { token: "not-the-right-token" });
  check("invalid tracking token is rejected with 404", badToken.status === 404, brief(badToken.status, badToken.body));

  const noToken = await call("GET", `${CAFE}/orders/${counterOrder.id}`);
  check("missing tracking token is rejected with 404", noToken.status === 404, brief(noToken.status, noToken.body));

  const badTransition = await call("PATCH", `${CAFE}/admin/orders/${counterOrder.id}`, {
    body: { status: "served" },
    jar: admin,
    csrf: adminCsrf,
  });
  check("skipping a status step is refused with 409", badTransition.status === 409, brief(badTransition.status, badTransition.body));

  for (const status of ["preparing", "ready", "served"]) {
    const moved = await call("PATCH", `${CAFE}/admin/orders/${counterOrder.id}`, { body: { status }, jar: admin, csrf: adminCsrf });
    check(`order advances to ${status}`, moved.status === 200, brief(moved.status, moved.body));
  }

  const adminOrders = await call("GET", `${CAFE}/admin/orders`, { jar: admin });
  const listed = adminOrders.body && (Array.isArray(adminOrders.body.orders) ? adminOrders.body.orders : adminOrders.body);
  const row = Array.isArray(listed) ? listed.find((order) => order.id === counterOrder.id) : null;
  check("kitchen board lists the order after its transitions", adminOrders.status === 200 && Boolean(row), row ? `status ${row.status}` : brief(adminOrders.status, adminOrders.body));
}

// 7. Dine-in table ordering.
{
  const mode = await call("PATCH", `${CAFE}/admin/settings`, { body: { serviceMode: "tables" }, jar: admin, csrf: adminCsrf });
  check("owner can switch back to table service", mode.status === 200, brief(mode.status, mode.body));

  const created = await call("POST", `${CAFE}/orders`, {
    body: { items: [{ itemId: firstItemId, qty: 1 }], tableId: 1, note: "pilot table order", paymentMethod: "counter" },
    headers: { "idempotency-key": `pilot-table-${Date.now()}` },
    jar: session(),
  });
  const order = created.body && created.body.order;
  check(
    "dine-in checkout creates a table order with queueNo null",
    created.status === 201 && order && order.tableId === 1 && order.queueNo === null,
    brief(created.status, order && { id: order.id, tableId: order.tableId, table: order.tableLabel })
  );
  const tracked = await call("GET", `${CAFE}/orders/${order.id}`, { token: created.body.trackToken });
  check("dine-in order is trackable", tracked.status === 200 && tracked.body.order.tableId === 1, brief(tracked.status, tracked.body && tracked.body.order && tracked.body.order.tableLabel));
}

// 8. Recovery code sign-in, its single use, and sign-out.
{
  const first = await loginPassword(session());
  if (first.body && first.body.challenge) {
    const viaRecovery = await totpLogin(first.body.challenge, recoveryCodes[0], first.jar);
    check("a recovery code completes sign-in", viaRecovery.status === 200 && Boolean(viaRecovery.jar.cookie), brief(viaRecovery.status, viaRecovery.body));
    const recoverySession = await sessionInfo(viaRecovery.jar);

    if (recoverySession.csrf) {
      const out = await call("POST", `${CAFE}/admin/logout`, { jar: viaRecovery.jar, csrf: recoverySession.csrf });
      check("owner sign-out succeeds", out.status === 200, brief(out.status, out.body));
      const after = await call("GET", `${CAFE}/admin/session`, { jar: viaRecovery.jar });
      check("signed-out session is refused (401)", after.status === 401, brief(after.status, after.body));
    }

    const second = await loginPassword(session());
    if (second.body && second.body.challenge) {
      const reuse = await totpLogin(second.body.challenge, recoveryCodes[0], second.jar);
      check("the same recovery code cannot be used twice (401)", reuse.status === 401, brief(reuse.status, reuse.body));
    }
  }
}

{
  // Sign-out-everywhere keeps the browser that asked for it and revokes every other session, so the
  // second session is created first (with a remaining recovery code) and is the one that must die.
  const other = session();
  const otherLogin = await loginPassword(other);
  let otherReady = false;
  if (otherLogin.body && otherLogin.body.challenge) {
    const viaRecovery = await totpLogin(otherLogin.body.challenge, recoveryCodes[1], other);
    otherReady = viaRecovery.status === 200 && Boolean(other.cookie);
  }
  check("a second owner session can be opened for the revocation test", otherReady);

  const all = await call("POST", `${CAFE}/admin/logout-all`, { jar: admin, csrf: adminCsrf });
  check("sign-out-everywhere succeeds", all.status === 200, brief(all.status, all.body));

  const otherAfter = await call("GET", `${CAFE}/admin/session`, { jar: other });
  check("sign-out-everywhere revokes the other session (401)", otherAfter.status === 401, brief(otherAfter.status, otherAfter.body));

  const acting = await call("GET", `${CAFE}/admin/session`, { jar: admin });
  check("sign-out-everywhere keeps the acting browser signed in", acting.status === 200, brief(acting.status, acting.body));

  const fresh = await sessionInfo(admin);
  if (fresh.csrf) {
    const out = await call("POST", `${CAFE}/admin/logout`, { jar: admin, csrf: fresh.csrf });
    check("final sign-out succeeds", out.status === 200, brief(out.status, out.body));
    const gone = await call("GET", `${CAFE}/admin/session`, { jar: admin });
    check("the acting session is revoked after sign-out (401)", gone.status === 401, brief(gone.status, gone.body));
  }
}

// 9. The Worker survived every unavailable-storage and auth path.
{
  const res = await call("GET", "/api/health");
  check("health still answers after all workflows", res.status === 200, brief(res.status, res.body));
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed.`);
if (failed.length) {
  console.log("Failures:");
  for (const failure of failed) console.log(`  - ${failure.name} ${failure.detail}`);
  process.exit(1);
}
