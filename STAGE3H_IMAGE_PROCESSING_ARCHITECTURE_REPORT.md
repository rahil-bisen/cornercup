# Stage 3H — Zero-Budget Image Processing Architecture Audit

**Decision: CONDITIONAL GO** for an out-of-band image processor built on GitHub Actions + Cloudflare R2 +
sharp, with the conditions in §13. The architecture is sound, the security model can be made strict, and
the cost is genuinely $0 at café volume — but GitHub Actions is **not a queue**, the project currently has
**no GitHub repository at all**, and the trust model only holds if the OIDC work in §4 is implemented as
specified rather than as "trust the job id in the payload".

Nothing in the project was changed. No dependency was installed, no GitHub App, token or secret was created,
no R2 bucket or Cloudflare setting was touched, and nothing was deployed, committed or pushed. All numbers in
§7 come from an isolated PoC at `%TEMP%\stage3h-poc` (outside the repository) run on 2026-11-20, using the
`sharp` binary that already exists in `node_modules` as a miniflare dev dependency — nothing was added.

---

## 1. What exists today (read-only findings)

### 1.1 Repository state — there is no GitHub repository

| Question | Finding |
| --- | --- |
| `git remote -v` | **Empty.** No remotes configured. |
| Branches | One local branch, `freebuff/qr-code-cafe-ordering-website`, no remote-tracking refs. |
| `.git/refs/remotes` | Absent. |
| `.github/` | Absent — no workflows, no CODEOWNERS, no branch protection. |
| `gh` CLI | Not installed; `GITHUB_TOKEN` / `GH_TOKEN` not set. |
| GitHub references in the tree | None outside `package-lock.json` (registry URLs) and unrelated tooling docs. |
| `package.json` | No `repository` / `homepage` field. |

**Repository visibility is therefore "not applicable yet": the code is not published to GitHub in any form.**
Every claim below about minutes, visibility and plan is about the repository that would have to be created
first. Deployment today is Freebuff Sites (`site.json`: `siteId 6f1c2a48-…`, preview and production on
`*.freebuff.page`), which is unrelated to GitHub.

### 1.2 Upload and serving path as it stands

`worker/api.js` (lines ~83–250, 2950–3120):

- `IMAGE_MAX_BYTES = 1 MB`, `IMAGE_MAX_DIMENSION = 4096`, `IMAGE_MAX_PIXELS = 16 MP`.
- `detectImageFormat` → JPEG `FF D8 FF`, PNG 8-byte signature, WebP `RIFF….WEBP`; nothing else.
- `imageDimensions` parses **headers only**: PNG IHDR, a scan for JPEG SOF0/1/2, WebP VP8/VP8L/VP8X.
- `validateImageBytes` combines signature + size + dimensions; `readImageBytes` enforces the 1 MB cap while
  reading multipart and again on the buffer.
- Upload order is object → D1 → delete previous (`adminUploadImage`), removal commits `image_key = NULL`
  first (`adminRemoveImage`), item delete cleans up best-effort.
- `getMenuImage` resolves `image_key` **from D1 by `id AND cafe_id`**, never from the URL, and serves with the
  stored content type, `x-content-type-options: nosniff`, `cache-control: public, max-age=31536000, immutable`.
- Keys are `cafes/<cafe_id>/menu/<item_id>/<uuid>.<ext>`, generated server-side.

This is header validation, not decoding — the same conclusion Stage 3G reached. A truncated JPEG passes it.

### 1.3 Storage, schema, auth

- `wrangler.jsonc` declares **`DB` (D1) and `ASSETS` only**. There is no `r2_buckets` entry, no `crons`, no
  `queues`, no Durable Objects. `IMAGES` is expected by the code but not provisioned (Stage 3B §3), so uploads
  currently answer 503 on a plain `wrangler dev`.
- `menu_items` carries `image_key TEXT`, `image_updated_at TEXT` (both nullable, added by `MIGRATIONS`).
- Owner auth is a signed HMAC cookie (`worker/session.js`) whose subject is `cafe:<id>:<version>:<session_id>`,
  backed by a live `owner_sessions` row, with a 12 h idle window and a 24 h absolute cap; mutations pass
  `verifyCsrf` (exact-Origin check + hashed token bound to the session id). `ADMIN_SECRET` absence fails closed
  with 503. Operator console is separate (`OPERATOR_PASSWORD`, `operator_sessions`).
- `worker/index.js` has a `fetch` handler only — no `scheduled()` handler exists.

Any processor must leave all of this as-is. In particular: the Worker keeps header validation on the upload
path, and the public image route keeps resolving keys from D1.

---

## 2. GitHub Actions feasibility

### 2.1 Repository visibility

Undetermined and currently moot (§1.1). Once created it is a decision, not a fact:

| Choice | Consequence for this design |
| --- | --- |
| **Private** (recommended) | Counts against included compute; source stays closed; the `repository_visibility` OIDC claim is `private`. |
| Public | Standard runners are **free and uncapped**, but the whole Corner Cup source — multi-tenant auth, session code, CSRF logic — becomes world-readable. Not acceptable for a commercial café product without a separate processor repository. |

A third option matters: keep the **application** private and put only the processor (workflow + a ~100-line
script) in a small **public** repository. Then Actions is free forever and no product source is exposed. The
trade-off is a second repository and a second set of OIDC claims to validate — recorded here, not recommended
for stage 1.

### 2.2 Account plan and allowance

Not accessible: no `gh`, no token, no remote, and reading a plan requires authenticated account access, which
this audit is forbidden from creating. What GitHub documents (billing page, read 2026-11-20):

- Included compute is a **dollar amount**, not a minute count, since 28 October 2026: **$12/month** on GitHub
  Free (and Free for organizations), **$18** on Pro/Team, **$300** on Enterprise Cloud.
- At the standard Linux rate of **$0.006/min**, $12 ≈ **2,000 Linux minutes/month**.
- The same pool also pays for cloud sandbox compute, and on Team/Enterprise for larger runners.
- Resets on the 1st of the month at 00:00 UTC; nothing rolls over.

### 2.3 Private-repository limits

| Plan | Included compute | Artifact storage | Cache storage |
| --- | --- | --- | --- |
| GitHub Free | $12 ≈ 2,000 Linux min | 500 MB | 10 GB/repo |
| Pro / Team | $18 ≈ 3,000 Linux min | 1–2 GB | 10 GB/repo |
| Enterprise Cloud | $300 ≈ 50,000 Linux min | 50 GB | 10 GB/repo |

For this design artifacts are **not used at all** (bytes move through the Worker, not through
`upload-artifact`), so the 500 MB artifact allowance is irrelevant. The 10 GB cache is used only for
`node_modules`/npm cache.

### 2.4 Can `workflow_dispatch` be triggered securely from a Worker?

Yes, with one required credential and one hard rule.

- Endpoint: `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` with
  `{"ref": "main", "inputs": {...}}`. Up to 25 inputs for a `workflow_dispatch`.
- Authorisation: a **fine-grained PAT with `Actions: write`**, or a **GitHub App installation token with
  `actions: write`**. OAuth/classic tokens need `repo` scope — do not use them.
- The workflow file must exist on the default branch; `ref` is required.
- **Hard rule:** `workflow_dispatch` inputs are **not masked**. They appear in the run's UI, in the stored
  event payload (`$GITHUB_EVENT_PATH`), and in any log line that prints them. `::add-mask::` runs too late to
  hide a value already in the payload. **No credential, presigned URL or token may be passed as an input.**

The Worker needs outbound HTTPS to `api.github.com` (available) and one secret. That secret is the only new
long-lived credential in the system, which is why §2.5 matters.

