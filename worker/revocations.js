// F-07 phase 2B. Durable, bounded, best-effort provider-session revocation.
//
// Local revocation never waits for the provider: the job is written in the same D1 batch as the
// `owner_sessions` delete, so a crash cannot leave a session invalidated locally with no record of
// the provider session that still needs ending.
//
// Delivery is at-least-once, not guaranteed. There is no cron here; jobs are drained opportunistically
// on later sign-out and sign-in traffic. A job that exhausts five attempts or outlives 24 hours is
// dropped, which means the provider session may remain until it expires. Nothing in the UI claims
// otherwise.
import { revokeSession } from "./workos.js";

export const REVOCATION_TTL_MS = 24 * 60 * 60 * 1000;
export const REVOCATION_MAX_ATTEMPTS = 5;
const LEASE_MS = 15000;
const DRAIN_LIMIT = 3;

// The queue insert used inside a larger batch. `excludeSessionId` and `excludeProviderSid` protect the
// session that survives the operation: excluding the local row is not enough when two local rows
// share one provider session, because revoking that provider session would sign the survivor out too.
export function queueProviderRevocationsStatement(
  env,
  { cafeId, now = Date.now(), excludeSessionId = null, excludeProviderSid = null }
) {
  return env.DB.prepare(
    "INSERT INTO provider_revocations " +
      "(workos_session_id, cafe_id, created, attempts, next_attempt, lease_until, lease_owner, expires, last_error) " +
      "SELECT DISTINCT workos_session_id, ?, ?, 0, ?, NULL, NULL, ?, '' FROM owner_sessions " +
      "WHERE cafe_id = ? AND workos_session_id IS NOT NULL " +
      "AND (? IS NULL OR session_id <> ?) AND (? IS NULL OR workos_session_id <> ?) " +
      "ON CONFLICT(workos_session_id) DO NOTHING"
  ).bind(
    cafeId,
    now,
    now,
    now + REVOCATION_TTL_MS,
    cafeId,
    excludeSessionId,
    excludeSessionId,
    excludeProviderSid,
    excludeProviderSid
  );
}

// Single-statement variant for callers that are not already in a batch.
export async function queueProviderRevocation(env, options) {
  try {
    await queueProviderRevocationsStatement(env, options).run();
  } catch (err) {
    console.error("Provider revocation queueing failed", {
      cafeId: options && options.cafeId,
      error: err && err.message ? err.message : String(err),
    });
  }
}

// Removes expired jobs and jobs that have used up their attempts. Bounded, best-effort.
export async function pruneProviderRevocations(env, now = Date.now()) {
  try {
    await env.DB.prepare(
      "DELETE FROM provider_revocations WHERE expires <= ? OR attempts >= ?"
    )
      .bind(now, REVOCATION_MAX_ATTEMPTS)
      .run();
  } catch (err) {
    console.error("Provider revocation cleanup failed", {
      error: err && err.message ? err.message : String(err),
    });
  }
}

// Leases one due job. The conditional UPDATE is the whole concurrency control: only one caller can
// move `lease_until` into the future, so two workers never revoke the same session at once.
async function claimJob(env, owner, now) {
  const row = await env.DB.prepare(
    "UPDATE provider_revocations SET lease_owner = ?, lease_until = ?, attempts = attempts + 1 " +
      "WHERE workos_session_id = (SELECT workos_session_id FROM provider_revocations " +
      "WHERE expires > ? AND next_attempt <= ? AND attempts < ? " +
      "AND (lease_until IS NULL OR lease_until <= ?) " +
      "ORDER BY next_attempt LIMIT 1) RETURNING workos_session_id, attempts"
  )
    .bind(owner, now + LEASE_MS, now, now, REVOCATION_MAX_ATTEMPTS, now)
    .first();
  return row ? { sessionId: row.workos_session_id, attempts: Number(row.attempts) } : null;
}

function backoffMs(attempts) {
  return Math.min(60_000, 2 ** Math.max(0, attempts) * 1000);
}

// Drains a few jobs. Never throws: a provider outage must not fail the request that happened to
// trigger the drain.
export async function drainProviderRevocations(env, { limit = DRAIN_LIMIT } = {}) {
  const owner = crypto.randomUUID();
  let revoked = 0;
  let failed = 0;

  // Housekeeping first, so a job that has used its five attempts or outlived its 24 hours leaves the
  // table instead of waiting for a later drain to notice it.
  await pruneProviderRevocations(env);

  for (let i = 0; i < limit; i += 1) {
    const now = Date.now();
    let job;
    try {
      job = await claimJob(env, owner, now);
    } catch (err) {
      console.error("Provider revocation claim failed", {
        error: err && err.message ? err.message : String(err),
      });
      break;
    }
    if (!job) break;

    let result;
    try {
      result = await revokeSession(env, job.sessionId);
    } catch {
      result = { ok: false, status: 0 };
    }

    try {
      if (result.ok) {
        await env.DB.prepare(
          "DELETE FROM provider_revocations WHERE workos_session_id = ? AND lease_owner = ?"
        )
          .bind(job.sessionId, owner)
          .run();
        revoked += 1;
      } else {
        await env.DB.prepare(
          "UPDATE provider_revocations SET lease_until = NULL, lease_owner = NULL, next_attempt = ?, last_error = ? " +
            "WHERE workos_session_id = ? AND lease_owner = ?"
        )
          .bind(now + backoffMs(job.attempts), `status:${result.status}`, job.sessionId, owner)
          .run();
        failed += 1;
      }
    } catch (err) {
      console.error("Provider revocation settle failed", {
        error: err && err.message ? err.message : String(err),
      });
      break;
    }
  }

  return { revoked, failed };
}
