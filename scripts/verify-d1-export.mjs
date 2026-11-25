// Verifies a D1 logical export without touching any database server.
//
// What it does, in order:
//   1. Reads the dump as bytes and prints size + SHA-256 (never modifies the file).
//   2. Optionally decrypts an AES-256-CBC/PBKDF2 export and checks the round trip is byte-identical.
//   3. Imports the SQL into a fresh temporary SQLite file using Node's built-in SQLite (no server, no
//      network, no remote database, no Worker).
//   4. Runs PRAGMA integrity_check, PRAGMA foreign_key_check, and lists tables/indexes with row counts.
//   5. Emits a JSON report and exits non-zero if anything fails.
//
// It is deliberately generic: it never assumes the Corner Cup schema, and it never prints row contents.
//
// Usage:
//   node scripts/verify-d1-export.mjs <dump.sql> [--sha256 <expected>] [--report <path>]
//   node scripts/verify-d1-export.mjs <dump.sql.enc> --decrypt --passphrase-file <path> [--sha256 <expected>]
//
// The passphrase is read from a file, never from argv, so it does not land in shell history or process
// listings. Encryption matches the documented disaster-recovery recipe:
//   openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in dump.sql -out dump.sql.enc -pass file:key

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const source = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--sha256" && args[args.indexOf(a) - 1] !== "--report" && args[args.indexOf(a) - 1] !== "--passphrase-file");
if (!source) fail("usage: verify-d1-export.mjs <dump.sql> [--sha256 <hex>] [--report <path>] [--decrypt --passphrase-file <path>]");

const flagValue = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};

const decrypt = args.includes("--decrypt");
let bytes = fs.readFileSync(source);
const originalBytes = bytes.length;
const sourceSha256 = crypto.createHash("sha256").update(bytes).digest("hex");

if (decrypt) {
  const passFile = flagValue("--passphrase-file");
  if (!passFile) fail("--decrypt needs --passphrase-file");
  const passphrase = fs.readFileSync(passFile, "utf8").replace(/\r?\n$/, "");
  if (!passphrase) fail("passphrase file is empty");
  // OpenSSL "Salted__" container: 8-byte magic, 8-byte salt, then AES-256-CBC ciphertext.
  if (bytes.subarray(0, 8).toString("latin1") !== "Salted__") fail("not an OpenSSL salted container");
  const salt = bytes.subarray(8, 16);
  const ciphertext = bytes.subarray(16);
  const keyIv = crypto.pbkdf2Sync(passphrase, salt, 200_000, 48, "sha256");
  const decipher = crypto.createDecipheriv("aes-256-cbc", keyIv.subarray(0, 32), keyIv.subarray(32, 48));
  bytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  // Re-encrypt and compare so the round trip is proven, not assumed.
  const reKeyIv = crypto.pbkdf2Sync(passphrase, salt, 200_000, 48, "sha256");
  const cipher = crypto.createCipheriv("aes-256-cbc", reKeyIv.subarray(0, 32), reKeyIv.subarray(32, 48));
  const reCiphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
  const reContainer = Buffer.concat([Buffer.from("Salted__", "latin1"), salt, reCiphertext]);
  if (!reContainer.equals(fs.readFileSync(source))) fail("encrypted round trip is not byte-identical");
}

const plainSha256 = crypto.createHash("sha256").update(bytes).digest("hex");
const expected = flagValue("--sha256");
if (expected && expected.toLowerCase() !== plainSha256 && expected.toLowerCase() !== sourceSha256) {
  fail(`SHA-256 mismatch: expected ${expected}, got plain ${plainSha256} / file ${sourceSha256}`);
}

const sql = bytes.toString("utf8");
if (!sql.trim()) fail("dump is empty");
if (/\bDROP\s+TABLE\b/i.test(sql) && !/CREATE\s+TABLE/i.test(sql)) {
  // A dump that drops without creating is a destructive script, not a backup.
  fail("dump contains DROP TABLE but no CREATE TABLE");
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "d1-verify-"));
const dbPath = path.join(tmpDir, "restore.sqlite");
const db = new DatabaseSync(dbPath);
let report;
try {
  db.exec(sql);
  const integrity = db.prepare("PRAGMA integrity_check").all().map((r) => Object.values(r)[0]);
  const fk = db.prepare("PRAGMA foreign_key_check").all();
  const objects = db
    .prepare("SELECT type, name FROM sqlite_master WHERE type IN ('table','index','trigger','view') ORDER BY type, name")
    .all();
  const tables = objects.filter((o) => o.type === "table" && !o.name.startsWith("sqlite_"));
  const counts = {};
  for (const table of tables) {
    const quoted = `"${table.name.replace(/"/g, '""')}"`;
    counts[table.name] = db.prepare(`SELECT COUNT(*) AS n FROM ${quoted}`).get().n;
  }
  report = {
    source,
    sourceBytes: originalBytes,
    plainBytes: bytes.length,
    decrypted: decrypt,
    sha256: { file: sourceSha256, plain: plainSha256 },
    sha256Matches: expected ? true : null,
    integrityCheck: integrity,
    integrityOk: integrity.length === 1 && integrity[0] === "ok",
    foreignKeyViolations: fk.length,
    counts: {
      tables: tables.length,
      indexes: objects.filter((o) => o.type === "index").length,
      triggers: objects.filter((o) => o.type === "trigger").length,
      views: objects.filter((o) => o.type === "view").length,
    },
    tables: counts,
    restoredAt: path.join("<temp>", "restore.sqlite"),
  };
} finally {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

report.ok = report.integrityOk && report.foreignKeyViolations === 0 && report.counts.tables > 0;
console.log(JSON.stringify(report, null, 2));

const reportPath = flagValue("--report");
if (reportPath) {
  fs.mkdirSync(path.dirname(path.resolve(reportPath)), { recursive: true });
  fs.writeFileSync(path.resolve(reportPath), JSON.stringify(report, null, 2) + "\n");
}
if (!report.ok) fail("restore verification did not pass");
