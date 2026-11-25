// Fixture passwords for the disposable harness database, defined once so the Worker and the tests
// cannot drift apart. Nothing here is a real credential: the harness only ever runs locally.

// The password every seeded café is created with, stored as its own PBKDF2 hash by /seed.
export const HARNESS_OWNER_PASSWORD = "harness-owner-password";

// Must match OWNER_PASSWORD in tests/harness/wrangler.auth.jsonc. It is the secret the primary café's
// hash is bootstrapped from on first boot, so the tests can prove the upgrade path keeps working.
export const HARNESS_BOOTSTRAP_PASSWORD = "harness-bootstrap-password";
