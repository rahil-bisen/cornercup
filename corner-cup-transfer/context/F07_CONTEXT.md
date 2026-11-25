# F07_CONTEXT.md — F-07 Technical Context: PBKDF2 Password-Hash Strengthening

This document provides the complete technical context for the F-07 implementation: PBKDF2 password-hash strengthening from 100,000 to 600,000 iterations with safe opportunistic rehashing and login-race correction.

## Existing PBKDF2 Hash Format

### Hash String Structure
All stored password hashes follow the PBKDF2 format:
```
pbkdf2$<iterations>$<salt>$<hash>
```

### Iteration Count Location
The iteration count is the second `$`-delimited segment: `parts[1]` after `String(stored).split("$")`.

### Verification Flow
`verifyPassword(password, stored)`:
1. Splits the stored hash by `$`: `[scheme, iterationsRaw, salt, hash]`
2. Checks `scheme === "pbkdf2"`
3. Parses `iterations = Number(iterationsRaw)`
4. Validates `Number.isFinite(iterations) && iterations >= 1000`
5. Derives candidate key: `derive(password, salt, iterations)`
6. Compares candidate length to stored hash length
7. XORs candidate and stored hash bytes; returns `mismatch === 0`

### Backward Compatibility
`verifyPassword` reads the iteration count from the stored hash string. This means:
- Hashes with `100000` iterations verify correctly
- Hashes with `600000` iterations verify correctly
- The iteration count is data-driven, not code-driven

## Previous 100,000 Iteration Setting

### Constant Location
`worker/passwords.js` line 5 (prior to F-07 change):
```javascript
const PBKDF2_ITERATIONS = 100_000;
```

### Hash Generation
`hashPassword(password)` derived using:
```javascript
const key = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(password),
  "PBKDF2", false, ["deriveBits"]
);
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", salt: fromBase64(salt), iterations: 100_000, hash: "SHA-256" },
  key, 256
);
return `pbkdf2$${100_000}$${salt}$${hash}`;
```

### Existing Hashes in Deployment
- Primary café bootstrap may have 100k iteration hashes from before F-07
- Operator resets and password changes generate new hashes at whatever `PBKDF2_ITERATIONS` was at the time
- All existing hashes verify unchanged via `verifyPassword` reading iterations from the hash string

## New 600,000 Iteration Setting

### Constant Location
`worker/passwords.js` line 5 (after F-07 change):
```javascript
const PBKDF2_ITERATIONS = 600_000;
```

### Hash Generation
`hashPassword(password)` derived using:
```javascript
const bits = await crypto.subtle.deriveBits(
  { name: "PBKDF2", salt: fromBase64(salt), iterations: 600_000, hash: "SHA-256" },
  key, 256
);
return `pbkdf2$${600_000}$${salt}$${hash}`;
```

### Performance Impact
- 600k iterations ~6x slower than 100k iterations (local measurements: 31ms median → 185ms median)
- Login latency increases for new password hashes
- Opportunistic rehash during login amortizes the cost (only happens on successful login with legacy hash)

## Legacy Hash Verification

### Backward Compatibility Assurance
`verifyPassword(password, stored)` works with ANY valid PBKDF2 hash regardless of iteration count because:
1. It extracts `iterations` from the hash string `pbkdf2$<iterations>$<salt>$<hash>`
2. It uses those iterations for derivation
3. It does not reference `PBKDF2_ITERATIONS` constant at verification time

### Verification of Existing 100k Hashes
- Hashes like `pbkdf2$100000$c2FsdA==$aGFzaA==` verify correctly
- No code change needed in `verifyPassword` for backward compatibility
- The constant `PBKDF2_ITERATIONS` only affects NEW hash generation

## Opportunistic Rehash

### Trigger Condition
Rebuild runs after successful password verification in login:
```javascript
const currentIterations = Number(cafe.pass_hash.split('$')[1]);
const rehashNeeded = currentIterations < 600_000;
if (rehashNeeded) {
  // generate and store 600k hash
}
```

### Rehash Flow in login() (worker/api.js:1656-1666)

1. After `verifyPassword(attempt, cafe.pass_hash)` succeeds
2. Read current iterations from `cafe.pass_hash.split('$')[1]`
3. If `currentIterations < 600_000`, generate new hash: `const newHash = await hashPassword(attempt)`
4. Compare-and-swap UPDATE: `UPDATE cafes SET pass_hash = ? WHERE id = ? AND pass_hash = ?`
5. Bind: `newHash` (new hash), `cafe.id` (café ID), `cafe.pass_hash` (verified old hash)
6. If UPDATE affects 1 row: hash upgraded to 600k iterations
7. If UPDATE affects 0 rows: concurrent password change occurred; do NOT overwrite; proceed with login

