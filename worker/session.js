// Owner session, signed-token and CSRF primitives, extracted verbatim from worker/api.js (F-07
// phase 2B, stage 0). The extraction is behaviour-preserving: the SQL, the cookie attributes, the
// hashing, the timing-safe comparison, the 12-hour idle window and the 24-hour absolute cap below
// are the same code that was already shipping. worker/api.js imports every name back, so no call
// site changed and no second copy of this logic exists.
import { json } from "./http.js";

// Operator console cookie. Declared here because verifyCsrf's default binding is operator-scoped.
const OPERATOR_COOKIE = "staff_operator";

const SESSION_COOKIE = "staff_session";
const SESSION_MAX_AGE = 12 * 60 * 60;
// The absolute lifetime, measured from the row's `created`: an active session is renewed on the idle
// window, but never lives longer than this. One day matches a café's operating day and bounds a forgotten
// or shared device.
const SESSION_ABSOLUTE_MAX_AGE = 24 * 60 * 60;
const SESSION_ABSOLUTE_MAX_MS = SESSION_ABSOLUTE_MAX_AGE * 1000;

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    const raw = part.slice(index + 1).trim();
    try {
      // A malformed percent-escape can never be a valid signed token. Skip this entry instead of
      // letting one bad cookie turn the whole request into a 500; a valid duplicate is still tried.
      return decodeURIComponent(raw);
    } catch {
      continue;
    }
  }
  return "";
}

// `Secure` is added only over https so the local dev server on plain http can still sign in.
function sessionCookie(request, token, maxAge = SESSION_MAX_AGE, name = SESSION_COOKIE) {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(token)}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

// One cookie per café, so an operator signed into two clients' boards in the same browser keeps
// both sessions instead of the second login evicting the first.
//
// Application-generated slugs are capped at 40 characters (see slugify in worker/db.js), so the
// full `staff_session_<slug>` name is at most 54 characters and never needs truncation. Keep the
// complete slug here: truncating could make two distinct long slugs share one cookie name, which
// would evict one café's session in a shared browser. (worker/db.js enforces the slug cap.)
function cookieName(cafe) {
  return `${SESSION_COOKIE}_${cafe.slug}`;
}

async function issueToken(env, subject, expires = Date.now() + SESSION_MAX_AGE * 1000) {
  const payload = `${expires}.${subject}`;
  const signature = await sign(env, payload);
  return `${payload}.${signature}`;
}

// A deployment with no ADMIN_SECRET cannot sign or verify a session, so every auth surface asks
// this first and answers 503 instead of letting sign() throw into a 500.
function authConfigured(env) {
  return Boolean(env.ADMIN_SECRET);
}

function authUnavailable(what) {
  return json({ error: `${what} isn't configured on this deployment.` }, 503);
}

// Verification in one place: a token is authentic only if it has the three parts, has not expired,
// and carries a signature over `expires.subject`. Callers that need the lifetime ask for the claims;
// callers that only need "who is this" use tokenSubject.
async function tokenClaims(env, token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [expires, subject, signature] = parts;
  const expiresAt = Number(expires);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;

  const expected = await sign(env, `${expires}.${subject}`);
  return constantTimeEqual(signature, expected) ? { subject, expires: expiresAt } : null;
}

async function tokenSubject(env, token) {
  const claims = await tokenClaims(env, token);
  return claims ? claims.subject : null;
}

// An operator session id: 16 random bytes as 32 hex characters. It is the primary key of the
// operator_sessions row that backs this session, and it is embedded in the signed subject so it
// cannot be stripped or reused. Two same-millisecond sign-ins still mint distinct ids.
function operatorSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function operatorSubject(sessionId) {
  return `operator:${sessionId}`;
}

// Parse `operator:<32 hex>` into the session id, or null for any other (including legacy bare
// `operator`) subject. The id shape is validated here so the database lookup only ever sees a
// canonical value.
function operatorSessionIdFromSubject(subject) {
  const match = /^operator:([0-9a-f]{32})$/.exec(String(subject || ""));
  return match ? match[1] : null;
}

