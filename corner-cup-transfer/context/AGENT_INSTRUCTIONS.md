# AGENT_INSTRUCTIONS.md — Receiving AI Agent Operating Instructions

The following rules govern the receiving AI agent's behavior while working on the Corner Cup project. These are mandatory; violations may cause regressions or security issues.

## Mandatory Rules

### 1. Read All Documentation Before Changing Code
- Read ALL 7 documentation files in `context/` BEFORE making any code changes
- Treat this as a prerequisite, not optional background reading
- If a document references a file or convention you don't understand, inspect the file before proceeding

### 2. Inspect the Existing Source Before Making Assumptions
- Never assume a function works a certain way based on its name alone
- Read the actual implementation before modifying related code
- Check for existing comments, error handling, and edge cases

### 3. Preserve All Existing Uncommitted Work
- The following files had modifications BEFORE this transfer session and must NOT be discarded:
  - `README.md`, `package.json`, `package-lock.json`
  - `src/components/PaymentPanel.jsx`, `src/lib/api.js`, `src/lib/config.js`
  - `src/pages/Menu.jsx`, `src/pages/Operator.jsx`, `src.pages/OrderStatus.jsx`
  - `tests/harness/worker.mjs`, `tests/harness/wrangler.auth.jsonc`, `tests/harness/wrangler.jsonc`
  - `tests/password.reset.test.mjs`, `tests/status.transitions.test.mjs`
  - `worker/api.js`, `worker/cafes.js`, `worker/db.js`, `worker/http.js`, `worker/orders.js`
  - `wrangler.jsonc`
- If you need to modify any of these, first understand WHY they were changed
- Document any changes you make; do not leave unexplained modifications

### 4. Never Discard or Overwrite Unrelated Changes
- When editing a file that has multiple modifications, preserve all of them unless explicitly instructed otherwise
- Use `git diff` to inspect all unstaged changes before starting work
- Stage and commit unrelated changes separately from your work (if committing is authorized)

### 5. Do Not Deploy Without Explicit Approval
- No `wrangler deploy`, `sites_deploy`, or similar deployment commands without direct authorization
- This includes preview (`environment: "preview"`) and production (`environment: "production"`) deployments
- The only exception: starting `wrangler dev` for local development on localhost

### 6. Do Not Commit or Push Without Approval
- Do not run `git commit` or `git push` without explicit authorization
- If you make meaningful changes, report them in your next message; the human will decide on commit/push

### 7. Do Not Access Production or Preview Environments Without Approval
- Do not attempt to access any deployed URLs, preview environments, or production dashboards
- Do not modify production data, even read-only access without approval
- Local development (`wrangler dev`, `vite dev`) is permitted on localhost

### 8. Never Expose Secrets or Credentials
- Do not print, log, commit, or echo any API keys, passwords, tokens, or secret values
- Environment variables like `OWNER_PASSWORD`, `ADMIN_PIN`, `RAZORPAY_KEY_ID` etc. must remain in `.env` or `wrangler.jsonc` — never in chat output
- If a secret file is needed for integration, use `sites_set_secret` with a user-provided file path; never read its value

### 9. Do Not Change Real Customer Data, Passwords, Sessions, or Payment Configuration Without Approval
- Do not modify any café's stored password hash unless explicitly instructed
- Do not change operator sessions, admin passwords, or payment settings
- Do not alter D1 database data beyond what is strictly necessary for code validation
- Do not reset or change any password except through the official API pathways

### 10. Run Relevant Tests After Every Meaningful Change
- After any code change, run `npm test` to check for regressions
- If tests were previously passing and now fail, investigate before proceeding
- Report exact test results; do not claim tests pass if they were not executed
- Distinguish between "tests were not executed" and "tests failed"

### 11. Report Exactly What Was Modified
- When you make changes, list every file modified, even trivial ones
- Use `git diff` to verify and document changes
- Include both the change itself and the reason for it
- If you cannot run tests, report that and do not claim passing behavior

### 12. Clearly Distinguish Implementation from Verified Behavior
- Code changes are implementation; test execution results are verified behavior
- Do not claim a test passed if it was not executed in your session
- Do not claim code behavior based on code review alone without test execution
- When reporting, clearly state: "Code change made, test not executed in this session"

### 13. Never Claim a Test Passed If It Was Not Executed
- If you cannot run a test (harness unavailable, Node.js not configured, etc.), say so
- Do not say "tests pass" when only some were run or when they were skipped
- Use exact counts: "48 of 89 tests pass locally; 39 skipped; 2 fail (harness-dependent)"

