import { Link, Navigate } from "react-router-dom";
import { cafePath, cafeSlug } from "../lib/api.js";
import { cafeName, isCafeNotFound, useCafeTitle, useSiteConfigState } from "../lib/config.js";
import { gatewayEnabled } from "../lib/payments.js";
import CafeNotFound from "../components/CafeNotFound.jsx";
import SiteFooter from "../components/SiteFooter.jsx";

// The page a guest reaches at /c/<slug> without a table: a table QR code opens the menu directly, so
// anyone here typed the address or followed a shared link. A table café asks them to scan the code on
// their table (which is how the kitchen knows where to bring the order) rather than letting them pick
// any table from a list; a counter café has nothing to scan, so it goes straight to the menu.
export default function Landing() {
  const { config, error: configError, retry: retryConfig } = useSiteConfigState();
  const cafe = cafeName(config);
  useCafeTitle(config, "", isCafeNotFound(configError));
  // Counter-service cafés have no tables to scan, so they skip this page for the menu.
  const counterService = Boolean(config && config.service && config.service.mode === "counter");
  // Only promise UPI/cards/wallets when this café can actually take an online payment.
  const online = gatewayEnabled(config);

  // A guest who already scanned a table in this tab (and came back here through a footer link) keeps
  // it: the menu remembers the table for the session under this key.
  const rememberedTable = rememberedTableFor(cafeSlug());

  // Until the café's settings arrive we don't know its name, service style or payment options, so we
  // show a neutral placeholder instead of guessing ("Café", "Dine-in") and then flipping.
  if (!config) {
    if (isCafeNotFound(configError)) return <CafeNotFound />;
    if (configError) {
      return (
        <main className="page-narrow">
          <div className="state-card" role="alert">
            <span className="state-emoji" aria-hidden="true">
              🫥
            </span>
            <h1>We couldn&apos;t open this café</h1>
            <p className="muted">{configError.message}</p>
            <button
              type="button"
              className="btn primary"
              onClick={retryConfig}
            >
              Try again
            </button>
          </div>
        </main>
      );
    }
    return (
      <main className="page-narrow">
        <div className="state-card" aria-busy="true">
          <span className="state-emoji" aria-hidden="true">
            ☕
          </span>
          <p className="muted">Loading…</p>
        </div>
      </main>
    );
  }

  if (counterService) return <Navigate to={cafePath("/menu")} replace />;

  return (
    <main className="landing">
      <header className="landing-bar">
        <span className="brand-mark small" aria-hidden="true">
          ☕
        </span>
        <p className="landing-bar-name">{cafe}</p>
        <span className="landing-bar-mode">Dine-in</span>
      </header>

      <section className="landing-hero">
        <p className="eyebrow">Order from your table</p>
        <h1>Order without the wait</h1>
        <p className="landing-lede">
          {`Browse the live menu at ${cafe} and send your order straight to the kitchen — no app, no waiting to catch someone's eye.`}
        </p>
      </section>

      <section className="landing-card scan-card" aria-labelledby="scan-title">
        <span className="scan-icon" aria-hidden="true">
          <svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 16V8a2 2 0 0 1 2-2h8M32 6h8a2 2 0 0 1 2 2v8M42 32v8a2 2 0 0 1-2 2h-8M16 42H8a2 2 0 0 1-2-2v-8" />
            <rect x="14" y="14" width="8" height="8" rx="1" />
            <rect x="26" y="14" width="8" height="8" rx="1" />
            <rect x="14" y="26" width="8" height="8" rx="1" />
            <path d="M26 26h3v3M34 26v8h-8" />
          </svg>
        </span>
        <h2 id="scan-title">Scan the QR code on your table</h2>
        <p className="muted">
          Point your phone camera at the code on your table. The menu opens with your table already set, so
          your order comes straight to you.
        </p>
        {rememberedTable && (
          <Link className="btn primary landing-cta" to={cafePath(`/t/${encodeURIComponent(rememberedTable)}`)}>
            Back to your menu · Table {rememberedTable}
            <span aria-hidden="true">→</span>
          </Link>
        )}
        <p className="scan-help small">
          <strong>Can&apos;t scan?</strong> Ask a staff member and they&apos;ll help you order.
        </p>
      </section>

      <section className="landing-card">
        <h2>How it works</h2>
        <ol className="steps">
          <li>
            <span className="step-num" aria-hidden="true">
              1
            </span>
            <div>
              <strong>Scan the QR code</strong>
              <p className="muted small">
                Every table has its own code, so we always know where you&apos;re sitting.
              </p>
            </div>
          </li>
          <li>
            <span className="step-num" aria-hidden="true">
              2
            </span>
            <div>
              <strong>Pick your food and drinks</strong>
              <p className="muted small">Live menu with today&apos;s sold-out items marked automatically.</p>
            </div>
          </li>
          <li>
            <span className="step-num" aria-hidden="true">
              3
            </span>
            <div>
              <strong>Send it to the kitchen</strong>
              <p className="muted small">
                {online
                  ? "Pay securely at your table — UPI, card or wallet, no app to install."
                  : "Your order goes straight to the kitchen — pay at the counter, no app to install."}
              </p>
            </div>
          </li>
        </ol>
      </section>

      <SiteFooter />
    </main>
  );
}

function rememberedTableFor(slug) {
  try {
    const value = sessionStorage.getItem(`cafe_table:${slug || "cafe"}`);
    return value && /^\d{1,4}$/.test(value) ? value : "";
  } catch {
    return "";
  }
}
