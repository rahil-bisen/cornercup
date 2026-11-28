import { BODY_LIMITS, BodyTooLargeError, json, readJson, readText } from "./http.js";
import { newTrackNonce, readTrackToken, trackHash, trackToken, trackingConfigured } from "./tracking.js";
import { SEED_MENU, isIdempotencyIndexReady } from "./db.js";
import {
  CLAIM_LEASE_MS,
  abandonClaimStatement,
  claimReadStatement,
  claimStatement,
  commitClaimStatement,
  counterPaymentStatement,
  normalizeCheckoutBody,
  orderBatch,
  paymentStatusSets,
  orderFingerprint,
  releaseStatement,
  staffOrderUpdateStatement,
  takeoverStatement,
  tombstoneStatement,
} from "./orders.js";
import { OrderIdUnavailableError, freshOrderId, isOrderIdCollision } from "./orderids.js";
import {
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
} from "./session.js";
import { authModeTransition, authModeTransitionStatements, isAuthModeTransitionConflict, newCasToken } from "./authmode.js";
import { ownerStart, ownerClaimStart, ownerCallback, ownerLogout } from "./owner.js";
import {
  RECOVERY_CODE_COUNT,
  base32Encode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateSecret,
  hashRecoveryCode,
  looksLikeRecoveryCode,
  mfaConfigured,
  mfaKeyState,
  otpauthUri,
  verifyTotp,
} from "./totp.js";
import { drainProviderRevocations, queueProviderRevocationsStatement } from "./revocations.js";
import { claimDigest, randomToken } from "./pkce.js";
import { archiveStatements, deleteStatements, isRemovalGuardFailure, restoreStatements } from "./cafe-removal.js";
import {
  cafeSettings,
  createCafe,
  defaultCafe,
  findCafeBySlug,
  hashPassword,
  primaryCafeId,
  isArgon2Hash,
  PasswordQueueFullError,
  passwordNeedsReset,
  publicCafe,
  verifyPassword,
} from "./cafes.js";

// Re-exported so every existing importer of worker/api.js keeps working after the extraction.
export { readCookie, cookieName, issueToken, authVersionFrom } from "./session.js";

const STATUSES = ["new", "preparing", "ready", "served", "cancelled"];

// Stage 3B: menu photography helpers.
const IMAGE_MAX_BYTES = 1 * 1024 * 1024; // 1 MB
const IMAGE_MAX_DIMENSION = 4096;
const IMAGE_MAX_PIXELS = 16 * 1024 * 1024; // ~16 MP

function itemImageUrl(cafe, id, imageKey, updatedAt) {
  if (!imageKey) return null;
  const v = updatedAt ? encodeURIComponent(String(updatedAt)) : "";
  return `/api/cafes/${encodeURIComponent(cafe.slug)}/menu/${id}/image${v ? "?v=" + v : ""}`;
}

function detectImageFormat(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < 12) return null;
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
    bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a
  ) return "png";
  // WebP: RIFF....WEBP
  if (
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
  ) return "webp";
  return null;
}

function imageContentType(format) {
  if (format === "jpeg") return "image/jpeg";
  if (format === "png") return "image/png";
  if (format === "webp") return "image/webp";
  return null;
}

function imageExtension(format) {
  if (format === "jpeg") return "jpg";
  if (format === "png") return "png";
  if (format === "webp") return "webp";
  return null;
}

function imageDimensions(format, bytes) {
  try {
    if (format === "png") {
      // IHDR: width/height at offset 16 (big-endian 4 bytes each)
      if (bytes.length < 24) return null;
      const w = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
      const h = (bytes[20] << 24) | (bytes[21] << 16) | (bytes[22] << 8) | bytes[23];
      return { width: w >>> 0, height: h >>> 0 };
    }
    if (format === "jpeg") {
      // Scan markers for SOF0/SOF1/SOF2.
      let i = 2;
      while (i < bytes.length - 9) {
        if (bytes[i] !== 0xff) { i += 1; continue; }
        const marker = bytes[i + 1];
        if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
          const h = (bytes[i + 5] << 8) | bytes[i + 6];
          const w = (bytes[i + 7] << 8) | bytes[i + 8];
          return { width: w, height: h };
        }
        if (marker === 0xd8 || marker === 0xd9) { i += 2; continue; }
        const len = (bytes[i + 2] << 8) | bytes[i + 3];
        if (!len || len < 2) return null;
        i += 2 + len;
      }
      return null;
    }
    if (format === "webp") {
      if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
        const w = (bytes[26] | (bytes[27] << 8)) & 0x3fff;
        const h = (bytes[28] | (bytes[29] << 8)) & 0x3fff;
        return { width: w, height: h };
      }
      if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4c) {
        if (bytes[20] !== 0x2f) return null;
        const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
        const width = 1 + (((b1 & 0x3f) << 8) | b0);
        const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
        return { width, height };
      }
      if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
        const w = (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16)) + 1;
        const h = (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16)) + 1;
        return { width: w, height: h };
      }
      return null;
    }
    return null;
  } catch (err) {
    return null;
  }
}

function validateImageBytes(bytes) {
  // Returns { ok: true, format, contentType, extension, width, height } or { ok: false, error, status }.
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: "We couldn't read that image.", status: 400 };
  if (bytes.length === 0) return { ok: false, error: "That image is empty.", status: 400 };
  if (bytes.length > IMAGE_MAX_BYTES) {
    return { ok: false, error: "That image is too large. Maximum 1 MB.", status: 413 };
  }
  const format = detectImageFormat(bytes);
  if (!format) return { ok: false, error: "Unsupported image type. Use JPEG, PNG or WebP.", status: 415 };
  const dims = imageDimensions(format, bytes);
  if (!dims) return { ok: false, error: "We couldn't read that image's dimensions.", status: 400 };
  if (
    !Number.isFinite(dims.width) || !Number.isFinite(dims.height) ||
    dims.width < 1 || dims.height < 1 ||
    dims.width > IMAGE_MAX_DIMENSION || dims.height > IMAGE_MAX_DIMENSION ||
    dims.width * dims.height > IMAGE_MAX_PIXELS
  ) {
    return { ok: false, error: "That image's dimensions are too large.", status: 413 };
  }
  return {
    ok: true,
    format,
    contentType: imageContentType(format),
    extension: imageExtension(format),
    width: dims.width,
    height: dims.height,
  };
}

async function readImageBytes(request) {
  // Reads a single file from multipart/form-data. Returns { bytes, error, status }.
  // Enforces the size cap while reading.
  let form;
  try {
    form = await request.formData();
  } catch (err) {
    return { bytes: null, error: "We couldn't read that upload.", status: 400 };
  }
  const files = [];
  for (const [key, value] of form.entries()) {
    if (value && typeof value === "object" && typeof value.arrayBuffer === "function") files.push(value);
  }
  if (files.length !== 1) {
    return { bytes: null, error: files.length === 0 ? "Choose an image to upload." : "Upload one image at a time.", status: 400 };
  }
  const file = files[0];
  if (typeof file.size === "number" && file.size > IMAGE_MAX_BYTES) {
    return { bytes: null, error: "That image is too large. Maximum 1 MB.", status: 413 };
  }
  let buf;
  try {
    buf = await file.arrayBuffer();
  } catch (err) {
    return { bytes: null, error: "We couldn't read that upload.", status: 400 };
  }
  const bytes = new Uint8Array(buf);
  if (bytes.length > IMAGE_MAX_BYTES) {
    return { bytes: null, error: "That image is too large. Maximum 1 MB.", status: 413 };
  }
  return { bytes, error: null, status: 200 };
}
const PAYMENT_STATUSES = ["unpaid", "submitted", "confirmed", "counter", "failed"];

// Legitimate status flow: NEW → PREPARING → READY → SERVED (terminal). Cancellation is always
// allowed, and re-sending the current status is a harmless no-op. Anything else is a skipped step.
function canTransitionStatus(from, to) {
  if (from === to) return true;
  if (to === "cancelled") return true;
  if (from === "new" && to === "preparing") return true;
  if (from === "preparing" && to === "ready") return true;
  if (from === "ready" && to === "served") return true;
  return false;
}
const RAZORPAY_API = "https://api.razorpay.com/v1";

// F-09: a guest may create a gateway order only for their own ticket, and only so many times. The
// capability is the tracking token (header only) and the budget is per order, so neither a leaked id
// nor a leaked token can be used to mint payable artefacts in a loop.
const RAZORPAY_CREATE_MAX = 10;
const RAZORPAY_CREATE_WINDOW_MS = 10 * 60 * 1000;

// A short-lived claim on one ticket's gateway creation. Two taps, two tabs or a retry racing the first
// request must not produce two payable gateway orders. The claim lives in D1, not in memory: an isolate
// can be replaced between two awaits, so an in-process lock would not survive the case it has to cover.
// It rides the existing rate_limits table, which is already a keyed store of expiring rows.
const PAYMENT_CLAIM_TTL_MS = 30 * 1000;
const PAYMENT_CLAIM_RENEW_MS = 10 * 1000;
// M-1: the gateway call is bounded below the claim TTL, so an in-process request cannot still be
// waiting on Razorpay after its own claim has expired and been taken over.
const RAZORPAY_TIMEOUT_MS = 15 * 1000;

// Every acquisition writes its own random owner token into the row, and every later write matches it.
// Without that, a request whose claim expired and was reclaimed by another request would still hold the
// old row's key: its finally block would delete the newer claim, and its renewal would extend it.
function newClaimOwner() {
  return crypto.randomUUID();
}

// One statement, so reclaiming an expired claim is atomic: a row that is still live refuses the update
// in its WHERE clause, while an expired row is taken over in place. RETURNING names the token that won.
async function claimPaymentCreation(env, key, ttlMs) {
  const now = Date.now();
  const owner = newClaimOwner();
  const row = await env.DB.prepare(
    "INSERT INTO rate_limits (key, count, window_start, expires, updated_at, owner) VALUES (?, 1, ?, ?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET owner = excluded.owner, expires = excluded.expires, " +
      "window_start = excluded.window_start, updated_at = excluded.updated_at " +
      "WHERE rate_limits.expires <= ? RETURNING owner"
  )
    .bind(key, now, now + ttlMs, now, owner, now)
    .first();
  return row && row.owner === owner ? owner : null;
}

// Extends a claim this request still owns. A claim that was reclaimed matches no row and is left alone.
async function renewPaymentClaim(env, key, owner, ttlMs) {
  const now = Date.now();
  const result = await env.DB.prepare(
    "UPDATE rate_limits SET expires = ?, updated_at = ? WHERE key = ? AND owner = ?"
  )
    .bind(now + ttlMs, now, key, owner)
    .run();
  return Number(result.meta && result.meta.changes) === 1;
}

// Conditional on the owner token: a stale request cannot delete the claim that replaced it.
async function releasePaymentClaim(env, key, owner) {
  try {
    const result = await env.DB.prepare("DELETE FROM rate_limits WHERE key = ? AND owner = ?").bind(key, owner).run();
    if (Number(result.meta && result.meta.changes) !== 1) {
      console.warn("Payment claim was reclaimed before release", { key });
    }
  } catch (err) {
    // The row expires on its own, so a failed release cannot leave a ticket stuck.
    console.error("Payment claim release failed", { error: err && err.message ? err.message : String(err) });
  }
}

// One place turns an oversized body into a 413. Every route reads its body through readJson or
// readText in worker/http.js, which throws BodyTooLargeError while the stream is still arriving, so
// nothing downstream ever sees a body it did not bound.
const BODY_TOO_LARGE = { error: "That request is too large." };

export async function handleApi(request, env, url, ctx) {
  try {
    return await routeApi(request, env, url, ctx);
  } catch (error) {
    if (error instanceof BodyTooLargeError) return json(BODY_TOO_LARGE, 413);
    throw error;
  }
}

async function routeApi(request, env, url, ctx) {
  const method = request.method;
  const path = url.pathname.slice("/api/".length).split("/").filter(Boolean);

  const rateLimitResponse = await checkApiRateLimit(request, env);
  if (rateLimitResponse) return rateLimitResponse;

  if (path[0] === "health" && method === "GET") return health(env);

  // Only the operator console may see the list of cafés; guests arrive with a slug instead. The one
  // exception is the bare domain, which resolves to the primary café so a single-café deployment
  // still opens on its own menu.
  if (path[0] === "cafe" && path.length === 1 && method === "GET") {
    const cafe = await defaultCafe(env);
    return cafe ? json(publicCafe(cafe)) : json({ error: "No café is set up yet." }, 404);
  }
  // The OAuth callback is deployment-wide: redirect URIs are registered per WorkOS application, not
  // per café, so this route resolves its own café from the consumed sign-in state.
  if (path[0] === "owner" && path[1] === "callback" && method === "GET") {
    return ownerCallback(request, env, url);
  }
  if (path[0] === "operator") return operatorApi(request, env, path.slice(1));

  // Every other route is scoped to one café, so a slug in the path decides which tenant's data
  // a request can see. An unknown slug is a 404 rather than a fallback, which keeps tenants apart.
  if (path[0] === "cafes" && path[1]) {
    const cafe = await findCafeBySlug(env, path[1]);
    if (!cafe) return json({ error: "No café found at that web address." }, 404);
    return handleCafeApi(request, env, url, ctx, cafe, path.slice(2));
  }

  return json({ error: "Not found" }, 404);
}

async function handleCafeApi(request, env, url, ctx, cafe, path) {
  const method = request.method;

  if (path[0] === "menu" && path.length === 3 && path[2] === "image" && method === "GET") {
    return getMenuImage(env, cafe, Number(path[1]));
  }
  if (path[0] === "menu" && method === "GET") return getMenu(env, url, cafe);
  if (path[0] === "tables" && method === "GET") return getTables(env, cafe);
  if (path[0] === "config" && method === "GET") return getConfig(env, cafe);

  // Managed owner sign-in. Each handler re-checks the café's mode itself, so a link minted before a
  // mode switch cannot be replayed afterwards.
  if (path[0] === "owner" && path[1] === "start" && method === "GET") return ownerStart(request, env, cafe);
  if (path[0] === "owner" && path[1] === "claim" && path[2] === "start" && method === "POST") {
    return ownerClaimStart(request, env, cafe);
  }
  if (path[0] === "owner" && path[1] === "logout" && method === "POST") return ownerLogout(request, env, cafe);

  // Razorpay's dashboard accepts exactly one webhook URL; both spellings reach the same handler.
  if (path[0] === "razorpay" && path[1] === "webhook" && method === "POST") return razorpayWebhook(request, env, cafe, ctx);
  if (path[0] === "webhooks" && path[1] === "razorpay" && method === "POST") return razorpayWebhook(request, env, cafe, ctx);

  if (path[0] === "orders") {
    if (method === "POST" && path.length === 1) return createOrder(request, env, cafe);
    // Settles a checkout whose cart changed: never creates, only reports committed or abandoned.
    if (method === "POST" && path.length === 4 && path[1] === "idempotency" && path[3] === "abandon") {
      return abandonCheckout(request, env, cafe, path[2]);
    }
    if (method === "GET" && path.length === 2) return getOrder(request, env, cafe, path[1]);
    if (method === "POST" && path.length === 3 && path[2] === "payment") return submitPayment(request, env, cafe, path[1]);
    if (method === "POST" && path.length === 4 && path[2] === "payment" && path[3] === "razorpay") {
      return createRazorpayPayment(request, env, cafe, path[1]);
    }
    if (method === "POST" && path.length === 5 && path[2] === "payment" && path[3] === "razorpay" && path[4] === "verify") {
      return verifyRazorpayPayment(request, env, cafe, path[1], ctx);
    }
  }

  if (path[0] === "admin") {
    // The second step of a two-factor sign-in. It is checked before the password route so
    // `/admin/login/totp` is never read as a password attempt.
    if (path[1] === "login" && path[2] === "totp" && method === "POST") return loginTotp(request, env, cafe);
    if (path[1] === "login" && method === "POST") return login(request, env, cafe);
    if (path[1] === "logout" && method === "POST") return logout(request, env, cafe);
    if (path[1] === "session" && method === "GET") return sessionStatus(env, request, cafe);

    // Without a secret no session can be verified; answer before sign() can throw.
    if (!authConfigured(env)) return authUnavailable("Staff sign-in");

    // Three outcomes, not two. A broken session store must not look like an expired session, or the
    // board would sign the owner out instead of letting them retry a moment later.
    const session = await ownerSession(env, readCookie(request, cookieName(cafe)), cafe);
    if (session.status === SESSION_STORE_DOWN) {
      return json({ error: "This café's sign-in isn't available right now. Please try again." }, 503);
    }
    if (session.status !== SESSION_OK) {
      // Expired, past its cap, signed out or legacy: reject it and drop the dead cookie here too, not
      // only on the status endpoint, so every owner path answers the same way.
      return json({ error: "Your staff session expired. Please sign in again." }, 401, {
        "set-cookie": sessionCookie(request, "", 0, cookieName(cafe)),
      });
    }

    // Second factor: status, enrollment, confirmation and removal. Every mutation below re-proves the
    // current password and bumps the credential version, so no session outlives a factor change.
    if (path[1] === "mfa") {
      if (path.length === 2 && method === "GET") return ownerMfaStatus(env, cafe);
      if (path[2] === "enroll" && method === "POST") return ownerMfaEnroll(request, env, cafe);
      if (path[2] === "confirm" && method === "POST") return ownerMfaConfirm(request, env, cafe);
      if (path[2] === "disable" && method === "POST") return ownerMfaDisable(request, env, cafe);
      if (path[2] === "recovery-regenerate" && method === "POST") {
        return ownerMfaRecoveryRegenerate(request, env, cafe);
      }
    }

    // Session inventory: a list and a per-device revoke. Both are scoped to this café's rows.
    if (path[1] === "sessions" && path.length === 2 && method === "GET") {
      return ownerSessionList(env, cafe, session);
    }
    if (path[1] === "sessions" && path[3] === "revoke" && method === "POST") {
      return ownerRevokeSession(request, env, cafe, session, path[2]);
    }

    // Ending every other device's session is a credential action, not a navigation one, so it asks
    // for the same CSRF proof an operator mutation does rather than trusting SameSite alone.
    if (path[1] === "logout-all" && method === "POST") return logoutEverywhere(request, env, cafe);

    if (path[1] === "settings" && method === "GET") return adminSettings(cafe);
    if (path[1] === "settings" && method === "PATCH") return adminSaveSettings(request, env, cafe);

    if (path[1] === "orders" && method === "GET") return adminOrders(env, cafe);
    if (path[1] === "orders" && path[2] && method === "PATCH") return adminUpdateOrder(request, env, cafe, path[2]);

    if (path[1] === "menu" && path[2] === "reseed" && method === "POST") return adminReseedMenu(request, env, cafe);
    if (path[1] === "menu" && method === "GET") return adminMenu(env, cafe);
    // The photo routes are narrower than "any POST/DELETE under /menu", so they must be matched
    // first; otherwise an upload would be read as JSON and an image delete would delete the item.
    if (path[1] === "menu" && path[2] && path[3] === "image" && method === "POST") return adminUploadImage(request, env, cafe, Number(path[2]));
    if (path[1] === "menu" && path[2] && path[3] === "image" && method === "DELETE") return adminRemoveImage(request, env, cafe, Number(path[2]));
    if (path[1] === "menu" && method === "POST") return adminCreateItem(request, env, cafe);
    // item edits (rename, price, description, emoji, category, availability) and removal both require a
    // verified owner session whose cookie belongs to this café. Creation uses its own CSRF check.
    if (path[1] === "menu" && path[2]) {
      if (method === "PATCH") return adminUpdateItem(request, env, cafe, Number(path[2]));
      if (method === "DELETE") return adminDeleteItem(request, env, cafe, Number(path[2]));
    }

    if (path[1] === "tables" && method === "GET") return getTables(env, cafe);
    if (path[1] === "tables" && method === "POST") return adminCreateTable(request, env, cafe);
  }

  return json({ error: "Not found" }, 404);
}

/* ---------------------------------------------------------------- operator */


