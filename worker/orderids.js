// Order id generation.
//
// Ids are short codes a guest reads aloud at the counter, so the alphabet leaves out every
// look-alike character. It has exactly 32 entries, which is why `byte % 32` over a 0..255 byte is
// uniform — a 33-entry alphabet would bias the first eight characters.

export const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

// Short codes are tried first, then longer ones. Every candidate, including the long fallback, is
// checked against D1 before it is returned: an unchecked code would provoke a PRIMARY KEY failure
// inside the order batch and answer that guest with a 500.
const LENGTHS = [
  [6, 6],
  [8, 3],
];

// Thrown when no free id exists after the bounded attempts. The caller turns this into a 503 and
// releases the idempotency claim so the guest can retry the same checkout.
export class OrderIdUnavailableError extends Error {
  constructor() {
    super("no free order id after bounded attempts");
    this.name = "OrderIdUnavailableError";
  }
}

export function randomCode(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

async function idTaken(env, id) {
  const row = await env.DB.prepare("SELECT 1 AS found FROM orders WHERE id = ?").bind(id).first();
  return Boolean(row);
}

// The generator is injectable so collision paths can be tested deterministically; production always
// calls freshOrderId().
export async function freshOrderIdWith(env, generate) {
  for (const [length, attempts] of LENGTHS) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const id = generate(length);
      if (!(await idTaken(env, id))) return id;
    }
  }
  throw new OrderIdUnavailableError();
}

export async function freshOrderId(env) {
  return freshOrderIdWith(env, randomCode);
}

// True only when a D1 error is the orders.id primary-key collision that the retry loop in
// createOrder can safely recover from by minting a new id. Matching is deliberately narrow:
// any other UNIQUE, foreign-key, CHECK or generic D1 error must not be retried.
export function isOrderIdCollision(err) {
  const message = String((err && err.message) || err || "");
  return /UNIQUE constraint failed:\s*orders\.id\b/i.test(message) ||
    /SQLITE_CONSTRAINT_PRIMARYKEY/i.test(message);
}

// The SELECT above and the INSERT in orderBatch() are separate statements, so two concurrent
// checkouts can both observe the same id as free. The insert batch is atomic, so exactly one order
// is written and the loser fails on the primary key. createOrder() recovers from that specific
// failure by minting a completely fresh attempt — new id, new nonce, new tracking token and hash —
// up to MAX_ATTEMPTS (4) in total; isOrderIdCollision() is deliberately narrow so no other D1 error
// is retried. The pre-check keeps the collision rare (roughly n/32^6 per request), and the primary
// key fails closed rather than corrupting data if all attempts are exhausted.
