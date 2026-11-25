// Stage 3F: the guest menu's photograph ladder — the owner's upload, then an item-specific default,
// then the category default, then the item's emoji. The ladder lives here rather than inside the page
// so the behaviour can be tested without a DOM.
//
// The item table was chosen in STAGE3E_DEFAULT_IMAGE_DIVERSITY_AUDIT.md: with six bundled photographs
// and 27 seeded items, a picture is only used where it truthfully shows the dish. Ten items therefore
// carry an explicit `null` — "use the emoji" — instead of borrowing a photograph of something else.
// There is deliberately no universal fallback image: a wrong picture reads as a data error to a guest.

const CATEGORY_DEFAULTS = {
  "Chai & Coffee": "/defaults/coffee.jpg",
  "Cold Drinks": "/defaults/cold-drink.jpg",
  Snacks: "/defaults/snack.jpg",
  Mains: "/defaults/main.jpg",
  Desserts: "/defaults/dessert.jpg",
};

// `null` means "this item has no truthful photograph, show the emoji". A missing key means "no
// item-specific default", which falls through to the category photograph. The two cases must stay
// distinguishable, or every future item would silently lose its image.
const ITEM_DEFAULTS = {
  "Chai & Coffee|Masala Chai": "/defaults/coffee.jpg",
  "Chai & Coffee|Filter Coffee": "/defaults/coffee.jpg",
  "Chai & Coffee|Espresso": "/defaults/coffee.jpg",
  "Chai & Coffee|Cappuccino": "/defaults/coffee.jpg",
  "Chai & Coffee|Café Latte": "/defaults/coffee.jpg",
  "Chai & Coffee|Hot Chocolate": "/defaults/coffee.jpg",

  "Cold Drinks|Cold Coffee": "/defaults/cold-drink.jpg",
  "Cold Drinks|Iced Americano": "/defaults/cold-drink.jpg",
  "Cold Drinks|Fresh Lime Soda": null,
  "Cold Drinks|Blue Lagoon Mocktail": null,
  "Cold Drinks|Buttermilk": null,
  "Cold Drinks|Mineral Water": null,

  "Snacks|Veg Grilled Sandwich": "/defaults/snack.jpg",
  "Snacks|Paneer Tikka Sandwich": "/defaults/snack.jpg",
  "Snacks|Peri Peri Fries": null,
  "Snacks|Veg Momos (6)": null,
  "Snacks|Chicken Momos (6)": null,
  "Snacks|Cheese Garlic Bread": "/defaults/snack.jpg",

  "Mains|Veg Biryani": "/defaults/main.jpg",
  "Mains|Chicken Biryani": "/defaults/main.jpg",
  "Mains|Paneer Butter Masala": "/defaults/main.jpg",
  "Mains|White Sauce Pasta": null,
  "Mains|Arrabbiata Pasta": null,
  "Mains|Masala Maggi": null,

  "Desserts|Chocolate Brownie": "/defaults/dessert.jpg",
  "Desserts|Choco Lava Cake": "/defaults/dessert.jpg",
  "Desserts|Brownie with Ice Cream": "/defaults/dessert.jpg",
};

// Case, spacing, punctuation and accents are the café's to change when they rename an item; none of
// that should drop the item back to the category photograph.
function normalise(value) {
  return String(value == null ? "" : value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// The tables above stay readable; lookups run against these normalised copies, built once.
const CATEGORY_BY_KEY = new Map(
  Object.entries(CATEGORY_DEFAULTS).map(([category, image]) => [normalise(category), image])
);
const ITEM_BY_KEY = new Map(
  Object.entries(ITEM_DEFAULTS).map(([key, image]) => {
    const separator = key.indexOf("|");
    const category = key.slice(0, separator);
    const name = key.slice(separator + 1);
    return [itemKey(category, name), image];
  })
);

function itemKey(category, name) {
  return `${normalise(category)}|${normalise(name)}`;
}

// The category photograph, when this category has one. An unknown category has none — never a
// generic "dish" picture standing in for something it does not show.
export function defaultImageFor(category) {
  return CATEGORY_BY_KEY.get(normalise(category)) || null;
}

// Every photograph worth trying for this item, best first. Empty means "no photograph: emoji".
function preferredImages(item, category) {
  const key = itemKey(category, item && item.name);
  if (ITEM_BY_KEY.has(key)) {
    const mapped = ITEM_BY_KEY.get(key);
    // An explicit null stops here: the category photograph belongs to a different dish.
    if (!mapped) return [];
    const categoryImage = defaultImageFor(category);
    return categoryImage && categoryImage !== mapped ? [mapped, categoryImage] : [mapped];
  }
  const categoryImage = defaultImageFor(category);
  return categoryImage ? [categoryImage] : [];
}

// The src to render, or null when nothing is left to try and the caller should draw the emoji.
// `broken` holds the sources that already failed to load in this session, so the ladder advances
// instead of retrying a URL the browser has already rejected.
export function resolveItemImage(item, category, broken = new Set()) {
  const custom = (item && item.imageUrl) || null;
  if (custom && !broken.has(custom)) return custom;
  for (const candidate of preferredImages(item, category)) {
    if (!broken.has(candidate)) return candidate;
  }
  return null;
}

export { ITEM_DEFAULTS, CATEGORY_DEFAULTS, normalise };
