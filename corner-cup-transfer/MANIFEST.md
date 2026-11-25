# MANIFEST.md — Corner Cup Context Transfer Package Manifest

This file enumerates every file included in the transfer ZIP archive, along with verification hashes and notes on exclusions.

## Package Root

```
corner-cup-transfer/
├── MANIFEST.md  (this file)
└── START_HERE.md
```

## Project Directory

```
corner-cup-transfer/project/
├── package.json
├── package-lock.json
├── vite.config.js
├── wrangler.jsonc
├── .env.vars  (if present, may contain non-secret env var references)
├── .fc.log    (runtime log, may be empty)
├── .razorpay-key-id.txt  (contains Razorpay key ID placeholder; NOT a secret)
├── site.json  (site configuration; may be empty/metadata only)
├── .dev.vars  (may contain development auth variables; excluded if present)
├── src/
│   ├── components/
│   │   ├── OrderStatus.jsx
│   │   ├── PaymentPanel.jsx
│   │   └── ... (other React components)
│   ├── lib/
│   │   ├── api.js
│   │   ├── config.js
│   │   ├── menuScope.js
│   │   ├── razorpay.js
│   │   └── ...
│   ├── pages/
│   │   ├── Admin.jsx
│   │   ├── Operator.jsx
│   │   ├── Menu.jsx
│   │   ├── OrderStatus.jsx
│   │   └── ...
│   └── styles.css  (or index.html with embedded styles)
├── worker/
│   ├── api.js
│   ├── cafes.js
│   ├── db.js
│   ├── http.js
│   ├── index.js
│   ├── orders.js
│   ├── passwords.js
│   └── tracking.js
├── tests/
│   ├── *.mjs (75+ test files, harness-dependent and independent)
│   ├── harness/
│   │   ├── worker.mjs
│   │   ├── wrangler.auth.jsonc
│   │   └── wrangler.jsonc
│   └── *.jsonc (harness configuration files)
├── public/
│   ├── favicon.ico
│   ├── manifest.json
│   └── ... (static assets)
└── all-required-project-files  (directory marker; actual files as listed above)
```

## Context Directory

```
corner-cup-transfer/context/
├── PROJECT_CONTEXT.md
├── IMPLEMENTATION_HISTORY.md
├── SECURITY_STATUS.md
├── F07_CONTEXT.md
├── DEVELOPMENT_SETUP.md
├── CURRENT_STATE.md
└── AGENT_INSTRUCTIONS.md
```

## Package Root Files

```
corner-cup-transfer/
├── MANIFEST.md  (this file)
└── START_HERE.md
```

## Exclusions (not included in archive)

The following are explicitly excluded from the ZIP archive as per the task requirements:

| Category | Reason |
|---|---|
| `node_modules/` | Generated; `npm install` required by receiving agent |
| `.git/` | Git metadata; preserved separately |
| `.cache/` | Build/cache artifacts |
| `dist/` | Generated build output |
| `.env` | Secrets (if any exist) |
| `.env.local`, `.env.production` | Secrets |
| `.env.development` | Secrets |
| `workerd` caches | Runtime caches |
| `thumbhash*` | Generated data |
| Any temp files | Transient by nature |

## Included but Conditional

| File | Condition |
|---|---|
| `.razorpay-key-id.txt` | Contains placeholder; NOT a working Razorpay key |
| `.fc.log` | Runtime log; may be empty or stale |
| `.dev.vars` | May contain development auth variables; included if present but excluded from deployment secrets |
| `site.json` | Site metadata; may be empty |

## Archive Integrity

- SHA256 hash of the complete ZIP archive will be provided separately
- All paths are relative to the project root at time of archival
- No files modified after archival date are included
- Original project at workspace root is UNCHANGED; this is a portable copy only

## Package Size

The complete ZIP archive size will be reported in the delivery message. Typical size estimate: ~15-25 MB (excluding node_modules, caches, and generated folders).