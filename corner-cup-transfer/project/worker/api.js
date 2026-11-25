import { json, readJson } from "./http.js";
import { newTrackNonce, readTrackToken, trackHash, trackToken, trackingConfigured } from "./tracking.js";
import { SEED_MENU, isIdempotencyIndexReady } from "./db.js";
import {
  CLAIM_LEASE_MS,
  abandonClaimStatement,
  claimReadStatement,
  claimStatement,
  commitClaimStatement,
  normalizeCheckoutBody,
  orderBatch,
  orderFingerprint,
  releaseStatement,
  takeoverStatement,
  tombstoneStatement,
} from "./orders.js";
import {
  cafeSettings,
  createCafe,
  defaultCafe,
  findCafeBySlug,
  hashPassword,
  publicCafe,
  verifyPassword,
} from "./cafes.js";

const STATUSES = ["new", "preparing", "ready", "served", "cancelled"];
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
// PhonePe Standard Checkout v2. Sandbox is the default so a stray deploy never moves real money.
const PHONEPE = {
  sandbox: {
    auth: "https://api-preprod.phonepe.com/apis/pg-sandbox/v1/oauth/token",
    checkout: "https://api-preprod.phonepe.com/apis/pg-sandbox/checkout/v2",
  },
  production: {
    auth: "https://api.phonepe.com/apis/identity-manager/v1/oauth/token",
    checkout: "https://api.phonepe.com/apis/pg/checkout/v2",
  },
};
const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";

export async function handleApi(request, env, url, ctx) {
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

  if (path[0] === "menu" && method === "GET") return getMenu(env, url, cafe);
  if (path[0] === "tables" && method === "GET") return getTables(env, cafe);
  if (path[0] === "config" && method === "GET") return getConfig(env, cafe);

  // Razorpay's dashboard accepts exactly one webhook URL; both spellings reach the same handler.
  if (path[0] === "razorpay" && path[1] === "webhook" && method === "POST") return razorpayWebhook(request, env, cafe, ctx);
  if (path[0] === "webhooks" && path[1] === "razorpay" && method === "POST") return razorpayWebhook(request, env, cafe, ctx);
  if (path[0] === "webhooks" && path[1] === "phonepe" && method === "POST") return phonepeWebhook(request, env, cafe);

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
    if (method === "POST" && path.length === 4 && path[2] === "payment" && path[3] === "phonepe") {
      return createPhonePePayment(request, env, cafe, path[1]);
    }
    if (method === "POST" && path.length === 5 && path[2] === "payment" && path[3] === "phonepe" && path[4] === "sync") {
      return syncPhonePePayment(request, env, cafe, path[1]);
    }
  }

  if (path[0] === "admin") {
    if (path[1] === "login" && method === "POST") return login(request, env, cafe);
    if (path[1] === "logout" && method === "POST") return logout(request, cafe);
    if (path[1] === "session" && method === "GET") return sessionStatus(env, request, cafe);

    // Without a secret no session can be verified; answer before sign() can throw.
    if (!authConfigured(env)) return authUnavailable("Staff sign-in");

    const authorised = await checkToken(env, readCookie(request, cookieName(cafe)), cafe);
    if (!authorised) return json({ error: "Your staff session expired. Please sign in again." }, 401);

    if (path[1] === "settings" && method === "GET") return adminSettings(cafe);
    if (path[1] === "settings" && method === "PATCH") return adminSaveSettings(request, env, cafe);

    if (path[1] === "orders" && method === "GET") return adminOrders(env, cafe);
    if (path[1] === "orders" && path[2] && method === "PATCH") return adminUpdateOrder(request, env, cafe, path[2]);

    if (path[1] === "menu" && path[2] === "reseed" && method === "POST") return adminReseedMenu(env, cafe);
    if (path[1] === "menu" && method === "GET") return adminMenu(env, cafe);
    if (path[1] === "menu" && method === "POST") return adminCreateItem(request, env, cafe);
    if (path[1] === "menu" && path[2] && method === "PATCH") return adminUpdateItem(request, env, cafe, Number(path[2]));
    if (path[1] === "menu" && path[2] && method === "DELETE") return adminDeleteItem(env, cafe, Number(path[2]));

    if (path[1] === "tables" && method === "GET") return getTables(env, cafe);
    if (path[1] === "tables" && method === "POST") return adminCreateTable(request, env, cafe);
  }

  return json({ error: "Not found" }, 404);
}

/* ---------------------------------------------------------------- operator */

const OPERATOR_COOKIE = "staff_operator";

