// F-07 phase 2A, real D1. The SQLite suite proves the statement list's semantics; this suite proves
// the same list inside `env.DB.batch()` on workerd, where the guarantee that actually matters lives:
// a failed statement rolls back the whole batch, and a zero-row UPDATE does not.
//
// Every failed scenario compares a full snapshot of all six affected tables for the café before and
// after, so "nothing changed" is checked table by table, not inferred from a status code.

import test from "node:test";
import assert from "node:assert/strict";

const BASE = process.env.HARNESS_URL || "http://127.0.0.1:8789";

let alive = false;
try {
  const probe = await fetch(`${BASE}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `harness not available at ${BASE}`;

async function post(path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.json();
}

const seed = (body = {}) => post("/phase2a/seed", body);
const snapshot = (cafeId) => post("/phase2a/snapshot", { cafeId });
const transition = (body) => post("/phase2a/transition", body);

// One seeded café per test, so scenarios never share rows.
async function fresh(body = {}) {
  const { cafeId } = await seed(body);
  assert.ok(Number.isInteger(cafeId) && cafeId > 0, "seed must return a café id");
  return cafeId;
}

test("F-07 phase 2A D1: a successful transition commits once, clears the token, and scopes invalidation", { skip }, async () => {
  const cafeId = await fresh();

  const result = await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 });
  assert.equal(result.ok, true, result.error);
  assert.equal(result.error, undefined);

  const after = await snapshot(cafeId);
  assert.deepEqual(after.cafe, {
    id: cafeId,
    owner_auth: "workos",
    auth_mode_generation: 1,
    auth_mode_cas_token: null,
  });
  assert.deepEqual(after.transitions, [
    { cafe_id: cafeId, generation: 1, from_mode: "local", to_mode: "workos" },
  ]);
  assert.deepEqual(after.audit, [
    { cafe_id: cafeId, action: "switch_auth_mode", subject: "p2a-operator", detail: "local->workos" },
  ]);
  assert.deepEqual(after.sessions, [], "every owner session for this café is revoked");
  assert.deepEqual(
    after.states,
    [{ nonce_hash: `p2a-${cafeId}-spent`, used_at: 500 }],
    "live sign-in states are revoked; the already-consumed one is history"
  );
  assert.equal(after.guard, 0, "the guard table never retains a row");
});

test("F-07 phase 2A D1: a stale generation aborts and leaves every table unchanged", { skip }, async () => {
  const cafeId = await fresh();
  assert.equal((await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 })).ok, true);

  const before = await snapshot(cafeId);
  const result = await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.constraint, true, `expected a constraint error, got: ${result.error}`);
  assert.deepEqual(await snapshot(cafeId), before);
});

test("F-07 phase 2A D1: A to B to A, then a stale retry, aborts and changes nothing", { skip }, async () => {
  const cafeId = await fresh();
  assert.equal((await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 })).ok, true);
  assert.equal((await transition({ cafeId, oldMode: "workos", newMode: "local", generation: 1 })).ok, true);

  const before = await snapshot(cafeId);
  const result = await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.constraint, true, result.error);
  assert.deepEqual(await snapshot(cafeId), before);
});

test("F-07 phase 2A D1: a wrong expected mode with a current generation aborts and changes nothing", { skip }, async () => {
  const cafeId = await fresh();
  const before = await snapshot(cafeId);

  // Generation is current, but the café is `local`, not the `workos` this caller claims. The
  // generation-based witness cannot see this; the per-attempt CAS token must.
  const result = await transition({ cafeId, oldMode: "workos", newMode: "local", generation: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.constraint, true, result.error);
  const after = await snapshot(cafeId);
  assert.deepEqual(after, before);
  assert.equal(after.cafe.owner_auth, "local");
  assert.equal(after.cafe.auth_mode_cas_token, null, "a failed attempt leaves no token behind");
});

test("F-07 phase 2A D1: a zero-owner café cannot switch to managed, and nothing changes", { skip }, async () => {
  const cafeId = await fresh({ owner: false });
  const before = await snapshot(cafeId);

  const result = await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.constraint, true, result.error);
  const after = await snapshot(cafeId);
  assert.deepEqual(after, before);
  assert.equal(after.sessions.length, 2, "sessions survive a refused transition");
  assert.deepEqual(
    after.states.map((row) => row.nonce_hash),
    [`p2a-${cafeId}-live-0`, `p2a-${cafeId}-live-1`, `p2a-${cafeId}-spent`],
    "sign-in states survive a refused transition"
  );
});

test("F-07 phase 2A D1: zero owners and a stale generation at once abort and change nothing", { skip }, async () => {
  const cafeId = await fresh();
  assert.equal((await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 })).ok, true);

  const before = await snapshot(cafeId);
  // The owner row is data, not part of the batch; deleting it makes S2 fail while the generation is
  // also stale, proving either guard alone aborts.
  const result = await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 });
  assert.equal(result.ok, false);
  assert.equal(result.constraint, true, result.error);
  assert.deepEqual(await snapshot(cafeId), before);
});

test("F-07 phase 2A D1: a no-op transition is refused in SQL", { skip }, async () => {
  const cafeId = await fresh();
  const before = await snapshot(cafeId);

  const result = await transition({ cafeId, oldMode: "local", newMode: "local", generation: 0 });

  assert.equal(result.ok, false);
  assert.equal(result.constraint, true, result.error);
  assert.deepEqual(await snapshot(cafeId), before);
  assert.equal((await snapshot(cafeId)).cafe.auth_mode_generation, 0, "a no-op must not bump the generation");
});

test("F-07 phase 2A D1: workos to local succeeds and records a second transition", { skip }, async () => {
  const cafeId = await fresh();
  assert.equal((await transition({ cafeId, oldMode: "local", newMode: "workos", generation: 0 })).ok, true);

  const result = await transition({ cafeId, oldMode: "workos", newMode: "local", generation: 1 });
  assert.equal(result.ok, true, result.error);

  const after = await snapshot(cafeId);
  assert.equal(after.cafe.owner_auth, "local");
  assert.equal(after.cafe.auth_mode_generation, 2);
  assert.equal(after.cafe.auth_mode_cas_token, null);
  assert.deepEqual(
    after.transitions.map((row) => `${row.generation}:${row.from_mode}->${row.to_mode}`),
    ["1:local->workos", "2:workos->local"]
  );
  assert.equal(after.audit.length, 2, "one audit row per committed transition");
});

test("F-07 phase 2A D1: concurrent transitions let exactly one win", { skip }, async () => {
  const cafeId = await fresh();
  const before = await snapshot(cafeId);

  const request = { cafeId, oldMode: "local", newMode: "workos", generation: 0 };
  const [first, second] = await Promise.all([transition(request), transition(request)]);

  const winners = [first, second].filter((result) => result.ok === true);
  const losers = [first, second].filter((result) => result.ok === false);
  assert.equal(winners.length, 1, `expected exactly one success, got ${JSON.stringify([first, second])}`);
  assert.equal(losers.length, 1);
  assert.equal(losers[0].constraint, true, `the loser must be a constraint error: ${losers[0].error}`);

  const after = await snapshot(cafeId);
  assert.equal(after.cafe.owner_auth, "workos");
  assert.equal(after.cafe.auth_mode_generation, 1);
  assert.equal(after.cafe.auth_mode_cas_token, null);
  assert.equal(after.transitions.length, 1, "exactly one transition was recorded");
  assert.equal(after.audit.length, 1, "exactly one audit row was written");
  assert.equal(after.guard, 0);

  // The loser left the winner's committed result alone.
  assert.notDeepEqual(after, before);
});

test("F-07 phase 2A D1: malformed input is refused before any SQL runs", { skip }, async () => {
  const cafeId = await fresh();
  const before = await snapshot(cafeId);

  for (const body of [
    { cafeId, oldMode: "local", newMode: "saml", generation: 0 },
    { cafeId, oldMode: "local", newMode: "WorkOS", generation: 0 },
    { cafeId: 0, oldMode: "local", newMode: "workos", generation: 0 },
    { cafeId, oldMode: "local", newMode: "workos", generation: -1 },
  ]) {
    const result = await transition(body);
    assert.equal(result.ok, false);
    assert.equal(result.validation, true, `expected validation refusal for ${JSON.stringify(body)}`);
    assert.equal(result.constraint, undefined);
  }

  assert.deepEqual(await snapshot(cafeId), before);
});
