// F-07 phase 2A. One place moves a café between password sign-in and managed identity, and that move
// must be all-or-nothing: the mode change, its transition record, its operator audit row, and the
// invalidation of every live owner session and outstanding sign-in state either all commit or none
// do. Leaking a partial result would leave a café whose mode disagrees with its audit trail, or a
// café with every owner signed out but the old mode still in force.
//
// D1 has no BEGIN/COMMIT, and batch() commits every statement that does not itself fail — a statement
// that matches zero rows is not a failure. So atomicity cannot come from inspecting results, and it
// cannot come from a JavaScript check: it has to come from SQL. This batch enforces it three ways:
//
//   * `auth_mode_cas_token` — a fresh random value written by the compare-and-swap itself. A guard
//     statement in the same batch aborts unless that exact value is present, so the batch fails when
//     the UPDATE matched nothing, for any reason at all: a stale generation, a wrong expected mode,
//     or a no-op. A concurrent request cannot satisfy it, because it writes its own token.
//   * `tx_guard` — `INSERT ... SELECT 0 WHERE <failure>` violates a CHECK constraint, which is the
//     error that rolls the batch back.
//   * `auth_mode_transitions (cafe_id, generation)` — primary key, so a second batch cannot record a
//     generation that is already taken. Belt and braces behind the token, and the immutable log.
//
// Nothing here reads `meta.changes`, and nothing here decides whether to commit.

export const AUTH_MODES = Object.freeze(["local", "workos"]);

// 16 random bytes as 32 hex characters, the same shape as an owner session id. It is a witness, not
// a credential: it is cleared at the end of a successful batch and never leaves the database.
const CAS_TOKEN_BYTES = 16;

export function newCasToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(CAS_TOKEN_BYTES));
  let token = "";
  for (const byte of bytes) {
    token += byte.toString(16).padStart(2, "0");
  }
  return token;
}

function requireMode(value, label) {
  const mode = String(value ?? "");
  if (!AUTH_MODES.includes(mode)) {
    throw new Error(`${label} must be one of ${AUTH_MODES.join(", ")}`);
  }
  return mode;
}

function requireInteger(value, label, minimum) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new Error(`${label} must be an integer of at least ${minimum}`);
  }
  return number;
}

// The nine statements, in the only order that is safe. Exported as data so the SQLite test and the
// workerd test run byte-identical SQL with identical bindings.
export const AUTH_MODE_TRANSITION_SQL = Object.freeze([
  {
    // S1 — compare-and-swap on both the mode and the generation, writing this attempt's token.
    // `owner_auth <> :new` makes a no-op transition fail rather than silently bump the generation.
    step: "cas",
    sql:
      "UPDATE cafes SET owner_auth = ?, auth_mode_generation = ?, auth_mode_cas_token = ? " +
      "WHERE id = ? AND owner_auth = ? AND auth_mode_generation = ? AND owner_auth <> ?",
    bind: (p) => [p.newMode, p.nextGeneration, p.token, p.cafeId, p.oldMode, p.generation, p.newMode],
  },
  {
    // S2 — a managed café must have at least one owner, or switching it on would lock everyone out.
    // Independent of S1: it aborts whatever the CAS did.
    step: "owner-precondition",
    sql:
      "INSERT INTO tx_guard (ok) SELECT 0 " +
      "WHERE ? = 'workos' AND NOT EXISTS (SELECT 1 FROM cafe_owners WHERE cafe_id = ?)",
    bind: (p) => [p.newMode, p.cafeId],
  },
  {
    // S3 — the CAS witness. Fails unless S1 itself changed this row.
    step: "cas-witness",
    sql:
      "INSERT INTO tx_guard (ok) SELECT 0 " +
      "WHERE NOT EXISTS (SELECT 1 FROM cafes WHERE id = ? AND auth_mode_cas_token = ?)",
    bind: (p) => [p.cafeId, p.token],
  },
  {
    // S4 — immutable transition record. Its primary key rejects a duplicate generation.
    step: "transition",
    sql:
      "INSERT INTO auth_mode_transitions " +
      "(cafe_id, generation, from_mode, to_mode, operator_subject, created) VALUES (?, ?, ?, ?, ?, ?)",
    bind: (p) => [
      p.cafeId,
      p.nextGeneration,
      p.oldMode,
      p.newMode,
      p.operatorSubject,
      p.now,
    ],
  },
  {
    // S5 — operator audit, in the same transaction so a mode change cannot be unlogged.
    step: "audit",
    sql:
      "INSERT INTO operator_audit (cafe_id, action, subject, detail, created) " +
      "VALUES (?, 'switch_auth_mode', ?, ?, ?)",
    bind: (p) => [p.cafeId, p.operatorSubject, `${p.oldMode}->${p.newMode}`, p.now],
  },
  {
    // S6 — every owner session for this café dies with the mode it was minted under.
    step: "sessions",
    sql: "DELETE FROM owner_sessions WHERE cafe_id = ?",
    bind: (p) => [p.cafeId],
  },
  {
    // S7 — and every sign-in that has not completed yet. Scoped to this café; another tenant's
    // in-flight sign-ins are untouched.
    step: "states",
    sql: "DELETE FROM owner_login_states WHERE cafe_id = ? AND used_at IS NULL",
    bind: (p) => [p.cafeId],
  },
  {
    // S8 — the witness is cleared so it never becomes durable state.
    step: "clear-token",
    sql: "UPDATE cafes SET auth_mode_cas_token = NULL WHERE id = ? AND auth_mode_cas_token = ?",
    bind: (p) => [p.cafeId, p.token],
  },
  {
    // S9 — hygiene. Unreachable on success (S2 and S3 insert nothing then), so the table stays empty.
    step: "guard-clear",
    sql: "DELETE FROM tx_guard",
    bind: () => [],
  },
]);

// Builds one attempt. The token is generated here and here only, so every request carries its own
// and no value is ever reused across attempts.
export function authModeTransition({
  cafeId,
  oldMode,
  newMode,
  generation,
  operatorSubject,
  now = Date.now(),
}) {
  const plan = {
    cafeId: requireInteger(cafeId, "cafeId", 1),
    oldMode: requireMode(oldMode, "oldMode"),
    newMode: requireMode(newMode, "newMode"),
    generation: requireInteger(generation, "generation", 0),
    operatorSubject: String(operatorSubject ?? ""),
    now: requireInteger(now, "now", 0),
    token: newCasToken(),
  };
  if (!plan.operatorSubject) throw new Error("operatorSubject is required");
  plan.nextGeneration = plan.generation + 1;

  return {
    ...plan,
    steps: AUTH_MODE_TRANSITION_SQL.map(({ step, sql, bind }) => ({ step, sql, params: bind(plan) })),
  };
}

// Prepared D1 statements for `env.DB.batch`. Callers must await the batch and treat a thrown error as
// "nothing changed": the transaction has already rolled back.
export function authModeTransitionStatements(env, plan) {
  return plan.steps.map(({ sql, params }) => env.DB.prepare(sql).bind(...params));
}

// A CHECK or primary-key violation is the expected way this batch fails; anything else is a real
// error and must be reported as such rather than mistaken for a lost race.
export function isAuthModeTransitionConflict(err) {
  const message = String(err && err.message ? err.message : err);
  return /constraint failed/i.test(message);
}