// Operator sessions are `operator:<nonce>`, one random nonce per sign-in, so two logins can never
// receive the same token and a CSRF row can be tied to one specific session. A bare `operator`
// subject is the pre-nonce format: it is still accepted so a console already signed in when this
// ships keeps working until its 12-hour cookie expires, and it can be dropped after that.
async function checkOperator(env, token) {
  const subject = await tokenSubject(env, token);
  if (!subject) return false;
  if (subject === "operator") return true;
  return /^operator:[0-9a-f]{32}$/.test(subject);
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
    return json({ ok: true, expiresIn: SESSION_MAX_AGE, csrfToken: await issueCsrfToken(env, token) });
  }

  if (path[0] === "login" && method === "POST") return operatorLogin(request, env);

  if (path[0] === "logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0, OPERATOR_COOKIE) });
  }

  if (!authConfigured(env)) return authUnavailable("The operator console");

  const authorised = await checkOperator(env, readCookie(request, OPERATOR_COOKIE));
  if (!authorised) return json({ error: "Sign in to the operator console." }, 401);

  if (path[0] === "cafes" && path.length === 1 && method === "GET") return operatorCafes(env);
  if (path[0] === "cafes" && path.length === 1 && method === "POST") return operatorCreateCafe(request, env);
  if (path[0] === "cafes" && path.length === 3 && path[2] === "reset-password" && method === "POST") {
    return operatorResetPassword(request, env, path[1]);
  }

  return json({ error: "Not found" }, 404);
}

async function operatorLogin(request, env) {
  // Same secret signs operator sessions, so the console stays closed without it.
  if (!env.ADMIN_SECRET) {
    return json({ error: "The operator console isn't configured on this deployment." }, 503);
  }

  // Trim so a secret pasted with stray whitespace still matches what the user types.
  const expected = String(env.OPERATOR_PASSWORD || "").trim();
  if (!expected) {
    return json({ error: "The operator password isn't configured for this deployment." }, 503);
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
    return json({ error: "Too many attempts. Please try again in a few minutes." }, 429);
  }

  const body = await readJson(request);
  const attempt = String((body && (body.password || body.pin)) || "").trim();

  if (!attempt || !constantTimeEqual(attempt, expected)) {
    try {
      await touchRateLimit(env, lockoutKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES);
    } catch (err) {
      console.error("Operator login lockout update failed", { error: err && err.message ? err.message : String(err) });
      return json({ error: "The operator console isn't available right now. Please try again." }, 503);
    }
    return json({ error: "That password doesn't match." }, 401);
  }

  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(lockoutKey).run();
  } catch (err) {
    console.error("Operator login lockout reset failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "The operator console isn't available right now. Please try again." }, 503);
  }
  const operatorToken = await issueToken(env, operatorSubject());
  return json({ ok: true, expiresIn: SESSION_MAX_AGE, csrfToken: await issueCsrfToken(env, operatorToken) }, 200, {
    "set-cookie": sessionCookie(request, operatorToken, SESSION_MAX_AGE, OPERATOR_COOKIE),
  });
}

async function operatorCafes(env) {
  const { results } = await env.DB.prepare(
    "SELECT c.slug, c.name, c.service_mode, " +
      "(SELECT COUNT(*) FROM menu_items m WHERE m.cafe_id = c.id) AS menu_count, " +
      "(SELECT COUNT(*) FROM orders o WHERE o.cafe_id = c.id) AS order_count, " +
      "(SELECT COUNT(*) FROM orders o WHERE o.cafe_id = c.id AND o.status IN ('new', 'preparing', 'ready')) AS open_count " +
      "FROM cafes c ORDER BY c.name ASC"
  ).all();

  return json({
    cafes: (results || []).map((row) => ({
      slug: row.slug,
      name: row.name,
      serviceMode: row.service_mode === "counter" ? "counter" : "tables",
      menuCount: row.menu_count,
      orderCount: row.order_count,
      openCount: row.open_count,
    })),
  });
}