### 2.5 GitHub App versus fine-grained PAT

| | Fine-grained PAT | GitHub App installation token |
| --- | --- | --- |
| Lifetime | 1–366 days (or none, unless policy blocks it) | **1 hour**, not configurable |
| Identity | The human who created it | The app (`<slug>[bot]`) |
| Scoping | One resource owner, selected repositories, per-permission | Installation grant, **narrowable per request** (`repositories`, `repository_ids`, `permissions`) |
| Cost to build | Store one string as a Worker secret | RSA private key as a Worker secret, RS256 JWT (≤10 min), exchange for installation token, ~40 lines |
| Failure mode | Expires and everything silently stops | Token minting fails loudly |
| Rotation | Manual, calendar-driven; auto-revoked after a year unused | Rotate the private key; tokens die hourly anyway |

**Recommendation: GitHub App.** For a Worker that runs unattended for years, a human-owned 366-day token is the
weakest part of the design. The App's marginal complexity is one key pair and one JWT helper, and per-request
narrowing (`repository_ids: [<id>]`, `permissions: { actions: "write", metadata: "read" }`) is exactly the
least privilege wanted here. A PAT is acceptable only as a stage-1 expedient with a rotation reminder; it
never goes in workflow inputs, logs or the browser.

Not created in this stage, as required.

### 2.6 Does this need a paid GitHub subscription?

**No.** Three zero-cost paths, in order of preference:

1. Private app repository, ~0.6–1.2 min per image → 1,700–3,300 images/month inside the Free allowance.
2. Public processor-only repository → free and uncapped, no product source exposed.
3. Private repository plus a self-hosted runner on an existing machine → free, but that machine is a server
   the café does not have.

The only way to spend money is to exhaust the allowance **with a payment method on file**. With no payment
method, usage is *blocked* when the allowance is gone — which is the safer failure for a zero-budget product,
and is why §8.3 recommends **no payment method**, or a budget set to stop usage.


---

## 3. Architecture

### 3.1 Diagram

```
  OWNER (browser: café session cookie + CSRF token)
        |  POST multipart, <= 1 MB
        v
+-------------------------------------------------------------------------------+
| CLOUDFLARE WORKER (Workers Free, 10 ms CPU)                                   |
|                                                                               |
|  [1] validate headers  (magic bytes, 1 MB, 4096 px, 16 MP)   <-- kept as-is   |
|  [2] IMAGES.put  cafes/<c>/menu/<i>/staging/<job>.<ext>                       |
|  [3] INSERT image_jobs(state='pending')                                       |
|  [4] POST /repos/{owner}/{repo}/actions/workflows/verify.yml/dispatches       |
|        body: { ref: "main", inputs: { job: "<uuid>" } }   <-- no secret      |
|        auth: GitHub App installation token (actions:write, 1 repo)            |
+-------------------+---------------------------------------+-------------------+
                    |                                       ^
                    | dispatch (HTTPS)                      | OIDC + job token
                    v                                       |
+-------------------------------------------------------------------------------+
| GITHUB ACTIONS (ubuntu-latest, 2-core, ~0.6-1.2 min)                          |
|  [4] on: workflow_dispatch  (default branch only, pinned by claim checks)     |
|  [5] mint OIDC id-token for aud=https://<worker-origin>                       |
|  [6] POST /api/image-jobs/claim   { id_token }        -> { job_token, job }   |
|  [7] GET  /api/image-jobs/<id>/source  (Authorization: Bearer <job_token>)    |
|  [8] sharp: decode -> autoOrient -> resize <=1024 -> jpeg q82 (metadata gone) |
|  [9] PUT  /api/image-jobs/<id>/result  (jpeg bytes, <= 512 KB)                |
| [10] POST /api/image-jobs/<id>/fail    (only on error; same job token)        |
+-------------------------------------------------------------------------------+

+-------------------------------------------------------------------------------+
| CLOUDFLARE WORKER - verification half                                         |
| [11] GET source -> stream to the runner (Class B read)                        |
| [12] PUT result -> sniff JPEG, enforce 512 KB, IMAGES.put verified/<job>.jpg  |
|      -> UPDATE image_jobs state='verified' (single-use, WHERE state='...')    |
|      -> UPDATE menu_items.image_key = verified key, keep previous_key         |
|      -> best-effort delete staging object + previous object                   |
+-------------------------------------------------------------------------------+

        PUBLIC MENU  GET /api/cafes/:slug/menu/:itemId/image
        resolves image_key from D1 (id AND cafe_id), refuses keys containing
        /staging/, serves bytes + nosniff + immutable cache
```

### 3.2 Trust boundaries

| # | Boundary | Who is trusted | Who is not | Control |
| --- | --- | --- | --- | --- |
| B1 | Owner browser → Worker | The café session and its CSRF token | Everything in the multipart body | `ownerSession` + `verifyCsrf` + header validation (unchanged) |
| B2 | Worker → GitHub | The App private key | GitHub's response body | Token narrowed per request; response used only for `ok` |
| B3 | GitHub → Worker | Nothing by default | An arbitrary HTTPS caller, including a workflow in *another* repo | OIDC signature + claim allowlist + `run_id` reconciliation (§4) |
| B4 | Workflow → R2 | Nothing | The runner | **No R2 credentials reach the runner.** All bytes move through the Worker under a job token (§5) |
| B5 | Public → Worker | Anyone | The caller | Only `menu_items.image_key` (written by the verified path) is ever served |
| B6 | Repository write access | Whoever can push to the protected branch | — | Out of scope to defend: a user who can change `verify.yml` on `main` *is* the processor (§11) |

The important inversion compared with the obvious design: the runner is **not** given storage credentials and
is **not** given a database connection. It is given one short-lived bearer token that is valid for exactly one
job, in one direction, for at most 15 minutes.

### 3.3 Data flow

**Upload.** Header validation → staged object → `image_jobs` row `pending` → dispatch. If the dispatch fails,
the job stays `pending` and the owner sees "queued"; the existing verified photo keeps serving.

**Process.** The runner claims the job, downloads the staged bytes, decodes them, re-encodes a canonical JPEG,
and uploads it. It never touches D1, R2 or `menu_items`.

**Commit.** The Worker sniffs the returned bytes, enforces the output cap, writes the verified object, and only
then moves `menu_items.image_key`. The previous key is retained until the swap commits.

**Serve.** The guest route is unchanged: key from D1, bytes from `IMAGES`, immutable cache busted by `?v=`.

**Retry.** A new job gets a new UUID, a new staging key and a new verified key. Nothing is overwritten in place,
so a retry can never corrupt or duplicate a live object.

### 3.4 Why not "process on upload, wait for the result"

Because a Worker request cannot wait 30–60 s for a runner, and `waitUntil` does not extend CPU or the response.
The upload must return as soon as the bytes are staged. That is the entire reason a job table exists.

---

## 4. Authentication design

### 4.1 Worker → GitHub (the dispatch direction)

1. Sign an RS256 JWT: `iss` = App ID, `iat`/`exp` (≤ 10 minutes), header `kid` = key id.
2. `POST /app/installations/{installation_id}/access_tokens` with
   `{"repository_ids":[<repo id>],"permissions":{"actions":"write","metadata":"read"}}`.
   The token lives 1 hour and cannot exceed the App's grant.
3. `POST /repos/{owner}/{repo}/actions/workflows/verify.yml/dispatches` with `ref: "main"` and
   `inputs: { job: <uuid> }`.
4. Cache the installation token in isolate memory until ~5 minutes before expiry. It is never logged, never
   returned to a client, and never written to D1.

