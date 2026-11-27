import { cafeSlug } from "../lib/api.js";

// Shown when the address points at a café that does not exist (the Worker's /config answered 404). It
// never borrows a generic "Café" name or a dine-in layout, and it offers no retry, because a missing café
// will not appear on a second attempt. The slug is echoed back so a mistyped address is easy to spot.
export default function CafeNotFound() {
  const slug = cafeSlug();
  return (
    <main className="page-narrow">
      <div className="state-card" role="alert">
        <span className="state-emoji" aria-hidden="true">
          🔍
        </span>
        <h1>Café not found</h1>
        <p className="muted">
          There is no café at{" "}
          <strong>
            /c/{slug}
          </strong>
          . Check the address, or scan the QR code on your table again.
        </p>
        <p className="muted small">If you work here, ask whoever set up your café for the right link.</p>
      </div>
    </main>
  );
}
