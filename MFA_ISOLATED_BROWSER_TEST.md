# MFA ISOLATED BROWSER ACCEPTANCE TEST

**Status: environment prepared — manual browser tests NOT yet performed.** Nothing below is recorded as
passing. A person must run the checklist in a browser.

This environment is completely separate from the café pilot on `127.0.0.1:8788`. It has its own café, owner
password, `MFA_ENC_KEY`, session cookie name, and D1 database file. It never reads `.local-pilot/`, the
project's `.dev.vars`, staging or production.

---

## 1. Start, stop, inspect

```bash
# normal (valid key) — this is the mode to run the browser tests in
node scripts/mfa-test-env.mjs start

# other key states, used only for scenarios G and H
node scripts/mfa-test-env.mjs start --mode missing
node scripts/mfa-test-env.mjs start --mode malformed

# after switching modes, restore the valid key with:
node scripts/mfa-test-env.mjs start --mode valid

node scripts/mfa-test-env.mjs status   # health + current mode
node scripts/mfa-test-env.mjs stop     # stop the test Worker
node scripts/mfa-test-env.mjs reset    # stop and delete the disposable database
```

Equivalent raw command (the script adds the generated config and isolated state):

```bash
npx wrangler dev --config .mfa-test/wrangler.jsonc --cwd .mfa-test \
  --port 8791 --ip 127.0.0.1 --persist-to .mfa-test/state
```

**Browser URL:** <http://127.0.0.1:8791/c/mfa-test-cafe/owner>
**Guest menu (optional):** <http://127.0.0.1:8791/c/mfa-test-cafe/menu>

## 2. Test-only credentials

Read them locally from **`.mfa-test/test.env`** — use the `OWNER_PASSWORD` value to sign in. The file also
contains the disposable `MFA_ENC_KEY` and `ADMIN_SECRET`; don't copy any of them into chat, a report, a
screenshot or another environment.

The café slug is `mfa-test-cafe`. The database name is `corner-cup-mfa-test`, stored at
`.mfa-test/state/` — a different SQLite file from the pilot's `.local-pilot/state/`.

## 3. Isolation checks already confirmed

| Check | Result |
|---|---|
| Test Worker answers on `127.0.0.1:8791` only | bound to loopback, not `0.0.0.0` |
| Health | `{"status":"ok","database":"ok"}` |
| Café in its own database | `mfa-test-cafe` / "MFA Test Café" / `counter`, 23 tables |
| Payments | `provider: "none"` — the project's Razorpay dev keys did not leak in |
| Test owner password accepted | yes (a wrong or project-dev password is rejected) |
| Session cookie namespace | `staff_session_mfa-test-cafe` (pilot uses a different slug) |
| Pilot before/after setup | HTTP 200 both times; no order created or changed |
| Mode switching | `valid`, `missing`, `malformed` each start and answer `/api/health` |

---

## 4. Manual checklist

Recommended order: **B → A → C → D → E → F → G → H → I → J**. Scenario A needs an enrollment to exist, so
enroll first.

Do not screenshot or paste: the authenticator secret/QR, the `otpauth://` URI, recovery codes, the owner
password, or `MFA_ENC_KEY`.

### B. First-time TOTP enrollment under the new key

1. Sign in at the owner URL with `OWNER_PASSWORD`.
2. Open **Security** → **Two-factor is off** → enter the password → **Set up two-factor**.
3. Add the displayed secret to an authenticator app (scan the QR or type the key).
4. Enter the current 6-digit code → **Turn on two-factor**.

**Expected:** enrollment is accepted; **10 recovery codes are shown exactly once**; the board signs this
device out; signing in again asks for a code. The Security tab never says two-factor is unavailable while
the test key is valid (mode `valid`).

### A. Owner login with password and MFA challenge

1. Enter the owner password.

**Expected:** the password alone yields the **code prompt**, never the board. No `staff_session_mfa-test-cafe`
cookie is usable before the code. The board URL redirects/rejects until the second step completes.

### C. Valid TOTP completes login

1. Enter the current code from the authenticator.

**Expected:** the board loads (Orders tab). Refreshing keeps the session. A session row exists and the cookie
is `HttpOnly; SameSite=Strict`.

### D. Invalid TOTP is rejected

1. Sign out, enter the password, then submit a wrong 6-digit code (for example, two digits swapped).

**Expected:** "That code didn't match." No session cookie, no board. The challenge remains usable for one
more attempt within its 5-minute life. **Do not** deliberately burn all five attempts unless you intend to
wait out the 10-minute lockout; `reset` clears the database if needed.

### E. Recovery code works once and is refused on reuse

1. Sign in with the password, choose the recovery-code path, enter one saved code.

**Expected:** sign-in succeeds and the Security tab shows **9** codes remaining.

2. Sign out and try the **same** code again.

**Expected:** refused ("That code didn't match."); no session. A different unused code still works.

### F. Logout and re-login still decrypts the enrolled seed

1. **Security → Sign out of this device** (or close the session), then sign in again with password + a fresh
   authenticator code.

**Expected:** login succeeds. This proves the seed persisted and decrypts under `MFA_ENC_KEY` after a
process restart/reload.

### G. Missing `MFA_ENC_KEY` fails closed

1. Stop the test Worker and start it with the key absent:

   ```bash
   node scripts/mfa-test-env.mjs start --mode missing
   ```

2. Open the owner URL, enter the password, then enter a **correct** authenticator code.

**Expected:** the password produces a challenge (the enrollment row still exists), but the code step answers
**503** — "Staff sign-in isn't available right now. Please try again." — and issues **no session**. It must
not sign in by deriving a key from `ADMIN_SECRET`. The board stays unreachable.

### H. Malformed `MFA_ENC_KEY` fails closed

1. Restart with a deliberately invalid key:

   ```bash
   node scripts/mfa-test-env.mjs start --mode malformed
   ```

2. Repeat the password + correct code step.

**Expected:** same 503, no session, no fallback. The test key is non-empty but not 32-byte base64url, so it is
rejected before any derivation.

### I. Restore the valid key

1. Restart normally:

   ```bash
   node scripts/mfa-test-env.mjs start --mode valid
   ```

2. Sign in with password + a current code.

**Expected:** login works again. The enrollment was never altered or invalidated by G/H.

### J. Confirm nothing leaked into the pilot

1. Open <http://127.0.0.1:8788/api/health> — expect `{"status":"ok","database":"ok"}`.
2. Confirm the pilot's own board/session is unaffected (it uses `staff_session_corner-cup-local-pilot`).
3. `node scripts/mfa-test-env.mjs status` — mode `valid`, database `.mfa-test/state`.

**Expected:** the pilot has the same orders and menu as before; no test cookie, secret or database is shared;
the test environment never wrote to `.local-pilot/`.

---

## 5. Finish

```bash
node scripts/mfa-test-env.mjs stop
node scripts/mfa-test-env.mjs reset   # optional: deletes the disposable database and enrollment
```

The test key and password stay in `.mfa-test/test.env` (git-ignored). Delete `.mfa-test/` to discard them as
well.

## 6. What is not verified yet

- **No human browser run has been performed.** Scenarios A–J are prepared, not passed.
- The isolated environment's mode switching and startup isolation checks were verified programmatically;
  that is setup evidence, not acceptance.
- Automated evidence for the same behaviours exists in the test suite (532 tests, including two HTTP tests
  for missing/malformed keys and an enrolled café recovering once the key returns), but it does not replace
  this browser pass.
