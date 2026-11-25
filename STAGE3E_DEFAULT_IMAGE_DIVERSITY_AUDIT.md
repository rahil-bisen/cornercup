# Stage 3E — Default Menu Image Diversity Audit

**Type:** read-only audit. Nothing was generated, downloaded, replaced or edited; no source, test, config,
database or asset was touched, and nothing was deployed or provisioned.

**Question:** the six bundled defaults are mapped per *category*, so all 27 seeded items currently show five
photographs between them. Can the existing assets do better at item level, and what is the right way to
implement that?

**Answer in one line:** item-level mapping is worth implementing, but the existing six assets can only
*improve fit* for 17 of 27 items and cannot remove repetition inside "Chai & Coffee" (six items, one
hot-drink photograph). Ten items have no suitable asset at all and are better served by their emoji until
real dish photography exists.

---

## 1. Assets inspected

All six are 1024 × 1024 JPEGs in `public/defaults/`, ~50–110 KB, warm cream/terracotta palette, single
subject, centred, food-photography lighting. They were opened and read for this audit.

| Asset | What it actually depicts | Palette | Naturally suits |
| --- | --- | --- | --- |
| `coffee.jpg` | Milky spiced **chai in a terracotta kulhad**, herb sprig on top | terracotta / cream | Indian tea; only hot milk-drink asset |
| `cold-drink.jpg` | Tall glass of **iced coffee** with chocolate drizzle, on a coaster | peach / brown | cold coffee, iced coffee drinks |
| `snack.jpg` | **Grilled vegetable sandwich** cut in two on a wooden board | wood / cream | sandwiches, toasted bread |
| `main.jpg` | Terracotta bowl of **biryani-style rice** with protein cubes, raita and a small curry bowl | terracotta / gold | biryani, rice plates, Indian curry plates |
| `dessert.jpg` | **Brownie with a scoop of vanilla ice cream** on a white plate | brown / cream | brownies, plated chocolate desserts |
| `dish.jpg` | Seared **meat fillet with tomato, carrot and jus** on a cream plate | cream / brown | generic "plated main"; currently unused by any seed item |

Two assets are visibly *specific* (`coffee.jpg` is tea, `cold-drink.jpg` is iced coffee, `main.jpg` is rice),
which matters below: reusing them outside their dish makes the menu look wrong rather than diverse.

---

## 2. All 27 items and their resolved image

Resolution today is purely categorical (`src/lib/menuImages.js`), then `dish.jpg` for unknown categories,
then the emoji. `hasCustomImage`/`imageUrl` are `false`/`null` for every seeded item, so no owner upload
overrides anything.

| # | Category | Item | Emoji | Resolved default | Shared with |
| --- | --- | --- | --- | --- | --- |
| 1 | Chai & Coffee | Masala Chai | 🫖 | `/defaults/coffee.jpg` | 5 siblings |
| 2 | Chai & Coffee | Filter Coffee | ☕ | `/defaults/coffee.jpg` | 5 siblings |
| 3 | Chai & Coffee | Espresso | ☕ | `/defaults/coffee.jpg` | 5 siblings |
| 4 | Chai & Coffee | Cappuccino | ☕ | `/defaults/coffee.jpg` | 5 siblings |
| 5 | Chai & Coffee | Café Latte | ☕ | `/defaults/coffee.jpg` | 5 siblings |
| 6 | Chai & Coffee | Hot Chocolate | 🍫 | `/defaults/coffee.jpg` | 5 siblings |
| 7 | Cold Drinks | Cold Coffee | 🥤 | `/defaults/cold-drink.jpg` | 5 siblings |
| 8 | Cold Drinks | Iced Americano | 🧊 | `/defaults/cold-drink.jpg` | 5 siblings |
| 9 | Cold Drinks | Fresh Lime Soda | 🍋 | `/defaults/cold-drink.jpg` | 5 siblings |
| 10 | Cold Drinks | Blue Lagoon Mocktail | 🍹 | `/defaults/cold-drink.jpg` | 5 siblings |
| 11 | Cold Drinks | Buttermilk | 🥛 | `/defaults/cold-drink.jpg` | 5 siblings |
| 12 | Cold Drinks | Mineral Water | 💧 | `/defaults/cold-drink.jpg` | 5 siblings |
| 13 | Snacks | Veg Grilled Sandwich | 🥪 | `/defaults/snack.jpg` | 5 siblings |
| 14 | Snacks | Paneer Tikka Sandwich | 🥪 | `/defaults/snack.jpg` | 5 siblings |
| 15 | Snacks | Peri Peri Fries | 🍟 | `/defaults/snack.jpg` | 5 siblings |
| 16 | Snacks | Veg Momos (6) | 🥟 | `/defaults/snack.jpg` | 5 siblings |
| 17 | Snacks | Chicken Momos (6) | 🥟 | `/defaults/snack.jpg` | 5 siblings |
| 18 | Snacks | Cheese Garlic Bread | 🧄 | `/defaults/snack.jpg` | 5 siblings |
| 19 | Mains | Veg Biryani | 🍚 | `/defaults/main.jpg` | 5 siblings |
| 20 | Mains | Chicken Biryani | 🍗 | `/defaults/main.jpg` | 5 siblings |
| 21 | Mains | Paneer Butter Masala | 🍛 | `/defaults/main.jpg` | 5 siblings |
| 22 | Mains | White Sauce Pasta | 🍝 | `/defaults/main.jpg` | 5 siblings |
| 23 | Mains | Arrabbiata Pasta | 🍝 | `/defaults/main.jpg` | 5 siblings |
| 24 | Mains | Masala Maggi | 🍜 | `/defaults/main.jpg` | 5 siblings |
| 25 | Desserts | Chocolate Brownie | 🍫 | `/defaults/dessert.jpg` | 2 siblings |
| 26 | Desserts | Choco Lava Cake | 🍫 | `/defaults/dessert.jpg` | 2 siblings |
| 27 | Desserts | Brownie with Ice Cream | 🍨 | `/defaults/dessert.jpg` | 2 siblings |

