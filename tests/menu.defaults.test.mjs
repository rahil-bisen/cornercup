// Stage 3F: item-specific default photographs.
//
// The table below is deliberately written out again instead of being read back from the module: this
// test is the approved Stage 3E mapping, so a change to the map has to be a considered change here too.
// The seeded menu is imported from the Worker so a renamed or added seed item fails loudly rather than
// quietly losing its picture.

import test from "node:test";
import assert from "node:assert/strict";
import { SEED_MENU } from "../worker/db.js";
import {
  CATEGORY_DEFAULTS,
  ITEM_DEFAULTS,
  defaultImageFor,
  normalise,
  resolveItemImage,
} from "../src/lib/menuImages.js";

const COFFEE = "/defaults/coffee.jpg";
const COLD = "/defaults/cold-drink.jpg";
const SNACK = "/defaults/snack.jpg";
const MAIN = "/defaults/main.jpg";
const DESSERT = "/defaults/dessert.jpg";

// The approved mapping, by seeded item name. `null` = the item is deliberately left to its emoji.
const EXPECTED = {
  "Masala Chai": COFFEE,
  "Filter Coffee": COFFEE,
  Espresso: COFFEE,
  Cappuccino: COFFEE,
  "Café Latte": COFFEE,
  "Hot Chocolate": COFFEE,

  "Cold Coffee": COLD,
  "Iced Americano": COLD,
  "Fresh Lime Soda": null,
  "Blue Lagoon Mocktail": null,
  Buttermilk: null,
  "Mineral Water": null,

  "Veg Grilled Sandwich": SNACK,
  "Paneer Tikka Sandwich": SNACK,
  "Peri Peri Fries": null,
  "Veg Momos (6)": null,
  "Chicken Momos (6)": null,
  "Cheese Garlic Bread": SNACK,

  "Veg Biryani": MAIN,
  "Chicken Biryani": MAIN,
  "Paneer Butter Masala": MAIN,
  "White Sauce Pasta": null,
  "Arrabbiata Pasta": null,
  "Masala Maggi": null,

  "Chocolate Brownie": DESSERT,
  "Choco Lava Cake": DESSERT,
  "Brownie with Ice Cream": DESSERT,
};

const EMOJI_ONLY = Object.entries(EXPECTED)
  .filter(([, image]) => image === null)
  .map(([name]) => name);

const byName = (name) => SEED_MENU.find(([, itemName]) => itemName === name);

test("all 27 seeded items resolve to their approved photograph or emoji", () => {
  assert.equal(SEED_MENU.length, 27, "the seeded menu is 27 items");
  assert.equal(Object.keys(EXPECTED).length, 27, "the approved mapping covers every seeded item");

  for (const [category, name, , , emoji] of SEED_MENU) {
    assert.ok(Object.prototype.hasOwnProperty.call(EXPECTED, name), `${name} has an approved mapping`);
    const resolved = resolveItemImage({ name, imageUrl: null, emoji }, category);
    assert.equal(resolved, EXPECTED[name], `${category} · ${name}`);
  }
});

test("every seeded item carries exactly one item-specific entry", () => {
  // Otherwise a category-level image could hide a missing decision for one item.
  assert.equal(Object.keys(ITEM_DEFAULTS).length, 27, "one entry per seeded item, no orphans");
  for (const [category, name] of SEED_MENU) {
    const matches = Object.keys(ITEM_DEFAULTS).filter((key) => {
      const [itemCategory, itemName] = key.split("|");
      return normalise(itemCategory) === normalise(category) && normalise(itemName) === normalise(name);
    });
    assert.equal(matches.length, 1, `${name} must have exactly one item default`);
  }
});

