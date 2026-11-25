// Recovery-code regeneration, exercised over HTTP against the disposable auth harness (port 8790).
//
// The endpoint replaces a credential's backup set, so every test here is about one of three things:
// the proof required to ask for a new set, the atomicity of the swap, or the promise that a refused
// or failed attempt changes nothing. Plaintext codes exist only in the successful response.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto, randomBytes } from "node:crypto";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";
import { base32Decode, hashRecoveryCode, hotp, stepFor, totp } from "../worker/totp.js";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };
const OWNER_PASSWORD = HARNESS_OWNER_PASSWORD;
const CODE_SHAPE = /^[A-Z0-9]{4}-[A-Z0-9]{4}$/;
const HASH_SHAPE = /^[0-9a-f]{64}$/;

let alive = false;
try {
  const probe = await fetch(`${AUTH}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not available at ${AUTH}`;

async function seed(extra = {}) {
  const res = await fetch(`${AUTH}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ serviceMode: "tables", ...extra }),
  });
  assert.equal(res.status, 200, `/seed answered ${res.status}`);
  const cafe = await res.json();
  await clearLimits(cafe.cafeId);
  return cafe;
}

async function clean(cafeId) {
  await fetch(`${AUTH}/clean`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId }),
  });
}

async function clearLimits(cafeId) {
  for (const prefix of [`login:${cafeId}:`, `totp:${cafeId}:`, `settings:${cafeId}:`]) {
    const listed = await fetch(`${AUTH}/rate-limit/keys`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ prefix }),
    });
    if (listed.status !== 200) continue;
    for (const key of (await listed.json()).keys || []) {
      await fetch(`${AUTH}/rate-row`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ key, clear: true }),
      });
    }
  }
}

function cookiesOf(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return (list[0] || res.headers.get("set-cookie") || "").split(";")[0];
}

async function login(slug, password = OWNER_PASSWORD) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password }),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, cookie: cookiesOf(res) };
}

async function csrfFor(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  const payload = await res.json().catch(() => ({}));
  return (payload && payload.csrfToken) || "";
}

function headersFor(cookie, token, extra = {}) {
  return { ...JSON_HEADERS, cookie, origin: AUTH, ...(token ? { "x-csrf-token": token } : {}), ...extra };
}

async function postJson(slug, path, cookie, token, body) {
  return fetch(`${AUTH}/api/cafes/${slug}/admin/${path}`, {
    method: "POST",
    headers: headersFor(cookie, token),
    body: JSON.stringify(body || {}),
  });
}

async function codeAt(secretB32, offsetMs = 0) {
  const secret = base32Decode(secretB32);
  assert.ok(secret, "the enrollment secret is valid base32");
  return (await totp(secret, { now: Date.now() + offsetMs })).code;
}

async function mfaState(slug) {
  const res = await fetch(`${AUTH}/mfa-state`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ slug }),
  });
  assert.equal(res.status, 200, `/mfa-state answered ${res.status}`);
  return res.json();
}

// A fresh code one step past the last one this café spent, which is always inside verifyTotp's ±1
// window because a test spends at most one step per café.
async function nextCode(slug, secretB32) {
  const state = await mfaState(slug);
  const lastUsed = state.totp && state.totp.lastUsedStep != null ? Number(state.totp.lastUsedStep) : -1;
  const current = Math.floor(Date.now() / 30_000);
  const step = Math.max(current, lastUsed + 1);
  assert.ok(step <= current + 1, "a test spends at most one TOTP step per café");
  return hotp(base32Decode(secretB32), step);
}

// Enrolls and confirms the factor, then mints a session through the harness so the test spends its one
// available TOTP step on the regeneration under test rather than on a sign-in.
async function enrolled() {
  const cafe = await seed();
  const first = await login(cafe.slug);
  assert.equal(first.status, 200, "the café starts on its seeded password");
  const token = await csrfFor(cafe.slug, first.cookie);

  const started = await postJson(cafe.slug, "mfa/enroll", first.cookie, token, {
    currentPassword: OWNER_PASSWORD,
  });
  assert.equal(started.status, 200, `enrollment answered ${started.status}`);
  const enrollment = await started.json();

  const confirmed = await postJson(cafe.slug, "mfa/confirm", first.cookie, token, {
    code: await codeAt(enrollment.secret),
  });
  assert.equal(confirmed.status, 200, `confirmation answered ${confirmed.status}`);
  const confirmation = await confirmed.json();

  const minted = await fetch(`${AUTH}/owner-session`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ slug: cafe.slug, sessionId: randomBytes(16).toString("hex") }),
  });
  assert.equal(minted.status, 200, "the harness minted an owner session");
  const { cookie } = await minted.json();
  const csrf = await csrfFor(cafe.slug, cookie);
  assert.ok(csrf, "the session has a CSRF token");

  return {
    cafe,
    cookie,
    csrf,
    secret: enrollment.secret,
    oldCodes: confirmation.recoveryCodes,
  };
}

// Completes a password sign-in with a recovery code, which is the behaviour regeneration must preserve
// for the new set and withdraw for the old one.
async function signInWithRecovery(slug, cafeId, code) {
  await clearLimits(cafeId);
  const gated = await login(slug);
  assert.equal(gated.status, 200, "the password is still accepted");
  assert.equal(gated.body.mfaRequired, true, "the second factor is still required");
  return fetch(`${AUTH}/api/cafes/${slug}/admin/login/totp`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ challenge: gated.body.challenge, code }),
  });
}

/* ------------------------------------------------- exactly ten new codes, hashes only */

test("regeneration issues exactly ten new codes and leaves only their hashes", { skip }, async () => {
  const setup = await enrolled();
  try {
    const before = await mfaState(setup.cafe.slug);
    assert.equal(setup.oldCodes.length, 10, "enrollment issued ten codes");
    assert.equal(before.codes.length, 10);

    const code = await nextCode(setup.cafe.slug, setup.secret);
    const res = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code,
    });
    assert.equal(res.status, 200, `regeneration answered ${res.status}`);
    const payload = await res.json();

    const codes = payload.recoveryCodes || [];
    assert.equal(codes.length, 10, "exactly ten new codes");
    assert.equal(new Set(codes).size, 10, "all ten are distinct");
    for (const value of codes) {
      assert.match(value, CODE_SHAPE, `unexpected code shape: ${value}`);
      assert.ok(!setup.oldCodes.includes(value), "no old code is reissued");
    }
    for (const value of setup.oldCodes) {
      assert.ok(!codes.includes(value), "the old set is fully replaced");
    }

    const after = await mfaState(setup.cafe.slug);
    assert.equal(after.codes.length, 10, "the café holds exactly ten codes");
    assert.equal(after.codes.filter((row) => row.used).length, 0, "all ten are unused");
    for (const row of after.codes) {
      assert.match(row.hash, HASH_SHAPE, "only a SHA-256 hash is stored");
    }

    // Each plaintext code really is the preimage of a stored hash, so nothing else was persisted.
    const stored = new Set(after.codes.map((row) => row.hash));
    for (const value of codes) {
      assert.ok(stored.has(await hashRecoveryCode(value)), "the stored hash matches the issued code");
    }

    assert.ok(
      after.events.some((event) => event.kind === "mfa_recovery_regenerated"),
      "the change is audited"
    );
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* ------------------------------------------------------------ the swap really swaps */

test("an old code stops working once the set is replaced", { skip }, async () => {
  const setup = await enrolled();
  try {
    const code = await nextCode(setup.cafe.slug, setup.secret);
    const res = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code,
    });
    assert.equal(res.status, 200);

    const stale = await signInWithRecovery(setup.cafe.slug, setup.cafe.cafeId, setup.oldCodes[0]);
    assert.equal(stale.status, 401, "a code from the previous set no longer signs in");
    assert.equal(cookiesOf(stale), "", "and it earns no session");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

test("every new code signs in exactly once", { skip }, async () => {
  const setup = await enrolled();
  try {
    const code = await nextCode(setup.cafe.slug, setup.secret);
    const res = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code,
    });
    assert.equal(res.status, 200);
    const fresh = (await res.json()).recoveryCodes;

    for (const value of fresh) {
      const accepted = await signInWithRecovery(setup.cafe.slug, setup.cafe.cafeId, value);
      assert.equal(accepted.status, 200, `code ${value} signs in once`);
      assert.ok(cookiesOf(accepted).startsWith("staff_session_"));
    }

    const reused = await signInWithRecovery(setup.cafe.slug, setup.cafe.cafeId, fresh[0]);
    assert.equal(reused.status, 401, "a code already spent is refused");
    assert.equal(cookiesOf(reused), "");

    const state = await mfaState(setup.cafe.slug);
    assert.equal(state.codes.filter((row) => row.used).length, 10, "all ten are now spent");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* ---------------------------------------------------- refusals change nothing at all */

test("a wrong password is refused and leaves the codes untouched", { skip }, async () => {
  const setup = await enrolled();
  try {
    const before = await mfaState(setup.cafe.slug);
    const res = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: "not-the-owner-password",
      code: await nextCode(setup.cafe.slug, setup.secret),
    });
    assert.equal(res.status, 401, `a wrong password answered ${res.status}`);
    const body = await res.json();
    assert.ok(!JSON.stringify(body).includes("not-the-owner-password"), "the password is not echoed");

    const after = await mfaState(setup.cafe.slug);
    assert.deepEqual(after.codes, before.codes, "no code was replaced or consumed");
    assert.equal(after.totp.lastUsedStep, before.totp.lastUsedStep, "the TOTP step was not spent");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

test("a wrong or replayed TOTP code is refused, masked and leaves the codes untouched", { skip }, async () => {
  const setup = await enrolled();
  try {
    const before = await mfaState(setup.cafe.slug);
    const far = await hotp(base32Decode(setup.secret), stepFor(Date.now()) + 10);

    const wrong = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code: far,
    });
    assert.equal(wrong.status, 401, `a wrong code answered ${wrong.status}`);
    const wrongMessage = (await wrong.json()).error;

    // The same café, a wrong password: the two refusals must be indistinguishable.
    const wrongPassword = await postJson(
      setup.cafe.slug,
      "mfa/recovery-regenerate",
      setup.cookie,
      setup.csrf,
      { currentPassword: "still-not-the-password", code: far }
    );
    assert.equal(wrongPassword.status, 401);
    assert.equal((await wrongPassword.json()).error, wrongMessage, "the reason for refusal is not disclosed");

    const after = await mfaState(setup.cafe.slug);
    assert.deepEqual(after.codes, before.codes, "a refused request changes no code");
    assert.equal(after.totp.lastUsedStep, before.totp.lastUsedStep, "and spends no TOTP step");

    // A successful regeneration, then the same authenticator code again: replayed.
    const firstCode = await nextCode(setup.cafe.slug, setup.secret);
    const accepted = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code: firstCode,
    });
    assert.equal(accepted.status, 200);
    const issued = await mfaState(setup.cafe.slug);

    const replay = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code: firstCode,
    });
    assert.ok(replay.status === 401 || replay.status === 409, `a replay answered ${replay.status}`);

    const settled = await mfaState(setup.cafe.slug);
    assert.deepEqual(settled.codes, issued.codes, "the replayed request replaced nothing");
    assert.equal(settled.totp.lastUsedStep, issued.totp.lastUsedStep, "and advanced no step");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

test("a recovery code cannot be used as the second factor for regeneration", { skip }, async () => {
  const setup = await enrolled();
  try {
    const before = await mfaState(setup.cafe.slug);
    const res = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code: setup.oldCodes[0],
    });
    assert.equal(res.status, 401, `a recovery code answered ${res.status}`);

    const after = await mfaState(setup.cafe.slug);
    assert.deepEqual(after.codes, before.codes, "the presented code was not consumed");
    assert.equal(after.codes.find((row) => row.used), undefined, "and no code was spent");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* ------------------------------------------------------------- CSRF and session proof */

test("missing or invalid CSRF is refused before any write", { skip }, async () => {
  const setup = await enrolled();
  try {
    const before = await mfaState(setup.cafe.slug);
    const code = await nextCode(setup.cafe.slug, setup.secret);

    for (const token of [null, "not-a-real-token"]) {
      const res = await postJson(
        setup.cafe.slug,
        "mfa/recovery-regenerate",
        setup.cookie,
        token,
        { currentPassword: OWNER_PASSWORD, code }
      );
      assert.equal(res.status, 403, `token ${String(token)} answered ${res.status}`);
    }

    const after = await mfaState(setup.cafe.slug);
    assert.deepEqual(after.codes, before.codes, "nothing was replaced");
    assert.equal(after.totp.lastUsedStep, before.totp.lastUsedStep, "and no step was spent");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

test("a missing or unknown owner session is refused", { skip }, async () => {
  const setup = await enrolled();
  try {
    const before = await mfaState(setup.cafe.slug);
    const code = await nextCode(setup.cafe.slug, setup.secret);

    const none = await fetch(`${AUTH}/api/cafes/${setup.cafe.slug}/admin/mfa/recovery-regenerate`, {
      method: "POST",
      headers: { ...JSON_HEADERS, origin: AUTH },
      body: JSON.stringify({ currentPassword: OWNER_PASSWORD, code }),
    });
    assert.equal(none.status, 401, `no session answered ${none.status}`);

    const bogus = await fetch(`${AUTH}/api/cafes/${setup.cafe.slug}/admin/mfa/recovery-regenerate`, {
      method: "POST",
      headers: headersFor("staff_session_bogus=not-a-token", setup.csrf),
      body: JSON.stringify({ currentPassword: OWNER_PASSWORD, code }),
    });
    assert.equal(bogus.status, 401, `an unknown session answered ${bogus.status}`);

    const after = await mfaState(setup.cafe.slug);
    assert.deepEqual(after.codes, before.codes, "no codes were replaced");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* --------------------------------------------------------------- atomicity and races */

test("a failed database replacement keeps the previous set valid", { skip }, async () => {
  const setup = await enrolled();
  try {
    const before = await mfaState(setup.cafe.slug);
    const code = await nextCode(setup.cafe.slug, setup.secret);

    const armed = await fetch(`${AUTH}/mfa-break`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({}),
    });
    assert.equal(armed.status, 200);

    const failed = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code,
    });
    assert.equal(failed.status, 503, `a broken replacement answered ${failed.status}`);
    const message = (await failed.json()).error;
    assert.ok(!Array.isArray(failed.recoveryCodes), "no code set is returned on failure");

    await fetch(`${AUTH}/mfa-break`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ off: true }),
    });

    const after = await mfaState(setup.cafe.slug);
    assert.deepEqual(after.codes, before.codes, "the rollback left every old hash in place");
    assert.equal(after.codes.length, 10, "the café was never left with zero codes");
    assert.equal(after.totp.lastUsedStep, before.totp.lastUsedStep, "the step update rolled back too");

    const stillWorks = await signInWithRecovery(setup.cafe.slug, setup.cafe.cafeId, setup.oldCodes[0]);
    assert.equal(stillWorks.status, 200, "an old code still signs in after the failed replacement");
    assert.ok(!String(message).toLowerCase().includes("undefined"), "the failure message is usable");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

test("concurrent regeneration cannot both spend the same TOTP step", { skip }, async () => {
  const setup = await enrolled();
  try {
    const before = await mfaState(setup.cafe.slug);
    const code = await nextCode(setup.cafe.slug, setup.secret);

    const send = () =>
      postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
        currentPassword: OWNER_PASSWORD,
        code,
      });
    const [first, second] = await Promise.all([send(), send()]);
    const statuses = [first.status, second.status];
    assert.equal(statuses.filter((status) => status === 200).length, 1, "exactly one attempt succeeds");
    assert.ok(
      statuses.every((status) => status === 200 || status === 401 || status === 409),
      `the loser is refused, not failed: ${statuses.join(", ")}`
    );

    // Neither a 401 nor a 409 may have written a set of its own, and the step moved exactly once.
    const state = await mfaState(setup.cafe.slug);
    assert.equal(state.codes.length, 10, "the winning attempt wrote exactly ten codes");
    assert.equal(state.codes.filter((row) => row.used).length, 0, "none of them is spent");
    assert.equal(
      Number(state.totp.lastUsedStep),
      Number(before.totp.lastUsedStep) + 1,
      "the TOTP step was spent exactly once"
    );
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* --------------------------------------------------------------- no plaintext anywhere */

test("plaintext codes never reach database rows or the audit log", { skip }, async () => {
  const setup = await enrolled();
  try {
    const code = await nextCode(setup.cafe.slug, setup.secret);
    const res = await postJson(setup.cafe.slug, "mfa/recovery-regenerate", setup.cookie, setup.csrf, {
      currentPassword: OWNER_PASSWORD,
      code,
    });
    assert.equal(res.status, 200);
    const issued = (await res.json()).recoveryCodes;

    const state = await mfaState(setup.cafe.slug);
    const everything = JSON.stringify(state);
    for (const value of issued) {
      assert.ok(!everything.includes(value), "no plaintext code is stored");
      assert.ok(!everything.includes(value.replace("-", "")), "not even without its dash");
    }
    for (const row of state.codes) {
      assert.match(row.hash, HASH_SHAPE, "every stored row is a hash");
    }
    for (const event of state.events) {
      assert.equal(event.detail, "", "the audit row carries no detail that could hold a code");
      for (const value of issued) assert.ok(!event.kind.includes(value));
    }

    // The response is the only place the plaintext appears: a second read of the café cannot recover it.
    const again = await mfaState(setup.cafe.slug);
    for (const value of issued) assert.ok(!JSON.stringify(again).includes(value));
  } finally {
    await clean(setup.cafe.cafeId);
  }
});