No item is currently left to the emoji: every seeded category has a default, and `dish.jpg` is never shown.

---

## 3. Repetition analysis

| Image | Items using it | Share of menu |
| --- | --- | --- |
| `coffee.jpg` | 6 (all of Chai & Coffee) | 22 % |
| `cold-drink.jpg` | 6 (all of Cold Drinks) | 22 % |
| `snack.jpg` | 6 (all of Snacks) | 22 % |
| `main.jpg` | 6 (all of Mains) | 22 % |
| `dessert.jpg` | 3 (all of Desserts) | 11 % |
| `dish.jpg` | 0 | 0 % |

- **Distinct images on screen:** 5 for 27 items — a 5.4 : 1 ratio.
- **Within-category repetition is total:** every category is 100 % one image. Scrolling the menu shows the
  same 52 px thumbnail repeating down the whole column, which is exactly what the Stage 3C/3D captures show
  (e.g. `screenshots/stage3c/menu-390.png`).
- **Cross-category repetition:** none today, because each category has its own asset. Any item-level mapping
  that borrows across categories will *introduce* cross-category repeats — that is the trade being made.
- **Worst offenders for a photo:** items whose category photo is actively wrong rather than generic —
  Mineral Water and Lime Soda showing an iced coffee, Momos and Fries showing a sandwich, Masala Maggi and
  the pastas showing a rice bowl.

---

## 4. Can six assets support item-level mappings?

Arithmetic first: 27 items, 6 assets, so the theoretical floor is 4.5 items per image — and the assets are
not interchangeable. Sorting them by how far they can travel:

| Asset | Safe reuse | Unsafe reuse |
| --- | --- | --- |
| `coffee.jpg` (chai in kulhad) | chai; arguably any hot milky cup | espresso (no crema, wrong vessel), iced drinks |
| `cold-drink.jpg` (iced coffee) | cold coffee, iced americano | soda, mocktail, water, buttermilk (wrong colour/liquid) |
| `snack.jpg` (grilled sandwich) | both sandwiches, garlic bread (toasted) | fries, momos |
| `main.jpg` (biryani bowl) | both biryani, paneer butter masala (curry bowl visible) | pasta, maggi |
| `dessert.jpg` (brownie + ice cream) | all three desserts | — |
| `dish.jpg` (meat fillet plate) | nothing on this menu; generic only | everything vegetarian |

**Verdict:** item-level mapping is possible and worthwhile, but with these six files it can only:
1. stop the ten mismatches (water, soda, mocktail, buttermilk, fries, two momos, two pastas, maggi),
2. keep the eight clear matches the categories already get right (chai, both sandwiches, garlic bread,
   both biryani, paneer plate, three desserts),
3. **not** diversify "Chai & Coffee" (six hot drinks, one hot-drink photo) or "Cold Drinks" beyond two
   iced-coffee items.

It cannot make 27 items look distinct. Only new per-dish photography can.

---

## 5. Proposed item-to-image mapping (existing assets only)

Resolution order proposed: **owner upload → item-level default → category default → `dish.jpg` → emoji.**
`— (emoji)` below means the item is deliberately left to its emoji because no asset is truthful for it.