async function operatorCreateCafe(request, env) {
  // Café creation is a state-changing operator action, so it needs the same CSRF proof as a
  // password reset: an Origin that matches this deployment and a live token bound to the
  // operator session cookie that sent it.
  const csrf = await verifyCsrf(request, env);
  if (!csrf.ok) {
    return json({ error: "That request couldn't be verified. Reload the console and try again." }, 403);
  }

  const body = await readJson(request);
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
    "SELECT id, category, name, description, price_cents, emoji, available FROM menu_items WHERE cafe_id = ? ORDER BY sort ASC, name ASC"
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

function phonepeConfigured(env) {
  return Boolean(env.PHONEPE_CLIENT_ID && env.PHONEPE_CLIENT_SECRET && env.PHONEPE_CLIENT_VERSION);
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
      payments: paymentProvider(env),
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
  const body = await readJson(request);
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
  if (normalized.error) return json({ error: "One of those items isn't valid." }, 400);

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
  const id = await freshOrderId(env);

  // A fresh 192-bit nonce per order, and the token derived from it. Only sha256(token) is stored, and
  // the nonce, the hash and the order all land in one batch, so a retry can never point at a hash whose
  // order did not commit.
  const trackNonce = newTrackNonce();
  const token = await trackToken(env, { cafeId: cafe.id, orderId: id, nonce: trackNonce });
  const trackHashValue = await trackHash(token);

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
      // The claim was abandoned or taken over between the reserve and the write.
      const after = await claimReadStatement(env, { cafeId: cafe.id, key: idempotencyKey }).first();
      if (after && after.fingerprint !== fingerprint) return keyReusedResponse();
      if (after && after.state === "committed") return replayedOrderResponse(env, cafe, after.order_id);
      if (after && after.state === "abandoned") return abandonedResponse();
      return inProgressResponse();
    }
  } catch (err) {
    console.error("Order insert failed", {
      cafeId: cafe.id,
      orderId: id,
      error: err && err.message ? err.message : String(err),
    });

    const after = await claimReadStatement(env, { cafeId: cafe.id, key: idempotencyKey }).first();
    if (after && after.fingerprint !== fingerprint) return keyReusedResponse();
    if (after && after.state === "committed") return replayedOrderResponse(env, cafe, after.order_id);

    // Nothing was written, so hand the key back and let the guest retry the same checkout.
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

  const body = await readJson(request);
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

  const body = await readJson(request);
  // Choosing the counter is all a guest may do here. Confirming a payment belongs to the gateway or to
  // staff, never to the browser that placed the order.
  if (!body || body.status !== "counter") return json({ error: "Unknown payment option." }, 400);

  if (order.status === "cancelled") return json({ error: "This order was cancelled by the café." }, 409);
  if (order.payment_status === "confirmed") return json({ ok: true, paymentStatus: "confirmed" });

  await env.DB.prepare(
    "UPDATE orders SET payment_method = 'counter', payment_status = 'counter', updated_at = ? WHERE id = ? AND cafe_id = ?"
  )
    .bind(new Date().toISOString(), id, cafe.id)
    .run();
  return json({ ok: true, paymentStatus: "counter" });
}

// Creates a Razorpay order for a ticket so Checkout can collect UPI/card and the
// webhook can confirm it without staff involvement.
async function createRazorpayPayment(request, env, cafe, id) {
  if (!razorpayConfigured(env) || paymentProvider(env) !== "razorpay") {
    return json({ error: "Online payments aren't switched on yet." }, 503);
  }

  const order = await env.DB.prepare(
    "SELECT id, table_label, status, total_cents, payment_status FROM orders WHERE id = ? AND cafe_id = ?"
  )
    .bind(id, cafe.id)
    .first();

  if (!order) return json({ error: "We couldn't find that order." }, 404);
  if (order.payment_status === "confirmed") return json({ error: "This order is already paid." }, 409);
  if (order.status === "cancelled") return json({ error: "This order was cancelled by the café." }, 409);

  let response;
  try {
    response = await fetch(`${RAZORPAY_API}/orders`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Basic ${btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`)}`,
      },
      body: JSON.stringify({
        amount: order.total_cents,
        currency: "INR",
        receipt: order.id,
        notes: { order_id: order.id, table: order.table_label },
      }),
    });
  } catch (err) {
    console.error("Razorpay order request failed", err);
    return json({ error: "Couldn't reach the payment gateway. Please try again." }, 502);
  }

  if (!response.ok) {
    console.error("Razorpay order rejected", response.status, await response.text());
    return json({ error: "The payment gateway rejected this order. Please try again." }, 502);
  }

  const data = await response.json();

  await env.DB.prepare(
    "UPDATE orders SET payment_method = 'razorpay', payment_ref = ?, updated_at = ? WHERE id = ? AND cafe_id = ?"
  )
    .bind(data.id, new Date().toISOString(), id, cafe.id)
    .run();

  return json({
    payment: {
      provider: "razorpay",
      keyId: env.RAZORPAY_KEY_ID,
      razorpayOrderId: data.id,
      amount: order.total_cents,
      currency: "INR",
      name: cafeSettings(cafe).cafeName,
      description: `Order ${order.id} · ${order.table_label}`,
    },
  });
}

