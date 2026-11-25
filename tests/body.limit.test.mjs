// F-08: request body size limits.
//
// Two layers are tested separately.
//
// 1. The shared reader in worker/http.js, in-process: it must enforce a byte budget on the stream,
//    not on Content-Length, and it must degrade safely for malformed JSON, an unreadable stream and a
//    body that is read twice.
// 2. The real routes through the harnesses, so the 413 is observed where a client would see it and
//    the existing behaviour (401 for a wrong password, 400 for malformed JSON, 201 for a valid
//    order) is shown to survive next to it.

import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { BODY_LIMITS, BodyTooLargeError, readJson, readText } from "../worker/http.js";
import { HARNESS_OWNER_PASSWORD } from "./harness/credentials.mjs";

const BATCH = process.env.HARNESS_URL || "http://127.0.0.1:8789";
const AUTH = process.env.AUTH_HARNESS_URL || "http://127.0.0.1:8790";
const OPERATOR_PASSWORD = "operator-test-password";
const jsonHeaders = { "content-type": "application/json" };

const encoder = new TextEncoder();

function request(body, headers = {}) {
  return new Request("http://harness/bench", { method: "POST", headers, body });
}

// A body of exactly `n` bytes that is still valid JSON: {"v":"aaaa…"}.
function exactJson(n) {
  assert.ok(n >= 9, "needs room for the JSON envelope");
  const value = `{"v":"${"a".repeat(n - 8)}"}`;
  assert.equal(encoder.encode(value).byteLength, n, "helper must produce an exact byte count");
  return value;
}

// A valid credential body padded to exactly `n` bytes, so the limit can be tested without a failed
// attempt: failed sign-ins feed the café's lockout counter, and these tests must not spend it.
function exactLogin(n, password = HARNESS_OWNER_PASSWORD) {
  const envelope = (pad) => `{"password":${JSON.stringify(password)},"pad":"${pad}"}`;
  const pad = n - encoder.encode(envelope("")).byteLength;
  assert.ok(pad >= 0, "the envelope alone must fit inside the limit");
  const value = envelope("p".repeat(pad));
  assert.equal(encoder.encode(value).byteLength, n, "helper must produce an exact byte count");
  return value;
}

function streamOf(text, { failAfter = false, chunk = 64 } = {}) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) {
        if (failAfter) controller.error(new Error("client went away"));
        else controller.close();
        return;
      }
      controller.enqueue(bytes.slice(offset, offset + chunk));
      offset += chunk;
    },
  });
}

// ------------------------------------------------------------------ shared reader

test("F-08: a body under the limit is read and parsed", async () => {
  const parsed = await readJson(request('{"a":1}'), 100);
  assert.deepEqual(parsed, { a: 1 });
});

test("F-08: a body of exactly the limit is accepted, one byte more is refused", async () => {
  const limit = 256;
  assert.deepEqual(await readJson(request(exactJson(limit)), limit), { v: "a".repeat(limit - 8) });

  await assert.rejects(
    () => readJson(request(exactJson(limit + 1)), limit),
    (error) => error instanceof BodyTooLargeError,
    "one byte past the limit must be refused"
  );
});

test("F-08: the streamed byte count is enforced without Content-Length", async () => {
  // A stream body carries no Content-Length, which is how chunked uploads arrive.
  const req = new Request("http://harness/bench", {
    method: "POST",
    body: streamOf(exactJson(400)),
    duplex: "half",
  });
  assert.equal(req.headers.get("content-length"), null, "precondition: no declared length");

  await assert.rejects(() => readJson(req, 100), (error) => error instanceof BodyTooLargeError);
});

test("F-08: an understated Content-Length does not bypass the limit", async () => {
  const req = new Request("http://harness/bench", {
    method: "POST",
    body: streamOf(exactJson(400)),
    duplex: "half",
  });
  req.headers.set("content-length", "10");
  assert.equal(req.headers.get("content-length"), "10", "precondition: the claim is falsified low");

  await assert.rejects(
    () => readJson(req, 100),
    (error) => error instanceof BodyTooLargeError,
    "the stream still decides, not the header"
  );
});

test("F-08: a declared length above the limit is refused without reading the body", async () => {
  const req = new Request("http://harness/bench", {
    method: "POST",
    body: streamOf(exactJson(50)),
    duplex: "half",
  });
  req.headers.set("content-length", "9999");

  await assert.rejects(() => readJson(req, 100), (error) => error instanceof BodyTooLargeError);
});

test("F-08: bytes are counted as UTF-8 bytes, not characters", async () => {
  // Nine characters, eighteen bytes.
  const text = "é".repeat(9);
  await assert.rejects(
    () => readText(request(text), 10),
    (error) => error instanceof BodyTooLargeError,
    "a multi-byte body must be measured in bytes"
  );
  assert.equal(await readText(request(text), 18), text, "and accepted at its real byte size");
});

