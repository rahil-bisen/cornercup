// `wrangler deploy` turns every top-level `secrets.required` name into an "inherit" binding, and
// Cloudflare rejects the whole upload when one of them is not set on the live Worker. A deploy of
// 0b2aff2 failed exactly that way (2026-11-28) because optional secrets were listed. Meanwhile
// `wrangler dev` loads ONLY the listed keys, so the self-host environment must list every key the
// Worker reads. These tests hold both halves in place.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// wrangler.jsonc has only whole-line // comments and no trailing commas.
const config = JSON.parse(
  readFileSync(path.join(root, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n")
);
const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));

// The secrets the live Worker has. Adding one here is a promise that it is set on Cloudflare.
const DEPLOY_REQUIRED = ["ADMIN_SECRET", "OPERATOR_PASSWORD"];
const BINDINGS = new Set(["DB", "IMAGES", "ASSETS"]);

function keysTheWorkerReads() {
  const keys = new Set();
  for (const file of readdirSync(path.join(root, "worker"))) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(path.join(root, "worker", file), "utf8");
    for (const match of source.matchAll(/\benv\.([A-Z][A-Z0-9_]+)/g)) keys.add(match[1]);
  }
  return [...keys].filter((key) => !BINDINGS.has(key)).sort();
}

test("a deploy demands only the secrets the live Worker has", () => {
  assert.deepEqual([...config.secrets.required].sort(), [...DEPLOY_REQUIRED].sort());
});

test("the self-host environment lists every key the Worker reads", () => {
  const listed = new Set(config.env.selfhost.secrets.required);
  const missing = keysTheWorkerReads().filter((key) => !listed.has(key));
  assert.deepEqual(missing, [], "wrangler dev would silently drop these keys");
  for (const key of DEPLOY_REQUIRED) assert.ok(listed.has(key));
});

test("the self-host environment repeats the top-level bindings exactly", () => {
  assert.deepEqual(config.env.selfhost.d1_databases, config.d1_databases);
  assert.deepEqual(config.env.selfhost.r2_buckets, config.r2_buckets);
});

test("dev and start use the self-host environment; deploy targets the top level", () => {
  assert.match(pkg.scripts.dev, /wrangler dev --env selfhost\b/);
  assert.match(pkg.scripts.start, /wrangler dev --env selfhost\b/);
  assert.match(pkg.scripts.deploy, /wrangler deploy --env=(\s|$)/);
  assert.doesNotMatch(pkg.scripts.deploy, /selfhost/);
});