// An owner session carries the version its password had when it was minted.
//
// An absent property (a database that has not run the reset migration) is version 1, which is what a
// legacy two-part token carries. A value that is *present but invalid* is not the same thing and
// must never be read as 1: doing so would silently let an old version-1 token authenticate against
// corrupt state. Invalid values return null and every caller fails closed.
function authVersionFrom(raw) {
  if (raw === undefined) return 1;
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 1 ? raw : null;
  }
  // D1 returns INTEGER columns as numbers; a canonical digit string is accepted on the same strict
  // terms. Null, zero, negatives, fractions, NaN, unsafe integers, "", "01", " 3" and objects are
  // all invalid.
  if (typeof raw === "string" && /^[1-9][0-9]*$/.test(raw)) {
    const value = Number(raw);
    return Number.isSafeInteger(value) ? value : null;
  }
  return null;
}

function currentAuthVersion(cafe) {
  return authVersionFrom(cafe ? cafe.auth_version : undefined);
}

function ownerSubject(cafe, version, sessionId) {
  return `cafe:${cafe.id}:${version}:${sessionId}`;
}

// The session id a cookie names, or "" if it does not name one. Used only as a CSRF binding, never as
// a credential: the session itself is authenticated separately, and a token signed for another session
// id still has to pass that check.
function ownerSessionIdOf(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return "";
  const pieces = parts[1].split(":");
  return pieces.length === 4 && /^[0-9a-f]{32}$/.test(pieces[3]) ? pieces[3] : "";
}