// Operator sessions are `operator:<nonce>`, one random nonce per sign-in, so two logins can never
// receive the same token and a CSRF row can be tied to one specific session. A bare `operator`
// subject is the pre-nonce format: it is still accepted so a console already signed in when this
// ships keeps working until its 12-hour cookie expires, and it can be dropped after that.
async function checkOperator(env, token) {
  const claims = await tokenClaims(env, token);
  if (!claims) return false;
  const sessionId = operatorSessionIdFromSubject(claims.subject);
  if (!sessionId) return false; // legacy bare `operator` tokens are rejected
  // The session must still exist server-side; a logout (ordinary or everywhere) deletes it.
  // Fail closed on any database error so a broken store can never authenticate a stale cookie.
  try {
    const row = await env.DB.prepare(
      "SELECT credential_hash FROM operator_sessions WHERE session_id = ? AND expires > ?"
    )
      .bind(sessionId, Date.now())
      .first();
    if (!row) return false;
    // The session is valid only while the configured password is the one it was minted under. A
    // rotation therefore revokes every console session immediately; a row without a digest (created
    // by an older build) fails closed rather than being grandfathered.
    const current = String(env.OPERATOR_PASSWORD || "").trim();
    if (!current || !row.credential_hash) return false;
    return constantTimeEqual(String(row.credential_hash), await sha256Hex(current));
  } catch (err) {
    console.error("Operator session lookup failed", {
      error: err && err.message ? err.message : String(err),
    });
    return false;
  }
}

// The console behind /operator: only the person running the deployment sees every client's café.
async function operatorApi(request, env, path) {
  const method = request.method;

  if (path[0] === "session" && method === "GET") {
    if (!authConfigured(env)) return authUnavailable("The operator console");
    const token = readCookie(request, OPERATOR_COOKIE);
    if (!(await checkOperator(env, token))) return json({ error: "Not signed in." }, 401);
    // The console picks its CSRF token up here and on login. Only the token hash is stored, so a
    // database read cannot be replayed as a mutating request.
    const claims = await tokenClaims(env, token);
    const expiresIn = claims ? Math.max(0, Math.floor((claims.expires - Date.now()) / 1000)) : 0;
    return json({ ok: true, expiresIn, csrfToken: await issueCsrfToken(env, token) });
  }

  if (path[0] === "login" && method === "POST") return operatorLogin(request, env);

  if (path[0] === "logout" && method === "POST") {
    // Ordinary sign-out: revoke the server-side session so a copied cookie stops working, then
    // clear the browser's copy. If the delete fails we still clear the cookie but say so.
    const token = readCookie(request, OPERATOR_COOKIE);
    const claims = await tokenClaims(env, token);
    const sessionId = claims ? operatorSessionIdFromSubject(claims.subject) : null;
    let revoked = true;
    if (sessionId) {
      try {
        await env.DB.prepare("DELETE FROM operator_sessions WHERE session_id = ?")
          .bind(sessionId)
          .run();
      } catch (err) {
        revoked = false;
        console.error("Operator session deletion failed", {
          error: err && err.message ? err.message : String(err),
        });
      }
    }
    // Best-effort cleanup of CSRF rows bound to this session.
    if (sessionId && revoked) {
      try {
        // Owner tokens are bound to the session id; the cookie-value delete also clears rows issued
        // before that binding existed, so an upgrade leaves nothing behind.
        await env.DB.prepare("DELETE FROM csrf_tokens WHERE operator_key_hash IN (?, ?)")
          .bind(await sha256Hex(sessionId), await sha256Hex(token))
          .run();
      } catch (err) {
        console.error("Operator CSRF cleanup failed", {
          error: err && err.message ? err.message : String(err),
        });
      }
    }
    const headers = { "set-cookie": sessionCookie(request, "", 0, OPERATOR_COOKIE) };
    if (!revoked && sessionId) {
      return json({ error: "We couldn't end that session on the server. Please try again." }, 500, headers);
    }
    return json({ ok: true }, 200, headers);
  }

  if (path[0] === "logout-all" && method === "POST") {
    return operatorLogoutEverywhere(request, env);
  }

  if (!authConfigured(env)) return authUnavailable("The operator console");

  const authorised = await checkOperator(env, readCookie(request, OPERATOR_COOKIE));
  if (!authorised) return json({ error: "Sign in to the operator console." }, 401);

  if (path[0] === "cafes" && path.length === 1 && method === "GET") return operatorCafes(env);
  if (path[0] === "cafes" && path.length === 1 && method === "POST") return operatorCreateCafe(request, env);
  if (path[0] === "cafes" && path.length === 3 && path[2] === "reset-password" && method === "POST") {
    return operatorResetPassword(request, env, path[1]);
  }
  if (path[0] === "cafes" && path.length === 3 && path[2] === "archive" && method === "POST") {
    return operatorArchiveCafe(request, env, path[1]);
  }
  if (path[0] === "cafes" && path.length === 3 && path[2] === "restore" && method === "POST") {
    return operatorRestoreCafe(request, env, path[1]);
  }
  if (path[0] === "cafes" && path.length === 2 && method === "DELETE") {
    return operatorDeleteCafe(request, env, path[1]);
  }
  if (path[0] === "cafes" && path.length === 3 && path[2] === "auth-mode" && method === "POST") {
    return operatorAuthMode(request, env, path[1]);
  }
  if (path[0] === "cafes" && path.length === 3 && (path[2] === "owners" || path[2] === "claims")) {
    if (method === "GET") return path[2] === "owners" ? operatorOwners(env, path[1]) : operatorClaims(env, path[1]);
    if (method === "POST") {
      return path[2] === "owners" ? operatorGrantOwner(request, env, path[1]) : operatorCreateClaim(request, env, path[1]);
    }
  }
  if (path[0] === "cafes" && path.length === 4 && path[2] === "owners" && method === "DELETE") {
    return operatorRevokeOwner(request, env, path[1], path[3]);
  }
  if (path[0] === "cafes" && path.length === 4 && path[2] === "claims" && method === "DELETE") {
    return operatorRevokeClaim(request, env, path[1], path[3]);
  }

  return json({ error: "Not found" }, 404);
}

async function operatorLogin(request, env) {
  // Same secret signs operator sessions, so the console stays closed without it.
  if (!env.ADMIN_SECRET) {
    return signinNotSetUp();
  }

  // Trim so a secret pasted with stray whitespace still matches what the user types.
  const expected = String(env.OPERATOR_PASSWORD || "").trim();
  if (!expected) {
    return signinNotSetUp();
  }

  const ipHash = await clientIpHash(request);
  const lockoutKey = `login:operator:${ipHash}`;

  let current;
  try {
    current = await readRateLimit(env, lockoutKey);
  } catch (err) {
    console.error("Operator login lockout check failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "The operator console isn't available right now. Please try again." }, 503);
  }
  if (current.count >= LOGIN_MAX_FAILURES && current.expires > Date.now()) {
    return signinLockedOut(current.expires);
  }

  const body = await readJson(request, BODY_LIMITS.operatorLogin);
  const attempt = String((body && (body.password || body.pin)) || "").trim();

  if (!attempt || !constantTimeEqual(attempt, expected)) {
    try {
      await touchRateLimit(env, lockoutKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES);
    } catch (err) {
      console.error("Operator login lockout update failed", { error: err && err.message ? err.message : String(err) });
      return json({ error: "The operator console isn't available right now. Please try again." }, 503);
    }
    return json({ error: SIGNIN_WRONG_PASSWORD, code: "wrong_password" }, 401);
  }

  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(lockoutKey).run();
  } catch (err) {
    console.error("Operator login lockout reset failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "The operator console isn't available right now. Please try again." }, 503);
  }
  // Mint the session id first and persist it; if the insert fails we must not hand out a cookie that
  // can never be validated (or, worse, one that authenticates against nothing).
  const sessionId = operatorSessionId();
  const now = Date.now();
  const expires = now + SESSION_MAX_AGE * 1000;

  // Bounded, best-effort pruning of expired sessions (not on every authenticated request).
  try {
    await env.DB.prepare("DELETE FROM operator_sessions WHERE expires < ?").bind(now).run();
  } catch (err) {
    console.error("Operator session cleanup failed", {
      error: err && err.message ? err.message : String(err),
    });
  }
  try {
    // The digest of the password this session was minted under. Rotating OPERATOR_PASSWORD changes
    // the digest, so every live console session stops authenticating at the same moment — the only
    // revocation lever a single shared credential can offer. A digest is not a credential.
    await env.DB.prepare(
      "INSERT INTO operator_sessions (session_id, created, expires, credential_hash) VALUES (?, ?, ?, ?)"
    )
      .bind(sessionId, now, expires, await sha256Hex(expected))
      .run();
  } catch (err) {
    console.error("Operator session creation failed", {
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "The operator console isn't available right now. Please try again." }, 503);
  }

  const operatorToken = await issueToken(env, operatorSubject(sessionId));
  return json({ ok: true, expiresIn: SESSION_MAX_AGE, csrfToken: await issueCsrfToken(env, operatorToken) }, 200, {
    "set-cookie": sessionCookie(request, operatorToken, SESSION_MAX_AGE, OPERATOR_COOKIE),
  });
}

async function operatorLogoutEverywhere(request, env) {
  // Authenticated, Origin-checked, CSRF-protected: same door as the owner's logout-all.
  const token = readCookie(request, OPERATOR_COOKIE);
  const claims = await tokenClaims(env, token);
  const sessionId = claims ? operatorSessionIdFromSubject(claims.subject) : null;
  if (!sessionId) {
    return json({ error: "Sign in to the operator console." }, 401);
  }
  // Session must still be live server-side.
  let live = false;
  try {
    const row = await env.DB.prepare(
      "SELECT 1 AS ok FROM operator_sessions WHERE session_id = ? AND expires > ?"
    )
      .bind(sessionId, Date.now())
      .first();
    live = Boolean(row);
  } catch (err) {
    console.error("Operator session lookup failed", {
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "The operator console isn't available right now. Please try again." }, 503);
  }
  if (!live) {
    return json({ error: "Sign in to the operator console." }, 401);
  }

  const csrf = await verifyCsrf(request, env, OPERATOR_COOKIE);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);
  }

  // Mint the replacement session id up front so it can be inserted atomically with the deletion.
  const newSessionId = operatorSessionId();
  const now = Date.now();
  const expires = now + SESSION_MAX_AGE * 1000;

  // Delete every existing session and insert the replacement in one atomic batch. If either
  // statement fails, neither commits, so no caller is left without a valid session and no failed
  // operation reports success. The replacement carries the current password digest, so it is the one
  // session that survives this sweep.
  const replacementCredential = await sha256Hex(String(env.OPERATOR_PASSWORD || "").trim());
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM operator_sessions"),
      env.DB
        .prepare(
          "INSERT INTO operator_sessions (session_id, created, expires, credential_hash) VALUES (?, ?, ?, ?)"
        )
        .bind(newSessionId, now, expires, replacementCredential),
    ]);
  } catch (err) {
    console.error("Operator logout-all batch failed", {
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "We couldn't sign the other devices out. Nothing was changed." }, 500);
  }

  // Best-effort CSRF cleanup; must not invalidate an otherwise successful operation.
  try {
    await env.DB.prepare("DELETE FROM csrf_tokens").run();
  } catch (err) {
    console.error("Operator CSRF cleanup failed", {
      error: err && err.message ? err.message : String(err),
    });
  }

  const newToken = await issueToken(env, operatorSubject(newSessionId));
  return json({ ok: true, expiresIn: SESSION_MAX_AGE }, 200, {
    "set-cookie": sessionCookie(request, newToken, SESSION_MAX_AGE, OPERATOR_COOKIE),
  });
}

async function operatorCafes(env) {
  const { results } = await env.DB.prepare(
    "SELECT c.id, c.slug, c.name, c.service_mode, c.archived_at, " +
      "(SELECT COUNT(*) FROM menu_items m WHERE m.cafe_id = c.id) AS menu_count, " +
      "(SELECT COUNT(*) FROM orders o WHERE o.cafe_id = c.id) AS order_count, " +
      "(SELECT COUNT(*) FROM orders o WHERE o.cafe_id = c.id AND o.status IN ('new', 'preparing', 'ready')) AS open_count " +
      "FROM cafes c ORDER BY c.name ASC"
  ).all();

  const primaryId = await primaryCafeId(env);
  const rows = (results || []).map((row) => ({
    slug: row.slug,
    name: row.name,
    serviceMode: row.service_mode === "counter" ? "counter" : "tables",
    menuCount: row.menu_count,
    orderCount: row.order_count,
    openCount: row.open_count,
    primary: Number(row.id) === primaryId,
    archivedAt: row.archived_at == null ? null : Number(row.archived_at),
  }));
  return json({
    cafes: rows.filter((row) => row.archivedAt === null).map(({ archivedAt, ...row }) => row),
    archived: rows.filter((row) => row.archivedAt !== null),
  });
}

/* ------------------------------------------------- operator: remove a café */

const REMOVE_UNVERIFIED = "That request couldn't be verified. Reload the console and try again.";
const REMOVE_CONFLICT = "That café changed while you were working. Reload and try again.";

// Who did it, without any credential: a short digest of the operator session id, which tells
// sessions apart in the audit log and cannot be replayed.
async function operatorAuditSubject(request, env) {
  const claims = await tokenClaims(env, readCookie(request, OPERATOR_COOKIE));
  const sessionId = claims ? operatorSessionIdFromSubject(claims.subject) : null;
  return sessionId ? `operator:${(await sha256Hex(sessionId)).slice(0, 12)}` : null;
}

async function removalDetail(request, cafe) {
  return JSON.stringify({ slug: cafe.slug, name: cafe.name, ip: (await clientIpHash(request)).slice(0, 16) });
}

// The café's session ids, as the digests their CSRF tokens are bound to.
async function cafeSessionCsrfHashes(env, cafeId) {
  const { results } = await env.DB.prepare("SELECT session_id FROM owner_sessions WHERE cafe_id = ?")
    .bind(cafeId)
    .all();
  return Promise.all((results || []).map((row) => sha256Hex(String(row.session_id))));
}

// The shared front half of archive, restore and delete: CSRF and Origin, the slug, the typed slug.
async function removalRequest(request, env, rawSlug) {
  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) return { response: json({ error: REMOVE_UNVERIFIED }, 403) };
  const slug = String(rawSlug || "").toLowerCase();
  const cafe = await findCafeBySlug(env, slug, { includeArchived: true });
  if (!cafe) return { response: json({ error: "No café found at that web address." }, 404) };
  const body = (await readJson(request, BODY_LIMITS.operatorRemove)) || {};
  if (String(body.confirmSlug || "").trim().toLowerCase() !== cafe.slug) {
    return {
      response: json({ error: `Type the café's web address (${cafe.slug}) to confirm.`, code: "confirm_slug" }, 400),
    };
  }
  const subject = await operatorAuditSubject(request, env);
  if (!subject) return { response: json({ error: "Sign in to the operator console." }, 401) };
  return { cafe, body, subject, primary: Number(cafe.id) === (await primaryCafeId(env)) };
}

function primaryRefusal() {
  return json(
    { error: "This is the main café that your bare web address opens, so it can't be removed.", code: "primary_cafe" },
    409
  );
}

async function operatorArchiveCafe(request, env, rawSlug) {
  const req = await removalRequest(request, env, rawSlug);
  if (req.response) return req.response;
  const { cafe, subject } = req;
  if (req.primary) return primaryRefusal();
  if (cafe.archived_at != null) return json({ error: "That café is already archived.", code: "already_archived" }, 409);

  const now = Date.now();
  let results;
  try {
    results = await env.DB.batch(
      archiveStatements(env, {
        cafeId: cafe.id,
        now,
        subject,
        detail: await removalDetail(request, cafe),
        csrfKeyHashes: await cafeSessionCsrfHashes(env, cafe.id),
      })
    );
  } catch (err) {
    console.error("Café archive failed", { cafeId: cafe.id, error: err && err.message ? err.message : String(err) });
    return json({ error: "We couldn't archive that café. Nothing was changed." }, 500);
  }
  if (Number(results && results[0] && results[0].meta && results[0].meta.changes) !== 1) {
    return json({ error: REMOVE_CONFLICT }, 409);
  }
  return json({ ok: true, slug: cafe.slug, archivedAt: now });
}

async function operatorRestoreCafe(request, env, rawSlug) {
  const req = await removalRequest(request, env, rawSlug);
  if (req.response) return req.response;
  const { cafe, subject } = req;
  if (cafe.archived_at == null) return json({ error: "That café isn't archived.", code: "not_archived" }, 409);

  try {
    await env.DB.batch(
      restoreStatements(env, { cafeId: cafe.id, now: Date.now(), subject, detail: await removalDetail(request, cafe) })
    );
  } catch (err) {
    if (isRemovalGuardFailure(err)) return json({ error: REMOVE_CONFLICT }, 409);
    console.error("Café restore failed", { cafeId: cafe.id, error: err && err.message ? err.message : String(err) });
    return json({ error: "We couldn't restore that café. Nothing was changed." }, 500);
  }
  return json({ ok: true, slug: cafe.slug });
}

async function operatorDeleteCafe(request, env, rawSlug) {
  const req = await removalRequest(request, env, rawSlug);
  if (req.response) return req.response;
  const { cafe, body, subject } = req;
  if (req.primary) return primaryRefusal();
  if (cafe.archived_at == null) {
    return json({ error: "Archive the café before deleting it permanently.", code: "not_archived" }, 409);
  }
  if (String(body.confirmDelete || "").trim().toLowerCase() !== `delete ${cafe.slug}`) {
    return json({ error: `Type "delete ${cafe.slug}" to confirm.`, code: "confirm_delete" }, 400);
  }

  // Photos are read before the rows that name them go, and removed only after the delete commits,
  // so a failed delete never leaves menu items pointing at missing photos.
  const { results: photos } = await env.DB.prepare(
    "SELECT image_key FROM menu_items WHERE cafe_id = ? AND image_key IS NOT NULL"
  )
    .bind(cafe.id)
    .all();

  try {
    await env.DB.batch(
      deleteStatements(env, {
        cafeId: cafe.id,
        now: Date.now(),
        subject,
        detail: await removalDetail(request, cafe),
        csrfKeyHashes: await cafeSessionCsrfHashes(env, cafe.id),
      })
    );
  } catch (err) {
    if (isRemovalGuardFailure(err)) return json({ error: REMOVE_CONFLICT }, 409);
    console.error("Café delete failed", { cafeId: cafe.id, error: err && err.message ? err.message : String(err) });
    return json({ error: "We couldn't delete that café. Nothing was changed." }, 500);
  }

  let photosLeft = 0;
  if (env.IMAGES) {
    const prefix = `cafes/${Number(cafe.id)}/`;
    for (const row of photos || []) {
      const key = String(row.image_key);
      // Only keys inside this café's own prefix are touched, whatever a row says.
      if (!key.startsWith(prefix)) continue;
      try {
        await env.IMAGES.delete(key);
      } catch (err) {
        photosLeft += 1;
        console.error("Café photo cleanup failed", { cafeId: cafe.id, error: err && err.message ? err.message : String(err) });
      }
    }
  }
  return json({ ok: true, slug: cafe.slug, photosLeft });
}

async function operatorCreateCafe(request, env) {
  // Café creation is a state-changing operator action, so it needs the same CSRF proof as a
  // password reset: an Origin that matches this deployment and a live token bound to the
  // operator session cookie that sent it.
  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);
  }

  const body = await readJson(request, BODY_LIMITS.operatorCafe);
  if (!body) return json({ error: "We couldn't read those details." }, 400);

  try {
    const cafe = await createCafe(env, {
      name: body.name,
      slug: body.slug,
      password: body.password,
      serviceMode: body.serviceMode,
      tables: body.tables,
    });

    return json({ cafe: { ...publicCafe(cafe), url: `/c/${cafe.slug}` } }, 201);
  } catch (error) {
    return json({ error: error.message || "We couldn't create that café." }, 400);
  }
}

/* ---------------------------------------------------------------- customer */

// Guests identify a table by its café-facing number, which restarts at 1 for every tenant.
async function getMenu(env, url, cafe) {
  const tableParam = url.searchParams.get("table");
  let table = null;

  if (tableParam) {
    table = await env.DB.prepare("SELECT id, number, label, seats FROM tables WHERE cafe_id = ? AND number = ?")
      .bind(cafe.id, Number(tableParam))
      .first();
    if (!table) return json({ error: "We couldn't find that table. Please scan the QR code again." }, 404);
  }

  const { results } = await env.DB.prepare(
    "SELECT id, category, name, description, price_cents, emoji, available, image_key, image_updated_at FROM menu_items WHERE cafe_id = ? ORDER BY sort ASC, name ASC"
  )
    .bind(cafe.id)
    .all();

  const categories = [];
  const byName = new Map();
  for (const row of results) {
    if (!byName.has(row.category)) {
      const category = { name: row.category, items: [] };
      byName.set(row.category, category);
      categories.push(category);
    }
    byName.get(row.category).items.push({
      id: row.id,
      name: row.name,
      description: row.description,
      priceCents: row.price_cents,
      emoji: row.emoji,
      available: Boolean(row.available),
      imageUrl: itemImageUrl(cafe, row.id, row.image_key, row.image_updated_at),
      hasCustomImage: Boolean(row.image_key),
    });
  }

  return json({
    table: table ? { id: table.number, label: table.label, seats: table.seats } : null,
    categories,
  });
}

