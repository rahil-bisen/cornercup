// F-14: every order id candidate is checked against D1 before it is returned — the 8-character
// fallback included — and exhaustion after the bounded attempts is a typed error the handler turns
// into a 503.
//
// The generator is injected, so these tests pin the exact sequence of candidates instead of hoping a
// random collision happens. `freshOrderIdWith` is the same function production calls through
// `freshOrderId`.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

import {
  CODE_ALPHABET,
  OrderIdUnavailableError,
  freshOrderIdWith,
  randomCode,
} from "../worker/orderids.js";

// A fake D1 that reports the first `takenProbes` probes as taken and every later probe as free.
function fakeDb(takenProbes) {
  const probes = [];
  return {
    probes,
    env: {
      DB: {
        prepare(sql) {
          assert.equal(sql, "SELECT 1 AS found FROM orders WHERE id = ?", "only the id probe is issued");
          return {
            bind(id) {
              probes.push(id);
              return { first: async () => (probes.length <= takenProbes ? { found: 1 } : null) };
            },
          };
        },
      },
    },
  };
}

// A fake D1 backed by an explicit set of taken ids, so a specific candidate can be reserved.
function setDb(taken) {
  const probes = [];
  return {
    probes,
    env: {
      DB: {
        prepare() {
          return {
            bind(id) {
              probes.push(id);
              return { first: async () => (taken.has(id) ? { found: 1 } : null) };
            },
          };
        },
      },
    },
  };
}

function sequence(ids) {
  let index = 0;
  return () => {
    if (index >= ids.length) throw new Error("generator exhausted: the code probed more ids than expected");
    return ids[index++];
  };
}

test("F14-1: a free first candidate is returned after a single probe", async () => {
  const { probes, env } = fakeDb(0);
  const id = await freshOrderIdWith(env, sequence(["ABC234"]));

  assert.equal(id, "ABC234");
  assert.equal(id.length, 6, "the readable short code is preferred");
  assert.equal(probes.length, 1, "exactly one database check");
});

test("F14-2: the 8-character fallback is checked against the database before it is returned", async () => {
  const { probes, env } = fakeDb(6);
  const shortCodes = ["AAAA22", "BBBB33", "CCCC44", "DDDD55", "EEEE66", "FFFF77"];
  const id = await freshOrderIdWith(env, sequence([...shortCodes, "GGGG8888"]));

  assert.equal(id, "GGGG8888");
  assert.equal(id.length, 8, "six collisions fall through to the long fallback");
  assert.equal(probes.length, 7, "the fallback candidate itself was checked — the F-14 defect");
  assert.equal(probes[6], "GGGG8888", "the id that was returned is the id that was queried");
});

test("F14-3: a taken 8-character candidate is retried, not returned", async () => {
  const { probes, env } = fakeDb(7);
  const ids = ["AAAA22", "BBBB33", "CCCC44", "DDDD55", "EEEE66", "FFFF77", "GGGG8888", "HHHH9999"];
  const id = await freshOrderIdWith(env, sequence(ids));

  assert.equal(id, "HHHH9999", "the second long candidate is used");
  assert.equal(probes.length, 8);
  assert.deepEqual(probes.slice(6), ["GGGG8888", "HHHH9999"], "both long candidates were checked");
});

test("F14-4: exhaustion after the bounded attempts throws a typed error and returns no id", async () => {
  const { probes, env } = fakeDb(9);
  const ids = ["AAAA22", "BBBB33", "CCCC44", "DDDD55", "EEEE66", "FFFF77", "GGGG8888", "HHHH9999", "JJJJ0000"];

  await assert.rejects(
    () => freshOrderIdWith(env, sequence(ids)),
    (err) => {
      assert.ok(err instanceof OrderIdUnavailableError, `expected OrderIdUnavailableError, got ${err && err.name}`);
      assert.equal(err.name, "OrderIdUnavailableError");
      return true;
    }
  );
  assert.equal(probes.length, 9, "six short probes and three long probes, then it stops");
});

test("F14-5: an id already owned by another order is skipped even when it is generated first", async () => {
  const taken = new Set(["OLD111"]);
  const { probes, env } = setDb(taken);
  const id = await freshOrderIdWith(env, sequence(["OLD111", "NEW222"]));

  assert.equal(id, "NEW222");
  assert.deepEqual(probes, ["OLD111", "NEW222"], "the taken id was probed, rejected and replaced");
});

test("F14-6: generated codes use only the safe alphabet and the requested length", async () => {
  for (const length of [6, 8]) {
    for (let i = 0; i < 50; i += 1) {
      const code = randomCode(length);
      assert.equal(code.length, length);
      for (const char of code) {
        assert.ok(CODE_ALPHABET.includes(char), `${char} is outside the alphabet`);
      }
    }
  }
  assert.equal(CODE_ALPHABET.length, 32, "32 characters keeps `byte % 32` unbiased");
});
