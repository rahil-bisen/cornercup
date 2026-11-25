import { seedMenu, seedTables, slugify } from "./db.js";
// Hashing is imported (and re-exported) so the database bootstrap can share one implementation
// without either module importing the other.
import { hashPassword, verifyPassword } from "./passwords.js";

export { hashPassword, verifyPassword };

export function cafeSettings(cafe) {
  return {
    cafeName: cafe.name,
    serviceMode: cafe.service_mode === "counter" ? "counter" : "tables",
    tzOffsetMin: Number.isFinite(Number(cafe.tz_offset_min)) ? Number(cafe.tz_offset_min) : 330,
    contactPhone: cafe.contact_phone || "",
    contactEmail: cafe.contact_email || "",
    contactAddress: cafe.contact_address || "",
  };
}

export function publicCafe(cafe) {
  return {
    slug: cafe.slug,
    name: cafe.name,
    serviceMode: cafe.service_mode === "counter" ? "counter" : "tables",
  };
}

export async function findCafeBySlug(env, slug) {
  if (!slug) return null;
  return env.DB.prepare("SELECT * FROM cafes WHERE slug = ?").bind(String(slug).toLowerCase()).first();
}

export async function findCafeById(env, id) {
  return env.DB.prepare("SELECT * FROM cafes WHERE id = ?").bind(Number(id)).first();
}

// The café that answers at the bare domain: the oldest one, so a single-café deployment keeps the
// exact URL its guests and printed QR codes already know.
export async function defaultCafe(env) {
  return env.DB.prepare("SELECT * FROM cafes ORDER BY id ASC LIMIT 1").first();
}

export async function listCafes(env) {
  const { results } = await env.DB.prepare("SELECT * FROM cafes ORDER BY name ASC").all();
  return (results || []).map(publicCafe);
}

// A new client is one row plus their own menu, so the whole studio shares a single deployment.
export async function createCafe(env, { name, slug, password, serviceMode = "tables", tables = 0 }) {
  const cleanName = String(name || "").trim().slice(0, 60);
  if (cleanName.length < 2) throw new Error("Give the café a name.");

  const finalSlug = slugify(slug || cleanName);
  if ((await findCafeBySlug(env, finalSlug)) || finalSlug === "operator") {
    throw new Error("That web address is already taken.");
  }

  const pass = String(password || "");
  // The same 12-character floor as an owner password change and an operator reset, so a café cannot
  // be created with a weaker password than it could later be given.
  if (pass.length < 12 || pass.length > 100) {
    throw new Error("The owner password needs at least 12 characters.");
  }

  const mode = serviceMode === "counter" ? "counter" : "tables";

  await env.DB.prepare("INSERT INTO cafes (slug, name, service_mode, pass_hash) VALUES (?, ?, ?, ?)")
    .bind(finalSlug, cleanName, mode, await hashPassword(pass))
    .run();

  const cafe = await findCafeBySlug(env, finalSlug);
  await seedMenu(env, cafe.id);

  // Only a table-service café needs tables; a counter café would never fill them in.
  if (mode === "tables") await seedTables(env, cafe.id, Math.max(0, Math.min(40, Number(tables) || 8)));

  return cafe;
}