async function getTables(env, cafe) {
  const { results } = await env.DB.prepare(
    "SELECT number AS id, label, seats FROM tables WHERE cafe_id = ? ORDER BY number ASC"
  )
    .bind(cafe.id)
    .all();
  return json({ tables: results });
}

function razorpayConfigured(env) {
  return Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);
}

// This deployment sells the Razorpay version and nothing else. The direct-UPI board lives in a
// separate build, so a guest here can never be sent to a UPI ID that no one is watching.
function paymentProvider(env) {
  return razorpayConfigured(env) ? "razorpay" : "none";
}

// Table service or counter service. Both are decided per café from the staff panel and stored in
// D1; SERVICE_MODE only supplies the starting value for a deployment that has never been edited.
function getConfig(env, cafe) {
  const provider = paymentProvider(env);
  const settings = cafeSettings(cafe);

  return json({
    currency: "INR",
    slug: cafe.slug,
    cafe: {
      name: settings.cafeName,
      phone: settings.contactPhone,
      email: settings.contactEmail,
      address: settings.contactAddress,
    },
    service: { mode: settings.serviceMode },
    // Whether this deployment can accept an order at all. Checkout fails closed with a 503 while no
    // tracking key is configured, so the menu says so up front instead of after the guest fills a cart.
    // A boolean only: it never reveals which secret is missing.
    ordering: { available: trackingConfigured(env) },
    // Which sign-in this café uses, so the board can show the right entry point. A mode label only:
    // no identity, token, secret or provider session value is ever part of this payload.
    ownerAuth: cafe.owner_auth === "workos" ? "workos" : "local",
    payments: {
      provider,
      gateway: provider === "razorpay",
      keyId: provider === "razorpay" ? env.RAZORPAY_KEY_ID : null,
    },
  });
}

// Liveness probe for uptime checkers: no secrets, no menu contents, just whether the Worker and
// its database are answering.
async function health(env) {
  let database = "ok";
  try {
    await env.DB.prepare("SELECT 1 AS ok").first();
  } catch (err) {
    console.error("Health database check failed", err && err.message ? err.message : err);
    database = "unavailable";
  }

  return json(
    {
      status: database === "ok" ? "ok" : "degraded",
      database,
      time: new Date().toISOString(),
    },
    database === "ok" ? 200 : 503
  );
}

/* --------------------------------------------------- checkout idempotency */

// Logged once per isolate: a paused deployment would otherwise write a line per guest attempt.
let orderingPausedLogged = false;

function pausedResponse() {
  if (!orderingPausedLogged) {
    orderingPausedLogged = true;
    console.error("Ordering is disabled until the checkout unique indexes are verified");
  }
  return json(
    {
      error: "Ordering is paused while we finish a database upgrade. Please try again in a few minutes.",
      code: "ordering_paused",
    },
    503
  );
}

function keyReusedResponse() {
  return json(
    {
      error: "That checkout key was already used for a different order. Please reload the menu and start again.",
      code: "idempotency_key_reused",
    },
    409
  );
}

function abandonedResponse() {
  return json(
    { error: "This checkout was cancelled. Please reload the menu and start again.", code: "checkout_abandoned" },
    409
  );
}

function inProgressResponse() {
  return json(
    { error: "We're still finishing your last attempt. Please try again in a second.", code: "checkout_in_progress" },
    409,
    { "retry-after": "1" }
  );
}

// The shape getOrder() returns, so a replay and a first response look identical to the browser.
async function orderPayload(env, cafe, orderId) {
  const order = await env.DB.prepare(
    "SELECT o.id, o.table_label, o.status, o.total_cents, o.payment_method, o.payment_status, o.queue_no, o.created_at, t.number AS table_number " +
      "FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = ? AND o.cafe_id = ?"
  )
    .bind(orderId, cafe.id)
    .first();

  if (!order) return null;

  const { results: items } = await env.DB.prepare(
    "SELECT name, emoji, price_cents, qty FROM order_items WHERE order_id = ? ORDER BY id ASC"
  )
    .bind(orderId)
    .all();

  return {
    id: order.id,
    tableId: order.table_number == null ? null : order.table_number,
    tableLabel: order.table_label,
    queueNo: order.queue_no == null ? null : order.queue_no,
    status: order.status,
    totalCents: order.total_cents,
    paymentMethod: order.payment_method || "counter",
    paymentStatus: order.payment_status || "unpaid",
    createdAt: order.created_at,
    items: (items || []).map((item) => ({
      name: item.name,
      emoji: item.emoji,
      priceCents: item.price_cents,
      qty: item.qty,
    })),
  };
}

// The capability a guest needs to read or pay for one order. It is recomputed from the stored nonce, so
// a replay hands back the same token without the plaintext ever being persisted. Null means the order
// predates tracking, and such an order stays unreadable to guests rather than becoming id-only again.
async function orderTrackToken(env, cafeId, orderId) {
  const row = await env.DB.prepare("SELECT track_nonce FROM orders WHERE id = ? AND cafe_id = ?")
    .bind(orderId, cafeId)
    .first();
  if (!row || !row.track_nonce) return null;
  return trackToken(env, { cafeId, orderId, nonce: row.track_nonce });
}

// The one gate every guest read and mutation of a single order goes through. A missing token, a wrong
// token, a legacy row with no hash and an id that does not exist all take the same path: the caller
// gets null, and the handler answers with one generic 404, so nothing here confirms an id exists.
async function authorisedOrder(env, cafe, id, token) {
  if (!token) return null;
  const order = await env.DB.prepare(
    "SELECT id, status, payment_status, track_hash FROM orders WHERE id = ? AND cafe_id = ?"
  )
    .bind(id, cafe.id)
    .first();
  if (!order || !order.track_hash) return null;
  if (!constantTimeEqual(await trackHash(token), String(order.track_hash))) return null;
  return order;
}

async function replayedOrderResponse(env, cafe, orderId) {
  const payload = await orderPayload(env, cafe, orderId);
  if (!payload) {
    console.error("Committed checkout points at a missing order", { cafeId: cafe.id, orderId });
    return json(
      { error: "We couldn't load that order. Please ask our staff for help.", code: "checkout_inconsistent" },
      500
    );
  }
  // The same order, the same token: derived from its stored nonce, never remembered in plaintext.
  return json({ order: payload, trackToken: await orderTrackToken(env, cafe.id, orderId) }, 200);
}

// Abandonment answers with a terminal fact, so a committed key says so explicitly instead of
// returning the bare order shape that a POST replay uses.
async function committedAbandonResponse(env, cafe, orderId) {
  const payload = await orderPayload(env, cafe, orderId);
  if (!payload) {
    console.error("Committed checkout points at a missing order", { cafeId: cafe.id, orderId });
    return json(
      { error: "We couldn't load that order. Please ask our staff for help.", code: "checkout_inconsistent" },
      500
    );
  }
  return json(
    { status: "committed", order: payload, trackToken: await orderTrackToken(env, cafe.id, orderId) },
    200
  );
}

async function createOrder(request, env, cafe) {
  const headerKey = (request.headers.get("idempotency-key") || "").trim();
  const body = await readJson(request, BODY_LIMITS.checkout);
  if (!body) return json({ error: "We couldn't read that order." }, 400);

  // Without a tracking key no token can be issued, and an order the guest cannot ever read back is not
  // worth creating. Fail closed with something an operator can act on.
  if (!trackingConfigured(env)) {
    return json({ error: "Ordering isn't configured on this deployment. Please ask our staff." }, 503);
  }

  if (!isIdempotencyIndexReady()) return pausedResponse();
  if (headerKey.length > 100) return json({ error: "That checkout key isn't valid.", code: "invalid_key" }, 400);

  const settings = cafeSettings(cafe);
  const counter = settings.serviceMode === "counter";

  // A counter-service café has no tables to claim, so a table id here is a mistake, not a hint.
  if (counter && body.tableId) return json({ error: "This café takes pickup orders — no table is needed." }, 400);

  const normalized = normalizeCheckoutBody(body, { counter });
  if (normalized.error === "empty") return json({ error: "Your order is empty." }, 400);
  if (normalized.error === "too_many") return json({ error: "That's a big order — please split it into two." }, 400);
  if (normalized.error === "payment_method") return json({ error: "Choose a supported payment method." }, 400);
  if (normalized.error) return json({ error: "One of those items isn't valid." }, 400);
  if (normalized.paymentMethod === "razorpay" && !razorpayConfigured(env)) {
    return json({ error: "Online payments aren't switched on yet." }, 503);
  }

  // Transitional: a client from before the key existed still gets an order, with no retry protection
  // — but it gets a fingerprint, so no unverifiable row is ever written again.
  const idempotencyKey = headerKey || crypto.randomUUID();
  const lease = crypto.randomUUID();
  const now = new Date().toISOString();

  const fingerprint = await orderFingerprint({
    cafeId: cafe.id,
    counter,
    tableId: normalized.tableId,
    note: normalized.note,
    paymentMethod: normalized.paymentMethod,
    wanted: normalized.wanted,
  });

  const existing = await claimReadStatement(env, { cafeId: cafe.id, key: idempotencyKey }).first();
  if (existing) {
    if (existing.fingerprint !== fingerprint) return keyReusedResponse();
    if (existing.state === "committed") return replayedOrderResponse(env, cafe, existing.order_id);
    if (existing.state === "abandoned") return abandonedResponse();

    const staleBefore = new Date(Date.now() - CLAIM_LEASE_MS).toISOString();
    const took = await takeoverStatement(env, {
      cafeId: cafe.id,
      key: idempotencyKey,
      fingerprint,
      lease,
      now,
      staleBefore,
    }).run();
    if (Number(took.meta && took.meta.changes) !== 1) return inProgressResponse();
  } else {
    const claimed = await claimStatement(env, {
      cafeId: cafe.id,
      key: idempotencyKey,
      fingerprint,
      lease,
      now,
    }).run();

    if (Number(claimed.meta && claimed.meta.changes) !== 1) {
      const raced = await claimReadStatement(env, { cafeId: cafe.id, key: idempotencyKey }).first();
      if (!raced) return inProgressResponse();
      if (raced.fingerprint !== fingerprint) return keyReusedResponse();
      if (raced.state === "committed") return replayedOrderResponse(env, cafe, raced.order_id);
      if (raced.state === "abandoned") return abandonedResponse();
      return inProgressResponse();
    }
  }

  // A key from before the claims table may already own an order. Its fingerprint decides.
  const legacy = await env.DB.prepare(
    "SELECT id, fingerprint FROM orders WHERE cafe_id = ? AND idempotency_key = ? AND idempotency_key IS NOT NULL"
  )
    .bind(cafe.id, idempotencyKey)
    .first();

  if (legacy) {
    if (legacy.fingerprint == null) {
      // No fingerprint means no way to prove this is the same checkout, so it is never a replay.
      await releaseStatement(env, { cafeId: cafe.id, key: idempotencyKey, lease }).run();
      console.error("Checkout key matches a legacy order with no fingerprint", { cafeId: cafe.id, orderId: legacy.id });
      return json(
        {
          error: "We couldn't verify this checkout. Please start a new order, or ask our staff to look it up.",
          code: "checkout_unverified",
        },
        409
      );
    }

    if (legacy.fingerprint !== fingerprint) {
      await releaseStatement(env, { cafeId: cafe.id, key: idempotencyKey, lease }).run();
      return keyReusedResponse();
    }

    const adopted = await commitClaimStatement(env, {
      cafeId: cafe.id,
      key: idempotencyKey,
      lease,
      orderId: legacy.id,
      now,
    }).run();
    if (Number(adopted.meta && adopted.meta.changes) === 1) return replayedOrderResponse(env, cafe, legacy.id);
    return inProgressResponse();
  }

  // Dine-in: the guest names a café-facing table number, the order stores the internal row.
  let table = null;
  if (!counter) {
    table = await env.DB.prepare("SELECT id, number, label FROM tables WHERE cafe_id = ? AND number = ?")
      .bind(cafe.id, Number(body.tableId))
      .first();
    if (!table) {
      await releaseStatement(env, { cafeId: cafe.id, key: idempotencyKey, lease }).run();
      return json({ error: "We couldn't find that table. Please scan the QR code again." }, 400);
    }
  }

  const ids = [...normalized.wanted.keys()];
  const placeholders = ids.map(() => "?").join(",");
  const { results: menuRows } = await env.DB.prepare(
    `SELECT id, name, emoji, price_cents, available FROM menu_items WHERE id IN (${placeholders}) AND cafe_id = ?`
  )
    .bind(...ids, cafe.id)
    .all();

  if (menuRows.length !== ids.length) {
    await releaseStatement(env, { cafeId: cafe.id, key: idempotencyKey, lease }).run();
    return json({ error: "One of those items is no longer on the menu." }, 400);
  }

  const soldOut = menuRows.find((row) => !row.available);
  if (soldOut) {
    await releaseStatement(env, { cafeId: cafe.id, key: idempotencyKey, lease }).run();
    return json({ error: `${soldOut.name} just sold out — please remove it to continue.` }, 409);
  }

  // Prices and quantities come from the menu row and the server's aggregation, never from the client.
  const totalCents = menuRows.reduce((sum, row) => sum + row.price_cents * normalized.wanted.get(row.id), 0);

  // Order id generation and the insert are separate statements, so two concurrent checkouts can both
  // observe the same candidate as free and both try to insert it. The orders.id primary key fails
  // closed (no duplicate, no cross-attached items), so we retry with a fresh id on that specific
  // collision. At most four total attempts (one initial plus three retries); any other D1 error is
  // not retried.
  const MAX_ATTEMPTS = 4;
  let id = null;
  let token = null;
  let succeeded = false;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    // Mint a fresh id. Capacity failure is terminal (not a collision) — release and 503.
    try {
      id = await freshOrderId(env);
    } catch (err) {
      if (!(err instanceof OrderIdUnavailableError)) throw err;
      await releaseStatement(env, { cafeId: cafe.id, key: idempotencyKey, lease }).run();
      return json({ error: "We couldn't create that order just now. Please try again." }, 503);
    }

    // A fresh nonce/token/hash per attempt, since the id changed.
    const trackNonce = newTrackNonce();
    const attemptToken = await trackToken(env, { cafeId: cafe.id, orderId: id, nonce: trackNonce });
    const trackHashValue = await trackHash(attemptToken);

    const statements = orderBatch(env, {
      id,
      cafeId: cafe.id,
      trackNonce,
      trackHash: trackHashValue,
      counter,
      tableId: counter ? 0 : table.id,
      tableLabel: counter ? "Counter" : table.label,
      note: normalized.note,
      totalCents,
      paymentMethod: normalized.paymentMethod,
      dayStart: cafeDayStart(settings.tzOffsetMin),
      key: idempotencyKey,
      fingerprint,
      lease,
      now,
      items: menuRows.map((row) => ({
        menuItemId: row.id,
        name: row.name,
        emoji: row.emoji,
        priceCents: row.price_cents,
        qty: normalized.wanted.get(row.id),
      })),
    });

    try {
      const results = await env.DB.batch(statements);
      const inserted = Number(results && results[0] && results[0].meta && results[0].meta.changes);

      if (inserted !== 1) {
        // The claim was abandoned or taken over between the reserve and the write. Do not retry;
        // the collision retry only applies to primary-key failures.
        const after = await claimReadStatement(env, { cafeId: cafe.id, key: idempotencyKey }).first();
        if (after && after.fingerprint !== fingerprint) return keyReusedResponse();
        if (after && after.state === "committed") return replayedOrderResponse(env, cafe, after.order_id);
        if (after && after.state === "abandoned") return abandonedResponse();
        return inProgressResponse();
      }

      // Success: remember the token and stop retrying.
      token = attemptToken;
      succeeded = true;
      break;
    } catch (err) {
      console.error("Order insert failed", {
        cafeId: cafe.id,
        orderId: id,
        error: err && err.message ? err.message : String(err),
      });

      // Only a primary-key collision on orders.id is retryable.
      if (isOrderIdCollision(err) && attempt < MAX_ATTEMPTS - 1) {
        continue;
      }

      const after = await claimReadStatement(env, { cafeId: cafe.id, key: idempotencyKey }).first();
      if (after && after.fingerprint !== fingerprint) return keyReusedResponse();
      if (after && after.state === "committed") return replayedOrderResponse(env, cafe, after.order_id);

      await releaseStatement(env, { cafeId: cafe.id, key: idempotencyKey, lease }).run();
      return json({ error: "We couldn't save that order. Please try again." }, 500);
    }
  }

  if (!succeeded) {
    await releaseStatement(env, { cafeId: cafe.id, key: idempotencyKey, lease }).run();
    return json({ error: "We couldn't save that order. Please try again." }, 500);
  }

  // The one place a plaintext token leaves the server, in the reply to the guest who just bought it.
  return json({ order: await orderPayload(env, cafe, id), trackToken: token }, 201);
}

// Settles a checkout whose cart has changed. It never creates an order, and it only answers with a
// terminal fact: this key produced an order, or this key can never produce one.
async function abandonCheckout(request, env, cafe, rawKey) {
  let key = String(rawKey || "");
  try {
    key = decodeURIComponent(key);
  } catch {
    return json({ error: "That checkout key isn't valid.", code: "invalid_key" }, 400);
  }
  key = key.trim();
  if (!key || key.length > 100) return json({ error: "That checkout key isn't valid.", code: "invalid_key" }, 400);

  if (!isIdempotencyIndexReady()) return pausedResponse();

  const body = await readJson(request, BODY_LIMITS.abandon);
  if (!body) return json({ error: "We couldn't read that checkout.", code: "invalid_payload" }, 400);

  const settings = cafeSettings(cafe);
  const counter = settings.serviceMode === "counter";
  const normalized = normalizeCheckoutBody(body, { counter });
  if (normalized.error) return json({ error: "That checkout doesn't look right.", code: "invalid_payload" }, 400);

  const fingerprint = await orderFingerprint({
    cafeId: cafe.id,
    counter,
    tableId: normalized.tableId,
    note: normalized.note,
    paymentMethod: normalized.paymentMethod,
    wanted: normalized.wanted,
  });
  const now = new Date().toISOString();

  // Fingerprint first, whatever the claim's state: a key reused with a different payload is a
  // conflict, never "abandoned" and never "committed".
  const claim = await claimReadStatement(env, { cafeId: cafe.id, key }).first();
  if (claim && claim.fingerprint !== fingerprint) return keyReusedResponse();

  // An order may already exist for this key, with or without a claim row. Decide that before any
  // tombstone can exist.
  const existing = await env.DB.prepare(
    "SELECT id, fingerprint FROM orders WHERE cafe_id = ? AND idempotency_key = ? AND idempotency_key IS NOT NULL"
  )
    .bind(cafe.id, key)
    .first();

  if (existing) {
    if (existing.fingerprint == null) {
      console.error("Checkout key matches a legacy order with no fingerprint", { cafeId: cafe.id, orderId: existing.id });
      return json(
        {
          error: "We couldn't verify this checkout. Please start a new order, or ask our staff to look it up.",
          code: "checkout_unverified",
        },
        409
      );
    }

    if (existing.fingerprint !== fingerprint) return keyReusedResponse();

    // Proven the same checkout. Adopt it, but only a row that has not reached a terminal state.
    if (!claim) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO checkout_claims (cafe_id, idempotency_key, fingerprint, state, lease, order_id, created_at, updated_at) " +
          "VALUES (?, ?, ?, 'committed', '', ?, ?, ?)"
      )
        .bind(cafe.id, key, fingerprint, existing.id, now, now)
        .run();
    } else if (claim.state === "claimed") {
      await env.DB.prepare(
        "UPDATE checkout_claims SET state = 'committed', order_id = ?, updated_at = ? " +
          "WHERE cafe_id = ? AND idempotency_key = ? AND state = 'claimed' AND fingerprint = ?"
      )
        .bind(existing.id, now, cafe.id, key, fingerprint)
        .run();
    } else if (claim.state === "abandoned") {
      // A tombstone beside a real order is a transition artefact. Report the order and leave the
      // terminal row alone, because a delayed POST relies on it staying abandoned.
      console.error("Abandoned claim shadows an existing order", { cafeId: cafe.id, orderId: existing.id });
    }

    return committedAbandonResponse(env, cafe, existing.id);
  }

  if (claim) {
    if (claim.state === "committed") return committedAbandonResponse(env, cafe, claim.order_id);
    if (claim.state === "abandoned") return json({ status: "abandoned" }, 200);

    const moved = await abandonClaimStatement(env, { cafeId: cafe.id, key, fingerprint, now }).run();
    if (Number(moved.meta && moved.meta.changes) === 1) return json({ status: "abandoned" }, 200);

    const reread = await claimReadStatement(env, { cafeId: cafe.id, key }).first();
    if (!reread) return inProgressResponse();
    if (reread.fingerprint !== fingerprint) return keyReusedResponse();
    if (reread.state === "abandoned") return json({ status: "abandoned" }, 200);
    if (reread.state === "committed") return committedAbandonResponse(env, cafe, reread.order_id);
    return inProgressResponse();
  }

  // Nothing exists for this key, so and only so may a tombstone be created.
  const stamped = await tombstoneStatement(env, { cafeId: cafe.id, key, fingerprint, now }).run();
  if (Number(stamped.meta && stamped.meta.changes) === 1) return json({ status: "abandoned" }, 200);

  const arrived = await claimReadStatement(env, { cafeId: cafe.id, key }).first();
  if (!arrived) return inProgressResponse();
  if (arrived.fingerprint !== fingerprint) return keyReusedResponse();
  if (arrived.state === "abandoned") return json({ status: "abandoned" }, 200);
  if (arrived.state === "committed") return committedAbandonResponse(env, cafe, arrived.order_id);
  return inProgressResponse();
}

