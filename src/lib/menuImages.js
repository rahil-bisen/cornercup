// The guest menu's picture for an item: the owner's own uploaded photograph, or nothing.
//
// The app used to fall back to six bundled stock photographs, one per category, which meant a filter
// coffee and three different chais all showed the same kulhad of chai, and both sandwiches showed the
// same sandwich. A photograph that is not of the dish reads as a mistake to a guest, so the only
// photograph shown is the one the café took of that item. Every other item gets the same clean
// placeholder tile (`placeholderInitial`), so the menu never mixes photographs, stock images and emoji.

// The src to render, or null for the placeholder. `broken` holds uploads that already failed to load in
// this session, so a missing file falls back to the placeholder instead of a broken-image icon.
export function resolveItemImage(item, _category, broken = new Set()) {
  const custom = (item && item.imageUrl) || null;
  return custom && !broken.has(custom) ? custom : null;
}

// The letter drawn on the placeholder tile: the first letter or digit of the item's name.
export function placeholderInitial(item) {
  const match = String((item && item.name) || "").match(/[\p{L}\p{N}]/u);
  return match ? match[0].toLocaleUpperCase() : "·";
}
