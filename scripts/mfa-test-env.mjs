// Isolated, disposable environment for the MFA browser acceptance tests.
//
// Safety properties this script enforces:
//   * port 8791 only — it refuses to touch the pilot on 8788;
//   * its own config, its own .dev.vars and its own D1 state under .mfa-test/ (ignored by git), so the
//     project's .dev.vars, .local-pilot/ state and any staging/production database cannot be reached;
//   * local mode only (no --remote, placeholder database id), no R2 binding, no payment keys;
//   * a dedicated 32-byte base64url test key, generated on this machine for this environment only;
//   * start-up isolation checks: the café slug must be the test slug and payments must report `none`
//     (if the project's dev vars leaked in, Razorpay keys would make the provider `razorpay`).
//
// Commands:
//   node scripts/mfa-test-env.mjs start [--mode valid|missing|malformed]
//   node scripts/mfa-test-env.mjs stop
//   node scripts/mfa-test-env.mjs status
//   node scripts/mfa-test-env.mjs reset          # stop and delete the disposable database
//
// Secrets live in .mfa-test/test.env and are never printed by this script.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(root, ".mfa-test");
const STATE = path.join(DIR, "state");
const CONFIG = path.join(DIR, "wrangler.jsonc");
const DEV_VARS = path.join(DIR, ".dev.vars");
const ENV_FILE = path.join(DIR, "test.env");
const RUN_FILE = path.join(DIR, "server.json");
const LOG_FILE = path.join(DIR, "server.log");

const PORT = 8791;
const SLUG = "mfa-test-cafe";
const MODES = ["valid", "missing", "malformed"];
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function assertSafePaths() {
  if (PORT === 8788) fail("refusing to use the pilot port 8788");
  for (const [label, value] of [["state", STATE], ["config", CONFIG], ["env", ENV_FILE]]) {
    if (!path.resolve(value).startsWith(path.resolve(DIR) + path.sep)) {
      fail(`${label} path is outside the disposable directory: ${value}`);
    }
  }
}

function parseEnv(text) {
  const out = {};
  for (const line of text.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) out[match[1]] = match[2];
  }
  return out;
}

function canonicalKey(value) {
  if (!KEY_PATTERN.test(value)) return false;
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(normalised, "base64");
  if (bytes.length !== 32) return false;
  return bytes.toString("base64url") === value;
}

function generateEnv() {
  const key = crypto.randomBytes(32).toString("base64url");
  if (!canonicalKey(key)) throw new Error("generated key is not canonical");
  return [
    "# Disposable test-only credentials for .mfa-test. Never used by the pilot, staging or production.",
    "# Delete .mfa-test/ (or run `reset`) to discard them. Do not copy these values anywhere.",
    `MFA_ENC_KEY=${key}`,
    `ADMIN_SECRET=${crypto.randomBytes(32).toString("hex")}`,
    `OWNER_PASSWORD=mfa-test-${crypto.randomBytes(9).toString("base64url")}`,
    "",
  ].join("\n");
}

function ensureEnv() {
  fs.mkdirSync(DIR, { recursive: true });
  if (!fs.existsSync(ENV_FILE)) fs.writeFileSync(ENV_FILE, generateEnv(), { mode: 0o600 });
  const env = parseEnv(fs.readFileSync(ENV_FILE, "utf8"));
  for (const key of ["MFA_ENC_KEY", "ADMIN_SECRET", "OWNER_PASSWORD"]) {
    if (!env[key]) fail(`.mfa-test/test.env is missing ${key}; run \`reset --new\` or delete the directory`);
  }
  if (!canonicalKey(env.MFA_ENC_KEY)) fail("MFA_ENC_KEY in .mfa-test/test.env is not 32-byte canonical base64url");
  if ((env.OWNER_PASSWORD || "").length < 12) fail("test OWNER_PASSWORD must be at least 12 characters");
  return env;
}

