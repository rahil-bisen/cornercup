// What a guest sees for an item's picture. Only the café's own uploaded photograph is shown; every
// other item gets the same placeholder tile with its initial. The bundled stock photographs this file
// used to map out (one picture per category, shared by several different dishes) were removed because a
// photo of a different dish reads as a mistake: a filter coffee showed chai, two sandwiches looked the same.

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SEED_MENU } from "../worker/db.js";
import { DEMO_MENU } from "../scripts/demo-cafe.mjs";
import { placeholderInitial, resolveItemImage } from "../src/lib/menuImages.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("an item without an upload shows the placeholder, never a stock photograph", () => {
  for (const [category, name] of [...SEED_MENU, ...DEMO_MENU]) {
    assert.equal(resolveItemImage({ name, imageUrl: null }, category), null, `${category} / ${name}`);
  }
  assert.equal(resolveItemImage({}, "Seasonal Specials"), null);
  assert.equal(existsSync(path.join(root, "public", "defaults")), false, "no stock photographs are shipped");
});

test("an uploaded photograph is shown, and only for its own item", () => {
  const latte = "/api/cafes/c/menu/1/image?v=1";
  const mocha = "/api/cafes/c/menu/2/image?v=4";
  assert.equal(resolveItemImage({ name: "Latte", imageUrl: latte }, "Coffee"), latte);
  assert.equal(resolveItemImage({ name: "Mocha", imageUrl: mocha }, "Coffee"), mocha);
  assert.equal(resolveItemImage({ name: "Espresso", imageUrl: null }, "Coffee"), null, "a neighbour's photo is never borrowed");
});

test("two different items can never resolve to the same picture", () => {
  const items = [...SEED_MENU, ...DEMO_MENU].map(([category, name], index) => ({
    category,
    name,
    imageUrl: index % 3 === 0 ? `/api/cafes/c/menu/${index}/image?v=1` : null,
  }));
  const shown = items.map((item) => resolveItemImage(item, item.category)).filter(Boolean);
  assert.equal(new Set(shown).size, shown.length);
});

test("a broken upload falls back to the placeholder instead of a broken image", () => {
  const custom = "/api/cafes/c/menu/1/image?v=1";
  assert.equal(resolveItemImage({ imageUrl: custom }, "Mains", new Set([custom])), null);
});

test("the placeholder shows the item's first letter or digit", () => {
  assert.equal(placeholderInitial({ name: "Masala Chai" }), "M");
  assert.equal(placeholderInitial({ name: "  éclair" }), "É");
  assert.equal(placeholderInitial({ name: "(6) Veg Momos" }), "6");
  assert.equal(placeholderInitial({ name: "" }), "·");
  assert.equal(placeholderInitial(null), "·");
});
