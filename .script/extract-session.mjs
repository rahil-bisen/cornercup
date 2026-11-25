// Stage 0 extraction: move the session/token/CSRF layer out of worker/api.js verbatim.
// Everything is located by unique anchors and sliced by index, so no line of the moved code is
// retyped and the diff inside each block is necessarily empty.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const API = "worker/api.js";
const OUT = "worker/session.js";

if (existsSync(OUT)) {
  console.error("worker/session.js already exists - refusing to overwrite");
  process.exit(1);
}

const src = readFileSync(API, "utf8");

function span(startAnchor, endAnchor) {
  const start = src.indexOf(startAnchor);
  if (start < 0) throw new Error(`start anchor not found: ${startAnchor.slice(0, 60)}`);
  const end = src.indexOf(endAnchor, start);
  if (end < 0) throw new Error(`end anchor not found: ${endAnchor.slice(0, 60)}`);
  return { start, end: end + endAnchor.length };
}

// 1. the per-café cookie constants and cookie helpers, up to the password sign-in handler
const cookieBlock = span("const SESSION_COOKIE = \"staff_session\";", "export function cookieName(cafe) {");
const cookieBlockEnd = src.indexOf("\n}\n", cookieBlock.start) >= 0 ? cookieBlock.start : cookieBlock.start;
// cookieName's body ends at the next top-level close; locate it precisely
const cookieNameStart = src.indexOf("export function cookieName(cafe) {");
const cookieNameEnd = src.indexOf("\n}\n", cookieNameStart) + 3;
const block1 = src.slice(cookieBlock.start, cookieNameEnd);

// 2. token, session and CSRF layer, from issueToken through verifyCsrf
const block2Start = src.indexOf("export async function issueToken(env, subject");
const block2EndAnchor = "\n}\n\n// An audit row never carries a credential";
const block2End = src.indexOf(block2EndAnchor, block2Start);
if (block2Start < 0 || block2End < 0) throw new Error("session layer anchors not found");
const block2 = src.slice(block2Start, block2End + 3);

// 3. signing primitives at the end of the file
const block3Start = src.indexOf("async function sign(env, message) {");
if (block3Start < 0) throw new Error("sign() not found");
const block3 = src.slice(block3Start).replace(/\s+$/, "\n");

// 4. the operator cookie name, used by verifyCsrf's default parameter
const operatorCookieDecl = "const OPERATOR_COOKIE = \"staff_operator\";\n";

// Remove spans, last first so earlier indices stay valid.
const spans = [
  { start: block3Start, end: block3Start + block3.length },
  { start: block2Start, end: block2End + 3 },
  { start: cookieBlock.start, end: cookieNameEnd },
  { start: src.indexOf(operatorCookieDecl), end: src.indexOf(operatorCookieDecl) + operatorCookieDecl.length },
].filter((s) => s.start >= 0).sort((a, b) => b.start - a.start);

let api = src;
for (const { start, end } of spans) api = api.slice(0, start) + api.slice(end);

const stripExport = (text) => text.replace(/^export (async function|function) /gm, "$1 ");

const session = `// Owner session, signed-token and CSRF primitives, extracted verbatim from worker/api.js (F-07
// phase 2B, stage 0). The extraction is behaviour-preserving: the SQL, the cookie attributes, the
// hashing, the timing-safe comparison, the 12-hour idle window and the 24-hour absolute cap below
// are the same code that was already shipping. worker/api.js imports every name back, so no call
// site changed and no second copy of this logic exists.
import { json } from "./http.js";

${stripExport(block1)}
${stripExport(block2)}
${stripExport(block3)}
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
`;

// The moved text declared OPERATOR_COOKIE inside api.js's operator section; it now lives here.
const withOperatorCookie = session.replace(
  "import { json } from \"./http.js\";\n",
  "import { json } from \"./http.js\";\n\n// Operator console cookie. Declared here because verifyCsrf's default binding is operator-scoped.\nconst OPERATOR_COOKIE = \"staff_operator\";\n"
);

const importLine =
  'import {\n' +
  '  SESSION_COOKIE,\n' +
  '  SESSION_MAX_AGE,\n' +
  '  SESSION_ABSOLUTE_MAX_AGE,\n' +
  '  SESSION_ABSOLUTE_MAX_MS,\n' +
  '  SESSION_OK,\n' +
  '  SESSION_NONE,\n' +
  '  SESSION_STORE_DOWN,\n' +
  '  CSRF_HEADER,\n' +
  '  OPERATOR_COOKIE,\n' +
  '  readCookie,\n' +
  '  sessionCookie,\n' +
  '  cookieName,\n' +
  '  issueToken,\n' +
  '  authConfigured,\n' +
  '  authUnavailable,\n' +
  '  tokenClaims,\n' +
  '  tokenSubject,\n' +
  '  operatorSessionId,\n' +
  '  operatorSubject,\n' +
  '  operatorSessionIdFromSubject,\n' +
  '  authVersionFrom,\n' +
  '  currentAuthVersion,\n' +
  '  ownerSubject,\n' +
  '  ownerSessionIdOf,\n' +
  '  parseOwnerSubject,\n' +
  '  ownerSessionId,\n' +
  '  createOwnerSession,\n' +
  '  deleteOwnerSession,\n' +
  '  removeOwnerSessionQuietly,\n' +
  '  pruneOwnerSessions,\n' +
  '  ownerSession,\n' +
  '  renewOwnerSession,\n' +
  '  issueCsrfToken,\n' +
  '  verifyCsrf,\n' +
  '  sign,\n' +
  '  sha256Hex,\n' +
  '  constantTimeEqual,\n' +
  '} from "./session.js";\n';

// Keep api.js's public surface: readCookie, cookieName, issueToken and authVersionFrom were exported.
const reExport =
  '\n// Re-exported so every existing importer of worker/api.js keeps working after the extraction.\n' +
  'export { readCookie, cookieName, issueToken, authVersionFrom } from "./session.js";\n';

const importAnchor = 'import {\n  cafeSettings,';
const at = api.indexOf(importAnchor);
if (at < 0) throw new Error("cafes.js import anchor not found");
api = api.slice(0, at) + importLine + api.slice(at);

// Append the re-export after the import block.
const firstCode = api.indexOf("\nconst STATUSES");
api = api.slice(0, firstCode) + reExport + api.slice(firstCode);

writeFileSync(OUT, withOperatorCookie);
writeFileSync(API, api);

console.log("session.js bytes:", withOperatorCookie.length);
console.log("api.js lines:", api.split("\n").length, "(was", src.split("\n").length + ")");