// The subject names the café, the credential version and one specific session row:
//   cafe:<id>:<version>:<session_id>
// The id, the version and the session id are validated on their own. Two- and three-part subjects
// are the pre-session formats: they are rejected outright rather than accepted without a row, so no
// token can ever authenticate without a live session behind it. Owners sign in once after the
// upgrade.
function parseOwnerSubject(subject) {
  const parts = String(subject || '').split(':');
  if (parts[0] !== 'cafe') return null;
  if (parts.length !== 4) return null;
  if (!/^\d+$/.test(parts[1])) return null;
  const id = Number(parts[1]);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  if (!/^\d+$/.test(parts[2])) return null;
  const version = Number(parts[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  if (!/^[0-9a-f]{32}$/.test(parts[3])) return null;
  return { owner: `cafe:${id}`, version, sessionId: parts[3] };
}

// ---------------------------------------------------------------- owner sessions
// A token is a claim; a live row in `owner_sessions` is what makes it a session. Ordinary sign-out
// deletes that one row, so it cannot end any other device. Verification distinguishes "no session"
// from "the store did not answer", because a database hiccup must never be reported as "signed out".
const SESSION_OK = "ok";
const SESSION_NONE = "none";
const SESSION_STORE_DOWN = "store_down";

// 16 random bytes as 32 hex characters, the same shape the operator console uses.
function ownerSessionId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// The row has to be committed before its cookie is handed out, so callers await this and refuse to
// issue a session if it throws.
async function createOwnerSession(env, { cafeId, sessionId, now, expires }) {
  await env.DB.prepare(
    "INSERT INTO owner_sessions (session_id, cafe_id, created, expires) VALUES (?, ?, ?, ?)"
  )
    .bind(sessionId, cafeId, now, expires)
    .run();
}

// Returns the number of rows removed: 0 means the session was already gone.
async function deleteOwnerSession(env, { cafeId, sessionId }) {
  const result = await env.DB.prepare(
    "DELETE FROM owner_sessions WHERE session_id = ? AND cafe_id = ?"
  )
    .bind(sessionId, cafeId)
    .run();
  return Number(result && result.meta && result.meta.changes) || 0;
}

// Cleanup on a failure path must never turn a handled error into an unhandled one.
async function removeOwnerSessionQuietly(env, cafeId, sessionId) {
  try {
    await deleteOwnerSession(env, { cafeId, sessionId });
  } catch (err) {
    console.error("Owner session cleanup failed", {
      cafeId,
      error: err && err.message ? err.message : String(err),
    });
  }
}

// Bounded, best-effort pruning. Runs at sign-in only, so no authenticated request pays for it, and
// it removes at most 100 rows per call using the expires index.
async function pruneOwnerSessions(env, now) {
  try {
    await env.DB.prepare(
      // Both dead kinds are collected: rows past their idle window, and rows past the absolute cap
      // (their `expires` can still be in the future, but they can never authenticate again).
      "DELETE FROM owner_sessions WHERE session_id IN (" +
        "SELECT session_id FROM owner_sessions WHERE expires <= ? OR created <= ? " +
        "ORDER BY expires LIMIT 100)"
    )
      .bind(now, now - SESSION_ABSOLUTE_MAX_MS)
      .run();
  } catch (err) {
    console.error("Owner session cleanup failed", {
      error: err && err.message ? err.message : String(err),
    });
  }
}

// The live owner session behind a cookie. `expiresIn` is reported by the status route; the boolean
// form cannot express "the store is down", which is why this returns a status instead.
async function ownerSession(env, token, cafe) {
  const claims = await tokenClaims(env, token);
  if (!claims) return { status: SESSION_NONE };
  const parsed = parseOwnerSubject(claims.subject);
  if (!parsed) return { status: SESSION_NONE };
  if (parsed.owner !== `cafe:${cafe.id}`) return { status: SESSION_NONE };
  // An invalid stored version fails closed: no token authenticates against it.
  const expected = currentAuthVersion(cafe);
  if (expected === null) return { status: SESSION_NONE };
  // A reset or a sign-out-everywhere bumps the version, so every token minted before it stops
  // matching in the same instant.
  if (parsed.version !== expected) return { status: SESSION_NONE };

  // Two limits, both in the WHERE clause so no read can miss them: the idle window (`expires`) and the
  // absolute lifetime measured from `created`. A session exactly at the cap no longer matches.
  const now = Date.now();
  let row;
  try {
    // The membership flag is read in the same query as the session, not at sign-in only: revoking an
    // owner's membership must end the board they already have open, not just prevent the next login.
    // Password-flow rows carry a NULL workos_user_id and have no membership row to consult — their
    // credential is the café's own hash — so the flag is only enforced for managed sessions.
    row = await env.DB.prepare(
      "SELECT s.expires AS expires, s.created AS created, s.workos_user_id AS workos_user_id, " +
        "(SELECT 1 FROM cafe_owners o WHERE o.cafe_id = s.cafe_id AND o.workos_user_id = s.workos_user_id) AS member " +
        "FROM owner_sessions s " +
        "WHERE s.session_id = ? AND s.cafe_id = ? AND s.expires > ? AND s.created > ?"
    )
      .bind(parsed.sessionId, cafe.id, now, now - SESSION_ABSOLUTE_MAX_MS)
      .first();
  } catch (err) {
    console.error("Owner session lookup failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return { status: SESSION_STORE_DOWN };
  }
  // No row covers three cases on purpose: signed out here, expired, and a token from before this
  // table existed. All of them are simply not a session.
  if (!row) return { status: SESSION_NONE };

  // A managed session whose membership row has disappeared is no longer a session either. This is
  // what makes "remove this owner" take effect immediately instead of at the 24-hour cap.
  if (row.workos_user_id && Number(row.member) !== 1) return { status: SESSION_NONE };

  // The row is what actually gates the request, so the reported lifetime never exceeds it — and never
  // exceeds the absolute cap either, whichever of the two arrives first.
  const created = Number(row.created);
  const expires = Math.min(claims.expires, Number(row.expires), created + SESSION_ABSOLUTE_MAX_MS);
  return {
    status: SESSION_OK,
    sessionId: parsed.sessionId,
    version: parsed.version,
    created,
    expires,
    expiresIn: Math.max(0, Math.floor((expires - now) / 1000)),
  };
}

// Sliding renewal of the same session. One conditional UPDATE extends the row *and* re-checks that it
// is still live, so a sign-out or expiry that lands mid-request cannot be undone by a renewal. A row
// that changed nothing is gone: `null` rather than a fresh expiry.
async function renewOwnerSession(env, cafe, session) {
  const now = Date.now();
  // The new expiry is the idle window or the absolute cap, whichever is sooner. `created` never changes,
  // so concurrent renewals all compute the same capped value and none can push past it.
  const expires = Math.min(now + SESSION_MAX_AGE * 1000, session.created + SESSION_ABSOLUTE_MAX_MS);
  const result = await env.DB.prepare(
    "UPDATE owner_sessions SET expires = ? WHERE session_id = ? AND cafe_id = ? " +
      "AND expires > ? AND created > ?"
  )
    .bind(expires, session.sessionId, cafe.id, now, now - SESSION_ABSOLUTE_MAX_MS)
    .run();
  return Number(result && result.meta && result.meta.changes) === 1 ? expires : null;
}

/* -------------------------------------------------------------- csrf + reset */

const CSRF_HEADER = 'x-csrf-token';

// 32 random bytes from the platform CSPRNG, encoded like a session token so it survives a header.
async function issueCsrfToken(env, operatorToken) {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const token = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Date.now();

  // Only hashes are stored: the raw token lives in the operator tab and the session token only in
  // its HttpOnly cookie, so neither can be read back out of the database.
  await env.DB.prepare('DELETE FROM csrf_tokens WHERE expires < ?').bind(now).run();
  await env.DB.prepare(
    'INSERT INTO csrf_tokens (token_hash, operator_key_hash, expires, created) VALUES (?, ?, ?, ?)'
  )
    .bind(await sha256Hex(token), await sha256Hex(operatorToken), now + SESSION_MAX_AGE * 1000, now)
    .run();

  return token;
}

// Two independent checks: the browser must say the request came from this exact origin, and the
// value in the header must hash to a live row bound to the session cookie that sent it. The cookie
// name is a parameter because owner sessions use it too; the operator default keeps every existing
// caller — café creation and password reset — on exactly the behaviour it had.
async function verifyCsrf(
  request,
  env,
  sessionCookieName = OPERATOR_COOKIE,
  bindingOf = (value) => value
) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null' || origin !== new URL(request.url).origin) {
    return { ok: false, reason: 'origin' };
  }

  const presented = String(request.headers.get(CSRF_HEADER) || '').trim();
  if (!presented) return { ok: false, reason: 'missing' };

  const operatorToken = readCookie(request, sessionCookieName);
  if (!operatorToken) return { ok: false, reason: 'session' };

  // Owner sessions bind to the stable session id (the cookie is reissued on every renewal), the
  // operator console keeps binding to its cookie value. A binding that cannot be derived is a refusal.
  const binding = bindingOf(operatorToken);
  if (!binding) return { ok: false, reason: 'session' };

  const row = await env.DB.prepare('SELECT operator_key_hash, expires FROM csrf_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(presented))
    .first();
  if (!row) return { ok: false, reason: 'unknown' };
  if (Number(row.expires) <= Date.now()) return { ok: false, reason: 'expired' };
  if (!constantTimeEqual(String(row.operator_key_hash), await sha256Hex(binding))) {
    return { ok: false, reason: 'session' };
  }
  return { ok: true };
}

async function sign(env, message) {
  const secret = env.ADMIN_SECRET;
  if (!secret) throw new Error("ADMIN_SECRET is not configured");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  let binary = "";
  for (const byte of new Uint8Array(signature)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(message) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(message));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return mismatch === 0;
}

export {
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  SESSION_ABSOLUTE_MAX_AGE,
  SESSION_ABSOLUTE_MAX_MS,
  SESSION_OK,
  SESSION_NONE,
  SESSION_STORE_DOWN,
  CSRF_HEADER,
  OPERATOR_COOKIE,
  readCookie,
  sessionCookie,
  cookieName,
  issueToken,
  authConfigured,
  authUnavailable,
  tokenClaims,
  tokenSubject,
  operatorSessionId,
  operatorSubject,
  operatorSessionIdFromSubject,
  authVersionFrom,
  currentAuthVersion,
  ownerSubject,
  ownerSessionIdOf,
  parseOwnerSubject,
  ownerSessionId,
  createOwnerSession,
  deleteOwnerSession,
  removeOwnerSessionQuietly,
  pruneOwnerSessions,
  ownerSession,
  renewOwnerSession,
  issueCsrfToken,
  verifyCsrf,
  sign,
  sha256Hex,
  constantTimeEqual,
};
