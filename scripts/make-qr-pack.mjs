#!/usr/bin/env node
// Builds the printable QR package for the LOCAL PILOT only.
//
//   node scripts/make-qr-pack.mjs
//
// Output: qr-pack/*.png (one per code) and qr-pack/corner-cup-local-pilot-qr-pack.pdf
// (A4, vector QR modules, labelled, with a LOCAL TEST ONLY banner on every page).
//
// The URLs are hard-coded to the pilot Worker (wrangler.pilot.jsonc, 127.0.0.1:8788). They are NOT
// public customer URLs: 127.0.0.1 only resolves on the machine running the pilot. A real café's codes
// must be generated against its eventual public HTTPS domain.

import QRCode from "qrcode";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "qr-pack");
const ORIGIN = "http://127.0.0.1:8788";
const SLUG = "corner-cup-local-pilot";
const CAFE = `${ORIGIN}/c/${SLUG}`;

const entries = [
  {
    file: "counter-menu.png",
    kind: "Counter ordering",
    title: "Counter ordering (no table)",
    subtitle: "Guests order at the counter and collect by pickup number.",
    url: `${CAFE}/menu`,
  },
  ...Array.from({ length: 8 }, (_, index) => {
    const number = index + 1;
    return {
      file: `table-${String(number).padStart(2, "0")}.png`,
      kind: `Table ${number}`,
      title: `Table ${number}`,
      subtitle: `Guests scan this at table ${number}; the order arrives labelled Table ${number}.`,
      url: `${CAFE}/t/${number}`,
    };
  }),
];

/* ------------------------------------------------------------------ PNG output */

await mkdir(OUT, { recursive: true });
for (const entry of entries) {
  await QRCode.toFile(path.join(OUT, entry.file), entry.url, {
    type: "png",
    errorCorrectionLevel: "M",
    margin: 2,
    width: 1024,
    color: { dark: "#000000", light: "#ffffff" },
  });
  console.log(`png  ${path.relative(ROOT, path.join(OUT, entry.file))}`);
}

/* ------------------------------------------------------------------ PDF output */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 40;