test("F-08: malformed JSON and an empty body are null, as before", async () => {
  assert.equal(await readJson(request('{"a":'), 100), null);
  assert.equal(await readJson(request("not json at all"), 100), null);
  assert.equal(await readJson(request(""), 100), null);
});

test("F-08: an interrupted stream is null, not a throw", async () => {
  const req = new Request("http://harness/bench", {
    method: "POST",
    body: streamOf(exactJson(400), { failAfter: true }),
    duplex: "half",
  });
  assert.equal(await readJson(req, 10_000), null, "a broken stream is a bad body, not an exception");
});

test("F-08: reading the same request twice is safe", async () => {
  const req = request('{"a":1}');
  assert.deepEqual(await readJson(req, 100), { a: 1 });
  assert.equal(await readJson(req, 100), null, "the second read reports a bad body rather than throwing");
});

test("F-08: every endpoint has a limit, and the largest is the webhook budget", () => {
  for (const [name, value] of Object.entries(BODY_LIMITS)) {
    assert.ok(Number.isSafeInteger(value) && value > 0, `${name} must be a positive byte budget`);
  }
  assert.equal(BODY_LIMITS.login, 1024);
  assert.equal(BODY_LIMITS.checkout, 16384);
  assert.equal(BODY_LIMITS.webhook, 65536);
  const largest = Math.max(...Object.values(BODY_LIMITS));
  assert.equal(largest, BODY_LIMITS.webhook);
});

// ------------------------------------------------------------------ real routes

let batchAlive = false;
try {
  const probe = await fetch(`${BATCH}/read`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ cafeId: -1, key: "probe" }),
  });
  batchAlive = probe.status === 200;
} catch {
  batchAlive = false;
}

let authAlive = false;
try {
  const probe = await fetch(`${AUTH}/read`, {
    method: "POST",
    headers: jsonHeaders,
    body: JSON.stringify({ cafeId: -1, key: "probe" }),
  });
  authAlive = probe.status === 200;
} catch {
  authAlive = false;
}

const skipBatch = batchAlive ? false : `harness not reachable at ${BATCH}`;
const skipAuth = authAlive ? false : `auth harness not reachable at ${AUTH}`;

const seed = async (base, body = {}) =>
  (
    await fetch(`${base}/seed`, {
      method: "POST",
      headers: jsonHeaders,
      body: JSON.stringify(body),
    })
  ).json();

const clean = (base, cafeId) =>
  fetch(`${base}/clean`, { method: "POST", headers: jsonHeaders, body: JSON.stringify({ cafeId }) });

const login = (base, slug, bodyText, extra = {}) =>
  fetch(`${base}/api/cafes/${slug}/admin/login`, {
    method: "POST",
    headers: { ...jsonHeaders, origin: base, ...extra },
    body: bodyText,
  });

test("F-08: sign-in under, at, and past its limit", { skip: skipAuth }, async () => {
  const cafe = await seed(AUTH, { serviceMode: "counter", password: HARNESS_OWNER_PASSWORD });
  try {
    const normal = JSON.stringify({ password: HARNESS_OWNER_PASSWORD });
    assert.equal((await login(AUTH, cafe.slug, normal)).status, 200, "normal sign-in behaviour is unchanged");

    const exact = exactLogin(BODY_LIMITS.login);
    assert.equal(exact.length, BODY_LIMITS.login);
    assert.equal((await login(AUTH, cafe.slug, exact)).status, 200, "exactly at the limit is allowed through");

    // A wrong password at the limit is still a credential answer, not a size answer.
    assert.equal(
      (await login(AUTH, cafe.slug, exactLogin(BODY_LIMITS.login, "not-the-password"))).status,
      401,
      "a body at the limit reaches the credential check"
    );

    const over = await login(AUTH, cafe.slug, exactJson(BODY_LIMITS.login + 1));
    assert.equal(over.status, 413, "one byte past the limit is refused");
    const payload = await over.json();
    assert.deepEqual(payload, { error: "That request is too large." }, "one generic message, no limit, no payload");
    assert.equal(over.headers.get("cache-control"), "no-store", "the 413 carries the usual JSON headers");

    // Streamed body with no Content-Length: the byte count, not the header, decides.
    const streamed = await fetch(`${AUTH}/api/cafes/${cafe.slug}/admin/login`, {
      method: "POST",
      headers: { ...jsonHeaders, origin: AUTH },
      body: streamOf(exactJson(BODY_LIMITS.login + 200)),
      duplex: "half",
    });
    assert.equal(streamed.status, 413, "a chunked body is bounded too");
  } finally {
    await clean(AUTH, cafe.cafeId);
  }
});