test("the ten emoji sentinels stop at the emoji instead of borrowing the category photograph", () => {
  assert.equal(EMOJI_ONLY.length, 10, "ten items have no truthful photograph");

  for (const name of EMOJI_ONLY) {
    const [, , , , emoji] = byName(name);
    const category = byName(name)[0];
    // The category does have a photograph — the point is that these items do not use it.
    assert.ok(defaultImageFor(category), `${category} has a category photograph`);
    assert.equal(
      resolveItemImage({ name, imageUrl: null }, category),
      null,
      `${name} must fall straight to its emoji (${emoji})`
    );
  }
});

test("a category photograph is used only when no item-specific entry exists", () => {
  // A new item the café adds in a known category: nothing item-specific, so the category photograph.
  assert.equal(resolveItemImage({ name: "Seasonal Cold Brew" }, "Cold Drinks"), COLD);
  assert.equal(resolveItemImage({ name: "Some New Snack" }, "Snacks"), SNACK);

  // An unknown category has no photograph at all — no universal placeholder stands in.
  assert.equal(resolveItemImage({ name: "Anything" }, "Seasonal Specials"), null);
  assert.equal(defaultImageFor("Seasonal Specials"), null);
});

test("an unknown or renamed item never falls back to the misleading dish photograph", () => {
  const allMapped = [...Object.values(ITEM_DEFAULTS), ...Object.values(CATEGORY_DEFAULTS)];
  assert.equal(allMapped.includes("/defaults/dish.jpg"), false, "dish.jpg is no longer referenced");
  assert.equal(
    Object.values(ITEM_DEFAULTS).some((image) => image && image.endsWith("dish.jpg")),
    false
  );

  for (const [, name] of SEED_MENU) {
    const category = byName(name)[0];
    assert.notEqual(resolveItemImage({ name }, category), "/defaults/dish.jpg", `${name}`);
  }
  assert.notEqual(resolveItemImage({ name: "Unlisted" }, "Unlisted Section"), "/defaults/dish.jpg");
});

test("matching ignores case, spacing, punctuation and accents without losing the item", () => {
  assert.equal(resolveItemImage({ name: "  MASALA   CHAI " }, "chai & coffee"), COFFEE);
  assert.equal(resolveItemImage({ name: "Cafe Latte" }, "Chai & Coffee"), COFFEE, "unaccented rename");
  assert.equal(resolveItemImage({ name: "VEG MOMOS (6)" }, "Snacks"), null, "sentinel survives renaming");
});

test("an owner upload outranks the item default, and a broken upload falls back to it", () => {
  const uploaded = "/api/cafes/c/menu/4/image?v=2026-01-01T00:00:00.000Z";

  // Upload wins for a mapped item…
  assert.equal(resolveItemImage({ name: "Masala Chai", imageUrl: uploaded }, "Chai & Coffee"), uploaded);
  // …and for an emoji item: the owner's own photo still shows.
  assert.equal(resolveItemImage({ name: "Masala Maggi", imageUrl: uploaded }, "Mains"), uploaded);

  // A broken upload advances to the item default, not to the emoji.
  assert.equal(
    resolveItemImage({ name: "Masala Chai", imageUrl: uploaded }, "Chai & Coffee", new Set([uploaded])),
    COFFEE
  );
  // A broken upload on an emoji item has nowhere truthful to go.
  assert.equal(
    resolveItemImage({ name: "Masala Maggi", imageUrl: uploaded }, "Mains", new Set([uploaded])),
    null
  );
});

test("a broken default falls through the ladder and finally to the emoji", () => {
  // Item default broken → no second photograph is borrowed for a mapped item whose category shares it.
  assert.equal(
    resolveItemImage({ name: "Masala Chai" }, "Chai & Coffee", new Set([COFFEE])),
    null
  );
  // Category-level item broken → emoji rather than a misleading substitute.
  assert.equal(resolveItemImage({ name: "Seasonal Cold Brew" }, "Cold Drinks", new Set([COLD])), null);
  // An empty broken set still resolves normally.
  assert.equal(resolveItemImage({ name: "Veg Biryani" }, "Mains", new Set()), MAIN);
});
