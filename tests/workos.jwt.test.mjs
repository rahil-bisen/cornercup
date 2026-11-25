// F-07 phase 2B: the pure verification layer. These tests prove the code enforces what it claims —
// RS256 only, strict audience, a single issuer, a bounded clock skew, and a provider session id that
// is either valid or absent. They do not prove anything about real WorkOS tokens.
import test from "node:test";
import assert from "node:assert/strict";
import { decodeJwt, providerSessionId, selectKey, verifyToken, validateClaims } from "../worker/jwt.js";
import { CLIENT_ID, ISSUER, claimsFor, mintToken } from "./fixtures/workos.mjs";

// The fixture owns the keypair. The test fetches the same JWKS document the Worker would, from the
// loopback provider, so key selection is exercised against real key material.
import { startProvider } from "./fixtures/workos.mjs";

let provider;
let jwks;

test.before(async () => {
  provider = await startProvider();
  const response = await fetch(`${provider.url}/sso/jwks/${CLIENT_ID}`);
  jwks = await response.json();
});

test.after(async () => {
  await provider.close();
});

const verify = (token, overrides = {}) =>
  verifyToken(token, {
    jwks,
    issuer: ISSUER,
    audience: CLIENT_ID,
    now: Date.now(),
    ...overrides,
  });

test("a well-formed token with a valid sid verifies and reports it", async () => {
  const token = mintToken(claimsFor({ sid: "session_abc123" }));
  const result = await verify(token);
  assert.equal(result.ok, true);
  assert.equal(result.claims.sub, "user_test_1");
  assert.equal(result.sessionId, "session_abc123");
});

test("a missing sid still authenticates and reports null", async () => {
  const claims = claimsFor();
  delete claims.sid;
  const result = await verify(mintToken(claims));
  assert.equal(result.ok, true);
  assert.equal(result.sessionId, null);
});

test("a malformed sid authenticates but is never stored or invented", async () => {
  for (const sid of ["", "abc", 42, null, { id: "session_x" }, "session_", "../session_x"]) {
    const result = await verify(mintToken(claimsFor({ sid })));
    assert.equal(result.ok, true, `sid ${JSON.stringify(sid)} must not block sign-in`);
    assert.equal(result.sessionId, null, `sid ${JSON.stringify(sid)} must not be stored`);
  }
});

test("the algorithm is pinned to RS256", async () => {
  const token = mintToken(claimsFor(), { alg: "HS256" });
  const result = await verify(token);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "alg");
});

test("a missing kid is rejected rather than guessed", async () => {
  const head = { alg: "RS256", typ: "JWT" };
  const claims = claimsFor();
  const encoded = Buffer.from(JSON.stringify(head)).toString("base64url");
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const result = await verify(`${encoded}.${body}.AAAA`);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "kid");
});

test("an unknown key is rejected even after one refetch", async () => {
  const token = mintToken(claimsFor(), { kid: "unknown-kid" });
  let refetched = 0;
  const result = await verify(token, {
    refetch: async () => {
      refetched += 1;
      return jwks;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-key");
  assert.equal(refetched, 1);
});

test("a tampered payload fails the signature", async () => {
  const token = mintToken(claimsFor());
  const [header, , signature] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ ...claimsFor(), sub: "user_attacker" })).toString("base64url");
  const result = await verify(`${header}.${forged}.${signature}`);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "signature");
});

test("the issuer is one exact string", async () => {
  const wrong = await verify(mintToken({ ...claimsFor(), iss: `${ISSUER}/` }));
  assert.equal(wrong.reason, "issuer");
  assert.equal((await verify(mintToken({ ...claimsFor(), iss: "https://evil.test" }))).reason, "issuer");
});

test("the audience is strict: absent, wrong and array forms", async () => {
  const missing = claimsFor();
  delete missing.aud;
  assert.equal((await verify(mintToken(missing))).reason, "audience-missing");
  assert.equal((await verify(mintToken({ ...claimsFor(), aud: "other_client" }))).reason, "audience");
  assert.equal((await verify(mintToken({ ...claimsFor(), aud: [CLIENT_ID] }))).ok, true);
  assert.equal((await verify(mintToken({ ...claimsFor(), aud: ["other", CLIENT_ID] }))).ok, true);
});

test("exp, iat and nbf are enforced with a bounded skew", async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await verify(mintToken({ ...claimsFor(), exp: now - 120 }))).reason, "expired");
  assert.equal((await verify(mintToken({ ...claimsFor(), iat: now + 600 }))).reason, "iat-future");
  assert.equal((await verify(mintToken({ ...claimsFor(), nbf: now + 600 }))).reason, "not-yet-valid");
  assert.equal((await verify(mintToken({ ...claimsFor(), nbf: now - 10 }))).ok, true);
});

test("the subject must match the expected identity", async () => {
  const token = mintToken(claimsFor({ sub: "user_other" }));
  const result = await verify(token, { expectedSubject: "user_test_1" });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "sub-mismatch");
});

test("a structurally broken token is rejected before any claims are read", async () => {
  for (const bad of ["", "a.b", "a.b.c.d", "....", "not-a-token"]) {
    const result = await verify(bad);
    assert.equal(result.ok, false);
    assert.equal(result.reason, "malformed", `token ${JSON.stringify(bad)}`);
  }
  assert.equal(decodeJwt("a.b.c"), null);
});

test("key selection requires exactly one matching RSA signing key", () => {
  assert.ok(selectKey(jwks, "test-kid-1"));
  assert.equal(selectKey(jwks, "missing"), null);
  assert.equal(selectKey({ keys: [{ kid: "k", kty: "oct", k: "abc" }] }, "k"), null);
  assert.equal(selectKey({ keys: [{ kid: "k", kty: "RSA", n: "x", e: "AQAB", use: "enc" }] }, "k"), null);
  assert.equal(selectKey({ keys: [{ kid: "k", kty: "RSA", n: "x", e: "AQAB", alg: "RS512" }] }, "k"), null);
});

test("providerSessionId accepts only the documented shape", () => {
  assert.equal(providerSessionId({ sid: "session_abc" }), "session_abc");
  for (const bad of [undefined, null, "", 1, {}, [], "session_" + "x".repeat(200)]) {
    assert.equal(providerSessionId({ sid: bad }), null);
  }
});

test("validateClaims refuses to run without an issuer or audience configured", () => {
  assert.equal(validateClaims(claimsFor(), { audience: CLIENT_ID }).ok, false);
  assert.equal(validateClaims(claimsFor(), { issuer: ISSUER }).ok, false);
});
