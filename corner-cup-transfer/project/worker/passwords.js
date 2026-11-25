// Owner password hashing. It lives on its own because two producers need it: the café module (create,
// change, operator reset) and the database bootstrap that seeds the primary café's password from
// OWNER_PASSWORD. Having either import the other would be a circular import.

const PBKDF2_ITERATIONS = 600_000;

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
