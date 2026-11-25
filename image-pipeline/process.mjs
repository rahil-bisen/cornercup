// Owner photo normaliser.
//
// The Worker cannot re-encode an image on a Free-plan CPU budget, so this is the piece that does it,
// outside the request path: decode with sharp, downscale, strip metadata (including EXIF location),
// and re-encode to WebP at a bounded size. A file that decodes to something absurd is refused before
// it can be decoded twice.
//
// Security properties, all enforced here:
//   * the input must decode as an image (magic bytes alone are not evidence, which is why the Worker
//     only ever stores the bytes and this step decides what they are);
//   * pixel budget and dimensions are capped before any resize, so a decompression bomb fails fast;
//   * output metadata is dropped, so GPS/EXIF from a phone camera is never published;
//   * output is always WebP, always bounded in bytes, and never larger than the configured edge;
//   * failures are reported, never silently published: the caller only uploads `--out` on exit 0.

import sharp from "sharp";

export const LIMITS = {
  maxInputBytes: 12 * 1024 * 1024,
  maxPixels: 40 * 1000 * 1000,
  maxEdge: 1600,
  maxOutputBytes: 400 * 1024,
  qualities: [82, 74, 66, 58, 50],
};

export class ImageRejected extends Error {
  constructor(reason) {
    super(reason);
    this.name = "ImageRejected";
  }
}

// One decode, one resize, one encode per quality until the byte budget is met. sharp keeps the raw
// decode in memory, so the loop re-encodes from the cached pipeline rather than re-reading the file.
export async function normalise(input, { maxEdge = LIMITS.maxEdge, maxOutputBytes = LIMITS.maxOutputBytes } = {}) {
  const source = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (!source.length) throw new ImageRejected("empty file");
  if (source.length > LIMITS.maxInputBytes) throw new ImageRejected("file is larger than 12 MB");

  let meta;
  try {
    meta = await sharp(source, { limitInputPixels: LIMITS.maxPixels, failOn: "error" }).metadata();
  } catch (err) {
    throw new ImageRejected(`not a decodable image (${err && err.message ? err.message : "unknown"})`);
  }
  if (!meta || !meta.format || !meta.width || !meta.height) throw new ImageRejected("no image dimensions");
  if (!["jpeg", "png", "webp", "avif", "gif", "tiff"].includes(meta.format)) {
    throw new ImageRejected(`unsupported format ${meta.format}`);
  }
  if (meta.width * meta.height > LIMITS.maxPixels) throw new ImageRejected("image has too many pixels");

  // `withoutEnlargement` keeps a small photo small; rotation follows the EXIF orientation before the
  // metadata is dropped, so a portrait photo is not published sideways.
  const pipeline = sharp(source, { limitInputPixels: LIMITS.maxPixels, failOn: "error" })
    .rotate()
    .resize({ width: maxEdge, height: maxEdge, fit: "inside", withoutEnlargement: true });

  let last;
  for (const quality of LIMITS.qualities) {
    const buffer = await pipeline.clone().webp({ quality, effort: 4 }).toBuffer();
    last = buffer;
    if (buffer.length <= maxOutputBytes) {
      const out = await sharp(buffer).metadata();
      return {
        buffer,
        contentType: "image/webp",
        width: out.width,
        height: out.height,
        bytes: buffer.length,
        quality,
        sourceFormat: meta.format,
        sourceWidth: meta.width,
        sourceHeight: meta.height,
      };
    }
  }
  throw new ImageRejected(`could not fit the image in ${maxOutputBytes} bytes (best ${last.length})`);
}

/* ------------------------------------------------------------------ CLI */

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? null : process.argv[index + 1] || null;
}

if (process.argv[1] && process.argv[1].endsWith("process.mjs")) {
  const { readFile, writeFile, rename } = await import("node:fs/promises");
  const input = arg("in");
  const output = arg("out");
  if (!input || !output) {
    console.error("usage: node process.mjs --in <file> --out <file.webp> [--max-edge 1600]");
    process.exit(2);
  }
  try {
    const raw = await readFile(input);
    const edge = Number(arg("max-edge")) || LIMITS.maxEdge;
    const result = await normalise(raw, { maxEdge: edge });
    // Write then rename so a crash cannot leave a half-written image where the uploader will find it.
    const temporary = `${output}.tmp`;
    await writeFile(temporary, result.buffer);
    await rename(temporary, output);
    console.log(
      JSON.stringify({
        ok: true,
        output,
        contentType: result.contentType,
        width: result.width,
        height: result.height,
        bytes: result.bytes,
        quality: result.quality,
        sourceFormat: result.sourceFormat,
      })
    );
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err && err.message ? err.message : String(err) }));
    process.exit(1);
  }
}
