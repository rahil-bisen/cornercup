// F-07 phase 2B fixtures. A deterministic provider on a loopback port, a JWT minter with a real RSA
// keypair, and a D1-shaped shim over node:sqlite so the production SQL can run in a plain test.
//
// Nothing here is a credential: the keypair is generated per process, the client secret is a literal
// test string, and no request ever leaves the machine.
import { createServer } from "node:http";
import { generateKeyPairSync, sign as rsaSign } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export const CLIENT_ID = "client_test_phase2b";
export const API_KEY = "sk_test_phase2b_not_a_secret";
export const ISSUER = `https://api.workos.com/user_management/${CLIENT_ID}`;

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });

const b64url = (buffer) =>
  Buffer.from(buffer).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

export function mintToken(payload, header = {}) {
  const head = { alg: "RS256", typ: "JWT", kid: "test-kid-1", ...header };
  const input = `${b64url(JSON.stringify(head))}.${b64url(JSON.stringify(payload))}`;
  const signature = rsaSign("RSA-SHA256", Buffer.from(input), privateKey);
  return `${input}.${b64url(signature)}`;
}

export function claimsFor({ sub = "user_test_1", sid = "session_test_1", email = "owner@example.test" } = {}) {
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: ISSUER, aud: CLIENT_ID, sub, iat: now, exp: now + 300, email };
  if (sid !== undefined) claims.sid = sid;
  return claims;
}

// Starts the provider. `provider.identity` controls the next authenticate response, `provider.mode`
// lets a test make the provider fail, and `provider.requests` records what actually arrived.
export async function startProvider() {
  const provider = {
    identity: { id: "user_test_1", email: "owner@example.test", email_verified: true },
    accessToken: null,
    authenticateStatus: 200,
    revokeStatus: 200,
    requests: [],
  };

  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const url = new URL(req.url, "http://127.0.0.1");
      let payload = null;
      try {
        payload = body ? JSON.parse(body) : null;
      } catch {
        payload = null;
      }
      provider.requests.push({ method: req.method, path: url.pathname, body: payload });

      const send = (status, json) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(json));
      };

      if (url.pathname === `/sso/jwks/${CLIENT_ID}`) {
        return send(200, { keys: [{ ...jwk, kid: "test-kid-1", alg: "RS256", use: "sig" }] });
      }

      if (url.pathname === "/user_management/authenticate") {
        if (provider.authenticateStatus !== 200) return send(provider.authenticateStatus, { error: "denied" });
        if (!payload || payload.client_id !== CLIENT_ID || payload.client_secret !== API_KEY) {
          return send(401, { error: "bad-client" });
        }
        if (payload.grant_type !== "authorization_code" || !payload.code) return send(400, { error: "bad-grant" });
        const token = provider.accessToken || mintToken(claimsFor({ sub: provider.identity.id }));
        return send(200, { user: provider.identity, access_token: token });
      }

      if (url.pathname === "/user_management/sessions/revoke") {
        return send(provider.revokeStatus, { ok: provider.revokeStatus === 200 });
      }

      return send(404, { error: "not-found" });
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  provider.url = `http://127.0.0.1:${server.address().port}`;
  provider.close = () => new Promise((resolve) => server.close(resolve));
  return provider;
}

// ------------------------------------------------------------------ D1 shim

// A D1-shaped facade over node:sqlite. `batch` uses a savepoint so a failing statement rolls the
// whole batch back, which is the D1 behaviour the atomicity tests depend on.
export function sqliteDb() {
  const db = new DatabaseSync(":memory:");

  const prepare = (sql) => {
    let params = [];
    const api = {
      bind(...values) {
        params = values;
        return api;
      },
      async run() {
        const statement = db.prepare(sql);
        const result = statement.run(...params);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      async all() {
        return { results: db.prepare(sql).all(...params) };
      },
      async first() {
        // RETURNING needs the row-returning path; node:sqlite's run() discards those rows.
        if (/\bRETURNING\b/i.test(sql)) {
          const rows = db.prepare(sql).all(...params);
          return rows.length ? rows[0] : null;
        }
        return db.prepare(sql).get(...params) ?? null;
      },
    };
    return api;
  };

  return {
    raw: db,
    prepare,
    async batch(statements) {
      db.exec("SAVEPOINT d1_batch");
      const out = [];
      try {
        for (const statement of statements) out.push(await statement.run());
        db.exec("RELEASE d1_batch");
        return out;
      } catch (err) {
        db.exec("ROLLBACK TO d1_batch");
        db.exec("RELEASE d1_batch");
        throw err;
      }
    },
    async exec(sql) {
      db.exec(sql);
    },
  };
}

export function testEnv(provider, overrides = {}) {
  return {
    DB: null,
    ADMIN_SECRET: "test-admin-secret-phase2b",
    WORKOS_CLIENT_ID: CLIENT_ID,
    WORKOS_API_KEY: API_KEY,
    WORKOS_REDIRECT_URI: "http://127.0.0.1/api/owner/callback",
    WORKOS_ISSUER: ISSUER,
    WORKOS_AUDIENCE: CLIENT_ID,
    WORKOS_STATE_ENCRYPTION_KEY: "state-encryption-key-for-tests-0123456789",
    WORKOS_API_BASE: provider.url,
    ...overrides,
  };
}
