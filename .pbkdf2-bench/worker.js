// Isolated PBKDF2 CPU benchmark. Deliberately standalone: no D1, KV, R2, assets, secrets beyond its
// own access token, no routes, no imports from the application. It re-implements the exact Web Crypto
// call worker/passwords.js makes (importKey "raw" -> PBKDF2 -> deriveBits 256 bits, SHA-256, base64)
// so the measurement is of the same platform primitive, not of a lookalike.
//
// The password is a fixed synthetic string. It is not a credential and is not logged. Salts are
// random per call. No hash value is returned, only lengths, so nothing here can be replayed.

const SYNTHETIC_PASSWORD = "benchmark-only-not-a-credential";
const MAX_ITERATIONS = 1_000_000;

function fromBase64(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromBase64(salt), iterations, hash: "SHA-256" },
    key,
    256
  );
  let binary = "";
  for (const byte of new Uint8Array(bits)) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function randomSalt() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let salt = "";
  for (const byte of bytes) salt += String.fromCharCode(byte);
  return btoa(salt);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") return Response.json({ ok: true });

    if (url.pathname !== "/bench") return Response.json({ error: "not found" }, { status: 404 });

    // The endpoint is reachable on workers.dev, so it takes a token. A missing token is a 503, a
    // wrong one a 403; neither distinguishes anything useful to a guesser.
    if (!env.BENCH_TOKEN) return Response.json({ error: "not configured" }, { status: 503 });
    if (request.headers.get("x-bench-token") !== env.BENCH_TOKEN) {
      return Response.json({ error: "forbidden" }, { status: 403 });
    }

    const iterations = Number(url.searchParams.get("iterations") || 600000);
    const mode = url.searchParams.get("mode") === "verify" ? "verify" : "hash";
    if (!Number.isSafeInteger(iterations) || iterations < 1000 || iterations > MAX_ITERATIONS) {
      return Response.json({ error: "iterations out of range" }, { status: 400 });
    }

    // Workers only advance timers around I/O, so this wall-clock number is advisory: it is not the
    // CPU time. The authoritative figure comes from Cloudflare's invocation metrics.
    const started = performance.now();

    let derivedLength = 0;
    if (mode === "hash") {
      const salt = randomSalt();
      derivedLength = (await derive(SYNTHETIC_PASSWORD, salt, iterations)).length;
    } else {
      // Verification: derive with the stored iteration count, then compare in constant time.
      const salt = randomSalt();
      const stored = await derive(SYNTHETIC_PASSWORD, salt, iterations);
      const candidate = await derive(SYNTHETIC_PASSWORD, salt, iterations);
      let mismatch = 0;
      for (let i = 0; i < candidate.length; i += 1) mismatch |= candidate.charCodeAt(i) ^ stored.charCodeAt(i);
      derivedLength = stored.length + (mismatch === 0 ? 0 : 1000);
    }

    const wallMs = performance.now() - started;

    return Response.json({
      ok: true,
      iterations,
      mode,
      wallMsAdvisory: Math.round(wallMs * 1000) / 1000,
      derivedLength,
      note: "wall clock only; CPU time must be read from Cloudflare invocation metrics",
    });
  },
};