test("F-08: a chunked body with no Content-Length is refused on a real socket", { skip: skipAuth }, async () => {
  const cafe = await seed(AUTH, { serviceMode: "counter", password: HARNESS_OWNER_PASSWORD });
  try {
    const status = await new Promise((resolve, reject) => {
      const target = new URL(AUTH);
      const payload = encoder.encode(exactJson(2000));
      const frames = [];
      for (let offset = 0; offset < payload.length; offset += 500) {
        const slice = payload.slice(offset, offset + 500);
        frames.push(Buffer.from(`${slice.length.toString(16)}\r\n`), Buffer.from(slice), Buffer.from("\r\n"));
      }
      frames.push(Buffer.from("0\r\n\r\n"));

      const socket = net.connect(Number(target.port), target.hostname, () => {
        // Chunked framing with no Content-Length: only a streamed byte count can bound this.
        socket.write(
          `POST /api/cafes/${cafe.slug}/admin/login HTTP/1.1\r\n` +
            `Host: ${target.host}\r\n` +
            "Content-Type: application/json\r\n" +
            "Transfer-Encoding: chunked\r\n" +
            "Connection: close\r\n\r\n"
        );
        for (const frame of frames) socket.write(frame);
      });
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("latin1");
        const match = buffer.match(/^HTTP\/1\.1 (\d{3})/);
        if (match) {
          socket.destroy();
          resolve(Number(match[1]));
        }
      });
      socket.on("error", reject);
      socket.setTimeout(10_000, () => {
        socket.destroy();
        reject(new Error("timed out waiting for a response"));
      });
    });

    assert.equal(status, 413, "a body declared (or forced) beyond the limit is refused");
  } finally {
    await clean(AUTH, cafe.cafeId);
  }
});

test("F-08: a checkout over its limit is refused, a normal one still commits", { skip: skipBatch }, async () => {
  const cafe = await seed(BATCH, { serviceMode: "counter" });
  try {
    const order = (bodyText, key) =>
      fetch(`${BATCH}/api/cafes/${cafe.slug}/orders`, {
        method: "POST",
        headers: { ...jsonHeaders, origin: BATCH, "idempotency-key": key },
        body: bodyText,
      });

    const normal = JSON.stringify({ items: [{ itemId: cafe.itemId, qty: 1 }], note: "no onions" });
    const created = await order(normal, crypto.randomUUID());
    assert.equal(created.status, 201, "a normal checkout is unaffected");

    const oversized = await order(exactJson(BODY_LIMITS.checkout + 1), crypto.randomUUID());
    assert.equal(oversized.status, 413, "an oversized checkout is refused before parsing");
    assert.deepEqual(await oversized.json(), { error: "That request is too large." });

    const malformed = await order('{"items":[', crypto.randomUUID());
    assert.equal(malformed.status, 400, "malformed JSON still answers 400, not 413");
  } finally {
    await clean(BATCH, cafe.cafeId);
  }
});

test("F-08: operator reset is bounded and keeps its CSRF gate", { skip: skipAuth }, async () => {
  const cafe = await seed(AUTH, { serviceMode: "counter", password: HARNESS_OWNER_PASSWORD });
  try {
    const signIn = await fetch(`${AUTH}/api/operator/login`, {
      method: "POST",
      headers: { ...jsonHeaders, origin: AUTH },
      body: JSON.stringify({ password: OPERATOR_PASSWORD }),
    });
    assert.equal(signIn.status, 200);
    const payload = await signIn.json();
    const raw = (signIn.headers.getSetCookie?.() || [])[0] || signIn.headers.get("set-cookie") || "";
    const cookie = raw.split(";")[0];

    const reset = (bodyText, csrf) =>
      fetch(`${AUTH}/api/operator/cafes/${cafe.slug}/reset-password`, {
        method: "POST",
        headers: {
          ...jsonHeaders,
          origin: AUTH,
          cookie,
          ...(csrf ? { "x-csrf-token": csrf } : {}),
        },
        body: bodyText,
      });

    assert.equal(
      (await reset(exactJson(BODY_LIMITS.operatorReset + 1), null)).status,
      403,
      "without a CSRF token the gate answers before the body is read"
    );
    assert.equal(
      (await reset(exactJson(BODY_LIMITS.operatorReset + 1), payload.csrfToken)).status,
      413,
      "with a valid token an oversized body is refused"
    );
  } finally {
    await clean(AUTH, cafe.cafeId);
  }
});

test("F-08: webhooks keep their configuration gate before any body handling", { skip: skipAuth }, async () => {
  const cafe = await seed(AUTH, { serviceMode: "counter" });
  try {
    const res = await fetch(`${AUTH}/api/cafes/${cafe.slug}/webhooks/razorpay`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-razorpay-signature": "x" },
      body: exactJson(1024),
    });
    assert.equal(res.status, 503, "an unconfigured webhook is 503, exactly as before F-08");
  } finally {
    await clean(AUTH, cafe.cafeId);
  }
});
