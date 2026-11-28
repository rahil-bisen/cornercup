// Veg / non-veg / egg and menu search: the filters as pure functions, and the owner's diet field over the
// real Worker routes in the auth harness (create, edit, clear, refuse a bad value, guest menu shows it).
import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_MIN_ITEMS, filterMenu, searchUseful, vegFilterUseful } from "../src/lib/menuFilter.js";
import { SEED_MENU } from "../worker/db.js";
import { DEMO_MENU } from "../scripts/demo-cafe.mjs";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

const categories = [
  { name: "Drinks", items: [{ id: 1, name: "Chai", diet: "veg" }, { id: 2, name: "Lassi", diet: null }] },
  { name: "Mains", items: [{ id: 3, name: "Chicken Biryani", diet: "nonveg" }, { id: 4, name: "Egg Curry", diet: "egg" }] },
  { name: "Snacks", items: [{ id: 5, name: "Samosa", diet: "veg" }] },
];

test("Veg only keeps veg items, drops unstated ones, and drops emptied categories", () => {
  const shown = filterMenu(categories, { vegOnly: true });
  assert.deepEqual(shown.map((c) => c.name), ["Drinks", "Snacks"]);
  assert.deepEqual(shown.flatMap((c) => c.items.map((i) => i.id)), [1, 5]);
  assert.deepEqual(filterMenu(categories).flatMap((c) => c.items.map((i) => i.id)), [1, 2, 3, 4, 5], "off shows everything");
});

test("the switch is offered only when it would change something", () => {
  assert.equal(vegFilterUseful(categories), true);
  assert.equal(vegFilterUseful([{ name: "A", items: [{ diet: "veg" }, { diet: null }] }]), false, "nothing to hide");
  assert.equal(vegFilterUseful([{ name: "A", items: [{ diet: null }] }]), false, "no diets stated");
});

test("every starter and demo item states its diet", () => {
  for (const row of SEED_MENU) assert.ok(["veg", "nonveg", "egg"].includes(row[6]), row[1]);
  for (const row of DEMO_MENU) assert.ok(["veg", "nonveg", "egg"].includes(row[6]), row[1]);
  assert.equal(SEED_MENU.find((r) => r[1] === "Chicken Biryani")[6], "nonveg");
  assert.equal(DEMO_MENU.find((r) => r[1] === "Chocolate Brownie")[6], "egg");
});

/* ------------------------------------------------------- the owner's routes */

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
let alive = false;
try {
  alive = (await fetch(`${AUTH}/api/health`)).status < 600;
} catch {
  alive = false;
}

const send = (method, path, body, headers = {}) =>
  fetch(`${AUTH}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: AUTH, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function owner() {
  const cafe = await (await send("POST", "/seed", { serviceMode: "counter" })).json();
  const login = await send("POST", `/api/cafes/${cafe.slug}/admin/login`, { password: HARNESS_OWNER_PASSWORD });
  assert.equal(login.status, 200);
  const cookie = String(login.headers.get("set-cookie") || "").split(";")[0];
  const session = await (await send("GET", `/api/cafes/${cafe.slug}/admin/session`, undefined, { cookie })).json();
  return { cafe, headers: { cookie, "x-csrf-token": session.csrfToken } };
}

test("the owner sets, changes and clears an item's diet; the guest menu shows it", { skip: !alive && "auth harness not running" }, async () => {
  const { cafe, headers } = await owner();
  const base = `/api/cafes/${cafe.slug}`;
  try {
    const created = await send("POST", `${base}/admin/menu`, { name: "Egg Roll", category: "Snacks", priceCents: 9000, diet: "egg" }, headers);
    assert.equal(created.status, 201);
    const { id } = await created.json();

    const diets = async () => {
      const menu = await (await send("GET", `${base}/menu`)).json();
      return Object.fromEntries(menu.categories.flatMap((c) => c.items).map((i) => [i.id, i.diet]));
    };
    assert.equal((await diets())[id], "egg");
    assert.equal((await diets())[cafe.itemId], null, "an item that never set one stays unmarked");

    assert.equal((await send("PATCH", `${base}/admin/menu/${id}`, { diet: "nonveg" }, headers)).status, 200);
    assert.equal((await diets())[id], "nonveg");

    assert.equal((await send("PATCH", `${base}/admin/menu/${id}`, { diet: null }, headers)).status, 200);
    assert.equal((await diets())[id], null);

    const bad = await send("PATCH", `${base}/admin/menu/${id}`, { diet: "vegan" }, headers);
    assert.equal(bad.status, 400);
    assert.equal((await send("POST", `${base}/admin/menu`, { name: "X", priceCents: 100, diet: 1 }, headers)).status, 400);
    assert.equal((await diets())[id], null, "a refused edit changed nothing");

    // Editing another field keeps the diet that was set.
    await send("PATCH", `${base}/admin/menu/${id}`, { diet: "veg" }, headers);
    await send("PATCH", `${base}/admin/menu/${id}`, { name: "Veg Roll" }, headers);
    assert.equal((await diets())[id], "veg");
  } finally {
    await send("POST", "/clean", { slug: cafe.slug });
  }
});

/* ------------------------------------------------------------------ search */


const longMenu = [
  { name: "Chai & Coffee", items: [{ name: "Café Latte", description: "Smooth and milky", diet: "veg" }, { name: "Masala Chai", description: "Kadak", diet: "veg" }] },
  { name: "Mains", items: [{ name: "Chicken Biryani", description: "Long grain rice", diet: "nonveg" }, { name: "Veg Biryani", description: "Dum-cooked", diet: "veg" }] },
];

test("search matches every typed word in name, description or category, ignoring case and accents", () => {
  const names = (query, options = {}) => filterMenu(longMenu, { query, ...options }).flatMap((c) => c.items.map((i) => i.name));
  assert.deepEqual(names("cafe latte"), ["Café Latte"]);
  assert.deepEqual(names("  BIRYANI "), ["Chicken Biryani", "Veg Biryani"]);
  assert.deepEqual(names("rice chicken"), ["Chicken Biryani"], "words in any order, across name and description");
  assert.deepEqual(names("coffee"), ["Café Latte", "Masala Chai"], "the category name counts");
  assert.deepEqual(names("biryani", { vegOnly: true }), ["Veg Biryani"], "search and Veg only combine");
  assert.deepEqual(names("pizza"), []);
  assert.deepEqual(names(""), ["Café Latte", "Masala Chai", "Chicken Biryani", "Veg Biryani"]);
});

test("search is offered only on menus with more than 15 items", () => {
  const menuOf = (n) => [{ name: "A", items: Array.from({ length: n }, (_, i) => ({ name: `Item ${i}` })) }];
  assert.equal(SEARCH_MIN_ITEMS, 16);
  assert.equal(searchUseful(menuOf(15)), false);
  assert.equal(searchUseful(menuOf(16)), true);
});
