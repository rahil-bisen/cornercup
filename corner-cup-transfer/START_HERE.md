# START_HERE.md — Corner Cup Receiving Agent: Begin Here

## What This Package Contains

This ZIP archive (`corner-cup-transfer.zip`) contains a complete portable copy of the Corner Cup project, structured for transfer to a new AI coding agent.

### Directory Structure

```
corner-cup-transfer/
├── START_HERE.md  (this file — read first)
├── MANIFEST.md      (package manifest; read second)
├── project/         (complete source code, tests, configs)
│   ├── src/         (React + Vite frontend)
│   ├── worker/      (Cloudflare Worker backend)
│   ├── tests/       (test suite, harness-dependent)
│   ├── public/      (static assets)
│   └── all required configs
└── context/         (7 documentation files)
    ├── PROJECT_CONTEXT.md      (product + tech overview)
    ├── IMPLEMENTATION_HISTORY.md  (development history F-01 to F-11)
    ├── SECURITY_STATUS.md      (F-01 through F-20 findings)
    ├── F07_CONTEXT.md          (PBKDF2 strengthening technical details)
    ├── DEVELOPMENT_SETUP.md    (environment setup, Node.js, Wrangler)
    ├── CURRENT_STATE.md        (Git status, test results, build status)
    └── AGENT_INSTRUCTIONS.md   (mandatory operating rules for this agent)
```

## Immediate First Steps

### 1. Extract the Archive
```bash
# Windows (PowerShell)
Expand-Archive corner-cup-transfer.zip -DestinationFolder .

# Or command prompt
cd /d %USERPROFILE%\Desktop
corner-cup-transfer.zip

# Or using 7-Zip, WinRAR, etc.
```

### 2. Read Documentation (Mandatory Order)
**Read these files in order, before making any code changes:**

1. **`START_HERE.md`** — You are here; this file
2. **`MANIFEST.md`** — Verify package contents and integrity
3. **`context/AGENT_INSTRUCTIONS.md`** — Mandatory operating rules (7+ mandatory rules)
4. **`context/PROJECT_CONTEXT.md`** — Product, tech stack, ordering architecture, payments
5. **`context/IMPLEMENTATION_HISTORY.md`** — Full development history (F-01 through F-11)
6. **`context/SECURITY_STATUS.md`** — Security findings F-01 through F-20
7. **`context/F07_CONTEXT.md`** — PBKDF2 strengthening technical context
8. **`context/DEVELOPMENT_SETUP.md`** — Node.js, Wrangler, test commands, build commands
9. **`context/CURRENT_STATE.md`** — Git status, HEAD, test results, build status, blockers

### 3. Set Up the Development Environment

```bash
# Extract (if not already done)
# Navigate to the project directory
cd corner-cup-transfer

# Install dependencies
npm install

# Use the project's Node.js (v22.23.4)
# Method A: PowerShell
$env:PATH = ".tools/node-v22.23.4-win-x64;$env:PATH"

# Method B: Command prompt
set PATH=.tools\node-v22.23.4-win-x64;%PATH%

# Verify
node --version   # Should output: v22.23.4
npm --version    # Should output: 10.9.9
```

### 4. Run Initial Checks

```bash
# Run test suite
npm test
# Expected: 48 pass, 2 fail (harness-dependent), 39 skipped (harness unavailable)
# Report exact results back

# Run production build
npm run build
# Expected: vite build succeeds, outputs dist/index.html + assets
# Report success or failure
```

### 5. Inspect Git Status
```bash
git status
# Review all unstaged modifications
# Distinguish F-07 changes (2 files) from pre-existing work (18 files)
# Do NOT discard pre-existing uncommitted work
```

### 6. Review F-07 Changes (If Active Task)
Inspect these two files and verify the changes:

```diff
--- worker/passwords.js (line 5)
- const PBKDF2_ITERATIONS = 100_000;
+ const PBKDF2_ITERATIONS = 600_000;

--- worker/api.js (login function, lines ~1638-1683)
- // OLD: version read AFTER verifyPassword (race condition)
+ // NEW: version captured BEFORE verifyPassword (race fix)
+ const version = cafe.auth_version;
+ // ... opportunistic rehash with compare-and-swap
```