### Compare-and-Swap SQL
```sql
UPDATE cafes SET pass_hash = ? WHERE id = ? AND pass_hash = ?
```
- Parameter 1: new hash (600k iterations)
- Parameter 2: café id
- Parameter 3: the exact old hash that was verified during login
- The WHERE clause ensures: only update if the stored hash still matches what was just verified
- This is a proper compare-and-swap: the row is only modified if the password hasn't changed since login began

## auth_version

### Purpose
`auth_version` is an integer column on the `cafes` table that version-stamps the café's authentication state. It works with session tokens of the format `cafe:<id>:<version>`.

### Version Behavior
- New cafés start at `auth_version = 1` (adopted during migration)
- Explicit password changes/resets increment: `auth_version = auth_version + 1`
- Rehashing does NOT increment `auth_version`
- Session tokens carry the version they were minted with: `cafe:<id>:<version>`

### Session Token Format
`ownerSubject(cafe, version)` returns ``cafe:${cafe.id}:${version}``

### checkToken Validation
```javascript
async function checkToken(env, token, cafe) {
  const parsed = parseOwnerSubject(token);  // extracts version from token
  const expected = currentAuthVersion(cafe);  // reads CURRENT version from DB
  return parsed.version === expected;         // compares token version vs current
}
```
- `checkToken` reads the CURRENT `auth_version` from the database
- If a password change occurred after login captured the old version, the session token carries the old version, and `checkToken` rejects it (because `parsed.version !== currentAuthVersion(cafe)`)

### Pre-Fix Race Condition (now resolved)
- **Before**: login read `version = currentAuthVersion(cafe)` AFTER `verifyPassword` succeeded
- **After**: login captures `version = cafe.auth_version` BEFORE `verifyPassword`; session uses captured version; `checkToken` re-reads current version for comparison

### F-07 Race Fix
The login function now:
1. Captures `version = cafe.auth_version` from the database row (BEFORE password verification)
2. Verifies password: `ok = await verifyPassword(attempt, cafe.pass_hash)`
3. Issues session token with the CAPTURED version: `ownerSubject(cafe, version)`
4. Does NOT re-read `currentAuthVersion(cafe)` after verification
5. If password changed between steps 1 and 3, session carries old version; `checkToken` correctly rejects it on next request

## Session Issuance

### Session Creation Flow (post-F-07)

1. `const version = cafe.auth_version;` — captured BEFORE verifyPassword
2. `const ok = await verifyPassword(attempt, cafe.pass_hash);` — password verification
3. If `ok`:
   - Rate limit reset: `DELETE FROM rate_limits WHERE key = ?`
   - Opportunistic rehash (if current iterations < 600k)
   - `return json({ ok: true, expiresIn: SESSION_MAX_AGE }, 200, {
       "set-cookie": sessionCookie(request, await issueToken(env, ownerSubject(cafe, version)), SESSION_MAX_AGE, cookieName(cafe)),
     });`
4. Session cookie: `staff_session_<slug>` with value `cafe:<id>:<captured_version>`

### Key Post-F-07 Behavior
- Session token version = the `auth_version` captured BEFORE password verification
- If password changes after capture but before session issuance, the session carries the OLD version
- On subsequent request, `checkToken` reads CURRENT `auth_version` and rejects the session (version mismatch)
- This is the intended behavior: "If a password change occurred meanwhile, normal session validation must reject that session"

## Session Validation

### checkToken Function (worker/api.js:2167-2180)

```javascript
async function checkToken(env, token, cafe) {
  const subject = await tokenSubject(env, token);
  if (!subject) return false;
  const parsed = parseOwnerSubject(subject);
  if (!parsed) return false;
  if (parsed.owner !== `cafe:${cafe.id}`) return false;
  const expected = currentAuthVersion(cafe);
  if (expected === null) return false;
  return parsed.version === expected;
}
```

### Validation Logic

| Condition | Result |
|---|---|
| Token version === current DB version | ✅ Accepted |
| Token version !== current DB version | ❌ Rejected (401) |
| current `auth_version` is null | ❌ Rejected (503) |
| Token's owner !== café's id | ❌ Rejected |
| Token not parseable | ❌ Rejected |

### Post-F-07 Race Prevention
If password changes during login:
- Login captured version=1 before verification
- Password changed, auth_version bumped to 2
- Session token: `cafe:12:1` (version 1)
- `checkToken`: reads current auth_version=2, compares 1 !== 2 → REJECTED
- ✅ Old password session correctly rejected

