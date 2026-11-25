// Test-environment-only module hooks for the Argon2id wasm binaries (F-07 follow-up).
//
// `worker/passwords.js` does `import simdWasm from "argon2id/dist/simd.wasm"` and hands the default
// export to `WebAssembly.instantiate`. That works on Cloudflare because the harness config declares
// `rules: [{ type: "CompiledWasm", globs: ["**/*.wasm"] }]`, which makes the default export a
// pre-compiled `WebAssembly.Module`.
//
// Node's own WASM-ESM integration behaves differently in two ways that break that import, and both are
// Node limitations rather than problems with the library or the Worker:
//   1. It resolves the wasm module's own imports itself, so `import { memory } from "env"` inside the
//      binary is treated as a package request and fails with
//      `ERR_MODULE_NOT_FOUND: Cannot find package 'env'`.
//   2. It exposes only the module's named exports, never a `default`, so a default import fails even
//      once resolution succeeds.
//
// These hooks replace the wasm module with a JavaScript module that compiles the same bytes and exports
// the resulting `WebAssembly.Module` as `default`. Both effects disappear, and the Worker's loading model
// is unchanged: the app still hands a `WebAssembly.Module` to `WebAssembly.instantiate`, exactly as it
// does in workerd. Nothing here is loaded by `worker/index.js`, `wrangler dev`, or the production build.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ARGON2_WASM = /\/node_modules\/argon2id\/dist\/(?:no-)?simd\.wasm$/;

export function load(url, context, nextLoad) {
  if (ARGON2_WASM.test(new URL(url).pathname)) {
    const base64 = readFileSync(fileURLToPath(url)).toString("base64");
    return {
      format: "module",
      shortCircuit: true,
      source:
        `const bytes = Uint8Array.from(atob(${JSON.stringify(base64)}), (c) => c.charCodeAt(0));\n` +
        `export default new WebAssembly.Module(bytes);\n`,
    };
  }
  return nextLoad(url, context);
}
