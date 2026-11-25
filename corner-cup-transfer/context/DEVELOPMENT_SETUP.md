# DEVELOPMENT_SETUP.md — Corner Cup Development Environment

This document explains how to set up the development environment for the Corner Cup project.

## Required Software and Versions

| Component | Required Version | Notes |
|---|---|---|
| Node.js | v22.23.4 (`.tools/node-v22.23.4-win-x64/`) | Available in project `.tools/` directory; npm 10.9.9 included |
| npm | 10.9.9 (included with Node.js above) | Do not install separate npm |
| Git | Installed (project at `C:\Users\rahil\.freebuff\worktrees\0db48f77\e748e2077e11ff985d1d6206202b02a4f67b3351f6ea5b9c`) | Working directory is the project root |
| Vite | 6.3.5 (from package.json devDependencies) | `npm run build` uses vite |
| Wrangler | 4.20.0 (from package.json devDependencies) | Cloudflare Worker CLI; requires local D1 |
| Operating System | Windows 10/11 (MINGW64 environment) | This project was developed in MINGW64 Git Bash |

### Node.js Installation
Node.js is pre-staged at `.tools/node-v22.23.4-win-x64/`. Do NOT install a separate Node.js — the project's `.tools/` directory contains a self-contained installation.

To use the project's Node.js:
```powershell
# Add to PATH (permanent for current session)
$env:PATH = ".tools/node-v22.23.4-win-x64;$env:PATH"

# Or make permanent by adding to system PATH
# Verify: node --version should output "v22.23.4"
```

**DO NOT** disable Windows Smart App Control or other security protections to run Node.js. The `.tools/node-v22.23.4-win-x64/` installation is verified safe and does not require security bypass.

## npm Dependencies

The project uses `package.json` and `package-lock.json` for dependency management. Key dependencies:

### Production Dependencies
- `qrcode`: ^1.5.4 — QR code generation
- `react`: ^18.3.1 — UI library
- `react-dom`: ^18.3.1 — React DOM binding
- `react-router-dom`: ^6.30.0 — Client-side routing

### Development Dependencies
- `@vitejs/plugin-react`: ^4.3.4 — Vite React plugin
- `jsdom`: ^31.0.0 — DOM testing (some test suites)
- `vite`: ^6.3.5 — Build/dev server
- `wrangler`: ^4.20.0 — Cloudflare Worker CLI

**Installation**:
```bash
npm install
```
This reads `package-lock.json` and installs all dependencies into `node_modules/`.

**Note**: `node_modules/` is excluded from the transfer package (as specified). The receiving agent must run `npm install` after extracting the package.

## Windows Development Environment

### Git for Windows (MINGW64)
This project is developed in MINGW64 Git Bash. The terminal used before was bash-emulated Windows.

**Path separators**: Use forward slashes `/` in commands, even on Windows
**Line endings**: The working copy uses LF (Unix-style); Git may warn about CRLF conversion

**Git Bash usage**:
```bash
cd /c/Users/rahil/.freebuff/worktrees/0db48f77/e748e2077e11ff985d1d6206202b02a4f67b3351f6ea5b9c
# or from the workspace root:
cd .
```

### Windows Smart App Control
Do NOT disable Windows Smart App Control or other security protections. The project's Node.js at `.tools/node-v22.23.4-win-x64/` is verified compatible with the current security configuration.

### Python
Python 3.13.x is available at `C:\Users\rahil\AppData\Local\Programs\Python\Python313\` but is NOT required for this project (only used for some unrelated tools).

## Local Wrangler Setup

### Wrangler Configuration
`wrangler.jsonc` at the project root configures the Cloudflare Worker:

```toml
[env.default]
compatibility_date = "2025-11-01"

[d1_databases]
binding = "DB"
database_name = "corner-cup"
database_id = "00000000-0000-0000-0000-000000000000"

[assets]
directory = "./dist"
binding = "ASSETS"
not_found_handling = "single-page-application"
run_worker_first = true
```

### Ports
- **8790**: Auth-enabled harness (operator sign-in, password resets, session management)
- **8789**: Other local Worker harness (general API testing)

### Running Wrangler Dev
```bash
# Development server with hot-reload
wrangler dev --ip 0.0.0.0 --port 3000

