import { readFileSync, writeFileSync } from "node:fs";

const PATH = "worker/api.js";
let api = readFileSync(PATH, "utf8");

const HEAD = "async function logoutEverywhere(request, env, cafe) {";
const START = api.indexOf(HEAD);
if (START < 0) throw new Error("logoutEverywhere not found");
const END_ANCHOR = "\n// Takings follow the café's clock";
const END = api.indexOf(END_ANCHOR, START);
if (END < 0) throw new Error("logoutEverywhere end anchor not found");

const replacement = `async function logoutEverywhere(request, env, cafe) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }

  const version = currentAuthVersion(cafe);
  if (version === null) {
    console.error("Refusing sign-out-everywhere: stored auth_version is invalid", { cafeId: cafe.id });
    return json({ error: "This café's sign-in isn't available right now. Please ask the operator." }, 503);
  }

  const token = readCookie(request, cookieName(cafe));
  const claims = await tokenClaims(env, token);
  const acting = claims ? parseOwnerSubject(claims.subject) : null;
  const actingSessionId = acting && acting.owner === \`cafe:\${cafe.id}\` ? acting.sessionId : null;

  // This browser keeps working, so its provider session must survive the sweep. That needs two
  // exclusions, not one: the local row is replaced by a new session id, and the provider session it
  // came from is shared by every local row minted from the same WorkOS sign-in. Revoking that
  // provider session would end the very browser that asked for this.
  let actingProviderSid = null;
  if (actingSessionId) {
    const row = await env.DB.prepare(
      "SELECT workos_session_id FROM owner_sessions WHERE session_id = ? AND cafe_id = ?"
    )
      .bind(actingSessionId, cafe.id)
      .first();
    actingProviderSid = row && row.workos_session_id ? row.workos_session_id : null;
  }

  const sessionId = ownerSessionId();
  const now = Date.now();
  const witness = newCasToken();
  const actingCsrfKey = await sha256Hex(actingSessionId || "");

  // One transaction, in an order that matters: the provider jobs are queued while the rows they name
  // still exist, the replacement is inserted before it is referenced, and the CAS is followed by a
  // CHECK-guarded witness so a lost race rolls the whole batch back instead of leaving partial state.
  try {
    await env.DB.batch([
      queueProviderRevocationsStatement(env, {
        cafeId: cafe.id,
        now,
        excludeSessionId: actingSessionId,
        excludeProviderSid: actingProviderSid,
      }),
      env.DB.prepare(
        "INSERT INTO owner_sessions (session_id, cafe_id, created, expires, workos_user_id, workos_session_id) " +
          "SELECT ?, ?, ?, ?, workos_user_id, workos_session_id FROM owner_sessions " +
          "WHERE session_id = ? AND cafe_id = ?"
      ).bind(sessionId, cafe.id, now, now + SESSION_MAX_AGE * 1000, actingSessionId, cafe.id),
      env.DB.prepare(
        "INSERT INTO tx_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM owner_sessions WHERE session_id = ?)"
      ).bind(sessionId),
      env.DB.prepare(
        "UPDATE cafes SET auth_version = auth_version + 1, auth_version_cas_token = ? WHERE id = ? AND auth_version = ?"
      ).bind(witness, cafe.id, version),
      env.DB.prepare(
        "INSERT INTO tx_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM cafes WHERE id = ? AND auth_version_cas_token = ?)"
      ).bind(cafe.id, witness),
      env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ? AND session_id != ?").bind(cafe.id, sessionId),
      env.DB.prepare("DELETE FROM csrf_tokens WHERE operator_key_hash = ?").bind(actingCsrfKey),
      env.DB.prepare("UPDATE cafes SET auth_version_cas_token = NULL WHERE id = ? AND auth_version_cas_token = ?").bind(
        cafe.id,
        witness
      ),
      env.DB.prepare("DELETE FROM tx_guard"),
    ]);
  } catch (err) {
    if (isAuthModeTransitionConflict(err)) {
      return json({ error: "This café's sign-in changed while you were working. Reload and try again." }, 409);
    }
    console.error("Sign-out-everywhere failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "We couldn't sign the other devices out. Nothing was changed." }, 500);
  }

  // The revocation jobs are already durable; the provider calls are best effort and never gate the
  // response.
  void drainProviderRevocations(env, { limit: 2 }).catch(() => {});

  const updated = await findCafeBySlug(env, cafe.slug);
  const nextVersion = currentAuthVersion(updated);
  if (nextVersion === null) {
    // The bump landed, so every other token is dead; only the replacement is unavailable.
    console.error("Signed out everywhere but auth_version is invalid; not reissuing a session", { cafeId: cafe.id });
    return json({ ok: true });
  }

  return json({ ok: true, expiresIn: SESSION_MAX_AGE }, 200, {
    "set-cookie": sessionCookie(
      request,
      await issueToken(env, ownerSubject(updated, nextVersion, sessionId)),
      SESSION_MAX_AGE,
      cookieName(updated)
    ),
  });
}

`;

