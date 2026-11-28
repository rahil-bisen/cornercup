import { seedMenu, seedTables, slugify } from "./db.js";
// Hashing is imported (and re-exported) so the database bootstrap can share one implementation
// without either module importing the other.
import {
  hashPassword,
  verifyPassword,
  isArgon2Hash,
  passwordNeedsReset,
  PasswordQueueFullError,
} from "./passwords.js";

export { hashPassword, verifyPassword, isArgon2Hash, passwordNeedsReset, PasswordQueueFullError };

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

// An archived café is treated as absent everywhere a guest, owner or sign-in reaches it, so its pages
// answer "Café not found" and no order or sign-in can start. Only the operator's archive, restore
// and delete routes (and the slug-uniqueness check) pass `includeArchived`.
export async function findCafeBySlug(env, slug, { includeArchived = false } = {}) {
  if (!slug) return null;
  const sql = includeArchived
    ? "SELECT * FROM cafes WHERE slug = ?"
    : "SELECT * FROM cafes WHERE slug = ? AND archived_at IS NULL";
  return env.DB.prepare(sql).bind(String(slug).toLowerCase()).first();
}

export async function findCafeById(env, id) {
  return env.DB.prepare("SELECT * FROM cafes WHERE id = ? AND archived_at IS NULL").bind(Number(id)).first();
}

// The primary café: the oldest one, so a single-café deployment keeps the exact URL its guests and
// printed QR codes already know. It answers at the bare domain and can never be archived or deleted.
export async function primaryCafeId(env) {
  const row = await env.DB.prepare("SELECT id FROM cafes ORDER BY id ASC LIMIT 1").first();
  return row ? Number(row.id) : null;
}

export async function defaultCafe(env) {
  return env.DB.prepare("SELECT * FROM cafes WHERE archived_at IS NULL ORDER BY id ASC LIMIT 1").first();
}

export async function listCafes(env) {
  const { results } = await env.DB.prepare(
    "SELECT * FROM cafes WHERE archived_at IS NULL ORDER BY name ASC"
  ).all();
  return (results || []).map(publicCafe);
}

// A new client is one row plus their own menu, so the whole studio shares a single deployment.
export async function createCafe(env, { name, slug, password, serviceMode = "tables", tables = 0 }) {
  const cleanName = String(name || "").trim().slice(0, 60);
  if (cleanName.length < 2) throw new Error("Give the café a name.");

  const finalSlug = slugify(slug || cleanName);
  // Archived cafés still hold their slug: reusing it would hand the old café's restore to a stranger.
  if ((await findCafeBySlug(env, finalSlug, { includeArchived: true })) || finalSlug === "operator") {
    throw new Error("That web address is already taken.");
  }

  const pass = String(password || "");
  // The same 12-character floor as an owner password change and an operator reset, so a café cannot
  // be created with a weaker password than it could later be given.
  if (pass.length < 12 || pass.length > 100) {
    throw new Error("The owner password needs at least 12 characters.");
  }

  if (serviceMode !== "counter" && serviceMode !== "tables") {
    throw new Error("Choose table service or counter service.");
  }
  const validTableCountType =
    typeof tables === "number" || (typeof tables === "string" && tables.trim() !== "");
  const tableCount = validTableCountType ? Number(tables) : Number.NaN;
  if (!Number.isSafeInteger(tableCount) || tableCount < 0 || tableCount > 40) {
    throw new Error("The starting table count must be between 0 and 40.");
  }

  const mode = serviceMode;
  const statements = [
    env.DB.prepare("INSERT INTO cafes (slug, name, service_mode, pass_hash) VALUES (?, ?, ?, ?)")
      .bind(finalSlug, cleanName, mode, await hashPassword(pass)),
  ];

  // Create any explicitly requested tables in the same D1 batch as the café, so a failed setup
  // cannot leave a half-created café behind.
  if (mode === "tables") {
    for (let number = 1; number <= tableCount; number += 1) {
      statements.push(
        env.DB.prepare(
          "INSERT INTO tables (cafe_id, number, label, seats) SELECT id, ?, ?, ? FROM cafes WHERE slug = ?"
        ).bind(number, `Table ${number}`, number <= 2 ? 2 : 4, finalSlug)
      );
    }
  }
  await env.DB.batch(statements);

  const cafe = await findCafeBySlug(env, finalSlug);
  await seedMenu(env, cafe.id);

  return cafe;
}