| # | Item | Proposed | Fit | Why |
| --- | --- | --- | --- | --- |
| 1 | Masala Chai | `coffee.jpg` | **Exact** | The photograph *is* a kulhad of masala chai |
| 2 | Filter Coffee | `coffee.jpg` | Fair | Only hot milk-drink asset; vessel is wrong but the drink reads right |
| 3 | Espresso | `coffee.jpg` | Weak | No crema or demitasse available; still a hot cup |
| 4 | Cappuccino | `coffee.jpg` | Fair | Milky hot cup |
| 5 | Café Latte | `coffee.jpg` | Fair | Milky hot cup |
| 6 | Hot Chocolate | `coffee.jpg` | Weak | Milky hot drink; colour is close enough at 52 px |
| 7 | Cold Coffee | `cold-drink.jpg` | **Exact** | Iced coffee with chocolate drizzle |
| 8 | Iced Americano | `cold-drink.jpg` | Good | Iced coffee glass; slightly milky for a long black |
| 9 | Fresh Lime Soda | — (emoji 🍋) | **No asset** | Pale citrus soda; iced coffee would be a lie |
| 10 | Blue Lagoon Mocktail | — (emoji 🍹) | **No asset** | Blue drink, nothing close |
| 11 | Buttermilk | — (emoji 🥛) | **No asset** | White/ivory drink; the coffee asset is brown |
| 12 | Mineral Water | — (emoji 💧) | **No asset** | A bottle/glass of water |
| 13 | Veg Grilled Sandwich | `snack.jpg` | **Exact** | Grilled vegetable sandwich |
| 14 | Paneer Tikka Sandwich | `snack.jpg` | Good | Same sandwich family |
| 15 | Peri Peri Fries | — (emoji 🍟) | **No asset** | No fries photograph |
| 16 | Veg Momos (6) | — (emoji 🥟) | **No asset** | No momos photograph |
| 17 | Chicken Momos (6) | — (emoji 🥟) | **No asset** | No momos photograph |
| 18 | Cheese Garlic Bread | `snack.jpg` | Fair | Toasted bread with cheese and veg reads acceptably |
| 19 | Veg Biryani | `main.jpg` | **Exact** | Biryani bowl with raita and salan |
| 20 | Chicken Biryani | `main.jpg` | **Exact** | The bowl even has protein cubes |
| 21 | Paneer Butter Masala | `main.jpg` | Fair | Curry bowl is in frame, but rice is the hero |
| 22 | White Sauce Pasta | — (emoji 🍝) | **No asset** | Creamy pasta; the alternatives show rice or meat |
| 23 | Arrabbiata Pasta | — (emoji 🍝) | **No asset** | Red pasta; same |
| 24 | Masala Maggi | — (emoji 🍜) | **No asset** | Noodles; a rice bowl would mislead |
| 25 | Chocolate Brownie | `dessert.jpg` | **Exact** | Brownie on a plate |
| 26 | Choco Lava Cake | `dessert.jpg` | Good | Close relative; different silhouette |
| 27 | Brownie with Ice Cream | `dessert.jpg` | **Exact** | Brownie plus a scoop |

### Resulting distribution

| Image | Before | After | Items |
| --- | --- | --- | --- |
| `coffee.jpg` | 6 | 6 | items 1–6 |
| `cold-drink.jpg` | 6 | 2 | 7–8 |
| `snack.jpg` | 6 | 3 | 13, 14, 18 |
| `main.jpg` | 6 | 3 | 19–21 |
| `dessert.jpg` | 3 | 3 | 25–27 |
| `dish.jpg` | 0 | 0 | generic fallback only |
| **emoji** | 0 | 10 | 9–12, 15–17, 22–24 |

**Honest reading of the gain:** the number of distinct photographs actually shown goes from 5 to 5 (all six
are used at category level already; `dish.jpg` stays a fallback). What improves is *truthfulness* — ten items
stop showing a drink or dish they are not, and no borrowing across categories is introduced. Repetition
inside Chai & Coffee (6), Cold Drinks (2), Snacks (3), Mains (3) and Desserts (3) cannot be fixed without
new assets.

If the café prefers a menu that always shows food over one that shows the right food, the alternative is to
keep the category default for those 10 items (Option B). Both options are one table apart in code; the audit
recommends Option A (emoji where no asset is truthful) because a wrong photo on a QR menu reads as a data
error to a guest.

---

## 6. Missing image categories and dishes

Ranked by how many seeded items each would serve and how wrong the current fallback is:

| Priority | Needed asset | Unlocks | Why first |
| --- | --- | --- | --- |
| 1 | **Momos** (steamed dumplings with red chutney) | Veg Momos, Chicken Momos | Currently show a sandwich |
| 2 | **Fries** (peri peri fries in a basket/paper) | Peri Peri Fries | Currently shows a sandwich |
| 3 | **Cold non-coffee drinks** — lime soda and a blue mocktail | Fresh Lime Soda, Blue Lagoon | Currently show iced coffee |
| 4 | **Buttermilk / water glass** | Buttermilk, Mineral Water | Currently show iced coffee |
| 5 | **Pasta** — one creamy, one tomato | White Sauce Pasta, Arrabbiata | Currently show a rice bowl |
| 6 | **Maggi / noodles** | Masala Maggi | Currently shows a rice bowl |
| 7 | **Espresso / filter coffee in a demitasse** (2 assets) | Espresso, Filter Coffee | Splits the six-way chai cluster |
| 8 | **Cappuccino / latte with latte art** (1–2 assets) | Cappuccino, Café Latte | Splits the cluster further |
| 9 | **Hot chocolate mug** | Hot Chocolate | Completes the hot-drinks set |
| 10 | **Paneer butter masala bowl** | Paneer Butter Masala | Removes the last rice-bowl mismatch |
| 11 | **Choco lava cake** | Choco Lava Cake | Finishes desserts |

Priorities 1–6 are nine new files (momos, fries, lime soda, mocktail, buttermilk, water, two pastas,
maggi). With them, every item on the menu would have a truthful photograph and the bundle would go from six
assets to fifteen, taking the average from 5.4 items per image to about 1.8 — although "Chai & Coffee" would
still share one photograph until priorities 7–9 land.

Style constraints for any future asset (to preserve the current identity): square 1:1, single subject
centred, warm cream/terracotta palette, soft daylight, no text or logos, ≥ 800 px so the 52 px crop stays
sharp on high-DPI screens.

---

## 7. Recommended implementation approach

**1. Data shape — a static module, not the database.**
The defaults are bundled assets that ship with the build, so they belong beside the current map rather than
in D1. Extend `src/lib/menuImages.js` with:

```js
// Keyed by category + normalised item name: a café may rename items, and the key must survive that
// gracefully by falling through to the category default.
const ITEM_DEFAULTS = {
  "chai & coffee|masala chai": "/defaults/coffee.jpg",
  ...
  "cold drinks|mineral water": null, // explicit: no truthful photograph, use the emoji
};
```

- `null` is the deliberate "emoji" sentinel; **absent** means "fall through to the category default". Those
  two cases must stay distinguishable, otherwise every future item silently loses its photo.
- Normalise with the existing `slug()`-style rule (lowercase, collapse non-alphanumerics), so spacing,
  punctuation and capitalisation changes in a café's own edits do not break the mapping.

**2. Resolution order (unchanged priority for uploads).**

```
owner upload (item.imageUrl from D1)
  → item-level default (ITEM_DEFAULTS hit; null means emoji)
  → category default (CATEGORY_DEFAULTS)
  → generic /defaults/dish.jpg
  → emoji
  → (on image error) same ladder with the failed source marked broken
```

The owner's upload keeps absolute priority because `item.imageUrl` is checked first and is the only
server-side source; this stage does not touch that path.

**3. Surface area.**
Only `src/lib/menuImages.js` (map + lookup) and its consumer `src/pages/Menu.jsx` change — the later stage's
work, not this one. `Menu.jsx` keeps the 52 px `.menu-emoji` tile, `object-fit: cover`, `alt={item.name}`,
lazy loading and the broken-image fallback exactly as they are. The admin tab needs no change: it already
shows the item's own upload or the generic emoji for "no custom photo", and item-level defaults are a guest
surface.

**4. Tests for that stage (not written here).**
- every known item resolves to its proposed path, and `null` entries resolve to `null` (emoji);
- an unknown category or renamed item still resolves through the category default;
- a broken item default falls to the category default, then to the emoji;
- an owner upload still wins over both;
- the resolved set uses each file at most as often as the table in §5 says.

**5. Rollout.**
Purely client-side and additive: no migration, no Worker route, no R2 and no cache invalidation are
involved, and reverting is deleting the map. New artwork can then be dropped in one file per dish and wired
into the same table without touching the resolution order.

---

## 8. Boundaries

Read-only. No images were generated, downloaded or replaced; no source, test, configuration, database or
asset was modified; nothing was deployed, provisioned, committed or pointed at production or staging.