## Authentication Race Condition and Fix

### The Race Condition (Pre-F-07)

| Timeline | Event |
|---|---|
| T1 | Login reads cafe row: auth_version=1, pass_hash=old-100k-hash |
| T2 | Operator changes password → auth_version=2, pass_hash=new-600k-hash |
| T3 | Login verifies old password against old-100k-hash → succeeds |
| T4 | Login reads `currentAuthVersion(cafe)` → gets 2 (new version) |
| T5 | Session token minted: `cafe:12:2` (version 2) |
| T5 Bug | Session `cafe:12:2` is valid for the NEW password, but the user typed the OLD password |
| Result | User gets valid session for old password — race win |

### The Fix (F-07)

| Timeline | Event |
|---|---|
| T1 | Login captures `version = cafe.auth_version` = 1 (from row snapshot) |
| T2 | Operator changes password → auth_version=2, pass_hash=new-600k-hash |
| T3 | Login verifies old password against old-100k-hash → succeeds |
| T4 | Session token minted: `cafe:12:1` (captured version, NOT re-read) |
| T4 Fix | Session token uses CAPTURED version 1, not the newly-read version 2 |
| T5 | `checkToken` reads current auth_version=2, compares 1 !== 2 → REJECTED |
| Result | Old password session correctly rejected; user must re-login with new password |

### Critical Code Difference

**Pre-F-07 (line ~1485, old code)**:
```javascript
// Refuse to mint a session from a version that cannot be trusted: a token stamped with a bad
// number would either never match or match the wrong thing.
const version = currentAuthVersion(cafe);  // ← AFTER verifyPassword
```

**Post-F-07 (line 1638, new code)**:
```javascript
// --- CRITICAL RACE FIX: Capture auth_version BEFORE password verification ---
// The version is read from the same café database row that supplies pass_hash, ensuring
// the session token version is consistent with the password snapshot.
const version = cafe.auth_version;  // ← BEFORE verifyPassword
```

### Password Change and Reset Behavior (Post-F-07)

| Action | auth_version Increment | Session Invalidation |
|---|---|---|
| Opportunistic rehash (legacy → 600k) | ❌ No | ✅ Session unchanged; rehash uses compare-and-swap |
| Explicit owner password change (board) | ✅ Yes (`auth_version = auth_version + 1`) | ✅ All old sessions invalidated (checkToken compares to new version) |
| Operator password reset | ✅ Yes (in batch, atomically with audit) | ✅ All old sessions for that café invalidated |
| Login with legacy hash + rehash | ❌ No | ✅ Session proceeds with captured version; rehash is silent |

### Shared hashPassword Implementation

All password paths use the shared `hashPassword` from `worker/passwords.js`:

| Path | File | Implementation |
|---|---|---|
| Café creation | `worker/cafes.js` | `import { hashPassword } from "./passwords.js"` |
| Owner password change (board) | `worker/api.js:1923` | `patch.pass_hash = await hashPassword(password);` |
| Operator reset password | `worker/api.js:passwordResetBatch` | Uses `hashPassword` via batch operation |
| Primary café bootstrap | `worker/db.js:1` | `import { hashPassword } from "./passwords.js"` |
| Login opportunistic rehash | `worker/api.js:1659` | `const newHash = await hashPassword(attempt);` |
| Password reset (operator) | `worker/db.js` (reset flow) | Uses shared implementation |

All paths use the SAME `PBKDF2_ITERATIONS` constant, so all new hashes are consistent.

## Required Regression Tests

The following test scenarios must be covered (10 required tests from F-07 specification):

### Test 1: New Hashes Encode 600,000 Iterations
- Hash generated by `hashPassword()` must contain `600000` in the iteration count position
- Verification: `hash.split("$")[1]` should equal `600000`

### Test 2: Correct and Incorrect Password Verification
- `verifyPassword(correct_password, hash_of_correct_password)` → `true`
- `verifyPassword(incorrect_password, hash_of_correct_password)` → `false`

### Test 3: Existing 100,000-Iteration Hashes Still Verify
- Hashes with `pbkdf2$100000$...` verify correctly via `verifyPassword`
- No code change needed; verifyPassword reads iterations from hash string

### Test 4: Successful Legacy Login Upgrades the Hash
- Login with 100k-iteration hash succeeds
- After successful login, stored hash is upgraded to 600k iterations
- Subsequent logins use 600k-iteration hash