// Checkout hands the browser a signed triple (order id, payment id, signature). Verifying it
// here lets the ticket settle the moment the money is captured, without waiting for a webhook —
// which matters because a fresh Razorpay account has no webhook configured yet.
async function verifyRazorpayPayment(request, env, cafe, id, ctx) {
  if (!razorpayConfigured(env) || paymentProvider(env) !== "razorpay") {
    return json({ error: "Online payments aren't switched on yet." }, 503);
  }

  const body = await readJson(request);
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

/* ------------------------------------------------------------- PhonePe PG */

function phonepeHosts(env) {
  return String(env.PHONEPE_ENV || "sandbox").toLowerCase() === "production" ? PHONEPE.production : PHONEPE.sandbox;
}

// PhonePe tokens live ~30 minutes. Cache one per isolate and refresh a minute early so we
// don't call the auth API before every payment, which PhonePe's UAT checklist asks us to avoid.
let phonepeToken = { key: "", token: "", expiresAt: 0 };

async function phonepeAccessToken(env) {
  const hosts = phonepeHosts(env);
  const cacheKey = `${env.PHONEPE_CLIENT_ID}|${hosts.auth}`;
  if (phonepeToken.key === cacheKey && phonepeToken.expiresAt > Date.now() + 60_000) return phonepeToken.token;

  const response = await fetch(hosts.auth, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.PHONEPE_CLIENT_ID,
      client_version: env.PHONEPE_CLIENT_VERSION,
      client_secret: env.PHONEPE_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });

  if (!response.ok) throw new Error(`PhonePe auth failed (${response.status}): ${await response.text()}`);

  const data = await response.json();
  if (!data.access_token) throw new Error("PhonePe auth returned no token");

  const ttlMs =
    Number(data.expires_in) > 0
      ? Number(data.expires_in) * 1000
      : Number(data.expires_at) > 0
        ? Number(data.expires_at) - Date.now()
        : 900_000;

  phonepeToken = { key: cacheKey, token: data.access_token, expiresAt: Date.now() + Math.max(60_000, ttlMs) };
  return phonepeToken.token;
}