async function getOrder(request, env, cafe, id) {
  // An id alone is never enough: the guest must present the capability issued at checkout.
  if (!(await authorisedOrder(env, cafe, id, readTrackToken(request)))) {
    return json({ error: "We couldn't find that order." }, 404);
  }

  // The guest sees the café-facing table number, not the internal row id.
  const order = await env.DB.prepare(
    "SELECT o.id, o.table_id, o.table_label, o.note, o.status, o.total_cents, o.payment_method, o.payment_status, o.paid_at, o.queue_no, o.created_at, t.number AS table_number " +
      "FROM orders o LEFT JOIN tables t ON t.id = o.table_id WHERE o.id = ? AND o.cafe_id = ?"
  )
    .bind(id, cafe.id)
    .first();

  if (!order) return json({ error: "We couldn't find that order." }, 404);

  const { results: items } = await env.DB.prepare(
    "SELECT name, emoji, price_cents, qty FROM order_items WHERE order_id = ? ORDER BY id ASC"
  )
    .bind(id)
    .all();

  return json({
    order: {
      id: order.id,
      tableId: order.table_number == null ? null : order.table_number,
      tableLabel: order.table_label,
      queueNo: order.queue_no == null ? null : order.queue_no,
      note: order.note,
      status: order.status,
      totalCents: order.total_cents,
      paymentMethod: order.payment_method || "counter",
      paymentStatus: order.payment_status || "unpaid",
      paidAt: order.paid_at,
      createdAt: order.created_at,
      items: items.map((item) => ({
        name: item.name,
        emoji: item.emoji,
        priceCents: item.price_cents,
        qty: item.qty,
      })),
    },
  });
}

// Besides paying online, a guest can choose to settle at the counter. There is no "I've paid"
// self-declaration any more: money either clears through Razorpay or staff take it in person.
async function submitPayment(request, env, cafe, id) {
  // The same capability that reads the order is required to change how it is paid for.
  const order = await authorisedOrder(env, cafe, id, readTrackToken(request));
  if (!order) return json({ error: "We couldn't find that order." }, 404);

  const body = await readJson(request, BODY_LIMITS.payment);
  // Choosing the counter is all a guest may do here. Confirming a payment belongs to the gateway or to
  // staff, never to the browser that placed the order.
  if (!body || body.status !== "counter") return json({ error: "Unknown payment option." }, 400);

  if (order.status === "cancelled") return json({ error: "This order was cancelled by the café." }, 409);

  // One conditional write instead of a check followed by a write: the guard is evaluated inside the
  // UPDATE, so a payment the gateway or staff confirmed between the read above and this statement
  // can never be replaced by the guest's counter choice. Zero changed rows means "already paid",
  // which is the same answer a sequential repeat gets.
  const written = await counterPaymentStatement(env, {
    cafeId: cafe.id,
    orderId: id,
    now: new Date().toISOString(),
  }).run();

  if (Number(written && written.meta && written.meta.changes) !== 1) {
    return json({ ok: true, paymentStatus: "confirmed" });
  }
  return json({ ok: true, paymentStatus: "counter" });
}

// The payment payload Checkout needs. Amount and currency come from the stored order and a
// constant: nothing a client sends can change what is being charged, because the request body is not
// read at all. The key id is the public half of the credential pair; the secret never leaves the Worker.
function razorpayPayment(order, razorpayOrderId, env, cafe) {
  return {
    payment: {
      provider: "razorpay",
      keyId: env.RAZORPAY_KEY_ID,
      razorpayOrderId,
      amount: order.total_cents,
      currency: "INR",
      name: cafeSettings(cafe).cafeName,
      description: `Order ${order.id} · ${order.table_label}`,
    },
  };
}

// Creates a Razorpay order for a ticket so Checkout can collect UPI/card and the webhook can confirm
// it without staff involvement. Knowing the id is not enough: the guest must present the tracking
// token issued at checkout, exactly as reading or paying the order requires.
async function createRazorpayPayment(request, env, cafe, id) {
  if (!razorpayConfigured(env) || paymentProvider(env) !== "razorpay") {
    return json({ error: "Online payments aren't switched on yet." }, 503);
  }

  // Missing, invalid, cross-order and cross-café tokens all leave through this one generic 404, so
  // nothing here confirms that an order id exists.
  const authorised = await authorisedOrder(env, cafe, id, readTrackToken(request));
  if (!authorised) return json({ error: "We couldn't find that order." }, 404);

  // Bounded per order rather than per address, so a shared café network cannot lock a table out and a
  // single ticket cannot reach the gateway in a loop.
  try {
    const attempt = await touchRateLimit(
      env,
      `pay:razorpay:${cafe.id}:${authorised.id}`,
      RAZORPAY_CREATE_MAX,
      RAZORPAY_CREATE_WINDOW_MS,
      RAZORPAY_CREATE_MAX + 1
    );
    if (attempt.count > RAZORPAY_CREATE_MAX) {
      return json({ error: "Too many payment attempts for this order. Please wait a few minutes." }, 429);
    }
  } catch (err) {
    console.error("Payment rate-limit check failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "We couldn't start that payment. Please try again." }, 503);
  }

  // The amount charged is this row's total: the same number the guest was quoted. Verification later
  // compares the captured amount against it again.
  const order = await env.DB.prepare(
    "SELECT id, table_label, status, total_cents, payment_status, payment_method, payment_ref FROM orders WHERE id = ? AND cafe_id = ?"
  )
    .bind(id, cafe.id)
    .first();

  if (!order) return json({ error: "We couldn't find that order." }, 404);
  if (order.payment_status === "confirmed") return json({ error: "This order is already paid." }, 409);
  if (order.status === "cancelled") return json({ error: "This order was cancelled by the café." }, 409);

  // A retry, a duplicate tap or a reopened Checkout reuses the gateway order already attached to this
  // ticket instead of creating a second payable artefact. Nothing is written and the same id returns.
  if (order.payment_method === "razorpay" && order.payment_ref) {
    return json(razorpayPayment(order, order.payment_ref, env, cafe), 200);
  }

  // From here the request is about to spend a gateway call, so it must hold the per-order claim. A
  // request that cannot take it is overlapping one that can, and its own gateway order would be a
  // duplicate of the one about to be persisted.
  const claimKey = `payclaim:razorpay:${cafe.id}:${authorised.id}`;
  let claimOwner;
  try {
    claimOwner = await claimPaymentCreation(env, claimKey, PAYMENT_CLAIM_TTL_MS);
  } catch (err) {
    console.error("Payment claim failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "We couldn't start that payment. Please try again." }, 503);
  }
  if (!claimOwner) {
    // The request that holds the claim is still talking to the gateway. Its id will land in this row,
    // so the guest retries shortly instead of receiving a second payable order.
    return json(
      { error: "A payment for this order is already being prepared. Please try again in a moment." },
      409
    );
  }

  // A gateway call can legitimately outlast one TTL. Renewal keeps the claim alive while this request
  // is still working, so a slow call does not hand the ticket to a second caller mid-flight.
  const renewal = setInterval(() => {
    renewPaymentClaim(env, claimKey, claimOwner, PAYMENT_CLAIM_TTL_MS).catch((err) => {
      console.error("Payment claim renewal failed", { error: err && err.message ? err.message : String(err) });
    });
  }, PAYMENT_CLAIM_RENEW_MS);

  try {
    // Re-read under the claim: a request that finished between the first read and the claim may have
    // written payment_ref already, and that id must win over a fresh gateway order.
    const current = await env.DB.prepare(
      "SELECT id, table_label, status, total_cents, payment_status, payment_method, payment_ref FROM orders WHERE id = ? AND cafe_id = ?"
    )
      .bind(id, cafe.id)
      .first();

    if (!current) return json({ error: "We couldn't find that order." }, 404);
    if (current.payment_status === "confirmed") return json({ error: "This order is already paid." }, 409);
    if (current.status === "cancelled") return json({ error: "This order was cancelled by the café." }, 409);
    if (current.payment_method === "razorpay" && current.payment_ref) {
      return json(razorpayPayment(current, current.payment_ref, env, cafe), 200);
    }

    let response;
    try {
      response = await fetch(`${RAZORPAY_API}/orders`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`,
        },
        body: JSON.stringify({
          amount: current.total_cents,
          currency: "INR",
          receipt: current.id,
          notes: { order_id: current.id, table: current.table_label },
        }),
        // Aborted at the 15s bound. There is deliberately no retry: an aborted call says nothing about
        // whether Razorpay created the order, so retrying here could mint a second payable order.
        signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
      });
    } catch (err) {
      if (err && (err.name === "TimeoutError" || err.name === "AbortError")) {
        console.error("Razorpay order request timed out", { orderId: current.id });
        return json({ error: "The payment gateway took too long to answer. Please try again." }, 504);
      }
      console.error("Razorpay order request failed", err);
      return json({ error: "Couldn't reach the payment gateway. Please try again." }, 502);
    }

    if (!response.ok) {
      console.error("Razorpay order rejected", response.status, await response.text());
      return json({ error: "The payment gateway rejected this order. Please try again." }, 502);
    }

    const data = await response.json().catch(() => null);
    if (!data || !data.id) {
      console.error("Razorpay order response carried no id");
      return json({ error: "The payment gateway rejected this order. Please try again." }, 502);
    }

    // L-1: ownership is enforced inside the write, not in a statement before it. The UPDATE only
    // matches while this request still holds the claim, so a request whose claim expired and was
    // reclaimed cannot overwrite the newer owner's payment_ref. The confirmed guard keeps a paid
    // ticket from being pointed at a fresh gateway order. Zero rows means the claim moved on or the
    // order is no longer payable.
    const persisted = await env.DB.prepare(
      "UPDATE orders SET payment_method = 'razorpay', payment_ref = ?, updated_at = ? " +
        "WHERE id = ? AND cafe_id = ? AND payment_status != 'confirmed' " +
        "AND EXISTS (SELECT 1 FROM rate_limits WHERE key = ? AND owner = ?)"
    )
      .bind(data.id, new Date().toISOString(), id, cafe.id, claimKey, claimOwner)
      .run();

    if (Number(persisted.meta && persisted.meta.changes) !== 1) {
      return json(
        { error: "A payment for this order is already being prepared. Please try again in a moment." },
        409
      );
    }

    return json(razorpayPayment(current, data.id, env, cafe), 200);
  } finally {
    // Every exit path releases the claim, including a failed gateway call, so a retry is never blocked
    // by a request that never produced an id. The delete is owner-scoped, so a request that lost the
    // claim leaves the newer one untouched.
    clearInterval(renewal);
    await releasePaymentClaim(env, claimKey, claimOwner);
  }
}

// Checkout hands the browser a signed triple (order id, payment id, signature). Verifying it
// here lets the ticket settle the moment the money is captured, without waiting for a webhook —
// which matters because a fresh Razorpay account has no webhook configured yet.
async function verifyRazorpayPayment(request, env, cafe, id, ctx) {
  if (!razorpayConfigured(env) || paymentProvider(env) !== "razorpay") {
    return json({ error: "Online payments aren't switched on yet." }, 503);
  }

  const body = await readJson(request, BODY_LIMITS.paymentVerify);
  if (!body) return json({ error: "We couldn't read that payment." }, 400);

  const razorpayOrderId = String(body.razorpay_order_id || "");
  const razorpayPaymentId = String(body.razorpay_payment_id || "");
  const signature = String(body.razorpay_signature || "");
  if (!razorpayOrderId || !razorpayPaymentId || !signature) {
    return json({ error: "That payment looks incomplete." }, 400);
  }

  const order = await env.DB.prepare(
    "SELECT id, total_cents, payment_status, payment_ref FROM orders WHERE id = ? AND cafe_id = ?"
  )
    .bind(id, cafe.id)
    .first();

  if (!order) return json({ error: "We couldn't find that order." }, 404);
  if (order.payment_status === "confirmed") return json({ ok: true, paymentStatus: "confirmed" });
  if (order.payment_ref !== razorpayOrderId) {
    return json({ error: "That payment doesn't belong to this order." }, 409);
  }

  const expected = await hmacHex(env.RAZORPAY_KEY_SECRET, `${razorpayOrderId}|${razorpayPaymentId}`);
  if (!constantTimeEqual(signature, expected)) {
    return json({ error: "That payment couldn't be verified." }, 400);
  }

  // The signature proves Razorpay produced it; the amount and status still come from Razorpay.
  let payment;
  try {
    const response = await fetch(`${RAZORPAY_API}/payments/${encodeURIComponent(razorpayPaymentId)}`, {
      headers: { authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}` },
    });
    if (!response.ok) {
      console.error("Razorpay payment lookup failed", response.status, await response.text());
      return json({ error: "We couldn't confirm this payment with Razorpay yet." }, 502);
    }
    payment = await response.json();
  } catch (err) {
    console.error("Razorpay payment lookup failed", err);
    return json({ error: "Couldn't reach the payment gateway. Please try again." }, 502);
  }

  if (payment.order_id && payment.order_id !== razorpayOrderId) {
    return json({ error: "That payment doesn't belong to this order." }, 409);
  }

  if (payment.currency && payment.currency !== "INR") {
    console.error("Razorpay currency mismatch", { order: order.id, received: payment.currency });
    return json({ ok: true, paymentStatus: "unpaid", reason: "currency-mismatch" });
  }

  if (payment.status !== "captured") {
    return json({ ok: true, paymentStatus: "unpaid", state: payment.status || null });
  }

  // Not "at least": a ticket settles only for exactly what it is owed.
  if (Number(payment.amount) !== order.total_cents) {
    console.error("Razorpay amount mismatch", { order: order.id, expected: order.total_cents, received: payment.amount });
    return json({ ok: true, paymentStatus: "unpaid", reason: "amount-mismatch" });
  }

  await markRazorpayPaid(env, cafe, order.id, razorpayOrderId, razorpayPaymentId, ctx);
  return json({ ok: true, paymentStatus: "confirmed" });
}

// The single place a Razorpay ticket becomes paid, shared by the browser verification and the
// webhook. The `payment_status != 'confirmed'` guard makes repeated events a no-op, which is what
// keeps the owner alert from firing twice for one payment.
async function markRazorpayPaid(env, cafe, orderId, razorpayOrderId, paymentId, ctx) {
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE orders SET payment_status = 'confirmed', payment_method = 'razorpay', payment_ref = ?, payment_txn = ?, paid_at = ?, updated_at = ? WHERE id = ? AND cafe_id = ? AND payment_status != 'confirmed'"
  )
    .bind(razorpayOrderId, paymentId, now, now, orderId, cafe.id)
    .run();

  const changed = Boolean(result.meta && result.meta.changes);
  if (changed) notifyOwnerPaid(env, cafe, orderId, paymentId, ctx);
  return changed;
}

// Telegram is opt-in and never allowed to break a payment: the order is already paid by the time
// this runs, so a send failure is retried and then logged without the token.
async function notifyOwnerPaid(env, cafe, orderId, paymentId, ctx) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_OWNER_CHAT_ID) return;

  // The order is already paid. Slow retries belong after the response, not in front of a webhook
  // ack that Razorpay times out.
  const job = sendOwnerAlert(env, cafe, orderId, paymentId);
  if (ctx && typeof ctx.waitUntil === "function") {
    ctx.waitUntil(job);
    return;
  }
  await job;
}

