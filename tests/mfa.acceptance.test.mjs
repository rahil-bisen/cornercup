// Additional HTTP acceptance coverage for the independent-MFA-key build.
//
// These complement tests/mfa.flows.test.mjs and tests/mfa.recovery-regenerate.test.mjs with the cases
// those files do not exercise: challenge expiry, a malformed challenge, a fresh TOTP step after a
// successful one, concurrent recovery-code claims, cross-café session rejection, removal revoking the
// session and its pending challenge, the TOTP lockout, and the flags on the session cookie issued
// through the second factor.
//
// Everything runs against the disposable auth harness (its own D1 state, test-only credentials). No
// production route, no pilot database and no manual browser environment is involved.

import test from "node:test";
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";
import { base32Decode, hotp, stepFor } from "../worker/totp.js";

if (!globalThis.crypto || !globalThis.crypto.subtle) globalThis.crypto = webcrypto;

const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const JSON_HEADERS = { "content-type": "application/json" };
const OWNER_PASSWORD = HARNESS_OWNER_PASSWORD;

let alive = false;
try {
  const probe = await fetch(`${AUTH}/api/health`);
  alive = probe.ok || probe.status === 503;
} catch {
  alive = false;
}
const skip = alive ? false : `auth harness not available at ${AUTH}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function seed() {
  const res = await fetch(`${AUTH}/seed`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ serviceMode: "tables" }),
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
  for (const prefix of [`login:${cafeId}:`, `totp:${cafeId}:`]) {
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

function rawSetCookie(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  return list[0] || res.headers.get("set-cookie") || "";
}

async function login(slug, password = OWNER_PASSWORD) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ password }),
  });
  return { status: res.status, body: await res.json().catch(() => ({})), cookie: cookiesOf(res) };
}

async function csrfFor(slug, cookie) {
  const res = await fetch(`${AUTH}/api/cafes/${slug}/admin/session`, { headers: { cookie } });
  return ((await res.json().catch(() => ({}))) || {}).csrfToken || "";
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

async function postTotp(slug, challenge, code) {
  return fetch(`${AUTH}/api/cafes/${slug}/admin/login/totp`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ challenge, code }),
  });
}

async function expireChallenges(cafeId) {
  const res = await fetch(`${AUTH}/totp-challenge/expire`, {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ cafeId }),
  });
  assert.equal(res.status, 200);
  return res.json();
}

// Enrolls a fresh café and returns the secret, the ten recovery codes and the step that confirmation
// spent. The secret stays in this process; nothing is printed.
async function enrolled() {
  const cafe = await seed();
  const first = await login(cafe.slug);
  assert.equal(first.status, 200);
  const token = await csrfFor(cafe.slug, first.cookie);

  const started = await postJson(cafe.slug, "mfa/enroll", first.cookie, token, {
    currentPassword: OWNER_PASSWORD,
  });
  assert.equal(started.status, 200);
  const enrollment = await started.json();
  const secret = base32Decode(enrollment.secret);
  const spentStep = stepFor(Date.now());

  const confirmed = await postJson(cafe.slug, "mfa/confirm", first.cookie, token, {
    code: await hotp(secret, spentStep),
  });
  assert.equal(confirmed.status, 200, `confirmation answered ${confirmed.status}`);
  const { recoveryCodes } = await confirmed.json();

  return { cafe, secret, recoveryCodes, spentStep };
}

/* ------------------------------------------------------------ challenge expiry and malformed tokens */

test("an expired challenge is refused before any code is accepted", { skip }, async () => {
  const setup = await enrolled();
  try {
    const gated = await login(setup.cafe.slug);
    assert.equal(gated.body.mfaRequired, true);
    assert.ok(gated.body.challenge);

    const expired = await expireChallenges(setup.cafe.cafeId);
    assert.ok(expired.expired >= 1, "the pending challenge was expired");

    const res = await postTotp(
      setup.cafe.slug,
      gated.body.challenge,
      await hotp(setup.secret, setup.spentStep + 1)
    );
    assert.equal(res.status, 401, "expired challenge");
    assert.equal(cookiesOf(res), "", "no session is issued");
    assert.match((await res.json()).error, /expired|start again/i);
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

test("a malformed or unknown challenge token is refused", { skip }, async () => {
  const setup = await enrolled();
  try {
    for (const challenge of ["not-a-real-challenge", "x".repeat(201), "<script>"]) {
      const res = await postTotp(setup.cafe.slug, challenge, await hotp(setup.secret, setup.spentStep + 1));
      assert.equal(res.status, 401, `challenge ${JSON.stringify(challenge.slice(0, 12))} is refused`);
      assert.equal(cookiesOf(res), "");
    }
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

test("a malformed current key fails closed at sign-in, and restoring it recovers", { skip }, async () => {
  const setup = await enrolled();
  try {
    const gated = await login(setup.cafe.slug);
    const code = await hotp(setup.secret, setup.spentStep + 1);

    const broken = await fetch(`${AUTH}/api/cafes/${setup.cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: { ...JSON_HEADERS, "x-harness-mfa-key": "malformed" },
      body: JSON.stringify({ challenge: gated.body.challenge, code }),
    });
    assert.equal(broken.status, 503, "a malformed key is a configuration fault, not a wrong code");
    assert.equal(cookiesOf(broken), "", "and issues no session");

    const restored = await fetch(`${AUTH}/api/cafes/${setup.cafe.slug}/admin/login/totp`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ challenge: gated.body.challenge, code }),
    });
    assert.equal(restored.status, 200, "the same challenge works once the key is restored");
    assert.ok(cookiesOf(restored).startsWith("staff_session_"));
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* --------------------------------------------------------------------------- fresh TOTP step */

