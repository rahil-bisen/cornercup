#!/usr/bin/env node
// Creates or resets the sales-demo café, and nothing else.
//
//   node scripts/demo-cafe.mjs                      # reset the LOCAL database (wrangler dev / npm start)
//   node scripts/demo-cafe.mjs --print              # print the SQL and touch nothing
//   node scripts/demo-cafe.mjs --remote --confirm chai-kona
//                                                   # reset the demo café on the LIVE database
//
// What a reset leaves behind: one café at /c/chai-kona with table service, IST (UTC+5:30), six tables,
// an Indian menu priced in INR across five categories, one item marked sold out, and no orders. It is
// safe to run before every demo.
//
// Why it cannot touch another café: every statement is scoped to the demo slug, either by
// `WHERE slug = 'chai-kona'` on the cafes row or by `cafe_id = (SELECT id FROM cafes WHERE slug =
// 'chai-kona')` everywhere else. The slug is a constant, not an argument, and tests/demo-cafe.test.mjs
// runs this exact SQL against a database holding other cafés and checks they come out byte-identical.
//
// What it never does: set, print or change a password. A newly created demo café has no owner password,
// so its board refuses sign-in until you set one in /operator → Reset password. A reset keeps whatever
// password, sign-in sessions and two-factor setup the café already has.
//
// Payments: online payment is a deployment setting (Razorpay keys). This script stores nothing about
// it, so with no keys on the deployment the demo café takes payment at the counter only.

import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const DEMO_SLUG = "chai-kona";

// Shown to guests on the menu and on the About, Contact and policy pages. Edit freely; the slug above is
// what keeps the reset scoped, not the name.
export const DEMO_CAFE = {
  name: "Chai Kona Café",
  serviceMode: "tables",
  tzOffsetMin: 330, // IST, UTC+5:30
  address: "Demo café, Bengaluru",
  phone: "Demo café (no phone line)",
  email: "hello@chaikona.example",
};

export const DEMO_TABLES = [
  { number: 1, seats: 2 },
  { number: 2, seats: 2 },
  { number: 3, seats: 4 },
  { number: 4, seats: 4 },
  { number: 5, seats: 4 },
  { number: 6, seats: 6 },
];

// [category, name, description, price in paise, emoji, available]. The five categories match the bundled
// category photographs in public/defaults, and the item names match the photo map in
// src/lib/menuImages.js, so items show a real photograph where one truthfully exists and their emoji
// otherwise. One item is sold out so the demo can show how that looks to a guest.
export const DEMO_MENU = [
  ["Chai & Coffee", "Masala Chai", "Kadak chai with house masala, served in a kulhad.", 4000, "🫖", true],
  ["Chai & Coffee", "Filter Coffee", "South Indian degree coffee, frothed and poured tall.", 5000, "☕", true],
  // The only bundled hot-drink photograph is chai in a kulhad, so the hot drinks are chais: a cappuccino
  // or hot chocolate would have shown a picture of something else.
  ["Chai & Coffee", "Adrak Chai", "Fresh ginger, brewed strong.", 4500, "🫖", true],
  ["Chai & Coffee", "Elaichi Chai", "Cardamom chai, lightly sweet.", 4500, "🫖", true],

  ["Cold Drinks", "Cold Coffee", "Blended with vanilla ice cream, chocolate on top.", 14000, "🥤", true],
  ["Cold Drinks", "Iced Americano", "Long black over ice.", 12000, "🧊", true],
  ["Cold Drinks", "Fresh Lime Soda", "Sweet or salted, your call.", 7000, "🍋", true],
  ["Cold Drinks", "Buttermilk", "Chilled chaas with curry leaf and ginger.", 5000, "🥛", true],

  ["Snacks", "Veg Grilled Sandwich", "Mint chutney, cheese and vegetables, pressed on the grill.", 11000, "🥪", true],
  ["Snacks", "Paneer Tikka Sandwich", "Tandoori paneer, onion and capsicum.", 15000, "🥪", true],
  ["Snacks", "Cheese Garlic Bread", "Molten cheese on toasted garlic bread.", 13000, "🧄", true],
  ["Snacks", "Veg Momos (6)", "Steamed, with fiery red chutney.", 9000, "🥟", true],

  ["Mains", "Veg Biryani", "Dum-cooked, with raita and mirchi ka salan.", 21000, "🍚", true],
  ["Mains", "Chicken Biryani", "Long-grain rice, tender chicken, raita.", 27000, "🍗", false],
  ["Mains", "Paneer Butter Masala", "With two butter rotis.", 23000, "🍛", true],
  ["Mains", "Masala Maggi", "Onion, tomato and plenty of butter.", 7000, "🍜", true],

  ["Desserts", "Chocolate Brownie", "Warm, fudgy, dark chocolate.", 11000, "🍫", true],
  ["Desserts", "Choco Lava Cake", "Molten centre, vanilla ice cream on the side.", 13000, "🍫", true],
  ["Desserts", "Brownie with Ice Cream", "The full works.", 17000, "🍨", true],
];

