# AUTHENTICATION DECISION

**Date:** 2026-11-20
**Question:** which authentication architecture should Corner Cup launch its first café on?
**Constraints:** zero budget, no credit card, Cloudflare Workers Free limits, TOTP intended as the long-term
owner MFA, multi-café identity, membership revocation, honest account recovery.

**Decision: stay on the local, self-contained path (Argon2id + signed sessions + `owner_sessions`) and do not
integrate Firebase or WorkOS until the CPU question in §2 is answered on a non-public deployment. Add TOTP at
the owner sign-in step before the first real café.** Firebase is **not** integrated, and this document explains
why, and what would have to be true to choose it instead.

---

## 1. What exists today (verified in source)

| Capability | Implementation | Status |
|---|---|---|
| Owner sign-in | `POST /api/cafes/:slug/admin/login` → Argon2id verify → signed session + `owner_sessions` row | Implemented, tested |
| Password storage | Argon2id, 19 MiB, t=2, p=1 (`worker/passwords.js`), parameters never reduced | Implemented, tested |
| Session lifetime | 12 h idle renewal, 24 h absolute cap, enforced **in SQL** | Implemented, tested |
| Revocation | per-session delete on logout; `auth_version` CAS on logout-all and password change | Implemented, tested |
| Re-authentication | current password required for a password change, rate-limited, before any write | Implemented, tested |
| CSRF | Origin equality + token hashed and bound to the session | Implemented, tested |
| Operator | separate console identity, separate cookie, separate CSRF binding | Implemented, tested |
| Managed identity | WorkOS OIDC (PKCE S256, RS256-only, strict `iss`/`aud`, JWKS rotation) | Implemented, **provider contract unverified** (no sandbox credentials) |
| MFA | none | **Not implemented** |
| Firebase | a separate Firebase project exists; **no Corner Cup integration** | Not started |

## 2. The blocking constraint: Argon2id cost vs Workers Free CPU

Measured locally on this machine (HTTP wall clock, not Workers CPU): hash p50 **48.8 ms**, p90 56.6 ms; verify
p50 47.3 ms. Argon2id is pure CPU — no I/O to hide behind — and the Workers **Free** plan allows **10 ms CPU per
request**.

Consequences, stated plainly:

- The parameters that make Argon2id strong (19 MiB, t=2) are exactly what makes it expensive. **Reducing them
  to fit 10 ms would weaken the stored credential**, which this project has ruled out.
- A Free-plan owner sign-in may therefore end in **Error 1102** (CPU time exceeded) rather than a wrong-password
  message. That is a launch blocker, not a tuning detail.
- It is **unmeasured on workerd**: local wall clock is not Workers CPU. The measurement requires a deployment,
  which requires approval.

**Therefore owner sign-in on Workers Free is UNVERIFIED and must be treated as at-risk until measured.**

## 3. Options assessed

| Option | CPU per sign-in | Cost | MFA path | Verdict |
|---|---|---|---|---|
| **A. Local Argon2id (current)** | ~47 ms (likely over Free limit) | €0 | TOTP added locally (HMAC-SHA1/6-digit, ~1 ms) | **Keep as the design; measure before launch.** Requires a paid plan *if* the measurement fails |
| **B. WorkOS managed identity** | RS256 verify + JWKS cache, ~2–5 ms | Free dev tier | Provider-side MFA (paid tiers) | Code already written and tested; **blocked on sandbox credentials** — no account can be created without an owner decision |
| **C. Firebase Authentication** | ID-token RS256 verify ~2–5 ms (client SDK + JWKS on the Worker) | Free (Spark) | TOTP MFA is **not** offered by Firebase Auth; SMS only, and SMS MFA requires Identity Platform (billed) | **Rejected for now**: it cannot deliver the stated TOTP policy on a zero budget, and integration would be new code with no evidence |
| **D. Weaker local hashing (PBKDF2-SHA256 via WebCrypto)** | ~5–15 ms | €0 | TOTP local | **Rejected**: it would *weaken* Argon2id, explicitly forbidden |
| **E. Hashing offload (external service / queue)** | n/a | €0 options are unreliable | n/a | **Rejected**: adds a network dependency to the one path that must never fail |

### Why not Firebase now

- Firebase Auth offers **no TOTP**; its MFA is SMS-based, and SMS MFA lives behind Identity Platform (billed).
  The intended policy is TOTP, so Firebase would either change the policy or require billing.
- Nothing exists to build on: no SDK, no verification code, no tests in this repository. Adding it is a new
  integration, not a fix.
- The existing managed path (WorkOS) is already implemented and covered by tests, including JWKS rotation and
  strict claim checks. Choosing a second managed provider would duplicate that work.

### Why not WorkOS today

The sandbox verification is blocked on credentials (`STAGE10B_WORKOS_SANDBOX_REPORT.md`). The owner can unblock
it by creating a free WorkOS dev account; that is an external action requiring approval.

## 4. Decision

1. **Primary path (launch):** local Argon2id + `owner_sessions` + TOTP, with the CPU measured on a non-public
   deployment **before** any café is onboarded.
2. **If the CPU measurement fails on Free:** the options, in order, are (a) an approved paid Workers plan —
   which keeps Argon2id intact and is the cheapest correct answer, (b) activate the already-written WorkOS path
   once a free sandbox exists. **Reducing Argon2id is not an option.**
3. **TOTP is required before the first real café.** It is cheap on Workers (HMAC via WebCrypto), it is the stated
   policy, and it is the control that makes a stolen password insufficient. Not implemented yet; planned.
4. **Firebase is not integrated.** It stays a documented option only if the TOTP policy changes or Identity
   Platform is funded.

## 5. What “production-ready authentication” requires here

| Requirement | State |
|---|---|
| Strong credential verification | Argon2id — **implemented** |
| Fail-closed behaviour | Store errors → 503, never “signed out”; invalid `auth_version` → refuse — **implemented** |
| Session revocation (single + all) | **implemented**, tested |
| Membership and role checks in SQL | **implemented**, tested |
| CSRF on credential mutations | **implemented**, tested |
| Re-authentication for credential change | **implemented**, tested |
| Token signature and claims (if managed) | **implemented** for WorkOS; provider contract **unverified** |
| Email verification | **Not implemented** — needed only for the managed path or self-service recovery |
| TOTP MFA | **Not implemented** — required before launch |
| Recovery procedure | Operator-driven password reset exists and is tested; self-service recovery does not exist, and should not, without email verification |

## 6. Approval required to move

- Creating a WorkOS dev account, or any Firebase/Identity Platform change: **owner approval, external action**.
- A Workers paid plan: **owner approval, billing**.
- Deploying to measure CPU: **deployment approval** (see `PRODUCTION_DEPLOYMENT_CHECKLIST.md`).

Until the CPU measurement and TOTP exist, owner sign-in must be described as **locally verified, production
unverified**.
