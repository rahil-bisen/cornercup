# Stage 17B — Owner Authentication Security Report

Date: 2026-11-22
Follows: `STAGE17A_OWNER_AUTH_AUDIT.md`

---

## 1. What Stage 17A found

The Stage 17A audit confirmed that owner authentication was password-only, that sessions could not
be inventoried or revoked individually, and that there was no second factor anywhere on the owner
surface. It also noted that CSRF coverage was partial: several mutating owner routes accepted a
session cookie alone.

Three classes of problem:

- **Single factor.** One guessed or phished password yielded a full owner session.
- **No revocation.** Removing a person from the café did not end their session until expiry.
- **No forensic trail.** Failed and successful logins were not recorded in a queryable form.

---

## 2. What Stage 17B implements

### 2.1 TOTP (`worker/totp.js`)

- Base32 encode/decode; secrets are 160-bit random values from `crypto.getRandomValues`.
- HOTP/TOTP per RFC 4226 / RFC 6238: HMAC-SHA-1, 6 digits, 30-second step, ±1 step window for clock
  drift. `verifyTotp` returns the matched step so the caller can persist it.
- Verified against the RFC 6238 Appendix B vectors (SHA-1 rows) in `tests/totp.vectors.test.mjs`,
  including the base32 round-trip and the window boundary behaviour.
- `otpauth://totp/...` URI generation for QR enrollment.

### 2.2 Encrypted seed storage

- AES-256-GCM, fresh random 12-byte IV per encryption, authentication tag stored with the ciphertext.
- Key = HKDF-SHA256(`MFA_ENC_KEY`, info `corner-cup/totp/v1`), falling back to `ADMIN_SECRET` when
  `MFA_ENC_KEY` is unset, so an existing deployment keeps working.
- No usable key ⇒ **503**. There is no code path that stores a seed in plaintext.
- Tamper test: flipping one ciphertext bit makes decryption fail rather than return garbage.

### 2.3 Enrollment and confirmation

- `POST /admin/mfa/enroll` creates a *pending* secret and returns the provisioning URI.
- `POST /admin/mfa/confirm` requires a currently valid code; only then does the secret become active.
- Confirmation (and disable) bump `auth_version`, delete all sessions and outstanding challenges,
  and clear the session cookie. Enabling a second factor logs other devices out — that is intended.

### 2.4 Login gate

1. `POST /admin/login` verifies the password. On success with MFA active it returns
   `{mfaRequired: true, challenge}` and sets no session.
2. The challenge is a 32-byte random token, stored **hashed**, valid 5 minutes, deleted on use.
3. `POST /admin/login/totp` accepts the challenge plus a 6-digit code (or a recovery code) and is the
   only place that mints a session.

### 2.5 Replay protection

| Vector | Mechanism |
| --- | --- |
| TOTP code reuse | `UPDATE owner_totp SET last_used_step=? WHERE … AND (last_used_step IS NULL OR last_used_step < ?)`; zero rows updated ⇒ replay rejected |
| Recovery code reuse | `UPDATE … SET used_at=? WHERE code_hash=? AND used_at IS NULL`; zero rows ⇒ rejected |
| Challenge reuse | Row deleted in the same request that consumes it |
| Guessing | `totp:<cafeId>:<ipHash>` limited to 5 attempts / 10 minutes |

### 2.6 Recovery codes

Ten codes generated at enrollment, returned once in the confirmation response, stored only as
SHA-256 hashes. Each use writes an `auth_events` row and cannot be repeated.

### 2.7 Session binding and revocation

- `worker/session.js` resolves membership for managed (WorkOS) sessions on **every** request; a
  non-member yields `SESSION_NONE` immediately.
- `GET /admin/sessions` returns the active sessions with creation time, IP hash and user agent.
- `POST /admin/sessions/:id/revoke` and revoke-all delete rows and bump `auth_version` in one batch,
  so a partially applied revoke cannot leave a live session behind.
- `passwordResetBatch` deletes sessions in the same batch as the password change.

### 2.8 Operator sessions

Operator sessions now store `sha256(trim(OPERATOR_PASSWORD))` as `credential_hash`. Rotating the
password invalidates every operator session on the next request without a migration. A row missing
its digest fails closed.

### 2.9 CSRF

A token is issued with the session and must be presented in the `x-csrf-token` header on every
mutating owner route — login, logout, settings, menu, orders, tables, MFA enroll/confirm/disable and
session revoke. The check runs **before** the request body is read, so a forged request cannot make
the Worker parse JSON at all. A 10-route matrix test asserts each route rejects a missing or wrong
token.

### 2.10 Audit trail

`auth_events` rows: `login_success`, `login_failure`, `mfa_challenge`, `mfa_success`,
`mfa_failure`, `mfa_enrolled`, `mfa_disabled`, `recovery_code_used`, `session_revoked`,
`membership_rejected`, plus the existing settings/order events. Columns: café, actor, event, IP hash,
user agent, created-at.

---

## 3. Schema added

| Object | Purpose |
| --- | --- |
| `owner_totp` | Active/pending secret (encrypted), `confirmed_at`, `last_used_step`, `auth_version` |
| `owner_totp_recovery` | Recovery code hashes with `used_at` |
| `owner_totp_challenges` | Hashed, expiring, single-use login challenges |
| `auth_events` | Authentication audit log |
| `operator_sessions.credential_hash` | Binds an operator session to the password it was created with |

All are created idempotently by `init()`; verified on a fresh database (24 tables, 38 indexes).

---

## 4. Test coverage added

| Suite | Covers |
| --- | --- |
| `tests/totp.vectors.test.mjs` | RFC 6238 vectors, base32, window, replay, encryption round-trip, tamper, recovery-code hashing |
| `tests/mfa.flows.test.mjs` | Enroll gating (cannot confirm with a bad code), full lifecycle, replay rejection, recovery code single-use, session inventory + revoke, disable, 10-route CSRF matrix, membership revocation |

Suite total: **492 passing, 0 failing**.

---

## 5. Residual risk

1. **`ADMIN_SECRET` as the MFA key.** If `MFA_ENC_KEY` is unset, the same secret protects both
   admin actions and TOTP seeds. Setting a dedicated `MFA_ENC_KEY` decouples them.
2. **No hardware-key option.** TOTP phishing is possible in principle; TOTP was chosen because it
   needs no paid service and works with any authenticator app.
3. **Recovery codes are printed by the client.** If the owner loses them and loses the device, the
   documented path is operator-assisted reset, which invalidates all sessions.
4. **Argon2id CPU cost on Workers Free is unmeasured.** Not a security weakness, but an operational
   one: if it exceeds budget the fix is a paid plan or cost tuning, never a weaker hash.
5. **The Security tab has not been visually inspected.** API behaviour is tested; layout is not.
