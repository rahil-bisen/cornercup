// The schema-version marker guard.
//
// Once a database has recorded SCHEMA_VERSION in app_schema_state, the Worker skips every migration on
// a cold start while the recorded version equals the code's. So a change to SCHEMA, MIGRATIONS or
// POST_MIGRATIONS that forgets to bump SCHEMA_VERSION would silently never run on a database that
// already has the marker — the live one included. This test makes that mistake impossible to merge.
//
// When it fails because the schema lists changed:
//   1. bump SCHEMA_VERSION in worker/db.js by one;
//   2. add that version to tests/fixtures/schema-versions.json with the fingerprint this test prints.
// Earlier entries stay as they are: they are the record of what each version contained.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { SCHEMA, MIGRATIONS, POST_MIGRATIONS, SCHEMA_VERSION } from "../worker/db.js";

const recorded = JSON.parse(readFileSync(new URL("./fixtures/schema-versions.json", import.meta.url), "utf8"));
const fingerprint = createHash("sha256")
  .update(JSON.stringify({ schema: SCHEMA, migrations: MIGRATIONS, post: POST_MIGRATIONS }))
  .digest("hex");

test("the schema lists match what SCHEMA_VERSION recorded", () => {
  assert.ok(
    recorded[String(SCHEMA_VERSION)],
    `SCHEMA_VERSION ${SCHEMA_VERSION} has no entry in tests/fixtures/schema-versions.json; add "${SCHEMA_VERSION}": "${fingerprint}"`
  );
  assert.equal(
    fingerprint,
    recorded[String(SCHEMA_VERSION)],
    `SCHEMA, MIGRATIONS or POST_MIGRATIONS changed but SCHEMA_VERSION is still ${SCHEMA_VERSION}. ` +
      `Bump it to ${SCHEMA_VERSION + 1} and record "${SCHEMA_VERSION + 1}": "${fingerprint}" in tests/fixtures/schema-versions.json, ` +
      "or the change will never run on a database that already has the marker."
  );
});

test("versions only move forward, and no two versions record the same schema", () => {
  const versions = Object.keys(recorded).filter((key) => /^\d+$/.test(key)).map(Number).sort((a, b) => a - b);
  assert.equal(versions[versions.length - 1], SCHEMA_VERSION, "SCHEMA_VERSION is the newest recorded version");
  assert.deepEqual(versions, Array.from({ length: versions.length }, (_, i) => versions[0] + i), "no version was skipped");
  const prints = versions.map((v) => recorded[String(v)]);
  assert.equal(new Set(prints).size, prints.length, "a bump with no schema change would hide which version changed what");
});