The Worker holds: `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` (PKCS#8, secret),
`GITHUB_REPO_ID` and `GITHUB_WORKFLOW_REF` (var). Five values, one of them secret. With a PAT instead:
`GITHUB_PAT` (secret) and the same two vars.

**The dispatch body contains nothing confidential.** A `job` UUID is a routing hint that also appears in
`run-name` for human traceability; it grants nothing (§4.7).

### 4.2 GitHub → Worker (the callback direction)

The workflow requests an ID token for this deployment's own audience:

```yaml
permissions:
  contents: read
  id-token: write        # the only elevated permission; no packages, no actions, no secrets
```

```bash
AUD="https://<worker-origin>"          # exact, no path, no trailing slash
ID_TOKEN=$(curl -sSf \
  -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "${ACTIONS_ID_TOKEN_REQUEST_URL}&audience=$(python3 -c "import urllib.parse,sys;print(urllib.parse.quote(sys.argv[1],safe=''))" "$AUD")" \
  | jq -r .value)
```

The Worker then verifies, in this order, failing closed at every step:

1. **Structure** — three segments, base64url, JSON object.
2. **Algorithm** — header `alg` must be exactly `RS256`; `none` and HS* are refused (no algorithm confusion).
3. **Key** — fetch `https://token.actions.githubusercontent.com/.well-known/jwks` (cache in isolate memory,
   refetch on unknown `kid`, never accept a key supplied by the caller), verify the signature with WebCrypto
   `RSASSA-PKCS1-v1_5`/SHA-256 using the matched `kid`.
4. **Issuer** — `iss === "https://token.actions.githubusercontent.com"`.
5. **Audience** — `aud` equals this deployment's origin exactly. (GitHub's default `aud` is the repository
   owner URL; a custom audience is the only way to make the token useless anywhere else.)
6. **Time** — `nbf <= now <= exp`, with ≤ 60 s clock skew; reject a token whose `exp - iat` exceeds 15 min.
7. **Claim allowlist** — table below.
8. **Binding** — `run_id` must reconcile to a job row (§4.4) and must not have been claimed before (§4.5).

### 4.3 Claim allowlist

| Claim | Required value | Why |
| --- | --- | --- |
| `repository_id` | the numeric id recorded at deploy time | Immutable. Repositories created after 2026-07-15 use a `sub` format with embedded IDs (`repo:owner@id/repo@id:…`), and older ones do not; comparing the explicit `repository_id` claim avoids parsing two `sub` formats. |
| `repository` | `owner/repo` | Human-readable cross-check; never the sole check (names are recyclable). |
| `repository_visibility` | `private` (or `public` if that was chosen deliberately) | Detects an accidental visibility change. |
| `event_name` | `workflow_dispatch` | Blocks `pull_request`, `pull_request_target`, `push`, `schedule`, `workflow_call`, `repository_dispatch`. |
| `ref` | `refs/heads/main` | Blocks a branch that runs unreviewed workflow code. |
| `workflow_ref` | `.github/workflows/verify.yml@refs/heads/main` | Pins the *file*. Without it, any workflow in the repo could claim jobs. |
| `job_workflow_ref` | same as `workflow_ref` | Catches a reusable-workflow indirection. |
| `runner_environment` | `github-hosted` | Optional; records that no self-hosted runner stood in. |
| `exp` / `nbf` | within 15 min of `iat`, currently valid | Bounds the replay window. |

Explicitly **not** trusted: `actor`, `workflow` (display name, mutable), `run_number` (predictable), and the
`job` input. None of them appear in an authorisation decision.

### 4.4 Binding a run to a job (the part that is easy to get wrong)

The dispatch API returns `204` and **no run id**, so the Worker cannot record which run it started. A job id in
the input is not proof. The binding is therefore established from GitHub's own record:

1. At dispatch the Worker writes `state='dispatched'`, `dispatched_at`, `workflow_ref`, `ref`, and a random
   32-byte `claim_salt_hash` — plus the UUID, which is also put in `run-name: verify ${{ inputs.job }}`.
2. On the first `POST /api/image-jobs/claim` the Worker verifies the token (§4.2), then calls
   `GET /repos/{owner}/{repo}/actions/runs?event=workflow_dispatch&per_page=30` with the App token and looks for
   a run where:
   - `id` equals the verified `run_id` claim (the decisive check), and
   - `path` equals `GITHUB_WORKFLOW_REF`, and
   - `head_branch` equals `main`, and
   - `created_at >= dispatched_at - 60 s`, and
   - `display_title` contains the UUID from the input.
3. Only if that run exists and is not already bound to another job does the Worker write
   `gh_run_id = verified.run_id` and move the job to `processing`.

The GitHub API read is what turns "a workflow in my repo says job X" into "**run 12345**, which GitHub records as
this workflow on this branch at this time, is job X". The input UUID selects the row; the verified `run_id` is
what authorises it. A caller who invents a job id gets nothing, because no run exists with that `display_title`
and time window.

### 4.5 Replay prevention and one-time authorisation

- `image_jobs.gh_run_id` has a **unique index**. One run can claim one job, ever.
- The claim is a single atomic statement:
  `UPDATE image_jobs SET state='processing', gh_run_id=?, lease_expires=?, attempts=attempts+1 WHERE id=? AND state='dispatched' AND gh_run_id IS NULL RETURNING id`.
  Zero rows → 409, and no token is issued.
- The issued `job_token` is an HMAC-signed value (`ADMIN_SECRET` exists already; a dedicated
  `IMAGE_JOB_SECRET` is cleaner) carrying `job_id`, `run_id`, `exp = now + 15 min`, and a random nonce. It is
  checked on every source/result/fail call, and each state transition is a conditional UPDATE, so a replayed
  token cannot complete a job twice.
- A fresh OIDC token minted later in the *same* run still fails, because `gh_run_id` is already claimed and the
  job is no longer `dispatched`.
- Failed attempts are counted: a job that has been claimed and then gone stale three times is `failed` for good.

### 4.6 Minimum workflow permissions

```yaml
name: verify
on:
  workflow_dispatch:
    inputs:
      job: { required: true, type: string }
run-name: "verify ${{ inputs.job }}"
permissions:
  contents: read      # checkout of the pinned workflow only
  id-token: write     # OIDC
concurrency:
  group: verify-${{ inputs.job }}
  cancel-in-progress: false
```