function writeConfig(env, mode) {
  const mfa =
    mode === "missing" ? {} : { MFA_ENC_KEY: mode === "malformed" ? "not-a-valid-mfa-key" : env.MFA_ENC_KEY };
  const config = {
    $schema: "../node_modules/wrangler/config-schema.json",
    name: "corner-cup-mfa-test",
    main: "../worker/index.js",
    compatibility_date: "2025-11-01",
    rules: [{ type: "CompiledWasm", globs: ["../**/*.wasm"], fallthrough: true }],
    assets: {
      directory: "../dist",
      binding: "ASSETS",
      not_found_handling: "single-page-application",
      run_worker_first: true,
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: "corner-cup-mfa-test",
        database_id: "00000000-0000-0000-0000-000000000000",
      },
    ],
    vars: {
      CAFE_NAME: "MFA Test Café",
      CAFE_SLUG: SLUG,
      SERVICE_MODE: "counter",
      CAFE_TZ_OFFSET_MIN: "330",
      ADMIN_SECRET: env.ADMIN_SECRET,
      OWNER_PASSWORD: env.OWNER_PASSWORD,
      ...mfa,
    },
  };
  fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);

  // The config directory is .mfa-test/, so this is the .dev.vars Wrangler loads. Keeping it in sync
  // means the project's own .dev.vars (which holds dev secrets and Razorpay keys) is never read.
  const lines = [
    "# Generated by scripts/mfa-test-env.mjs — disposable MFA test environment only.",
    `ADMIN_SECRET=${env.ADMIN_SECRET}`,
    `OWNER_PASSWORD=${env.OWNER_PASSWORD}`,
    ...(mode === "missing" ? [] : [`MFA_ENC_KEY=${mode === "malformed" ? "not-a-valid-mfa-key" : env.MFA_ENC_KEY}`]),
    "",
  ];
  fs.writeFileSync(DEV_VARS, lines.join("\n"), { mode: 0o600 });
}

function readRun() {
  try {
    return JSON.parse(fs.readFileSync(RUN_FILE, "utf8"));
  } catch {
    return null;
  }
}

function portListenerPid() {
  if (process.platform !== "win32") {
    const out = spawnSync("lsof", ["-ti", `tcp:${PORT}`, "-sTCP:LISTEN"], { encoding: "utf8" });
    const pid = Number((out.stdout || "").trim().split(/\s+/)[0]);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  }
  const out = spawnSync("netstat", ["-ano"], { encoding: "utf8" });
  const line = (out.stdout || "")
    .split(/\r?\n/)
    .find((row) => new RegExp(`127\\.0\\.0\\.1:${PORT}\\s+.*LISTENING`).test(row));
  if (!line) return null;
  const pid = Number(line.trim().split(/\s+/).pop());
  return Number.isFinite(pid) && pid > 0 ? pid : null;
}

function stopServer() {
  const run = readRun();
  const pids = new Set();
  if (run && run.pid) pids.add(Number(run.pid));
  const listener = portListenerPid();
  if (listener) pids.add(listener);

  for (const pid of pids) {
    if (!Number.isFinite(pid) || pid <= 0) continue;
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
      // The listener may be a workerd child whose parent tree was already taken down.
      spawnSync("taskkill", ["/F", "/PID", String(pid)], { stdio: "ignore" });
    } else {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // already gone
      }
    }
  }
  try {
    fs.rmSync(RUN_FILE, { force: true });
  } catch {
    // ignore
  }
  return pids.size > 0;
}

