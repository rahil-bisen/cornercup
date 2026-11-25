// Registers the Argon2id wasm hooks for `node --test`. Test scripts pass this with
// `--import ./tests/setup/register.mjs`; it is not referenced by any runtime or build path.
import { registerHooks } from "node:module";

import * as argon2idWasm from "./argon2id-wasm-hooks.mjs";

registerHooks({
  load: argon2idWasm.load,
});