No `GITHUB_TOKEN` write scopes, no `secrets:` used at all (nothing to steal from the runner's environment), no
`actions/upload-artifact`, no `pull_request_target`, no `workflow_run`. Third-party actions are pinned by full
commit SHA, and ideally there are none: `actions/checkout` and `actions/setup-node` are the only candidates and
`checkout` is not even needed if the processing script is fetched from the pinned ref by URL.

### 4.7 Why a job id must never be the credential

If a job UUID alone authorised processing, anyone who can read a GitHub run could take a job they do not own,
download a pending photo and mark it verified with bytes they chose — a confidentiality leak and an integrity
break with no authentication at all. Here the UUID is only a **selector**: authorisation needs a valid OIDC
signature from GitHub, the exact repository id, the exact workflow file on the exact branch,
`event_name = workflow_dispatch`, a live time window, and a GitHub API record tying that `run_id` to that
dispatch. None of those can be produced outside GitHub's runner infrastructure.

### 4.8 Refusal matrix (stable reason codes; tokens are never logged)

| Condition | Result |
| --- | --- |
| Missing bearer | 401 `no_token` |
| Malformed JWT | 401 `malformed` |
| `alg` ≠ RS256 | 401 `bad_alg` |
| Unknown `kid` after a JWKS refresh | 401 `unknown_key` |
| Signature mismatch | 401 `bad_signature` |
| Wrong `iss` / `aud` | 401 `bad_issuer` / `bad_audience` |
| Expired, not yet valid, or lifetime > 15 min | 401 `stale_token` |
| Wrong `repository_id` / `repository` | 403 `wrong_repo` |
| Wrong `event_name`, `ref` or `workflow_ref` | 403 `wrong_context` |
| No job row, or row not `dispatched` | 409 `no_job` |
| `gh_run_id` already bound | 409 `already_claimed` |
| Run absent from GitHub's API within the window | 409 `unbound_run` |
| Job expired or attempts ≥ 3 | 410 `job_dead` |

---

## 5. Image transfer: A versus B

### 5.1 Option A — Worker-mediated transfer (recommended)

The runner downloads the staged object from the Worker and uploads the result to the Worker, both under the
job token. The Worker streams to and from R2 with the `IMAGES` binding.

### 5.2 Option B — short-lived R2 presigned URLs

The Worker signs S3 URLs (GET for the staged key, PUT for the result key) and hands them to the workflow.

### 5.3 Comparison against the required criteria

| Criterion | A. Worker-mediated | B. Presigned URLs |
| --- | --- | --- |
| **Credential exposure** | None outside the Worker. The runner holds only a 15-minute, single-job bearer. | Requires **R2 S3 access key + secret in the Worker** (to sign SigV4) and delivers a signed URL to the runner. Every URL is a bearer credential for one object; a leaked bucket key would be far worse, but R2 tokens cannot be scoped to a key prefix — only to a bucket. |
| **Maximum object size** | Worker request body limit (100 MB on Workers Free) and `IMAGES.put` 5 GiB; the Worker enforces its own **512 KB** output cap before writing. | R2 single `PUT` up to 5 GiB. Presigned **PUT cannot carry `content-length-range`** — that is an S3 POST-policy feature and R2 does not support presigned POST. So the workflow can write an object of any size, and the Worker only discovers it on read. |
| **Memory consumption** | Streaming in and out; the 1 MB source and 512 KB result never need full buffering beyond what the Worker already does today. | Zero Worker memory for transfer, but the Worker must sign with credentials it holds. |
| **Retry behaviour** | Idempotent per job: re-GET is free; re-PUT of the same bytes to the same verified key is a no-op if the Worker checks the state first. A retry needs a fresh job token (cheap). | A presigned URL expires (1 s–7 days); retries after expiry need a new URL round-trip, or a longer TTL that widens the leakage window. |
| **CORS and URL leakage** | No CORS (server-to-server). URLs are Worker paths under a bearer, so they leak nothing alone. | URL is visible in the run's stored event payload if passed as an input, in `$GITHUB_EVENT_PATH`, and in any log line. `::add-mask::` cannot hide it from the payload. Presigned URLs also only work on `*.r2.cloudflarestorage.com`, never a custom domain. |
| **Authentication** | OIDC + `run_id` binding + job token (§4). | Presigned URL **is** the authentication: possession equals permission, with no identity, no job binding and no single-use guarantee. |
| **R2 stays private** | Yes. No public bucket, no bucket URL, no S3 credentials outside the Worker. | Yes, but the bucket's S3 endpoint and account id become known to the runner and to anyone who can read the run. |

### 5.4 Verdict

**A.** It is the only option that keeps R2 credentials out of CI entirely, cannot be replayed, and lets the
Worker enforce an output ceiling. Its costs — a few hundred KB of Worker egress per image, two extra requests,
and streaming code in the Worker — are trivial at café volume, and Workers Free request bodies (100 MB) are far
above the 1 MB/512 KB this needs.

---

## 6. D1 job lifecycle

### 6.1 Proposed schema (additive, local-only in this audit)

```sql
CREATE TABLE IF NOT EXISTS image_jobs (
  id                TEXT PRIMARY KEY,           -- uuid from the Worker
  cafe_id           INTEGER NOT NULL,
  item_id           INTEGER NOT NULL,
  state             TEXT NOT NULL,              -- dispatched|processing|verified|rejected|failed|expired
  source_key        TEXT NOT NULL,              -- cafes/<c>/menu/<i>/staging/<job>.<ext>
  source_bytes      INTEGER NOT NULL,
  source_sha256     TEXT NOT NULL,
  result_key        TEXT,                       -- cafes/<c>/menu/<i>/verified/<job>.jpg
  previous_key      TEXT,                       -- menu_items.image_key at commit time
  job_secret_hash   TEXT NOT NULL,              -- sha256 of the per-job HMAC key
  gh_run_id         TEXT,                       -- unique once bound
  attempts          INTEGER NOT NULL DEFAULT 0,
  lease_expires     INTEGER,                    -- ms; 15 min from claim
  error_code        TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL            -- created_at + 24 h
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_jobs_run   ON image_jobs (gh_run_id) WHERE gh_run_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_image_jobs_live  ON image_jobs (cafe_id, item_id)
  WHERE state IN ('dispatched','processing');
CREATE INDEX IF NOT EXISTS idx_image_jobs_state ON image_jobs (state, updated_at);
```

Both partial unique indexes are ordinary SQLite and supported by D1. `idx_image_jobs_live` is what makes
"one live job per item" a database guarantee rather than application discipline.

### 6.2 State machine

```
                 dispatch ok
   (upload) ──► dispatched ──claim+run_id──► processing ──result ok──► verified
                    │                            │
                    │ no run / 3 attempts        ├── reject (bad pixels/dims/format) ──► rejected
                    │ within lease window        ├── explicit fail call ───────────────► failed
                    └────────────────────────────┴── lease expired, attempts < 3 ─────► dispatched (retry)

   pending/processing ──24 h expiry──────────────────────────────────────────────────► expired
```

The brief's three paths map on as: `dispatched → processing → verified`,
`dispatched → processing → rejected`, `dispatched → processing → failed`. Two extra states are needed in
practice: **`dispatched`** (the row exists but no run has claimed it — this is where a dropped dispatch lives)
and **`expired`** (the sweep's terminal state, distinct from a processing failure).

### 6.3 Invariants

1. `menu_items.image_key` is written **only** in the `processing → verified` transition.
2. A job row is the only thing that can move a key; the runner cannot set `image_key`.
3. `source_key` and `result_key` are generated by the Worker from `cafe_id`, `item_id` and the job UUID.
4. At most one live job per `(cafe_id, item_id)`; enforced by index, surfaced as HTTP 409 to the owner.
5. Every transition is a conditional `UPDATE … WHERE id=? AND state=?`; zero rows means someone else moved it.
6. `gh_run_id` is bound at most once, for ever.

### 6.4 Duplicate jobs and concurrency

- A second upload while a job is live returns **409 "A photo for this item is already being checked"** and does
  nothing. The owner can cancel and retry once the first completes or expires.
- Two uploads racing in the same millisecond: one `INSERT` wins on the partial unique index; the loser's staged
  object is deleted inline and it gets the 409. No lock, no read-then-write window.
- Two runs for one job: impossible after binding (unique `gh_run_id`, conditional claim). A duplicate
  `workflow_dispatch` that starts a second run finds no claimable row and exits immediately.
- Two jobs for different items: independent, no global serialisation. The workflow deliberately has **no**
  repository-wide concurrency group, only per-job, because a global group with the default
  `cancel-in-progress` behaviour would silently cancel pending jobs.

### 6.5 Stale jobs, expiry, retry limits

- **Lease:** 15 minutes from claim, renewed only by progress calls. A run that dies (runner loss, timeout,
  `npm ci` failure before claim) leaves a lease that lapses.
- **Reaper:** the job is reaped lazily whenever any job for that item is read (admin panel, upload, public menu
  miss), and additionally by one scheduled Worker trigger per day if one is later added. Lazy reaping keeps the
  design free of cron entirely; the cost is that a dead job stays visible as "processing" until the item is next
  looked at.
- **Retry:** a lapsed lease with `attempts < 3` returns the row to `dispatched` with **the same source key** (the
  staged bytes are unchanged, so no second object) and a fresh dispatch. `attempts = 3` → `failed` permanently.
- **Expiry:** `expires_at = created_at + 24 h`. Any job past it is `expired`; its staged object is deleted.

### 6.6 Failed GitHub runs

Three independent detections, because each alone is unreliable:

1. The workflow's final step (`if: failure()`) calls `POST /api/image-jobs/:id/fail` with its job token.
2. Lease expiry (§6.5) catches a run that never reached that step.
3. The reaper catches a run that claimed and then vanished.

The owner sees "Processing failed — try again", never a spinning state, and the previous verified photo keeps
serving throughout.

### 6.7 Replacement rollback and preservation of the live image

- Before the swap, `previous_key` records the current `image_key`.
- The verified object is written first; the D1 update then sets `image_key = verified_key` **and** leaves
  `previous_key` on the job row.
- Only after that commit is the previous object deleted (best-effort). If the delete fails, the old object is an
  orphan, not a loss.
- To roll back a bad replacement, the operator sets `image_key = previous_key` — the object still exists until
  the next successful replacement's cleanup, so rollback is a metadata operation, not a re-upload.
- The public route never 404s during a replacement: at every instant `image_key` points at an object that was
  written before the pointer moved.

### 6.8 Cleanup of abandoned pending objects

| Object | When it is deleted |
| --- | --- |
| `staging/<job>` on success | Immediately after `verified` commits |
| `staging/<job>` on rejection/failure/expiry | By the reaper that terminated the job |
| `staging/<job>` whose insert lost the race | Inline, in the losing request |
| `verified/<job>` superseded | After the next successful swap |
| `verified/<job>` for a deleted item | By the existing `adminDeleteItem` path, extended to `previous_key` |
| Anything unreferenced | A listing comparison (`list` keys vs `menu_items.image_key ∪ image_jobs.result_key`), run manually or by the daily trigger |

### 6.9 The public endpoint guarantee

`GET /api/cafes/:slug/menu/:itemId/image` resolves the key from D1 and serves it. Because only the
`verified` transition writes `image_key`, `dispatched`, `processing`, `rejected`, `failed` and `expired` images
are unreachable by construction. Two cheap belt-and-braces additions:

- refuse any key containing `/staging/` (a key that should never be referenced), and
- serve the category default / emoji while the item's first job is in flight.

No cache header changes are needed: a verified replacement is a new key and a new `?v=`, so the immutable entry
for the old one is simply never requested again.
---

## 7. Processing: sharp on a GitHub-hosted Linux runner

### 7.1 What was measured

`sharp` **0.35.5** (Apache-2.0) bundling **libvips 8.18.7**, Node v26.13.1, on the audit machine (Windows 11),
libvips concurrency 1 unless stated, with the same synthetic fixtures Stage 3G used
(`%TEMP%\stage3g-poc\fixtures`). The `sharp` binary is the one **already in the project's `node_modules`** as a
miniflare dev dependency — nothing was installed. These are desktop numbers, not runner numbers; they are used
to judge *behaviour* (accept/reject, metadata, limits) and to bound latency, not to claim a CI benchmark.

### 7.2 Actual decoding, not header inspection

| Input | Result | Time | Error |
| --- | --- | --- | --- |
| Truncated JPEG (50 % cut, 413 KB of 826 KB) — default `failOn: 'warning'` | **rejected** | 33 ms | `VipsJpeg: premature end of JPEG image` |
| Same, `failOn: 'error'` | **rejected** | 31 ms | same |
| Same, `failOn: 'none'` | **accepted** | 544 ms | — (this is exactly what Stage 3G showed SIP doing by default) |
| Truncated PNG (50 % cut) | **rejected** | 64 ms | `vipspng: libpng read error` |
| Truncated WebP (50 % cut) | **rejected** | 1 ms | `Input buffer has corrupt header: webp: unable to parse image` |
| Forged PNG IHDR rewritten to 40000 × 40000 (CRC fixed) | **rejected** | 1 ms | `Input image exceeds pixel limit` |
| 5000 × 5000 JPEG (25 MP) | **rejected** | 1 ms | `Input image exceeds pixel limit` |
| 4096 × 4096 solid PNG (50 KB on the wire) | accepted | 952 ms | — memory bounded, **CPU/time not** |

Two observations that matter:

- **sharp closes the Stage 3G gap.** The truncated JPEG that SIP silently repaired into uniform grey is refused
  here, *by default*, because libjpeg reports premature EOF as a warning and sharp's default `failOn` is
  `'warning'`. libvips' own default is permissive (`VIPS_FAIL_ON_NONE`), so the explicit option is mandatory —
  `sharp(buf, { failOn: 'warning' })` must be written out, not implied by the loader.
- **`metadata()` is not a safe pre-check.** With `limitInputPixels: false`, `metadata()` reported
  `40000x40000` for the forged file *without decoding it*. A pipeline that reads dimensions from `metadata()`
  and then decides is trusting the header exactly as today's Worker does. The pixel limit must be applied by
  the constructor (which is why the forged file and the 25 MP file both fail in 1 ms, before any pixel work).

### 7.3 Time and output size for the realistic pipeline

`decode → autoOrient → resize(fit: inside, withoutEnlargement) → jpeg(q82, mozjpeg)`; metadata stripped by
default.

| Input | Wire size | → ≤ 1600 px | → ≤ 800 px | → ≤ 256 px | Output at ≤ 800 |
| --- | --- | --- | --- | --- | --- |
| 1024² JPEG | 0.19 MB | 227 ms | 202 ms | 30 ms | 186 KB |
| 1024² PNG | 0.41 MB | 284 ms | 216 ms | 56 ms | 191 KB |
| 1024² WebP | 0.19 MB | 300 ms | 202 ms | 42 ms | 175 KB |
| 1800² JPEG (≈1 MB class) | 0.77 MB | 742 ms | 236 ms | 49 ms | 207 KB |
| 1500² PNG (1.00 MB) | 1.00 MB | 637 ms | 285 ms | 88 ms | 212 KB |
| 2350² WebP (0.99 MB) | 0.99 MB | 767 ms | 305 ms | 122 ms | 208 KB |
| 4096² JPEG (16 MP) | 2.99 MB | 890 ms | 299 ms | 71 ms | 241 KB |
| 4096² PNG (16 MP) | 9.65 MB | 1169 ms | 634 ms | 401 ms | 242 KB |
| 4096² WebP (16 MP) | 3.46 MB | 1076 ms | 511 ms | 300 ms | 235 KB |

Every run produced a fresh JPEG with `exif=false`. Peak RSS moved by 0–2 MB against baseline: libvips streams,
so a 16 GB runner is not remotely at risk, which is the first time in this series that **memory is a non-issue**
(the Worker's 128 MB was the binding constraint in Stage 3G).

A 1600 px output lands at 620–823 KB — larger than the 1 MB input cap allows for a *result*. **Choose a smaller
canonical output:** max side 1024, quality 82 → 200–300 KB, and a hard **512 KB** ceiling enforced by the
Worker. The menu medallion is 52 px and the largest use is a detail view, so 1024 is generous.

### 7.4 Metadata and EXIF orientation

A JPEG carrying an `APP1 Exif` segment plus a synthetic GPS payload
(`GPSLatitude=28.6139;GPSLongitude=77.2090;Make=TestPhone;Model=Pixel`) was re-encoded:

| Property | Input | Output |
| --- | --- | --- |
| EXIF segment | 73 bytes present | **absent** (`metadata().exif === undefined`) |
| ICC profile | present | **absent** |
| `GPSLatitude` / `Make` / `Model` strings | present | **absent** |
| Dimensions | 1024 × 1024 | 1024 × 1024 |

sharp strips all metadata on encode by default and converts to a web-friendly sRGB profile; only
`keepMetadata()` / `withMetadata()` would preserve it. `autoOrient()` applies EXIF orientation **and removes the
tag**, so a phone photo taken sideways is corrected once and cannot be re-rotated by the browser later.

A measurement caveat worth recording: a naive `bytes.includes('GPS')` scan reported a hit in an unrelated
output, because three ASCII bytes occur by chance in 3.4 MB of compressed data. Verify with `metadata()`, not
substring search.

### 7.5 Required pipeline

```js
const MAX_INPUT_PIXELS = 16 * 1024 * 1024;   // same ceiling the Worker enforces
const MAX_OUT = 512 * 1024;

const out = await sharp(src, {
  failOn: "warning",          // rejects truncated JPEG/PNG, not just corrupt containers
  limitInputPixels: MAX_INPUT_PIXELS,
  sequentialRead: true,
  animated: false,            // first frame only; never a GIF/WebP animation loop
})
  .autoOrient()
  .resize({ width: 1024, height: 1024, fit: "inside", withoutEnlargement: true })
  .toColourspace("srgb")
  .jpeg({ quality: 82, mozjpeg: true, progressive: false })
  .toBuffer({ resolveWithObject: true });

if (out.info.format !== "jpeg") throw new Error("unexpected output format");
if (out.info.width < 32 || out.info.height < 32) throw new Error("image too small");
if (out.info.width > 1024 || out.info.height > 1024) throw new Error("resize failed");
if (out.info.size > MAX_OUT) throw new Error("output too large");
```

Then re-open the buffer with `sharp(out.data).metadata()` and assert: `width`, `height` within bounds, and
`exif === undefined`. Belt-and-braces, because "the decoder returned an image" was already shown to be
insufficient once (Stage 3G §2).

### 7.6 Limits the workflow must enforce (matching or tightening today's)

| Limit | Value | Where enforced |
| --- | --- | --- |
| Input bytes | 1 MB | Worker (unchanged) |
| Input dimensions | 4096 px per side | Worker header check + sharp pixel limit |
| Input pixels | 16 MP | `limitInputPixels` |
| Format | JPEG / PNG / WebP, still images only | Worker magic bytes + `failOn` + `animated: false` |
| Output format | JPEG only | `.jpeg()`; Worker re-sniffs on receipt |
| Output bytes | **512 KB** | Workflow check + Worker hard cap |
| Output dimensions | ≤ 1024 px per side | `.resize()`; Worker re-reads header |
| Metadata | none | default strip + post-check |
| SVG | rejected | never reaches sharp (Worker 415) |

### 7.7 Dependency pinning and supply chain

- **Pin sharp exactly** (`"sharp": "0.35.5"`, not `^0.35.5`) with a committed `package-lock.json`, installed by
  `npm ci`. The lockfile's `integrity` hashes are what make the install reproducible; `npm ci` refuses a
  mismatch.
- sharp has 3 runtime dependencies (`@img/colour`, `detect-libc`, `semver`) and 25 optional platform packages
  that carry the prebuilt libvips — the platform binary is an **optional dependency resolved at install**, so
  `--ignore-scripts` is not an option and `npm ci` must be allowed to run its install script.
- **Pin every action by full commit SHA**, not `@v4`. Prefer zero third-party actions: download the processing
  script from the pinned ref, use `node` from the runner image.
- No `secrets:` in the workflow at all, so a compromised action has nothing to exfiltrate beyond a 15-minute job
  token that is already scoped to one image.
- The runner's `GITHUB_TOKEN` is limited to `contents: read` and `id-token: write`.
- Record the resolved sharp/libvips versions in the job result (`sharp.versions`) so a silent platform change is
  visible in the audit trail.
---

## 8. Operational reliability

### 8.1 Expected latency

There is no SLA and no way to promise one. What the components imply:

| Stage | Typical | Notes |
| --- | --- | --- |
| Owner upload → dispatch accepted | 200–600 ms | One GitHub API call |
| Dispatch → runner starts | **5–20 s** | 1–3 min in bursts or during GitHub incidents; occasionally longer |
| Checkout + Node + `npm ci` (cached) | 5–15 s | 25–40 s with a cold cache |
| sharp decode + encode | 0.3–1.2 s | §7.3 |
| Transfer in + out | ~1 s | 1 MB + 0.3 MB through the Worker |
| **End to end, p50** | **~30–60 s** | |
| **p95** | **2–5 min** | |
| Worst observed class | tens of minutes | Hosted-runner shortage; the job simply waits |

The image is usable through the whole window: the previous verified photo, or the category default, keeps
serving. Nothing in the guest experience blocks on processing.

### 8.2 Usage per image

| Configuration | Minutes per image | Images in 2,000 included minutes |
| --- | --- | --- |
| Warm npm cache, no checkout | ~0.4–0.7 | ~2,850–5,000 |
| Warm cache with `actions/checkout` | ~0.6–0.9 | ~2,200–3,300 |
| Cold cache | ~0.9–1.6 | ~1,250–2,200 |

A café with 50 items that replaces every photo once a month spends ~50 images; 30 such cafés fit inside the
Free allowance with two thirds to spare. **Batch uploads are the only realistic way to exhaust it** (a café
importing 500 photos spends ~500 of the ~2,000).

Artifacts are not used, so the 500 MB artifact allowance is untouched. Cache stays far below 10 GB (a
node_modules with sharp is ~60–90 MB).

### 8.3 Free-tier exhaustion behaviour

| Account state | What happens when the allowance is gone | Consequence here |
| --- | --- | --- |
| **No payment method** (recommended) | Hosted-runner usage is **blocked**; jobs stop starting | Dispatches are accepted by the API but never run; the lease reaper marks them `failed`; the owner sees "processing is unavailable, try again later"; the previous photo keeps serving |
| Payment method, no budget | Every further minute is **billed silently** | Unacceptable for a zero-budget product |
| Payment method + budget with "stop usage" | Usage stops at the dollar threshold | Equivalent to the first row, with a spend ceiling |

The design must therefore treat "no run ever started" as a normal failure mode, not an exception.

### 8.4 What the owner sees

The Menu tab gains a small state line per item, fed by `GET /api/admin/menu` (which already returns items):

| Job state | Owner text | Controls |
| --- | --- | --- |
| none | "Default photo" / "Custom photo" | Upload |
| `dispatched` | "Queued for checking" | Cancel |
| `processing` | "Checking photo…" | Cancel (marks the job `failed`, releases the slot) |
| `verified` | "Ready" | Replace, Remove |
| `rejected` | "That photo can't be used — try another" + reason (`too large`, `not a real image`, `corrupt`) | Try again |
| `failed` | "Checking failed — try again" | Retry |
| `expired` | "Checking timed out — try again" | Retry |

No state hides the fact that a human must act. `Cancel` is a conditional `UPDATE … WHERE state IN
('dispatched','processing')` plus a best-effort delete of the staged object; a run that is already executing
finds its job gone and discards its result.

### 8.5 Retrying without duplicate objects

- **Retry a lapsed job:** same job id, same `source_key`, same `result_key`. Nothing is re-uploaded, and the
  conditional `verified` write means a late duplicate from the first attempt cannot overwrite the second.
- **Retry after `rejected`/`failed`:** a **new** job with a new UUID, a new staged object (the owner is uploading
  again anyway) and a new verified key. The old objects are swept by the reaper.
- **Owner re-upload while a job is live:** 409, no second object, no second dispatch.
- **Operator action:** `POST /api/operator/image-jobs/:id/redispatch` (audit-logged) for the case where GitHub
  was down at dispatch time.

### 8.6 Is GitHub Actions acceptable as a low-volume processor without an SLA?

**Yes, on these conditions, and only because nothing user-facing waits on it:**

- The upload path is unchanged and returns immediately.
- Pending, failed and rejected images are never served; the previous verified photo or the default shows instead.
- Every job is idempotent, leased and retried at most three times, with a visible failure to the owner.
- There is a documented manual fallback: run the same script locally (it needs only the job token, which an
  operator can mint) if GitHub is unavailable for an extended period.

**It is not a queue, and must never be described as one.** There is no delivery guarantee, no ordering, no
dead-letter queue, no per-minute throughput commitment. GitHub documents delays and dropped runs for `schedule`
events, 6-hour job limits, 35-day run limits and 100-item concurrency queues with cancel-on-replace defaults.
The design tolerates all of it by making every step recoverable; it does not pretend the guarantees exist.

---

## 9. Cost estimate

| Service | Usage per image | Free allowance | Monthly cost at café volume |
| --- | --- | --- | --- |
| GitHub Actions (private repo) | ~0.6–1.2 min | $12 ≈ 2,000 Linux min | **$0** up to ~1,600–3,300 images |
| GitHub Actions (public processor repo) | same | Uncapped for standard runners | **$0** always |
| Cloudflare R2 | 2 Class A (staging PUT, verified PUT) + 2 Class B (source GET, served GET); deletes and egress free | 1 M Class A, 10 M Class B, 10 GB | **$0** up to ~500,000 images/month |
| Cloudflare Workers | 3 extra requests per image; CPU ~1–3 ms each (streaming) | 100k requests/day | **$0** |
| Cloudflare D1 | ~6 row writes + a few reads per job | 100k writes/day | **$0** |
| sharp / libvips | — | — | **$0** (Apache-2.0 / LGPL-2.1, run in CI, not distributed) |
| GitHub App | — | — | **$0** |
| **Total** | | | **$0/month** |

The only spend risk is a payment method attached to the GitHub account (silent overage) or a public bucket
(the design keeps it private). Both are configuration decisions, not architectural ones.

---

## 10. Failure and recovery scenarios

| Scenario | What breaks | Recovery | User-visible |
| --- | --- | --- | --- |
| GitHub API rejects the dispatch (401/403/404) | No run exists | Job stays `dispatched`; owner retried or operator re-dispatches; alert on repeated 401 (credential problem) | "Queued" then "try again" |
| App private key rotated mid-flight | Minting fails | New key in the Worker secret store; cache cleared on 401 | Brief "queued" |
| Dispatch accepted, run never starts (allowance exhausted) | Nothing runs | Lease reaper → `failed`; owner retries later; ops notice via failure rate | "Checking failed" |
| Runner dies mid-job | No result, no fail call | 15-min lease → re-dispatch with same source key, up to 3 attempts | Job returns to "checking" |
| Workflow fails (npm, sharp, bug) | `if: failure()` calls `/fail` | `failed` with `error_code`; owner sees "try again" | Immediate |
| Image rejected (truncated, bomb, unsupported) | No verified output | `rejected` with reason; staged object deleted | "Try another photo" |
| OIDC token replayed | Claim refused | 409 `already_claimed`; logged with `run_id`, never the token | None |
| Forged `job` input from a hostile workflow in the same repo | No matching run → 409 | `unbound_run`; counts as an incident worth alerting on | None |
| `IMAGES.put` fails on the result | No verified object | Job `failed`; staged object retained for a retry; previous photo still live | "Try again" |
| D1 update fails after the verified object was written | Object orphaned | Retry writes the same key; sweep deletes unreferenced `verified/` objects | "Try again" |
| Cleanup delete fails | Orphan object | Sweep (listing vs references) | None |
| Owner cancels during processing | Job `failed` | Staged object deleted; the run's later PUT is refused (state changed) | "Cancelled" |
| Item deleted while a job runs | Item gone | Job `failed`; result refused (item lookup returns nothing); objects swept | None |
| Café's previous photo must be restored | — | Operator sets `image_key = previous_key`; object still present | Instant |
| GitHub outage for hours | No processing | Uploads queue as `dispatched`; runner later drains them; manual fallback available | "Queued" for the duration |
| Repository made public by accident | OIDC claim changes to `public` | Claim check fails closed → all jobs refused until the configuration decision is re-approved | Processing stops, visibly |
---

## 11. Security assessment

| # | Threat | Without this design | Control in this design | Residual |
| --- | --- | --- | --- | --- |
| S1 | Anyone on the internet calls the "job finished" endpoint | Trivially forges a verified image | OIDC signature + claim allowlist + `run_id` binding (§4) | None known |
| S2 | A workflow in another repository claims a job | Would be accepted by a naive `repo`-check | `repository_id` (immutable) + `workflow_ref` + `ref` + `aud` | None known |
| S3 | A fork PR or `pull_request_target` run claims a job | Common real-world bypass | `event_name === 'workflow_dispatch'` required | None known |
| S4 | Replay of a captured OIDC token | Token valid ~5 min | Unique `gh_run_id`, single-use claim, 15-min job token, conditional updates | None known |
| S5 | Job id treated as a password | Read access to a run = upload authority | Job id is only a lookup selector; see §4.7 | — |
| S6 | Credentials leak through workflow inputs or logs | Inputs are visible in the stored payload and unmasked | No secret is ever an input; no `secrets:` in the workflow; log lines never print the job token | A 15-min job token could leak into a log if the workflow prints it — forbidden by the workflow and masked first |
| S7 | R2 credentials on the runner | A stolen runner = full bucket | None exist outside the Worker; transfer is Worker-mediated (§5) | None |
| S8 | Malformed/truncated image stored as valid | Today's header checks pass a truncated JPEG | `failOn: 'warning'` rejects it (§7.2) | Progressive/CMYK JPEG not tested |
| S9 | Decompression bomb | 4096² PNG in 50 KB costs 950 ms | Pixel limit + output cap + job timeout | CPU is cheap on a runner; a bomb only wastes one job |
| S10 | Metadata / GPS leak | Phone photos carry EXIF and GPS | Re-encode strips EXIF, ICC and GPS (§7.4) | None known |
| S11 | Pending photo publicly readable | A guessable key would expose it | Public route reads `image_key` from D1 only; `verified` is the only writer; `/staging/` refused | None known |
| S12 | Malicious substitute output from the runner | — | **Not defended.** A user who can push to the workflow branch can change what "verified" means | Accepted boundary (§3.2 B6); branch protection and review are the control |
| S13 | Owner burns GitHub minutes deliberately | Upload loop → allowance exhausted | Existing API rate limit + one live job per item + 24 h expiry; add a per-café daily upload cap | Minutes exhaustion degrades processing, not the menu |
| S14 | Supply-chain compromise of the processor | Arbitrary code on the runner | Exact pins, `npm ci` integrity, actions pinned by SHA, no secrets to steal | sharp's optional platform binaries are resolved at install; pinning the lockfile is the control |
| S15 | Cache poisoning of a served image | — | Immutable cache keyed by UUID + `?v=`; a changed photo is a new URL | None |
| S16 | Log/diagnostic leakage | Bucket names, account ids | Logs carry café id, item id, job id, `run_id`, error code — never bytes, tokens or bucket names | None known |

One thing this design **does not** buy: it does not make image processing trustworthy against the repository's
own writers. The processor's integrity rests on who can change `verify.yml` on `main`. If CI must be trusted
against its own maintainers, the answer is a separate, protected processor repository with its own review, not
more cryptography in the Worker.

---

## 12. Implementation prerequisites

Ordered; nothing here was done in this audit.

**Account and repository (human decisions, one-time)**

1. Create the GitHub repository (or the processor-only public repository) and push a branch named `main`.
2. Decide visibility: private ($12 allowance) or public (uncapped, source exposed). Record the decision — the
   OIDC claim check in §4.3 hard-codes the expected value.
3. Protect `main`: required review, no force-push, restrict who may push — this is the control behind S12.
4. Confirm the plan and remaining allowance in Billing (unverifiable from here, §2.2). Ensure **no payment
   method**, or a budget with "stop usage".

**Credentials (one-time, never in chat or project files)**

5. GitHub App with `actions: write` (dispatch) and `actions: read` (run reconciliation), installed on that one
   repository. Or, as a stage-1 expedient, a fine-grained PAT with the same two permissions and a calendar
   reminder before its expiry date.
6. Store `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID`, `GITHUB_APP_PRIVATE_KEY` as Worker secrets; `GITHUB_REPO_ID`,
   `GITHUB_WORKFLOW_REF`, `IMAGE_JOB_SECRET` as secrets/vars. Names only — values go through the platform's
   secret store.

**Storage**

7. Provision the `IMAGES` R2 binding for preview **and** production (the code already expects it; today it
   answers 503). No bucket URL is published.

**Code (a later stage, not this one)**

8. Migration adding `image_jobs` (additive only), plus the two partial unique indexes.
9. Worker: `dispatchImageJob`, `claimImageJob` (JWKS + claim checks + run reconciliation), `getJobSource`,
   `putJobResult`, `failJob`, `cancelJob`, and the reaper. Keep the existing header validation on upload.
10. Public route: refuse keys containing `/staging/`; keep resolving from D1.
11. Admin API/UI: job state line, cancel, retry, rejection reasons (§8.4).
12. Workflow `verify.yml` on `main` (pinned actions, no secrets, `id-token: write` only) plus the processing
    script with the §7.5 pipeline and output assertions.

**Verification before anything is enabled for owners**

13. Local workerd/Wrangler run with a fake `IMAGES` and a fake dispatch: state machine, one-live-job index,
    lease reaping, cancellation, rollback.
14. Negative auth tests: wrong `aud`, wrong `repository_id`, wrong `ref`, `event_name: push`, replayed token,
    unbound `run_id`, forged `job` input. Each must return the §4.8 code and write nothing.
15. Two-café isolation: a job token for café A cannot fetch café B's staged bytes; a verified commit for one
    item cannot touch another.
16. Confirm that a `processing` or `failed` item never yields a 200 from the public image route.

---

## 13. Recommendation: CONDITIONAL GO

**Go** for architecture C (off-request-path processing) implemented as Worker-dispatch + GitHub Actions +
Worker-mediated R2 transfer, because:

- it costs **$0** at café volume on every component, with the only real limit (GitHub minutes) two orders of
  magnitude above expected use;
- it closes the gap Stage 3G identified: real decoding rejects the truncated JPEG that header checks and SIP both
  let through, and re-encoding provably removes EXIF, ICC and GPS;
- the trust model can be strict without any credential on the runner: OIDC with a deployment-specific audience,
  an immutable `repository_id`, a pinned `workflow_ref`, `event_name = workflow_dispatch`, and a `run_id` that
  GitHub itself ties back to the dispatch;
- Workers Free limits are respected: the Worker only streams bytes and updates rows, so the 10 ms CPU budget and
  128 MB memory limit are not engaged.

**It is conditional on all of the following.** Any one missing turns this into a NO-GO, because the fallback is a
design that looks secure and is not:

1. **A GitHub repository exists** and `main` is protected. Without a repo there is nothing to dispatch to, and
   without protection S12 is unbounded.
2. **OIDC is verified in the Worker**, not delegated to a "secret URL" or a job id. Algorithm pinned to RS256,
   JWKS from GitHub, `aud` = this deployment's origin, and the claim allowlist of §4.3.
3. **`run_id` is reconciled against GitHub's API** and bound once (§4.4, §4.5). A job id alone must never
   authorise anything.
4. **No R2 credential leaves the Worker** (§5.4). No presigned URLs in workflow inputs.
5. **No secret is ever a workflow input**, and the workflow uses no `secrets:` at all.
6. **The public route serves only verified keys**, with `/staging/` refused and pending states unreachable.
7. **sharp is pinned exactly**, installed by `npm ci`, with `failOn: 'warning'`, `limitInputPixels` at 16 MP, a
   1024 px output and a 512 KB Worker-enforced cap.
8. **Today's upload validation and owner authentication are unchanged.** The processor is additive; it never
   replaces the 1 MB / 4096 px / 16 MP / CSRF checks.
9. **A reaper exists** for leases and 24 h expiry, and the owner sees `rejected`/`failed` with a retry.
10. **Exhaustion is a designed state**, not an incident: no payment method (or a stop-usage budget), and
    "no run started" must degrade to a visible failure, never a stuck spinner.

**NO-GO if** the intent is to call this a queue with delivery guarantees, to skip the OIDC work and trust a job
id, to put bucket credentials on the runner for convenience, or to gate the guest menu on processing completing.

---

## 14. Limitations of this audit and boundaries respected

**Limitations**

- **The GitHub account plan and remaining allowance were not read.** No `gh`, no token, no remote, and creating
  credentials is out of scope. §2.2–2.3 are GitHub's documented figures, not this account's.
- **No workflow was executed on GitHub.** §8.1 latency and §8.2 minutes per image are derived from component
  behaviour and documented runner characteristics, not measured on `ubuntu-latest`.
- **§7 numbers are desktop numbers** (Windows 11, Node 26.13.1, sharp 0.35.5 / libvips 8.18.7). They are used
  for accept/reject behaviour, metadata and output sizing — all machine-independent — and only to bound latency,
  not to claim a CI benchmark. A Linux runner will differ, most likely favourably.
- **Fixtures are synthetic** (noise/gradient), matching Stage 3G so the two reports are comparable; real café
  photos differ in entropy by tens of percent.
- **Progressive and CMYK JPEG, animated WebP and AVIF** were not exercised. `animated: false` and the Worker's
  format allowlist are the controls; a progressive JPEG from a phone is untested.
- **The design has not been implemented or reviewed as code.** No OIDC verifier, job table or workflow exists;
  §4 and §6 are a specification.
- The in-Worker CPU cost of streaming (a few ms) was not measured; it is bounded by I/O, not computation, and is
  far below the 10 ms budget only if the Worker does not buffer the whole object.

**Boundaries respected**

- Read-only investigation of Corner Cup: no source, test, config, schema, binding or dependency was changed.
- The only file added to the repository is this report.
- No dependency was installed in the project. The `sharp` used for measurement is the one miniflare already
  brings; the PoC lives at `%TEMP%\stage3h-poc` outside the tree.
- No GitHub App, token, secret, webhook or repository was created.
- No R2 bucket, no Cloudflare binding, variable, secret, migration or cron change.
- No production or staging access; no deployment, publication, commit or push.
- All existing modified and untracked files were preserved exactly as they were: 156 entries before this
  audit, the same 156 plus this report afterwards.
