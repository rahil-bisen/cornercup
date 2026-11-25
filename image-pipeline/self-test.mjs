// Local proof that the normaliser does what it claims, without a repository, a workflow run or a
// deployed Worker: sharp generates real images in memory, and the same code path the Actions job runs
// is exercised against them.

import assert from "node:assert/strict";
import sharp from "sharp";
import { LIMITS, ImageRejected, normalise } from "./process.mjs";

let passed = 0;
async function check(name, work) {
  await work();
  passed += 1;
  console.log(`ok ${passed} - ${name}`);
}

async function bigJpeg(width = 3000, height = 2000) {
  return sharp({
    create: { width, height, channels: 3, background: { r: 180, g: 90, b: 40 } },
  })
    .jpeg({ quality: 96 })
    .toBuffer();
}

await check("a large photo is downscaled and re-encoded as WebP", async () => {
  const result = await normalise(await bigJpeg());
  assert.equal(result.contentType, "image/webp");
  assert.ok(result.width <= LIMITS.maxEdge && result.height <= LIMITS.maxEdge);
  assert.ok(result.bytes <= LIMITS.maxOutputBytes);
  assert.equal(result.sourceFormat, "jpeg");
});

await check("output metadata is dropped", async () => {
  const result = await normalise(await bigJpeg());
  const meta = await sharp(result.buffer).metadata();
  assert.equal(meta.format, "webp");
  assert.equal(meta.exif, undefined, "no EXIF survives, so no GPS does either");
  assert.equal(meta.icc, undefined);
});

await check("a small image is not enlarged", async () => {
  const small = await sharp({
    create: { width: 120, height: 80, channels: 3, background: { r: 10, g: 10, b: 10 } },
  })
    .png()
    .toBuffer();
  const result = await normalise(small);
  assert.equal(result.width, 120);
  assert.equal(result.height, 80);
});

await check("a non-image is refused before any re-encode", async () => {
  await assert.rejects(() => normalise(Buffer.from("<html>not a photo</html>")), ImageRejected);
  await assert.rejects(() => normalise(Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x00])), ImageRejected);
  await assert.rejects(() => normalise(Buffer.alloc(0)), ImageRejected);
});

await check("an oversized file is refused on size alone", async () => {
  const oversized = Buffer.alloc(LIMITS.maxInputBytes + 1, 0x41);
  await assert.rejects(() => normalise(oversized), /larger than 12 MB/);
});

await check("the byte budget really binds", async () => {
  const photo = await bigJpeg(2400, 1600);
  const tight = await normalise(photo, { maxEdge: 1600, maxOutputBytes: 24 * 1024 });
  assert.ok(tight.bytes <= 24 * 1024);
});

await check("a pixel bomb is refused rather than decoded", async () => {
  // A legitimate small PNG whose declared dimensions are far beyond the pixel cap.
  const bomb = await sharp({
    create: { width: 200, height: 200, channels: 3, background: { r: 1, g: 2, b: 3 } },
  })
    .png()
    .toBuffer();
  const original = LIMITS.maxPixels;
  LIMITS.maxPixels = 1000;
  try {
    await assert.rejects(() => normalise(bomb), ImageRejected);
  } finally {
    LIMITS.maxPixels = original;
  }
});

console.log(`\n${passed} checks passed`);
