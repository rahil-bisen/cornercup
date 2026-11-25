// F-07 phase 2B. The only module that talks to WorkOS.
//
// Everything is fail-closed: a timeout, a non-JSON body, an unexpected shape or a missing
// configuration value is an error the caller turns into a 503/502 — never a half-authenticated
// result. Secrets, codes, verifiers, tokens and provider session ids are never logged; the only
// thing that ever reaches a log line is an HTTP status or a bounded error label.
//
// The base URL is overridable so the deterministic test fixtures can serve the same paths. In
// production WORKOS_API_BASE is unset and this resolves to the real API.

const DEFAULT_API_BASE = "https://api.workos.com";
const TIMEOUT_MS = 5000;
const MAX_JWKS_BYTES = 65536;
const JWKS_TTL_MS = 10 * 60 * 1000;

export class WorkosError extends Error {
  constructor(label, status = 0) {
    super(label);
    this.name = "WorkosError";
    this.label = label;
    this.status = status;
  }
}

export function workosConfig(env) {
  const clientId = String((env && env.WORKOS_CLIENT_ID) || "").trim();
  const apiKey = String((env && env.WORKOS_API_KEY) || "").trim();
  const redirectUri = String((env && env.WORKOS_REDIRECT_URI) || "").trim();
  const issuer = String((env && env.WORKOS_ISSUER) || "").trim();
  // WorkOS access tokens are issued with the client id as their audience. WORKOS_AUDIENCE exists so a
  // sandbox can pin the value it actually observes without a code change.
  const audience = String((env && env.WORKOS_AUDIENCE) || clientId).trim();
  const base = String((env && env.WORKOS_API_BASE) || DEFAULT_API_BASE).replace(/\/+$/, "");
  return { clientId, apiKey, redirectUri, issuer, audience, base };
}

// A managed café cannot sign anyone in until every value it needs is present. Returning the list of
// missing *names* (never values) keeps the 503 diagnosable without leaking anything.
export function missingConfig(env) {
  const config = workosConfig(env);
  const missing = [];
  if (!config.clientId) missing.push("WORKOS_CLIENT_ID");
  if (!config.apiKey) missing.push("WORKOS_API_KEY");
  if (!config.redirectUri) missing.push("WORKOS_REDIRECT_URI");
  if (!config.issuer) missing.push("WORKOS_ISSUER");
  if (String((env && env.WORKOS_STATE_ENCRYPTION_KEY) || "").length < 32) {
    missing.push("WORKOS_STATE_ENCRYPTION_KEY");
  }
  return missing;
}

function timeoutSignal() {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(TIMEOUT_MS);
  }
  const controller = new AbortController();
  setTimeout(() => controller.abort(), TIMEOUT_MS);
  return controller.signal;
}

async function readBounded(response, limit) {
  const text = await response.text();
  if (text.length > limit) throw new WorkosError("response-too-large", response.status);
  return text;
}

export function authorizeUrl(env, { state, challenge }) {
  const config = workosConfig(env);
  const url = new URL(`${config.base}/user_management/authorize`);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  // Email verification is a provider-side policy, but asking for the scope keeps the requirement
  // explicit for the sandbox review instead of relying on dashboard drift.
  url.searchParams.set("scope", "openid profile email");
  return url.toString();
}

// Exchanges a code exactly once. There is deliberately no retry: a second exchange of the same code
// cannot succeed, and repeating a request whose reply was lost risks the provider treating it as
// replay. The caller restarts the sign-in instead.
export async function exchangeCode(env, { code, verifier }) {
  const config = workosConfig(env);
  let response;
  try {
    response = await fetch(`${config.base}/user_management/authenticate`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: config.clientId,
        client_secret: config.apiKey,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
      }),
      signal: timeoutSignal(),
    });
  } catch {
    throw new WorkosError("exchange-timeout");
  }

  if (!response.ok) throw new WorkosError("exchange-failed", response.status);

  let body;
  try {
    body = JSON.parse(await readBounded(response, MAX_JWKS_BYTES));
  } catch {
    throw new WorkosError("exchange-body", response.status);
  }

  const user = body && body.user;
  const accessToken = body && body.access_token;
  if (!user || typeof user.id !== "string" || !user.id) throw new WorkosError("exchange-user", response.status);
  if (typeof accessToken !== "string" || !accessToken) throw new WorkosError("exchange-token", response.status);

  return {
    accessToken,
    user: {
      id: user.id,
      email: typeof user.email === "string" ? user.email : "",
      emailVerified: user.email_verified === true,
    },
  };
}

// Module-scope cache, one entry per client id. A cold isolate fetches once; an unknown `kid` forces
// one refetch, which is how a rotation is picked up without waiting for the TTL.
const jwksCache = new Map();

export async function fetchJwks(env, { force = false } = {}) {
  const config = workosConfig(env);
  const cacheKey = `${config.base}|${config.clientId}`;
  const cached = jwksCache.get(cacheKey);
  if (!force && cached && Date.now() - cached.at < JWKS_TTL_MS) return cached.jwks;

  let response;
  try {
    response = await fetch(`${config.base}/sso/jwks/${encodeURIComponent(config.clientId)}`, {
      headers: { accept: "application/json" },
      signal: timeoutSignal(),
    });
  } catch {
    throw new WorkosError("jwks-timeout");
  }
  if (!response.ok) throw new WorkosError("jwks-failed", response.status);

  let jwks;
  try {
    jwks = JSON.parse(await readBounded(response, MAX_JWKS_BYTES));
  } catch {
    throw new WorkosError("jwks-body", response.status);
  }
  if (!jwks || !Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new WorkosError("jwks-empty");

  jwksCache.set(cacheKey, { jwks, at: Date.now() });
  return jwks;
}

export function clearJwksCache() {
  jwksCache.clear();
}

// Server-side revocation. 200 and 404 are both success: 404 means the session is already gone, which
// is the state we wanted. Anything else is a failure to be retried later.
export async function revokeSession(env, sessionId) {
  const config = workosConfig(env);
  if (!sessionId) return { ok: false, status: 0 };
  let response;
  try {
    response = await fetch(`${config.base}/user_management/sessions/revoke`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ session_id: sessionId }),
      signal: timeoutSignal(),
    });
  } catch {
    return { ok: false, status: 0 };
  }
  if (response.ok || response.status === 404) return { ok: true, status: response.status };
  return { ok: false, status: response.status };
}

// Top-level navigation target for a provider logout. Only ever used when a provider session id is
// known; a NULL sid means provider logout is simply unavailable for that session.
export function logoutUrl(env, { sessionId, returnTo }) {
  const config = workosConfig(env);
  const url = new URL(`${config.base}/user_management/sessions/logout`);
  url.searchParams.set("session_id", sessionId);
  if (returnTo) url.searchParams.set("return_to", returnTo);
  return url.toString();
}
