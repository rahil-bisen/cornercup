// Every customer page names the café in the browser tab. The title is built by one pure function so
// the wording is checked here without a DOM; each page passes its own screen name.
import test from "node:test";
import assert from "node:assert/strict";
import { cafeTitle } from "../src/lib/config.js";

const config = { cafe: { name: "Chai Kona Café" } };

test("the landing page shows the café name alone", () => {
  assert.equal(cafeTitle(config, ""), "Chai Kona Café");
});

test("other pages put the screen first, then the café", () => {
  assert.equal(cafeTitle(config, "Menu"), "Menu · Chai Kona Café");
  assert.equal(cafeTitle(config, "Order #R8Q64L"), "Order #R8Q64L · Chai Kona Café");
});

test("nothing is set until the café is known, and a missing café says so", () => {
  assert.equal(cafeTitle(null, "Menu"), null);
  assert.equal(cafeTitle({ cafe: {} }, "Menu"), null);
  assert.equal(cafeTitle(null, "Menu", true), "Café not found");
});