test("a fresh TOTP step succeeds after an earlier step was spent", { skip }, async () => {
  const setup = await enrolled();
  try {
    const first = await login(setup.cafe.slug);
    const firstCode = await hotp(setup.secret, setup.spentStep + 1);
    const accepted = await postTotp(setup.cafe.slug, first.body.challenge, firstCode);
    assert.equal(accepted.status, 200, "the next step is accepted");
    assert.ok(cookiesOf(accepted).startsWith("staff_session_"));

    // Wait until the server clock reaches the step that was just spent, so the following step is
    // inside the ±1 window. Bounded by one 30-second period.
    while (stepFor(Date.now()) < setup.spentStep + 1) await sleep(250);

    await clearLimits(setup.cafe.cafeId);
    const second = await login(setup.cafe.slug);
    const nextCode = await hotp(setup.secret, setup.spentStep + 2);
    const nextAccepted = await postTotp(setup.cafe.slug, second.body.challenge, nextCode);
    assert.equal(nextAccepted.status, 200, "a genuinely new step is accepted after the previous one");
    assert.ok(cookiesOf(nextAccepted).startsWith("staff_session_"));
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* --------------------------------------------------------------- concurrent recovery-code claims */

test("two concurrent claims of the same recovery code cannot both succeed", { skip }, async () => {
  const setup = await enrolled();
  try {
    await clearLimits(setup.cafe.cafeId);
    const first = await login(setup.cafe.slug);
    const second = await login(setup.cafe.slug);
    assert.equal(first.body.mfaRequired, true);
    assert.equal(second.body.mfaRequired, true);

    const code = setup.recoveryCodes[0];
    const [a, b] = await Promise.all([
      postTotp(setup.cafe.slug, first.body.challenge, code),
      postTotp(setup.cafe.slug, second.body.challenge, code),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    assert.deepEqual(statuses, [200, 401], `exactly one claim wins (got ${statuses.join(", ")})`);

    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    assert.ok(cookiesOf(winner).startsWith("staff_session_"), "the winner gets a session");
    assert.equal(cookiesOf(loser), "", "the loser gets none");

    // And the code is spent for any later attempt too.
    await clearLimits(setup.cafe.cafeId);
    const third = await login(setup.cafe.slug);
    const reused = await postTotp(setup.cafe.slug, third.body.challenge, code);
    assert.equal(reused.status, 401, "the code cannot be claimed again");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* ------------------------------------------------------------------------- café scoping */

test("a session from one café cannot authenticate another café", { skip }, async () => {
  const one = await seed();
  const two = await seed();
  try {
    const signedIn = await login(one.slug);
    assert.equal(signedIn.status, 200);
    assert.ok(signedIn.cookie.startsWith("staff_session_"));

    const own = await fetch(`${AUTH}/api/cafes/${one.slug}/admin/session`, {
      headers: { cookie: signedIn.cookie },
    });
    assert.equal(own.status, 200, "the session works on its own café");

    const foreignCookie = signedIn.cookie.replace(`staff_session_${one.slug}`, `staff_session_${two.slug}`);
    const foreign = await fetch(`${AUTH}/api/cafes/${two.slug}/admin/session`, {
      headers: { cookie: foreignCookie },
    });
    assert.equal(foreign.status, 401, "a renamed cookie for another café is not a session");
  } finally {
    await clean(one.cafeId);
    await clean(two.cafeId);
  }
});

/* ------------------------------------------------------- setting changes revoke access */

test("disabling MFA invalidates live sessions and pending challenges", { skip }, async () => {
  const setup = await enrolled();
  try {
    await clearLimits(setup.cafe.cafeId);
    const gated = await login(setup.cafe.slug);
    const accepted = await postTotp(
      setup.cafe.slug,
      gated.body.challenge,
      await hotp(setup.secret, setup.spentStep + 1)
    );
    assert.equal(accepted.status, 200);
    const cookie = cookiesOf(accepted);

    // A second sign-in is left pending when the factor is removed.
    const pending = await login(setup.cafe.slug);
    assert.equal(pending.body.mfaRequired, true);

    const token = await csrfFor(setup.cafe.slug, cookie);
    const disabled = await postJson(setup.cafe.slug, "mfa/disable", cookie, token, {
      currentPassword: OWNER_PASSWORD,
      code: setup.recoveryCodes[0],
    });
    assert.equal(disabled.status, 200);

    const session = await fetch(`${AUTH}/api/cafes/${setup.cafe.slug}/admin/session`, {
      headers: { cookie },
    });
    assert.equal(session.status, 401, "the session that removed the factor is revoked");

    // An unused recovery code would complete sign-in if the pending challenge still existed.
    const stale = await postTotp(setup.cafe.slug, pending.body.challenge, setup.recoveryCodes[1]);
    assert.equal(stale.status, 401, "the pending challenge was deleted with the factor");
    assert.equal(cookiesOf(stale), "");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* ------------------------------------------------------------------------- TOTP lockout */

test("five wrong TOTP codes lock the code prompt without issuing a session", { skip }, async () => {
  const setup = await enrolled();
  try {
    await clearLimits(setup.cafe.cafeId);
    const gated = await login(setup.cafe.slug);
    const wrong = await hotp(setup.secret, setup.spentStep + 10);

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const res = await postTotp(setup.cafe.slug, gated.body.challenge, wrong);
      assert.equal(res.status, 401, `attempt ${attempt} is refused`);
      assert.equal(cookiesOf(res), "");
    }

    const locked = await postTotp(
      setup.cafe.slug,
      gated.body.challenge,
      await hotp(setup.secret, setup.spentStep + 1)
    );
    assert.equal(locked.status, 429, "the sixth attempt is rate-limited");
    assert.equal(cookiesOf(locked), "", "and still issues no session");
  } finally {
    await clean(setup.cafe.cafeId);
  }
});

/* ------------------------------------------------------------------------- cookie flags */

test("the session cookie issued through the second factor keeps its security flags", { skip }, async () => {
  const setup = await enrolled();
  try {
    const gated = await login(setup.cafe.slug);
    const accepted = await postTotp(
      setup.cafe.slug,
      gated.body.challenge,
      await hotp(setup.secret, setup.spentStep + 1)
    );
    assert.equal(accepted.status, 200);
    const cookie = rawSetCookie(accepted);
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Domain=/i);
    // Loopback runs over http, so `Secure` must be absent here; it is added when the request is https.
    assert.doesNotMatch(cookie, /;\s*Secure/i);
  } finally {
    await clean(setup.cafe.cafeId);
  }
});
