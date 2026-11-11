import { seedMenu, seedTables, slugify } from "./db.js";

const PBKDF2_ITERATIONS = 100_000;

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromBase64(salt), iterations, hash: "SHA-256" },
    key,
    256
  );
  let binary = "";
  for (const byte of new Uint8Array(bits)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

// Each café keeps its own owner password. Hashing it means a database dump does not hand over
// every client's staff board.
export async function hashPassword(password) {
  const saltBytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = "";
  for (const byte of saltBytes) salt += String.fromCharCode(byte);
  salt = btoa(salt);
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${salt}$${hash}`;
}

export async function verifyPassword(password, stored) {
  if (!stored) return false;
  const [scheme, iterationsRaw, salt, hash] = String(stored).split("$");
  if (scheme !== "pbkdf2" || !salt || !hash) return false;

  const iterations = Number(iterationsRaw);
  if (!Number.isFinite(iterations) || iterations < 1000) return false;

  const candidate = await derive(password, salt, iterations);
  if (candidate.length !== hash.length) return false;

  let mismatch = 0;
  for (let i = 0; i < candidate.length; i += 1) mismatch |= candidate.charCodeAt(i) ^ hash.charCodeAt(i);
  return mismatch === 0;
}

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
  if (pass.length < 6) throw new Error("The owner password needs at least 6 characters.");

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
