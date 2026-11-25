// F-07 phase 2B. Managed owner sign-in, the callback, claims and coordinated sign-out.
//
// The shape of this module follows one rule: D1 decides who may open a café. The provider says who a
// person is; `cafe_owners` says which café that person may open. Every session-writing statement
// carries its own `EXISTS` clause on that table, so authentication alone can never mint a session —
// there is no JavaScript branch that could be talked out of the check.
//
// Failure paths are deliberately uniform: a bad state, a bad token, an unverified email, no
// membership and a failed claim all produce the same generic message and no session. The single
// write a failed callback may perform is burning the matching login state.
import { json, readJson, BODY_LIMITS } from "./http.js";
import {
  SESSION_MAX_AGE,
  cookieName,
  sessionCookie,
  ownerSubject,
  ownerSessionId,
  createOwnerSession,
  currentAuthVersion,
  parseOwnerSubject,
  tokenClaims,
  readCookie,
  verifyCsrf,
  sha256Hex,
  issueToken,
} from "./session.js";
import { claimDigest, decryptState, encryptState, newPkce, randomToken } from "./pkce.js";
import {
  WorkosError,
  authorizeUrl,
  exchangeCode,
  fetchJwks,
  missingConfig,
} from "./workos.js";
import { verifyToken } from "./jwt.js";
import { drainProviderRevocations, queueProviderRevocationsStatement } from "./revocations.js";
import { findCafeById } from "./cafes.js";

const STATE_TTL_MS = 10 * 60 * 1000;
const SIGNIN_WINDOW_MS = 60 * 60 * 1000;
const SIGNIN_MAX = 20;
const CLAIM_WINDOW_MS = 10 * 60 * 1000;
const CLAIM_MAX = 10;

const GENERIC_DENIED = "You can't open this café with that account.";

function redirect(location, headers = {}) {
  return new Response(null, {
    status: 303,
    headers: { location, "cache-control": "no-store", "referrer-policy": "no-referrer", ...headers },
  });
}

function page(message, status) {
  return json({ error: message }, status, { "referrer-policy": "no-referrer" });
}

function clientIp(request) {
  const cf = String(request.headers.get("cf-connecting-ip") || "").trim();
  if (cf) return cf;
  const forwarded = String(request.headers.get("x-forwarded-for") || "").trim();
  if (forwarded) return forwarded.split(",")[0].trim();
  return "local";
}

// Token-bucket style window on the existing rate_limits table. Returns false when the caller must be
// refused. A store failure fails open for sign-in initiation only (nothing is authenticated yet) and
// is logged without any value from the request.
async function allow(env, request, scope, limit, windowMs) {
  try {
    const key = `${scope}:${await sha256Hex(clientIp(request))}`;
    const now = Date.now();
    const row = await env.DB.prepare(
      "INSERT INTO rate_limits (key, count, window_start, expires, updated_at) VALUES (?, 1, ?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET " +
        "count = CASE WHEN rate_limits.expires <= ? THEN 1 ELSE rate_limits.count + 1 END, " +
        "window_start = CASE WHEN rate_limits.expires <= ? THEN ? ELSE rate_limits.window_start END, " +
        "expires = CASE WHEN rate_limits.expires <= ? THEN ? ELSE rate_limits.expires END, " +
        "updated_at = ? RETURNING count"
    )
      .bind(key, now, now + windowMs, now, now, now, now, now + windowMs, now)
      .first();
    return !row || Number(row.count) <= limit;
  } catch (err) {
    console.error("Sign-in rate limit check failed", {
      scope,
      error: err && err.message ? err.message : String(err),
    });
    return true;
  }
}

function managedOnly(cafe) {
  return cafe && cafe.owner_auth === "workos";
}

// ---------------------------------------------------------------- login start

