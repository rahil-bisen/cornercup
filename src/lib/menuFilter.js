// What the guest menu shows after its filters, as a pure function so it is tested without a DOM.
// Categories keep their order; a category left with no items disappears, so the category rail and the
// sections never point at an empty heading.

// The "Veg only" switch is offered only when it would change something: the menu states diets for at
// least one item, and at least one item is not veg.
export function vegFilterUseful(categories) {
  const items = (categories || []).flatMap((category) => category.items || []);
  return items.some((item) => item.diet) && items.some((item) => item.diet && item.diet !== "veg");
}

export function filterMenu(categories, { vegOnly = false } = {}) {
  return (categories || [])
    .map((category) => ({
      ...category,
      // An item with no stated diet is not promised to be veg, so "Veg only" leaves it out.
      items: (category.items || []).filter((item) => !vegOnly || item.diet === "veg"),
    }))
    .filter((category) => category.items.length > 0);
}