### Test 5: Rehash Compare-and-Swap Does Not Overwrite Concurrently Changed Password
- If password changes during login, rehash UPDATE WHERE pass_hash = ? affects 0 rows
- The original pass_hash is preserved; login proceeds with the new password
- The session carries the captured version; checkToken will reject on next request if version mismatch

### Test 6: Rehashing Does Not Change auth_version or Invalidate Existing Sessions
- Rehash code path does NOT include `auth_version = auth_version + 1`
- Existing sessions remain valid (or invalidated only by explicit password change, not rehash)
- auth_version only increments on explicit password changes/resets

### Test 7: Password Changes Still Increment auth_version and Invalidate Old Sessions
- Explicit password change via admin board: `auth_version = auth_version + 1`
- Session tokens with old version are invalidated by checkToken
- Owner who changed password gets a fresh cookie; other devices signed out

### Test 8: Login That Reads Old Hash Cannot Obtain Valid Session If Password Changes Before Session Issuance
- Race condition: version captured before verifyPassword
- If password changes after capture, session carries old version
- checkToken correctly rejects session with old version when current version is newer
- User must re-login with new password

### Test 9: Failed or Zero-Row Rehash Does Not Turn Valid Password Into Failed Login
- If rehash UPDATE affects 0 rows (concurrent change), login proceeds with existing hash
- The verified password continues to work
- Login is not rejected due to rehash failure

### Test 10: All Password Creation, Change, Bootstrap, and Reset Paths Use the Shared hashImplementation
- `hashPassword` imported from `worker/passwords.js` in all relevant modules
- `PBKDF2_ITERATIONS` is the single source of truth for iteration count
- No duplicate hashing implementations

## Current Node.js/Wrangler Validation Blocker

### Environment Status
- Node.js v22.23.4 available at `.tools/node-v22.23.4-win-x64/`
- npm 10.9.9 available
- Production build (`vite build`) succeeds
- Local test suite: 48 of 89 tests pass; 39 skipped (auth harness unavailable); 2 fail (harness-dependent)

### What Cannot Run Without the Harness
- Full auth-enabled Wrangler harness on port 8790
- All tests requiring `HARNESS_URL` or `AUTH_HARNESS_URL`
- PBKDF2 benchmark in Cloudflare Worker runtime
- Opportunistic rehash end-to-end flow (concurrent password change during login)
- Session race condition verification (checkToken version comparison)
- Password reset batch flow with audit logging

### What Can Run Locally
- Migration-based tests (`migrations.test.mjs`) — pass locally
- Non-harness test suites (`api.resilience.test.mjs`, `migrations.test.mjs`, `rate.limits.migration.test.mjs`)
- Production build (`vite build`)
- Unit-like tests that don't require D1 bindings or admin secret

### Cloudflare Worker CPU Compatibility Question

#### Local Benchmark Measurements (wall-clock, NOT Cloudflare production CPU)
Using Node.js `crypto.subtle` with PBKDF2-HMAC-SHA256:

| Iteration Count | Median Time | p95 Time |
|---|---|---|
| 100,000 | ~31ms | ~38ms |
| 600,000 | ~185ms | ~227ms |

#### Important Distinctions
- These are LOCAL wall-clock measurements on a Windows workstation
- They do NOT establish Cloudflare CPU compatibility or production performance
- Cloudflare Workers have different CPU characteristics (warm vs cold isolates, miniflare vs actual Worker)
- The 600k iteration count may have different performance characteristics in workerd vs local Node.js
- No remote deployment or production CPU measurement has been performed
- The iteration count change is a security strengthening; performance impact is expected and acceptable

#### Recommendation
- The 600k iteration strengthening is a security decision, not a performance optimization
- Local measurements show acceptable latency (185ms median is within typical login SLA)
- Production CPU impact should be measured after deployment with actual Cloudflare Worker metrics
- The change is designed to be backward compatible (existing 100k hashes verify unchanged)

### F-07 Validation Summary
- ✅ PBKDF2_ITERATIONS changed from 100_000 to 600_000
- ✅ verifyPassword backward compatible (reads iterations from hash string)
- ✅ Opportunistic rehash with compare-and-swap implemented
- ✅ Login race condition fixed (version captured before verifyPassword)
- ✅ auth_version not incremented during rehash
- ✅ Explicit password changes still increment auth_version atomically
- ✅ Production build passes
- ❌ Full test suite blocked (harness unavailable at port 8790)
- ❌ Full PBKDF2 benchmark blocked (no Cloudflare Worker runtime measurement)
- ❌ End-to-end race condition verification blocked (harness required)
- ⚠️ Local wall-clock benchmarks possible; not Cloudflare production measurements
- ⚠️ F-07 is code-complete but not harness-verified