function escapePdf(text) {
  return String(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function text(font, size, x, y, value) {
  return `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${escapePdf(value)}) Tj ET\n`;
}

function rect(x, y, w, h) {
  return `q ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q\n`;
}

function wrap(line, width) {
  const words = String(line).split(/\s+/);
  const lines = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > width && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
}

// A QR code drawn as filled vector modules. Crisper than an embedded bitmap at any print size.
function drawQr(content, x, y, size, moduleCount) {
  let out = "0 0 0 rg\n";
  const step = size / moduleCount;
  for (let row = 0; row < moduleCount; row += 1) {
    for (let column = 0; column < moduleCount; column += 1) {
      if (!content[row * moduleCount + column]) continue;
      out += rect(x + column * step, y + size - (row + 1) * step, step, step);
    }
  }
  return out;
}

function pageContent(pageEntries, pageNumber, pageCount) {
  let out = "";

  out += text("F2", 18, MARGIN, PAGE_H - 58, "Corner Cup — Local Pilot QR Pack");
  out += text(
    "F1",
    10,
    MARGIN,
    PAGE_H - 76,
    `Café slug: ${SLUG}   ·   Pilot Worker: ${ORIGIN}   ·   page ${pageNumber} of ${pageCount}`
  );

  // The warning is unmissable and repeated on every page.
  out += "0.85 0.12 0.12 rg\n" + rect(MARGIN, PAGE_H - 110, PAGE_W - MARGIN * 2, 22);
  out += "1 1 1 rg\n" + text("F2", 11, MARGIN + 10, PAGE_H - 104, "LOCAL TEST ONLY — NOT A PUBLIC CUSTOMER URL");

  const blockHeight = 220;
  let top = PAGE_H - 135;

  for (const entry of pageEntries) {
    const qrSize = 150;
    const qrY = top - 40 - qrSize;

    out += "0 0 0 rg\n";
    out += text("F2", 17, MARGIN + 6, top - 10, entry.title);
    out += text("F1", 9.5, MARGIN + 6, top - 26, entry.subtitle);

    const matrix = QRCode.create(entry.url, { errorCorrectionLevel: "M" }).modules;
    out += drawQr(matrix.data, MARGIN + 6, qrY, qrSize, matrix.size);

    const columnX = MARGIN + 6 + qrSize + 26;
    out += text("F2", 14, columnX, top - 60, entry.kind);
    let lineY = top - 80;
    for (const line of wrap("Scan with a phone camera to open the menu.", 26)) {
      out += text("F1", 10, columnX, lineY, line);
      lineY -= 14;
    }
    lineY -= 6;
    for (const line of wrap(entry.url, 30)) {
      out += text("F1", 8.5, columnX, lineY, line);
      lineY -= 11;
    }
    lineY -= 8;
    out += "0.85 0.12 0.12 rg\n";
    out += text("F2", 8.5, columnX, lineY, "Works only on this computer.");
    out += "0 0 0 rg\n";

    out += "0.75 0.75 0.75 RG 0.7 w\n";
    out += `q ${MARGIN} ${top - blockHeight + 10} m ${PAGE_W - MARGIN} ${top - blockHeight + 10} l S Q\n`;

    top -= blockHeight;
  }

  out += text(
    "F1",
    8,
    MARGIN,
    46,
    "These URLs point at 127.0.0.1, which only resolves on the cafe's own computer. They cannot be scanned over the internet."
  );
  out += text(
    "F1",
    8,
    MARGIN,
    34,
    "A real cafe's QR codes must be generated against its eventual public HTTPS domain, never against these local addresses."
  );

  return out;
}

const perPage = 3;
const pages = [];
for (let index = 0; index < entries.length; index += perPage) {
  pages.push(entries.slice(index, index + perPage));
}

const objects = [];
function addObject(body) {
  objects.push(body);
  return objects.length;
}

const fontRegular = addObject(
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>"
);
const fontBold = addObject(
  "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>"
);

const pageObjectIds = [];
for (let index = 0; index < pages.length; index += 1) {
  const content = pageContent(pages[index], index + 1, pages.length);
  const contentId = addObject(
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`
  );
  const pageId = addObject(
    `<< /Type /Page /Parent __PAGES__ 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentId} 0 R >>`
  );
  pageObjectIds.push(pageId);
}

const pagesId = addObject(
  `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`
);
const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);

const bodies = objects.map((body) => body.replace("__PAGES__", String(pagesId)));

let pdf = "%PDF-1.4\n";
const offsets = [0];
for (let index = 0; index < bodies.length; index += 1) {
  offsets[index + 1] = Buffer.byteLength(pdf, "latin1");
  pdf += `${index + 1} 0 obj\n${bodies[index]}\nendobj\n`;
}
const xrefOffset = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${bodies.length + 1}\n`;
pdf += "0000000000 65535 f \n";
for (let index = 1; index <= bodies.length; index += 1) {
  pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
}
pdf += `trailer\n<< /Size ${bodies.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

const pdfPath = path.join(OUT, "corner-cup-local-pilot-qr-pack.pdf");
await writeFile(pdfPath, Buffer.from(pdf, "latin1"));
console.log(`pdf  ${path.relative(ROOT, pdfPath)}`);

await writeFile(
  path.join(OUT, "README.md"),
  [
    "# Corner Cup — local pilot QR pack",
    "",
    "**LOCAL TEST ONLY.** Every URL in this folder points at `http://127.0.0.1:8788`, which resolves",
    "only on the computer running the local pilot. These codes cannot be scanned by a customer's phone",
    "over the internet, and they must never be presented as the café's real ordering codes.",
    "",
    "A real café's QR codes must be generated against its eventual publicly deployed HTTPS domain.",
    "",
    "## Files",
    "",
    "- `corner-cup-local-pilot-qr-pack.pdf` — A4 printable sheet, three labelled codes per page, with the",
    "  LOCAL TEST ONLY warning repeated on every page. This is the file to print.",
    "- `counter-menu.png` — counter ordering URL (no table).",
    "- `table-01.png` … `table-08.png` — one QR per table.",
    "",
    "The PNG files are bare QR images with no caption; the PDF carries the labels, table numbers and the",
    "warning. Print the PDF.",
    "",
    "## Regenerate",
    "",
    "```bash",
    "node scripts/make-qr-pack.mjs",
    "```",
    "",
    "The URLs are defined in that script and match `wrangler.pilot.jsonc` (port 8788, slug",
    "`corner-cup-local-pilot`). Editing the script is how the pack changes; do not hand-edit the PNGs.",
    "",
  ].join("\n")
);
console.log("readme qr-pack/README.md");