api = api.slice(0, START) + replacement + api.slice(END + 1);

const tail = `
/* ------------------------------------------------- operator: owners and mode */

// The mode switch composes around the frozen nine statements. Nothing in worker/authmode.js changes:
// the array is rebuilt with one extra INSERT spliced in before the session delete, so the provider
// jobs are written in the same transaction that invalidates those sessions.
async function operatorAuthMode(request, env, rawSlug) {
  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);

  const cafe = await findCafeBySlug(env, String(rawSlug || "").toLowerCase());
  if (!cafe) return json({ error: "No cafe found at that web address." }, 404);

  const body = (await readJson(request, BODY_LIMITS.operatorReset)) || {};
  const newMode = String(body.mode || "");
  const oldMode = cafe.owner_auth === "workos" ? "workos" : "local";
  if (newMode !== "local" && newMode !== "workos") return json({ error: "Mode must be local or workos." }, 400);

  const operatorClaims = await tokenClaims(env, readCookie(request, OPERATOR_COOKIE));
  const operatorId = operatorClaims ? operatorSessionIdFromSubject(operatorClaims.subject) : null;
  if (!operatorId) return json({ error: "Sign in to the operator console." }, 401);

  let plan;
  try {
    plan = authModeTransition({
      cafeId: cafe.id,
      oldMode,
      newMode,
      generation: Number(cafe.auth_mode_generation) || 0,
      operatorSubject: operatorSubject(operatorId),
    });
  } catch (err) {
    return json({ error: "That mode change couldn't be prepared." }, 400);
  }

  const steps = plan.steps;
  const sessionsAt = steps.findIndex((step) => step.step === "sessions");
  if (sessionsAt !== 5) {
    console.error("Unexpected phase 2A step order", { step: steps[sessionsAt] && steps[sessionsAt].step });
    return json({ error: "The mode change is unavailable right now." }, 500);
  }

  const composed = [
    ...steps.slice(0, sessionsAt),
    { sql: "queue" },
    ...steps.slice(sessionsAt),
  ];
  const statements = composed.map((step) =>
    step.sql === "queue" ? queueProviderRevocationsStatement(env, { cafeId: cafe.id, now: plan.now }) : env.DB.prepare(step.sql).bind(...step.params)
  );

  try {
    await env.DB.batch(statements);
  } catch (err) {
    if (isAuthModeTransitionConflict(err)) {
      return json({ error: "This café's sign-in changed while you were working. Reload and try again." }, 409);
    }
    console.error("Auth mode transition failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "We couldn't change the sign-in mode. Nothing was changed." }, 500);
  }

  void drainProviderRevocations(env, { limit: 3 }).catch(() => {});
  return json({ ok: true, mode: newMode, generation: plan.nextGeneration });
}

// Operator-visible ownership. Email comes from the identity cache, which is populated only by an
// authorized sign-in, so it is always an address that actually authenticated for that identity.
async function operatorOwners(env, rawSlug) {
  const cafe = await findCafeBySlug(env, String(rawSlug || "").toLowerCase());
  if (!cafe) return json({ error: "No cafe found at that web address." }, 404);
  const { results } = await env.DB.prepare(
    "SELECT o.workos_user_id, o.role, o.created, COALESCE(i.email, '') AS email " +
      "FROM cafe_owners o LEFT JOIN owner_identities i ON i.workos_user_id = o.workos_user_id " +
      "WHERE o.cafe_id = ? ORDER BY o.created ASC"
  )
    .bind(cafe.id)
    .all();
  return json({
    mode: cafe.owner_auth === "workos" ? "workos" : "local",
    generation: Number(cafe.auth_mode_generation) || 0,
    owners: (results || []).map((row) => ({
      workosUserId: row.workos_user_id,
      email: row.email,
      role: row.role,
      addedAt: row.created,
    })),
  });
}

async function operatorGrantOwner(request, env, rawSlug) {
  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);
  const cafe = await findCafeBySlug(env, String(rawSlug || "").toLowerCase());
  if (!cafe) return json({ error: "No cafe found at that web address." }, 404);

  const body = (await readJson(request, BODY_LIMITS.operatorReset)) || {};
  const workosUserId = String(body.workosUserId || "").trim();
  if (!/^user_[A-Za-z0-9]{1,128}$/.test(workosUserId)) {
    return json({ error: "That doesn't look like a WorkOS user id." }, 400);
  }
  if (body.role !== undefined && String(body.role) !== "owner") {
    return json({ error: "Only the owner role is supported." }, 400);
  }

  await env.DB.prepare(
    "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) VALUES (?, ?, 'owner', ?) " +
      "ON CONFLICT(cafe_id, workos_user_id) DO NOTHING"
  )
    .bind(cafe.id, workosUserId, Date.now())
    .run();
  await env.DB.prepare(
    "INSERT INTO operator_audit (cafe_id, action, subject, detail, created) VALUES (?, 'grant_owner', ?, ?, ?)"
  )
    .bind(cafe.id, workosUserId, "role=owner", Date.now())
    .run();

  return json({ ok: true }, 201);
}

async function operatorRevokeOwner(request, env, rawSlug, workosUserId) {
  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);
  const cafe = await findCafeBySlug(env, String(rawSlug || "").toLowerCase());
  if (!cafe) return json({ error: "No cafe found at that web address." }, 404);

  const result = await env.DB.prepare("DELETE FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?")
    .bind(cafe.id, String(workosUserId || ""))
    .run();
  if (Number(result && result.meta && result.meta.changes) !== 1) {
    return json({ error: "That identity doesn't own this café." }, 404);
  }
  await env.DB.prepare(
    "INSERT INTO operator_audit (cafe_id, action, subject, detail, created) VALUES (?, 'revoke_owner', ?, '', ?)"
  )
    .bind(cafe.id, String(workosUserId || ""), Date.now())
    .run();
  return json({ ok: true });
}

// A claim is a one-time code for one café and, when an address is given, one email. Only its digest is
// stored, so the code shown here once is the only copy that exists.
async function operatorCreateClaim(request, env, rawSlug) {
  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);
  const cafe = await findCafeBySlug(env, String(rawSlug || "").toLowerCase());
  if (!cafe) return json({ error: "No cafe found at that web address." }, 404);

  const body = (await readJson(request, BODY_LIMITS.operatorReset)) || {};
  const email = String(body.email || "").trim().toLowerCase();
  if (email && !/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) {
    return json({ error: "That email address doesn't look right." }, 400);
  }
  const ttlMinutes = Number(body.ttlMinutes);
  const ttl = Number.isFinite(ttlMinutes) ? Math.min(7 * 24 * 60, Math.max(5, Math.round(ttlMinutes))) : 24 * 60;

  const code = randomToken(24);
  const now = Date.now();
  const expires = now + ttl * 60 * 1000;
  await env.DB.prepare(
    "INSERT INTO owner_claims (claim_hash, cafe_id, email, role, issued_by, created, expires) VALUES (?, ?, ?, 'owner', 'operator', ?, ?)"
  )
    .bind(await claimDigest(code), cafe.id, email, now, expires)
    .run();

  return json({ ok: true, code, expires, email }, 201);
}

async function operatorClaims(env, rawSlug) {
  const cafe = await findCafeBySlug(env, String(rawSlug || "").toLowerCase());
  if (!cafe) return json({ error: "No cafe found at that web address." }, 404);
  const { results } = await env.DB.prepare(
    "SELECT claim_hash, email, role, created, expires, used_at FROM owner_claims " +
      "WHERE cafe_id = ? AND expires > ? AND used_at IS NULL ORDER BY created ASC"
  )
    .bind(cafe.id, Date.now())
    .all();
  return json({
    claims: (results || []).map((row) => ({
      id: String(row.claim_hash).slice(0, 12),
      email: row.email,
      role: row.role,
      createdAt: row.created,
      expires: row.expires,
    })),
  });
}

async function operatorRevokeClaim(request, env, rawSlug, id) {
  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);
  const cafe = await findCafeBySlug(env, String(rawSlug || "").toLowerCase());
  if (!cafe) return json({ error: "No cafe found at that web address." }, 404);

  // Revocation is by the short id shown in the list, which is a prefix of the stored digest.
  const result = await env.DB.prepare(
    "DELETE FROM owner_claims WHERE cafe_id = ? AND claim_hash LIKE ? AND used_at IS NULL"
  )
    .bind(cafe.id, String(id || "").replace(/[^0-9a-f]/g, "") + "%")
    .run();
  if (Number(result && result.meta && result.meta.changes) !== 1) {
    return json({ error: "That invite is not valid for this café." }, 404);
  }
  return json({ ok: true });
}
`;

api = api.trimEnd() + "\n" + tail;
writeFileSync(PATH, api);
console.log("api.js lines:", api.split("\n").length);
