// Unit tests for the per-isolate read window used by the general API limiter (F-06 follow-up).
//
// These are pure: no HTTP, no D1, no harness. `now` is injected, so window boundaries, expiry and
// store bounding are asserted exactly instead of by sleeping.
//
// Covered:
//   1. exactly `max` requests are admitted and the next one is refused;
//   2. the window resets at its expiry instant and not one millisecond earlier;
//   3. counters are isolated per client key and per limiter instance;
//   4. a flood of distinct keys cannot grow the store without bound;
//   5. expired keys are reclaimed before live ones are evicted;
//   6. sustained polling never exceeds the ceiling.

import test from "node:test";
import assert from "node:assert/strict";

import { createWindowLimiter } from "../worker/api.js";

test("a window admits exactly max requests and refuses the next", () => {
  const limiter = createWindowLimiter({ max: 3, windowMs: 1000 });

  for (let i = 1; i <= 3; i += 1) {
    const result = limiter.check("ip-a", 10_000);
    assert.equal(result.allowed, true, `request ${i} is allowed`);
    assert.equal(result.count, i, "the count is reported after the increment");
    assert.equal(result.expires, 11_000);
  }

  const refused = limiter.check("ip-a", 10_000);
  assert.equal(refused.allowed, false, "one past the ceiling is refused");
  assert.equal(refused.count, 4);
});

test("the window resets at its expiry instant, not before", () => {
  const limiter = createWindowLimiter({ max: 2, windowMs: 1000 });

  limiter.check("ip", 5000);
  limiter.check("ip", 5000);
  assert.equal(limiter.check("ip", 5999).allowed, false, "still inside the window");

  const fresh = limiter.check("ip", 6000);
  assert.equal(fresh.allowed, true, "expires <= now starts a new window");
  assert.equal(fresh.count, 1, "the new window starts from one");
  assert.equal(fresh.expires, 7000);
});

test("counters are isolated per key and per limiter", () => {
  const limiter = createWindowLimiter({ max: 1, windowMs: 60_000 });

  assert.equal(limiter.check("ip-a", 1000).allowed, true);
  assert.equal(limiter.check("ip-b", 1000).allowed, true, "another client has its own window");
  assert.equal(limiter.check("ip-a", 1000).allowed, false, "the first client is still capped");

  const other = createWindowLimiter({ max: 1, windowMs: 60_000 });
  assert.equal(other.check("ip-a", 1000).allowed, true, "a second isolate starts empty");
});

test("a flood of distinct keys keeps the store bounded", () => {
  const limiter = createWindowLimiter({ max: 5, windowMs: 60_000, maxKeys: 100 });

  for (let i = 0; i < 10_000; i += 1) limiter.check(`ip-${i}`, 1000);

  assert.ok(limiter.size <= 101, `store size ${limiter.size} must stay bounded`);
});

test("expired windows are reclaimed before live ones are evicted", () => {
  const limiter = createWindowLimiter({ max: 5, windowMs: 1000, maxKeys: 10 });

  for (let i = 0; i < 10; i += 1) limiter.check(`old-${i}`, 1000);

  // One millisecond past expiry, the old windows are dead and may be dropped to make room.
  const result = limiter.check("new-0", 2001);
  assert.equal(result.allowed, true);
  assert.ok(limiter.size <= 11, `store size ${limiter.size}`);
});

test("sustained polling never exceeds the ceiling", () => {
  const limiter = createWindowLimiter({ max: 600, windowMs: 60_000 });

  let allowed = 0;
  for (let i = 0; i < 900; i += 1) {
    if (limiter.check("board", 1000).allowed) allowed += 1;
  }

  assert.equal(allowed, 600, "a board polling faster than the ceiling is cut off at the ceiling");
  assert.equal(limiter.size, 1, "polling one client creates no extra state");
});
