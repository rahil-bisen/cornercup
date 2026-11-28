// How an order is labelled on screen and found by the board's search.
import test from "node:test";
import assert from "node:assert/strict";
import { hasDailyNumber, orderLabel, orderMatchesTerm } from "../src/lib/orderNumber.js";

const fresh = { id: "MPK7AL", queueNo: 23 };
const old = { id: "WRCUTG", queueNo: null };

test("a numbered order is #23; an older one keeps its code", () => {
  assert.equal(orderLabel(fresh), "#23");
  assert.equal(orderLabel(old), "#WRCUTG");
  assert.equal(hasDailyNumber(old), false);
  assert.equal(orderLabel(null), "");
});

test("search finds the exact daily number, with or without #, and still finds the code", () => {
  assert.equal(orderMatchesTerm(fresh, "23"), true);
  assert.equal(orderMatchesTerm(fresh, "#23"), true);
  assert.equal(orderMatchesTerm(fresh, "2"), false, "2 is not order 23");
  assert.equal(orderMatchesTerm({ id: "X", queueNo: 123 }, "23"), false, "23 is not order 123");
  assert.equal(orderMatchesTerm(fresh, "mpk7"), true, "part of the code still works");
  assert.equal(orderMatchesTerm(old, "#wrcutg"), true);
  assert.equal(orderMatchesTerm(old, "23"), false);
  assert.equal(orderMatchesTerm(fresh, "  "), true, "an empty search matches everything");
});