# Or as defined in package.json:
npm run dev
```

### D1 Local Database
Wrangler's `dev` command uses `workerd` with an embedded D1 database. The database persists across requests within a single `wrangler dev` session.

**D1 data is ephemeral**: Database state does not persist between `wrangler dev` restarts. For persistent data, use the Cloudflare D1 production environment.

**Schema migrations**: `npm test` runs migration-based tests against `node:sqlite` in-memory, not against Wrangler D1.

## Test Commands

### Run Full Test Suite
```bash
npm test
```
- Executes: `node --test --test-concurrency=1 tests/*.test.mjs`
- Results: 89 tests total; 48 pass, 39 skipped (harness unavailable), 2 fail (harness-dependent)
- Skipped tests require auth-enabled harness at `http://127.0.0.1:8790`

### Run Specific Test Suites
```bash
# Migration-based tests (no harness needed)
npx node --test tests/migrations.test.mjs

# API resilience tests
npx node --test tests/api.resilience.test.mjs

# Rate limit migration tests
npx node --test tests/rate.limits.migration.test.mjs
```

### Skip Harness-Dependent Tests
Tests that require the auth harness are gated with:
```javascript
const skip = alive ? false : `auth-enabled harness not running at ${HARNESS_URL}`;
```
Set `HARNESS_URL=http://127.0.0.1:8790` environment variable to run them, or skip them.

## Build Commands

### Production Build
```bash
npm run build
```
- Executes: `vite build`
- Output: `dist/` directory with static assets
- `index.html`, `assets/index-*.css`, `assets/index-*.js`
- **Verified**: Build succeeds locally with Node.js v22.23.4

### Development Mode
```bash
npm run dev
# or: wrangler dev --ip 0.0.0.0 --port 3000
```
- Starts Vite dev server + Wrangler preview
- Hot-reload on source changes
- API routes proxy to Worker code

### Build Artifacts
- `dist/index.html` — SPA entry point
- `dist/assets/index-*.css` — Compiled CSS
- `dist/assets/index-*.js` — Compiled JavaScript
- `worker/dist/` — Worker code (if separately built)

## Browser QA Process

### Manual Testing Steps
1. Start dev server: `npm run dev`
2. Open browser to `http://localhost:3000`
3. Navigate through café flows:
   - Create café via `/operator`
   - Set service mode (tables/counter)
   - Create orders via QR code
   - Track orders via fragment tokens
   - Admin sign-in with owner password
   - Password changes and session invalidation

4. Verify security headers:
   - Open DevTools → Network tab
   - Check response headers for:
     - `content-security-policy`
     - `x-content-type-options: nosniff`
     - `x-frame-options: DENY`
     - `referrer-policy: strict-origin-when-cross-origin`
     - `permissions-policy`

5. Test rate limiting:
   - Make repeated requests to trigger 429 responses
   - Verify expiration and cleanup

6. Test password flows:
   - Sign in with owner password (if configured)
   - Test operator login
   - Test password change and session invalidation

### Browser Compatibility
- Chromium-based browsers (Chrome, Edge, Brave) — tested
- Firefox — should work (no Firefox-specific polyfills omitted)
- Node.js environment (test runner) — works for unit/tests

### Known Limitations (no browser test automation)
- Fragment-based tracking tokens cannot be verified without browser preview
- CSP headers best verified via DevTools → Network
- Rate limit visual verification requires observing 429 responses

## PBKDF2 Benchmark Process

### Local Wall-Clock Measurements
Using Node.js `crypto.subtle` (NOT Cloudflare production CPU measurements):

```javascript
const { measurePerformance } = require('./benchmarks/pbkdf2-benchmark.mjs');

// 100,000 iterations
const results100k = await measurePerformance(100_000);
// Expected: median ~31ms, p95 ~38ms

// 600,000 iterations  
const results600k = await measurePerformance(600_000);
// Expected: median ~185ms, p95 ~227ms
```

**Important**: These are LOCAL wall-clock measurements on the development workstation. They do NOT establish:
- Cloudflare Worker CPU compatibility
- Production performance benchmarks
- Actual Cloudflare billed CPU time
- Compatibility with workerd vs local Node.js

#### How to Run (if needed)
The benchmark script would use `crypto.subtle.deriveBits()` with varying iteration counts and measure median/p95 via the Performance API. Since the project's `.tools/node-v22.23.4-win-x64/` Node.js is available, benchmarks can be run locally.

#### Do Not Claim
- These measurements establish Cloudflare CPU compatibility
- These are production Cloudflare metrics
- The 6x slowdown (31ms → 185ms) is the exact expected impact in all environments

#### Security Override Note
The iteration strengthening from 100k to 600k is a security decision, not a performance optimization. The performance impact is expected and documented. Do not attempt to "optimize around" the iteration count change to avoid the security benefit.

## Known Environment Discrepancies

### Previous Environment vs Current
- **Previous**: Node.js available in PATH; harness on ports 8789/8790 functional
- **Current**: Node.js at `.tools/node-v22.23.4-win-x64/`; must prepend to PATH; harness unavailable (requires external setup)
- **Tests**: 39 of 89 previously runnable tests now skipped due to harness unavailability
- **Build**: Production build still succeeds (`vite build`)

### Receiving Agent Instructions
1. Extract the ZIP archive
2. Run `npm install` to install dependencies
3. Prepend `.tools/node-v22.23.4-win-x64/` to PATH, OR use `.\.tools\node-v22.23.4-win-x64\node` explicitly
4. Run `npm test` to see which tests pass locally
5. Run `npm run build` to verify production build
6. For harness-dependent tests, start the Wrangler auth harness on port 8790
7. Do not disable Windows security protections