async function sendOwnerAlert(env, cafe, orderId, paymentId) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_OWNER_CHAT_ID;
  if (!token || !chatId) return;

  const order = await env.DB.prepare("SELECT id, table_label, total_cents FROM orders WHERE id = ? AND cafe_id = ?")
    .bind(orderId, cafe.id)
    .first();
  if (!order) return;

  const { results: items } = await env.DB.prepare(
    "SELECT name, qty FROM order_items WHERE order_id = ? ORDER BY id ASC"
  )
    .bind(orderId)
    .all();

  const text = [
    "✅ Paid order",
    `${order.table_label} · #${order.id}`,
    items.map((item) => `${item.qty}× ${item.name}`).join("\n"),
    `Total ₹${(Number(order.total_cents) / 100).toFixed(2)}`,
    paymentId ? `Payment ${paymentId}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
      });
      if (response.ok) return;
      console.error("Telegram rejected the order alert", response.status);
    } catch (err) {
      console.error("Telegram order alert failed", err && err.message ? err.message : err);
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
}

// Razorpay signs the raw body with the webhook secret; nothing is trusted until that checks out.
async function razorpayWebhook(request, env, cafe, ctx) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return json({ error: "Webhook is not configured." }, 503);

  const raw = await readText(request, BODY_LIMITS.webhook);
  const signature = request.headers.get("x-razorpay-signature") || "";
  const expected = await hmacHex(secret, raw);

  if (!signature || !constantTimeEqual(signature, expected)) {
    return json({ error: "Invalid signature." }, 400);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid payload." }, 400);
  }

  const payment = event && event.payload && event.payload.payment ? event.payload.payment.entity : null;
  const razorpayOrder = event && event.payload && event.payload.order ? event.payload.order.entity : null;
  const ourOrderId =
    (payment && payment.notes && payment.notes.order_id) || (razorpayOrder && razorpayOrder.receipt) || null;

  if (!ourOrderId) return json({ ok: true, ignored: "no-order-reference" });

  const order = await env.DB.prepare(
    "SELECT id, total_cents, payment_status FROM orders WHERE id = ? AND cafe_id = ?"
  )
    .bind(ourOrderId, cafe.id)
    .first();

  if (!order) return json({ ok: true, ignored: "unknown-order" });

  if (event.event === "payment.captured" || event.event === "order.paid") {
    const amount = Number((payment && payment.amount) || (razorpayOrder && razorpayOrder.amount_paid) || 0);
    const currency = (payment && payment.currency) || (razorpayOrder && razorpayOrder.currency) || "INR";

    if (currency !== "INR" || !Number.isFinite(amount) || amount !== order.total_cents) {
      console.error("Razorpay amount mismatch", { order: ourOrderId, expected: order.total_cents, received: amount, currency });
      // Acknowledge so Razorpay stops retrying — this event can never settle this ticket.
      return json({ ok: true, ignored: "amount-mismatch" });
    }

    if (order.payment_status === "confirmed") return json({ ok: true, alreadyConfirmed: true });

    const razorpayOrderId = (payment && payment.order_id) || (razorpayOrder && razorpayOrder.id) || null;
    await markRazorpayPaid(env, cafe, ourOrderId, razorpayOrderId, (payment && payment.id) || null, ctx);

    return json({ ok: true, confirmed: true });
  }

  if (event.event === "payment.failed") {
    if (order.payment_status !== "confirmed") {
      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE orders SET payment_status = 'failed', payment_method = 'razorpay', payment_txn = ?, updated_at = ? WHERE id = ? AND cafe_id = ? AND payment_status != 'confirmed'"
      )
        .bind((payment && payment.id) || null, now, ourOrderId, cafe.id)
        .run();
    }
    // A failed attempt is not an error: the guest can try again, so stop Razorpay retrying.
    return json({ ok: true, failed: true });
  }

  return json({ ok: true, ignored: event.event || "unknown-event" });
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/* ------------------------------------------------------------------- staff */

// Durable rate-limit windows and thresholds. These are intentionally unchanged from the previous
// in-memory implementation; only the storage moved to D1 so counters survive isolate restarts.
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_MAX_FAILURES = 8;

// Sign-in answers shared by the owner and operator pages, so both say the same thing for the same case.
// None of them depends on which café was asked for: an unknown café is already a 404 on every café URL.
const SIGNIN_WRONG_PASSWORD = "Incorrect password. Please try again.";
const SIGNIN_NOT_SET_UP = "Sign-in isn't set up yet. Please contact support.";

// A café without an owner password also tells the reader what has to happen, so support knows the fix.
const SIGNIN_OWNER_NOT_SET =
  "Sign-in isn't set up yet for this café. Please contact support — the operator needs to set an owner password.";

function signinNotSetUp(message = SIGNIN_NOT_SET_UP) {
  return json({ error: message, code: "signin_not_configured" }, 503);
}

// A locked-out sign-in says when it can be tried again, from the lockout row's own expiry, and sends the
// standard Retry-After header. The lockout itself (count, window, key) is unchanged.
function signinLockedOut(expires) {
  const seconds = Math.max(1, Math.ceil((Number(expires) - Date.now()) / 1000));
  const minutes = Math.ceil(seconds / 60);
  return json(
    {
      error: `Too many attempts. Please try again in ${minutes} ${minutes === 1 ? "minute" : "minutes"}.`,
      code: "signin_locked",
      retryAfter: seconds,
    },
    429,
    { "retry-after": String(seconds) }
  );
}
const API_WINDOW_MS = 60 * 1000;
// A ceiling, not a throttle: every guest in the café shares one public IP across the NAT, and the
// order page polls while a ticket is open, so a low number would lock out a busy room.
const API_MAX_REQUESTS = 600;

// Reads use the same ceiling but not the same storage. A per-request D1 row for polling cost a write
// every four seconds per open board (see RATE_LIMIT_CAPACITY_REPORT.md), so reads are counted in the
// isolate that serves them and writes — the low-volume, abuse-relevant half — stay durable.
const READ_METHODS = new Set(["GET", "HEAD"]);
const API_READ_WINDOW_MS = 60 * 1000;
const API_READ_MAX_REQUESTS = 600;
// Bound on the number of client windows one isolate remembers, so distinct addresses cannot grow the
// map without limit. Expired windows are always dropped first.
const API_READ_MAX_KEYS = 20_000;

// Client IP selection. In production, Cloudflare sets cf-connecting-ip and that is the only trusted
// source. x-forwarded-for is a local/development fallback only; arbitrary forwarded headers are not
// trusted when cf-connecting-ip is absent outside local hosts.
function clientIp(request) {
  const cf = String(request.headers.get("cf-connecting-ip") || "").trim();
  if (cf) return cf;

  let host = "";
  try {
    host = new URL(request.url).hostname;
  } catch {
    host = "";
  }
  const localHost = host === "localhost" || host === "127.0.0.1" || host === "::1";
  if (localHost) {
    const forwarded = String(request.headers.get("x-forwarded-for") || "").trim();
    if (forwarded) {
      const first = forwarded.split(",")[0].trim();
      if (first) return first;
    }
  }
  return "local";
}

// IPs are hashed before they reach rate_limits. Raw addresses are never stored.
async function clientIpHash(request) {
  return sha256Hex(clientIp(request));
}

// One atomic upsert per check. The count is capped so a blocked key cannot grow without bound, and
// an expired window resets in the same statement. RETURNING gives the post-update count/expires.
async function touchRateLimit(env, key, limit, windowMs, cap) {
  const now = Date.now();
  const expires = now + windowMs;
  const sql =
    "INSERT INTO rate_limits (key, count, window_start, expires, updated_at) " +
    "VALUES (?, 1, ?, ?, ?) " +
    "ON CONFLICT(key) DO UPDATE SET " +
    "count = CASE WHEN rate_limits.expires <= ? THEN 1 " +
    "WHEN rate_limits.count >= ? THEN ? " +
    "ELSE rate_limits.count + 1 END, " +
    "window_start = CASE WHEN rate_limits.expires <= ? THEN ? ELSE rate_limits.window_start END, " +
    "expires = CASE WHEN rate_limits.expires <= ? THEN ? ELSE rate_limits.expires END, " +
    "updated_at = ? " +
    "RETURNING count, expires";
  const row = await env.DB.prepare(sql)
    .bind(key, now, expires, now, now, cap, cap, now, now, now, expires, now)
    .first();
  if (!row) throw new Error("rate-limit upsert returned no row");
  return { count: Number(row.count), expires: Number(row.expires) };
}

async function readRateLimit(env, key) {
  const row = await env.DB.prepare("SELECT count, expires FROM rate_limits WHERE key = ?")
    .bind(key)
    .first();
  if (!row) return { count: 0, expires: 0 };
  const expires = Number(row.expires);
  if (!Number.isFinite(expires) || expires <= Date.now()) return { count: 0, expires };
  return { count: Number(row.count), expires };
}

// A fixed-window counter that lives in one isolate's memory. `check` reports whether the caller is
// still inside the ceiling and when the current window ends. Windows are dropped when they expire;
// if a flood of distinct keys fills the store, the least recently inserted ones go first, so memory
// is bounded and no single address can pin it.
//
// `now` is injectable so window boundaries and expiry can be tested without waiting.
export function createWindowLimiter({ max, windowMs, maxKeys = API_READ_MAX_KEYS, now = () => Date.now() }) {
  const windows = new Map();

  const prune = (at) => {
    for (const [key, window] of windows) {
      if (window.expires <= at) windows.delete(key);
    }
    while (windows.size > maxKeys) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
  };

  return {
    check(key, at = now()) {
      if (windows.size >= maxKeys) prune(at);
      let window = windows.get(key);
      if (!window || window.expires <= at) {
        // Re-inserting keeps Map order equal to recency, so eviction drops the coldest key.
        windows.delete(key);
        window = { count: 0, expires: at + windowMs };
        windows.set(key, window);
      }
      window.count += 1;
      return { allowed: window.count <= max, count: window.count, expires: window.expires };
    },
    get size() {
      return windows.size;
    },
    clear() {
      windows.clear();
    },
  };
}

// One limiter per isolate. It is rebuilt only when the configured ceiling changes (tests lower it);
// `API_READ_MAX` is the same kind of tuning variable as RATE_LIMIT_CLEANUP_PROBABILITY.
let readLimiter = null;
let readLimiterMax = 0;

function readMaxRequests(env) {
  const configured = Number(env && env.API_READ_MAX);
  if (!Number.isInteger(configured) || configured < 1 || configured > 100_000) return API_READ_MAX_REQUESTS;
  return configured;
}

function readLimiterFor(env) {
  const max = readMaxRequests(env);
  if (!readLimiter || readLimiterMax !== max) {
    readLimiter = createWindowLimiter({ max, windowMs: API_READ_WINDOW_MS });
    readLimiterMax = max;
  }
  return readLimiter;
}

// Returns a Response on limit/failure, or null when the request may proceed.
//
// Reads and writes are protected differently on purpose. A durable row per request only pays for
// itself where abuse actually matters — sign-in, re-authentication, checkout, payments and every
// other state change — and those are low-volume by nature. A board polling every few seconds is not
// abuse; charging it a D1 write turned one open screen into ~21,600 writes a day. Reads therefore use
// the in-isolate window above: no storage, no write amplification, and a ceiling that still stops one
// isolate from serving an unbounded burst. The trade-off (a ceiling that is per isolate, not global)
// is documented in RATE_LIMIT_CAPACITY_REPORT.md.
async function checkApiRateLimit(request, env) {
  if (READ_METHODS.has(request.method)) return checkReadRateLimit(request, env);
  return checkDurableApiRateLimit(request, env);
}

async function checkReadRateLimit(request, env) {
  const key = await clientIpHash(request);
  const result = readLimiterFor(env).check(key);
  if (!result.allowed) {
    return json({ error: "Too many requests. Please slow down." }, 429);
  }
  return null;
}

async function checkDurableApiRateLimit(request, env) {
  const key = `api:${await clientIpHash(request)}`;
  let result;
  try {
    result = await touchRateLimit(env, key, API_MAX_REQUESTS, API_WINDOW_MS, API_MAX_REQUESTS + 1);
  } catch (err) {
    console.error("API rate-limit check failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "Too many requests. Please try again." }, 503);
  }
  if (result.count > API_MAX_REQUESTS) {
    return json({ error: "Too many requests. Please slow down." }, 429);
  }

  // Opportunistic, bounded cleanup of expired rows. It runs only on a small fraction of counted
  // writes — never on polling reads, which have no row to clean — and only after the rate-limit
  // decision has been made, so it can never change that decision or turn an allowed request into a
  // denied one. Failures are contained and logged generically.
  if (Math.random() < rateLimitCleanupProbability(env)) {
    await cleanupExpiredRateLimits(env);
  }
  return null;
}

// Sampling probability for expired-row cleanup. Defaults to 1% of API requests. Override with the
// RATE_LIMIT_CLEANUP_PROBABILITY Worker variable (0..1) for tests or tuning; invalid values fall
// back to the default. The cleanup is opportunistic, so a probability of 0 disables it.
function rateLimitCleanupProbability(env) {
  const configured = Number(env && env.RATE_LIMIT_CLEANUP_PROBABILITY);
  if (!Number.isFinite(configured) || configured < 0 || configured > 1) {
    return 0.01;
  }
  return configured;
}

// Removes at most 100 expired rows per execution, using the expires index. Active rows are excluded
// by the expires <= ? predicate. Errors are contained and never propagated to the caller.
async function cleanupExpiredRateLimits(env) {
  try {
    await env.DB.prepare(
      "DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE expires <= ? ORDER BY expires LIMIT 100)"
    )
      .bind(Date.now())
      .run();
  } catch {
    console.error("Rate-limit maintenance failed");
  }
}


async function login(request, env, cafe) {
  // A managed café has exactly one way in. Answering 410 rather than 401 is deliberate: the password
  // flow is not merely rejected here, it is gone for this café, so no password can be used to bypass
  // the provider even if a hash is still stored (an operator reset keeps the hash inert, not deleted).
  if (cafe.owner_auth === "workos") {
    return json(
      { error: "This café signs in with a managed identity. Open the board to continue.", code: "auth_mode_managed" },
      410
    );
  }
  // Sessions are signed with a deployment secret. A default would let anyone mint a staff session.
  if (!env.ADMIN_SECRET) {
    return signinNotSetUp();
  }
  // Every café signs in with its own stored hash. No deployment-wide fallback secret is consulted
  // here: one shared value used to open any café whose password was missing, and a short numeric pin
  // is not a password. An upgraded single-café install keeps its old password because the primary
  // café's hash is seeded once, at bootstrap (see worker/db.js).
  if (!cafe.pass_hash) {
    return signinNotSetUp(SIGNIN_OWNER_NOT_SET);
  }

  const ipHash = await clientIpHash(request);
  const lockoutKey = `login:${cafe.id}:${ipHash}`;

  let current;
  try {
    current = await readRateLimit(env, lockoutKey);
  } catch (err) {
    console.error("Login lockout check failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
  }
  if (current.count >= LOGIN_MAX_FAILURES && current.expires > Date.now()) {
    return signinLockedOut(current.expires);
  }

  // --- CRITICAL RACE FIX: Capture auth_version BEFORE password verification ---
  // The version is read from the same café database row that supplies pass_hash, ensuring
  // the session token version is consistent with the password snapshot. If a password change
  // occurs after this capture but before session issuance, the session will carry the old
  // version and be correctly rejected by subsequent version checks.
  const version = currentAuthVersion(cafe);

  const body = await readJson(request, BODY_LIMITS.login);
  const attempt = String((body && (body.password || body.pin)) || "").trim();

  // An empty body ("{}", "[]", malformed JSON, whitespace-only or any body that resolves to a blank
  // password) cannot match a stored credential and must be rejected before the Argon2id queue, so the
  // Argon2id binding is never handed an empty string and the login lockout counter is updated instead
  // of being silently skipped by an unhandled validation error.
  if (!attempt) {
    try {
      await touchRateLimit(env, lockoutKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES);
    } catch (err) {
      console.error("F-07 login lockout update failed", { error: err && err.message ? err.message : String(err) });
      return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
    }
    return json({ error: SIGNIN_WRONG_PASSWORD, code: "wrong_password" }, 401);
  }

  // A legacy hash whose work factor this runtime cannot compute is a controlled reset, never a
  // cheaper verification: answering 401 here would be indistinguishable from a wrong password.
  if (passwordNeedsReset(cafe.pass_hash)) {
    return json(
      {
        error:
          "This password was saved with a work factor this deployment can't verify. Ask the operator to reset it from the operator console.",
      },
      409
    );
  }

  let ok;
  try {
    ok = await verifyPassword(attempt, cafe.pass_hash);
  } catch (err) {
    // The per-isolate hashing queue is full: answer now instead of waiting behind an unbounded line.
    if (err instanceof PasswordQueueFullError) {
      return json({ error: "Too many sign-in attempts right now. Please try again in a moment." }, 429);
    }
    throw err;
  }

  if (!ok) {
    try {
      await touchRateLimit(env, lockoutKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES);
    } catch (err) {
      console.error("Login lockout update failed", { error: err && err.message ? err.message : String(err) });
      return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
    }
    return json({ error: SIGNIN_WRONG_PASSWORD, code: "wrong_password" }, 401);
  }

  // --- OPPORTUNISTIC MIGRATION: after a successful legacy PBKDF2 verification, move the hash to
  // Argon2id. The compare-and-swap only replaces the exact string that was just verified, so a
  // concurrent password change wins. The hash format is not part of the session, so the version field
  // is deliberately untouched and live sessions survive the upgrade.
  if (!isArgon2Hash(cafe.pass_hash)) {
    try {
      const newHash = await hashPassword(attempt);
      await env.DB.prepare("UPDATE cafes SET pass_hash = ? WHERE id = ? AND pass_hash = ?")
        .bind(newHash, cafe.id, cafe.pass_hash)
        .run();
    } catch (err) {
      // A full hashing queue or a wasm hiccup must not turn a correct password into a failed login;
      // the legacy hash stays in place and the next sign-in retries the migration.
      console.error("Password rehash skipped", {
        cafeId: cafe.id,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(lockoutKey).run();
  } catch (err) {
    console.error("Login lockout reset failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
  }

  // Use the pre-verification version; do not re-read the latest version after verification.
  // If a password change occurred after the cafe row was read, the session carries the old
  // version and will be rejected by checkToken which re-reads the current version.
  if (version === null) {
    console.error("Refusing an owner session: stored auth_version is invalid", { cafeId: cafe.id });
    return json({ error: "This café's sign-in isn't available right now. Please ask the operator." }, 503);
  }

  // Second factor. A café with a confirmed authenticator never receives a session from a password
  // alone: a correct password earns only a short-lived, single-use challenge. A row that exists but
  // was never confirmed (`confirmed_at IS NULL`) gates nothing — an abandoned enrollment has not
  // proved possession of the secret and must not be able to lock the owner out.
  const mfa = await env.DB.prepare("SELECT confirmed_at FROM owner_totp WHERE cafe_id = ?")
    .bind(cafe.id)
    .first();
  if (mfa && mfa.confirmed_at) {
    const challenge = await issueTotpChallenge(env, cafe.id);
    if (!challenge) {
      return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
    }
    await recordAuthEvent(env, request, cafe.id, "login_password_ok_mfa_required");
    return json(
      { ok: false, mfaRequired: true, challenge, expiresIn: TOTP_CHALLENGE_TTL_SECONDS },
      200
    );
  }

  // The row is committed before the cookie exists. A token whose session was never stored would be
  // refused on its very next request, so issuing it anyway would only look like a successful sign-in.
  const sessionId = ownerSessionId();
  const now = Date.now();
  await pruneOwnerSessions(env, now);
  try {
    await createOwnerSession(env, {
      cafeId: cafe.id,
      sessionId,
      now,
      expires: now + SESSION_MAX_AGE * 1000,
    });
  } catch (err) {
    console.error("Owner session creation failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
  }

  return json({ ok: true, expiresIn: SESSION_MAX_AGE }, 200, {
    "set-cookie": sessionCookie(
      request,
      await issueToken(env, ownerSubject(cafe, version, sessionId)),
      SESSION_MAX_AGE,
      cookieName(cafe)
    ),
  });
}


/* ------------------------------------------------------------------ MFA (TOTP) */

// A challenge is the ticket a correct password earns when a second factor is required. Five minutes
// is long enough to read a code off a phone and short enough that a stolen challenge is worthless.
const TOTP_CHALLENGE_TTL_MS = 5 * 60 * 1000;
const TOTP_CHALLENGE_TTL_SECONDS = Math.floor(TOTP_CHALLENGE_TTL_MS / 1000);
const TOTP_CHALLENGE_MAX_ATTEMPTS = 5;
const TOTP_ATTEMPT_WINDOW_MS = 10 * 60 * 1000;
const TOTP_ATTEMPTS_PER_WINDOW = 5;

// Best-effort audit. Never throws: a logging failure must not change the outcome of a sign-in. No
// credential, code, token or raw address is ever written — only the fact and a hashed IP.
async function recordAuthEvent(env, request, cafeId, kind, detail = "") {
  try {
    let ipHash = "";
    try {
      ipHash = await clientIpHash(request);
    } catch {
      ipHash = "";
    }
    await env.DB.prepare(
      "INSERT INTO auth_events (cafe_id, kind, subject, detail, ip_hash, created) VALUES (?, ?, 'owner', ?, ?, ?)"
    )
      .bind(
        cafeId == null ? null : Number(cafeId),
        String(kind).slice(0, 40),
        String(detail).slice(0, 120),
        String(ipHash).slice(0, 64),
        Date.now()
      )
      .run();
  } catch (err) {
    console.error("Auth audit write failed", {
      kind,
      error: err && err.message ? err.message : String(err),
    });
  }
}

async function issueTotpChallenge(env, cafeId) {
  const token = randomToken(32);
  const now = Date.now();
  try {
    await env.DB.prepare("DELETE FROM owner_totp_challenges WHERE expires <= ?").bind(now).run();
    await env.DB.prepare(
      "INSERT INTO owner_totp_challenges (challenge_hash, cafe_id, created, expires, attempts) VALUES (?, ?, ?, ?, 0)"
    )
      .bind(await sha256Hex(token), cafeId, now, now + TOTP_CHALLENGE_TTL_MS)
      .run();
    return token;
  } catch (err) {
    console.error("MFA challenge write failed", {
      cafeId,
      error: err && err.message ? err.message : String(err),
    });
    return null;
  }
}

// Returns the stored digest of a live challenge, or null. Expired, exhausted, foreign-café and
// unknown challenges are one answer: nothing to complete.
async function readTotpChallenge(env, cafeId, token) {
  if (!token || typeof token !== "string" || token.length > 200) return null;
  const hash = await sha256Hex(token);
  const row = await env.DB.prepare(
    "SELECT expires, attempts FROM owner_totp_challenges WHERE challenge_hash = ? AND cafe_id = ?"
  )
    .bind(hash, cafeId)
    .first();
  if (!row) return null;
  if (Number(row.expires) <= Date.now()) return null;
  if (Number(row.attempts) >= TOTP_CHALLENGE_MAX_ATTEMPTS) return null;
  return { hash };
}

async function bumpChallengeAttempts(env, hash) {
  try {
    await env.DB.prepare(
      "UPDATE owner_totp_challenges SET attempts = attempts + 1 WHERE challenge_hash = ?"
    )
      .bind(hash)
      .run();
  } catch (err) {
    console.error("MFA challenge attempt write failed", {
      error: err && err.message ? err.message : String(err),
    });
  }
}

// Step two of a sign-in. Consumes the challenge exactly once, verifies a TOTP code (or a single-use
// recovery code), advances the replay counter in a conditional UPDATE, and only then creates the
// session row the cookie names. Nothing about the password is re-read here: the challenge itself is
// the proof that step one succeeded.
async function loginTotp(request, env, cafe) {
  if (cafe.owner_auth === "workos") {
    return json(
      { error: "This café signs in with a managed identity. Open the board to continue.", code: "auth_mode_managed" },
      410
    );
  }
  if (!env.ADMIN_SECRET) {
    return signinNotSetUp();
  }

  const ipHash = await clientIpHash(request);
  const limitKey = `totp:${cafe.id}:${ipHash}`;
  let current;
  try {
    current = await readRateLimit(env, limitKey);
  } catch (err) {
    console.error("MFA lockout check failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
  }
  if (current.count >= TOTP_ATTEMPTS_PER_WINDOW && current.expires > Date.now()) {
    return signinLockedOut(current.expires);
  }

  const body = await readJson(request, BODY_LIMITS.loginTotp);
  const challengeToken = String((body && body.challenge) || "").trim();
  const code = String((body && body.code) || "").trim();

  const fail = async (status, message) => {
    try {
      await touchRateLimit(env, limitKey, TOTP_ATTEMPTS_PER_WINDOW, TOTP_ATTEMPT_WINDOW_MS, TOTP_ATTEMPTS_PER_WINDOW);
    } catch (err) {
      console.error("MFA lockout update failed", { error: err && err.message ? err.message : String(err) });
    }
    await recordAuthEvent(env, request, cafe.id, "mfa_fail");
    return json({ error: message }, status);
  };

  if (!challengeToken || !code) return fail(400, "Enter the code from your authenticator app.");

  const challenge = await readTotpChallenge(env, cafe.id, challengeToken);
  if (!challenge) return fail(401, "That sign-in attempt has expired. Start again.");

  const row = await env.DB.prepare(
    "SELECT secret_enc, confirmed_at, last_used_step FROM owner_totp WHERE cafe_id = ?"
  )
    .bind(cafe.id)
    .first();
  if (!row || !row.confirmed_at) {
    return json({ error: "This café's sign-in changed. Please start again." }, 409);
  }

  const secret = await decryptSecret(env, row.secret_enc);
  if (!secret) {
    // Safe to log: a status word, never key material. `malformed` means the deployment set a value
    // that is not 32 base64url bytes; both cases refuse rather than falling back to ADMIN_SECRET.
    console.error("MFA secret could not be decrypted", { cafeId: cafe.id, mfaKey: mfaKeyState(env) });
    return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
  }

  let outcome = "";
  if (looksLikeRecoveryCode(code)) {
    const digest = await hashRecoveryCode(code);
    if (digest) {
      const used = await env.DB.prepare(
        "UPDATE owner_totp_recovery SET used_at = ? WHERE code_hash = ? AND cafe_id = ? AND used_at IS NULL"
      )
        .bind(Date.now(), digest, cafe.id)
        .run();
      if (Number(used && used.meta && used.meta.changes) === 1) outcome = "recovery";
    }
  } else {
    const verified = await verifyTotp(secret, code, { lastStep: row.last_used_step });
    if (verified.ok) {
      // The replay counter is advanced in the same statement that proves it may be: two requests
      // presenting the same code race here, and exactly one of them changes a row.
      const advanced = await env.DB.prepare(
        "UPDATE owner_totp SET last_used_step = ?, updated = ? " +
          "WHERE cafe_id = ? AND (last_used_step IS NULL OR last_used_step < ?)"
      )
        .bind(verified.step, Date.now(), cafe.id, verified.step)
        .run();
      if (Number(advanced && advanced.meta && advanced.meta.changes) === 1) outcome = "totp";
    }
  }

  if (!outcome) {
    await bumpChallengeAttempts(env, challenge.hash);
    return fail(401, "That code didn't match.");
  }

  // The challenge is single-use whether the code was right or not: a second attempt must start from
  // the password again.
  try {
    await env.DB.prepare("DELETE FROM owner_totp_challenges WHERE challenge_hash = ?")
      .bind(challenge.hash)
      .run();
  } catch (err) {
    console.error("MFA challenge cleanup failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
  }
  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(limitKey).run();
  } catch (err) {
    console.error("MFA lockout reset failed", { error: err && err.message ? err.message : String(err) });
  }

  const version = currentAuthVersion(cafe);
  if (version === null) {
    console.error("Refusing an owner session: stored auth_version is invalid", { cafeId: cafe.id });
    return json({ error: "This café's sign-in isn't available right now. Please ask the operator." }, 503);
  }

  const sessionId = ownerSessionId();
  const now = Date.now();
  await pruneOwnerSessions(env, now);
  try {
    await createOwnerSession(env, {
      cafeId: cafe.id,
      sessionId,
      now,
      expires: now + SESSION_MAX_AGE * 1000,
    });
  } catch (err) {
    console.error("Owner session creation failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
  }

  await recordAuthEvent(env, request, cafe.id, `login_success_${outcome}`);

  return json({ ok: true, expiresIn: SESSION_MAX_AGE }, 200, {
    "set-cookie": sessionCookie(
      request,
      await issueToken(env, ownerSubject(cafe, version, sessionId)),
      SESSION_MAX_AGE,
      cookieName(cafe)
    ),
  });
}

// ------------------------------------------------------- MFA management (session)

async function ownerMfaStatus(env, cafe) {
  const row = await env.DB.prepare("SELECT confirmed_at FROM owner_totp WHERE cafe_id = ?")
    .bind(cafe.id)
    .first();
  const remaining = await env.DB.prepare(
    "SELECT COUNT(*) AS value FROM owner_totp_recovery WHERE cafe_id = ? AND used_at IS NULL"
  )
    .bind(cafe.id)
    .first();
  const managed = cafe.owner_auth === "workos";
  return json({
    managed,
    available: managed ? false : await mfaConfigured(env),
    enabled: Boolean(row && row.confirmed_at),
    pending: Boolean(row && !row.confirmed_at),
    recoveryCodesRemaining: Number(remaining && remaining.value) || 0,
  });
}

async function ownerMfaEnroll(request, env, cafe) {
  if (cafe.owner_auth === "workos") {
    return json(
      { error: "Managed cafés inherit their provider's second factor.", code: "auth_mode_managed" },
      409
    );
  }
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  if (!(await mfaConfigured(env))) {
    return json({ error: "Two-factor sign-in isn't configured on this deployment." }, 503);
  }

  const body = (await readJson(request, BODY_LIMITS.mfa)) || {};
  // A live session is not proof of the password (F-19): enrollment is a credential change.
  const refused = await verifyOwnerReauth(request, env, cafe, body.currentPassword);
  if (refused) return refused;

  const secret = generateSecret();
  const encrypted = await encryptSecret(env, secret);
  if (!encrypted) {
    return json({ error: "Two-factor sign-in isn't configured on this deployment." }, 503);
  }

  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO owner_totp (cafe_id, secret_enc, confirmed_at, last_used_step, created, updated) " +
          "VALUES (?, ?, NULL, NULL, ?, ?) " +
          "ON CONFLICT(cafe_id) DO UPDATE SET secret_enc = excluded.secret_enc, confirmed_at = NULL, " +
          "last_used_step = NULL, updated = excluded.updated"
      ).bind(cafe.id, encrypted, now, now),
      env.DB.prepare("DELETE FROM owner_totp_recovery WHERE cafe_id = ?").bind(cafe.id),
    ]);
  } catch (err) {
    console.error("MFA enrollment write failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Two-factor sign-in isn't available right now. Please try again." }, 503);
  }

  return json({
    ok: true,
    // The plaintext secret exists only in this response: it is not recoverable from the database.
    secret: base32Encode(secret),
    otpauth: otpauthUri({ secret: base32Encode(secret), account: cafe.slug }),
    issuer: "Corner Cup",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    expiresIn: TOTP_CHALLENGE_TTL_SECONDS,
  });
}

// A credential change: the factor becomes mandatory, every existing session dies, and the owner
// signs in again with the new factor. Recovery codes are returned once, in the clear, never stored.
async function ownerMfaConfirm(request, env, cafe) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }

  const body = (await readJson(request, BODY_LIMITS.mfa)) || {};
  const row = await env.DB.prepare(
    "SELECT secret_enc, confirmed_at, last_used_step FROM owner_totp WHERE cafe_id = ?"
  )
    .bind(cafe.id)
    .first();
  if (!row) return json({ error: "Start the enrollment again." }, 409);
  if (row.confirmed_at) return json({ error: "Two-factor sign-in is already on." }, 409);

  const secret = await decryptSecret(env, row.secret_enc);
  if (!secret) return json({ error: "Two-factor sign-in isn't available right now." }, 503);

  const verified = await verifyTotp(secret, body.code, { lastStep: row.last_used_step });
  if (!verified.ok) {
    await recordAuthEvent(env, request, cafe.id, "mfa_enroll_fail");
    return json({ error: "That code didn't match. Check the clock on your phone and try again." }, 401);
  }

  const codes = await generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE owner_totp SET confirmed_at = ?, last_used_step = ?, updated = ? WHERE cafe_id = ? AND confirmed_at IS NULL"
      ).bind(now, verified.step, now, cafe.id),
      env.DB.prepare("DELETE FROM owner_totp_recovery WHERE cafe_id = ?").bind(cafe.id),
      ...codes.map((entry) =>
        env.DB.prepare(
          "INSERT INTO owner_totp_recovery (code_hash, cafe_id, created, used_at) VALUES (?, ?, ?, NULL)"
        ).bind(entry.hash, cafe.id, now)
      ),
      // Every session minted before the factor existed is now on an old version and dies here; so do
      // the challenges that were waiting for a code.
      env.DB.prepare("UPDATE cafes SET auth_version = auth_version + 1 WHERE id = ?").bind(cafe.id),
      env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ?").bind(cafe.id),
      env.DB.prepare("DELETE FROM owner_totp_challenges WHERE cafe_id = ?").bind(cafe.id),
    ]);
  } catch (err) {
    console.error("MFA confirmation failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Two-factor sign-in isn't available right now. Please try again." }, 503);
  }

  await recordAuthEvent(env, request, cafe.id, "mfa_enabled");
  return json(
    { ok: true, enabled: true, recoveryCodes: codes.map((entry) => entry.code), signInRequired: true },
    200,
    { "set-cookie": sessionCookie(request, "", 0, cookieName(cafe)) }
  );
}

async function ownerMfaDisable(request, env, cafe) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }

  const body = (await readJson(request, BODY_LIMITS.mfa)) || {};
  const refused = await verifyOwnerReauth(request, env, cafe, body.currentPassword);
  if (refused) return refused;

  const row = await env.DB.prepare(
    "SELECT secret_enc, confirmed_at, last_used_step FROM owner_totp WHERE cafe_id = ?"
  )
    .bind(cafe.id)
    .first();
  if (!row || !row.confirmed_at) return json({ error: "Two-factor sign-in is already off." }, 409);

  let proved = false;
  if (looksLikeRecoveryCode(body.code)) {
    const digest = await hashRecoveryCode(body.code);
    if (digest) {
      const used = await env.DB.prepare(
        "UPDATE owner_totp_recovery SET used_at = ? WHERE code_hash = ? AND cafe_id = ? AND used_at IS NULL"
      )
        .bind(Date.now(), digest, cafe.id)
        .run();
      proved = Number(used && used.meta && used.meta.changes) === 1;
    }
  } else {
    const secret = await decryptSecret(env, row.secret_enc);
    if (secret) {
      const verified = await verifyTotp(secret, body.code, { lastStep: row.last_used_step });
      proved = verified.ok;
    }
  }
  if (!proved) {
    await recordAuthEvent(env, request, cafe.id, "mfa_disable_fail");
    return json({ error: "That code didn't match." }, 401);
  }

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM owner_totp WHERE cafe_id = ?").bind(cafe.id),
      env.DB.prepare("DELETE FROM owner_totp_recovery WHERE cafe_id = ?").bind(cafe.id),
      env.DB.prepare("DELETE FROM owner_totp_challenges WHERE cafe_id = ?").bind(cafe.id),
      env.DB.prepare("UPDATE cafes SET auth_version = auth_version + 1 WHERE id = ?").bind(cafe.id),
      env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ?").bind(cafe.id),
    ]);
  } catch (err) {
    console.error("MFA disable failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Two-factor sign-in isn't available right now. Please try again." }, 503);
  }

  await recordAuthEvent(env, request, cafe.id, "mfa_disabled");
  return json(
    { ok: true, enabled: false, signInRequired: true },
    200,
    { "set-cookie": sessionCookie(request, "", 0, cookieName(cafe)) }
  );
}

// Replacing the recovery set is a credential change like enrollment or removal: it needs the current
// password, a live authenticator code that has not been spent, and one atomic replacement. The old
// set is only invalidated inside the same batch that writes the new one, so a failure of any kind
// leaves the café with the codes it already had.
async function ownerMfaRecoveryRegenerate(request, env, cafe) {
  // CSRF before anything else: a failed or forged request must not read a credential or write a row.
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  if (cafe.owner_auth === "workos") {
    return json(
      { error: "Managed cafés inherit their provider's second factor.", code: "auth_mode_managed" },
      409
    );
  }

  const body = (await readJson(request, BODY_LIMITS.mfa)) || {};
  const password = String(body.currentPassword == null ? "" : body.currentPassword);
  const code = String(body.code == null ? "" : body.code).trim();
  if (!password || !code) {
    return json({ error: "Enter your current password and the code from your authenticator." }, 400);
  }

  // One answer for both factors: the caller must not learn from the reply which proof was wrong.
  const maskedRefusal = async () => {
    await recordAuthEvent(env, request, cafe.id, "mfa_recovery_regenerate_fail");
    return json({ error: "That password or code didn't match. Check both and try again." }, 401);
  };

  // The existing re-authentication gate: same Argon2 verification, same five-failure lockout. Its
  // operational refusals (locked out, unverifiable hash, store down) pass through unchanged; a missing
  // or wrong password is masked so it is indistinguishable from a wrong code.
  const refused = await verifyOwnerReauth(request, env, cafe, password);
  if (refused) {
    if (refused.status === 429 || refused.status === 409 || refused.status === 503) return refused;
    return maskedRefusal();
  }

  const row = await env.DB.prepare(
    "SELECT secret_enc, confirmed_at, last_used_step FROM owner_totp WHERE cafe_id = ?"
  )
    .bind(cafe.id)
    .first();
  if (!row || !row.confirmed_at) {
    return json({ error: "Two-factor sign-in isn't on for this café." }, 409);
  }

  // A recovery code may remove the factor, but it may never mint its own replacement set: regeneration
  // is proved with the authenticator itself, not with a code the old set already contained.
  if (looksLikeRecoveryCode(code)) return maskedRefusal();

  const secret = await decryptSecret(env, row.secret_enc);
  if (!secret) {
    return json({ error: "Two-factor sign-in isn't available right now. Please try again." }, 503);
  }

  const verified = await verifyTotp(secret, code, { lastStep: row.last_used_step });
  if (!verified.ok) return maskedRefusal();

  const codes = await generateRecoveryCodes(RECOVERY_CODE_COUNT);
  const now = Date.now();
  try {
    await env.DB.batch([
      // Claim the TOTP step first. Two concurrent requests verified the same code against the same
      // stale `last_used_step`; exactly one of them changes this row, because the predicate only
      // admits a strictly greater step.
      env.DB.prepare(
        "UPDATE owner_totp SET last_used_step = ?, updated = ? " +
          "WHERE cafe_id = ? AND confirmed_at IS NOT NULL " +
          "AND (last_used_step IS NULL OR last_used_step < ?)"
      ).bind(verified.step, now, cafe.id, verified.step),
      // The CHECK-guarded witness turns the loser's zero-row UPDATE into a constraint failure, which
      // rolls this whole batch back. Nothing is decided by inspecting `meta.changes` in JavaScript.
      env.DB.prepare(
        "INSERT INTO tx_guard (ok) SELECT 0 WHERE NOT EXISTS (" +
          "SELECT 1 FROM owner_totp WHERE cafe_id = ? AND last_used_step = ?)"
      ).bind(cafe.id, verified.step),
      // Only inside this batch: if any later statement fails, the rollback restores the old set.
      env.DB.prepare("DELETE FROM owner_totp_recovery WHERE cafe_id = ?").bind(cafe.id),
      ...codes.map((entry) =>
        env.DB.prepare(
          "INSERT INTO owner_totp_recovery (code_hash, cafe_id, created, used_at) VALUES (?, ?, ?, NULL)"
        ).bind(entry.hash, cafe.id, now)
      ),
      // Unreachable on success; keeps the guard table empty when it is.
      env.DB.prepare("DELETE FROM tx_guard"),
    ]);
  } catch (err) {
    if (isAuthModeTransitionConflict(err)) {
      return json(
        { error: "That code was already used. Wait for the next one and try again." },
        409
      );
    }
    // No code, hash or partial set leaves this branch: the transaction has already rolled back.
    console.error("MFA recovery regeneration failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json(
      { error: "We couldn't replace the recovery codes. Your previous codes are still valid." },
      503
    );
  }

  await recordAuthEvent(env, request, cafe.id, "mfa_recovery_regenerated");
  // The plaintext set exists only in this response. Only the SHA-256 hashes above were stored.
  return json({ ok: true, recoveryCodes: codes.map((entry) => entry.code) });
}

// ------------------------------------------------------------ session inventory

async function ownerSessionList(env, cafe, session) {
  const { results } = await env.DB.prepare(
    "SELECT session_id, created, expires, workos_user_id FROM owner_sessions " +
      "WHERE cafe_id = ? AND expires > ? ORDER BY created DESC LIMIT 20"
  )
    .bind(cafe.id, Date.now())
    .all();
  return json({
    sessions: (results || []).map((row) => ({
      // Only a prefix leaves the server: enough to name a device in the UI, useless as a credential.
      id: String(row.session_id).slice(0, 8),
      created: Number(row.created),
      expires: Number(row.expires),
      managed: Boolean(row.workos_user_id),
      current: row.session_id === session.sessionId,
    })),
  });
}

async function ownerRevokeSession(request, env, cafe, session, prefix) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  const id = String(prefix || "").toLowerCase();
  if (!/^[0-9a-f]{8}$/.test(id)) return json({ error: "Unknown session." }, 400);

  const { results } = await env.DB.prepare(
    "SELECT session_id FROM owner_sessions WHERE cafe_id = ? AND session_id LIKE ?"
  )
    .bind(cafe.id, `${id}%`)
    .all();
  const matches = results || [];
  if (matches.length === 0) return json({ error: "Unknown session." }, 404);
  if (matches.length > 1) return json({ error: "That session reference is ambiguous." }, 409);
  const target = String(matches[0].session_id);
  if (target === session.sessionId) {
    return json({ error: "Use sign out everywhere to end this device." }, 400);
  }

  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM owner_sessions WHERE session_id = ? AND cafe_id = ?").bind(target, cafe.id),
      env.DB.prepare("DELETE FROM csrf_tokens WHERE operator_key_hash = ?").bind(await sha256Hex(target)),
    ]);
  } catch (err) {
    console.error("Session revoke failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "We couldn't end that session. Please try again." }, 500);
  }

  await recordAuthEvent(env, request, cafe.id, "session_revoked", target.slice(0, 8));
  return json({ ok: true });
}

// The session lives in an HttpOnly cookie, so no script on the page (and no guest poking at
// devtools) can read or copy a staff token. SameSite=Strict stops another site riding it.
async function sessionStatus(env, request, cafe) {
  if (!authConfigured(env)) return authUnavailable("Staff sign-in");

  const token = readCookie(request, cookieName(cafe));
  const session = await ownerSession(env, token, cafe);
  if (session.status === SESSION_STORE_DOWN) {
    return json({ error: "This café's sign-in isn't available right now. Please try again." }, 503);
  }
  if (session.status !== SESSION_OK) {
    // Expired, signed out or legacy: drop the dead cookie rather than let it keep being sent.
    return json({ error: "Not signed in." }, 401, {
      "set-cookie": sessionCookie(request, "", 0, cookieName(cafe)),
    });
  }

  // Sliding expiry: this call is the board's heartbeat, and it renews the session. The row is extended
  // first and the cookie is only reissued once that write actually changed a row, so a failed or
  // refused renewal can never leave a twelve-hour cookie pointing at a shorter-lived session — on
  // failure the browser keeps exactly the cookie it already had, which still matches the old row.
  let expires = session.expires;
  let renewed = null;
  try {
    const next = await renewOwnerSession(env, cafe, session);
    if (next === null) {
      // Signed out or expired between verification and the write: this is no longer a session.
      return json({ error: "Not signed in." }, 401, {
        "set-cookie": sessionCookie(request, "", 0, cookieName(cafe)),
      });
    }
    expires = next;
    renewed = await issueToken(env, ownerSubject(cafe, session.version, session.sessionId), expires);
  } catch (err) {
    // The session is still valid until its existing expiry. Declining to extend is the safe failure,
    // and it is reported as the time actually left rather than as a renewal.
    console.error("Owner session renewal failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
  }

  // The board needs a CSRF token to sign other devices out, so it is issued here the same way the
  // operator console gets one. It is bound to the session id, which survives renewal, so reissuing the
  // cookie does not invalidate the token a tab is already holding.
  const csrfToken = await issueCsrfToken(env, session.sessionId);

  // The cookie's Max-Age is the lesser of the idle window and what is left of the absolute lifetime, so
  // a renewed cookie can never outlive the row it names.
  const maxAge = Math.max(0, Math.min(SESSION_MAX_AGE, Math.floor((expires - Date.now()) / 1000)));

  return json(
    { ok: true, expiresIn: Math.max(0, Math.floor((expires - Date.now()) / 1000)), csrfToken },
    200,
    renewed ? { "set-cookie": sessionCookie(request, renewed, maxAge, cookieName(cafe)) } : {}
  );
}

// Ordinary sign-out ends this one session for real: its row is deleted, so a copy of the cookie is
// refused on the next request while every other device keeps working. The CSRF rows bound to this
// cookie go with it. Ending the other devices is `logoutEverywhere` below.
async function logout(request, env, cafe) {
  const token = readCookie(request, cookieName(cafe));
  // Without a signing secret there is no token to read, and sign() would throw; clearing the cookie
  // is still the whole job in that deployment.
  const claims = authConfigured(env) ? await tokenClaims(env, token) : null;
  const parsed = claims ? parseOwnerSubject(claims.subject) : null;
  // A legacy, forged or already-cleared cookie has nothing to revoke; clearing it is still correct.
  const sessionId = parsed && parsed.owner === `cafe:${cafe.id}` ? parsed.sessionId : null;

  let revoked = true;
  if (sessionId) {
    try {
      await deleteOwnerSession(env, { cafeId: cafe.id, sessionId });
    } catch (err) {
      revoked = false;
      console.error("Owner session deletion failed", {
        cafeId: cafe.id,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  if (sessionId && revoked) {
    try {
              // Owner CSRF rows are keyed by sha256(session id); rows written before that binding existed
        // are keyed by the cookie value. Both are cleared, so neither binding leaves a stale row.
        await env.DB.prepare("DELETE FROM csrf_tokens WHERE operator_key_hash IN (?, ?)")
        .bind(await sha256Hex(sessionId), await sha256Hex(token))
        .run();
    } catch (err) {
      console.error("Owner CSRF cleanup failed", {
        cafeId: cafe.id,
        error: err && err.message ? err.message : String(err),
      });
    }
  }

  const headers = { "set-cookie": sessionCookie(request, "", 0, cookieName(cafe)) };
  if (!revoked) {
    // The browser's copy is gone either way, but the server still accepts it — never claim success.
    return json({ error: "We couldn't end that session on the server. Please try again." }, 500, headers);
  }
  return json({ ok: true }, 200, headers);
}

// Sign out everywhere: bump the café's auth_version so every token stamped with the old version — on
// every device — stops matching in the same instant, then hand this owner a fresh cookie so the screen
// they are standing at keeps working. The compare-and-swap mirrors the operator reset: if the version
// moved underneath us (a password change in another tab) we refuse rather than double-bump.
// `password_changed_at` is deliberately untouched, because it dates a credential change and this is
// a session decision.
async function logoutEverywhere(request, env, cafe) {
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
  const actingSessionId = acting && acting.owner === `cafe:${cafe.id}` ? acting.sessionId : null;

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
  await recordAuthEvent(env, request, cafe.id, "logout_everywhere");

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

// Takings follow the café's clock, not the Worker's UTC clock: an order placed at 12:30am in India
// belongs to that night's till, and the board is the screen staff close the day from.
function cafeDayStart(offsetMinutesRaw, nowMs = Date.now()) {
  const offsetMinutes = Number.isFinite(Number(offsetMinutesRaw)) ? Number(offsetMinutesRaw) : 330;
  const shifted = nowMs + offsetMinutes * 60 * 1000;
  const midnight = Math.floor(shifted / 86_400_000) * 86_400_000;
  return new Date(midnight - offsetMinutes * 60 * 1000).toISOString();
}

async function adminOrders(env, cafe) {
  const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const settings = cafeSettings(cafe);
  const dayStart = cafeDayStart(settings.tzOffsetMin);

  // The 24-hour window keeps the board tidy, but an order still sitting in "new" from last night
  // must not disappear from the kitchen just because the clock rolled over.
  const { results: orders } = await env.DB.prepare(
    "SELECT id, table_id, table_label, note, status, total_cents, payment_method, payment_status, payment_ref, payment_txn, paid_at, queue_no, created_at, updated_at FROM orders WHERE cafe_id = ? AND (created_at >= ? OR status IN ('new', 'preparing', 'ready')) ORDER BY created_at DESC LIMIT 100"
  )
    .bind(cafe.id, cutoff)
    .all();

  const { results: items } = await env.DB.prepare(
    "SELECT oi.order_id, oi.name, oi.emoji, oi.price_cents, oi.qty FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.cafe_id = ? AND (o.created_at >= ? OR o.status IN ('new', 'preparing', 'ready')) ORDER BY oi.id ASC"
  )
    .bind(cafe.id, cutoff)
    .all();

  const grouped = new Map();
  for (const item of items) {
    if (!grouped.has(item.order_id)) grouped.set(item.order_id, []);
    grouped.get(item.order_id).push({
      name: item.name,
      emoji: item.emoji,
      priceCents: item.price_cents,
      qty: item.qty,
    });
  }

  const day = await env.DB.prepare(
    `SELECT
       COUNT(*) AS orders,
       COALESCE(SUM(CASE WHEN payment_status IN ('confirmed', 'counter') THEN total_cents ELSE 0 END), 0) AS collected_cents,
       COALESCE(SUM(CASE WHEN payment_status IN ('confirmed', 'counter') THEN 1 ELSE 0 END), 0) AS settled_orders,
       COALESCE(SUM(CASE WHEN payment_status = 'confirmed' THEN total_cents ELSE 0 END), 0) AS online_cents,
       COALESCE(SUM(CASE WHEN payment_status = 'counter' THEN total_cents ELSE 0 END), 0) AS counter_cents,
       COALESCE(SUM(CASE WHEN payment_status IN ('unpaid', 'submitted', 'failed') AND status != 'cancelled' THEN total_cents ELSE 0 END), 0) AS pending_cents
     FROM orders WHERE cafe_id = ? AND created_at >= ?`
  )
    .bind(cafe.id, dayStart)
    .first();

  const openNow = await env.DB.prepare(
    "SELECT COUNT(*) AS value FROM orders WHERE cafe_id = ? AND status IN ('new', 'preparing', 'ready')"
  )
    .bind(cafe.id)
    .first();

  const settledOrders = Number(day.settled_orders) || 0;
  const stats = {
    dayStart,
    orders: Number(day.orders) || 0,
    collectedCents: Number(day.collected_cents) || 0,
    onlineCents: Number(day.online_cents) || 0,
    counterCents: Number(day.counter_cents) || 0,
    pendingCents: Number(day.pending_cents) || 0,
    settledOrders,
    averageCents: settledOrders ? Math.round(Number(day.collected_cents) / settledOrders) : 0,
    openOrders: Number(openNow && openNow.value) || 0,
  };

  return json({
    statistics: stats,
    orders: orders.map((order) => ({
      id: order.id,
      tableId: order.table_id,
      tableLabel: order.table_label,
      queueNo: order.queue_no == null ? null : order.queue_no,
      note: order.note,
      status: order.status,
      totalCents: order.total_cents,
      paymentMethod: order.payment_method || "counter",
      paymentStatus: order.payment_status || "unpaid",
      paymentRef: order.payment_ref,
      paymentTxn: order.payment_txn,
      paidAt: order.paid_at,
      createdAt: order.created_at,
      updatedAt: order.updated_at,
      items: grouped.get(order.id) || [],
    })),
  });
}

async function adminUpdateOrder(request, env, cafe, id) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  const body = await readJson(request, BODY_LIMITS.adminOrder);
  if (!body) return json({ error: "Nothing to update." }, 400);

  const sets = [];
  const params = [];
  const now = new Date().toISOString();

  if (body.status !== undefined) {
    const status = String(body.status);
    if (!STATUSES.includes(status)) return json({ error: "Unknown order status." }, 400);

    // Guard the workflow: a status may only move one step at a time (or be cancelled). Fetching the
    // current row also gives a clean 404 for a missing order before any UPDATE runs.
    const current = await env.DB.prepare("SELECT status FROM orders WHERE id = ? AND cafe_id = ?")
      .bind(id, cafe.id)
      .first();
    if (!current) return json({ error: "Order not found." }, 404);
    if (!canTransitionStatus(String(current.status || ""), status)) {
      return json({ error: "That status change isn't allowed." }, 409);
    }

    sets.push("status = ?");
    params.push(status);
  }

  // A ticket that is already paid may not be marked unpaid, submitted or failed. The flag rides in
  // the statement's WHERE clause below, so the rule holds even if a confirmation lands in between.
  let guardPaid = false;
  if (body.paymentStatus !== undefined) {
    const paymentStatus = String(body.paymentStatus);
    if (!PAYMENT_STATUSES.includes(paymentStatus)) return json({ error: "Unknown payment status." }, 400);
    const parts = paymentStatusSets(paymentStatus, now);
    sets.push(...parts.sets);
    params.push(...parts.params);
    guardPaid = parts.guardPaid;
  }

  if (sets.length === 0) return json({ error: "Nothing to update." }, 400);

  sets.push("updated_at = ?");
  params.push(now);

  const result = await staffOrderUpdateStatement(env, {
    cafeId: cafe.id,
    orderId: id,
    sets,
    params,
    guardPaid,
  }).run();
  const changes = Number(result && result.meta && result.meta.changes) || 0;

  if (changes !== 1) {
    if (guardPaid) {
      // With the guard in place, zero rows means the ticket was confirmed after this request read it.
      const row = await env.DB.prepare("SELECT payment_status FROM orders WHERE id = ? AND cafe_id = ?")
        .bind(id, cafe.id)
        .first();
      if (!row) return json({ error: "Order not found." }, 404);
      if (String(row.payment_status || "") === "confirmed") {
        return json(
          {
            error: "This order's payment is already confirmed, so it can't be marked unpaid or failed.",
            code: "payment_already_confirmed",
          },
          409
        );
      }
    }
    return json({ error: "Order not found." }, 404);
  }

  return json({ ok: true });
}

// Everything a new outlet needs that used to live in Worker variables: name, service mode, the
// café clock and the contact details Razorpay's website review expects on the policy pages.
async function adminSettings(cafe) {
  return json({ slug: cafe.slug, settings: cafeSettings(cafe) });
}

/* ------------------------------------------------ settings re-authentication */

// A password change is the one settings write that moves a credential, so it asks the caller to prove
// they know the current password. Every other field in the panel is a preference and stays session-only.
const REAUTH_WINDOW_MS = 10 * 60 * 1000;
const REAUTH_MAX_FAILURES = 5;

// Returns a Response when the change must be refused, or null when the caller proved the password.
// Every check runs before the new hash is computed and before the UPDATE, so a refusal changes
// nothing — not the password, not the café name, not a contact field sent in the same request.
async function verifyOwnerReauth(request, env, cafe, supplied) {
  const password = supplied == null ? "" : String(supplied);
  if (!password) {
    return json({ error: "Enter your current password to change it." }, 400);
  }

  const key = `settings:${cafe.id}:${await clientIpHash(request)}`;

  let current;
  try {
    current = await readRateLimit(env, key);
  } catch (err) {
    console.error("Settings re-authentication check failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "Café settings aren't available right now. Please try again." }, 503);
  }
  if (current.count >= REAUTH_MAX_FAILURES && current.expires > Date.now()) {
    return json({ error: "Too many attempts. Please try again in a few minutes." }, 429);
  }

  // Same policy as sign-in: a missing hash, or a work factor this runtime cannot compute, is a
  // controlled operator reset — never a skipped or weaker verification.
  if (!cafe.pass_hash || passwordNeedsReset(cafe.pass_hash)) {
    return json(
      {
        error:
          "This café's current password can't be verified here. Ask the operator to reset it from the operator console.",
      },
      409
    );
  }

  let ok;
  try {
    ok = await verifyPassword(password, cafe.pass_hash);
  } catch (err) {
    if (err instanceof PasswordQueueFullError) {
      return json({ error: "Too many requests right now. Please try again in a moment." }, 429);
    }
    throw err;
  }

  if (!ok) {
    try {
      await touchRateLimit(env, key, REAUTH_MAX_FAILURES, REAUTH_WINDOW_MS, REAUTH_MAX_FAILURES);
    } catch (err) {
      console.error("Settings re-authentication lockout update failed", {
        cafeId: cafe.id,
        error: err && err.message ? err.message : String(err),
      });
      return json({ error: "Café settings aren't available right now. Please try again." }, 503);
    }
    // The session is still valid — only the re-authentication failed. The code lets the staff screen
    // show this instead of treating a 401 as "your session ended" and signing the owner out.
    return json({ error: "That current password doesn't match.", code: "reauth_required" }, 401);
  }

  // A proven password starts a clean slate. Failing to clear the counter is not a reason to refuse a
  // change the caller has just proved they are entitled to make.
  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(key).run();
  } catch (err) {
    console.error("Settings re-authentication counter reset failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
  }

  return null;
}

async function adminSaveSettings(request, env, cafe) {
  // Every owner mutation carries the same proof: an exact-Origin request plus a live, hashed CSRF
  // token bound to this session. SameSite=Strict alone is not treated as sufficient for a write.
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  const body = await readJson(request, BODY_LIMITS.settings);
  if (!body) return json({ error: "We couldn't read those settings." }, 400);

  const patch = {};

  if (body.cafeName !== undefined) {
    const name = String(body.cafeName).trim();
    if (name.length < 2 || name.length > 60) {
      return json({ error: "The café name should be 2–60 characters." }, 400);
    }
    patch.name = name;
  }

  if (body.serviceMode !== undefined) {
    const mode = String(body.serviceMode).trim().toLowerCase();
    if (mode !== "tables" && mode !== "counter") {
      return json({ error: "Service mode must be tables or counter." }, 400);
    }
    patch.service_mode = mode;
  }

  if (body.tzOffsetMin !== undefined) {
    const tz = Number(body.tzOffsetMin);
    if (!Number.isFinite(tz) || tz < -720 || tz > 840) {
      return json({ error: "That timezone offset doesn't look right." }, 400);
    }
    patch.tz_offset_min = Math.round(tz);
  }

  if (body.contactPhone !== undefined) {
    const phone = String(body.contactPhone).trim();
    if (phone.length > 32) return json({ error: "That phone number is too long." }, 400);
    patch.contact_phone = phone;
  }

  if (body.contactEmail !== undefined) {
    const email = String(body.contactEmail).trim();
    if (email.length > 120) return json({ error: "That email address is too long." }, 400);
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return json({ error: "That email address doesn't look right." }, 400);
    }
    patch.contact_email = email;
  }

  if (body.contactAddress !== undefined) {
    const address = String(body.contactAddress).trim();
    if (address.length > 200) return json({ error: "That address is too long (200 characters max)." }, 400);
    patch.contact_address = address;
  }

  // The board password is per café, so a client can lock their own staff out without touching
  // anyone else's deployment.
  // A password set here is a real credential change, so it moves the café's auth version too.
  let passwordChanged = false;
  // F-07 phase 2B. In managed mode a password would be a second, weaker way in, so the write is
  // refused before the re-authentication prompt and before any hashing. Other settings still save.
  if (body.password !== undefined && cafe.owner_auth === "workos") {
    return json(
      {
        error: "This café signs in with a managed identity, so it has no owner password to change.",
        code: "auth_mode_managed",
      },
      409
    );
  }
  if (body.password !== undefined) {
    const password = String(body.password);
    // The same 12-character floor the operator reset enforces, so a password cannot be weakened
    // by setting it here instead.
    if (password.length < 12 || password.length > 100) {
      return json({ error: "The owner password needs at least 12 characters." }, 400);
    }
    // F-19: a live session is not proof of the password. Re-authenticate before hashing or writing
    // anything, so an unlocked board or a copied cookie cannot silently take the café over.
    const refused = await verifyOwnerReauth(request, env, cafe, body.currentPassword);
    if (refused) return refused;
    patch.pass_hash = await hashPassword(password);
    passwordChanged = true;
  }

  const entries = Object.entries(patch);
  if (entries.length === 0) return json({ error: "Nothing to save." }, 400);

  // Column names come from the fixed set validated above, never from the request body.
  const columns = entries.map(([column]) => `${column} = ?`);
  const values = entries.map(([, value]) => value);
  if (passwordChanged) {
    columns.push("auth_version = auth_version + 1");
    columns.push("password_changed_at = ?");
    values.push(Date.now());
  }

  // A password change is written against the version this request verified. If another change landed
  // in between, the UPDATE touches no row and nothing is written: a stale password must never be able
  // to replace the credential that already superseded it. Preference-only saves stay last-write-wins.
  const expectedVersion = passwordChanged ? currentAuthVersion(cafe) : null;

  // The replacement session is created before the version bump, so the browser that changed the
  // password always has a row to be handed back. Every failure path below removes it again.
  let replacementSession = null;
  if (passwordChanged) {
    replacementSession = ownerSessionId();
    const created = Date.now();
    try {
      await createOwnerSession(env, {
        cafeId: cafe.id,
        sessionId: replacementSession,
        now: created,
        expires: created + SESSION_MAX_AGE * 1000,
      });
    } catch (err) {
      console.error("Password change replacement session failed", {
        cafeId: cafe.id,
        error: err && err.message ? err.message : String(err),
      });
      return json({ error: "Café settings aren't available right now. Please try again." }, 503);
    }
  }

  const update = passwordChanged
    ? env.DB.prepare(`UPDATE cafes SET ${columns.join(", ")} WHERE id = ? AND auth_version = ?`).bind(
        ...values,
        cafe.id,
        expectedVersion
      )
    : env.DB.prepare(`UPDATE cafes SET ${columns.join(", ")} WHERE id = ?`).bind(...values, cafe.id);

  let written;
  try {
    written = await update.run();
  } catch (err) {
    if (replacementSession) await removeOwnerSessionQuietly(env, cafe.id, replacementSession);
    throw err;
  }
  if (passwordChanged && Number(written && written.meta && written.meta.changes) !== 1) {
    await removeOwnerSessionQuietly(env, cafe.id, replacementSession);
    return json(
      { error: "This café's password changed while you were working. Reload and try again." },
      409
    );
  }

  const updated = await findCafeBySlug(env, cafe.slug);

  if (passwordChanged) {
    await recordAuthEvent(env, request, cafe.id, "password_changed");
  }

  // Every session minted before the change is now on an old version, including the one that made
  // it. The owner who changed the password gets a fresh cookie, so only their other devices are
  // signed out.
  if (passwordChanged) {
    const version = currentAuthVersion(updated);
    if (version === null) {
      // Cannot happen through the code paths above, but a session must never be stamped from a
      // value that is not a valid version — and no replacement row may be left behind.
      console.error("Password changed but auth_version is invalid; not reissuing a session", {
        cafeId: updated.id,
      });
      await removeOwnerSessionQuietly(env, updated.id, replacementSession);
      return json({ slug: updated.slug, settings: cafeSettings(updated) });
    }

    // Every other row for this café is dead by the version bump; dropping it keeps the table small.
    try {
      await env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ? AND session_id != ?")
        .bind(updated.id, replacementSession)
        .run();
    } catch (err) {
      console.error("Password change session cleanup failed", {
        cafeId: updated.id,
        error: err && err.message ? err.message : String(err),
      });
    }

    return json({ slug: updated.slug, settings: cafeSettings(updated) }, 200, {
      "set-cookie": sessionCookie(
        request,
        await issueToken(env, ownerSubject(updated, version, replacementSession)),
        SESSION_MAX_AGE,
        cookieName(updated)
      ),
    });
  }

  return json({ slug: updated.slug, settings: cafeSettings(updated) });
}

async function adminMenu(env, cafe) {
  const { results } = await env.DB.prepare(
    "SELECT id, category, name, description, price_cents, emoji, available, image_key, image_updated_at FROM menu_items WHERE cafe_id = ? ORDER BY sort ASC, name ASC"
  )
    .bind(cafe.id)
    .all();

  return json({
    items: results.map((row) => ({
      id: row.id,
      category: row.category,
      name: row.name,
      description: row.description,
      priceCents: row.price_cents,
      emoji: row.emoji,
      available: Boolean(row.available),
      imageUrl: itemImageUrl(cafe, row.id, row.image_key, row.image_updated_at),
      hasCustomImage: Boolean(row.image_key),
    })),
  });
}

async function adminCreateItem(request, env, cafe) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  const body = await readJson(request, BODY_LIMITS.menuItem);
  if (!body) return json({ error: "We couldn't read that item." }, 400);

  const name = String(body.name || "").trim().slice(0, 60);
  const category = String(body.category || "").trim().slice(0, 40) || "Menu";
  const description = String(body.description || "").trim().slice(0, 160);
  const emoji = String(body.emoji || "🍽️").trim().slice(0, 8) || "🍽️";
  const priceCents = Math.round(Number(body.priceCents));

  if (!name) return json({ error: "Give the item a name." }, 400);
  if (!Number.isFinite(priceCents) || priceCents <= 0 || priceCents > 100000) {
    return json({ error: "Enter a price greater than zero." }, 400);
  }

  const max = await env.DB.prepare("SELECT COALESCE(MAX(sort), 0) AS value FROM menu_items WHERE cafe_id = ?")
    .bind(cafe.id)
    .first();
  const result = await env.DB.prepare(
    "INSERT INTO menu_items (cafe_id, category, name, description, price_cents, emoji, available, sort) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
  )
    .bind(cafe.id, category, name, description, priceCents, emoji, (max ? max.value : 0) + 10)
    .run();

  return json({ id: result.meta ? result.meta.last_row_id : null }, 201);
}

const EDITABLE_MENU_FIELDS = new Set([
  "name",
  "category",
  "description",
  "emoji",
  "available",
  "priceCents",
]);

async function adminUpdateItem(request, env, cafe, id) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  if (!Number.isFinite(id)) return json({ error: "Unknown item." }, 400);
  const body = await readJson(request, BODY_LIMITS.adminItem);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return json({ error: "Nothing to update." }, 400);
  }

  // Reject payloads that try to touch protected rows. The client may only edit the fields the board
  // exposes; identity, ownership, sort order and internal ids are the server's to manage.
  for (const key of Object.keys(body)) {
    if (!EDITABLE_MENU_FIELDS.has(key)) {
      return json({ error: `Unknown field: ${key}` }, 400);
    }
  }

  // Resolve the current row once, before applying anything. The item must belong to this café, and a
  // PATCH that touches nothing is still a no-op rather than a created row.
  const existing = await env.DB.prepare(
    "SELECT id, category, name, description, price_cents, emoji, available FROM menu_items WHERE id = ? AND cafe_id = ?"
  )
    .bind(id, cafe.id)
    .first();

  if (!existing) return json({ error: "Item not found." }, 404);

  const next = {
    category: existing.category,
    name: existing.name,
    description: existing.description,
    emoji: existing.emoji,
    available: Boolean(existing.available),
    priceCents: existing.price_cents,
  };

  // Types are checked, not coerced: a number where text belongs, or text where a price belongs, is a
  // malformed edit rather than something to reinterpret. Lengths are enforced, not truncated, so a
  // caller is told its payload was wrong instead of silently getting a different value back.
  let touched = false;

  if ("name" in body) {
    touched = true;
    if (typeof body.name !== "string") {
      return json({ error: "The item name must be text." }, 400);
    }
    const name = body.name.trim();
    if (!name) return json({ error: "Give the item a name." }, 400);
    if (name.length > 60) {
      return json({ error: "The item name is too long (60 characters max)." }, 400);
    }
    next.name = name;
  }
  if ("category" in body) {
    touched = true;
    if (typeof body.category !== "string") {
      return json({ error: "The category must be text." }, 400);
    }
    const category = body.category.trim();
    if (category.length > 40) {
      return json({ error: "The category is too long (40 characters max)." }, 400);
    }
    next.category = category || "Menu";
  }
  if ("description" in body) {
    touched = true;
    if (typeof body.description !== "string") {
      return json({ error: "The description must be text." }, 400);
    }
    const description = body.description.trim();
    if (description.length > 160) {
      return json({ error: "The description is too long (160 characters max)." }, 400);
    }
    next.description = description;
  }
  if ("emoji" in body) {
    touched = true;
    if (typeof body.emoji !== "string") {
      return json({ error: "The icon must be text." }, 400);
    }
    const emoji = body.emoji.trim();
    if (emoji.length > 8) {
      return json({ error: "The icon is too long (8 characters max)." }, 400);
    }
    next.emoji = emoji || "🍽️";
  }
  if ("priceCents" in body) {
    touched = true;
    // A safe positive integer of paise: the exact type, not a numeric-looking string, and inside the
    // same ceiling creation accepts so an edit cannot price an item beyond it.
    if (typeof body.priceCents !== "number" || !Number.isSafeInteger(body.priceCents)) {
      return json({ error: "Enter the price as a whole number of paise." }, 400);
    }
    if (body.priceCents <= 0 || body.priceCents > 1_000_000) {
      return json({ error: "Enter a price greater than zero (up to 10,000.00)." }, 400);
    }
    next.priceCents = body.priceCents;
  }
  if ("available" in body) {
    touched = true;
    if (typeof body.available !== "boolean") {
      return json({ error: "Available must be true or false." }, 400);
    }
    next.available = body.available;
  }

  // A PATCH that carries no supported field would rewrite the row with its own current values and
  // report success; that hides a client bug. Only an explicit availability-only toggle (or any other
  // real field) is a valid update.
  if (!touched) return json({ error: "Nothing to update." }, 400);

  const result = await env.DB.prepare(
    "UPDATE menu_items SET category = ?, name = ?, description = ?, price_cents = ?, emoji = ?, available = ? WHERE id = ? AND cafe_id = ?"
  )
    .bind(next.category, next.name, next.description, next.priceCents, next.emoji, next.available ? 1 : 0, id, cafe.id)
    .run();

  if (!result.meta || !result.meta.changes) return json({ error: "Item not found." }, 404);
  return json({ ok: true, item: { id, ...next } });
}

// Lets a new outlet clear the starter menu and start again from the seeded list.
async function adminReseedMenu(request, env, cafe) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  if (env.SEED_DEMO_DATA !== "true") {
    return json({ error: "Sample menu seeding is disabled." }, 409);
  }
  const statements = [env.DB.prepare("DELETE FROM menu_items WHERE cafe_id = ?").bind(cafe.id)];

  for (const [category, name, description, priceCents, emoji, sort] of SEED_MENU) {
    statements.push(
      env.DB.prepare(
        "INSERT INTO menu_items (cafe_id, category, name, description, price_cents, emoji, available, sort) VALUES (?, ?, ?, ?, ?, ?, 1, ?)"
      ).bind(cafe.id, category, name, description, priceCents, emoji, sort)
    );
  }

  await env.DB.batch(statements);
  return json({ ok: true, items: SEED_MENU.length });
}

async function adminDeleteItem(request, env, cafe, id) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  if (!Number.isFinite(id)) return json({ error: "Unknown item." }, 400);
  // Read the image key first so the R2 object can be cleaned up (best-effort).
  const row = await env.DB.prepare("SELECT image_key FROM menu_items WHERE id = ? AND cafe_id = ?")
    .bind(id, cafe.id)
    .first();
  const result = await env.DB.prepare("DELETE FROM menu_items WHERE id = ? AND cafe_id = ?")
    .bind(id, cafe.id)
    .run();
  if (!result.meta || !result.meta.changes) return json({ error: "Item not found." }, 404);
  if (row && row.image_key && env.IMAGES) {
    try { await env.IMAGES.delete(row.image_key); } catch (err) {
      console.error("Failed to delete menu image on item delete", { cafeId: cafe.id, itemId: id, error: err && err.message ? err.message : String(err) });
    }
  }
  return json({ ok: true });
}

async function getMenuImage(env, cafe, id) {
  if (!Number.isFinite(id)) return json({ error: "Not found" }, 404);
  const row = await env.DB.prepare("SELECT image_key FROM menu_items WHERE id = ? AND cafe_id = ?")
    .bind(id, cafe.id)
    .first();
  if (!row || !row.image_key) return json({ error: "Not found" }, 404);
  if (!env.IMAGES) return json({ error: "Storage is not configured." }, 503);
  let obj;
  try {
    obj = await env.IMAGES.get(row.image_key);
  } catch (err) {
    console.error("R2 read failed", { cafeId: cafe.id, itemId: id, error: err && err.message ? err.message : String(err) });
    return json({ error: "We couldn't load that image." }, 502);
  }
  if (!obj) return json({ error: "Not found" }, 404);
  let bytes;
  try {
    bytes = await obj.arrayBuffer();
  } catch (err) {
    console.error("R2 image body read failed", {
      cafeId: cafe.id,
      itemId: id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "We couldn't load that image." }, 502);
  }
  const contentType = (obj.httpMetadata && obj.httpMetadata.contentType) || "application/octet-stream";
  const headers = {
    "content-type": contentType,
    "x-content-type-options": "nosniff",
    "cache-control": "public, max-age=31536000, immutable",
  };
  if (obj.etag) headers.etag = obj.etag;
  // The URL carries ?v=<image_updated_at>, so a replacement is a new URL and the immutable cache
  // entry for the old one can never be shown again. No revalidation is needed.
  return new Response(bytes, { status: 200, headers });
}

async function adminUploadImage(request, env, cafe, id) {
  if (!Number.isFinite(id)) return json({ error: "Unknown item." }, 400);

  // CSRF parity with settings save.
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);

  const item = await env.DB.prepare("SELECT id, image_key FROM menu_items WHERE id = ? AND cafe_id = ?")
    .bind(id, cafe.id)
    .first();
  if (!item) return json({ error: "Item not found." }, 404);
  if (!env.IMAGES) return json({ error: "Image storage is not configured." }, 503);

  // Content-Length pre-check (best effort; streamed read is authoritative).
  const cl = request.headers.get("content-length");
  if (cl && Number(cl) > IMAGE_MAX_BYTES + 1024 * 64) {
    return json({ error: "That image is too large. Maximum 1 MB." }, 413);
  }

  const read = await readImageBytes(request);
  if (read.error) return json({ error: read.error }, read.status);
  const v = validateImageBytes(read.bytes);
  if (!v.ok) return json({ error: v.error }, v.status);

  const previousKey = item.image_key || null;
  const newKey = `cafes/${cafe.id}/menu/${id}/${crypto.randomUUID()}.${v.extension}`;

  // 1. Upload new image first.
  try {
    await env.IMAGES.put(newKey, read.bytes, { httpMetadata: { contentType: v.contentType } });
  } catch (err) {
    console.error("R2 upload failed", { cafeId: cafe.id, itemId: id, error: err && err.message ? err.message : String(err) });
    return json({ error: "We couldn't save that image. Please try again." }, 502);
  }

  // 2. Commit the D1 reference.
  const now = new Date().toISOString();
  let committed = false;
  try {
    const result = await env.DB.prepare(
      "UPDATE menu_items SET image_key = ?, image_updated_at = ? WHERE id = ? AND cafe_id = ?"
    )
      .bind(newKey, now, id, cafe.id)
      .run();
    if (!result.meta || !result.meta.changes) {
      throw new Error("no rows updated");
    }
    committed = true;
  } catch (err) {
    // Roll back the just-written object so we don't leak it.
    try {
      await env.IMAGES.delete(newKey);
    } catch (cleanupError) {
      console.error("Failed to remove orphaned R2 image after D1 update failure", {
        cafeId: cafe.id,
        itemId: id,
        key: newKey,
        error: cleanupError && cleanupError.message ? cleanupError.message : String(cleanupError),
      });
    }
    console.error("D1 update failed after R2 upload", { cafeId: cafe.id, itemId: id, error: err && err.message ? err.message : String(err) });
    return json({ error: "We couldn't save that image. Please try again." }, 502);
  }

  // 3. Delete the previous image only after the new reference is committed.
  if (previousKey) {
    try { await env.IMAGES.delete(previousKey); } catch (err) {
      console.error("Failed to delete previous menu image (orphan, retryable)", { cafeId: cafe.id, itemId: id, key: previousKey, error: err && err.message ? err.message : String(err) });
    }
  }

  return json({
    ok: true,
    imageUrl: itemImageUrl(cafe, id, newKey, now),
    hasCustomImage: true,
  });
}

async function adminRemoveImage(request, env, cafe, id) {
  if (!Number.isFinite(id)) return json({ error: "Unknown item." }, 400);

  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);

  const item = await env.DB.prepare("SELECT image_key FROM menu_items WHERE id = ? AND cafe_id = ?")
    .bind(id, cafe.id)
    .first();
  if (!item) return json({ error: "Item not found." }, 404);

  const previousKey = item.image_key || null;

  // Commit the D1 change first (restore default).
  const now = new Date().toISOString();
  const result = await env.DB.prepare(
    "UPDATE menu_items SET image_key = NULL, image_updated_at = ? WHERE id = ? AND cafe_id = ?"
  )
    .bind(now, id, cafe.id)
    .run();
  if (!result.meta || !result.meta.changes) return json({ error: "Item not found." }, 404);

  // Best-effort delete of the R2 object; orphan is retryable.
  if (previousKey && env.IMAGES) {
    try { await env.IMAGES.delete(previousKey); } catch (err) {
      console.error("Failed to delete removed menu image (orphan, retryable)", { cafeId: cafe.id, itemId: id, key: previousKey, error: err && err.message ? err.message : String(err) });
    }
  }

  return json({ ok: true, imageUrl: null, hasCustomImage: false });
}

async function adminCreateTable(request, env, cafe) {
  const csrf = await verifyCsrf(request, env, cookieName(cafe), ownerSessionIdOf);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the board and try again." }, 403);
  }
  const body = await readJson(request, BODY_LIMITS.table);

  // Ids stay globally unique; the number a guest sees counts up within this café only.
  const ids = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) AS value FROM tables").first();
  const numbers = await env.DB.prepare("SELECT COALESCE(MAX(number), 0) AS value FROM tables WHERE cafe_id = ?")
    .bind(cafe.id)
    .first();

  const id = (ids ? ids.value : 0) + 1;
  const number = (numbers ? numbers.value : 0) + 1;
  const label = String((body && body.label) || "").trim().slice(0, 40) || `Table ${number}`;
  const seats = Math.max(1, Math.min(20, Number(body && body.seats) || 2));

  await env.DB.prepare("INSERT INTO tables (id, cafe_id, number, label, seats) VALUES (?, ?, ?, ?, ?)")
    .bind(id, cafe.id, number, label, seats)
    .run();

  return json({ table: { id: number, label, seats } }, 201);
}

/* ------------------------------------------------------------------- utils */

// The signed subject decides who a token belongs to: `cafe:12` for a staff board, `operator` for
// the console that creates cafés. A token for one café is rejected by every other tenant.

// An audit row never carries a credential: no password, no hash, no session or CSRF token. An
// unknown cafe is recorded with a null cafe_id rather than dropped, and the table has no foreign
// key, so that insert cannot fail for the absence of the row it is reporting.
async function recordPasswordReset(env, cafeId, outcome) {
  try {
    await env.DB.prepare(
      'INSERT INTO password_resets (cafe_id, operator_identity, action, outcome, timestamp) ' +
        "VALUES (?, 'operator', 'reset_password', ?, ?)"
    )
      .bind(cafeId == null ? null : Number(cafeId), outcome, Date.now())
      .run();
  } catch (err) {
    console.error('Password reset audit write failed', {
      outcome,
      error: err && err.message ? err.message : String(err),
    });
  }
}

const PASSWORD_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const RESET_MIN_LENGTH = 12;

// Excludes look-alike characters so a password read off a screen is typed correctly.
function generatePassword(length = 16) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length];
  return out;
}

// The two statements of a reset, kept in one place so their SQL and bindings can be reviewed and
// tested on their own. The UPDATE is guarded by the version it expects; the audit row is selected
// out of the cafés table afterwards, so it can only exist for an update that actually landed.
export function passwordResetBatch(env, { cafeId, fromVersion, toVersion, passHash, now }) {
  return [
    env.DB.prepare(
      "UPDATE cafes SET pass_hash = ?, auth_version = auth_version + 1, password_changed_at = ? " +
        "WHERE id = ? AND auth_version = ?"
    ).bind(passHash, now, cafeId, fromVersion),
    env.DB.prepare(
      "INSERT INTO password_resets (cafe_id, operator_identity, action, outcome, timestamp) " +
        "SELECT c.id, 'operator', 'reset_password', 'success', ? FROM cafes c " +
        "WHERE c.id = ? AND c.auth_version = ? AND c.password_changed_at = ?"
    ).bind(now, cafeId, toVersion, now),
    // The reset ends the sessions it invalidates. The version bump already makes every token fail
    // closed; deleting the rows turns a revocation into a revocation instead of a later prune.
    env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ?").bind(cafeId),
  ];
}

// Operator-only. The UPDATE, the version bump and the success audit row are one D1 batch, and the
// audit insert only selects when that UPDATE landed, so a failure cannot leave a password change
// without its version bump or without its record.
async function operatorResetPassword(request, env, rawSlug) {
  const slug = String(rawSlug || '').toLowerCase();
  const cafe = await findCafeBySlug(env, slug);

  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) {
    await recordPasswordReset(env, cafe ? cafe.id : null, 'csrf_rejected');
    return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);
  }

  if (!cafe) {
    await recordPasswordReset(env, null, 'unknown_cafe');
    return json({ error: 'No cafe found at that web address.' }, 404);
  }

  const body = (await readJson(request, BODY_LIMITS.operatorReset)) || {};
  const supplied = body.password == null ? '' : String(body.password);
  const password = supplied === '' ? generatePassword() : supplied;
  if (password.length < RESET_MIN_LENGTH || password.length > 100) {
    await recordPasswordReset(env, cafe.id, 'short_password');
    return json({ error: 'The new password needs at least 12 characters.' }, 400);
  }

  const fromVersion = currentAuthVersion(cafe);
  if (fromVersion === null) {
    // Fail closed instead of letting a corrupt value be "repaired" into something an old token
    // could match; the row has to be fixed deliberately.
    await recordPasswordReset(env, cafe.id, 'invalid_version');
    return json(
      { error: "This café's stored session version is invalid. Fix the café row before resetting." },
      409
    );
  }

  const passHash = await hashPassword(password);
  const now = Date.now();
  const toVersion = fromVersion + 1;

  let results;
  try {
    results = await env.DB.batch(
      passwordResetBatch(env, { cafeId: cafe.id, fromVersion, toVersion, passHash, now })
    );
  } catch (err) {
    console.error('Password reset failed', {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "We couldn't reset that password. Nothing was changed." }, 500);
  }

  const updated = Number(results && results[0] && results[0].meta && results[0].meta.changes);
  const audited = Number(results && results[1] && results[1].meta && results[1].meta.changes);
  if (updated !== 1 || audited !== 1) {
    // The conditional insert refused a record for an update that did not happen. The batch is a
    // transaction, so the password was left exactly as it was.
    await recordPasswordReset(env, cafe.id, 'conflict');
    return json({ error: "This cafe's password changed while you were working. Reload and try again." }, 409);
  }

  const refreshed = await findCafeBySlug(env, slug);
  return json({
    ok: true,
    slug: cafe.slug,
    name: refreshed ? refreshed.name : cafe.name,
    password,
    authVersion: toVersion,
    passwordChangedAt: now,
    csrfToken: await issueCsrfToken(env, readCookie(request, OPERATOR_COOKIE)),
  });
}

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
  if (!/^user_[A-Za-z0-9_-]{1,128}$/.test(workosUserId)) {
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

  const target = String(workosUserId || "");
  const existing = await env.DB.prepare(
    "SELECT role FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?"
  )
    .bind(cafe.id, target)
    .first();
  if (!existing) {
    return json({ error: "That identity doesn't own this café." }, 404);
  }

  // Removing an owner is a revocation, not a bookkeeping change: the membership row, every live
  // session that identity holds for this café, and the credential version all move in one batch. The
  // version bump also kills any token whose row somehow survives, and `ownerSession()` refuses a
  // managed session with no membership row, so a removed owner cannot keep the board open.
  const now = Date.now();
  try {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM cafe_owners WHERE cafe_id = ? AND workos_user_id = ?").bind(cafe.id, target),
      env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ? AND workos_user_id = ?").bind(
        cafe.id,
        target
      ),
      env.DB.prepare("UPDATE cafes SET auth_version = auth_version + 1 WHERE id = ?").bind(cafe.id),
      env.DB.prepare(
        "INSERT INTO operator_audit (cafe_id, action, subject, detail, created) VALUES (?, 'revoke_owner', ?, '', ?)"
      ).bind(cafe.id, target, now),
    ]);
  } catch (err) {
    console.error("Owner revocation failed", {
      cafeId: cafe.id,
      error: err && err.message ? err.message : String(err),
    });
    return json({ error: "We couldn't revoke that owner. Nothing was changed." }, 500);
  }
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
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
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
