# Corner Cup — local pilot QR pack

**LOCAL TEST ONLY.** Every URL in this folder points at `http://127.0.0.1:8788`, which resolves
only on the computer running the local pilot. These codes cannot be scanned by a customer's phone
over the internet, and they must never be presented as the café's real ordering codes.

A real café's QR codes must be generated against its eventual publicly deployed HTTPS domain.

## Files

- `corner-cup-local-pilot-qr-pack.pdf` — A4 printable sheet, three labelled codes per page, with the
  LOCAL TEST ONLY warning repeated on every page. This is the file to print.
- `counter-menu.png` — counter ordering URL (no table).
- `table-01.png` … `table-08.png` — one QR per table.

The PNG files are bare QR images with no caption; the PDF carries the labels, table numbers and the
warning. Print the PDF.

## Regenerate

```bash
node scripts/make-qr-pack.mjs
```

The URLs are defined in that script and match `wrangler.pilot.jsonc` (port 8788, slug
`corner-cup-local-pilot`). Editing the script is how the pack changes; do not hand-edit the PNGs.
