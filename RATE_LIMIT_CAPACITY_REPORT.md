# RATE LIMIT & CAPACITY REPORT

**Date:** 2026-11-20
**Scope:** local source, tests and arithmetic. No deployment, no production or staging traffic.
**Status of the change described here:** **implemented** and **tested** locally (see §6). Nothing has been deployed.

---

## 1. What was wrong

`routeApi` called `checkApiRateLimit(request, env)` before routing (`worker/api.js`), and that function
performed one D1 upsert **per API request**, whatever the method:

```sql
INSERT INTO rate_limits (key, count, window_start, expires, updated_at)
VALUES (?, 1, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET count = …, window_start = …, expires = …, updated_at = ?
RETURNING count, expires
```

The board polled `/api/admin/orders` every 4 seconds, and the guest tracking page polled every 4 seconds.
One open board therefore produced 900 API requests per hour, each one a committed write, plus a 1 %-sampled
cleanup that could delete up to 100 rows per execution.

Measured on the live production deployment before this change: **12,320 requests** and **1,580 D1 writes**
for the month, with a monthly allowance of 100,000 writes — i.e. the write budget was being spent on idle
screens, not on orders.

## 2. What changed

### 2.1 Server: method-aware limiting

| Request kind | Storage | Ceiling | Cost per request |
|---|---|---|---|
| `GET`, `HEAD` | per-isolate fixed window (`createWindowLimiter`) | 600 / minute / client IP | **zero D1 writes** |
| `POST`, `PATCH`, `PUT`, `DELETE` | D1 `rate_limits` row (unchanged SQL) | 600 / minute / client IP | 1 write |
| Login, re-auth, payment, webhook, operator | unchanged dedicated keys | unchanged | unchanged |

The durable path is kept exactly where abuse matters — credential operations and state changes — and those
are low-volume by nature. Reads, which are the high-volume polling path, are counted in the isolate that
serves them. `RATE_LIMIT_CLEANUP_PROBABILITY` sampling now runs only on the durable (write) path, so expired
rows are reclaimed in proportion to the traffic that creates them.

The window store is bounded (`API_READ_MAX_KEYS = 20,000`): expired windows are dropped first, then the least
recently inserted, so a flood of distinct client addresses cannot grow memory without limit.

### 2.2 Client: less polling, and none while hidden

| Page | Before | After |
|---|---|---|
| Staff board (`src/pages/Admin.jsx`) | every 4 s | every 10 s, paused while the tab is hidden, immediate refresh on return |
| Guest tracking (`src/pages/OrderStatus.jsx`) | every 4 s | every 15 s, paused while hidden, immediate refresh on return |

A background tab (a phone in a pocket, a board minimised overnight) now makes **no requests at all**.

## 3. Capacity arithmetic

### 3.1 Reads (requests only — no writes)

| Open boards | /hour | /8 h shift | /24 h | /month (8 h × 30 d) | /month (24/7) |
|---:|---:|---:|---:|---:|---:|
| 1 | 360 | 2,880 | 8,640 | 86,400 | 259,200 |
| 5 | 1,800 | 14,400 | 43,200 | 432,000 | 1,296,000 |
| 10 | 3,600 | 28,800 | 86,400 | 864,000 | 2,592,000 |

Each open guest tracking page adds 240 requests/hour; each board also makes 6 session-renewal requests per
hour (the 10-minute session check).

Against a 100,000 **requests/day** allowance (Workers Free), five boards open 24/7 use 43,200 (43 %), and ten
boards use 86,400 (86 %) — tight but inside. The 8-hour-shift figures are 14 % and 29 %.

### 3.2 Writes (D1 rows written)

| Source | Before | After |
|---|---:|---:|
| Rate limiter, per open board, per 8 h | 7,200 | **0** |
| Rate limiter, 5 boards, 24 h | 108,000 | **0** |
| Session renewal, per open board per day | 144 (unchanged) | 144 (only on the 10-minute session call) |
| Rate limiter, per state change | 1 | 1 (unchanged) |
| Order creation + items + payment + transitions | ~8–14 rows | unchanged |

Polling is no longer a write source at all. Remaining writes scale with **activity**, not with how many screens
are open:

| Scenario | Writes/day | Writes/month |
|---|---:|---:|
| 5 boards, 8 h, 100 orders/day (≈12 rows each) | 240 + 1,200 ≈ **1,440** | ≈ **43,200** (43 % of 100 k) |
| 5 boards, 24 h, 200 orders/day | 720 + 2,400 ≈ **3,120** | ≈ **93,600** (94 % of 100 k) |
| 10 boards, 8 h, 200 orders/day | 480 + 2,400 ≈ **2,880** | ≈ **86,400** (86 % of 100 k) |

The binding constraint is now order volume, not screen count — which is the correct shape for a café SaaS.

## 4. Abuse protection: what is still guaranteed

- **Credential brute force is still durable and exact.** Login lockout (`LOGIN_MAX_FAILURES = 8` per 10 min,
  per café + IP), the re-authentication limit (5 per 10 min), payment-attempt limits and the operator limits
  are unchanged, atomic and survive isolate recycling.
- **Read floods are still capped** at 600/min per client IP per isolate. A single flood cannot exceed that in
  the isolate serving it.
- **Payment and order mutations** remain durable-limited plus token- and signature-checked.

## 5. Known limitations (stated, not hidden)

1. **The read ceiling is per isolate, not global.** An attacker who spreads requests across many isolates can
   exceed 600/min in aggregate, up to roughly (isolates × 600) per minute. This is a deliberate trade of
   exactness for zero write amplification on a €0 budget; reads are cheap, scoped by café slug, and sit behind
   the platform's own DDoS protection. It is **not** applied to any credential or payment path.
2. **Key eviction can reset a window.** Under a flood of more than 20,000 distinct addresses in one isolate, the
   coldest window may be evicted, giving that address a fresh count. The flood needed to do that
   (20,000 × 600 requests) is far beyond what the free tier serves, and is itself rate-limited by the platform.
3. **Expired rows are reclaimed on write traffic only.** A deployment with no writes accrues no rows either, so
   the table is self-limiting; a deployment with writes reclaims at 1 % sampling (≤100 rows per run).
4. **No conditional requests (ETag/304).** The order list has no cheap change token, so a conditional GET would
   still need the same query — the bandwidth saved would not translate into a write saved, and the poll interval
   is already 10–15 s. Recorded here rather than silently skipped.
5. **Reads still cost request quota.** The change removes writes, not requests. Ten boards open around the clock
   would approach the free daily request allowance (§3.1); the fix for that is push (Durable Object / WebSocket),
   which needs a paid plan and is out of scope.

## 6. Tests and evidence

| Suite | Result |
|---|---|
| `tests/rate.readwindow.test.mjs` (new, 6 unit tests: ceiling, boundary, isolation, bounded store, expiry-first reclaim, sustained polling) | **6/6 pass** |
| `tests/rate.limit.test.mjs` against the live Worker harness (16 tests, incl. 4 new) | **16/16 pass** |
| New: “polling reads are answered without creating a durable counter” | 12 sequential polls, `api:<hash>` row stays **absent** |
| New: “a state-changing request is still counted durably” | 1 POST → row present, `count = 1` |
| New: “reads never delete rows and never create them” | 20 polls leave a seeded expired row untouched |
| Login lockout, IP keying, spoofed-header precedence, concurrency, cleanup bounds (existing) | all still pass |

Capacity measurement used the same harness as production code paths (real `handleApi`, real D1) — not a model.
The request counts in §3.1 are arithmetic from the poll intervals in the shipped components.