async function health() {
  try {
    const res = await fetch(`http://127.0.0.1:${PORT}/api/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function waitForHealth(timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const body = await health();
    if (body && body.status === "ok") return body;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return null;
}

async function isolationCheck(env, mode) {
  const configRes = await fetch(`http://127.0.0.1:${PORT}/api/cafes/${SLUG}/config`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!configRes.ok) return `config endpoint answered ${configRes.status}`;
  const config = await configRes.json();
  if (config.slug !== SLUG) return `unexpected café slug ${String(config.slug).slice(0, 40)}`;
  if (config.payments && config.payments.provider !== "none") {
    return "payments are configured in the test environment — the project's .dev.vars probably leaked";
  }
  if (mode === "valid") {
    const login = await fetch(`http://127.0.0.1:${PORT}/api/cafes/${SLUG}/admin/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: env.OWNER_PASSWORD }),
      signal: AbortSignal.timeout(15_000),
    });
    // 200 with mfaRequired is also fine on a reused database; the point is that it is not 401.
    if (login.status !== 200) return `test owner password was not accepted (status ${login.status})`;
  }
  return null;
}

function start(mode) {
  if (!MODES.includes(mode)) fail(`mode must be one of ${MODES.join(", ")}`);
  assertSafePaths();
  const env = ensureEnv();

  if (!fs.existsSync(path.join(root, "dist", "index.html"))) {
    fail("dist/ is missing — run `npm run build` first");
  }

  stopServer();
  writeConfig(env, mode);

  const logFd = fs.openSync(LOG_FILE, "w");
  const args = [
    "wrangler",
    "dev",
    "--config",
    CONFIG,
    "--cwd",
    DIR,
    "--port",
    String(PORT),
    "--ip",
    "127.0.0.1",
    "--persist-to",
    STATE,
  ];
  const child = spawn("npx", args, {
    cwd: root,
    detached: true,
    windowsHide: true,
    shell: process.platform === "win32",
    stdio: ["ignore", logFd, logFd],
  });
  child.unref();
  fs.writeFileSync(RUN_FILE, JSON.stringify({ pid: child.pid, mode, startedAt: new Date().toISOString() }, null, 2));

  return waitForHealth().then(async (body) => {
    if (!body) {
      stopServer();
      fail(`the test Worker did not become healthy; see ${path.relative(root, LOG_FILE)}`);
    }
    const problem = await isolationCheck(env, mode);
    if (problem) {
      stopServer();
      fail(`isolation check failed: ${problem}. See ${path.relative(root, LOG_FILE)}`);
    }
    console.log(`MFA test environment running (mode: ${mode})`);
    console.log(`  URL:     http://127.0.0.1:${PORT}/c/${SLUG}/owner`);
    console.log(`  Menu:    http://127.0.0.1:${PORT}/c/${SLUG}/menu`);
    console.log(`  Health:  ${JSON.stringify(body)}`);
    console.log(`  Database: ${path.relative(root, STATE)} (separate from .local-pilot/state)`);
    console.log(`  Credentials: ${path.relative(root, ENV_FILE)}  (read locally; never paste into a report)`);
    console.log(`  Stop: node scripts/mfa-test-env.mjs stop`);
  });
}

async function status() {
  const run = readRun();
  const body = await health();
  const listener = portListenerPid();
  console.log(
    JSON.stringify(
      {
        port: PORT,
        running: Boolean(listener),
        mode: run ? run.mode : null,
        health: body,
        url: `http://127.0.0.1:${PORT}/c/${SLUG}/owner`,
        database: path.relative(root, STATE),
      },
      null,
      2
    )
  );
}

function reset() {
  assertSafePaths();
  stopServer();
  fs.rmSync(STATE, { recursive: true, force: true });
  console.log(`Deleted the disposable database at ${path.relative(root, STATE)}. Credentials and test key kept.`);
}

const [command, ...rest] = process.argv.slice(2);
if (command === "start") {
  const modeIndex = rest.indexOf("--mode");
  const mode = modeIndex === -1 ? "valid" : rest[modeIndex + 1];
  await start(mode);
} else if (command === "stop") {
  const stopped = stopServer();
  console.log(stopped ? `Stopped the test environment on ${PORT}.` : `Nothing was running on ${PORT}.`);
} else if (command === "status") {
  await status();
} else if (command === "reset") {
  reset();
} else {
  console.log("usage: node scripts/mfa-test-env.mjs start [--mode valid|missing|malformed] | stop | status | reset");
  process.exit(command ? 1 : 0);
}
