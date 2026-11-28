// What the guest menu shows after its filters, as a pure function so it is tested without a DOM.
// Categories keep their order; a category left with no items disappears, so the category rail and the
// sections never point at an empty heading.

// The "Veg only" switch is offered only when it would change something: the menu states diets for at
// least one item, and at least one item is not veg.
export function vegFilterUseful(categories) {
  const items = (categories || []).flatMap((category) => category.items || []);
  return items.some((item) => item.diet) && items.some((item) => item.diet && item.diet !== "veg");
}

// Search is offered once a menu is long enough that scrolling stops being the quick way to find a dish.
export const SEARCH_MIN_ITEMS = 16;

export function searchUseful(categories) {
  return (categories || []).reduce((count, category) => count + (category.items || []).length, 0) >= SEARCH_MIN_ITEMS;
}

// Case, accents and extra spaces never stop a match: "cafe latte" finds "Café Latte".
function fold(value) {
  return String(value == null ? "" : value)
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

// Every word the guest typed has to appear in the item's name, description or category, in any order.
function matches(item, category, words) {
  if (words.length === 0) return true;
  const haystack = fold(`${item.name} ${item.description || ""} ${category.name}`);
  return words.every((word) => haystack.includes(word));
}

export function filterMenu(categories, { vegOnly = false, query = "" } = {}) {
  const words = fold(query).split(" ").filter(Boolean);
  return (categories || [])
    .map((category) => ({
      ...category,
      items: (category.items || []).filter(
        // An item with no stated diet is not promised to be veg, so "Veg only" leaves it out.
        (item) => (!vegOnly || item.diet === "veg") && matches(item, category, words)
      ),
    }))
    .filter((category) => category.items.length > 0);
}