### 14. Ask Before Making Destructive Database Changes
- Any D1 database schema change (ALTER TABLE, CREATE TABLE) requires approval
- Any data modification (UPDATE, DELETE, INSERT) beyond trivial validation requires approval
- Migration tests exist; run them before and after any schema change
- If a migration needs to be updated, report it and ask

### 15. Keep Security Findings Open Until Their Validation Requirements Are Satisfied
- All F-01 through F-20 findings documented in `SECURITY_STATUS.md` remain relevant
- F-01 through F-06 have local remediation completed (code-verified)
- F-07 has code changes but remains unverified (harness unavailable)
- F-08 onward must be treated according to their actual status, not assumed complete
- When making changes near any finding's code area, report impact on that finding
- Do not "resolve" a finding by removing documentation without actual code fix and test verification

## Behavioral Guidelines

### Senior Engineer Persona
- Treat this as a senior engineer taking ownership of an existing codebase
- Not as someone starting a new project from scratch
- Ask questions when stuck, but exhaust inspection-first approach first
- Preserve what works; fix what's broken; document everything

### Communication Style
- Keep the user (human) informed at meaningful checkpoints
- Report blockers early; do not silently wait
- Distinguish between "I've confirmed this works" and "this seems like it should work"
- When in doubt, err on the side of over-communication

### Question-Asking Protocol
- Use the `ask_questions` tool when essential information is unavailable
- Limit to at most 20 questions per call
- Each question should have 2-4 concrete options with recommended option first
- Prefer inspecting source code over asking questions
- Only ask when you truly cannot continue safely or correctly

## What to Do First (START_HERE.md Guidance)

When the receiving agent begins work, they should:

1. **Extract the ZIP archive** to a working directory
2. **Read START_HERE.md** (will be provided in the package)
3. **Read all 7 documentation files** in `context/`:
   - PROJECT_CONTEXT.md — product/tech overview
   - IMPLEMENTATION_HISTORY.md — development history
   - SECURITY_STATUS.md — F-01 through F-20 findings
   - F07_CONTEXT.md — PBKDF2 strengthening technical details
   - DEVELOPMENT_SETUP.md — environment setup details
   - CURRENT_STATE.md — Git status, test results, build status
   - AGENT_INSTRUCTIONS.md — these operating rules
4. **Run `npm install`** to install dependencies
5. **Prepend Node.js to PATH**: `$env:PATH = ".tools/node-v22.23.4-win-x64;$env:PATH"`
6. **Run `npm test`** and record results
7. **Run `npm run build`** and confirm success
8. **Inspect `git diff`** to understand all unstaged modifications
9. **Begin with F-07 validation** if that's the active task, or explore the codebase first

## File Reference Map (for quick lookup)

| Topic | File(s) |
|---|---|
| PBKDF2 implementation | `worker/passwords.js` |
| Login flow / race fix | `worker/api.js` (login function, lines ~1638-1683) |
| Password verification | `worker/passwords.js` → `verifyPassword()` |
| Opportunistic rehash | `worker/api.js` → login() post-verification |
| auth_version handling | `worker/api.js` → `checkToken()`, `currentAuthVersion()` |
| Rate limiting (D1-backed) | `worker/db.js` → `rate_limits` table; `worker/api.js` → `checkApiRateLimit()` |
| Security headers / CSP | `worker/http.js` → `SECURITY_HEADERS` |
| CSRF protection | `worker/api.js` → operatorLogin, operatorCreateCafe |
| Token tracking architecture | `worker/tracking.js`, `worker/orders.js`, `worker/db.js` |
| Migrations / schema | `worker/db.js` → MIGRATIONS, POST_MIGRATIONS |
| Test harness requirements | `tests/harness/` directory; `HARNESS_URL` env var |

## Quick Reference: Test Suite Status

| Test Category | Pass | Fail | Skip | Notes |
|---|---|---|---|---|
| Migration-based | ✅ | ❌ (2) | ❌ (39) | 2 failures harness-dependent; 39 skipped harness unavailable |
| API resilience | ✅ | ❌ (0) | ❌ (0) | All 12 subtests pass locally |
| Rate limit migration | ✅ | ❌ (0) | ❌ (0) | Passes locally |
| Auth harness tests | ❌ (0) | ❌ (2) | ❌ (39) | Requires Wrangler on port 8790 |
| Component tests | ✅ (varies) | ❌ (varies) | ❌ (varies) | Inspect individually |

**Note**: Exact counts from latest local execution: 48 pass, 2 fail (both harness-dependent), 39 skipped (harness unavailable).