// SQLite string literal. Every value here is a constant from this file, but quoting stays correct anyway.
function q(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

// The SQL for one reset, as an ordered list of statements. Exported so the test runs exactly this.
export function buildDemoStatements() {
  const slug = q(DEMO_SLUG);
  const cafeId = `(SELECT id FROM cafes WHERE slug = ${slug})`;
  const c = DEMO_CAFE;
  const statements = [];

  // Create the row only if it is missing. pass_hash stays NULL: sign-in fails closed until an operator
  // sets the owner password, and an existing café keeps its own.
  statements.push(
    `INSERT INTO cafes (slug, name, service_mode, tz_offset_min, contact_phone, contact_email, contact_address) ` +
      `SELECT ${slug}, ${q(c.name)}, ${q(c.serviceMode)}, ${Number(c.tzOffsetMin)}, ${q(c.phone)}, ${q(c.email)}, ${q(c.address)} ` +
      `WHERE NOT EXISTS (SELECT 1 FROM cafes WHERE slug = ${slug})`
  );
  // Settings are put back to the demo values every time, in case they were edited during a demo.
  statements.push(
    `UPDATE cafes SET name = ${q(c.name)}, service_mode = ${q(c.serviceMode)}, tz_offset_min = ${Number(c.tzOffsetMin)}, ` +
      `contact_phone = ${q(c.phone)}, contact_email = ${q(c.email)}, contact_address = ${q(c.address)} ` +
      `WHERE slug = ${slug}`
  );

  // Last demo's orders go, children first so no order_items row is left pointing at nothing.
  statements.push(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE cafe_id = ${cafeId})`);
  statements.push(`DELETE FROM checkout_claims WHERE cafe_id = ${cafeId}`);
  statements.push(`DELETE FROM orders WHERE cafe_id = ${cafeId}`);

  // Menu and tables are rebuilt from the lists above. Guests reach a table by its number (/t/1), not by
  // its row id, so printed QR codes keep working across resets.
  statements.push(`DELETE FROM menu_items WHERE cafe_id = ${cafeId}`);
  statements.push(`DELETE FROM tables WHERE cafe_id = ${cafeId}`);

  for (const table of DEMO_TABLES) {
    statements.push(
      `INSERT INTO tables (cafe_id, number, label, seats) ` +
        `SELECT id, ${table.number}, ${q(`Table ${table.number}`)}, ${table.seats} FROM cafes WHERE slug = ${slug}`
    );
  }

  DEMO_MENU.forEach(([category, name, description, price, emoji, available], index) => {
    statements.push(
      `INSERT INTO menu_items (cafe_id, category, name, description, price_cents, emoji, available, sort) ` +
        `SELECT id, ${q(category)}, ${q(name)}, ${q(description)}, ${Number(price)}, ${q(emoji)}, ${available ? 1 : 0}, ${(index + 1) * 10} ` +
        `FROM cafes WHERE slug = ${slug}`
    );
  });

  return statements;
}

export function buildDemoSql() {
  return `${buildDemoStatements().join(";\n")};\n`;
}

function usage(message) {
  if (message) console.error(`\n${message}`);
  console.error(
    [
      "",
      "Usage:",
      "  node scripts/demo-cafe.mjs                               reset the demo café in the local database",
      "  node scripts/demo-cafe.mjs --print                       print the SQL only",
      `  node scripts/demo-cafe.mjs --remote --confirm ${DEMO_SLUG}   reset the demo café on the LIVE database`,
      "",
    ].join("\n")
  );
  process.exit(message ? 1 : 0);
}

async function main(argv) {
  const args = new Set(argv);
  if (args.has("--help") || args.has("-h")) usage();

  const sql = buildDemoSql();
  if (args.has("--print")) {
    process.stdout.write(sql);
    return;
  }

  const remote = args.has("--remote");
  if (remote) {
    // Typing the slug is the guard against running a live reset by accident.
    const at = argv.indexOf("--confirm");
    if (at === -1 || argv[at + 1] !== DEMO_SLUG) {
      usage(`A live reset needs --confirm ${DEMO_SLUG}. Nothing was changed.`);
    }
  }

  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = await mkdtemp(path.join(tmpdir(), "demo-cafe-"));
  const file = path.join(dir, "demo-cafe.sql");
  try {
    await writeFile(file, sql, "utf8");
    // The project's own wrangler, run by this same Node with no shell in between, so no argument is
    // ever re-parsed by cmd.exe or sh.
    const wrangler = path.join(root, "node_modules", "wrangler", "bin", "wrangler.js");
    const wranglerArgs = [wrangler, "d1", "execute", "corner-cup", remote ? "--remote" : "--local", "--file", file];
    if (remote) wranglerArgs.push("--yes");
    console.log(`Resetting /c/${DEMO_SLUG} on the ${remote ? "LIVE" : "local"} database…`);
    const result = spawnSync(process.execPath, wranglerArgs, { cwd: root, stdio: "inherit" });
    if (result.status !== 0) {
      console.error("\nThe reset did not complete. Nothing outside the demo café was part of it.");
      process.exit(result.status || 1);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  console.log(
    [
      "",
      `Done. ${DEMO_CAFE.name}: ${DEMO_TABLES.length} tables, ${DEMO_MENU.length} menu items ` +
        `(${DEMO_MENU.filter((item) => !item[5]).length} sold out), no orders.`,
      `Guests: /c/${DEMO_SLUG}   Staff: /c/${DEMO_SLUG}/owner`,
      "If this is the first run, set the owner password in /operator → Reset password before signing in.",
    ].join("\n")
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  await main(process.argv.slice(2));
}
