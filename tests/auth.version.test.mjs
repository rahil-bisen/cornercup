// Unit tests for the owner-session version parser.
//
// Two messages must never be confused:
//   * the column is absent      → the deployment has not run the reset migration; version 1, which is
//                                 exactly what a legacy two-part token carries;
//   * the column is present but not a valid version → fail closed (null), because coercing it to 1
//                                 would let an old version-1 token authenticate against corrupt state.

import test from "node:test";
import assert from "node:assert/strict";
import { authVersionFrom } from "../worker/api.js";

test("an absent version property is the legacy default, version 1", () => {
  assert.equal(authVersionFrom(undefined), 1);
});

test("valid versions pass through, whatever their shape", () => {
  assert.equal(authVersionFrom(1), 1);
  assert.equal(authVersionFrom(2), 2);
  assert.equal(authVersionFrom(9999), 9999);
  assert.equal(authVersionFrom(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
  assert.equal(authVersionFrom("3"), 3, "a canonical digit string is accepted");
  assert.equal(authVersionFrom("10"), 10);
});

test("present-but-invalid versions are rejected instead of becoming version 1", () => {
  const invalid = [
    null,
    0,
    -1,
    -7,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    "0",
    "00",
    "01",
    "",
    " 3",
    "3 ",
    "+3",
    "-3",
    "3.0",
    "abc",
    true,
    false,
    {},
    [],
    [3],
  ];

  for (const value of invalid) {
    assert.equal(
      authVersionFrom(value),
      null,
      `${JSON.stringify(value)} must be invalid rather than fall back to 1`
    );
  }
});
