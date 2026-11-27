#!/usr/bin/env node
// Printable table QR codes for the sales-demo café (scripts/demo-cafe.mjs).
//
//   node scripts/demo-qr-pack.mjs
//   node scripts/demo-qr-pack.mjs --origin https://your-domain.example
//
// Output: qr-pack/demo/table-01.png … table-06.png and qr-pack/demo/chai-kona-table-qr-codes.pdf, an A4
// sheet with two labelled codes per page, drawn as vector modules so they print sharp at any size.
//
// The codes point at /c/<demo slug>/t/<table number>. Guests reach a table by its number, so these stay
// valid across every demo reset.

import QRCode from "qrcode";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEMO_CAFE, DEMO_SLUG, DEMO_TABLES } from "./demo-cafe.mjs";

const DEFAULT_ORIGIN = "https://corner-cup.rahilbisen8.workers.dev";

const argv = process.argv.slice(2);
const originAt = argv.indexOf("--origin");
const ORIGIN = String(originAt === -1 ? DEFAULT_ORIGIN : argv[originAt + 1] || "").replace(/\/+$/, "");
if (!/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(ORIGIN)) {
  console.error("--origin must be an https:// address with no path, e.g. https://cafe.example.com");
  process.exit(1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "qr-pack", "demo");
const CAFE_URL = `${ORIGIN}/c/${DEMO_SLUG}`;

const entries = DEMO_TABLES.map(({ number, seats }) => ({
  file: `table-${String(number).padStart(2, "0")}.png`,
  title: `Table ${number}`,
  subtitle: `${seats} seats`,
  url: `${CAFE_URL}/t/${number}`,
}));

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

/* ------------------------------------------------------------------ PDF (A4, no dependencies) */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 48;

// The built-in PDF fonts speak WinAnsi, which covers "é" but not every character a name could hold.
function pdfText(value) {
  return String(value)
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/[^\x20-\x7E -ÿ]/g, "")
    .replace(/\\/g, "\\\\")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)");
}

function text(font, size, x, y, value) {
  return `BT /${font} ${size} Tf ${x.toFixed(2)} ${y.toFixed(2)} Td (${pdfText(value)}) Tj ET\n`;
}

// Roughly centred: Helvetica averages about half an em per character.
function centred(font, size, y, value) {
  const width = String(value).length * size * (font === "F2" ? 0.56 : 0.5);
  return text(font, size, (PAGE_W - width) / 2, y, value);
}

function rect(x, y, w, h) {
  return `q ${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f Q\n`;
}

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

// Two table cards per page, each meant to be cut out along the grey line and stood on the table.
function pageContent(pageEntries) {
  let out = "";
  const half = (PAGE_H - MARGIN * 2) / 2;
  pageEntries.forEach((entry, index) => {
    const top = PAGE_H - MARGIN - index * half;
    out += "0 0 0 rg\n";
    out += centred("F2", 22, top - 40, DEMO_CAFE.name);
    out += centred("F1", 12, top - 60, "Scan to see the menu and order from your phone");

    const qrSize = 210;
    const matrix = QRCode.create(entry.url, { errorCorrectionLevel: "M" }).modules;
    out += drawQr(matrix.data, (PAGE_W - qrSize) / 2, top - 80 - qrSize, qrSize, matrix.size);

    out += centred("F2", 28, top - 80 - qrSize - 34, entry.title);
    out += "0.35 0.35 0.35 rg\n";
    out += centred("F1", 9, top - 80 - qrSize - 52, entry.url);

    if (index === 0 && pageEntries.length > 1) {
      out += "0.75 0.75 0.75 RG 0.6 w [4 4] 0 d\n";
      out += `q ${MARGIN} ${top - half} m ${PAGE_W - MARGIN} ${top - half} l S Q\n[] 0 d\n`;
    }
  });
  return out;
}

const perPage = 2;
const pages = [];
for (let index = 0; index < entries.length; index += perPage) pages.push(entries.slice(index, index + perPage));

const objects = [];
const addObject = (body) => objects.push(body);
addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
addObject("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
const fontRegular = 1;
const fontBold = 2;

const pageObjectIds = [];
for (const page of pages) {
  const content = pageContent(page);
  const contentId = addObject(`<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`);
  pageObjectIds.push(
    addObject(
      `<< /Type /Page /Parent __PAGES__ 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
        `/Resources << /Font << /F1 ${fontRegular} 0 R /F2 ${fontBold} 0 R >> >> /Contents ${contentId} 0 R >>`
    )
  );
}
const pagesId = addObject(
  `<< /Type /Pages /Kids [${pageObjectIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageObjectIds.length} >>`
);
const catalogId = addObject(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
const bodies = objects.map((body) => body.replace("__PAGES__", String(pagesId)));

let pdf = "%PDF-1.4\n";
const offsets = [0];
bodies.forEach((body, index) => {
  offsets[index + 1] = Buffer.byteLength(pdf, "latin1");
  pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
});
const xrefOffset = Buffer.byteLength(pdf, "latin1");
pdf += `xref\n0 ${bodies.length + 1}\n0000000000 65535 f \n`;
for (let index = 1; index <= bodies.length; index += 1) pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
pdf += `trailer\n<< /Size ${bodies.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

const pdfPath = path.join(OUT, `${DEMO_SLUG}-table-qr-codes.pdf`);
await writeFile(pdfPath, Buffer.from(pdf, "latin1"));
console.log(`pdf  ${path.relative(ROOT, pdfPath)}`);
console.log(`\nCodes point at ${CAFE_URL}/t/1 … /t/${DEMO_TABLES.length}. Print the PDF.`);
