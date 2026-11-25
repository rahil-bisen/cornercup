// Measures the *CPU* cost of the Argon2id derivation this Worker actually uses.
//
// This is a local, derivation-only measurement. It is NOT a Cloudflare platform `cpuTime` reading and
// NOT evidence of the plan's per-request CPU ceiling. It exists to separate two numbers the launch
// review previously conflated: how much CPU the KDF itself needs, and how much the per-isolate
// database initialisation needs. The derivation here is byte-for-byte the same wasm module, the same
// parameters and the same call shape as worker/passwords.js `derive()`.
//
// Run: node scripts/measure-argon2-cpu.mjs [--json <path>]
// Argon2id parameters are read from worker/passwords.js and asserted; this script refuses to run if
// they differ from m=19456 KiB, t=2, p=1.

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");

const EXPECTED = { m: 19456, t: 2, p: 1 };
const SALT_BYTES = 16;
const TAG_BYTES = 32;
const SAMPLES = 10;

const source = fs.readFileSync(path.join(root, "worker/passwords.js"), "utf8");
const params = /const ARGON2 = \{ m: (\d+), t: (\d+), p: (\d+) \};/.exec(source);
if (!params) {
  console.error("FAIL: could not read ARGON2 parameters from worker/passwords.js");
  process.exit(1);
}
const actual = { m: Number(params[1]), t: Number(params[2]), p: Number(params[3]) };
if (actual.m !== EXPECTED.m || actual.t !== EXPECTED.t || actual.p !== EXPECTED.p) {
  console.error(`FAIL: worker parameters ${JSON.stringify(actual)} differ from the reviewed ${JSON.stringify(EXPECTED)}`);
  process.exit(1);
}

// Prove this measurement still describes the production implementation rather than a drifted copy:
// same two wasm imports, same salt/tag sizes, same derive parameters read above.
for (const needle of [
  'import simdWasm from "argon2id/dist/simd.wasm";',
  'import noSimdWasm from "argon2id/dist/no-simd.wasm";',
  "const SALT_BYTES = 16;",
  "const TAG_BYTES = 32;",
]) {
  if (!source.includes(needle)) {
    console.error(`FAIL: worker/passwords.js no longer contains ${JSON.stringify(needle)}`);
    process.exit(1);
  }
}

const simdPath = require.resolve("argon2id/dist/simd.wasm");
const noSimdPath = require.resolve("argon2id/dist/no-simd.wasm");
const simdBytes = fs.readFileSync(simdPath);
const noSimdBytes = fs.readFileSync(noSimdPath);

const { default: setupWasm } = await import("argon2id/lib/setup.js");

const compute = await setupWasm(
  async (imports) => ({ instance: new WebAssembly.Instance(new WebAssembly.Module(simdBytes), imports) }),
  async (imports) => ({ instance: new WebAssembly.Instance(new WebAssembly.Module(noSimdBytes), imports) })
);

async function derive(password, salt) {
  const tag = await compute({
    password: new TextEncoder().encode(password),
    salt,
    passes: actual.t,
    parallelism: actual.p,
    memorySize: actual.m,
    tagLength: TAG_BYTES,
  });
  return new Uint8Array(tag);
}

const password = "measurement-only-password-not-a-real-credential";
const salt = crypto.randomBytes(SALT_BYTES);

// Warm-up: first call pays wasm compilation/linking inside this process, not a per-request cost in a
// warm isolate. It is reported separately rather than folded into the distribution.
const warmBefore = process.cpuUsage();
const warmWall = performance.now();
await derive(password, salt);
const warmDelta = process.cpuUsage(warmBefore);
const warm = {
  cpuMs: (warmDelta.user + warmDelta.system) / 1000,
  wallMs: performance.now() - warmWall,
};

const samples = [];
for (let i = 0; i < SAMPLES; i += 1) {
  const before = process.cpuUsage();
  const wallStart = performance.now();
  const tag = await derive(password, salt);
  const wallMs = performance.now() - wallStart;
  const delta = process.cpuUsage(before);
  if (tag.length !== TAG_BYTES) throw new Error("unexpected tag length");
  samples.push({ cpuMs: (delta.user + delta.system) / 1000, userMs: delta.user / 1000, systemMs: delta.system / 1000, wallMs });
}

const sortedCpu = samples.map((s) => s.cpuMs).sort((a, b) => a - b);
const sortedWall = samples.map((s) => s.wallMs).sort((a, b) => a - b);
const p50 = (values) => values[Math.floor((values.length - 1) * 0.5)];
const mean = (values) => values.reduce((a, b) => a + b, 0) / values.length;
const round = (n) => Math.round(n * 100) / 100;

// setupWasm tries SIMD first and only falls back if instantiation throws; the runtime cannot report which
// path was taken, so this is recorded as intent rather than as a measured fact.
const simdUsed = "preferred (SIMD attempted first; fallback not observable)";
const result = {
  measuredAt: new Date().toISOString(),
  environment: {
    runtime: `node ${process.version}`,
    platform: process.platform,
    arch: process.arch,
    cpu: (await import("node:os")).cpus()?.[0]?.model ?? "unknown",
    simd: simdUsed,
  },
  parameters: { ...actual, saltBytes: SALT_BYTES, tagBytes: TAG_BYTES },
  workerSource: "worker/passwords.js",
  implementationMatch: {
    wasmImports: ["argon2id/dist/simd.wasm", "argon2id/dist/no-simd.wasm"],
    saltBytes: SALT_BYTES,
    tagBytes: TAG_BYTES,
    parametersAssertedFromSource: true,
  },
  wasm: {
    simdSha256: crypto.createHash("sha256").update(simdBytes).digest("hex"),
    noSimdSha256: crypto.createHash("sha256").update(noSimdBytes).digest("hex"),
  },
  warmUp: { cpuMs: round(warm.cpuMs), wallMs: round(warm.wallMs) },
  samples: samples.map((s) => ({ cpuMs: round(s.cpuMs), userMs: round(s.userMs), systemMs: round(s.systemMs), wallMs: round(s.wallMs) })),
  summary: {
    cpuMs: { min: round(sortedCpu[0]), p50: round(p50(sortedCpu)), mean: round(mean(sortedCpu)), max: round(sortedCpu[sortedCpu.length - 1]) },
    wallMs: { min: round(sortedWall[0]), p50: round(p50(sortedWall)), max: round(sortedWall[sortedWall.length - 1]) },
    samples: SAMPLES,
  },
  scope:
    "Local process CPU (user+system) for one Argon2id derivation using the Worker's wasm module and parameters. " +
    "Excludes HTTP handling and database initialisation. Not a Cloudflare platform cpuTime reading and not a plan ceiling.",
};

console.log(JSON.stringify(result, null, 2));

const jsonFlag = process.argv.indexOf("--json");
if (jsonFlag !== -1) {
  const out = process.argv[jsonFlag + 1];
  if (!out) {
    console.error("FAIL: --json needs a path");
    process.exit(1);
  }
  fs.mkdirSync(path.dirname(path.resolve(root, out)), { recursive: true });
  fs.writeFileSync(path.resolve(root, out), JSON.stringify(result, null, 2) + "\n");
  console.error(`wrote ${out}`);
}
