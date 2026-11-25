# CI and Build Instructions

---

## 1. Prerequisites

- Node.js 20 or newer (CI pins 20; local development has also been exercised on 22).
- npm, using the committed `package-lock.json`. **Never** regenerate the lockfile to "fix" CI; it is
  committed deliberately and contains the resolved dependency graph (including `sharp` for the image
  pipeline).
- Two local D1-backed Workers for the test harnesses (see §3). They are started by you, not by the
  test process.

---

## 2. Commands

```bash
npm ci                    # reproducible install from the lockfile
npm run build             # vite production build → dist/
npm test                  # full suite (requires harnesses, see §3)
```

Expected build output on the current tree: `293.33 kB` JS, `94.22 kB` gzip.

---

## 3. Test harnesses (required before `npm test`)

`npm test` runs
`node --import ./tests/setup/register.mjs --test --test-concurrency=1 tests/*.test.mjs`
against two Workers on fixed loopback ports.

```bash
# auth harness — port 8790
npx wrangler dev --config tests/harness/wrangler.auth.jsonc --port 8790 --ip 127.0.0.1

# batch harness — port 8789
npx wrangler dev --config tests/harness/wrangler.jsonc --port 8789 --ip 127.0.0.1
```

Both must answer `GET /api/health` before the suite starts. Consequences worth knowing:

- `--test-concurrency=1` is mandatory: the suites share a D1 file.
- An `npm install`/`npm ci` **while the harnesses are running** kills them (SQLITE_BUSY and
  `node_modules` churn). Restart both afterwards and re-run.
- Harness credentials are test-only constants in `tests/harness/credentials.mjs`
  (owner `harness-owner-password`, bootstrap `harness-bootstrap-password`,
  `ADMIN_SECRET=test-admin-secret-for-harness-only`, `OPERATOR_PASSWORD=operator-test-password`).
  These are not production secrets and must never be reused outside the harness.

---

## 4. The CI workflow

`.github/workflows/ci.yml` performs, in order:

1. checkout, Node 20 with npm cache, `npm ci`
2. `node --check` on the changed Worker modules (fast syntax gate before the slow steps)
3. start both harnesses, wait for health, run the suite, dump harness logs on failure
4. `npm run build`
5. `npm audit --omit=dev --audit-level=high`
6. upload logs as artifacts on failure

Status: **written but never executed on a runner.** No GitHub remote, CLI or token exists in this
workspace, so the workflow has not been proven. Treat its first run as a debugging session, not a
green light.

To run it: push the branch (requires explicit approval), open the Actions tab, and run the workflow.
The first thing to check if it fails is the harness startup step — health polling and log capture are
the parts most sensitive to runner differences.

---

## 5. Image pipeline workflow

`.github/workflows/image-process.yml` is marked **PREPARED, NOT WIRED**. It would build
`sharp`-based processing on a runner and commit re-encoded images back. It is deliberately not
connected to a trigger because:

- there is no repository to run it in (B-1), and
- the `image_jobs` table that would record work was intentionally not added (D-17B-8) — it would
  only be written by a pipeline that does not exist yet.

The processing logic itself is real and testable now:

```bash
node image-pipeline/self-test.mjs   # 7/7 pass
```

---

## 6. Local equivalent of CI

If you cannot use GitHub Actions, run this sequence; it is what the workflow does:

```bash
npm ci
node --check worker/index.js worker/api.js worker/db.js worker/session.js worker/totp.js worker/http.js
# start both harnesses in separate terminals, wait for health
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

Record the exit status of each; do not pipe the suite through `tail` or `head`, because that hides
the exit code.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| `ECONNREFUSED 127.0.0.1:8790` | auth harness down | restart it, wait for health |
| `SQLITE_BUSY` mid-suite | concurrent harness writes or an install running | stop installs, restart harnesses, re-run |
| Mass 403s in owner tests | missing CSRF token in a fixture | fixtures must fetch a token from `/owner-csrf`; do not relax the check (D-17B-9) |
| MFA endpoints 503 | no valid `MFA_ENC_KEY` (43-char base64url); `ADMIN_SECRET` is no longer a fallback | set a test key in the harness config, not in code |
| Build OOM on a small runner | vite memory | `NODE_OPTIONS=--max-old-space-size=2048 npm run build` |

---

## 8. Note — CPU measurement (2026-11-22)

Argon2id login was exercised against the real Workers runtime via a temporary probe Worker:
65/67/68 ms for a correct password, 53/62/67 ms for a wrong one, 0 ms for a no-hash baseline. The
probe was deleted after measurement (post-delete URL returns 404).

Previous owner-login measurements of approximately 65–68 ms represent elapsed wall-clock time, not confirmed Cloudflare CPU consumption. These measurements do not establish whether the current Argon2id configuration exceeds the Workers Free 10 ms CPU limit. Compatibility remains unresolved pending an actual platform-reported CPU-time measurement in the deployed Worker runtime. Keep Argon2id at m=19456 KiB, t=2, p=1; do not weaken the hashing parameters.

## 9. Note — R2 binding (2026-11-22)

`wrangler.jsonc` now declares `r2_buckets: [{ "binding": "IMAGES", "bucket_name": "corner-cup-images" }]`.

- `wrangler dev` simulates that bucket locally, so the upload path can be exercised without an account
  (`env.IMAGES (corner-cup-images) R2 Bucket local` in the startup banner).
- A deploy requires the bucket to exist: `wrangler r2 bucket create corner-cup-images`. Until then the
  deploy fails on the missing bucket, which is deliberate — it is better than shipping a Worker whose
  uploads answer 503.
- The CI workflow is unchanged and needs no R2 binding: it runs the harnesses, which supply their own
  in-memory binding, and it never deploys.