export async function ownerStart(request, env, cafe) {
  if (!managedOnly(cafe)) return json({ error: "This café uses a password.", code: "auth_mode_local" }, 409);
  if (!(await allow(env, request, `ownerstart:${cafe.id}`, SIGNIN_MAX, SIGNIN_WINDOW_MS))) {
    return json({ error: "Too many sign-in attempts. Please wait a few minutes." }, 429);
  }

  const missing = missingConfig(env);
  if (missing.length > 0) {
    console.error("Managed sign-in is not configured", { cafeId: cafe.id, missing: missing.join(",") });
    return json({ error: "Owner sign-in isn't configured on this deployment." }, 503);
  }

  const { verifier, challenge } = await newPkce();
  const state = randomToken(32);
  const now = Date.now();

  let encrypted;
  try {
    encrypted = await encryptState(env, verifier);
  } catch (err) {
    console.error("Sign-in state encryption failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Owner sign-in isn't available right now." }, 503);
  }

  try {
    await env.DB.prepare(
      "INSERT INTO owner_login_states " +
        "(nonce_hash, cafe_id, created, expires, used_at, code_verifier_enc, claim_hash, return_to) " +
        "VALUES (?, ?, ?, ?, NULL, ?, NULL, NULL)"
    )
      .bind(await sha256Hex(state), cafe.id, now, now + STATE_TTL_MS, encrypted)
      .run();
    // Opportunistic pruning, scoped so no other tenant's in-flight sign-in is touched.
    await env.DB.prepare(
      "DELETE FROM owner_login_states WHERE cafe_id = ? AND expires <= ?"
    )
      .bind(cafe.id, now)
      .run();
  } catch (err) {
    console.error("Sign-in state write failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Owner sign-in isn't available right now." }, 503);
  }

  return new Response(null, {
    status: 302,
    headers: {
      location: authorizeUrl(env, { state, challenge }),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
}

// ---------------------------------------------------------------- claim start

export async function ownerClaimStart(request, env, cafe) {
  if (!managedOnly(cafe)) return json({ error: "This café uses a password.", code: "auth_mode_local" }, 409);
  if (!(await allow(env, request, `ownerclaim:${cafe.id}`, CLAIM_MAX, CLAIM_WINDOW_MS))) {
    return json({ error: "Too many attempts. Please wait a few minutes." }, 429);
  }
  if (missingConfig(env).length > 0) {
    return json({ error: "Owner sign-in isn't configured on this deployment." }, 503);
  }

  const body = (await readJson(request, BODY_LIMITS.ownerClaim)) || {};
  const code = String(body.code || "").trim();
  if (!code || code.length > 200) return json({ error: "Enter the invite code from your operator." }, 400);

  const digest = await claimDigest(code);
  const claim = await env.DB.prepare(
    "SELECT claim_hash FROM owner_claims WHERE claim_hash = ? AND cafe_id = ? AND used_at IS NULL AND expires > ?"
  )
    .bind(digest, cafe.id, Date.now())
    .first();
  // One message for "no such code", "wrong café" and "already used": the code is a bearer secret and
  // probing it must not be a way to learn which of those is true.
  if (!claim) return json({ error: "That invite code isn't valid for this café." }, 404);

  const { verifier, challenge } = await newPkce();
  const state = randomToken(32);
  const now = Date.now();

  let encrypted;
  try {
    encrypted = await encryptState(env, verifier);
  } catch {
    return json({ error: "Owner sign-in isn't available right now." }, 503);
  }

  try {
    await env.DB.prepare(
      "INSERT INTO owner_login_states " +
        "(nonce_hash, cafe_id, created, expires, used_at, code_verifier_enc, claim_hash, return_to) " +
        "VALUES (?, ?, ?, ?, NULL, ?, ?, ?)"
    )
      .bind(await sha256Hex(state), cafe.id, now, now + STATE_TTL_MS, encrypted, digest, null)
      .run();
  } catch (err) {
    console.error("Claim state write failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Owner sign-in isn't available right now." }, 503);
  }

  // The invite flow is started from the board with fetch, which cannot follow a cross-origin
  // redirect, so the authorization URL is handed back for a top-level navigation instead. It carries
  // only the public client id, a fresh state and the PKCE challenge.
  return json({ ok: true, authorizeUrl: authorizeUrl(env, { state, challenge }) }, 200, {
    "referrer-policy": "no-referrer",
  });
}

// ---------------------------------------------------------------- callback

// Consumes the state row exactly once. Returns the row's payload, or null when there is nothing live
// to consume. This is the only write a failed callback may perform.
async function burnState(env, state, now) {
  if (!state || typeof state !== "string" || state.length > 200) return null;
  const digest = await sha256Hex(state);
  const row = await env.DB.prepare(
    "UPDATE owner_login_states SET used_at = ? WHERE nonce_hash = ? AND used_at IS NULL AND expires > ? " +
      "RETURNING cafe_id, code_verifier_enc, claim_hash"
  )
    .bind(now, digest, now)
    .first();
  return row || null;
}

// Consumes without requiring a live row: a cancel still burns whatever matched.
async function burnAnyState(env, state, now) {
  if (!state || typeof state !== "string" || state.length > 200) return false;
  try {
    const result = await env.DB.prepare(
      "UPDATE owner_login_states SET used_at = ? WHERE nonce_hash = ? AND used_at IS NULL AND expires > ?"
    )
      .bind(now, await sha256Hex(state), now)
      .run();
    return Number(result && result.meta && result.meta.changes) === 1;
  } catch {
    return false;
  }
}

export async function ownerCallback(request, env, url) {
  const params = url.searchParams;
  const state = params.get("state") || "";
  const code = params.get("code") || "";
  const providerError = params.get("error") || "";
  const now = Date.now();

  if (missingConfig(env).length > 0) {
    return page("Owner sign-in isn't configured on this deployment.", 503);
  }

  // Cancellation and provider-side errors: burn the state so the link cannot be replayed, exchange
  // nothing, create nothing. No provider error text is echoed back.
  if (providerError || !code) {
    await burnAnyState(env, state, now);
    return page("Sign-in was cancelled. You can try again from the café's board.", 400);
  }

  let stateRow;
  try {
    stateRow = await burnState(env, state, now);
  } catch (err) {
    console.error("Sign-in state consumption failed", {
      error: err && err.message ? err.message : String(err),
    });
    return page("Sign-in isn't available right now. Please try again.", 503);
  }
  if (!stateRow) return page("That sign-in link has expired. Please start again.", 400);

  const cafe = await findCafeById(env, Number(stateRow.cafe_id));
  if (!cafe) return page("That sign-in link is no longer valid.", 400);
  // The café may have been switched back to password sign-in while this link was in flight.
  if (!managedOnly(cafe)) return page("This café has changed its sign-in method. Please reload the board.", 409);

  const verifier = await decryptState(env, stateRow.code_verifier_enc);
  if (!verifier) {
    console.error("Sign-in state could not be decrypted", { cafeId: cafe.id });
    return page("Sign-in failed. Please start again.", 400);
  }

  let exchanged;
  try {
    exchanged = await exchangeCode(env, { code, verifier });
  } catch (err) {
    // A failed exchange is terminal for this state: restarting mints a new one.
    console.error("Authorization code exchange failed", {
      cafeId: cafe.id,
      status: err instanceof WorkosError ? err.status : 0,
    });
    return page("Sign-in failed. Please start again.", 502);
  }

  const { user, accessToken } = exchanged;
  if (!user.emailVerified) {
    // The provider is authoritative about its own verification flag; an unverified address cannot
    // redeem a claim and is not allowed to open a managed café.
    return page(GENERIC_DENIED, 403);
  }

  let verified;
  try {
    verified = await verifyToken(accessToken, {
      jwks: await fetchJwks(env),
      refetch: () => fetchJwks(env, { force: true }),
      issuer: (env.WORKOS_ISSUER || "").trim(),
      audience: (env.WORKOS_AUDIENCE || env.WORKOS_CLIENT_ID || "").trim(),
      now,
      expectedSubject: user.id,
    });
  } catch (err) {
    console.error("Token verification failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return page("Sign-in failed. Please start again.", 502);
  }
  if (!verified.ok) {
    console.error("Token rejected", { cafeId: cafe.id, reason: verified.reason });
    return page("Sign-in failed. Please start again.", 401);
  }

  const workosSessionId = verified.sessionId; // null when absent or malformed; never fabricated
  const claimHash = stateRow.claim_hash || null;

  // Claim path: the email must match before anything is consumed. A mismatch leaves the claim usable
  // by the person it was issued to, which is the whole point of not consuming it here.
  if (claimHash) {
    const claim = await env.DB.prepare(
      "SELECT email FROM owner_claims WHERE claim_hash = ? AND cafe_id = ? AND used_at IS NULL AND expires > ?"
    )
      .bind(claimHash, cafe.id, now)
      .first();
    if (!claim) return page("That invite is no longer valid. Ask your operator for a new one.", 403);
    const claimed = String(claim.email || "").trim().toLowerCase();
    if (!claimed || claimed !== String(user.email || "").trim().toLowerCase()) {
      return page(GENERIC_DENIED, 403);
    }
  }

  const membership = await env.DB.prepare(
    "SELECT role FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?"
  )
    .bind(cafe.id, user.id)
    .first();
  if (!membership && !claimHash) return page(GENERIC_DENIED, 403);

  const version = currentAuthVersion(cafe);
  if (version === null) {
    console.error("Refusing a managed session: stored auth_version is invalid", { cafeId: cafe.id });
    return page("This café's sign-in isn't available right now.", 503);
  }

  const sessionId = ownerSessionId();
  const expires = now + SESSION_MAX_AGE * 1000;
  const redeemToken = randomToken(16);

  const sessionInsert = env.DB.prepare(
    "INSERT INTO owner_sessions (session_id, cafe_id, created, expires, workos_user_id, workos_session_id) " +
      "SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS " +
      "(SELECT 1 FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?)"
  ).bind(sessionId, cafe.id, now, expires, user.id, workosSessionId, cafe.id, user.id);

  const identityUpsert = env.DB.prepare(
    "INSERT INTO owner_identities (workos_user_id, email, created, last_seen) " +
      "SELECT ?, ?, ?, ? WHERE EXISTS " +
      "(SELECT 1 FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?) " +
      "ON CONFLICT(workos_user_id) DO UPDATE SET email = excluded.email, last_seen = excluded.last_seen"
  ).bind(user.id, user.email, now, now, cafe.id, user.id);

  let results;
  try {
    if (claimHash) {
      // One transaction: consume the claim for this attempt, grant membership, record it, then create
      // the identity and the session. A failure anywhere rolls the whole thing back, so no half-claim
      // survives and a replay consumes nothing.
      results = await env.DB.batch([
        env.DB.prepare(
          "UPDATE owner_claims SET used_at = ?, redeem_token = ? " +
            "WHERE claim_hash = ? AND cafe_id = ? AND used_at IS NULL AND expires > ?"
        ).bind(now, redeemToken, claimHash, cafe.id, now),
        env.DB.prepare(
          "INSERT INTO cafe_owners (cafe_id, workos_user_id, role, created) " +
            "SELECT ?, ?, role, ? FROM owner_claims WHERE claim_hash = ? AND redeem_token = ?"
        ).bind(cafe.id, user.id, now, claimHash, redeemToken),
        env.DB.prepare(
          "INSERT INTO operator_audit (cafe_id, action, subject, detail, created) " +
            "SELECT ?, 'claim_redeemed', ?, ?, ? WHERE EXISTS " +
            "(SELECT 1 FROM owner_claims WHERE claim_hash = ? AND redeem_token = ?)"
        ).bind(cafe.id, user.id, claimHash.slice(0, 8), now, claimHash, redeemToken),
        identityUpsert,
        sessionInsert,
      ]);
    } else {
      results = await env.DB.batch([identityUpsert, sessionInsert]);
    }
  } catch (err) {
    console.error("Managed session creation failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return page("Sign-in isn't available right now. Please try again.", 503);
  }

  const created = results && results[results.length - 1];
  if (Number(created && created.meta && created.meta.changes) !== 1) {
    // No membership row (or the claim lost a race). Nothing was granted: the batch rolled back.
    return page(GENERIC_DENIED, 403);
  }

  try {
    await env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ? AND expires <= ?").bind(cafe.id, now).run();
  } catch {
    // Pruning is housekeeping; the session above is already committed.
  }
  void drainProviderRevocations(env, { limit: 1 }).catch(() => {});

  return redirect(`/c/${cafe.slug}/owner`, {
    "set-cookie": sessionCookie(
      request,
      await issueToken(env, ownerSubject(cafe, version, sessionId)),
      SESSION_MAX_AGE,
      cookieName(cafe)
    ),
  });
}

// ---------------------------------------------------------------- logout

// Sign-out for one browser. The local row is deleted in the same batch that queues the provider job, so
// a crash can never leave a session invalidated with no record of the provider session behind it. The
// provider call itself happens after the commit and never gates the cookie being cleared.
//
// Owner CSRF rows are keyed by sha256(session id); older rows were keyed by sha256(cookie). Both are
// deleted, because leaving the second behind is one stale row per sign-out.
// Returns the statement itself: an async wrapper here would put a Promise into the batch array.
function queueOne(env, { cafeId, sessionId, now }) {
  return env.DB.prepare(
    "INSERT INTO provider_revocations " +
      "(workos_session_id, cafe_id, created, attempts, next_attempt, lease_until, lease_owner, expires, last_error) " +
      "SELECT DISTINCT workos_session_id, ?, ?, 0, ?, NULL, NULL, ?, '' FROM owner_sessions " +
      "WHERE session_id = ? AND cafe_id = ? AND workos_session_id IS NOT NULL " +
      "ON CONFLICT(workos_session_id) DO NOTHING"
  ).bind(cafeId, now, now, now + 24 * 60 * 60 * 1000, sessionId, cafeId);
}

export async function ownerLogout(request, env, cafe) {
  // Sign-out is a POST from the board's own origin; anything else is refused before a cookie is read.
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: "That request couldn't be verified." }, 403);
  }

  const cookieValue = readCookie(request, cookieName(cafe));
  const claims = cookieValue ? await tokenClaims(env, cookieValue) : null;
  const parsed = claims ? parseOwnerSubject(claims.subject) : null;
  const sessionId = parsed && parsed.owner === `cafe:${cafe.id}` ? parsed.sessionId : null;
  const now = Date.now();

  let revoked = true;
  if (sessionId) {
    const [sessionKey, cookieKey] = [await sha256Hex(sessionId), await sha256Hex(cookieValue)];
    try {
      await env.DB.batch([
        queueOne(env, { cafeId: cafe.id, sessionId, now }),
        env.DB.prepare("DELETE FROM owner_sessions WHERE session_id = ? AND cafe_id = ?").bind(sessionId, cafe.id),
        env.DB.prepare("DELETE FROM csrf_tokens WHERE operator_key_hash IN (?, ?)").bind(sessionKey, cookieKey),
      ]);
    } catch (err) {
      revoked = false;
      console.error("Owner sign-out failed", {
        cafeId: cafe.id,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  // Best effort, after the local revocation is already durable. A slow provider must not delay the
  // browser being signed out, and a failure here only leaves the job for a later drain.
  if (revoked) void drainProviderRevocations(env, { limit: 1 }).catch(() => {});

  const headers = {
    "set-cookie": sessionCookie(request, "", 0, cookieName(cafe)),
    "cache-control": "no-store",
  };
  if (!revoked) {
    return json({ error: "We couldn't end that session on the server. Please try again." }, 500, headers);
  }
  return redirect(`/c/${cafe.slug}/owner?signed_out=1`, headers);
}