**F-07 Validation Checklist** (from F07_CONTEXT.md):
- [ ] PBKDF2_ITERATIONS = 600_000 in passwords.js
- [ ] verifyPassword reads iterations from hash string (backward compatible)
- [ ] Opportunistic rehash with compare-and-swap WHERE pass_hash = ?
- [ ] auth_version NOT incremented during rehash
- [ ] Explicit password changes still increment auth_version atomically
- [ ] Race fix: version captured before verifyPassword
- [ ] Production build passes
- [ ] ⚠️ Full test suite: harness unavailable (39 skipped, 2 fail)

### 7. Begin Active Work

After completing steps 1-6, you are cleared to begin meaningful work. Recommended starting points:

- **If F-07 is the active task**: Validate the code changes, run local tests, report results
- **If exploring the codebase**: Start with `worker/api.js` and `worker/passwords.js`, then inspect pre-existing modifications
- **If continuing from a prior development state**: Compare current `git status` with where you left off

## Important Restrictions

### Do NOT Do These Things

| Forbidden Action | Reason |
|---|---|
| Deploy without explicit approval | `wrangler deploy`, `sites_deploy` require authorization |
| Commit or push | Git operations require explicit go-ahead |
| Access production/preview envs | No authorization; local dev only on localhost |
| Discard pre-existing uncommitted work | 18 files were modified before this transfer; all must be preserved |
| Expose secrets or credentials | Never print API keys, passwords, tokens |
| Change real customer data | No password changes, session modifications, or D1 data changes without approval |
| Claim tests pass if not executed | Report exact results; note when harness blocks execution |
| Disable Windows security protections | `.tools/node-v22.23.4-win-x64/` works without bypass |

### Do These Instead

| Required Action | How |
|---|---|
| Run local development | `npm run dev` or `wrangler dev` on localhost |
| Verify code changes | `npm test` + inspect `git diff` |
| Report findings | Be exact about pass/fail/skip counts; note blockers |
| Ask for clarification | Use the question-asking protocol when stuck |

## What to Report Back

When providing work updates, include:

1. **Exact test results**: "48 of 89 tests pass; 39 skipped (harness unavailable); 2 fail (harness-dependent)"
2. **Build status**: "vite build succeeds" or "vite build failed: <error>"
3. **Git status summary**: List modified files, distinguish F-07 from pre-existing
4. **F-07 specific**: "PBKDF2_ITERATIONS = 600_000 verified; race fix inspected; harness verification blocked"
5. **Blockers**: "Auth harness unavailable at port 8790; cannot run full test suite"
6. **Any discrepancies**: "Document says X but source shows Y"

## Directory Quick Reference

| Directory | Contents |
|---|---|
| `project/src/` | React components, pages, lib utilities |
| `project/worker/` | Cloudflare Worker JavaScript files |
| `project/tests/` | Test suite (mjs files + harness config) |
| `project/public/` | Static assets (HTML, favicon, etc.) |
| `context/` | 7 documentation files (READ ME FIRST) |
| `MANIFEST.md` | Package manifest (read second) |
| `START_HERE.md` | This file (read first) |

## Archive Integrity Verification

After extracting, verify:
- All 7 documentation files exist in `context/`
- All source files exist in `project/src/`, `project/worker/`, `project/tests/`, `project/public/`
- `MANIFEST.md` and `START_HERE.md` are at the archive root
- No `node_modules/` directory (it was excluded)
- `package-lock.json` is present (for `npm install`)

If anything is missing, report it; do not make up files.

---

**You are now ready to begin working with the Corner Cup project. Read the documentation in the specified order, set up the environment, and begin with step 7 (active work) or step 6 (F-07 validation) depending on your assigned task.**

Good luck, and don't hesitate to report blockers or ask questions when stuck.