// PhonePe wants a unique merchantOrderId per attempt, so a retry after a failure doesn't
// collide with the previous one while the ticket keeps its own short order code.
function phonepeMerchantOrderId(orderId) {
  return `${orderId}${Date.now().toString(36).toUpperCase()}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 63);
}

async function createPhonePePayment(request, env, cafe, id) {
  if (!phonepeConfigured(env) || paymentProvider(env) !== "phonepe") {
    return json({ error: "PhonePe checkout isn't switched on for this site." }, 503);
  }

  const order = await env.DB.prepare(
    "SELECT id, table_id, table_label, status, total_cents, payment_status FROM orders WHERE id = ? AND cafe_id = ?"
  )
    .bind(id, cafe.id)
    .first();

  if (!order) return json({ error: "We couldn't find that order." }, 404);
  if (order.payment_status === "confirmed") return json({ error: "This order is already paid." }, 409);
  if (order.status === "cancelled") return json({ error: "This order was cancelled by the café." }, 409);

  const merchantOrderId = phonepeMerchantOrderId(order.id);
  const origin = new URL(request.url).origin;

  let response;
  let data;
  try {
    const token = await phonepeAccessToken(env);
    response = await fetch(`${phonepeHosts(env).checkout}/pay`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `O-Bearer ${token}` },
      body: JSON.stringify({
        merchantOrderId,
        amount: order.total_cents,
        expireAfter: 900,
        paymentFlow: {
          type: "PG_CHECKOUT",
          message: `${order.table_label} · order ${order.id}`,
          merchantUrls: { redirectUrl: `${origin}/c/${cafe.slug}/order/${order.id}?payment=phonepe` },
        },
        metaInfo: { udf1: order.id, udf2: order.table_label },
      }),
    });
    data = await response.json().catch(() => null);
  } catch (err) {
    console.error("PhonePe order request failed", err);
    return json({ error: "Couldn't reach PhonePe. Please try again." }, 502);
  }

  if (!response.ok || !data || !data.redirectUrl) {
    console.error("PhonePe order rejected", response.status, data);
    return json({ error: "PhonePe rejected this order. Please try again." }, 502);
  }

  await env.DB.prepare(
    "UPDATE orders SET payment_method = 'phonepe', payment_ref = ?, updated_at = ? WHERE id = ? AND cafe_id = ?"
  )
    .bind(merchantOrderId, new Date().toISOString(), id, cafe.id)
    .run();

  return json({ payment: { provider: "phonepe", merchantOrderId, redirectUrl: data.redirectUrl } });
}

// The redirect back from PhonePe isn't proof of payment, so we always ask PhonePe directly.
// That also covers a merchant account whose webhook isn't configured yet.
async function syncPhonePePayment(request, env, cafe, id) {
  if (!phonepeConfigured(env)) {
    return json({ error: "PhonePe checkout isn't switched on for this site." }, 503);
  }

  const order = await env.DB.prepare(
    "SELECT id, total_cents, payment_status, payment_method, payment_ref FROM orders WHERE id = ? AND cafe_id = ?"
  )
    .bind(id, cafe.id)
    .first();

  if (!order) return json({ error: "We couldn't find that order." }, 404);
  if (order.payment_status === "confirmed") return json({ ok: true, paymentStatus: "confirmed" });
  if (order.payment_method !== "phonepe" || !order.payment_ref) {
    return json({ error: "This order hasn't been sent to PhonePe yet." }, 409);
  }

  let data;
  try {
    const token = await phonepeAccessToken(env);
    const response = await fetch(
      `${phonepeHosts(env).checkout}/order/${encodeURIComponent(order.payment_ref)}/status`,
      { headers: { "content-type": "application/json", authorization: `O-Bearer ${token}` } }
    );
    data = await response.json().catch(() => null);
    if (!response.ok || !data) {
      console.error("PhonePe status check failed", response.status, data);
      return json({ error: "We couldn't confirm this payment with PhonePe yet." }, 502);
    }
  } catch (err) {
    console.error("PhonePe status request failed", err);
    return json({ error: "Couldn't reach PhonePe. Please try again." }, 502);
  }

  if (data.state === "COMPLETED") {
    const status = await confirmPhonePeOrder(env, cafe, order, data.amount, data.paymentDetails);
    return json({ ok: true, paymentStatus: status });
  }

  return json({ ok: true, paymentStatus: "unpaid", state: data.state || null });
}

// Shared by the status sync and the webhook. The amount must match what the ticket says,
// otherwise a cheaper payment would settle a bigger bill.
async function confirmPhonePeOrder(env, cafe, order, amount, paymentDetails) {
  const received = Number(amount);
  if (!Number.isFinite(received) || received < order.total_cents) {
    console.error("PhonePe amount mismatch", { order: order.id, expected: order.total_cents, received: amount });
    return "unpaid";
  }

  if (order.payment_status === "confirmed") return "confirmed";

  const attempt = Array.isArray(paymentDetails)
    ? paymentDetails.find((entry) => entry && entry.state === "COMPLETED") || paymentDetails[0]
    : null;
  const utr = attempt && attempt.rail && attempt.rail.utr ? attempt.rail.utr : null;
  const transactionId = (attempt && attempt.transactionId) || null;
  const now = new Date().toISOString();

  await env.DB.prepare(
    "UPDATE orders SET payment_status = 'confirmed', payment_method = 'phonepe', payment_txn = ?, paid_at = ?, updated_at = ? WHERE id = ? AND cafe_id = ?"
  )
    .bind(utr || transactionId, now, now, order.id, cafe.id)
    .run();

  return "confirmed";
}

// PhonePe signs webhooks as SHA256(username:password) in the Authorization header.
async function phonepeWebhook(request, env, cafe) {
  const username = env.PHONEPE_WEBHOOK_USERNAME;
  const password = env.PHONEPE_WEBHOOK_PASSWORD;
  if (!username || !password) return json({ error: "Webhook is not configured." }, 503);

  const raw = await request.text();
  const given = (request.headers.get("authorization") || "").trim();
  const expected = await sha256Hex(`${username}:${password}`);

  if (!given || !constantTimeEqual(given, expected)) {
    return json({ error: "Invalid signature." }, 400);
  }

  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid payload." }, 400);
  }

  const payload = (event && event.payload) || {};
  const merchantOrderId = payload.merchantOrderId || null;
  const ourOrderId = (payload.metaInfo && payload.metaInfo.udf1) || null;

  let order = null;
  if (merchantOrderId) {
    order = await env.DB.prepare(
      "SELECT id, total_cents, payment_status FROM orders WHERE payment_ref = ? AND payment_method = 'phonepe' AND cafe_id = ?"
    )
      .bind(merchantOrderId, cafe.id)
      .first();
  }
  if (!order && ourOrderId) {
    order = await env.DB.prepare("SELECT id, total_cents, payment_status FROM orders WHERE id = ? AND cafe_id = ?")
      .bind(ourOrderId, cafe.id)
      .first();
  }
  if (!order) return json({ ok: true, ignored: "unknown-order" });

  // Only the root-level payload.state decides the outcome; the event name can lag behind it.
  if (payload.state === "COMPLETED") {
    const status = await confirmPhonePeOrder(env, cafe, order, payload.amount, payload.paymentDetails);
    return json({ ok: true, paymentStatus: status });
  }

  if (payload.state === "FAILED") {
    console.error("PhonePe payment failed", { order: order.id, code: payload.errorCode || null });
    return json({ ok: true, failed: true });
  }

  return json({ ok: true, ignored: payload.state || (event && event.event) || "unknown-event" });
}

// Razorpay signs the raw body with the webhook secret; nothing is trusted until that checks out.
async function razorpayWebhook(request, env, cafe, ctx) {
  const secret = env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return json({ error: "Webhook is not configured." }, 503);

  const raw = await request.text();
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
const API_WINDOW_MS = 60 * 1000;
// A ceiling, not a throttle: every guest in the café shares one public IP across the NAT, and the
// order page polls while a ticket is open, so a low number would lock out a busy room.
const API_MAX_REQUESTS = 600;

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

// Returns a Response on limit/failure, or null when the request may proceed.
async function checkApiRateLimit(request, env) {
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

  // Opportunistic, bounded cleanup of expired rows. It runs only on a small fraction of API
  // requests, after the rate-limit decision has already been made, so it can never change that
  // decision and can never turn an allowed request into a denied one. Failures are contained and
  // logged generically.
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
const SESSION_COOKIE = "staff_session";
const SESSION_MAX_AGE = 12 * 60 * 60;

function readCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) return decodeURIComponent(part.slice(index + 1).trim());
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
function cookieName(cafe) {
  return `${SESSION_COOKIE}_${cafe.slug}`.slice(0, 60);
}


async function login(request, env, cafe) {
  // Sessions are signed with a deployment secret. A default would let anyone mint a staff session.
  if (!env.ADMIN_SECRET) {
    return json({ error: "Staff sign-in isn't configured on this deployment." }, 503);
  }
  // Every café signs in with its own stored hash. No deployment-wide fallback secret is consulted
  // here: one shared value used to open any café whose password was missing, and a short numeric pin
  // is not a password. An upgraded single-café install keeps its old password because the primary
  // café's hash is seeded once, at bootstrap (see worker/db.js).
  if (!cafe.pass_hash) {
    return json(
      {
        error:
          "This café hasn't set an owner password yet. Ask the operator to reset it from the operator console.",
      },
      503
    );
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
    return json({ error: "Too many attempts. Please try again in a few minutes." }, 429);
  }

  // --- CRITICAL RACE FIX: Capture auth_version BEFORE password verification ---
  // The version is read from the same café database row that supplies pass_hash, ensuring
  // the session token version is consistent with the password snapshot. If a password change
  // occurs after this capture but before session issuance, the session will carry the old
  // version and be correctly rejected by subsequent version checks.
  const version = cafe.auth_version;

  const body = await readJson(request);
  const attempt = String((body && (body.password || body.pin)) || "").trim();

  const ok = await verifyPassword(attempt, cafe.pass_hash);

  if (!ok) {
    try {
      await touchRateLimit(env, lockoutKey, LOGIN_MAX_FAILURES, LOGIN_WINDOW_MS, LOGIN_MAX_FAILURES);
    } catch (err) {
      console.error("Login lockout update failed", { error: err && err.message ? err.message : String(err) });
      return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
    }
    return json({ error: "That password doesn't match." }, 401);
  }

  // --- OPPORTUNISTIC REHASH: Upgrade legacy 100k hash to 600k iterations ---
  // After successful verification, replace the stored hash with a 600k-iteration hash
  // using compare-and-swap. The WHERE clause ensures we only replace the exact hash that
  // was verified during login. If the update affects 0 rows (concurrent password change),
  // we do not overwrite the newer password.
  const currentIterations = Number(cafe.pass_hash.split('$')[1]);
  const rehashNeeded = currentIterations < 600_000;
  if (rehashNeeded) {
    const newHash = await hashPassword(attempt);
    const rehashResult = await env.DB.prepare(
      "UPDATE cafes SET pass_hash = ? WHERE id = ? AND pass_hash = ?"
    ).bind(newHash, cafe.id, cafe.pass_hash).run();
    const rehashChanged = Number((rehashResult.meta && rehashResult.meta.changes) || 0) === 1;
  }

  try {
    await env.DB.prepare("DELETE FROM rate_limits WHERE key = ?").bind(lockoutKey).run();
  } catch (err) {
    console.error("Login lockout reset failed", { error: err && err.message ? err.message : String(err) });
    return json({ error: "Staff sign-in isn't available right now. Please try again." }, 503);
  }

  // Use the pre-verification version; do not re-read the latest version after verification.
  // If a password change occurred after the cafe row was read, the session carries the old
  // version and will be rejected by checkToken which re-reads the current auth_version.
  if (version === null) {
    console.error("Refusing an owner session: stored auth_version is invalid", { cafeId: cafe.id });
    return json({ error: "This café's sign-in isn't available right now. Please ask the operator." }, 503);
  }

  return json({ ok: true, expiresIn: SESSION_MAX_AGE }, 200, {
    "set-cookie": sessionCookie(request, await issueToken(env, ownerSubject(cafe, version)), SESSION_MAX_AGE, cookieName(cafe)),
  });


// The session lives in an HttpOnly cookie, so no script on the page (and no guest poking at
// devtools) can read or copy a staff token. SameSite=Strict stops another site riding it.
async function sessionStatus(env, request, cafe) {
  if (!authConfigured(env)) return authUnavailable("Staff sign-in");

  const authorised = await checkToken(env, readCookie(request, cookieName(cafe)), cafe);
  return authorised
    ? json({ ok: true, expiresIn: SESSION_MAX_AGE })
    : json({ error: "Not signed in." }, 401);
}

async function logout(request, cafe) {
  return json({ ok: true }, 200, { "set-cookie": sessionCookie(request, "", 0, cookieName(cafe)) });
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
  const body = await readJson(request);
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

  if (body.paymentStatus !== undefined) {
    const paymentStatus = String(body.paymentStatus);
    if (!PAYMENT_STATUSES.includes(paymentStatus)) return json({ error: "Unknown payment status." }, 400);
    sets.push("payment_status = ?");
    params.push(paymentStatus);
    if (paymentStatus === "counter") {
      // Staff taking cash is the one case where the rail itself changes: the ticket was never
      // settled online, so "upi" would misreport it.
      sets.push("payment_method = 'counter'");
    }
    if (paymentStatus === "confirmed" || paymentStatus === "counter") {
      sets.push("paid_at = ?");
      params.push(now);
    } else {
      sets.push("paid_at = NULL");
    }
  }

  if (sets.length === 0) return json({ error: "Nothing to update." }, 400);

  sets.push("updated_at = ?");
  params.push(now, id, cafe.id);

  const result = await env.DB.prepare(`UPDATE orders SET ${sets.join(", ")} WHERE id = ? AND cafe_id = ?`)
    .bind(...params)
    .run();

  if (!result.meta || !result.meta.changes) return json({ error: "Order not found." }, 404);
  return json({ ok: true });
}

// Everything a new outlet needs that used to live in Worker variables: name, service mode, the
// café clock and the contact details Razorpay's website review expects on the policy pages.
async function adminSettings(cafe) {
  return json({ slug: cafe.slug, settings: cafeSettings(cafe) });
}

async function adminSaveSettings(request, env, cafe) {
  const body = await readJson(request);
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
  if (body.password !== undefined) {
    const password = String(body.password);
    // The same 12-character floor the operator reset enforces, so a password cannot be weakened
    // by setting it here instead.
    if (password.length < 12 || password.length > 100) {
      return json({ error: "The owner password needs at least 12 characters." }, 400);
    }
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

  await env.DB.prepare(`UPDATE cafes SET ${columns.join(", ")} WHERE id = ?`)
    .bind(...values, cafe.id)
    .run();

  const updated = await findCafeBySlug(env, cafe.slug);

  // Every session minted before the change is now on an old version, including the one that made
  // it. The owner who changed the password gets a fresh cookie, so only their other devices are
  // signed out.
  if (passwordChanged) {
    const version = currentAuthVersion(updated);
    if (version === null) {
      // Cannot happen through the code paths above, but a session must never be stamped from a
      // value that is not a valid version.
      console.error("Password changed but auth_version is invalid; not reissuing a session", {
        cafeId: updated.id,
      });
      return json({ slug: updated.slug, settings: cafeSettings(updated) });
    }

    return json({ slug: updated.slug, settings: cafeSettings(updated) }, 200, {
      "set-cookie": sessionCookie(
        request,
        await issueToken(env, ownerSubject(updated, version)),
        SESSION_MAX_AGE,
        cookieName(updated)
      ),
    });
  }

  return json({ slug: updated.slug, settings: cafeSettings(updated) });
}

async function adminMenu(env, cafe) {
  const { results } = await env.DB.prepare(
    "SELECT id, category, name, description, price_cents, emoji, available FROM menu_items WHERE cafe_id = ? ORDER BY sort ASC, name ASC"
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
    })),
  });
}

async function adminCreateItem(request, env, cafe) {
  const body = await readJson(request);
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

async function adminUpdateItem(request, env, cafe, id) {
  if (!Number.isFinite(id)) return json({ error: "Unknown item." }, 400);
  const body = await readJson(request);
  if (!body || typeof body.available !== "boolean") {
    return json({ error: "Nothing to update." }, 400);
  }

  const result = await env.DB.prepare("UPDATE menu_items SET available = ? WHERE id = ? AND cafe_id = ?")
    .bind(body.available ? 1 : 0, id, cafe.id)
    .run();

  if (!result.meta || !result.meta.changes) return json({ error: "Item not found." }, 404);
  return json({ ok: true });
}

// Lets a new outlet clear the starter menu and start again from the seeded list.
async function adminReseedMenu(env, cafe) {
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

async function adminDeleteItem(env, cafe, id) {
  if (!Number.isFinite(id)) return json({ error: "Unknown item." }, 400);
  const result = await env.DB.prepare("DELETE FROM menu_items WHERE id = ? AND cafe_id = ?")
    .bind(id, cafe.id)
    .run();
  if (!result.meta || !result.meta.changes) return json({ error: "Item not found." }, 404);
  return json({ ok: true });
}

async function adminCreateTable(request, env, cafe) {
  const body = await readJson(request);

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

async function freshOrderId(env) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const id = randomCode(6);
    const existing = await env.DB.prepare("SELECT 1 AS found FROM orders WHERE id = ?").bind(id).first();
    if (!existing) return id;
  }
  return randomCode(8);
}

function randomCode(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = "";
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

// The signed subject decides who a token belongs to: `cafe:12` for a staff board, `operator` for
// the console that creates cafés. A token for one café is rejected by every other tenant.
async function issueToken(env, subject) {
  const expires = Date.now() + 12 * 60 * 60 * 1000;
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

async function tokenSubject(env, token) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [expires, subject, signature] = parts;
  if (!Number.isFinite(Number(expires)) || Number(expires) < Date.now()) return null;

  const expected = await sign(env, `${expires}.${subject}`);
  return constantTimeEqual(signature, expected) ? subject : null;
}

// An operator session subject: `operator:<16 random bytes as hex>`. The nonce is inside the signed
// payload, so it cannot be stripped or reused, and it is what keeps two same-millisecond sign-ins
// from minting the same token.
function operatorSubject() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return `operator:${[...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

// An owner session carries the version its password had when it was minted.
//
// An absent property (a database that has not run the reset migration) is version 1, which is what a
// legacy two-part token carries. A value that is *present but invalid* is not the same thing and
// must never be read as 1: doing so would silently let an old version-1 token authenticate against
// corrupt state. Invalid values return null and every caller fails closed.
export function authVersionFrom(raw) {
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

function ownerSubject(cafe, version) {
  return `cafe:${cafe.id}:${version}`;
}

// `cafe:12` predates versioning and counts as version 1; `cafe:12:3` is only good while the cafe
// is still on version 3. The id and the version are normalised and validated on their own.
function parseOwnerSubject(subject) {
  const parts = String(subject || '').split(':');
  if (parts[0] !== 'cafe') return null;
  if (parts.length !== 2 && parts.length !== 3) return null;
  if (!/^\d+$/.test(parts[1])) return null;
  const id = Number(parts[1]);
  if (!Number.isSafeInteger(id) || id < 1) return null;
  if (parts.length === 2) return { owner: `cafe:${id}`, version: 1 };
  if (!/^\d+$/.test(parts[2])) return null;
  const version = Number(parts[2]);
  if (!Number.isSafeInteger(version) || version < 1) return null;
  return { owner: `cafe:${id}`, version };
}

async function checkToken(env, token, cafe) {
  const subject = await tokenSubject(env, token);
  if (!subject) return false;
  const parsed = parseOwnerSubject(subject);
  if (!parsed) return false;
  if (parsed.owner !== `cafe:${cafe.id}`) return false;
  // An invalid stored version fails closed: no token authenticates against it, not even the
  // version-1 token that a missing column would have accepted.
  const expected = currentAuthVersion(cafe);
  if (expected === null) return false;
  // A reset bumps the version, so every token minted before it stops matching in the same instant.
  return parsed.version === expected;
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
// value in the header must hash to a live row bound to the session cookie that sent it.
async function verifyCsrf(request, env) {
  const origin = request.headers.get('origin');
  if (!origin || origin === 'null' || origin !== new URL(request.url).origin) {
    return { ok: false, reason: 'origin' };
  }

  const presented = String(request.headers.get(CSRF_HEADER) || '').trim();
  if (!presented) return { ok: false, reason: 'missing' };

  const operatorToken = readCookie(request, OPERATOR_COOKIE);
  if (!operatorToken) return { ok: false, reason: 'session' };

  const row = await env.DB.prepare('SELECT operator_key_hash, expires FROM csrf_tokens WHERE token_hash = ?')
    .bind(await sha256Hex(presented))
    .first();
  if (!row) return { ok: false, reason: 'unknown' };
  if (Number(row.expires) <= Date.now()) return { ok: false, reason: 'expired' };
  if (!constantTimeEqual(String(row.operator_key_hash), await sha256Hex(operatorToken))) {
    return { ok: false, reason: 'session' };
  }
  return { ok: true };
}

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

  const body = (await readJson(request)) || {};
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
