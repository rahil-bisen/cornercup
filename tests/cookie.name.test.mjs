import test from "node:test";
import assert from "node:assert/strict";

import { cookieName } from "../worker/api.js";

const PREFIX = "staff_session_";

test("F-11: valid slugs of every length 0..40 keep their exact cookie name", () => {
  for (let len = 0; len <= 40; len++) {
    const slug = "a".repeat(len);
    const cafe = { slug };
    const expected = `${PREFIX}${slug}`;
    // Byte-for-byte unchanged vs. the previous truncated form, since len <= 40 < 46.
    const previous = `${PREFIX}${slug}`.slice(0, 60);
    assert.equal(cookieName(cafe), expected, `length ${len}`);
    assert.equal(cookieName(cafe), previous, `unchanged at length ${len}`);
  }
});

test("F-11: distinct valid slugs produce distinct cookie names", () => {
  const slugs = [];
  for (let len = 1; len <= 40; len++) {
    slugs.push("a".repeat(len));
    slugs.push(("b" + "a".repeat(len - 1)).slice(0, len));
  }
  // Add some varied slugs at the 40-char boundary.
  slugs.push("corner-cup-cafe");
  slugs.push("corner-cup-cafe-2");
  slugs.push("x".repeat(40));

  const names = new Set(slugs.map((s) => cookieName({ slug: s })));
  assert.equal(names.size, slugs.length, "every distinct slug must map to a distinct cookie name");
  // Each name must still be the untruncated form.
  for (const s of slugs) {
    assert.equal(cookieName({ slug: s }), `${PREFIX}${s}`);
  }
});

test("F-11: two slugs sharing a 46-character prefix no longer collide", () => {
  const prefix = "a".repeat(46);
  const slug1 = prefix + "x";
  const slug2 = prefix + "y";
  const name1 = cookieName({ slug: slug1 });
  const name2 = cookieName({ slug: slug2 });
  assert.notEqual(name1, name2, "long slugs differing only in the last character must not share a cookie name");
  assert.equal(name1, `${PREFIX}${slug1}`, "first slug must be preserved in full");
  assert.equal(name2, `${PREFIX}${slug2}`, "second slug must be preserved in full");
  // Sanity: the old truncated form would have collided.
  assert.equal(`${PREFIX}${slug1}`.slice(0, 60), `${PREFIX}${slug2}`.slice(0, 60));
});

test("F-11: the maximum valid 40-character slug keeps its previous cookie name", () => {
  const slug = "z".repeat(40);
  const cafe = { slug };
  const current = cookieName(cafe);
  const previous = `${PREFIX}${slug}`.slice(0, 60);
  assert.equal(current, previous);
  assert.equal(current, `${PREFIX}${slug}`);
  assert.equal(current.length, PREFIX.length + 40);
});
