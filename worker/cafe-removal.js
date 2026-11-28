// Removing a café from the operator console, in two steps. Archiving hides it and stops every
// sign-in while keeping its data; only an archived café may then be deleted for good. Every
// statement here is static SQL with positional binds, and each step is one D1 batch (one
// transaction), so a failure leaves the café exactly as it was.
//
// The primary café (the oldest row, which the bare domain opens) can never be archived or deleted:
// the guard is part of each write, not only a check before it.

const PRIMARY_GUARD = "id <> (SELECT MIN(id) FROM cafes)";

// Rate-limit keys that carry a café id, always as `<prefix>:<cafeId>:...`. A delete removes only the
// rows under these exact prefixes, matched with substr rather than LIKE so no wildcard in a key can
// widen the match, and the trailing colon keeps café 5 from matching café 55.
export const CAFE_RATE_LIMIT_PREFIXES = [
  "login",
  "settings",
  "totp",
  "pay:razorpay",
  "payclaim:razorpay",
  "ownerstart",
  "ownerclaim",
];

export function rateLimitPrefixes(cafeId) {
  return CAFE_RATE_LIMIT_PREFIXES.map((prefix) => `${prefix}:${Number(cafeId)}:`);
}

// Archive: stamp archived_at, bump auth_version (every owner token fails closed at once), end the
// café's sessions and their CSRF tokens, and write the audit row only if the archive landed.
// `csrfKeyHashes` are sha256(sessionId) for the sessions read just before this batch.
export function archiveStatements(env, { cafeId, now, subject, detail, csrfKeyHashes = [] }) {
  const statements = [
    env.DB.prepare(
      "UPDATE cafes SET archived_at = ?, auth_version = auth_version + 1 " +
        `WHERE id = ? AND archived_at IS NULL AND ${PRIMARY_GUARD}`
    ).bind(now, cafeId),
    env.DB.prepare(
      "INSERT INTO operator_audit (cafe_id, action, subject, detail, created) " +
        "SELECT id, 'archive_cafe', ?, ?, ? FROM cafes WHERE id = ? AND archived_at = ?"
    ).bind(subject, detail, now, cafeId, now),
  ];
  for (const hash of csrfKeyHashes) {
    statements.push(env.DB.prepare("DELETE FROM csrf_tokens WHERE operator_key_hash = ?").bind(hash));
  }
  statements.push(
    env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ? AND EXISTS (SELECT 1 FROM cafes WHERE id = ? AND archived_at IS NOT NULL)")
      .bind(cafeId, cafeId),
    env.DB.prepare("DELETE FROM owner_totp_challenges WHERE cafe_id = ? AND EXISTS (SELECT 1 FROM cafes WHERE id = ? AND archived_at IS NOT NULL)")
      .bind(cafeId, cafeId),
    env.DB.prepare("DELETE FROM owner_login_states WHERE cafe_id = ? AND EXISTS (SELECT 1 FROM cafes WHERE id = ? AND archived_at IS NOT NULL)")
      .bind(cafeId, cafeId)
  );
  return statements;
}

export function restoreStatements(env, { cafeId, now, subject, detail }) {
  return [
    // Aborts the batch unless the café is archived right now, so the audit row below can only exist
    // for a restore that actually happened.
    env.DB.prepare(
      "INSERT INTO tx_guard (ok) SELECT 0 WHERE NOT EXISTS (SELECT 1 FROM cafes WHERE id = ? AND archived_at IS NOT NULL)"
    ).bind(cafeId),
    env.DB.prepare("UPDATE cafes SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL").bind(cafeId),
    env.DB.prepare(
      "INSERT INTO operator_audit (cafe_id, action, subject, detail, created) VALUES (?, 'restore_cafe', ?, ?, ?)"
    ).bind(cafeId, subject, detail, now),
  ];
}

// Permanent delete. The first statement aborts the whole batch (tx_guard's CHECK) unless the café
// is archived and is not the primary one, so no later delete can run against an active café. The
// audit row is written inside the same transaction; it keeps the café id, slug and name so the
// record outlives the row it describes. Logs (operator_audit, password_resets, auth_events,
// auth_mode_transitions) are kept on purpose.
export function deleteStatements(env, { cafeId, now, subject, detail, csrfKeyHashes = [] }) {
  const id = Number(cafeId);
  const statements = [
    env.DB.prepare(
      "INSERT INTO tx_guard (ok) SELECT 0 WHERE NOT EXISTS " +
        `(SELECT 1 FROM cafes WHERE id = ? AND archived_at IS NOT NULL AND ${PRIMARY_GUARD})`
    ).bind(id),
    env.DB.prepare("INSERT INTO operator_audit (cafe_id, action, subject, detail, created) VALUES (?, 'delete_cafe', ?, ?, ?)")
      .bind(id, subject, detail, now),
    env.DB.prepare("DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE cafe_id = ?)").bind(id),
    env.DB.prepare("DELETE FROM orders WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM checkout_claims WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM menu_items WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM tables WHERE cafe_id = ?").bind(id),
    // An identity is removed only when this café was its sole membership; a person who also owns
    // another café keeps their identity row.
    env.DB.prepare(
      "DELETE FROM owner_identities WHERE workos_user_id IN (SELECT workos_user_id FROM cafe_owners WHERE cafe_id = ?) " +
        "AND workos_user_id NOT IN (SELECT workos_user_id FROM cafe_owners WHERE cafe_id <> ?)"
    ).bind(id, id),
    env.DB.prepare("DELETE FROM cafe_owners WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM owner_claims WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM owner_login_states WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM owner_totp WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM owner_totp_recovery WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM owner_totp_challenges WHERE cafe_id = ?").bind(id),
    env.DB.prepare("DELETE FROM provider_revocations WHERE cafe_id = ?").bind(id),
  ];
  for (const hash of csrfKeyHashes) {
    statements.push(env.DB.prepare("DELETE FROM csrf_tokens WHERE operator_key_hash = ?").bind(hash));
  }
  statements.push(env.DB.prepare("DELETE FROM owner_sessions WHERE cafe_id = ?").bind(id));
  for (const prefix of rateLimitPrefixes(id)) {
    statements.push(
      env.DB.prepare("DELETE FROM rate_limits WHERE substr(key, 1, ?) = ?").bind(prefix.length, prefix)
    );
  }
  statements.push(env.DB.prepare("DELETE FROM cafes WHERE id = ?").bind(id));
  return statements;
}

export function isRemovalGuardFailure(err) {
  const message = String(err && err.message ? err.message : err);
  return /constraint failed/i.test(message);
}
